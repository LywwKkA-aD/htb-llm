import { test, expect, mockReset } from "./helpers";

// Коллизия префиксов id машин HTB: Lame #1 матчился префиксным LIKE в Shocker #108 —
// импорт открывал чужую задачу, а синк активного инстанса переписывал ей цель.
// Здесь та же пара на моке: #77 против #777.
test.describe("импорт HTB: точное совпадение id машины", () => {
  test.beforeAll(async ({ request }) => {
    await request.delete("/api/htb/token").catch(() => {});
    const r = await request.post("/api/htb/token", { data: { token: "test-htb-token-0123456789" } });
    expect(r.ok(), await r.text()).toBeTruthy();
  });
  test.afterAll(async ({ request }) => { await request.delete("/api/htb/token").catch(() => {}); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("#77 не открывается как #777; синк IP активной #77 не трогает #777", async ({ request }) => {
    test.setTimeout(180_000);
    const imp = async (machineId: number) => (await (await request.post("/api/htb/import", { data: { machineId } })).json()) as any;
    const a = await imp(777); // existed зависит от соседних спек прогона — важна только её задача
    const b = await imp(77);
    expect(b.existed, "машина #77 не должна находиться по префиксу #777").toBeFalsy();
    expect(b.task.id).not.toBe(a.task.id);
    expect(b.task.title).toBe("PrefixBox");
    const b2 = await imp(77);
    expect(b2.existed).toBeTruthy();
    expect(b2.task.id).toBe(b.task.id);

    const spawn = await request.post("/api/htb/spawn", { data: { machineId: 77 } });
    expect(spawn.ok(), await spawn.text()).toBeTruthy();
    await request.get("/api/htb/status?refresh=1");
    const all = await (await request.get("/api/tasks")).json();
    const aNow = all.find((t: any) => t.id === a.task.id);
    const bNow = all.find((t: any) => t.id === b.task.id);
    expect(bNow.target).toBe("10.129.9.10"); // IP спавна в моке фиксированный
    expect(aNow.target).not.toBe("10.129.9.10");
  });
});
