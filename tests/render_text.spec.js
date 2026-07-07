import { test, expect } from './fixtures.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = path.resolve(__dirname, '..', 'test_data', 'TB3Y.dwg');

// Canvas2D をスタブ化し、テキスト描画に関わる呼び出し(scale/font/textAlign/textBaseline/fillText)を記録
const STUB = () => {
  window.__t = { scales: [], fonts: [], aligns: [], baselines: [], texts: 0 };
  const rec = window.__t;
  const noop = () => {};
  const base = {
    canvas: null, measureText: () => ({ width: 0 }),
    scale: (x, y) => rec.scales.push([x, y]),
    fillText: (s) => { rec.texts++; },
    moveTo: noop, lineTo: noop, stroke: noop, clearRect: noop,
  };
  const handler = {
    get: (t, k) => (k in t ? t[k] : noop),
    set: (t, k, v) => {
      if (k === 'font') rec.fonts.push(v);
      else if (k === 'textAlign') rec.aligns.push(v);
      else if (k === 'textBaseline') rec.baselines.push(v);
      return true;
    },
  };
  const fake = new Proxy(base, handler);
  HTMLCanvasElement.prototype.getContext = function () { fake.canvas = this; return fake; };
};

test('描画: 幅係数scale・キャップ高font・整列が適用される', async ({ context, extensionId }) => {
  await context.addInitScript(STUB);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  await page.setInputFiles('#file', A);
  await page.waitForFunction(() => /図形 \d+/.test(document.getElementById('status').textContent || ''),
    null, { timeout: 20000, polling: 200 });
  await page.waitForTimeout(200);

  const t = await page.evaluate(() => window.__t);
  console.log('texts:', t.texts, 'scales:', t.scales.length, 'fonts sample:', t.fonts.slice(0, 3),
    'aligns:', [...new Set(t.aligns)], 'baselines:', [...new Set(t.baselines)]);

  // テキストが描画されている
  expect(t.texts, 'fillText が呼ばれる').toBeGreaterThan(0);
  // 幅係数(xScale<1)による横スケールが適用されている（sx!=1, sy==1）
  const widthScale = t.scales.find(([x, y]) => x !== 1 && y === 1 && x > 0 && x < 1);
  expect(widthScale, `幅係数scaleが無い: ${JSON.stringify(t.scales.slice(0, 5))}`).toBeTruthy();
  // 整列(textAlign/textBaseline)がセットされている
  expect(t.aligns.length, 'textAlign セット').toBeGreaterThan(0);
  expect(t.baselines.length, 'textBaseline セット').toBeGreaterThan(0);
  // valign=1(bottom) が多いので 'bottom' baseline が現れる
  expect(t.baselines).toContain('bottom');
});
