import { test, expect } from './fixtures.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = path.resolve(__dirname, '..', 'test_data', 'TB3Y.dwg');

// devicePixelRatio=2 を強制し、描画座標(ユーザー空間=CSS px想定)の範囲を記録するスタブ
const STUB = () => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => 2 });
  window.__b = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity, n: 0 };
  const acc = (x, y) => { const b = window.__b; b.n++; if (x < b.minx) b.minx = x; if (y < b.miny) b.miny = y; if (x > b.maxx) b.maxx = x; if (y > b.maxy) b.maxy = y; };
  const noop = () => {};
  const base = {
    canvas: null, measureText: () => ({ width: 0 }),
    moveTo: acc, lineTo: acc,
    clearRect: () => { window.__b = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity, n: 0 }; },
  };
  const fake = new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
  HTMLCanvasElement.prototype.getContext = function () { fake.canvas = this; return fake; };
};

test('DPR=2: 図面がcanvasの可視CSS範囲に収まる（フィットが正しい）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.addInitScript(STUB);
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  await page.setInputFiles('#file', A);
  await page.waitForFunction(() => /図形 \d+/.test(document.getElementById('status').textContent || ''), null, { timeout: 20000, polling: 200 });
  await page.waitForTimeout(300);

  const info = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    return { b: window.__b, cssW: c.clientWidth, cssH: c.clientHeight, dpr: window.devicePixelRatio };
  });
  console.log('INFO:', JSON.stringify(info));

  const { b, cssW, cssH } = info;
  const tol = 50; // pad 余裕
  // 描画はCSSピクセル座標系（render が setTransform(dpr) するため）→ [0,cssW]x[0,cssH] に収まるべき
  const ok = b.minx >= -tol && b.miny >= -tol && b.maxx <= cssW + tol && b.maxy <= cssH + tol;
  expect(ok, `drawn bounds [${b.minx.toFixed(0)},${b.miny.toFixed(0)}]-[${b.maxx.toFixed(0)},${b.maxy.toFixed(0)}] should fit canvas ${cssW}x${cssH}`).toBe(true);
});
