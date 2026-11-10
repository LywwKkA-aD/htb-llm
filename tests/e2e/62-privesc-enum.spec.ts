import { test, expect, createTask, mockReset, openTask, send, waitIdle, type Ids } from "./helpers";

// privesc_enum: бандл чеклиста повышения одним вводом в job-сессию, результат секциями.
// «Цель» в e2e — bash нашего же контейнера в job: механика та же, что с пойманным reverse shell.
type Call = { name: string; args: Record<string, unknown> };
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

const toolOuts = async (request: any, chatId: string): Promise<string> => {
  const log = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return log.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output)).join("\n");
};

test.describe("privesc_enum", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Privesc enum"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("бандл выполняется в job-сессии, секции и факт профиля на месте; битый job — честная ошибка", async ({ page, request }) => {
    test.setTimeout(240_000);
    const job = await (await request.post(`/api/tasks/${ids.task.id}/jobs`, {
      data: { name: "pe-shell", command: "bash -l" },
    })).json();
    try {
      const outApi = async () => (await (await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output?lines=40`)).json()).output as string;
      await expect.poll(outApi, { timeout: 30_000 }).toMatch(/root@task-/);
      const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
      await openTask(page, { task: ids.task, chat });
      await send(page, tt([call("privesc_enum", { job: "pe-shell", timeout_sec: 120 })], [call("privesc_enum", { job: "no-such-job" })]));
      await waitIdle(page);
      const outs = await toolOuts(request, chat.id);
      expect(outs).toContain("[privesc_enum: job «pe-shell»");
      expect(outs).toContain("uid=0(root)");
      expect(outs).toContain("== SUID-бинари ==");
      expect(outs).toContain("== Cron: crontab и /etc/cron.d ==");
      expect(outs).toContain("нет такого job: no-such-job");
      const prof = await (await request.get(`/api/tasks/${ids.task.id}/profile`)).json();
      expect(JSON.stringify(prof)).toContain("privesc_enum: root@");
    } finally {
      await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`).catch(() => {});
    }
  });
});
