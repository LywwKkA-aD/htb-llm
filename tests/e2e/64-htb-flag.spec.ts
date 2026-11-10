import { test, expect, createTask, mockReset, openTask, type Ids } from "./helpers";

// Сдача флага в HTB: сервер резолвит машину (явный id → маркер брифа задачи → активная),
// ответ HTB показывает как есть. Стаб мока: верный флаг — 0123…cdef, машина по умолчанию — MockBox #777.
const GOOD = "0123456789abcdef0123456789abcdef";

test.describe("сдача флага HTB", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, "Флаг HTB");
    await request.delete("/api/htb/token").catch(() => {});
    const r = await request.post("/api/htb/token", { data: { token: "test-htb-token-0123456789" } });
    expect(r.ok(), await r.text()).toBeTruthy();
  });
  test.afterAll(async ({ request }) => { await request.delete("/api/htb/token").catch(() => {}); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("API: неверный флаг, верный флаг, повтор, битый формат", async ({ request }) => {
    const submit = (data: any) => request.post("/api/htb/submit-flag", { data });
    const bad = await (await submit({ flag: "00000000000000000000000000000000" })).json();
    expect(bad.ok).toBeFalsy();
    expect(bad.message).toContain("Incorrect flag");
    const good = await (await submit({ flag: GOOD })).json();
    expect(good.ok).toBeTruthy();
    expect(good.machineId).toBe(777);
    expect(good.message).toContain("owned");
    expect(good.status?.activeMachine?.ownedUser).toBeTruthy();
    const again = await (await submit({ flag: GOOD })).json();
    expect(again.ok).toBeFalsy();
    expect(again.message).toContain("already owned");
    expect((await submit({ flag: "not-a-flag" })).status()).toBe(400);
  });

  test("API: машина резолвится по маркеру брифа импортированной задачи", async ({ request }) => {
    const imp = await (await request.post("/api/htb/import", { data: {} })).json();
    const r = await (await request.post("/api/htb/submit-flag", { data: { taskId: imp.task.id, flag: GOOD } })).json();
    expect(r.ok).toBeTruthy();
    expect(r.machineId).toBe(777);
  });

  test("UI: форма в блоке активной машины сдаёт флаг и показывает ответ HTB", async ({ page }) => {
    test.setTimeout(120_000);
    await openTask(page, ids);
    await expect(page.getByTestId("htb-active")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("htb-flag-input").fill(GOOD);
    await page.getByTestId("htb-flag-submit").click();
    await expect(page.getByTestId("htb-flag-msg")).toContainText("owned", { timeout: 20_000 });
  });
});
