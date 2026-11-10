import { test, expect, createTask, mockReset, openTask, send, waitIdle, type Ids } from "./helpers";

// cred_check: пара кред проверяется netexec-ом одним вызовом; успех пишется кредой в профиль,
// отказ — обновляемым фактом «НЕ подходит». Цель — impacket-smbserver в том же контейнере (job).
type Call = { name: string; args: Record<string, unknown> };
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

const toolOuts = async (request: any, chatId: string): Promise<string> => {
  const log = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return log.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output)).join("\n");
};

test.describe("cred_check", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Проверка кред"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("smb: верный пароль — вход и креды в профиле; неверный — отказ и факт-негатив", async ({ page, request }) => {
    test.setTimeout(300_000);
    const job = await (await request.post(`/api/tasks/${ids.task.id}/jobs`, {
      data: {
        name: "smb-target",
        command: "bash -lc 'S=$(command -v impacket-smbserver || command -v smbserver.py); echo USE=$S; mkdir -p /tmp/whshare; $S share /tmp/whshare -smb2support -username whusr -password WhPass123x & sleep 3; ss -tlnp 2>/dev/null | grep 445; sleep 240'",
      },
    })).json();
    try {
      const outApi = async () => (await (await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output?lines=60`)).json()).output as string;
      await expect.poll(outApi, { timeout: 60_000 }).toMatch(/LISTEN.*445|445.*LISTEN/);
      const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
      await openTask(page, { task: ids.task, chat });
      await send(page, tt([call("cred_check", { username: "whusr", secret: "WhPass123x", host: "127.0.0.1", services: ["smb"] })]));
      await waitIdle(page);
      const first = await toolOuts(request, chat.id);
      expect(first, first.slice(-800)).toContain("smb: ВХОД ЕСТЬ");
      const prof1 = JSON.stringify(await (await request.get(`/api/tasks/${ids.task.id}/profile`)).json());
      expect(prof1).toContain("whusr");
      expect(prof1).toContain("cred_check");
      await send(page, tt([call("cred_check", { username: "whusr", secret: "WrongPass9", host: "127.0.0.1", services: ["smb"] })]));
      await waitIdle(page);
      const all = await toolOuts(request, chat.id);
      expect(all).toContain("smb: отказ");
      const prof2 = JSON.stringify(await (await request.get(`/api/tasks/${ids.task.id}/profile`)).json());
      expect(prof2).toContain("НЕ подходит");
    } finally {
      await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`).catch(() => {});
    }
  });
});
