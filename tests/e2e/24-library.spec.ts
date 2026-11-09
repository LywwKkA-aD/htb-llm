import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { APIRequestContext, Browser, Locator, Page } from "@playwright/test";
import { clearGlobalDocs, test, expect, createTask, mockReset, mockRequests, send, textOf, waitIdle, expectNoOverflowX, type Ids } from "./helpers";

// Библиотека (RAG): загрузка PDF/md/txt, индексация, цитаты [файл, с.N — заголовок], области видимости,
// удаление (в том числе посреди индексации), статусы в панели, перетаскивание файлов.
// Поиск проверяется тем, что реально уходит в модель: вывод инструмента search_docs (событие tool_end).

const DATA = process.env.E2E_DATA!; // playwright.config выставляет абсолютный путь каталога данных этого прогона
const UPLOADS = path.join(DATA, "uploads");
// суффикс имён в общей библиотеке: спецификацию можно повторять на тех же данных (--repeat-each), строки не задваиваются
const RUN = Date.now().toString(36).slice(-5);
const nm = (n: string) => n.replace(/(\.[^.]+)$/, ` ${RUN}$1`);
const uw = (s: string) => `${s}${RUN.toUpperCase()}`; // уникальное слово для поиска в общей библиотеке

type Doc = { id: number; task_id: string | null; name: string; kind: string; path: string; pages: number; chunks: number; status: string; error: string | null };
type UpFile = { name: string; body: string | Buffer; type?: string };

// ---------- API ----------
async function uploadApi(request: APIRequestContext, files: UpFile[], task?: string) {
  const fd = new FormData();
  for (const f of files) fd.append("files", new File([typeof f.body === "string" ? f.body : Uint8Array.from(f.body)], f.name, { type: f.type ?? "text/plain" }));
  if (task) fd.append("task", task);
  const r = await request.post("/api/docs", { multipart: fd });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()) as (Doc & { error?: string })[];
}
async function listDocs(request: APIRequestContext, task?: string) {
  return (await (await request.get(`/api/docs${task ? `?task=${task}` : ""}`)).json()) as Doc[];
}
async function waitDoc(request: APIRequestContext, id: number, task?: string, status = "ready", timeout = 30_000) {
  await expect.poll(async () => (await listDocs(request, task)).find((d) => d.id === id)?.status, { timeout, message: `документ ${id} → ${status}` }).toBe(status);
  return (await listDocs(request, task)).find((d) => d.id === id)!;
}
async function newChat(request: APIRequestContext, taskId: string) {
  return (await (await request.post(`/api/tasks/${taskId}/chats`)).json()) as { id: string };
}
// Ход агента через API: ответ — SSE, который закрывается на done/error.
async function ask(request: APIRequestContext, chatId: string, text: string) {
  const r = await request.post(`/api/chats/${chatId}/send`, { data: { text, effort: "off" }, timeout: 45_000 });
  expect(r.status(), await r.text()).toBe(200);
  const evs = (await r.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  expect(evs.at(-1)?.type, JSON.stringify(evs.at(-1))).toBe("done");
  return evs as any[];
}
// search_docs глазами модели: текст, который вернул инструмент
async function searchDocs(request: APIRequestContext, chatId: string, query: string, o: { scope?: string; k?: number } = {}) {
  const directive = o.scope || o.k ? `[[lib:docs:${o.scope ?? ""}:${o.k ?? ""}:${query}]]` : `[[tool:docs:${query}]]`;
  const evs = await ask(request, chatId, `${directive} [[nomem]]`);
  const end = evs.find((e) => e.type === "tool_end" && e.name === "search_docs");
  expect(end, "search_docs должен выполниться").toBeTruthy();
  return String(end.output);
}
const blocks = (out: string) => out.split("\n\n---\n\n");
const headers = (out: string) => blocks(out).map((b) => b.split("\n")[0]);
function blockWith(out: string, word: string) {
  const b = blocks(out).find((x) => x.includes(word));
  expect(b, `в выдаче search_docs нет фрагмента со словом ${word}:\n${out.slice(0, 1500)}`).toBeTruthy();
  return { header: b!.split("\n")[0], text: b! };
}

// ---------- база этого прогона (только чтение) — проверить, что после удаления не осталось хвостов ----------
function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(path.join(DATA, "whitehat.db"), { readonly: true, fileMustExist: true });
  try { sqliteVec.load(db); return fn(db); } finally { db.close(); }
}
const one = (db: Database.Database, sql: string, ...p: unknown[]) => Number(Object.values(db.prepare(sql).get(...p) as object)[0]);
// инварианты индекса: у каждого фрагмента есть вектор, нет векторов и фрагментов без документа
function indexInvariants() {
  return withDb((db) => ({
    vecMinusChunks: one(db, "select (select count(*) from chunks_vec) - (select count(*) from chunks)"),
    orphanChunks: one(db, "select count(*) from chunks where doc_id not in (select id from docs)"),
  }));
}
const ftsHits = (word: string) => withDb((db) => one(db, "select count(*) from chunks_fts where chunks_fts match ?", `"${word.toLowerCase()}"`));

// ---------- генераторы файлов ----------
async function makePdf(browser: Browser, pages: string[]) {
  const p = await browser.newPage();
  await p.setContent(`<html><body style="font: 15px sans-serif">${pages
    .map((t, i) => `<section style="${i < pages.length - 1 ? "break-after: page;" : ""}">${t}</section>`).join("")}</body></html>`);
  const buf = await p.pdf({ format: "A5" });
  await p.close();
  return buf;
}
// большой конспект: ~sections × 13 КБ, в конце уникальный факт
function bigMd(sections: number, tail: string) {
  const para = "Трафик между VLAN маршрутизируется через шлюз по умолчанию, коммутатор изучает MAC-адреса и строит таблицу коммутации. ";
  const out: string[] = ["# Коммутация и маршрутизация"];
  for (let s = 1; s <= sections; s++) {
    out.push(`## Раздел ${s}`);
    for (let p = 0; p < 20; p++) out.push(`${para.repeat(3)}Абзац ${s}.${p}.`, "");
  }
  out.push("## Итог стенда", tail);
  return out.join("\n");
}

// ---------- интерфейс ----------
const panelOf = (page: Page) => page.getByTestId("library-panel");
// строка документа по точному имени (имя лежит в title — кавычки и эмодзи не ломают селектор)
const docRow = (page: Page, name: string) => panelOf(page).getByTestId("doc-item").filter({ has: page.getByTitle(name, { exact: true }) });
const docsInUploads = () => (fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : []);
// openTask из helpers гоняется с самим приложением: на «/» без wh.task приложение после загрузки списка задач
// пишет в localStorage первую задачу и может перетереть только что выставленную (так загрузка ушла не в ту задачу).
// Здесь localStorage готовится на странице того же origin без приложения, и открытая задача проверяется по заголовку.
async function openAt(page: Page, ids: { task: { id: string; title: string }; chat?: { id: string } }, tab: "term" | "mem" | "lib" = "term") {
  await page.goto("/api/docs");
  await page.evaluate(([t, c, tb]) => {
    localStorage.clear();
    localStorage.setItem("wh.task", t);
    if (c) localStorage.setItem("wh.chat", c);
    localStorage.setItem("wh.tab", tb);
  }, [ids.task.id, ids.chat?.id ?? "", tab] as const);
  await page.goto("/");
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("chat-task-title")).toHaveText(ids.task.title);
  if (tab === "lib") await expect(panelOf(page)).toBeVisible();
}

test.describe("библиотека (RAG): форматы, цитаты, области видимости, удаление", () => {
  test.afterAll(async ({ request }) => { await clearGlobalDocs(request); }); // не оставлять общие документы следующим спекам
  let A: Ids; // основная задача
  let B: Ids; // соседняя задача — проверка изоляции вложений
  test.beforeAll(async ({ request }) => {
    A = await createTask(request, "Библиотека: основная");
    B = await createTask(request, "Библиотека: соседняя");
  });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("PDF из трёх страниц: «3 с.» в панели, search_docs и автоподклейка ссылаются на нужную страницу", async ({ page, request, browser }) => {
    const [ALFA, BRAVO, CHARLIE] = [uw("PDFALFA"), uw("PDFBRAVO"), uw("PDFCHARLIE")];
    const pdf = await makePdf(browser, [
      `<h1>Лекция 5</h1><p>Протокол ${ALFA} работает поверх UDP, порт 4401.</p>`,
      `<h2>Маршруты</h2><p>Команда ${BRAVO} показывает таблицу маршрутов ядра: ip route show.</p>`,
      `<h2>Сканирование</h2><p>Утилита ${CHARLIE} ищет открытые порты: nmap -sS 10.0.0.0/24.</p>`,
    ]);
    const NAME = nm("лекция 5 маршрутизация.pdf");
    await openAt(page, A, "lib");
    await panelOf(page).getByTestId("lib-input").setInputFiles({ name: NAME, mimeType: "application/pdf", buffer: pdf });
    const row = docRow(page, NAME);
    await expect(row).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
    await expect(row).toContainText(/3 с\. · \d+ фрагм\./);

    const chat = await newChat(request, A.task.id);
    const out2 = await searchDocs(request, chat.id, BRAVO);
    const p2 = blockWith(out2, BRAVO);
    expect(p2.header).toBe(`[${NAME}, с.2]`);
    expect(p2.text, "страницы не склеиваются в один фрагмент").not.toContain(ALFA);
    expect(p2.text).not.toContain(CHARLIE);
    expect(blockWith(await searchDocs(request, chat.id, CHARLIE), CHARLIE).header).toBe(`[${NAME}, с.3]`);
    expect(blockWith(await searchDocs(request, chat.id, ALFA), ALFA).header).toBe(`[${NAME}, с.1]`);

    // автоподклейка в обычном ходе: чип источника со страницей под ответом, фрагмент со ссылкой — в контексте хода
    await mockReset(request);
    const c2 = await newChat(request, A.task.id);
    await openAt(page, { task: A.task, chat: c2 });
    await send(page, `Чем показать таблицу маршрутов ${BRAVO}? [[short]] [[nomem]]`);
    await waitIdle(page);
    await expect(page.getByTestId("recall-sources")).toContainText(`${NAME} · с.2`);
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const user = textOf(req.body.messages.filter((m: any) => m.role === "user").at(-1).content);
    expect(user.slice(user.indexOf("<контекст_хода>"))).toContain(`[${NAME}, с.2]`);
  });

  test("ошибки индексации: битый PDF, PDF без текста и пустой txt — статус «ошибка» с причиной, опрос списка прекращается", async ({ page, request, browser }) => {
    const scan = await makePdf(browser, ['<div style="width:300px;height:200px;background:#4a7"></div>']); // «скан»: только картинка
    const files = [
      { name: nm("скан без текста.pdf"), mimeType: "application/pdf", buffer: scan },
      { name: nm("битый.pdf"), mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nэто не pdf, а мусор\n%%EOF\n") },
      { name: nm("пустой.txt"), mimeType: "text/plain", buffer: Buffer.alloc(0) },
    ];
    await openAt(page, A, "lib");
    await panelOf(page).getByTestId("lib-input").setInputFiles(files);
    await expect(page.getByTestId("toast").filter({ hasText: "загружено: 3" })).toBeVisible();
    for (const f of files) {
      const row = docRow(page, f.name);
      await expect(row, f.name).toHaveAttribute("data-status", "error", { timeout: 30_000 });
      await expect(row).toContainText("ошибка");
      await expect(row).not.toContainText("индексирую");
    }
    // причина — в подсказке у статуса (второй элемент с title; первый — имя файла)
    const reason = (name: string) => docRow(page, name).locator("span[title]").nth(1).getAttribute("title");
    expect(await reason(files[0].name)).toContain("не найден текст");
    expect(await reason(files[2].name)).toContain("не найден текст");
    expect((await reason(files[1].name))?.trim(), "у битого PDF должна быть причина ошибки").toBeTruthy();
    const api = await listDocs(request);
    for (const f of files) expect(api.find((d) => d.name === f.name)?.status).toBe("error");

    // всё в конечном статусе — панель больше не опрашивает сервер (окно наблюдения больше интервала опроса 1.2 с)
    let polls = 0;
    page.on("request", (r) => { if (r.method() === "GET" && new URL(r.url()).pathname === "/api/docs") polls++; });
    await page.waitForTimeout(3000);
    expect(polls, "опрос /api/docs после завершения индексации").toBe(0);
  });

  test("md: путь заголовков «H1 › H2 › H3» в цитате, стек сбрасывается на новом H1, текст до первого заголовка — без заголовка", async ({ request }) => {
    const NAME = "сети и linux.md";
    const md = [
      "Вступление без заголовка: термин HDPREAMBLEWORD.",
      "",
      "# Сети",
      "## ARP",
      "ARP сопоставляет IP и MAC, факт HDARPWORD.",
      "### Кэш",
      "Записи кэша стареют, факт HDCACHEWORD.",
      "## DHCP",
      "Схема DORA, факт HDDHCPWORD.",
      "# Linux",
      "### Права",
      "chmod 640 файл, факт HDCHMODWORD.",
    ].join("\n");
    const [d] = await uploadApi(request, [{ name: NAME, body: md, type: "text/markdown" }]);
    const ready = await waitDoc(request, d.id);
    expect(ready.kind).toBe("md");
    expect(ready.pages).toBe(0);
    expect(ready.chunks).toBe(5);

    const chat = await newChat(request, A.task.id);
    const out = await searchDocs(request, chat.id, "HDPREAMBLEWORD HDARPWORD HDCACHEWORD HDDHCPWORD HDCHMODWORD", { k: 10 });
    expect(blockWith(out, "HDPREAMBLEWORD").header).toBe(`[${NAME}]`);
    expect(blockWith(out, "HDARPWORD").header).toBe(`[${NAME} — Сети › ARP]`);
    expect(blockWith(out, "HDCACHEWORD").header).toBe(`[${NAME} — Сети › ARP › Кэш]`);
    expect(blockWith(out, "HDDHCPWORD").header, "H2 заменяет прошлый H2 и сбрасывает H3").toBe(`[${NAME} — Сети › DHCP]`);
    expect(blockWith(out, "HDCHMODWORD").header, "новый H1 сбрасывает весь стек").toBe(`[${NAME} — Linux › Права]`);
    // строки заголовков не дублируются в тексте фрагмента
    expect(blockWith(out, "HDARPWORD").text).not.toContain("## ARP");
  });

  test("md: комментарий «# …» внутри блока кода ``` не считается заголовком", async ({ request }) => {
    const NAME = "arp с кодом.md";
    const md = [
      "# Сети",
      "## ARP",
      "Посмотреть таблицу соседей:",
      "```bash",
      "# вывести таблицу соседей",
      "ip neigh show",
      "```",
      "После этого видно FENCEWORD у каждого соседа.",
    ].join("\n");
    const [d] = await uploadApi(request, [{ name: NAME, body: md, type: "text/markdown" }]);
    await waitDoc(request, d.id);
    const chat = await newChat(request, A.task.id);
    const hit = blockWith(await searchDocs(request, chat.id, "FENCEWORD"), "FENCEWORD");
    expect(hit.header, "заголовок раздела, а не строка-комментарий из bash").toBe(`[${NAME} — Сети › ARP]`);
    expect(hit.text, "комментарий из кода остаётся в тексте фрагмента").toContain("# вывести таблицу соседей");
  });

  test("md с переводами строк Windows (CRLF): заголовки распознаются и попадают в цитату", async ({ request }) => {
    const NAME = "конспект из windows.md";
    const md = ["# Сети", "## VLAN", "Тег 802.1Q занимает 4 байта, факт CRLFWORD.", "", "## STP", "Корневой мост выбирается по Bridge ID."].join("\r\n");
    const [d] = await uploadApi(request, [{ name: NAME, body: md, type: "text/markdown" }]);
    await waitDoc(request, d.id);
    const chat = await newChat(request, A.task.id);
    const hit = blockWith(await searchDocs(request, chat.id, "CRLFWORD"), "CRLFWORD");
    expect(hit.header).toBe(`[${NAME} — Сети › VLAN]`);
    expect(hit.text, "строка заголовка не должна оставаться в тексте").not.toContain("## VLAN");
    expect(hit.text, "соседний раздел — отдельный фрагмент").not.toContain("Корневой мост");
  });

  test.describe("области видимости: вложения задачи и общая библиотека", () => {
    const GLOBAL = nm("общий конспект.md"), TASKTXT = "вариант 7.txt", CONF = "dhcpd.conf";
    const GW = uw("SCOPEGLOBAL");
    test.beforeAll(async ({ request }) => {
      const g = await uploadApi(request, [{ name: GLOBAL, body: `# Общее\nОбщий факт ${GW} про маски подсетей.`, type: "text/markdown" }]);
      const t = await uploadApi(request, [
        { name: TASKTXT, body: "Вариант 7: сеть 10.7.0.0/22, шлюз 10.7.0.1, ключ SCOPETASKWORD." },
        { name: CONF, body: "subnet 10.7.0.0 netmask 255.255.252.0 {\n  range 10.7.0.10 10.7.0.200; # SCOPECONFWORD\n}\n" },
      ], A.task.id);
      for (const d of g) await waitDoc(request, d.id);
      for (const d of t) await waitDoc(request, d.id, A.task.id);
      expect(t.map((d) => [d.kind, d.task_id])).toEqual([["txt", A.task.id], ["txt", A.task.id]]);
    });

    test("search_docs: scope=task — только вложения задачи, scope=lib — только общая, без scope — всё; k ограничивает выдачу", async ({ request }) => {
      const chat = await newChat(request, A.task.id);
      const Q = `${GW} SCOPETASKWORD SCOPECONFWORD`;
      const isTask = (h: string) => h.startsWith(`[${TASKTXT}`) || h.startsWith(`[${CONF}`);

      const onlyTask = headers(await searchDocs(request, chat.id, Q, { scope: "task", k: 10 }));
      expect(onlyTask.length).toBeGreaterThan(0);
      expect(onlyTask.filter((h) => !isTask(h)), "scope=task вернул документы не из задачи").toEqual([]);

      const onlyLib = headers(await searchDocs(request, chat.id, Q, { scope: "lib", k: 10 }));
      expect(onlyLib.filter(isTask), "scope=lib вернул вложения задачи").toEqual([]);
      expect(onlyLib).toContain(`[${GLOBAL} — Общее]`);

      const all = await searchDocs(request, chat.id, Q, { k: 10 });
      expect(blockWith(all, "SCOPETASKWORD").header).toBe(`[${TASKTXT}]`);
      expect(blockWith(all, "SCOPECONFWORD").header, ".conf индексируется как текст").toBe(`[${CONF}]`);
      expect(blockWith(all, GW).header).toBe(`[${GLOBAL} — Общее]`);

      expect(blocks(await searchDocs(request, chat.id, Q, { k: 1 }))).toHaveLength(1);
    });

    test("соседняя задача не видит чужие вложения ни в панели, ни в поиске, ни в автоподклейке; общая библиотека видна", async ({ page, request }) => {
      // список: без задачи — только общая библиотека; в соседней задаче — общая, но не чужие вложения
      const libOnly = (await listDocs(request)).map((d) => d.name);
      expect(libOnly).toContain(GLOBAL);
      expect(libOnly).not.toContain(TASKTXT);
      const inB = (await listDocs(request, B.task.id)).map((d) => d.name);
      expect(inB).toContain(GLOBAL);
      expect(inB).not.toContain(TASKTXT);
      expect(inB).not.toContain(CONF);

      // поиск модели в соседней задаче
      const chatB = await newChat(request, B.task.id);
      const out = await searchDocs(request, chatB.id, `SCOPETASKWORD SCOPECONFWORD ${GW}`, { k: 10 });
      expect(headers(out).filter((h) => h.startsWith(`[${TASKTXT}`) || h.startsWith(`[${CONF}`))).toEqual([]);
      expect(out).not.toContain("SCOPETASKWORD");

      // панель соседней задачи
      await openAt(page, B, "lib");
      await expect(docRow(page, GLOBAL)).toBeVisible();
      await expect(docRow(page, TASKTXT)).toHaveCount(0);
      await expect(docRow(page, CONF)).toHaveCount(0);
      const bOwn = (await listDocs(request, B.task.id)).filter((d) => d.task_id === B.task.id);
      expect(bOwn.map((d) => d.name)).not.toContain(TASKTXT);
      await expect(page.getByTestId("lib-task-title")).toContainText(`вложения задачи · ${bOwn.length}`);

      // автоподклейка в соседней задаче: общий фрагмент есть, чужого вложения нет
      await mockReset(request);
      const c = await newChat(request, B.task.id);
      await openAt(page, { task: B.task, chat: c });
      await send(page, `Что такое SCOPETASKWORD и SCOPECONFWORD и ${GW}? [[short]] [[nomem]]`);
      await waitIdle(page);
      await expect(page.getByTestId("recall-sources")).toContainText(GLOBAL);
      await expect(page.getByTestId("recall-sources")).not.toContainText(TASKTXT);
      const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
      const user = textOf(req.body.messages.filter((m: any) => m.role === "user").at(-1).content);
      const ctx = user.slice(user.indexOf("<контекст_хода>"));
      expect(ctx).toContain(`[${GLOBAL}`);
      expect(ctx).not.toContain(`[${TASKTXT}`);
      expect(ctx).not.toContain("10.7.0.10");

      // а в своей задаче вложения видны в своём разделе
      await openAt(page, A, "lib");
      const aOwn = (await listDocs(request, A.task.id)).filter((d) => d.task_id === A.task.id);
      expect(aOwn.map((d) => d.name)).toEqual(expect.arrayContaining([TASKTXT, CONF]));
      await expect(page.getByTestId("lib-task-title")).toContainText(`вложения задачи · ${aOwn.length}`);
      await expect(docRow(page, TASKTXT)).toHaveAttribute("data-status", "ready");
    });
  });

  test("два документа с одинаковым именем: удаление одного через панель убирает его фрагменты и файл, второй остаётся в поиске", async ({ page, request }) => {
    const NAME = nm("дубль.md");
    const [ONE, TWO] = [uw("DUPONE"), uw("DUPTWO")];
    const [d1] = await uploadApi(request, [{ name: NAME, body: `# Копия\nПервая версия, слово ${ONE}.`, type: "text/markdown" }]);
    const [d2] = await uploadApi(request, [{ name: NAME, body: `# Копия\nВторая версия, слово ${TWO}.`, type: "text/markdown" }]);
    await waitDoc(request, d1.id);
    await waitDoc(request, d2.id);
    expect(d1.path).not.toBe(d2.path);
    expect(fs.existsSync(d1.path) && fs.existsSync(d2.path)).toBe(true);

    await openAt(page, A, "lib");
    const rows = docRow(page, NAME);
    await expect(rows).toHaveCount(2);
    // порядок строк в панели = порядок списка API
    const idx = (await listDocs(request, A.task.id)).filter((d) => d.name === NAME).findIndex((d) => d.id === d1.id);
    const row = rows.nth(idx);
    await row.hover();
    await row.getByTestId("doc-delete").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText(NAME);
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toast").filter({ hasText: "документ удалён" })).toBeVisible();
    await expect(rows).toHaveCount(1);

    const left = (await listDocs(request)).filter((d) => d.name === NAME);
    expect(left.map((d) => d.id)).toEqual([d2.id]);
    expect(fs.existsSync(d1.path), "файл удалённого документа стёрт из uploads").toBe(false);
    expect(fs.existsSync(d2.path), "файл второго документа на месте").toBe(true);

    const chat = await newChat(request, A.task.id);
    const out = await searchDocs(request, chat.id, `${ONE} ${TWO}`, { k: 10 });
    expect(out).not.toContain(ONE);
    expect(blockWith(out, TWO).header).toBe(`[${NAME} — Копия]`);
    expect(ftsHits(ONE), "полнотекстовый индекс очищен").toBe(0);
    expect(indexInvariants()).toEqual({ vecMinusChunks: 0, orphanChunks: 0 });
  });

  test("большой md (≈3 МБ) через панель: «индексирую» → готово, сотни фрагментов, факт из конца файла находится", async ({ page, request }) => {
    test.setTimeout(150_000);
    const NAME = nm("большой конспект.md");
    const body = bigMd(220, "Пароль стенда хранится в заметке BIGTAILWORD, никому не показывать.");
    expect(Buffer.byteLength(body)).toBeGreaterThan(2_500_000);
    await openAt(page, B, "lib");
    await page.getByTestId("lib-scope-task").click(); // во вложения соседней задачи — не засоряем общую библиотеку
    // журнал состояний строки документа: промежуточное «индексирую» может длиться доли секунды — фиксируем его наблюдателем
    await page.evaluate((name) => {
      const w = window as unknown as { __libSeen: string[] };
      w.__libSeen = [];
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[data-testid="doc-item"]'))
          if (el.getAttribute("data-name") === name) w.__libSeen.push(`${el.getAttribute("data-status")}|${(el.textContent ?? "").includes("индексирую")}`);
      }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    }, NAME);
    await panelOf(page).getByTestId("lib-input").setInputFiles({ name: NAME, mimeType: "text/markdown", buffer: Buffer.from(body) });
    await expect(page.getByTestId("toast").filter({ hasText: "загружено: 1 — индексирую" })).toBeVisible();
    const row = docRow(page, NAME);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveAttribute("data-status", "ready", { timeout: 120_000 });
    await expect(row).toContainText(/\d+ фрагм\./);
    const seen = await page.evaluate(() => (window as unknown as { __libSeen: string[] }).__libSeen);
    expect(seen, "панель показывала «индексирую», пока шла индексация").toContain("indexing|true");
    expect(seen.at(-1)).toBe("ready|false");
    const doc = (await listDocs(request, B.task.id)).find((d) => d.name === NAME)!;
    expect(doc.task_id).toBe(B.task.id);
    expect(doc.chunks, "3 МБ режутся на сотни фрагментов").toBeGreaterThan(500);
    expect(Number((await row.innerText()).match(/(\d+) фрагм\./)?.[1])).toBe(doc.chunks);

    const chat = await newChat(request, B.task.id);
    const hit = blockWith(await searchDocs(request, chat.id, "BIGTAILWORD", { scope: "task" }), "BIGTAILWORD");
    expect(hit.header).toBe(`[${NAME} — Коммутация и маршрутизация › Итог стенда]`);
    expect(indexInvariants()).toEqual({ vecMinusChunks: 0, orphanChunks: 0 });
  });

  test("удаление документа посреди индексации: документ пропадает, фрагменты не появляются, соседний индексируется, сервер жив", async ({ page, request }) => {
    test.setTimeout(150_000);
    const X = "удаляемый на лету.md", Y = "остаётся.md";
    const [dx, dy] = await uploadApi(request, [
      { name: X, body: bigMd(150, "Факт только в удаляемом: DELXONLYWORD."), type: "text/markdown" },
      { name: Y, body: bigMd(150, "Факт только в оставшемся: DELYONLYWORD."), type: "text/markdown" },
    ], B.task.id);
    expect([dx.status, dy.status]).toEqual(["indexing", "indexing"]);
    const del = await request.delete(`/api/docs/${dx.id}`);
    expect(del.ok(), await del.text()).toBeTruthy();
    expect((await listDocs(request, B.task.id)).some((d) => d.id === dx.id)).toBe(false);
    expect(fs.existsSync(dx.path), "файл удалённого документа стёрт").toBe(false);

    await waitDoc(request, dy.id, B.task.id, "ready", 120_000);
    // индексация X шла параллельно с Y; её запись в базу должна тихо не состояться — наблюдаем несколько секунд
    for (let i = 0; i < 6; i++) {
      expect(indexInvariants(), `инварианты индекса, замер ${i}`).toEqual({ vecMinusChunks: 0, orphanChunks: 0 });
      expect(ftsHits("DELXONLYWORD"), "фрагменты удалённого документа не попали в полнотекст").toBe(0);
      expect((await listDocs(request, B.task.id)).some((d) => d.id === dx.id), "удалённый документ не воскрес").toBe(false);
      await page.waitForTimeout(500);
    }
    const chat = await newChat(request, B.task.id);
    const out = await searchDocs(request, chat.id, "DELXONLYWORD DELYONLYWORD", { scope: "task", k: 10 });
    expect(out).not.toContain("DELXONLYWORD");
    expect(headers(out).filter((h) => !h.startsWith("[")), "битых заголовков нет").toEqual([]);
    expect(out).not.toContain("[undefined");
    expect(blockWith(out, "DELYONLYWORD").header).toBe(`[${Y} — Коммутация и маршрутизация › Итог стенда]`);
    expect((await request.get("/api/health")).ok()).toBe(true);

    await openAt(page, B, "lib");
    await expect(docRow(page, Y)).toHaveAttribute("data-status", "ready");
    await expect(docRow(page, X)).toHaveCount(0);
  });

  test("имена файлов: кириллица с пробелами и скобками, эмодзи, расширение в верхнем регистре, .log, «../» в имени; длинное имя обрезается", async ({ page, request }) => {
    const LONG = nm("Очень длинное название методички по маршрутизации и коммутации в корпоративных сетях, часть вторая (исправленная).md");
    const names = [nm("Лекция 3 — ARP и NDP (финал).md"), nm("ЗАМЕТКИ ПО VLAN.MD"), nm("шпаргалка 🚀 v2.markdown"), nm("журнал стенда.log"), LONG];
    await openAt(page, A, "lib");
    await panelOf(page).getByTestId("lib-input").setInputFiles(names.map((n, i) => ({ name: n, mimeType: "text/plain", buffer: Buffer.from(`# Раздел\nТекст номер ${i}, слово NAMEWORD${i}.`) })));
    for (const n of names) await expect(docRow(page, n), n).toHaveAttribute("data-status", "ready", { timeout: 30_000 });

    const api = await listDocs(request);
    const byName = (n: string) => api.find((d) => d.name === n)!;
    expect(names.map((n) => byName(n)?.kind)).toEqual(["md", "md", "md", "txt", "md"]);
    for (const n of names) {
      expect(path.dirname(byName(n).path), `${n}: файл лежит в uploads`).toBe(UPLOADS);
      expect(path.basename(byName(n).path), `${n}: имя на диске — безопасное, расширение в нижнем регистре`).toMatch(/^\d+-[\w-]{6}\.(md|markdown|log)$/);
    }
    // имя с «../» от клиента не выводит файл за пределы uploads
    const [esc] = await uploadApi(request, [{ name: "../../escape-NAMEWORD.md", body: "# Побег\nтекст", type: "text/markdown" }]);
    expect(path.dirname(esc.path)).toBe(UPLOADS);
    expect(esc.name).not.toContain("/");
    expect(fs.existsSync(path.join(DATA, "..", "escape-NAMEWORD.md"))).toBe(false);
    await waitDoc(request, esc.id);

    // длинное имя: обрезано многоточием, полное — в подсказке; статус не вытеснен; горизонтальной прокрутки нет
    const longRow = docRow(page, LONG);
    const nameEl = longRow.getByTitle(LONG, { exact: true });
    const r = await nameEl.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, to: getComputedStyle(el).textOverflow }));
    expect(r.sw, "длинное имя не помещается и обрезается").toBeGreaterThan(r.cw);
    expect(r.to).toBe("ellipsis");
    await expect(longRow.getByText(/фрагм\./)).toBeInViewport();
    await expectNoOverflowX(page.getByTestId("tabbody-lib"), "вкладка библиотеки");
  });

  test("перетаскивание в зону загрузки: подсветка, загрузка в задачу, неподдерживаемый файл отклонён и не остаётся на диске", async ({ page, request }) => {
    await openAt(page, A, "lib");
    await page.getByTestId("lib-scope-task").click();
    const before = (await listDocs(request, A.task.id)).filter((d) => d.task_id === A.task.id).length;
    const drop = page.getByTestId("lib-drop");
    const dt = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["# Лаба\nПеретащенный конспект, слово DROPMDWORD."], "лаба drop.md", { type: "text/markdown" }));
      dt.items.add(new File(["Условие: поднять VLAN 30, слово DROPTXTWORD."], "условие drop.txt", { type: "text/plain" }));
      dt.items.add(new File(["PK\u0003\u0004"], "схема сети.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
      return dt;
    });
    const lit = /(^|\s)border-accent(\s|$)/;
    await expect(drop).not.toHaveClass(lit);
    await drop.dispatchEvent("dragover", { dataTransfer: dt });
    await expect(drop, "зона подсвечивается при наведении файлов").toHaveClass(lit);
    await drop.dispatchEvent("dragleave", { dataTransfer: dt });
    await expect(drop).not.toHaveClass(lit);
    await drop.dispatchEvent("dragover", { dataTransfer: dt });
    await drop.dispatchEvent("drop", { dataTransfer: dt });
    await expect(drop).not.toHaveClass(lit);

    await expect(page.getByTestId("toast").filter({ hasText: "схема сети.docx: неподдерживаемый тип файла" })).toBeVisible();
    await expect(page.getByTestId("toast").filter({ hasText: "загружено: 2" })).toBeVisible();
    for (const n of ["лаба drop.md", "условие drop.txt"]) await expect(docRow(page, n)).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
    await expect(docRow(page, "схема сети.docx")).toHaveCount(0);
    await expect(page.getByTestId("lib-task-title")).toContainText(`вложения задачи · ${before + 2}`);
    const mine = (await listDocs(request, A.task.id)).filter((d) => d.name.includes(" drop."));
    expect(mine.map((d) => d.task_id)).toEqual([A.task.id, A.task.id]);
    expect(docsInUploads().filter((f) => f.endsWith(".docx")), "отклонённый файл удалён из uploads").toEqual([]);

    const chat = await newChat(request, A.task.id);
    expect(blockWith(await searchDocs(request, chat.id, "DROPMDWORD", { scope: "task" }), "DROPMDWORD").header).toBe("[лаба drop.md — Лаба]");
  });

  test("больше 50 файлов за раз: понятное сообщение о лимите, на диске ничего не остаётся", async ({ page, request }) => {
    const before = docsInUploads().length;
    const docsBefore = (await listDocs(request)).length;
    await openAt(page, A, "lib");
    const files = Array.from({ length: 51 }, (_, i) => ({ name: `пачка ${String(i + 1).padStart(2, "0")}.txt`, mimeType: "text/plain", buffer: Buffer.from(`заметка ${i}`) }));
    await panelOf(page).getByTestId("lib-input").setInputFiles(files);
    const err = page.getByTestId("toast").and(page.locator('[data-kind="error"]'));
    await expect(err).toBeVisible();
    const msg = await err.innerText();
    test.info().annotations.push({ type: "toast", description: msg });
    // на диске и в библиотеке — ничего от прерванной загрузки
    await expect.poll(() => docsInUploads().length).toBe(before);
    expect((await listDocs(request)).length).toBe(docsBefore);
    // сообщение должно объяснять причину (лимит 50 файлов), а не быть «500 Internal Server Error»
    expect(msg).not.toContain("Internal Server Error");
    expect(msg).toMatch(/\b50\b/);
  });

  test("много документов: список прокручивается, последний доступен и удаляется, по горизонтали ничего не вылезает", async ({ page, request }) => {
    const N = 30;
    const up = await uploadApi(request, Array.from({ length: N }, (_, i) => ({ name: `заметка ${RUN} ${String(i + 1).padStart(2, "0")}.txt`, body: `Заметка номер ${i + 1} про маршрутизацию, слово MANYWORD${i + 1}.` })));
    for (const d of up) await waitDoc(request, d.id);
    await openAt(page, A, "lib");
    const body = page.getByTestId("tabbody-lib");
    const rows = panelOf(page).getByTestId("doc-item");
    await expect(rows.filter({ hasText: `заметка ${RUN} ` })).toHaveCount(N);
    const total = await rows.count();
    const s = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(s.sh, "список длиннее панели — нужна прокрутка").toBeGreaterThan(s.ch);
    await expectNoOverflowX(body, "вкладка библиотеки");

    // самый нижний документ сначала за краем панели; прокрутка доводит до него, его можно удалить
    const last = rows.last();
    const lastName = (await last.getAttribute("data-name"))!;
    await expect(last).not.toBeInViewport();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect(await body.evaluate((el) => el.scrollTop), "прокручивается именно вкладка библиотеки").toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollTop), "страница целиком не прокручивается").toBe(0);
    await last.hover();
    await last.getByTestId("doc-delete").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText(lastName);
    await page.getByTestId("confirm-ok").click();
    await expect(rows).toHaveCount(total - 1);
    await expect(docRow(page, lastName)).toHaveCount(0);
    expect((await listDocs(request, A.task.id)).some((d) => d.name === lastName)).toBe(false);
  });

  test("удаление задачи стирает её вложения (файлы, фрагменты, индексы), общая библиотека не трогается", async ({ request }) => {
    test.setTimeout(90_000);
    const C = await createTask(request, "Библиотека: удаляемая");
    const globalBefore = (await listDocs(request)).map((d) => d.id).sort();
    const [d] = await uploadApi(request, [{ name: "схема удаляемой.md", body: "# Схема\nАдресация стенда, слово TASKDELWORD.", type: "text/markdown" }], C.task.id);
    await waitDoc(request, d.id, C.task.id);
    expect(fs.existsSync(d.path)).toBe(true);
    expect(ftsHits("TASKDELWORD")).toBe(1);

    const r = await request.delete(`/api/tasks/${C.task.id}`);
    expect(r.ok(), await r.text()).toBeTruthy();
    expect(fs.existsSync(d.path), "файл вложения удалён").toBe(false);
    expect(ftsHits("TASKDELWORD"), "полнотекстовый индекс вложения очищен").toBe(0);
    expect(withDb((db) => one(db, "select count(*) from chunks where scope=?", `task:${C.task.id}`))).toBe(0);
    expect(withDb((db) => one(db, "select count(*) from docs where task_id=?", C.task.id))).toBe(0);
    expect(indexInvariants()).toEqual({ vecMinusChunks: 0, orphanChunks: 0 });
    expect((await listDocs(request)).map((x) => x.id).sort()).toEqual(globalBefore);
  });
});
