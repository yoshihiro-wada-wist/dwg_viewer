import { defineConfig } from '@playwright/test';

// MV3拡張は新ヘッドレス（channel: 'chromium'）が必須。
// 拡張の読み込みは launchPersistentContext で各テスト内（fixtures）で行う。
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
});
