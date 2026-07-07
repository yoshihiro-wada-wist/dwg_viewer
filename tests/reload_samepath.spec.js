import { test, expect } from './fixtures.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = path.resolve(__dirname, '..', 'test_data', 'TB3Y.dwg');
const B = path.resolve(__dirname, '..', 'test_data', 'TB3Y_new.dwg');

const STUB = () => {
  window.__draw = { n: 0, strokes: 0 };
  const noop = () => {};
  const base = {
    canvas: null, measureText: () => ({ width: 0 }),
    moveTo: () => { window.__draw.n++; }, lineTo: () => { window.__draw.n++; },
    stroke: () => { window.__draw.strokes++; },
    clearRect: () => { window.__draw = { n: 0, strokes: 0 }; },
  };
  const fake = new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
  HTMLCanvasElement.prototype.getContext = function () { fake.canvas = this; return fake; };
};

async function openAndRead(page, filePath, nameFrag) {
  await page.setInputFiles('#file', filePath);
  await page.waitForFunction((frag) => {
    const s = document.getElementById('status').textContent || '';
    return s.includes(frag) && /図形 \d+/.test(s);
  }, nameFrag, { timeout: 20000, polling: 200 });
  const status = (await page.locator('#status').textContent() || '').replace(/\s+/g, ' ').trim();
  const strokes = await page.evaluate(() => window.__draw.strokes);
  return { status, strokes };
}

test('同名ファイルを外部編集後に再読込すると新内容になる', async ({ context, extensionId }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwg-same-'));
  const same = path.join(dir, 'TB3Y.dwg'); // 終始この同名パスを使う
  fs.copyFileSync(A, same);

  const page = await context.newPage();
  await page.addInitScript(STUB);
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  // ① A の内容で開く
  const r1 = await openAndRead(page, same, 'TB3Y.dwg');
  console.log('① 初回(=A内容):', JSON.stringify(r1));

  // ② 外部編集を模擬：同じパスを B の内容で上書き
  fs.copyFileSync(B, same);

  // ③ 同じパスを再読込
  const r2 = await openAndRead(page, same, 'TB3Y.dwg');
  console.log('② 上書き後 再読込:', JSON.stringify(r2));

  fs.rmSync(dir, { recursive: true, force: true });

  expect(r1.strokes, '初回は A=465本').toBe(465);
  // 外部編集後の再読込で B=458本 になるべき（465のままなら=表示が変わらないバグ）
  expect(r2.strokes, '再読込後は B=458本（465のままなら古い表示が残るバグ）').toBe(458);
});
