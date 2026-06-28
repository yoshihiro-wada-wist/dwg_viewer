import { test, expect } from './fixtures.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, '..', 'test_data', 'TB3Y.dwg');

// 解析(sandbox+WASM)を直接叩くヘルパ：実DWG -> 描画プリミティブ
async function parseInPage(page, filePath) {
  const bytes = Array.from(fs.readFileSync(filePath));
  return await page.evaluate(async (bytes) => {
    const buffer = new Uint8Array(bytes).buffer;
    const wasmBase = chrome.runtime.getURL('vendor/wasm');
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = chrome.runtime.getURL('sandbox.html');
    const copy = buffer.slice(0);
    try {
      return await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('timeout')), 30000);
        function onMsg(ev) {
          if (ev.source !== iframe.contentWindow) return;
          const m = ev.data || {};
          if (m.type === 'ready') iframe.contentWindow.postMessage({ type: 'parse', id: 1, buffer: copy }, '*', [copy]);
          else if (m.type === 'fatal') { clearTimeout(to); reject(new Error('init: ' + m.error)); }
          else if (m.type === 'result') {
            clearTimeout(to); window.removeEventListener('message', onMsg);
            m.ok ? resolve(m) : reject(new Error(m.error));
          }
        }
        window.addEventListener('message', onMsg);
        iframe.addEventListener('load', () => iframe.contentWindow.postMessage({ type: 'init', wasmBase }, '*'));
        document.body.appendChild(iframe);
      });
    } finally { iframe.remove(); }
  }, bytes);
}

// Canvas2Dラスタライズ可否を判定（WSL2等のヘッドレスでは fillRect でレンダラが停止する）
async function canRasterize(page) {
  return await Promise.race([
    page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 16; c.height = 16;
      const x = c.getContext('2d'); x.fillRect(0, 0, 8, 8);
      return x.getImageData(0, 0, 1, 1).data[3] >= 0;
    }).catch(() => false),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]);
}

test('拡張が読み込まれ viewer UI が表示される', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  await expect(page).toHaveTitle('DWG Viewer');
  await expect(page.locator('#overlay')).toBeVisible();
  await expect(page.locator('#name')).toHaveText('未選択');
  for (const id of ['#fitBtn', '#layersBtn', '#printBtn']) {
    await expect(page.locator(id)).toBeVisible();
  }
});

test('sandbox が初期化(ready)し、解析RPCが整形された結果を返す', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const res = await page.evaluate(async () => {
    const wasmBase = chrome.runtime.getURL('vendor/wasm');
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = chrome.runtime.getURL('sandbox.html');
    document.body.appendChild(iframe);
    function once(pred, ms) {
      return new Promise((resolve, reject) => {
        const to = setTimeout(() => { window.removeEventListener('message', h); reject(new Error('timeout')); }, ms);
        function h(ev) { if (ev.source !== iframe.contentWindow) return; const m = ev.data || {}; if (pred(m)) { clearTimeout(to); window.removeEventListener('message', h); resolve(m); } }
        window.addEventListener('message', h);
      });
    }
    await new Promise((res) => iframe.addEventListener('load', res, { once: true }));
    const readyP = once((m) => m.type === 'ready' || m.type === 'fatal', 30000);
    iframe.contentWindow.postMessage({ type: 'init', wasmBase }, '*');
    const ready = await readyP;
    if (ready.type !== 'ready') return { initOk: false, error: ready.error };
    const buf = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer;
    const resP = once((m) => m.type === 'result' && m.id === 1, 30000);
    iframe.contentWindow.postMessage({ type: 'parse', id: 1, buffer: buf }, '*', [buf]);
    const r = await resP;
    return { initOk: true, ok: r.ok, itemsIsArray: Array.isArray(r.items), hasTotal: typeof r.total === 'number', hasStats: !!r.stats };
  });
  expect(res.initOk, `初期化失敗: ${res.error || ''}`).toBe(true);
  expect(res.ok).toBe(true);
  expect(res.itemsIsArray).toBe(true);
  expect(res.hasTotal).toBe(true);
  expect(res.hasStats).toBe(true);
});

test('実DWG(TB3Y.dwg)を解析すると図形・レイヤ・色が抽出される', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const r = await parseInPage(page, SAMPLE);

  expect(r.ok).toBe(true);
  expect(r.items.length).toBeGreaterThan(0);          // 実図形が得られる
  expect(r.total).toBeGreaterThan(0);

  // 図形プリミティブの構造を検証（描画に必要なキーが揃っている）
  const withGeom = r.items.find((it) => (it.polylines && it.polylines.length) || (it.labels && it.labels.length));
  expect(withGeom, 'polylines/labels を持つ図形が無い').toBeTruthy();
  expect(typeof withGeom.layer).toBe('string');       // レイヤ名が文字列で付与される

  // レイヤ集合が1つ以上（viewer のレイヤパネルの素になる）
  const layers = new Set(r.items.map((it) => it.layer));
  expect(layers.size).toBeGreaterThan(0);

  // 色フィールドは常に「null（背景連動の前景色）」または [r,g,b] のいずれか
  const badColor = r.items.find((it) => it.color != null && !(Array.isArray(it.color) && it.color.length === 3));
  expect(badColor, '不正な color 値を持つ図形がある').toBeFalsy();
});

test('実DWGをUIで開くと描画される（Canvas2D要・非対応環境はskip）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  test.skip(!(await canRasterize(page)), 'この環境ではCanvas2Dラスタライズ不可（ヘッドレスGPU制約のため描画系テストを省略）');

  await page.locator('#file').setInputFiles(SAMPLE);
  await expect(page.locator('#status')).toContainText('図形', { timeout: 40000 });
  await expect(page.locator('#status')).not.toHaveClass(/err/);
  await expect(page.locator('#name')).toHaveText('TB3Y.dwg');
  await expect(page.locator('#overlay')).toBeHidden();

  await page.locator('#layersBtn').click();
  await expect(page.locator('#layers')).toBeVisible();
  expect(await page.locator('.layer-row').count()).toBeGreaterThan(0);

  const drawn = await page.evaluate(() => {
    const cv = document.getElementById('canvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] !== 0 && ++n > 50) return true;
    return false;
  });
  expect(drawn, 'キャンバスに描画なし').toBe(true);
});
