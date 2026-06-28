import { test as base, chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..'); // 拡張ルート（manifest.jsonのある場所）

// 拡張を読み込んだ永続コンテキストと拡張IDを提供するfixture
export const test = base.extend({
  context: async ({}, use) => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dwg-'));
    const context = await chromium.launchPersistentContext(userDir, {
      channel: 'chromium', // MV3拡張＝新ヘッドレス
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        // WSL2/Docker でのレンダラクラッシュ対策（/dev/shm 枯渇・GPU不在）
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
        '--use-gl=swiftshader',
      ],
    });
    await use(context);
    await context.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const id = new URL(sw.url()).host;
    await use(id);
  },
});

export const expect = test.expect;
