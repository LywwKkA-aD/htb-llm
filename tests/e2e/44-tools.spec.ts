import type { APIRequestContext } from "@playwright/test";
import { test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle, type Ids } from "./helpers";

type Call = { name: string; args: Record<string, unknown> };
const sh = (command: string): Call => ({ name: "shell", args: { command } });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

async function toolOutputs(request: APIRequestContext, chatId: string): Promise<string[]> {
  const r = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return r.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output));
}

test.describe("образ: bloodyAD и katana (п.17 плана)", () => {
  let ids: Ids;
  let srvJob: string;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, "Тулы: проверки");
    const r = await request.post(`/api/tasks/${ids.task.id}/jobs`, { data: { name: "websrv", command: "python3 -m http.server 18092 --directory /work/www" } });
    expect(r.ok(), await r.text()).toBeTruthy();
    srvJob = (await r.json()).id;
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${srvJob}/output`)).text(), { timeout: 20_000 }).toContain("Serving HTTP");
  });
  test.afterAll(async ({ request }) => { await request.post(`/api/tasks/${ids.task.id}/jobs/${srvJob}/stop`); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("bloodyAD и katana установлены, запускаются, katana краулит тестовый сайт", async ({ page, request }) => {
    test.setTimeout(240_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    const outs = async () => toolOutputs(request, chat.id);

    // справки: заодно это штатная сверка перед специализированным инструментом
    await send(page, tt([sh("bloodyAD --help")], [sh("katana -version")]));
    await waitIdle(page);
    let o = await outs();
    expect(o.at(-2)).toContain("usage: bloodyAD");
    expect(o.at(-2)).toContain("-H HOST"); // полный --help в компактный вывод не влезает — проверяем голову
    expect(o.at(-2)).toMatch(/get|set|add/);
    expect(o.at(-1)).toContain("projectdiscovery"); // баннер: слово katana только ASCII-артом
    expect(o.at(-1)).toContain("Current version: v1.8.0");
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    expect(textOf(req.body.messages[0].content)).toContain("bloodyAD");

    // тестовый сайт: главная ссылается на страницу и скрипт
    await send(page, tt([sh("mkdir -p /work/www && printf '<html><a href=\"/secret-page.html\">s</a><script src=\"/app.js\"></script></html>' > /work/www/index.html && printf 'SECRET-PAGE' > /work/www/secret-page.html && printf 'fetch(\"/api/data\")' > /work/www/app.js && echo WWW-READY")]));
    await waitIdle(page);
    expect((await outs()).at(-1)).toContain("WWW-READY");

    await send(page, tt([sh("katana -u http://127.0.0.1:18092 -d 2 -jc -silent -duc")]));
    await waitIdle(page);
    o = await outs();
    expect(o.at(-1)).toContain("secret-page.html");
    expect(o.at(-1)).toContain("app.js");

    // bloodyAD без DC падает ошибкой соединения, а не битыми импортами установки
    await send(page, tt([sh("bloodyAD --host 127.0.0.1 -d test.local -u a -p b get object 'DC=test,DC=local' 2>&1 | tail -3")]));
    await waitIdle(page);
    o = await outs();
    expect(o.at(-1)).not.toContain("ModuleNotFoundError");
    expect(o.at(-1)).not.toContain("command not found");
    expect(o.at(-1)).toMatch(/error|refused|connect|failed|exception|ldap/i);
  });
});
