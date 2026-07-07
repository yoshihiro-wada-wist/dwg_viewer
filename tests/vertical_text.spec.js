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

test('縦書き(KANJI4)テキスト「和田」が1文字ずつ縦に積まれる', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const r = await parseInPage(page, SAMPLE);
  expect(r.ok).toBe(true);

  const labels = r.items.flatMap((it) => it.labels || []);

  // 縦書きスタイルの「和田」は「和」「田」の2つの単一文字ラベルに分解される
  const wa = labels.find((l) => l.text === '和');
  const da = labels.find((l) => l.text === '田');
  expect(wa, '「和」単独ラベルがある（縦書き分解）').toBeTruthy();
  expect(da, '「田」単独ラベルがある（縦書き分解）').toBeTruthy();

  // 「和」が上、「田」が下（world Y は上向き → 和.y > 田.y）
  expect(wa.y, '和が田より上にある').toBeGreaterThan(da.y);
  // ほぼ同じX（縦一列）
  expect(Math.abs(wa.x - da.x), '同じ列に並ぶ').toBeLessThan(0.5);
  // 中央・中段揃え
  expect(wa.align).toBe('center');
  expect(wa.baseline).toBe('middle');

  // 横書きの「和田」連結ラベルは存在しない（＝横表示バグが直っている）
  const horiz = labels.find((l) => l.text === '和田');
  expect(horiz, '横並びの「和田」ラベルが残っていない').toBeFalsy();
});
