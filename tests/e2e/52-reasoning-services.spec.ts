import { test, expect, createTask, mockRequests, mockReset, openTask, send, waitIdle, MOCK, type Ids } from "./helpers";

const MOCK_V1 = `${MOCK}/v1`;

async function setPresets(request: any, llm: "local" | "openrouter", embed: "local" | "openrouter") {
  const r = await request.put("/api/settings", {
    data: {
      llm: { active: llm, local: { url: MOCK_V1, model: "Qwen3.8-27B-Turbo", ctxWindow: 65536 }, openrouter: { url: MOCK_V1, model: "z-ai/glm-5.3-flash", apiKey: "[REDACTED]", ctxWindow: 131072 } },
      embed: { active: embed, local: { url: MOCK_V1, model: "embed" }, openrouter: { url: MOCK_V1, model: "cohere/embed-5-fast", apiKey: "[REDACTED]" } },
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
}

test.describe("reasoning по модели и локальные сервисы по пресетам", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Reasoning и сервисы"); });
  test.afterAll(async ({ request }) => {
    await request.put("/api/settings", {
      data: {
        llm: { active: "local", openrouter: { url: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash", apiKey: "", provider: "relace", quantization: "fp4", ctxWindow: 131072 } },
        embed: { active: "local", openrouter: { url: "https://openrouter.ai/api/v1", model: "cohere/embed-5-fast", apiKey: "" } },
      },
    });
  });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("GLM: health и селектор дают только max/high/low, выбранный max уходит без понижения до high", async ({ request, page }) => {
    await setPresets(request, "openrouter", "local");
    const health = await (await request.get("/api/health")).json();
    expect(health.reasoning).toMatchObject({ supportedEfforts: ["max", "high", "low"], defaultEffort: "max", mandatory: true });

    await openTask(page, ids);
    await expect(page.getByTestId("effort-max")).toBeVisible();
    await expect(page.getByTestId("effort-high")).toBeVisible();
    await expect(page.getByTestId("effort-low")).toBeVisible();
    await expect(page.getByTestId("effort-medium")).toHaveCount(0);
    await expect(page.getByTestId("effort-off")).toHaveCount(0);

    await page.getByTestId("effort-max").click();
    await send(page, "привет [[nomem]]");
    await waitIdle(page);
    let last = (await mockRequests(request)).filter((x) => x.kind === "agent").at(-1) as any;
    expect(last.body.reasoning).toEqual({ effort: "max" });

    await page.getByTestId("effort-low").click();
    await send(page, "ещё привет [[nomem]]");
    await waitIdle(page);
    last = (await mockRequests(request)).filter((x) => x.kind === "agent").at(-1) as any;
    expect(last.body.reasoning).toEqual({ effort: "low" });
  });

  test("локальные сервисы скрываются по каждому внешнему пресету отдельно", async ({ request, page }) => {
    await setPresets(request, "openrouter", "local");
    await openTask(page, ids);
    await expect(page.getByTestId("service-llm")).toHaveCount(0);
    await expect(page.getByTestId("service-embed")).toBeVisible();

    await setPresets(request, "openrouter", "openrouter");
    await page.reload();
    await expect(page.getByTestId("services")).toHaveCount(0);
    await expect(page.getByTestId("service-llm")).toHaveCount(0);
    await expect(page.getByTestId("service-embed")).toHaveCount(0);

    await setPresets(request, "local", "openrouter");
    await page.reload();
    await expect(page.getByTestId("service-llm")).toBeVisible();
    await expect(page.getByTestId("service-embed")).toHaveCount(0);
  });
});
