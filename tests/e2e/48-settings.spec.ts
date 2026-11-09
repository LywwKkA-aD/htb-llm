import { test, expect, createTask, mockRequests, mockReset, openTask, send, waitIdle, MOCK, type Ids } from "./helpers";

// Общие настройки моделей глобальны для сервера: каждый тест возвращает активный пресет
// на local (мок), а afterAll — полное исходное состояние, чтобы не утащить чужие спеки.
const MOCK_V1 = `${MOCK}/v1`;

async function restore(request: any) {
  await request.put("/api/settings", {
    data: {
      llm: { active: "local", local: { url: MOCK_V1, model: "Qwen3.8-27B-Turbo", apiKey: "", provider: "", quantization: "", ctxWindow: 65536 },
        openrouter: { url: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash", apiKey: "", provider: "relace", quantization: "fp4", ctxWindow: 131072 },
        custom: { url: "", model: "", apiKey: "", provider: "", quantization: "", ctxWindow: 65536 } },
      embed: { active: "local", local: { url: MOCK_V1, model: "embed", apiKey: "", provider: "", quantization: "" } },
    },
  });
}

test.describe("общие настройки моделей", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Настройки: проверки"); });
  test.afterAll(async ({ request }) => { await restore(request); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("GET /api/settings: пресеты и дефолты, ключи наружу не утекают", async ({ request }) => {
    const r = await request.get("/api/settings");
    expect(r.ok()).toBeTruthy();
    const s = await r.json();
    expect(s.llm.active).toBe("local");
    expect(s.llm.local).toMatchObject({ url: MOCK_V1, model: "Qwen3.8-27B-Turbo", apiKeySet: false, ctxWindow: 65536 });
    expect(s.llm.openrouter).toMatchObject({ url: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash", provider: "relace", quantization: "fp4" });
    expect(s.embed.active).toBe("local");
    expect(s.embed.openrouter.model).toBe("cohere/embed-5-fast");
    expect(JSON.stringify(s)).not.toContain("apiKey\":");
  });

  test("PUT валидация: кривой URL, пустой активный пресет, битое окно контекста", async ({ request }) => {
    expect((await request.put("/api/settings", { data: { llm: { custom: { url: "не-адрес" } } } })).status()).toBe(400);
    expect((await request.put("/api/settings", { data: { llm: { active: "custom", custom: { url: "", model: "" } } } })).status()).toBe(400);
    expect((await request.put("/api/settings", { data: { llm: { active: "нет-такого" } } })).status()).toBe(400);
    expect((await request.put("/api/settings", { data: { llm: { local: { ctxWindow: 100 } } } })).status()).toBe(400);
    // активный пресет после отказов не сдвинулся
    const s = await (await request.get("/api/settings")).json();
    expect(s.llm.active).toBe("local");
  });

  test("свой API: модель и ключ уходят в запрос, health показывает активную модель", async ({ request, page }) => {
    const put = await request.put("/api/settings", {
      data: { llm: { active: "custom", custom: { url: MOCK_V1, model: "z-ai/glm-5.3-flash", apiKey: "sk-secret-123", ctxWindow: 131072 } } },
    });
    expect(put.ok(), await put.text()).toBeTruthy();
    const pub = await put.json();
    expect(pub.llm.custom.apiKeySet).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-secret-123");

    const health = await (await request.get("/api/health")).json();
    expect(health).toMatchObject({ model: "z-ai/glm-5.3-flash", ctxWindow: 131072, preset: "custom", llm: true });

    await openTask(page, ids);
    await send(page, "скажи коротко привет [[nomem]]");
    await waitIdle(page);
    const last = (await mockRequests(request)).filter((x) => x.kind === "agent").at(-1) as any;
    expect(last.body.model).toBe("z-ai/glm-5.3-flash");
    expect(last.auth).toBe("Bearer sk-secret-123");
    expect(last.body.reasoning).toBeTruthy(); // внешнему API — стандартный параметр, не llama-шаблон
    expect(last.body.chat_template_kwargs).toBeUndefined();

    await restore(request);
    const back = await (await request.get("/api/health")).json();
    expect(back).toMatchObject({ model: "Qwen3.8-27B-Turbo", preset: "local" });
  });

  test("OpenRouter: роутинг провайдера и квантизация попадают в тело запроса", async ({ request, page }) => {
    const put = await request.put("/api/settings", {
      data: { llm: { active: "openrouter", openrouter: { url: MOCK_V1, model: "z-ai/glm-5.3-flash", provider: "relace, together", quantization: "fp4" } } },
    });
    expect(put.ok(), await put.text()).toBeTruthy();
    await openTask(page, ids);
    await send(page, "ещё привет [[nomem]]");
    await waitIdle(page);
    const last = (await mockRequests(request)).filter((x) => x.kind === "agent").at(-1) as any;
    expect(last.body.provider).toEqual({ allow_fallbacks: true, order: ["relace", "together"], quantizations: ["fp4"] });
    await restore(request);
  });

  test("проверка соединения: llm/embed по моку ок, мёртвый адрес — честный отказ", async ({ request }) => {
    const llm = await (await request.post("/api/settings/test", { data: { kind: "llm", preset: "local" } })).json();
    expect(llm.ok).toBe(true);
    const emb = await (await request.post("/api/settings/test", { data: { kind: "embed", preset: "local" } })).json();
    expect(emb.ok).toBe(true);
    expect(emb.detail).toContain("1024");
    const dead = await (await request.post("/api/settings/test", {
      data: { kind: "llm", preset: "custom", config: { url: "http://127.0.0.1:1/v1", model: "x" } },
    })).json();
    expect(dead.ok).toBe(false);
  });

  test("UI: шестерёнка открывает настройки, смена пресета и сохранение действуют сразу", async ({ request, page }) => {
    await openTask(page, ids);
    await page.getByTestId("settings-open").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await expect(page.getByTestId("set-llm-model")).toHaveValue("Qwen3.8-27B-Turbo");

    await page.getByTestId("set-llm-preset-openrouter").click();
    await expect(page.getByTestId("set-llm-model")).toHaveValue("z-ai/glm-5.3-flash");
    await expect(page.getByTestId("set-llm-provider")).toHaveValue("relace");
    await expect(page.getByTestId("set-llm-quant")).toHaveValue("fp4");
    // направляем пресет на мок, чтобы проверка и ход остались локальными
    await page.getByTestId("set-llm-url").fill(MOCK_V1);
    await page.getByTestId("set-llm-test").click();
    await expect(page.getByTestId("set-llm-result")).toContainText(/доступна|отвечает/);
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();

    const health = await (await request.get("/api/health")).json();
    expect(health).toMatchObject({ preset: "openrouter", model: "z-ai/glm-5.3-flash" });
    await restore(request);
  });
});
