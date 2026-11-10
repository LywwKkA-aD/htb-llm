import { test, expect, createTask, mockReset, openTask, send, waitIdle, type Ids } from "./helpers";

// Привеск-подсказки сервера: задача расписания в выводе → напоминание проследить цепочку исполнения,
// а не уходить в экзотику (урок Connected: incron/root include из записываемого веб-корня).
type Call = { name: string; args: Record<string, unknown> };
const sh = (command: string): Call => ({ name: "shell", args: { command } });
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

const toolOuts = async (request: any, chatId: string): Promise<string> => {
  const log = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return log.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output)).join("\n");
};

test.describe("привеск-подсказки", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Привеск-подсказки"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("строка crontab в выводе shell → подсказка про цепочку исполнения", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await send(page, tt([sh("printf '%s\\n' '*/5 * * * * root /opt/wh-backup.sh'")]));
    await waitIdle(page);
    expect(await toolOuts(request, chat.id)).toContain("цепочку исполнения");
  });

  test("incron-строка в job → подсказка в job_output", async ({ page, request }) => {
    test.setTimeout(120_000);
    const job = await (await request.post(`/api/tasks/${ids.task.id}/jobs`, {
      data: { name: "incron-sim", command: "bash -c 'echo \"/var/www/html IN_MODIFY,IN_CREATE /usr/sbin/wh-ha-helper\"; sleep 30'" },
    })).json();
    try {
      const outApi = async () => (await (await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output?lines=40`)).json()).output as string;
      await expect.poll(outApi, { timeout: 20_000 }).toContain("IN_MODIFY");
      const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
      await openTask(page, { task: ids.task, chat });
      await send(page, tt([call("job_output", { id: job.id })]));
      await waitIdle(page);
      expect(await toolOuts(request, chat.id)).toContain("цепочку исполнения");
    } finally {
      await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`).catch(() => {});
    }
  });
});
