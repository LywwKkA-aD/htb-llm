import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect, createTask, mockReset, openTask, send, waitIdle, type Ids } from "./helpers";

// Свои строки /etc/hosts (vhost'ы) переживают перезапуск контейнера: Docker файл пересоздаёт,
// приложение зеркалит пользовательские строки в /work/.whitehat/hosts.extra и восстанавливает.
const DATA = path.resolve(process.env.E2E_DATA ?? "tests/.data");
function dexec(taskId: string, script: string) {
  const name = `whitehat-${taskId}`;
  const label = execFileSync("docker", ["inspect", "-f", '{{index .Config.Labels "whitehat.data"}}', name]).toString().trim();
  expect(label, "контейнер принадлежит этому тестовому прогону").toBe(DATA);
  return execFileSync("docker", ["exec", name, "bash", "-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

type Call = { name: string; args: Record<string, unknown> };
const sh = (command: string): Call => ({ name: "shell", args: { command } });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;
const toolOuts = async (request: any, chatId: string): Promise<string> => {
  const log = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return log.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output)).join("\n");
};

test.describe("персистентность /etc/hosts", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, "Hosts persist");
    const r = await request.patch(`/api/tasks/${ids.task.id}`, { data: { target: "10.10.10.10", hostname: "persist.htb" } });
    expect(r.ok(), await r.text()).toBeTruthy();
  });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("vhost-строка скрейпится в hosts.extra, переживает docker restart и переезжает при смене IP", async ({ page, request }) => {
    test.setTimeout(300_000);
    dexec(ids.task.id, "grep -q myvhost /etc/hosts || echo '10.10.10.10 myvhost.persist.htb' >> /etc/hosts; tail -1 /etc/hosts");
    // второе имя — прямо в строку нашего управляемого блока (так дописывали vhost'ы вживую в Enigma);
    // блок уже написан применением цели из beforeAll
    dexec(ids.task.id, "python3 -c \"p='/etc/hosts'; s=open(p).read(); open(p,'w').write(s.replace('machine.htb\\n', 'machine.htb app.persist.htb\\n'))\"");
    await openTask(page, ids);
    // скрейп происходит на ensure перед командами (троттлинг 5 с) — дёргаем, пока не ляжет в hosts.extra
    await expect.poll(async () => {
      await send(page, tt([sh("true")]));
      await waitIdle(page);
      return dexec(ids.task.id, "cat /work/.whitehat/hosts.extra 2>/dev/null || true");
    }, { timeout: 60_000, intervals: [3000] }).toContain("app.persist.htb");
    expect(dexec(ids.task.id, "cat /work/.whitehat/hosts.extra")).toContain("myvhost.persist.htb");

    execFileSync("docker", ["restart", `whitehat-${ids.task.id}`], { stdio: "ignore" });
    await page.waitForTimeout(1000);
    await send(page, tt([sh("getent hosts myvhost.persist.htb || echo NOENT")]));
    await waitIdle(page);
    expect(await toolOuts(request, ids.chat.id)).toContain("10.10.10.10");

    const p = await request.patch(`/api/tasks/${ids.task.id}`, { data: { target: "10.10.10.99" } });
    expect(p.ok(), await p.text()).toBeTruthy();
    await send(page, tt([sh("getent hosts myvhost.persist.htb || echo NOENT")]));
    await waitIdle(page);
    const outs = await toolOuts(request, ids.chat.id);
    expect(outs).toContain("10.10.10.99");
    const extra = dexec(ids.task.id, "cat /work/.whitehat/hosts.extra");
    expect(extra).toContain("10.10.10.99");
    expect(extra).toContain("myvhost.persist.htb");
  });
});
