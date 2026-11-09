import type { APIRequestContext } from "@playwright/test";
import { test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle, type Ids } from "./helpers";

type Call = { name: string; args: Record<string, unknown> };
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const sh = (command: string): Call => ({ name: "shell", args: { command } });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

async function toolOutputs(request: APIRequestContext, chatId: string): Promise<string[]> {
  const r = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return r.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output));
}

test.describe("ffuf_scan: типизированный фазинг", () => {
  let ids: Ids;
  let srvJob: string;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, "Ffuf: проверки");
    const r = await request.post(`/api/tasks/${ids.task.id}/jobs`, { data: { name: "websrv", command: "python3 -m http.server 18096 --directory /work/www" } });
    expect(r.ok(), await r.text()).toBeTruthy();
    srvJob = (await r.json()).id;
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${srvJob}/output`)).text(), { timeout: 20_000 }).toContain("Serving HTTP");
  });
  test.afterAll(async ({ request }) => { await request.post(`/api/tasks/${ids.task.id}/jobs/${srvJob}/stop`); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("path-режим: находит страницы по словарю и расширениям, находки фактами, JSON в scans/", async ({ page, request }) => {
    test.setTimeout(180_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    const last = async () => (await toolOutputs(request, chat.id)).at(-1)!;

    await send(page, tt([sh("mkdir -p /work/www && echo HOME > /work/www/index.html && echo ADMINPAGE > /work/www/admin.html && echo CONFIGPHP > /work/www/config.php && printf 'admin\\nindex\\nconfig\\nnope\\n' > /work/wl.txt && echo SITE-READY")]));
    await waitIdle(page);
    expect(await last()).toContain("SITE-READY");

    await send(page, tt([call("ffuf_scan", { url: "http://127.0.0.1:18096", wordlist: "/work/wl.txt", extensions: ".html,.php" })]));
    await waitIdle(page);
    const out = await last();
    expect(out).toContain("находок: 3");
    expect(out).toContain("admin.html");
    expect(out).toContain("index.html");
    expect(out).toContain("config.php");
    expect(out).not.toContain("nope");
    expect(out).toContain("scans/ffuf-");
    const jsonPath = /scans\/ffuf-[\w.-]+\.json/.exec(out)?.[0];
    expect(jsonPath).toBeTruthy();
    await send(page, tt([sh(`test -s /work/${jsonPath} && echo FFUFJSON-OK`)]));
    await waitIdle(page);
    expect((await toolOutputs(request, chat.id)).at(-1)).toContain("FFUFJSON-OK");
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    expect(textOf(req.body.messages[0].content)).toContain("ffuf_scan");
  });

  test("vhost-режим: базовый размер замеряется и фильтруется, настоящий vhost находится", async ({ page, request }) => {
    test.setTimeout(180_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    const last = async () => (await toolOutputs(request, chat.id)).at(-1)!;

    const srv = [
      "cat > /tmp/vhost-srv.py <<'PY'",
      "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
      "class H(BaseHTTPRequestHandler):",
      "    def log_message(self, *a): pass",
      "    def do_GET(self):",
      "        host = self.headers.get('Host') or ''",
      "        b = b'VHOST-ADMIN-PANEL-LONG' if host.startswith('admin.') else b'HOME'",
      "        self.send_response(200)",
      "        self.send_header('Content-Type', 'text/plain')",
      "        self.send_header('Content-Length', str(len(b)))",
      "        self.end_headers()",
      "        self.wfile.write(b)",
      "srv = ThreadingHTTPServer(('127.0.0.1', 18097), H)",
      "print('READY', flush=True)",
      "srv.serve_forever()",
      "PY",
    ].join("\n");
    await send(page, tt(
      [sh("grep -q 'test.local' /etc/hosts || echo '127.0.0.1 test.local' >> /etc/hosts; getent hosts test.local")],
      [sh(srv)],
      [call("job_start", { name: "vhostsrv", command: "python3 /tmp/vhost-srv.py" })],
    ));
    await waitIdle(page);
    const jobsList = await (await request.get(`/api/tasks/${ids.task.id}/jobs`)).json() as any[];
    const vjob = jobsList.find((j: any) => j.name === "vhostsrv");
    expect(vjob?.running).toBe(true);
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${vjob.id}/output`)).text(), { timeout: 20_000 }).toContain("READY");

    await send(page, tt([sh("printf 'admin\\ndev\\nnope\\n' > /work/vhosts.txt && echo VHWL-OK")]));
    await waitIdle(page);
    await send(page, tt([call("ffuf_scan", { mode: "vhost", url: "http://test.local:18097", wordlist: "/work/vhosts.txt" })]));
    await waitIdle(page);
    const out = await last();
    expect(out).toContain("базовый размер");
    expect(out).toContain("находок: 1");
    expect(out).toContain("admin (");
    await request.post(`/api/tasks/${ids.task.id}/jobs/${vjob.id}/stop`);
  });

  test("валидация: инъекция в URL, словарь вне разрешённых путей, vhost по IP", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    const last = async () => (await toolOutputs(request, chat.id)).at(-1)!;

    await send(page, tt([call("ffuf_scan", { url: "http://127.0.0.1:18096/FUZZ; echo hacked" })]));
    await waitIdle(page);
    expect(await last()).toContain("ошибка:");

    await send(page, tt([call("ffuf_scan", { url: "http://127.0.0.1:18096", wordlist: "/etc/passwd" })]));
    await waitIdle(page);
    expect(await last()).toContain("ошибка: wordlist");

    await send(page, tt([call("ffuf_scan", { mode: "vhost", url: "http://127.0.0.1:18096" })]));
    await waitIdle(page);
    expect(await last()).toContain("нужен домен");
  });
});
