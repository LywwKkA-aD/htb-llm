import { test, expect, createTask, mockReset, openTask, MOCK, type Ids } from "./helpers";

const MOCK_V1 = `${MOCK}/v1`;

test.describe("статистика OpenRouter: два ключа", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "OR-статистика: проверки"); });
  test.afterAll(async ({ request }) => {
    await request.put("/api/settings", {
      data: { llm: { active: "local", openrouter: { url: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash", apiKey: "", provider: "relace", quantization: "fp4", ctxWindow: 131072 } }, openrouterMgmt: { apiKey: "" } },
    });
  });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  async function setup(request: any, withMgmt: boolean) {
    const r = await request.put("/api/settings", {
      data: {
        llm: { openrouter: { url: MOCK_V1, model: "z-ai/glm-5.3-flash", apiKey: "sk-or-inference" } },
        openrouterMgmt: { apiKey: withMgmt ? "sk-or-mgmt-123" : "" },
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  }

  test("management-ключ хранится замаскированным; статистика агрегирует activity по моделям и дням", async ({ request }) => {
    const pub = await setup(request, true);
    expect(pub.openrouterMgmt.apiKeySet).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-or-mgmt-123");

    const st = await (await request.get("/api/stats/openrouter?refresh=1")).json();
    expect(st.hasInferenceKey).toBe(true);
    expect(st.hasManagementKey).toBe(true);
    expect(st.errors).toEqual({});
    expect(st.key).toMatchObject({ label: "mock-key", usage: 12.34, limit: 100 });
    expect(st.totals.cost).toBeCloseTo(4.25, 5);
    expect(st.totals.requests).toBe(270);
    expect(st.totals.promptTokens).toBe(600_000);
    expect(st.totals.reasoningTokens).toBe(12_000);
    expect(st.periodDays).toBe(2);
    expect(st.byModel[0]).toMatchObject({ model: "z-ai/glm-5.3-flash", requests: 70 });
    expect(st.byModel[0].cost).toBeCloseTo(4.0, 5);
    expect(st.byDay[0]).toMatchObject({ date: "2026-11-05", requests: 240 });
    expect(st.keys.map((k: any) => k.label)).toEqual(["whitehat-llm", "whitehat-embed"]);
  });

  test("без management-ключа: только info инференс-ключа, activity честно пустая", async ({ request }) => {
    await setup(request, false);
    const st = await (await request.get("/api/stats/openrouter?refresh=1")).json();
    expect(st.hasInferenceKey).toBe(true);
    expect(st.hasManagementKey).toBe(false);
    expect(st.key.usage).toBeCloseTo(12.34, 5);
    expect(st.totals).toBeNull();
    expect(st.byModel).toEqual([]);
    expect(st.errors).toEqual({});
  });

  test("неверный management-ключ: ошибки activity/keys видны, key info не падает", async ({ request }) => {
    const r = await request.put("/api/settings", {
      data: { llm: { openrouter: { url: MOCK_V1, model: "z-ai/glm-5.3-flash", apiKey: "sk-or-inference" } }, openrouterMgmt: { apiKey: "sk-or-wrong" } },
    });
    expect(r.ok()).toBeTruthy();
    const st = await (await request.get("/api/stats/openrouter?refresh=1")).json();
    expect(st.key.usage).toBeCloseTo(12.34, 5);
    expect(st.errors.activity).toContain("401");
    expect(st.errors.keys).toContain("401");
    expect(st.totals).toBeNull();
  });

  test("смена management-ключа не упирается в закэшированную ошибку", async ({ request }) => {
    const wrong = await request.put("/api/settings", {
      data: { llm: { openrouter: { url: MOCK_V1, model: "z-ai/glm-5.3-flash", apiKey: "[REDACTED]" } }, openrouterMgmt: { apiKey: "[REDACTED]" } },
    });
    expect(wrong.ok()).toBeTruthy();
    const bad = await (await request.get("/api/stats/openrouter?refresh=1")).json();
    expect(bad.errors.activity).toContain("401");

    await setup(request, true);
    const fixed = await (await request.get("/api/stats/openrouter")).json();
    expect(fixed.errors).toEqual({});
    expect(fixed.totals.requests).toBe(270);
  });

  test("UI: секция статистики в настройках показывает итоги и таблицу моделей", async ({ request, page }) => {
    await setup(request, true);
    // статистика закэширована сервером на минуту от прошлых тестов — UI жмёт «обновить» (refresh=1)
    await openTask(page, ids);
    await page.getByTestId("settings-open").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await expect(page.getByTestId("set-or-mgmt-key")).toHaveAttribute("placeholder", /сохранён/);
    await page.getByTestId("or-stats-refresh").click();
    await expect(page.getByTestId("or-totals")).toBeVisible();
    await expect(page.getByTestId("or-bymodel")).toContainText("z-ai/glm-5.3-flash");
    await expect(page.getByTestId("or-keys")).toContainText("whitehat-llm");
    await expect(page.getByTestId("or-key-info")).toContainText("$12.34");
    await page.keyboard.press("Escape");
  });
});
