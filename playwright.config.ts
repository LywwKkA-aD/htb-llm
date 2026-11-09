import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Порты и каталоги параметризуются: несколько прогонов могут идти одновременно, не мешая друг другу
// (у каждого свой сервер, мок модели, каталог данных и свои Kali-контейнеры по метке каталога).
const APP = Number(process.env.E2E_APP_PORT ?? 17331);
const MOCK = Number(process.env.E2E_MOCK_PORT ?? 18080);
const DATA = path.resolve(process.env.E2E_DATA ?? "tests/.data");
const OUT = process.env.E2E_OUT ?? "tests/results";
process.env.E2E_APP_PORT = String(APP); process.env.E2E_MOCK_PORT = String(MOCK); process.env.E2E_DATA = DATA; // для тестов и teardown

// e2e против настоящего сервера + настоящих Kali-контейнеров, но с мок-моделью (tests/mock-llm.mjs):
// быстро, детерминированно и без загрузки GPU.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" } },
  fullyParallel: false,
  workers: 1, // общий сервер, база и Docker
  retries: 0,
  updateSnapshots: "missing", // эталоны снимков создаются при первом прогоне
  reporter: [["list"], ["html", { open: "never", outputFolder: process.env.E2E_REPORT ?? "tests/report" }]],
  outputDir: OUT,
  snapshotPathTemplate: "tests/e2e/__screenshots__/{testFilePath}/{arg}{ext}",
  globalTeardown: "./tests/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${APP}`,
    viewport: { width: 1600, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce", // анимации выключены — геометрия меряется без «полёта» элементов
    locale: "ru-RU",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 } }],
  webServer: [
    { command: "node tests/mock-llm.mjs", url: `http://127.0.0.1:${MOCK}/v1/models`, reuseExistingServer: false, stdout: "ignore", env: { MOCK_PORT: String(MOCK) } },
    { command: "bash tests/start-app.sh", url: `http://127.0.0.1:${APP}/api/health`, reuseExistingServer: false, timeout: 60_000, stdout: "ignore",
      env: { E2E_APP_PORT: String(APP), E2E_MOCK_PORT: String(MOCK), E2E_DATA: DATA, E2E_WEB_DIST: process.env.E2E_WEB_DIST ?? "" } },
  ],
});
