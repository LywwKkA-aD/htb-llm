import { test as base, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// порты задаёт playwright.config.ts (E2E_APP_PORT / E2E_MOCK_PORT) — параллельные прогоны не пересекаются
export const APP_PORT = Number(process.env.E2E_APP_PORT ?? 17331);
export const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 18080}`;

// Любой нативный alert/confirm/prompt — это баг интерфейса (у нас свои модальные окна).
// Любая необработанная ошибка JS на странице — тоже.
export const test = base.extend<{ guard: void }>({
  guard: [async ({ page }, use) => {
    const dialogs: string[] = [];
    const errors: string[] = [];
    page.on("dialog", async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); await d.dismiss(); });
    page.on("pageerror", (e) => errors.push(e.message));
    await use();
    expect(dialogs, "нативные диалоги браузера не должны появляться").toEqual([]);
    expect(errors, "ошибки JavaScript на странице").toEqual([]);
  }, { auto: true }],
});
export { expect };

export type Ids = { task: { id: string; title: string }; chat: { id: string } };

export async function createTask(request: APIRequestContext, title: string, extra: { course?: string; brief?: string } = {}): Promise<Ids> {
  const r = await request.post("/api/tasks", { data: { title, course: extra.course ?? "Сети", brief: extra.brief ?? "Тестовое условие задачи." } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const ids = (await r.json()) as Ids;
  await waitContainer(request, ids.task.id);
  return ids;
}

// Общая библиотека — глобальное состояние сервера на весь прогон: спеки, которым важен состав фрагментов
// в промпте, начинают с чистой библиотеки, а спеки, которые её наполняют, убирают за собой.
export async function clearGlobalDocs(request: APIRequestContext) {
  const docs = (await (await request.get("/api/docs")).json()) as { id: number; task_id: string | null }[];
  for (const d of docs) if (d.task_id === null) await request.delete(`/api/docs/${d.id}`);
}

export async function waitContainer(request: APIRequestContext, taskId: string, state = "running") {
  await expect.poll(async () => (await (await request.get(`/api/tasks/${taskId}/container`)).json()).status, { timeout: 40_000 }).toBe(state);
}

// открыть приложение на нужной задаче/чате с чистыми настройками интерфейса
// Настройки пишутся ДО запуска приложения (init-скрипт), один раз на вызов openTask.
// Раньше: goto → evaluate → reload, и автоматический выбор задачи приложением мог перезаписать wh.task
// между evaluate и reload — тест молча открывал не ту задачу.
let openSeq = 0;
export async function openTask(page: Page, ids: Ids | { task: { id: string }; chat?: { id: string } }, opts: { tab?: "term" | "mem" | "lib" | "vpn" | "browser" | "proxy" } = {}) {
  const key = `__wh_open_${++openSeq}`;
  await page.addInitScript(([k, t, c, tab]) => {
    if (sessionStorage.getItem(k)) return; // последующие перезагрузки в тесте сохраняют то, что выбрал тест/пользователь
    sessionStorage.setItem(k, "1");
    localStorage.clear();
    localStorage.setItem("wh.task", t);
    if (c) localStorage.setItem("wh.chat", c);
    localStorage.setItem("wh.tab", tab);
  }, [key, ids.task.id, ids.chat?.id ?? "", opts.tab ?? "term"] as const);
  await page.goto("/");
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("chat-task-title")).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("wh.task"))).toBe(ids.task.id);
  if (ids.chat?.id) await expect.poll(() => page.evaluate(() => localStorage.getItem("wh.chat"))).toBe(ids.chat.id);
}

export async function send(page: Page, text: string) {
  const input = page.getByTestId("composer-input");
  const before = await page.getByTestId("msg-user").count();
  await input.fill(text);
  await input.press("Enter");
  // сообщение и состояние «занят» рендерятся одним батчем — дальше waitIdle не проскочит раньше времени
  await expect(page.getByTestId("msg-user")).toHaveCount(before + 1);
}

export async function waitIdle(page: Page, timeout = 45_000) {
  await expect(page.getByTestId("stop")).toHaveCount(0, { timeout });
  await expect(page.getByTestId("thinking")).toHaveCount(0, { timeout });
}

export async function termText(page: Page, which: "agent" | "shell") {
  return page.getByTestId(`term-${which}`).locator(".xterm-rows").innerText();
}

export async function mockReset(request: APIRequestContext) { await request.get(`${MOCK}/__reset`); }
export async function mockRequests(request: APIRequestContext) {
  return (await (await request.get(`${MOCK}/__requests`)).json()) as { kind: "agent" | "propose" | "summary"; body: any }[];
}
export const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (p.type === "text" ? p.text : "")).join("\n") : "";

// ---------- геометрия ----------
export type Box = { x: number; y: number; width: number; height: number };
export async function box(l: Locator): Promise<Box> {
  await expect(l).toBeVisible();
  const b = await l.boundingBox();
  expect(b, "элемент должен иметь размеры").not.toBeNull();
  return b!;
}
export const right = (b: Box) => b.x + b.width;
export const bottom = (b: Box) => b.y + b.height;
export function expectNear(actual: number, expected: number, what: string, tol = 1.5) {
  expect(Math.abs(actual - expected), `${what}: ожидалось ≈${expected}, получено ${actual.toFixed(1)}`).toBeLessThanOrEqual(tol);
}
export async function expectInside(child: Locator, parent: Locator, what: string, tol = 0.5) {
  const c = await box(child), p = await box(parent);
  expect(c.x, `${what}: левый край`).toBeGreaterThanOrEqual(p.x - tol);
  expect(c.y, `${what}: верхний край`).toBeGreaterThanOrEqual(p.y - tol);
  expect(right(c), `${what}: правый край`).toBeLessThanOrEqual(right(p) + tol);
  expect(bottom(c), `${what}: нижний край`).toBeLessThanOrEqual(bottom(p) + tol);
}
export async function expectNoOverlap(a: Locator, b: Locator, what: string) {
  const A = await box(a), B = await box(b);
  const overlap = A.x < right(B) - 0.5 && B.x < right(A) - 0.5 && A.y < bottom(B) - 0.5 && B.y < bottom(A) - 0.5;
  expect(overlap, `${what}: элементы перекрываются`).toBe(false);
}
export async function expectNoOverflowX(l: Locator, what: string) {
  const r = await l.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(r.sw, `${what}: содержимое шире контейнера (${r.sw} > ${r.cw})`).toBeLessThanOrEqual(r.cw + 1);
}

// 1×1 PNG для тестов вложений
export const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
