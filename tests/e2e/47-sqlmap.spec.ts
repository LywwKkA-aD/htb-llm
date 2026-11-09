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

const SRV = [
  "cat > /tmp/sqli-srv.py <<'PY'",
  "import sqlite3",
  "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
  "from urllib.parse import urlparse, parse_qs",
  "db = sqlite3.connect(':memory:', check_same_thread=False)",
  "db.execute('create table users(id integer, name text, secret text)')",
  "db.executemany('insert into users values(?,?,?)', [(1,'alice','s1'),(2,'bob','s2')])",
  "class H(BaseHTTPRequestHandler):",
  "    def log_message(self, *a): pass",
  "    def do_GET(self):",
  "        u = urlparse(self.path)",
  "        i = (parse_qs(u.query).get('id') or ['1'])[0]",
  "        try:",
  "            if u.path == '/safe':",
  "                row = db.execute('select name from users where id=?', (int(i),)).fetchone()",
  "            else:",
  "                row = db.execute(f'select name from users where id={i}').fetchone()",
  "            body = f'USER:{row[0]}' if row else 'NOUSER'",
  "        except Exception as e:",
  "            body = f'SQLERR {e}'",
  "        b = body.encode()",
  "        self.send_response(200); self.send_header('Content-Type','text/plain'); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)",
  "srv = ThreadingHTTPServer(('127.0.0.1', 18088), H)",
  "print('READY', flush=True)",
  "srv.serve_forever()",
  "PY",
].join("\n");

test.describe("sqlmap_scan: стадии в факты", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Sqlmap: проверки"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("detect → dbs → tables → columns → dump на уязвимом SQLite; безопасный параметр честно «не найден»", async ({ page, request }) => {
    test.setTimeout(600_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    const last = async () => (await toolOutputs(request, chat.id)).at(-1)!;
    const U = "http://127.0.0.1:18088/user?id=1";

    await send(page, tt([sh(SRV)], [call("job_start", { name: "sqlisrv", command: "python3 /tmp/sqli-srv.py" })]));
    await waitIdle(page);
    const jobsList = (await (await request.get(`/api/tasks/${ids.task.id}/jobs`)).json()) as any[];
    const job = jobsList.find((j) => j.name === "sqlisrv");
    expect(job?.running).toBe(true);
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output`)).text(), { timeout: 20_000 }).toContain("READY");
    await send(page, tt([sh("curl -s 'http://127.0.0.1:18088/user?id=2'")]));
    await waitIdle(page);
    expect(await last()).toContain("USER:bob");

    // detect: СУБД и уязвимый параметр с техниками — фактами, не логом
    await send(page, tt([call("sqlmap_scan", { url: U })]));
    await waitIdle(page);
    expect(await last()).toContain("СУБД: SQLite");
    expect(await last()).toContain("уязвимые параметры:");
    expect(await last()).toContain("id (GET)");
    expect(await last()).toContain("UNION query");
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    expect(textOf(req.body.messages[0].content)).toContain("sqlmap_scan");

    // dbs на SQLite честно говорит, что перечисления нет
    await send(page, tt([call("sqlmap_scan", { url: U, stage: "dbs" })]));
    await waitIdle(page);
    expect(await last()).toContain("базы не перечисляются");

    // tables/columns/dump по сохранённой сессии
    await send(page, tt([call("sqlmap_scan", { url: U, stage: "tables" })]));
    await waitIdle(page);
    expect(await last()).toContain("users");

    await send(page, tt([call("sqlmap_scan", { url: U, stage: "columns", table: "users" })]));
    await waitIdle(page);
    expect(await last()).toContain("secret");

    await send(page, tt([call("sqlmap_scan", { url: U, stage: "dump", table: "users" })]));
    await waitIdle(page);
    expect(await last()).toContain("дамп users: строк 2");
    expect(await last()).toContain("alice");
    expect(await last()).toContain("CSV:");

    // валидация стадий и параметров
    await send(page, tt([call("sqlmap_scan", { url: "http://127.0.0.1:18088/user" })]));
    await waitIdle(page);
    expect(await last()).toContain("ошибка: нужен параметр");
    await send(page, tt([call("sqlmap_scan", { url: U, stage: "dump" })]));
    await waitIdle(page);
    expect(await last()).toContain("нужен table");

    // параметризованный запрос инъекцией не является — и формулировка это честно оговаривает
    await send(page, tt([call("sqlmap_scan", { url: "http://127.0.0.1:18088/safe?id=1", technique: "BEU", timeout_sec: 300 })]));
    await waitIdle(page);
    expect(await last()).toContain("инъекций не найдено");
    await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`);
  });
});
