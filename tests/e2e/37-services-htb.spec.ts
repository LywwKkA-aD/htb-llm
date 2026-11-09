import { test, expect, createTask, mockReset, openTask, type Ids } from "./helpers";

// Управление моделями из веба (в тестах WH_SERVICES=off: настоящие llama-процессы не трогаем,
// проверяем честное «управление отключено») и интеграция HTB по App Token против стаба в mock-llm
// (WH_HTB_API_URL указывает на мок; принимается только test-htb-token-0123456789). Токен после себя удаляем:
// блок HTB живёт в сайдбаре всех экранов, чужой «подключённый» профиль сломал бы соседние спеки.

test.describe("сервисы моделей и HTB", () => {
  let ids: Ids;
  let importedTaskId = "";
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, "Сервисы и HTB");
    await request.delete("/api/htb/token").catch(() => {});
    await mockReset(request);
  });
  test.afterAll(async ({ request }) => {
    await request.delete("/api/htb/token").catch(() => {});
    await mockReset(request).catch(() => {});
  });

  test("сервисы: статус отдаёт обе модели, в тестовом окружении управление честно отключено", async ({ request }) => {
    const list = (await (await request.get("/api/services")).json()) as any[];
    expect(list.map((s) => s.id)).toEqual(["llm", "embed"]);
    for (const s of list) {
      expect(s.managed).toBe(false);
      expect(s.detail).toContain("WH_SERVICES=off");
      expect(s.state).toBe("running"); // мок отвечает на пробы — статус не врёт, что выключено
    }
    const start = await request.post("/api/services/llm/start");
    expect(start.status()).toBe(400);
    expect((await start.json()).error).toContain("WH_SERVICES=off");
    expect((await request.post("/api/services/bogus/start")).status()).toBe(404);
  });

  test("сервисы в сайдбаре: обе строки видны, кнопки недоступны без управления", async ({ page }) => {
    await openTask(page, ids);
    for (const id of ["llm", "embed"]) {
      await expect(page.getByTestId(`service-${id}`)).toBeVisible();
      await expect(page.getByTestId(`service-${id}`)).toHaveAttribute("data-state", "running");
      await expect(page.getByTestId(`service-toggle-${id}`)).toBeDisabled();
    }
  });

  test("HTB API: битый токен отклоняется, хороший даёт профиль, прогресс и активную машину", async ({ request }) => {
    expect((await (await request.get("/api/htb/status")).json()).configured).toBe(false);

    const bad = await request.post("/api/htb/token", { data: { token: "wrong-token-wrong-token" } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toContain("недействителен");
    // битый токен не сохранился
    expect((await (await request.get("/api/htb/status")).json()).configured).toBe(false);

    const ok = await request.post("/api/htb/token", { data: { token: "test-htb-token-0123456789" } });
    expect(ok.ok(), await ok.text()).toBeTruthy();

    const st = await (await request.get("/api/htb/status?refresh=1")).json();
    expect(st.configured).toBe(true);
    expect(st.user).toMatchObject({ name: "mockhacker", rank: "Pro Hacker", points: 321, userOwns: 12, systemOwns: 9, nextRank: "Elite Hacker", level: 12, levelTitle: "Apprentice", levelGrade: "1", xpInLevel: 40, xpUntilNext: 60, xpTotal: 940 });
    expect(st.activeMachine).toMatchObject({ id: 777, name: "MockBox", ip: "10.129.9.9", difficultyText: "Easy", os: "Linux" });

    const found = (await (await request.get("/api/htb/machines?q=second")).json()) as any[];
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 778, name: "SecondBox", difficultyText: "Medium", os: "Windows", ownedUser: true });
  });

  test("HTB API: импорт активной машины создаёт задачу один раз; spawn/stop переключают активную", async ({ request }) => {
    const imp = await request.post("/api/htb/import", { data: {} });
    expect(imp.ok(), await imp.text()).toBeTruthy();
    const r1 = await imp.json();
    importedTaskId = r1.task.id;
    expect(r1.existed).toBe(false);
    expect(r1.task.title).toBe("MockBox");
    expect(r1.task.brief).toContain("HTB machine #777");
    expect(r1.task.brief).toContain("10.129.9.9");
    expect(r1.task.target).toBe("10.129.9.9");
    expect(r1.task.hostname).toBe("mockbox.htb");

    const r2 = await (await request.post("/api/htb/import", { data: {} })).json();
    expect(r2.existed).toBe(true);
    expect(r2.task.id).toBe(importedTaskId);

    // респаун той же машины с новым IP: статус HTB синкает TARGET и бриф существующей задачи
    await request.post("/api/htb/spawn", { data: { machineId: 777 } });
    await request.get("/api/htb/status?refresh=1");
    const synced = ((await (await request.get("/api/tasks")).json()) as any[]).find((t) => t.id === importedTaskId);
    expect(synced.target).toBe("10.129.9.10");
    expect(synced.brief).toContain("10.129.9.10");

    const spawned = await (await request.post("/api/htb/spawn", { data: { machineId: 778 } })).json();
    expect(spawned.activeMachine).toMatchObject({ id: 778, name: "SecondBox", ip: "10.129.9.10" });
    const stopped = await (await request.post("/api/htb/stop")).json();
    expect(stopped.activeMachine).toBeNull();
    await mockReset(request); // вернуть MockBox активной в моке для UI-теста
  });

  test("HTB UI: подключение через диалог, профиль и импорт из блока сайдбара", async ({ page, request }) => {
    await request.delete("/api/htb/token");
    await openTask(page, ids);
    await expect(page.getByTestId("htb-connect")).toBeVisible();
    await page.getByTestId("htb-connect").click();
    await page.getByTestId("htb-token-input").fill("test-htb-token-0123456789");
    await page.getByTestId("htb-token-save").click();

    await expect(page.getByTestId("htb-user-name")).toHaveText("mockhacker");
    await expect(page.getByTestId("htb-level")).toContainText("Lvl 12");
    await expect(page.getByTestId("htb-level")).toContainText("Apprentice");
    await expect(page.getByTestId("htb-xp")).toContainText("40/100 XP");
    await expect(page.getByTestId("htb-owns")).toContainText("12");
    await expect(page.getByTestId("htb-owns")).toContainText("9");
    await page.getByTestId("htb-refresh").click(); // кэш сервера после внешнего mockReset
    await expect(page.getByTestId("htb-active")).toContainText("MockBox");
    await expect(page.getByTestId("htb-active-ip")).toHaveText("10.129.9.9");

    await page.getByTestId("htb-import-active").click();
    // навигация без URL-роутов: открытая задача — aria-current у её строки в сайдбаре
    await expect(page.locator(`[data-testid="task-item"][data-task-id="${importedTaskId}"]`)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("sidebar")).toContainText("MockBox");
  });
});
