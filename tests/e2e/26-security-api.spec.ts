import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  test, expect, createTask, openTask, send, waitIdle,
  mockReset, mockRequests, APP_PORT, PNG_1PX, type Ids,
} from "./helpers";

// Безопасность и устойчивость API: XSS в пользовательских данных рендерится как текст,
// валидация входа не роняет сервер (нет 500/краха), защита хоста, хардненинг контейнера.
// Баги реального приложения закреплены test.fail — спек зелёный и «мигнёт», когда их починят.

const DATA = path.resolve(process.env.E2E_DATA ?? "tests/.data");
const XSS = `<img src=x onerror=alert(1)><script>alert(2)</script>`;

// сырой HTTP-запрос с полным контролем заголовков и байтов пути (Host, %2F в id)
function raw(reqPath: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string; ct: string }>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: APP_PORT, path: reqPath, method: opts.method ?? "GET", headers: opts.headers ?? {} },
      (res) => {
        let b = ""; res.setEncoding("utf8");
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, ct: String(res.headers["content-type"] ?? "") }));
      },
    );
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// лёгкая задача без ожидания контейнера (UI-тестам контейнер не нужен)
async function makeTask(request: any, fields: { title: string; course?: string; brief?: string }) {
  const r = await request.post("/api/tasks", { data: { title: fields.title, course: fields.course ?? "", brief: fields.brief ?? "" } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()) as Ids;
}

test.describe("security-api", () => {
  let ids: Ids; // общая задача с поднятым контейнером (для хардненинга и симлинк-теста)
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "security-api base"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  // ---------- XSS: пользовательские поля рендерятся как текст ----------

  test("XSS в названии/курсе/условии задачи экранируется в сайдбаре, шапке и диалоге", async ({ page, request }) => {
    const t = await makeTask(request, { title: `${XSS} ARP`, course: XSS, brief: `бриф ${XSS}` });
    await openTask(page, t);
    // guard-фикстура уронит тест на любом alert; проверяем, что HTML попал как текст, а не как разметка
    await expect(page.getByTestId("chat-task-title")).toContainText("onerror=alert(1)");
    await expect(page.getByTestId("chat-header").locator("img")).toHaveCount(0);
    await expect(page.getByTestId("chat-header").locator("script")).toHaveCount(0);
    const item = page.locator(`[data-testid="task-item"][data-task-id="${t.task.id}"]`); // такие же названия создают и другие спеки
    await expect(item).toHaveCount(1);
    await expect(item.locator("img")).toHaveCount(0);
    // в диалоге правки значение приходит как строка в input (не как HTML)
    await page.getByTestId("edit-task").click();
    await expect(page.getByTestId("task-title")).toHaveValue(`${XSS} ARP`);
    await expect(page.getByTestId("task-brief")).toHaveValue(`бриф ${XSS}`);
    await expect(page.getByTestId("task-dialog").locator("img")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("XSS в карточке памяти (заголовок и текст) экранируется в панели памяти", async ({ page, request }) => {
    const t = await makeTask(request, { title: "память-xss" });
    await request.post(`/api/tasks/${t.task.id}/memories`, { data: { kind: "fact", title: `title ${XSS}`, content: `content ${XSS}` } });
    await openTask(page, t, { tab: "mem" });
    const card = page.getByTestId("memory-card").filter({ hasText: "onerror=alert(1)" });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("content <img");
    await expect(page.getByTestId("memory-panel").locator("img")).toHaveCount(0);
    await expect(page.getByTestId("memory-panel").locator("script")).toHaveCount(0);
  });

  test("XSS в имени документа экранируется в библиотеке", async ({ page, request }) => {
    const t = await makeTask(request, { title: "док-xss" });
    await openTask(page, t, { tab: "lib" });
    // имя файла с HTML-полезной нагрузкой, расширение .md — файл проиндексируется
    await page.getByTestId("lib-input").setInputFiles({
      name: `<img src=x onerror=alert(1)>.md`, mimeType: "text/markdown", buffer: Buffer.from("# заметка\nтело") });
    const doc = page.getByTestId("doc-item").filter({ hasText: "onerror=alert(1)" });
    await expect(doc).toHaveCount(1);
    await expect(page.getByTestId("library-panel").locator("img")).toHaveCount(0);
    await expect(page.getByTestId("library-panel").locator("script")).toHaveCount(0);
  });

  test("ответ модели: сырой HTML как текст, javascript:-ссылки обезврежены", async ({ page, request }) => {
    const t = await makeTask(request, { title: "ответ-xss" });
    const chat = await (await request.post(`/api/tasks/${t.task.id}/chats`)).json();
    await openTask(page, { task: t.task, chat });
    await send(page, "[[sec:xss]] [[nomem]]");
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai).toContainText("Обычный текст"); // рендер дошёл до конца
    // сырой <img>/<script> не стали элементами, markdown-картинка/ссылка с javascript: обезврежены
    await expect(ai.locator("img")).toHaveCount(0);
    await expect(ai.locator("script")).toHaveCount(0);
    await expect(ai.locator('a[href^="javascript:" i]')).toHaveCount(0);
    const link = ai.getByTestId("md-image-link");
    if (await link.count()) expect((await link.first().getAttribute("href")) ?? "").not.toMatch(/^javascript:/i);
  });

  // ---------- защита хоста (DNS-rebinding) ----------

  test("Host-заголовок: свои имена (в т.ч. регистр и [::1]) — ок, чужие и без порта — 403", async () => {
    const ok = [`localhost:${APP_PORT}`, `LOCALHOST:${APP_PORT}`, `127.0.0.1:${APP_PORT}`, `[::1]:${APP_PORT}`, "127.0.0.1:17332"]; // Docker может опубликовать внутренний 7331 на другом loopback-порту
    for (const h of ok) expect((await raw("/api/tasks", { headers: { Host: h } })).status, h).toBe(200);
    const bad = ["evil.example", "127.0.0.1", "localhost", "0.0.0.0:" + APP_PORT, `127.0.0.1:${APP_PORT}.`, `localhost.:${APP_PORT}`];
    for (const h of bad) expect((await raw("/api/tasks", { headers: { Host: h } })).status, h).toBe(403);
  });

  // ---------- валидация и устойчивость ----------

  test("/stream на простаивающем чате отдаёт 204", async ({ request }) => {
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    const r = await request.get(`/api/chats/${chat.id}/stream`);
    expect(r.status()).toBe(204);
  });

  test("второй send при занятом чате — 409, сервер остаётся жив", async ({ request }) => {
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    // первый (медленный) ход держит чат занятым; ответ не ждём
    const first = request.post(`/api/chats/${chat.id}/send`, { data: { text: "[[slow]] [[nomem]]" } }).catch(() => {});
    // ждём серверный флаг busy — надёжнее, чем смотреть на поток в UI
    await expect.poll(async () =>
      ((await (await request.get(`/api/tasks/${ids.task.id}/chats`)).json()) as any[]).find((c) => c.id === chat.id)?.busy,
      { timeout: 15_000 }).toBe(true);
    const r = await request.post(`/api/chats/${chat.id}/send`, { data: { text: "второй" } });
    expect(r.status()).toBe(409);
    expect((await r.json()).error).toBeTruthy();
    await request.post(`/api/chats/${chat.id}/stop`);
    await first;
    expect((await request.get("/api/health")).ok(), "сервер жив").toBe(true);
  });

  test("send: невалидный effort → xhigh, валидный medium проходит, не-data картинки отброшены", async ({ request }) => {
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    const png = `data:image/png;base64,${PNG_1PX.toString("base64")}`;
    await request.post(`/api/chats/${chat.id}/send`, { data: {
      text: "картинки [[short]] [[nomem]]", effort: "banana",
      images: [png, "http://evil.example/leak.png", "data:text/html,<script>alert(1)</script>", 42],
    } });
    const chat2 = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await request.post(`/api/chats/${chat2.id}/send`, { data: { text: "второй [[short]] [[nomem]]", effort: "medium" } });
    const agents = (await mockRequests(request)).filter((r) => r.kind === "agent");
    const effort = (b: any) => b.chat_template_kwargs?.reasoning_effort ?? (b.chat_template_kwargs?.enable_thinking === false ? "off" : undefined);
    expect(effort(agents[0].body), "мусорный effort → дефолт xhigh").toBe("xhigh");
    expect(effort(agents[1].body), "валидный effort medium проходит").toBe("medium");
    // в модель ушла только корректная data:image/-картинка
    const imgs = (agents[0].body.messages as any[])
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p) => p?.type === "image_url")
      .map((p) => p.image_url.url);
    expect(imgs).toEqual([png]);
  });

  test("слишком большое тело запроса — 413, не крах", async ({ request }) => {
    const body = JSON.stringify({ title: "x".repeat(45 * 1024 * 1024) });
    const r = await raw("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json", Host: `127.0.0.1:${APP_PORT}`, "Content-Length": String(Buffer.byteLength(body)) }, body });
    expect(r.status).toBe(413);
    expect((await request.get("/api/health")).ok(), "сервер жив").toBe(true);
  });

  test("имя загружаемого файла с ../ обезврежено: файл лежит только в uploads", async ({ request }) => {
    const before = fs.readdirSync(path.join(DATA, "uploads"));
    const r = await request.post("/api/docs", { multipart: {
      files: { name: "../../../../etc/escape.md", mimeType: "text/markdown", buffer: Buffer.from("# x") } } });
    expect(r.ok(), await r.text()).toBeTruthy();
    const after = fs.readdirSync(path.join(DATA, "uploads"));
    const added = after.filter((f) => !before.includes(f));
    expect(added.length, "ровно один новый файл в uploads").toBe(1);
    // сохранённое имя — генерированное (timestamp-nanoid.ext), без обхода каталога
    expect(added[0]).toMatch(/^\d+-[A-Za-z0-9_-]{6}\.md$/);
    expect(fs.existsSync(path.join(DATA, "escape.md")), "ничего не вылезло в корень данных").toBe(false);
  });

  test("хардненинг контейнера: NET_ADMIN/NET_RAW есть, SYS_ADMIN нет, лимит памяти, только /work, нет docker.sock", async () => {
    const name = `whitehat-${ids.task.id}`;
    const label = execFileSync("docker", ["inspect", name, "--format", `{{index .Config.Labels "whitehat.data"}}`]).toString().trim();
    expect(label, "трогаем только свой контейнер").toBe(DATA);
    const info = JSON.parse(execFileSync("docker", ["inspect", name]).toString())[0];
    const caps: string[] = info.HostConfig.CapAdd ?? [];
    expect(caps).toEqual(expect.arrayContaining(["NET_ADMIN", "NET_RAW"]));
    expect(caps.map((c) => c.toUpperCase())).not.toContain("SYS_ADMIN");
    expect(info.HostConfig.Memory, "лимит памяти выставлен").toBeGreaterThan(0);
    const mounts = (info.Mounts ?? []).map((m: any) => m.Destination);
    expect(mounts).toEqual(["/work"]);
    // внутри контейнера эффективные привилегии не содержат sys_admin и нет сокета docker
    const dec = execFileSync("docker", ["exec", name, "bash", "-lc",
      "capsh --decode=$(awk '/CapEff/{print $2}' /proc/1/status) 2>/dev/null; echo ---; test -S /var/run/docker.sock && echo SOCK || echo NOSOCK"]).toString();
    expect(dec).not.toMatch(/sys_admin/i);
    expect(dec).toMatch(/cap_net_admin/i);
    expect(dec).toContain("NOSOCK");
  });

  test("подмена /work/.whitehat симлинком наружу: сервер не пишет за пределы задачи", async ({ page, request }) => {
    const name = `whitehat-${ids.task.id}`;
    const target = path.join(DATA, `sec-symtarget-${Date.now()}`);
    fs.mkdirSync(target, { recursive: true });
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    try {
      // root контейнера заменяет .whitehat симлинком на хостовый путь вне папки задачи
      execFileSync("docker", ["exec", name, "bash", "-lc", `rm -rf /work/.whitehat && ln -s '${target}' /work/.whitehat`]);
      await openTask(page, { task: ids.task, chat });
      // большой вывод (>6000 симв) заставляет сервер сохранять out-файл — guard в sandbox не должен дать записать наружу
      await send(page, "[[tool:shell:for i in $(seq 1 500); do echo \"line $i padding padding padding padding\"; done]] [[nomem]]");
      await waitIdle(page);
      await expect(page.getByTestId("tool-block").first()).toHaveAttribute("data-status", "ok");
      const leaked = fs.readdirSync(target).filter((f) => /^out-/.test(f));
      expect(leaked, "сервер не записал out-файл за пределы задачи").toEqual([]);
      expect((await request.get("/api/health")).ok(), "сервер жив").toBe(true);
    } finally {
      try { execFileSync("docker", ["exec", name, "bash", "-lc", "rm -f /work/.whitehat && mkdir -p /work/.whitehat"]); } catch { /* ignore */ }
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  // ---------- найденные баги (test.fail: спек зелёный, мигнёт при починке) ----------

  test("BUG: загрузка с неожиданным полем multipart должна давать 4xx JSON, а не 500", async ({ request }) => {
    const r = await request.post("/api/docs", { multipart: {
      wrongfield: { name: "x.md", mimeType: "text/markdown", buffer: Buffer.from("# x") } } });
    expect((await request.get("/api/health")).ok(), "сервер жив").toBe(true); // не падает — это ок
    expect(r.status(), "ошибка валидации загрузки должна быть 4xx").toBeLessThan(500);
  });

  test("BUG: send с images:null не должен ронять обработчик в 500", async ({ request }) => {
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    const r = await raw(`/api/chats/${chat.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: `127.0.0.1:${APP_PORT}` },
      body: JSON.stringify({ text: "", images: null }),
    });
    expect((await request.get("/api/health")).ok(), "сервер жив").toBe(true);
    expect(r.status, "кривой images должен давать 400, а не 500").toBe(400);
  });

  test("BUG: id задачи с ../ в REST не валидируется и создаёт каталог вне tasks/", async ({ request }) => {
    const rnd = `sec-trav-${Date.now()}`;
    const outside = path.join(DATA, rnd);
    // %2F доходит до :id и декодируется в '../' — обход каталога на файловой системе хоста
    const r = await raw(`/api/tasks/..%2F${rnd}/container/start`, { method: "POST", headers: { Host: `127.0.0.1:${APP_PORT}` } });
    const created = fs.existsSync(outside);
    fs.rmSync(outside, { recursive: true, force: true }); // подчистить до assert (всегда)
    expect((await request.get("/api/health")).ok(), "сервер жив").toBe(true);
    expect(r.status, "кривой id — чистый 4xx").toBeLessThan(500);
    expect(created, "id с ../ не должен создавать каталог вне tasks/").toBe(false);
  });
});
