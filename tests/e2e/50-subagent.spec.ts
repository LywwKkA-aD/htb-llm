import { test, expect, createTask, mockRequests, mockReset, openTask, send, waitIdle, MOCK, type Ids } from "./helpers";

const MOCK_V1 = `${MOCK}/v1`;
type Call = { name: string; args: Record<string, unknown> };
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;
const spawn = (task: string, label = "тест"): Call => ({ name: "spawn_subagent", args: { task, label } });

async function setAgents(request: any, llmActive: "local" | "custom", agents: object) {
  const r = await request.put("/api/settings", {
    data: {
      llm: { active: llmActive, custom: { url: MOCK_V1, model: "z-ai/glm-5.3-flash", apiKey: "sk-sub-1", ctxWindow: 131072 } },
      agents,
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
}
async function toolOutputs(request: any, chatId: string, name: string): Promise<string[]> {
  const r = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return r.log.filter((x: any) => x.kind === "tool_result" && x.data.name === name).map((x: any) => String(x.data.output));
}
const toolNames = (reqs: any[], kind: string) =>
  ((reqs.find((x) => x.kind === kind)?.body.tools ?? []) as any[]).map((t) => t.function.name);

test.describe("spawn_subagent: подагент-исследователь", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Подагенты: проверки"); });
  test.afterAll(async ({ request }) => {
    await request.put("/api/settings", {
      data: { llm: { active: "local", custom: { url: "", model: "", apiKey: "" } }, agents: { subagents: false, maxPerTurn: 3, maxRounds: 8 } },
    });
  });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("делегирование: подагент ищет по базе своим циклом и возвращает сводку главной модели", async ({ request, page }) => {
    await setAgents(request, "custom", { subagents: true, maxPerTurn: 3, maxRounds: 8 });
    await openTask(page, ids);
    await send(page, tt([spawn("выполни поиск: shadow credentials атака")]));
    await waitIdle(page);

    const out = (await toolOutputs(request, ids.chat.id, "spawn_subagent")).at(-1)!;
    expect(out).toContain("[подагент «тест»: завершил");
    expect(out).toContain("Сводка подагента: поиск выполнен");
    expect(out).toContain("search_docs");

    const reqs = await mockRequests(request) as any[];
    // главной модели инструмент виден только когда доступен
    expect(toolNames(reqs, "agent")).toContain("spawn_subagent");
    // подагент ходил отдельным запросом со своим системным промптом и урезанным набором
    const sub = reqs.filter((x) => x.kind === "subagent");
    expect(sub.length).toBeGreaterThan(0);
    expect(String(sub[0].body.messages[0].content)).toContain("РАЗРЕШЁННЫЙ УЧЕБНЫЙ КОНТЕКСТ (HTB / HTB ACADEMY)");
    const subTools = toolNames(sub, "subagent");
    expect(subTools).toContain("search_docs");
    expect(subTools).not.toContain("shell");
    expect(subTools).not.toContain("spawn_subagent");
    expect(subTools).not.toContain("plan_update");
    expect(sub[0].auth).toBe("Bearer sk-sub-1");
  });

  test("лимит на ход: второй подагент при maxPerTurn=1 отклоняется сервером", async ({ request, page }) => {
    await setAgents(request, "custom", { subagents: true, maxPerTurn: 1, maxRounds: 8 });
    await openTask(page, ids);
    await send(page, tt(
      [spawn("выполни поиск: kerberos билеты", "первый")],
      [spawn("выполни поиск: adcs esc1", "второй")],
    ));
    await waitIdle(page);
    const outs = (await toolOutputs(request, ids.chat.id, "spawn_subagent")).slice(-2);
    expect(outs.length).toBe(2);
    expect(outs[0]).toContain("Сводка подагента");
    expect(outs[1]).toContain("[лимит подагентов — не выполнено]");
  });

  test("доступность: тумблер выкл или локальный пресет — инструмента у модели нет", async ({ request, page }) => {
    await setAgents(request, "custom", { subagents: false, maxPerTurn: 3, maxRounds: 8 });
    await openTask(page, ids);
    await send(page, "привет [[nomem]]");
    await waitIdle(page);
    expect(toolNames(await mockRequests(request) as any[], "agent")).not.toContain("spawn_subagent");

    await mockReset(request);
    await setAgents(request, "local", { subagents: true, maxPerTurn: 3, maxRounds: 8 });
    await send(page, "ещё привет [[nomem]]");
    await waitIdle(page);
    expect(toolNames(await mockRequests(request) as any[], "agent")).not.toContain("spawn_subagent");
  });

  test("валидация настроек агентов", async ({ request }) => {
    expect((await request.put("/api/settings", { data: { agents: { maxPerTurn: 99 } } })).status()).toBe(400);
    expect((await request.put("/api/settings", { data: { agents: { maxRounds: 0 } } })).status()).toBe(400);
    const ok = await request.put("/api/settings", { data: { agents: { subagents: true, maxPerTurn: 2 } } });
    expect(ok.ok(), await ok.text()).toBeTruthy();
    expect((await ok.json()).agents).toMatchObject({ subagents: true, maxPerTurn: 2 });
  });
});
