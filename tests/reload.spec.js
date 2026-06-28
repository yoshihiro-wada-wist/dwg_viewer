import { test, expect } from './fixtures.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = path.resolve(__dirname, '..', 'test_data', 'TB3Y.dwg');
const B = path.resolve(__dirname, '..', 'test_data', 'TB3Y_new.dwg');

// viewer.js と同じ parseItems 経路（専用iframe生成→破棄）を再現
async function parseViaSandbox(page, filePath) {
  const bytes = Array.from(fs.readFileSync(filePath));
  return await page.evaluate(async (bytes) => {
    const buffer = new Uint8Array(bytes).buffer;
    const wasmBase = chrome.runtime.getURL('vendor/wasm');
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = chrome.runtime.getURL('sandbox.html');
    const copy = buffer.slice(0);
    let onMsg;
    try {
      const res = await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('timeout')), 30000);
        onMsg = (ev) => {
          if (ev.source !== iframe.contentWindow) return;
          const m = ev.data || {};
          if (m.type === 'ready') iframe.contentWindow.postMessage({ type: 'parse', id: 1, buffer: copy }, '*', [copy]);
          else if (m.type === 'fatal') { clearTimeout(to); reject(new Error('init: ' + m.error)); }
          else if (m.type === 'result') { clearTimeout(to); m.ok ? resolve(m) : reject(new Error(m.error)); }
        };
        window.addEventListener('message', onMsg);
        iframe.addEventListener('load', () => iframe.contentWindow.postMessage({ type: 'init', wasmBase }, '*'));
        document.body.appendChild(iframe);
      });
      return { ok: true, items: res.items.length };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      if (onMsg) window.removeEventListener('message', onMsg);
      iframe.remove();
    }
  }, bytes);
}

test('連続で別ファイルを開ける（A→B→A の再読み込み）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  const r1 = await parseViaSandbox(page, A);
  console.log('1回目(A):', JSON.stringify(r1));
  const r2 = await parseViaSandbox(page, B);
  console.log('2回目(B):', JSON.stringify(r2));
  const r3 = await parseViaSandbox(page, A);
  console.log('3回目(A 同一再読み込み):', JSON.stringify(r3));

  expect(r1.ok, '1回目: ' + r1.error).toBe(true);
  expect(r2.ok, '2回目: ' + r2.error).toBe(true);
  expect(r3.ok, '3回目: ' + r3.error).toBe(true);
  expect(r1.items).toBeGreaterThan(0);
  expect(r2.items).toBeGreaterThan(0);
  expect(r3.items).toBeGreaterThan(0);
});
