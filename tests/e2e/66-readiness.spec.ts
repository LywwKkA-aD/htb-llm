import { test, expect, createTask, mockReset, openTask, type Ids } from "./helpers";

// Готовность первого запуска: чеклист из 7 проверок с честными состояниями (API + блок в настройках).
test.describe("панель готовности", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Готовность"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("API: семь проверок, docker и задача в порядке, у каждой есть подсказка", async ({ request }) => {
    const r = await (await request.get("/api/readiness")).json();
    expect(r.checks.map((c: any) => c.id)).toEqual(["docker", "llm", "embed", "knowledge", "task", "vpn", "htb"]);
    const byId = Object.fromEntries(r.checks.map((c: any) => [c.id, c]));
    expect(byId.docker.state).toBe("ok");
    expect(byId.task.state).toBe("ok");
    expect(byId.llm.state).toBe("ok"); // e2e: локальный пресет на мок из env
    for (const c of r.checks) expect(String(c.detail).length).toBeGreaterThan(10);
    expect(typeof r.ready).toBe("boolean");
  });

  test("UI: чеклист виден в настройках со статусами", async ({ page }) => {
    test.setTimeout(120_000);
    await openTask(page, ids);
    await page.getByTestId("settings-open").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await expect(page.getByTestId("readiness-panel")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("readiness-check")).toHaveCount(7);
    await expect(page.locator('[data-check="docker"]')).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId("readiness-summary")).toBeVisible();
  });
});
