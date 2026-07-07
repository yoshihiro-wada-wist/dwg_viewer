import { test, expect } from './fixtures.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, '..', 'test_data', 'TB3Y.dwg');

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

test('テキスト属性が label に反映される（幅係数・整列・MTEXT整形）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const r = await parseInPage(page, SAMPLE);
  expect(r.ok).toBe(true);

  const labels = r.items.flatMap((it) => it.labels || []);
  expect(labels.length, 'ラベルが抽出される').toBeGreaterThan(0);

  // 全ラベルに幅係数・整列情報が付与されている
  for (const l of labels) {
    expect(typeof l.wf, 'wf は数値').toBe('number');
    expect(l.wf, 'wf は正').toBeGreaterThan(0);
    expect(['left', 'center', 'right']).toContain(l.align);
    expect(['top', 'middle', 'bottom', 'alphabetic']).toContain(l.baseline);
  }

  // xScale<1 のテキストが多数 → wf!=1 のラベルが存在する
  const narrowed = labels.filter((l) => l.wf !== 1);
  expect(narrowed.length, '幅係数(xScale)が反映されたラベルがある').toBeGreaterThan(0);

  // MTEXT の書式制御コードが除去されている（生の \P \H \W や {} が残らない）
  const dirty = labels.find((l) => /\\P|\\H|\\W|\\A|[{}]|\\pxi/.test(l.text));
  expect(dirty, `未整形のMTEXTコードが残っている: ${dirty && dirty.text}`).toBeFalsy();

  // MTEXT 由来テキスト("HLS"を含む)が処理されて存在する
  const mtext = labels.find((l) => l.text.includes('HLS'));
  expect(mtext, 'MTEXTが処理されて描画対象になっている').toBeTruthy();
});
