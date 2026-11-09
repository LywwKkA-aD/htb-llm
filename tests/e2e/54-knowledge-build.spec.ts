import { test, expect, createTask, openTask, type Ids } from "./helpers";

// Построение базы знаний кнопкой в вебе: сервер сам запускает scripts/knowledge.mts.
// В e2e WH_KNOWLEDGE_ARGS ограничивает сборку собственным гайдом htb-00 (без клонов внешних реп).
async function waitKnowledge(request: any) {
  await expect.poll(async () => (await (await request.get("/api/settings/knowledge")).json()).knowledge.running, { timeout: 180_000 }).toBe(false);
  return (await (await request.get("/api/settings/knowledge")).json());
}

test.describe("построение базы знаний из веба", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "База знаний: сборка кнопкой"); });
  test.afterAll(async ({ request }) => {
    const list = await (await request.get("/api/docs")).json();
    const doc = list.find((d: any) => d.name === "htb-00-methodology.md" && d.task_id === null);
    if (doc) await request.delete(`/api/docs/${doc.id}`);
  });

  test("UI: на пустой базе кнопка «скачать и построить» активна, переиндексация — нет; сборка доводит индекс до готовности", async ({ page, request }) => {
    test.setTimeout(240_000);
    await openTask(page, ids);
    await page.getByTestId("settings-open").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    const before = (await (await request.get("/api/settings")).json()).embedIndex.chunks as number;
    await expect(page.getByTestId("knowledge-build")).toBeEnabled();
    if (before === 0) await expect(page.getByTestId("reindex-start")).toBeDisabled();
    await page.getByTestId("knowledge-build").click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("knowledge-done")).toBeVisible({ timeout: 200_000 });
    const fin = await waitKnowledge(request);
    expect(fin.knowledge.error).toBeNull();
    expect(fin.embedIndex.chunks).toBeGreaterThan(0);
    const list = await (await request.get("/api/docs")).json();
    const doc = list.find((d: any) => d.name === "htb-00-methodology.md" && d.task_id === null);
    expect(doc?.status).toBe("ready");
    expect(doc?.chunks).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
  });

  test("API: повторная сборка безопасна (без изменений), состояние отдаётся в настройках", async ({ request }) => {
    test.setTimeout(240_000);
    const s0 = await (await request.get("/api/settings")).json();
    expect(s0.knowledge).toMatchObject({ running: false });
    expect(Array.isArray(s0.knowledge.lines)).toBe(true);
    const r = await request.post("/api/settings/knowledge");
    expect(r.ok(), await r.text()).toBeTruthy();
    const fin = await waitKnowledge(request);
    expect(fin.knowledge.error).toBeNull();
    expect(fin.knowledge.finishedAt).toBeGreaterThan(0);
    expect(fin.embedIndex.chunks).toBeGreaterThan(0);
  });
});
