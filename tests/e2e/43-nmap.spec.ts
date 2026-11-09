import type { APIRequestContext } from "@playwright/test";
import { test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle, type Ids } from "./helpers";

type Call = { name: string; args: Record<string, unknown> };
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

async function toolOutputs(request: APIRequestContext, chatId: string): Promise<string[]> {
  const r = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return r.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output));
}
async function profileItems(request: APIRequestContext, taskId: string): Promise<any[]> {
  return (await (await request.get(`/api/tasks/${taskId}/profile`)).json()).items;
}
async function clearProfile(request: APIRequestContext, taskId: string) {
  for (const i of await profileItems(request, taskId)) await request.delete(`/api/tasks/${taskId}/profile/${i.id}`);
}

test.describe("nmap_scan: типизированное сканирование в факты и профиль", () => {
  let ids: Ids;
  let srvJob: string;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, "Nmap: проверки");
    const r = await request.post(`/api/tasks/${ids.task.id}/jobs`, { data: { name: "websrv", command: "python3 -m http.server 18093" } });
    expect(r.ok(), await r.text()).toBeTruthy();
    srvJob = (await r.json()).id;
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${srvJob}/output`)).text(), { timeout: 20_000 }).toContain("Serving HTTP");
  });
  test.afterAll(async ({ request }) => { await request.post(`/api/tasks/${ids.task.id}/jobs/${srvJob}/stop`); });
  test.beforeEach(async ({ request }) => {
    await mockReset(request);
    await clearProfile(request, ids.task.id);
  });

  test("скан находит сервис с версией, пишет в профиль без дублей, файлы ложатся в scans/", async ({ page, request }) => {
    test.setTimeout(180_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    const last = async () => (await toolOutputs(request, chat.id)).at(-1)!;

    await send(page, tt([call("nmap_scan", { target: "127.0.0.1", ports: "18093,18091" })]));
    await waitIdle(page);
    const out = await last();
    expect(out).toContain("открытых портов: 1");
    expect(out).toContain("18093/tcp http");
    expect(out).toMatch(/Python|BaseHTTP|SimpleHTTP/); // версия/продукт из -sV, а не голая строка nmap
    expect(out).toMatch(/18091\/tcp closed|1 closed/);
    expect(out).toContain("в профиль цели записано сервисов: 1");
    expect(out).toContain("scans/nmap-");
    const txtPath = /scans\/nmap-[\w.-]+\.txt/.exec(out)?.[0];
    expect(txtPath, "путь к файлу скана").toBeTruthy();

    const prof = await profileItems(request, ids.task.id);
    expect(prof).toHaveLength(1);
    expect(prof[0]).toMatchObject({ kind: "service", host: "127.0.0.1", port: 18093, proto: "tcp", service: "http" });
    expect(prof[0].version).toMatch(/Python|0\.6/);
    expect(prof[0].source).toContain("nmap_scan");

    // файл скана настоящий и непустой
    await send(page, tt([call("shell", { command: `test -s /work/${txtPath} && echo SCANFILE-OK` })]));
    await waitIdle(page);
    expect((await toolOutputs(request, chat.id)).at(-1)).toContain("SCANFILE-OK");

    // повторный скан обновляет ту же запись профиля, а не плодит вторую
    await send(page, tt([call("nmap_scan", { target: "127.0.0.1", ports: "18093" })]));
    await waitIdle(page);
    expect(await profileItems(request, ids.task.id)).toHaveLength(1);

    // промпт направляет сканировать именно обёрткой
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    expect(textOf(req.body.messages[0].content)).toContain("Порты сканируй nmap_scan");
  });

  test("валидация: инъекция в цель и битые порты отклоняются без запуска; save_profile=false не пишет", async ({ page, request }) => {
    test.setTimeout(180_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    const last = async () => (await toolOutputs(request, chat.id)).at(-1)!;

    await send(page, tt([call("nmap_scan", { target: "127.0.0.1; echo hacked" })]));
    await waitIdle(page);
    expect(await last()).toContain("ошибка: target должен быть");

    await send(page, tt([call("nmap_scan", { target: "127.0.0.1", ports: "99999" })]));
    await waitIdle(page);
    expect(await last()).toContain("ошибка: ports");

    await send(page, tt([call("nmap_scan", { target: "127.0.0.1", ports: "18093", save_profile: false })]));
    await waitIdle(page);
    expect(await last()).toContain("открытых портов: 1");
    expect(await last()).not.toContain("в профиль цели записано");
    expect(await profileItems(request, ids.task.id)).toHaveLength(0);
  });
});
