import { test, expect, createTask, mockRequests, mockReset, openTask, send, waitIdle, type Ids } from "./helpers";

// Лимит этапа управляемого режима: ожидание (sleep) и чтение job_output бюджет не тратят; за 2 раунда
// до границы модель получает предупреждение; на самой границе сервер доснимает свежий вывод job после
// последнего job_input — иначе модель честно писала «вывод забрать не успел — лимит этапа».
type Call = { name: string; args: Record<string, unknown> };
const sh = (command: string): Call => ({ name: "shell", args: { command } });
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

test.describe("лимит этапа управляемого режима", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, "Лимиты этапа");
    const s = await (await request.get("/api/settings")).json();
    const r = await request.put("/api/settings", { data: { agents: { ...s.agents, guidedRounds: 3 } } });
    expect(r.ok(), await r.text()).toBeTruthy();
    if ((ids.chat as any).mode !== "guided")
      await request.patch(`/api/chats/${ids.chat.id}`, { data: { mode: "guided" } });
  });
  test.afterAll(async ({ request }) => {
    const s = await (await request.get("/api/settings")).json();
    await request.put("/api/settings", { data: { agents: { ...s.agents, guidedRounds: 6 } } }).catch(() => {});
  });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  const executedCommands = async (request: any, chatId: string): Promise<string> => {
    const log = await (await request.get(`/api/chats/${chatId}/log`)).json();
    return log.log
      .filter((x: any) => x.kind === "assistant")
      .flatMap((x: any) => x.data.tool_calls ?? [])
      .map((c: any) => String(c.args?.command ?? c.name))
      .join("\n");
  };

  test("sleep не тратит раунды действий; 4-е действие при лимите 3 не выполняется; предупреждение уходит модели", async ({ page, request }) => {
    test.setTimeout(180_000);
    await openTask(page, ids);
    await send(page, tt(
      [sh("touch stg1")], [sh("sleep 1")], [sh("touch stg2")], [sh("sleep 1")], [sh("touch stg3")], [sh("touch stg4")],
    ));
    await waitIdle(page);
    const cmds = await executedCommands(request, ids.chat.id);
    expect(cmds).toContain("touch stg1");
    expect(cmds).toContain("touch stg2");
    expect(cmds).toContain("touch stg3");
    expect(cmds).not.toContain("touch stg4");
    expect(JSON.stringify(await mockRequests(request))).toContain("До конца порученного этапа осталось раундов действий: 2");
  });

  test("на границе этапа сервер доснимает вывод job после последнего job_input", async ({ page, request }) => {
    test.setTimeout(180_000);
    const job = await (await request.post(`/api/tasks/${ids.task.id}/jobs`, {
      data: { name: "collect-sim", command: "bash -c 'read x; echo GOT-$x; sleep 25'" },
    })).json();
    try {
      await page.waitForTimeout(1500); // read встал на ожидание ввода
      await openTask(page, ids);
      await send(page, tt(
        [sh("touch col1")], [sh("touch col2")], [call("job_input", { id: job.id, text: "hello42" })],
      ));
      await waitIdle(page);
      const reqs = JSON.stringify(await mockRequests(request));
      expect(reqs).toContain("доснят сервером на границе этапа");
      expect(reqs).toContain("GOT-hello42");
    } finally {
      await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`).catch(() => {});
    }
  });
});
