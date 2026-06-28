import { test, expect } from './fixtures.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = path.resolve(__dirname, '..', 'test_data', 'TB3Y.dwg');
const B = path.resolve(__dirname, '..', 'test_data', 'TB3Y_new.dwg');

// 描画コマンドを記録するスタブ。render() が呼ぶ moveTo/lineTo/fillText の座標から
// 1回の render の「描画指紋」を計算して window.__sig に格納する。
const STUB = () => {
  window.__draw = { n: 0, sum: 0, strokes: 0, texts: 0 };
  const acc = (x, y) => { const d = window.__draw; d.n++; d.sum = (d.sum + x * 31.7 + y * 13.3) % 1e9; };
  const noop = () => {};
  const base = {
    canvas: null,
    measureText: () => ({ width: 0 }),
    moveTo: (x, y) => acc(x, y),
    lineTo: (x, y) => acc(x, y),
    fillText: (t, x, y) => { window.__draw.texts++; acc(x, y); for (const ch of String(t)) window.__draw.sum = (window.__draw.sum + ch.charCodeAt(0)) % 1e9; },
    stroke: () => { window.__draw.strokes++; },
    clearRect: () => {
      // 新しい render の開始。直前の指紋を確定して履歴に積む
      if (!window.__sigs) window.__sigs = [];
      const d = window.__draw;
      if (d.n > 0) window.__sigs.push({ n: d.n, sum: Math.round(d.sum), strokes: d.strokes, texts: d.texts });
      window.__draw = { n: 0, sum: 0, strokes: 0, texts: 0 };
    },
  };
  const handler = { get: (t, k) => (k in t ? t[k] : noop), set: () => true };
  const fake = new Proxy(base, handler);
  HTMLCanvasElement.prototype.getContext = function () { fake.canvas = this; return fake; };
};

async function open(page, file, nameFrag) {
  await page.setInputFiles('#file', file);
  await page.waitForFunction((frag) => {
    const s = document.getElementById('status').textContent || '';
    return s.includes(frag) && /図形 \d+/.test(s);
  }, nameFrag, { timeout: 20000, polling: 200 });
  // 直近 render のコマンドは window.__draw に溜まったまま（次の clearRect まで未確定）。
  // これを読めば「いま canvas に描かれている内容」の指紋になる。
  await page.waitForTimeout(200);
  return await page.evaluate(() => {
    const d = window.__draw;
    return d && d.n > 0 ? { n: d.n, sum: Math.round(d.sum), strokes: d.strokes, texts: d.texts } : null;
  });
}

test('render 指紋: A→B→A で canvas へ描く内容が実際に変わる', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.addInitScript(STUB);
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  const sa1 = await open(page, A, 'TB3Y.dwg');
  const sb  = await open(page, B, 'TB3Y_new.dwg');
  const sa2 = await open(page, A, 'TB3Y.dwg');
  console.log('render A1:', JSON.stringify(sa1));
  console.log('render B :', JSON.stringify(sb));
  console.log('render A2:', JSON.stringify(sa2));

  expect(sa1, 'A1 rendered').not.toBeNull();
  expect(sb, 'B rendered').not.toBeNull();
  // A と B で描画指紋が異なるべき（= 再読み込みで表示が変わる）
  expect(JSON.stringify(sb), 'B render should differ from A1').not.toBe(JSON.stringify(sa1));
  // A 再読み込みで A1 と同じ描画になるべき
  expect(JSON.stringify(sa2), 'A2 render should match A1').toBe(JSON.stringify(sa1));
});
