import { test, expect } from './fixtures.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = path.resolve(__dirname, '..', 'test_data', 'TB3Y.dwg');

// Canvas をスタブ化（描画no-op / toDataURL は極小PNG）。
// window.open は同一オリジンの隠しiframeに差し替え、実DOM/実onload/実CSP下で
// 印刷トリガ(win.print)が発火するかを検証する（about:blank iframe は拡張CSPを継承するため、
// もしインライン onload を使っていればここでブロックされ print は呼ばれない＝退行検出になる）。
const STUB = () => {
  const noop = () => {};
  const fake = new Proxy({ canvas: null, measureText: () => ({ width: 0 }) },
    { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
  HTMLCanvasElement.prototype.getContext = function () { fake.canvas = this; return fake; };
  HTMLCanvasElement.prototype.toDataURL = () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  window.__printed = 0;
  window.open = function () {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.body.appendChild(f);
    const w = f.contentWindow;
    w.print = () => { window.__printed++; };
    return w;
  };
};

test('印刷ボタン: CSP下でも img.onload から window.print が呼ばれる', async ({ context, extensionId }) => {
  await context.addInitScript(STUB);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  await page.setInputFiles('#file', A);
  await page.waitForFunction(() => /図形 \d+/.test(document.getElementById('status').textContent || ''),
    null, { timeout: 20000, polling: 200 });

  // 注: page.click は実入力ディスパッチで swiftshader レンダラを落とすため evaluate で発火
  await page.evaluate(() => document.getElementById('printBtn').click());
  await page.waitForFunction(() => window.__printed > 0, null, { timeout: 10000, polling: 100 });

  const printed = await page.evaluate(() => window.__printed);
  const hasErr = await page.locator('#status').evaluate((el) => el.classList.contains('err'));
  console.log('printed:', printed, 'err:', hasErr);

  expect(printed, 'window.print should be called from img.onload').toBeGreaterThan(0);
  expect(hasErr, 'no error status (no popup-block)').toBe(false);
});
