import { test, expect } from './fixtures.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WITH_DIM = path.resolve(__dirname, '..', 'test_data', 'TB3Y_new.dwg'); // 寸法入り

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
          else if (m.type === 'result') { clearTimeout(to); window.removeEventListener('message', onMsg); resolve(m); }
        }
        window.addEventListener('message', onMsg);
        iframe.addEventListener('load', () => iframe.contentWindow.postMessage({ type: 'init', wasmBase }, '*'));
        document.body.appendChild(iframe);
      });
    } finally { iframe.remove(); }
  }, bytes);
}

test('寸法(DIMENSION)が匿名ブロック展開で描画される', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const r = await parseInPage(page, WITH_DIM);
  expect(r.ok).toBe(true);

  const labels = r.items.flatMap((it) => it.labels || []);
  // 寸法値テキスト(measurement 73.64) が描画対象になっている（MTEXT書式\A1;は除去済み）
  const dimText = labels.find((l) => /73\.6/.test(l.text));
  expect(dimText, `寸法値ラベルが無い（例: 73.64）。labels=${JSON.stringify(labels.map(l=>l.text)).slice(0,300)}`).toBeTruthy();
  // 書式コードが残っていない
  expect(/\\A|[{}]/.test(dimText.text), '書式コードが残っている: ' + dimText.text).toBe(false);

  // 寸法の補助線(x≈115.17 と x≈188.81 の縦線)が描画プリミティブに含まれる
  const allPts = r.items.flatMap((it) => it.polylines.flat());
  const hasExt1 = allPts.some((p) => Math.abs(p.x - 115.17) < 0.5);
  const hasExt2 = allPts.some((p) => Math.abs(p.x - 188.81) < 0.5);
  expect(hasExt1 && hasExt2, '寸法補助線が描画されていない').toBe(true);

  // 未対応カウントに DIMENSION が残っていない（＝展開された）
  expect(r.stats).toBeTruthy();
});

test('直径寸法の寸法値が寸法線に沿って回転する（direction ベクトル反映）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const r = await parseInPage(page, WITH_DIM);
  expect(r.ok).toBe(true);

  const labels = r.items.flatMap((it) => it.labels || []);
  // 直径寸法値（∅6.00 / 6.00）のラベル
  const dia = labels.find((l) => /6\.0/.test(l.text) && (l.text.includes('∅') || l.text.includes('%%c') || true) && l.text.length <= 8);
  expect(dia, `直径寸法値ラベルが無い。labels=${JSON.stringify(labels.map(l=>l.text)).slice(0,300)}`).toBeTruthy();
  // direction=(0.813,0.583) → 角度 ≈ 0.622rad(≈35.6°)。rotation(=0)ではなくdirectionが反映される
  expect(Math.abs(dia.rot), `寸法値が回転していない(rot=${dia.rot})。水平のままなら direction 未反映`).toBeGreaterThan(0.3);
  expect(dia.rot, `寸法線角度 ≈0.62rad と一致`).toBeCloseTo(0.622, 1);
});
