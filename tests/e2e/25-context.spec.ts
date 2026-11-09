import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import type { APIRequestContext, Page } from "@playwright/test";
import { clearGlobalDocs, test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle, APP_PORT, MOCK, PNG_1PX, type Ids } from "./helpers";

// Управление контекстом: сворачивание (несколько циклов, границы порога, сбои резюме, «стоп»), стабильность
// префикса промпта (инструменты, картинки, фрагменты лекций), защита 75% окна, уровни размышлений,
// чистка чекпоинтов и перезапуск сервера на тех же данных. Ходы в основном шлются через API (быстрее и точнее),
// интерфейс проверяется там, где важно, что видит пользователь.

const ROOT = path.resolve(import.meta.dirname, "../..");
const DATA = path.resolve(process.env.E2E_DATA ?? path.join(ROOT, "tests/.data"));
const PNG = `data:image/png;base64,${PNG_1PX.toString("base64")}`;
const WINDOW = 65536;

// материалы задачи: 2 раздела = 2 фрагмента, оба подклеиваются на первом ходе чата (WH_RECALL_MIN_SIM=0)
const DOC = `# Маршрутизация

Статический маршрут: ip route add 10.0.0.0/8 via 192.168.1.1. МАРКЕР-ФРАГМЕНТА-1

# NAT

Маскарадинг: iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE. МАРКЕР-ФРАГМЕНТА-2
`;

type Ev = Record<string, any>;
type Msg = { role: string; content: any; tool_calls?: any[]; tool_call_id?: string; reasoning_content?: string };

// ход через API: SSE-ответ закрывается на done/error — возвращаем события
async function turn(request: APIRequestContext, chatId: string, text: string, o: { images?: string[]; effort?: string; base?: string } = {}) {
  const data: Record<string, unknown> = { text, images: o.images ?? [] };
  if (o.effort !== undefined) data.effort = o.effort;
  const r = await request.post(`${o.base ?? ""}/api/chats/${chatId}/send`, { data, timeout: 90_000 });
  const body = await r.text();
  expect(r.status(), body).toBe(200);
  return body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))) as Ev[];
}
// ход с чтением событий по мере прихода — чтобы нажать «стоп» (или уронить сервер) в нужный момент
function startTurn(chatId: string, text: string, base = `http://127.0.0.1:${APP_PORT}`) {
  const events: Ev[] = [];
  const finished = (async () => {
    const r = await fetch(`${base}/api/chats/${chatId}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, images: [] }) });
    if (!r.ok || !r.body) throw new Error(`send ${r.status}: ${await r.text()}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        for (const line of buf.slice(0, i).split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        buf = buf.slice(i + 2);
      }
    }
    return events;
  })();
  const tokens = () => events.filter((e) => e.type === "token").map((e) => e.t).join("");
  return { events, finished, tokens };
}
const done = (evs: Ev[]) => {
  const d = evs.find((e) => e.type === "done");
  expect(d, `ход должен закончиться без ошибки: ${JSON.stringify(evs.filter((e) => e.type === "error"))}`).toBeTruthy();
  return d!;
};
const agentReqs = async (request: APIRequestContext) =>
  (await mockRequests(request)).filter((r) => r.kind === "agent").map((r) => r.body as { messages: Msg[]; tools?: any[]; chat_template_kwargs: any; max_tokens: number; temperature?: number });
const summaryReqs = async (request: APIRequestContext) => (await mockRequests(request)).filter((r) => r.kind === "summary").map((r) => r.body);
const usersOf = (msgs: Msg[]) => msgs.filter((m) => m.role === "user").map((m) => textOf(m.content));
const s = (x: unknown) => JSON.stringify(x);

async function newChat(request: APIRequestContext, taskId: string, base = "") {
  const r = await request.post(`${base}/api/tasks/${taskId}/chats`);
  expect(r.ok()).toBe(true);
  return (await r.json()) as { id: string };
}
async function chatRow(request: APIRequestContext, taskId: string, chatId: string, base = "") {
  const list = (await (await request.get(`${base}/api/tasks/${taskId}/chats`)).json()) as any[];
  return list.find((c) => c.id === chatId) as { summary: string; last_prompt_tokens: number; busy: boolean };
}
async function uploadDoc(request: APIRequestContext, taskId: string, base = "") {
  const r = await request.post(`${base}/api/docs`, { multipart: { task: taskId, files: { name: "лекция-контекст.md", mimeType: "text/markdown", buffer: Buffer.from(DOC) } } });
  expect(r.ok(), await r.text()).toBe(true);
  await expect.poll(async () => ((await (await request.get(`${base}/api/docs?task=${taskId}`)).json()) as any[])
    .find((d) => d.name === "лекция-контекст.md")?.status, { timeout: 20_000 }).toBe("ready");
}

// чекпоинты LangGraph — только чтение, база открыта сервером (WAL)
function cpRows(thread: string) {
  const db = new Database(path.join(DATA, "checkpoints.db"), { readonly: true, fileMustExist: true });
  try {
    const cps = (db.prepare("select checkpoint_id from checkpoints where thread_id=?").all(thread) as { checkpoint_id: string }[]).map((r) => r.checkpoint_id);
    const writes = (db.prepare("select checkpoint_id from writes where thread_id=?").all(thread) as { checkpoint_id: string }[]).map((r) => r.checkpoint_id);
    return { cps, writes };
  } finally { db.close(); }
}
async function expectOneCheckpoint(thread: string) {
  await expect.poll(() => cpRows(thread).cps.length, { message: "после хода в базе остаётся один чекпоинт чата" }).toBe(1);
  const r = cpRows(thread);
  expect(r.writes.filter((w) => w !== r.cps[0]), "записи (writes) старых чекпоинтов удалены").toEqual([]);
  return r.cps[0];
}

// ---------- свой экземпляр сервера (перезапуск) — на ТЕХ ЖЕ данных и с тем же моком ----------
type Srv = { child: ChildProcess; base: string; out: () => string };
async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const sv = net.createServer();
    sv.on("error", reject);
    sv.listen(0, "127.0.0.1", () => { const p = (sv.address() as net.AddressInfo).port; sv.close(() => resolve(p)); });
  });
}
async function startServer(port: number, extraEnv: Record<string, string | undefined> = {}): Promise<Srv> {
  const env: NodeJS.ProcessEnv = { ...process.env, WH_PORT: String(port), WH_DATA: DATA, WH_LLM_URL: `${MOCK}/v1`, WH_EMBED_URL: `${MOCK}/v1`, WH_RECALL_MIN_SIM: "0", WH_COMPACT_AT: "12000", WH_LLM_MODEL: "Qwen3.8-27B-Turbo" };
  for (const [k, v] of Object.entries(extraEnv)) { if (v === undefined) delete env[k]; else env[k] = v; }
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  await expect.poll(async () => {
    if (child.exitCode !== null) return `сервер завершился: ${out.slice(-800)}`;
    try { return (await fetch(`${base}/api/health`)).status; } catch { return 0; }
  }, { timeout: 40_000, message: "свой сервер поднялся" }).toBe(200);
  return { child, base, out: () => out };
}
async function killServer(srv: Srv | null) {
  if (!srv || srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  srv.child.kill("SIGKILL"); // как падение/перезагрузка: без корректного завершения
  await once(srv.child, "exit");
}
async function openOn(page: Page, base: string, taskId: string, chatId: string, title: string) {
  await expect(async () => {
    await page.goto(`${base}/`);
    await page.evaluate(([t, c]) => {
      localStorage.clear();
      localStorage.setItem("wh.task", t); localStorage.setItem("wh.chat", c); localStorage.setItem("wh.tab", "term");
    }, [taskId, chatId] as const);
    await page.reload();
    await expect(page.getByTestId("chat-title")).toContainText(title, { timeout: 5000 });
  }).toPass({ timeout: 60_000 });
}
// Соседние прогоны всё время создают и удаляют Kali-контейнеры (новые veth на хосте), а Chromium на смену сети
// обрывает текущие запросы (net::ERR_NETWORK_CHANGED). Если при открытии оборвалась загрузка списка чатов,
// интерфейс остаётся без чата — открываем ещё раз и проверяем, что открыт именно нужный чат.
async function openChat(page: Page, ids: { task: Ids["task"]; chat: { id: string } }, title: string) {
  await expect(async () => {
    await openTask(page, ids);
    await expect(page.getByTestId("chat-title")).toContainText(title, { timeout: 5000 });
  }).toPass({ timeout: 60_000 });
}
// ход, отправленный из интерфейса, закончился на сервере (поток в браузере мог оборваться сменой сети)
async function settled(request: APIRequestContext, taskId: string, chatId: string) {
  await expect.poll(async () => (await chatRow(request, taskId, chatId)).busy, { timeout: 45_000 }).toBe(false);
}

test.describe("управление контекстом", () => {
  let base: Ids; // задача без материалов (контейнер нужен для shell)
  let docs: Ids; // задача с материалами — фрагменты подклеиваются
  test.beforeAll(async ({ request }, info) => {
    info.setTimeout(120_000);
    await clearGlobalDocs(request); // фрагменты чужих спеков иначе попадают в промпты этих тестов
    [base, docs] = await Promise.all([
      createTask(request, "Контекст: сворачивание", { brief: "Разобраться с маршрутизацией." }),
      createTask(request, "Контекст: префикс", { brief: "Настроить NAT." }),
    ]);
    await uploadDoc(request, docs.task.id);
  });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("три сворачивания подряд: каждое резюме вбирает предыдущее, границы порога и «двух последних ходов», полная история в ленте", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await newChat(request, base.task.id);
    // [текст, сколько сообщений свернётся (null — сворачивания нет)]
    const plan: [string, number | null][] = [
      ["ХОД-1 [[ctx:tok:20000]]", null], // в состоянии 1 ход — сворачивать нечего, даже при 20K
      ["ХОД-2 [[ctx:tok:20000]]", null], // 2 хода = keepRecentTurns — тоже нечего
      ["ХОД-3 [[ctx:tok:11994]]", null], // 11994 + 5 = 11999 — ниже порога 12000
      ["ХОД-4 [[ctx:tok:11995]]", 4], //    ровно 12000 — сворачиваются ходы 1–2 (по 2 сообщения)
      ["ХОД-5 [[ctx:tok:15000]]", 2], //    ход 3
      ["ХОД-6 [[ctx:tok:15000]]", 2], //    ход 4
    ];
    const sums: any[] = [];
    const markers: Ev[] = [];
    for (const [text, removed] of plan) {
      await mockReset(request);
      const evs = await turn(request, chat.id, text);
      done(evs);
      const c = evs.find((e) => e.type === "compacted");
      if (removed === null) {
        expect(c, `${text}: сворачивания быть не должно`).toBeUndefined();
        expect(await summaryReqs(request)).toHaveLength(0);
      } else {
        expect(c?.removed, `${text}: свёрнуто сообщений`).toBe(removed);
        expect(c!.after, "оценка после сворачивания меньше, чем было").toBeLessThan(c!.before);
        markers.push(c!);
        const sr = await summaryReqs(request);
        expect(sr).toHaveLength(1);
        sums.push(sr[0]);
      }
    }
    expect(markers.map((m) => m.before)).toEqual([12000, 15005, 15005]);
    const parts = (b: any) => { const u = textOf(b.messages[1].content); const i = u.indexOf("Диалог для сжатия:"); return { head: u.slice(0, i), dialog: u.slice(i) }; };
    // 1-е резюме: предыдущего нет, в диалоге ходы 1–2
    expect(parts(sums[0]).head).not.toContain("Предыдущее резюме");
    expect(parts(sums[0]).dialog.match(/ХОД-\d/g)).toEqual(["ХОД-1", "ХОД-2"]);
    // 2-е: предыдущее резюме + только ход 3 (ходы 1–2 уже свёрнуты и второй раз не пересказываются)
    expect(parts(sums[1]).head).toContain("Предыдущее резюме:\n- ctx-резюме: ХОД-1, ХОД-2\n");
    expect(parts(sums[1]).dialog.match(/ХОД-\d/g)).toEqual(["ХОД-3"]);
    // 3-е: накопленное резюме + ход 4
    expect(parts(sums[2]).head).toContain("Предыдущее резюме:\n- ctx-резюме: ХОД-1, ХОД-2, ХОД-3\n");
    expect(parts(sums[2]).dialog.match(/ХОД-\d/g)).toEqual(["ХОД-4"]);
    const row = await chatRow(request, base.task.id, chat.id);
    expect(row.summary).toBe("- ctx-резюме: ХОД-1, ХОД-2, ХОД-3, ХОД-4");

    // следующий ход: в системном промпте одно (последнее) резюме, в истории — только 2 последних хода + новый
    await mockReset(request);
    done(await turn(request, chat.id, "ХОД-7 [[short]]"));
    const [r7] = await agentReqs(request);
    const sys = textOf(r7.messages[0].content);
    expect(sys).toContain("# РАНЕЕ В ЭТОМ ЧАТЕ (резюме свёрнутых ходов)\n- ctx-резюме: ХОД-1, ХОД-2, ХОД-3, ХОД-4\n");
    expect(sys.split("ctx-резюме").length - 1, "старые резюме не накапливаются в промпте").toBe(1);
    expect(usersOf(r7.messages)).toEqual(["ХОД-5 [[ctx:tok:15000]]", "ХОД-6 [[ctx:tok:15000]]", "ХОД-7 [[short]]"]);

    // соседний чат той же задачи: резюме чужого чата в него не попадает
    const other = await newChat(request, base.task.id);
    await mockReset(request);
    done(await turn(request, other.id, "[[short]] соседний чат"));
    expect(textOf((await agentReqs(request))[0].messages[0].content)).not.toContain("РАНЕЕ В ЭТОМ ЧАТЕ");

    // интерфейс: вся история, три маркера на своих местах, шкала = сохранённому значению
    await openChat(page, { task: base.task, chat }, "ХОД-1");
    await expect(page.getByTestId("msg-user")).toHaveCount(7);
    await expect(page.getByTestId("marker-compacted")).toHaveCount(3);
    const order = async () => (await page.locator('[data-testid="msg-user"], [data-testid="marker-compacted"]')
      .evaluateAll((els) => els.map((e) => (e.getAttribute("data-testid") === "msg-user" ? "U" : "M")))).join("");
    expect(await order()).toBe("UUUUMUMUMU");
    await expect(page.getByTestId("marker-compacted").first()).toContainText("контекст свёрнут: 4 сообщ. → резюме · 12.0K →");
    await expect(page.getByTestId("marker-compacted").nth(1)).toContainText("2 сообщ. → резюме · 15.0K →");
    await expect(page.getByTestId("msg-user").first()).toContainText("ХОД-1");
    const last = (await chatRow(request, base.task.id, chat.id)).last_prompt_tokens;
    await expect(page.getByTestId("ctx-meter")).toHaveAttribute("data-tokens", String(last));
  });

  test("порог сворачивания по умолчанию — 32K: 31999 ещё не сворачивается, ровно 32000 сворачивается", async ({ request }) => {
    test.setTimeout(120_000);
    const port = await freePort();
    const srv = await startServer(port, { WH_COMPACT_AT: undefined }); // именно продуктовый дефолт, без тестового 12K
    try {
      const B = srv.base;
      const created = await (await request.post(`${B}/api/tasks`, { data: { title: "Контекст: порог 32K", course: "Сети", brief: "Проверка порога." } })).json();
      const chatId = created.chat.id as string;
      for (const text of ["ХОД-1 [[ctx:tok:20000]]", "ХОД-2 [[ctx:tok:20000]]", "ХОД-3 [[ctx:tok:31994]]"]) {
        const evs = await turn(request, chatId, text, { base: B });
        done(evs);
        expect(evs.find((e) => e.type === "compacted"), `${text}: до 32K сворачивания нет`).toBeUndefined();
      }
      const evs = await turn(request, chatId, "ХОД-4 [[ctx:tok:31995]]", { base: B });
      done(evs);
      const c = evs.find((e) => e.type === "compacted");
      expect(c?.before).toBe(32000);
      expect(c?.removed).toBe(4);
    } finally {
      await killServer(srv);
    }
  });

  test("сворачивание режет по границе хода: цепочка инструментов уходит в резюме целиком, картинка — пометкой, а не base64", async ({ request }) => {
    test.setTimeout(120_000);
    const chat = await newChat(request, base.task.id);
    done(await turn(request, chat.id, "ХОД-1 что на схеме? [[tool:shell:echo CHAIN-$((6*7))]] [[ctx:sumok]]", { images: [PNG] }));
    // предложение памяти по ходу с картинкой: в служебный вызов идёт пометка, а не data-URL
    const prop = (await mockRequests(request)).find((r) => r.kind === "propose");
    expect(prop, "ход с инструментом — повод предложить карточки").toBeTruthy();
    expect(s(prop!.body)).toContain("[изображение]");
    expect(s(prop!.body)).not.toContain("data:image");

    done(await turn(request, chat.id, "ХОД-2 [[tool:shell:echo KEEP-$((5*5))]] [[nomem]]"));
    await mockReset(request);
    const evs = await turn(request, chat.id, "ХОД-3 [[ctx:tok:15000]]");
    expect(evs.find((e) => e.type === "compacted")?.removed, "ход 1 = вопрос, вызов, результат, ответ").toBe(4);
    const [sum] = await summaryReqs(request);
    expect(textOf(sum.messages[0].content)).toContain("пометки происхождения фактов");
    expect(textOf(sum.messages[0].content)).toContain("гипотезу или слова пользователя в подтверждённый факт");
    const src = textOf(sum.messages[1].content);
    expect(src).toContain("ПОЛЬЗОВАТЕЛЬ: ХОД-1 что на схеме?");
    expect(src).toContain("[изображение]");
    expect(src).toMatch(/→ shell\(\{"command":"echo CHAIN-\$\(\(6\*7\)\)"\}\)/);
    expect(src).toContain("CHAIN-42");
    expect(src, "картинка не уходит в резюме base64-строкой").not.toContain("data:image");
    expect(src, "ход 2 остаётся дословно и в резюме не попадает").not.toContain("KEEP-");

    await mockReset(request);
    done(await turn(request, chat.id, "ХОД-4 [[short]]"));
    const [r4] = await agentReqs(request);
    expect(r4.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user", "assistant", "user"]);
    const call = r4.messages[2], res = r4.messages[3];
    expect(call.tool_calls).toHaveLength(1);
    expect(res.tool_call_id, "у результата инструмента есть свой вызов").toBe(call.tool_calls![0].id);
    expect(textOf(res.content)).toContain("KEEP-25");
    expect(s(r4.messages), "из свёрнутого хода ничего не осталось").not.toContain("CHAIN-42");
    expect(s(r4.messages)).not.toContain("image_url");
    expect(textOf(r4.messages[0].content)).toContain("- ctx-резюме: ХОД-1");
  });

  test("резюме не получилось (ошибка модели или обрезано по длине): ничего не теряется, следующий ход пробует снова", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await newChat(request, base.task.id);
    done(await turn(request, chat.id, "ХОД-1 [[ctx:sumfail]] [[ctx:tok:20000]]"));
    done(await turn(request, chat.id, "ХОД-2 [[ctx:sumok]] [[ctx:tok:20000]]"));
    await mockReset(request);
    const evs = await turn(request, chat.id, "ХОД-3 [[ctx:sumfail]] [[ctx:tok:20000]]"); // метка понадобится в ходе 5
    expect(done(evs).promptTokens).toBe(20005);
    expect(evs.some((e) => e.type === "compacting"), "сворачивание пробовали").toBe(true);
    expect(evs.find((e) => e.type === "compacted")).toBeUndefined();
    expect(evs.find((e) => e.type === "error"), "сбой резюме не превращается в ошибку хода").toBeUndefined();
    expect(await summaryReqs(request)).toHaveLength(1);
    let row = await chatRow(request, base.task.id, chat.id);
    expect(row.summary).toBe("");
    expect(row.last_prompt_tokens).toBe(20005);

    // следующий ход: вся история на месте; сворачивание повторяется (ходы 1–2) и теперь удаётся
    await mockReset(request);
    const evs4 = await turn(request, chat.id, "ХОД-4 [[ctx:tok:20000]]");
    const [r4] = await agentReqs(request);
    expect(usersOf(r4.messages).map((u) => u.slice(0, 5))).toEqual(["ХОД-1", "ХОД-2", "ХОД-3", "ХОД-4"]);
    expect(evs4.find((e) => e.type === "compacted")?.removed).toBe(4);
    row = await chatRow(request, base.task.id, chat.id);
    expect(row.summary).toBe("- ctx-резюме: ХОД-1, ХОД-2");

    // уже есть резюме, а следующее сворачивание (ход 3) снова сорвалось: старое резюме и история не тронуты
    await mockReset(request);
    const evs5 = await turn(request, chat.id, "ХОД-5 [[ctx:tok:20000]]");
    expect(await summaryReqs(request)).toHaveLength(1);
    expect(evs5.find((e) => e.type === "compacted")).toBeUndefined();
    expect((await chatRow(request, base.task.id, chat.id)).summary).toBe("- ctx-резюме: ХОД-1, ХОД-2");
    await mockReset(request);
    done(await turn(request, chat.id, "ХОД-6 [[short]]"));
    const [r6] = await agentReqs(request);
    expect(textOf(r6.messages[0].content)).toContain("- ctx-резюме: ХОД-1, ХОД-2\n");
    expect(usersOf(r6.messages).map((u) => u.slice(0, 5))).toEqual(["ХОД-3", "ХОД-4", "ХОД-5", "ХОД-6"]);

    await openChat(page, { task: base.task, chat }, "ХОД-1");
    await expect(page.getByTestId("msg-user")).toHaveCount(6);
    await expect(page.getByTestId("marker-compacted")).toHaveCount(1);
    await expect(page.getByTestId("marker-error")).toHaveCount(0);

    // обрезанное по длине резюме не сохраняется: «обрезанное хуже, чем никакого»
    const c2 = await newChat(request, base.task.id);
    done(await turn(request, c2.id, "ХОД-1 [[ctx:sumlen]] [[ctx:tok:20000]]"));
    done(await turn(request, c2.id, "ХОД-2 [[ctx:tok:20000]]"));
    await mockReset(request);
    const e3 = await turn(request, c2.id, "ХОД-3 [[ctx:tok:20000]]");
    expect(await summaryReqs(request)).toHaveLength(1);
    expect(e3.find((e) => e.type === "compacted")).toBeUndefined();
    expect((await chatRow(request, base.task.id, c2.id)).summary).toBe("");
    await mockReset(request);
    done(await turn(request, c2.id, "ХОД-4 [[short]]"));
    const [q4] = await agentReqs(request);
    expect(textOf(q4.messages[0].content)).not.toContain("оборвано на полуслове");
    expect(usersOf(q4.messages)[0]).toContain("ХОД-1");
  });

  test("префикс промпта стабилен: ход с картинкой, инструментом и фрагментами лекций, затем обычные ходы", async ({ request }) => {
    test.setTimeout(120_000);
    const chat = await newChat(request, docs.task.id);
    done(await turn(request, chat.id, "ХОД-1 что на схеме? [[tool:shell:echo PREFIX-$((2+3))]] [[nomem]]", { images: [PNG] }));
    const [r1a, r1b] = await agentReqs(request);
    expect(r1b, "два раунда: вызов инструмента и ответ").toBeTruthy();
    const n = r1a.messages.length;
    // внутри хода: второй раунд продолжает первый побайтно (картинка текущего хода остаётся до конца цепочки)
    expect(r1b.messages.slice(0, n).map(s)).toEqual(r1a.messages.map(s));
    const u1 = r1a.messages[n - 1];
    expect(u1.content.some((p: any) => p.type === "image_url" && String(p.image_url.url).startsWith("data:image/png"))).toBe(true);
    expect(textOf(u1.content)).toContain("<контекст_хода>");
    expect(textOf(u1.content)).toContain("МАРКЕР-ФРАГМЕНТА-1");
    expect(textOf(u1.content)).toContain("МАРКЕР-ФРАГМЕНТА-2");
    expect(textOf(r1a.messages[0].content), "фрагменты — не в системном промпте").not.toContain("МАРКЕР-ФРАГМЕНТА");
    const call1 = r1b.messages[n];
    expect(call1.tool_calls).toHaveLength(1);
    expect(call1.reasoning_content, "размышления внутри текущей цепочки инструментов передаются").toBeTruthy();
    expect(textOf(r1b.messages[n + 1].content)).toContain("PREFIX-5");

    await mockReset(request);
    done(await turn(request, chat.id, "ХОД-2 [[short]]"));
    const [r2] = await agentReqs(request);
    expect(s(r2.messages[0]), "системный промпт тот же").toBe(s(r1a.messages[0]));
    expect(r2.messages.slice(1, n - 1).map(s)).toEqual(r1a.messages.slice(1, n - 1).map(s));
    // единственные осознанные изменения старого хода: картинка → пометка (экономия ~1000+ токенов на картинку)
    // и размышления закончившейся цепочки инструментов больше не передаются (как в шаблоне Qwen)
    const expectedU1 = { ...u1, content: u1.content.map((p: any) => (p.type === "image_url" ? { type: "text", text: "[изображение из прошлого хода]" } : p)) };
    expect(s(r2.messages[n - 1])).toBe(s(expectedU1));
    const { reasoning_content: _rc, ...callNoReasoning } = call1;
    expect(s(r2.messages[n])).toBe(s(callNoReasoning));
    expect(s(r2.messages[n + 1])).toBe(s(r1b.messages[n + 1]));
    // фрагменты уже есть в истории чата — новый ход уходит без <контекст_хода>
    expect(r2.messages.at(-1)!.content).toBe("ХОД-2 [[short]]");

    // дальше всё стабильно: старые сообщения побайтно те же
    await mockReset(request);
    done(await turn(request, chat.id, "ХОД-3 [[short]]"));
    const [r3] = await agentReqs(request);
    expect(r3.messages.slice(0, r2.messages.length).map(s)).toEqual(r2.messages.map(s));
    expect(r3.messages.length).toBe(r2.messages.length + 2);
    expect(s(r3.messages), "картинка ушла в модель только в своём ходе").not.toContain("image_url");
  });

  test("фрагмент лекции, свёрнутый вместе со старым ходом, подклеивается снова (модель его больше не видит)", async ({ request }) => {
    const chat = await newChat(request, docs.task.id);
    const evs1 = await turn(request, chat.id, "ХОД-1 [[ctx:tok:3000]]");
    expect(evs1.find((e) => e.type === "recall")?.sources.map((x: any) => x.doc)).toContain("лекция-контекст.md");
    expect(textOf((await agentReqs(request))[0].messages.at(-1)!.content)).toContain("МАРКЕР-ФРАГМЕНТА-1");
    await mockReset(request);
    const evs2 = await turn(request, chat.id, "ХОД-2 [[ctx:tok:3000]]");
    expect(evs2.find((e) => e.type === "recall"), "уже показанный фрагмент второй раз не подклеивается").toBeUndefined();
    expect((await agentReqs(request))[0].messages.at(-1)!.content).toBe("ХОД-2 [[ctx:tok:3000]]");
    await mockReset(request);
    const evs3 = await turn(request, chat.id, "ХОД-3 [[ctx:tok:15000]]");
    expect(evs3.find((e) => e.type === "compacted")?.removed).toBe(2);
    // в резюме уходит диалог, а не подклеенные фрагменты
    expect(textOf((await summaryReqs(request))[0].messages[1].content)).not.toContain("МАРКЕР-ФРАГМЕНТА");
    await mockReset(request);
    const evs4 = await turn(request, chat.id, "ХОД-4 [[ctx:tok:3000]]");
    expect(evs4.find((e) => e.type === "recall")?.sources.length).toBeGreaterThan(0);
    const [r4] = await agentReqs(request);
    const users = r4.messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
    expect(users.map((u) => u.slice(0, 5))).toEqual(["ХОД-2", "ХОД-3", "ХОД-4"]);
    expect(users[2]).toContain("<контекст_хода>");
    expect(users[2]).toContain("МАРКЕР-ФРАГМЕНТА-2");
  });

  test("75% окна внутри цепочки инструментов: на границе ещё можно, за ней инструменты сняты, подсказка не остаётся в истории", async ({ page, request }) => {
    const chat = await newChat(request, base.task.id);
    const evs = await turn(request, chat.id, "ХОД-1 [[ctx:edge]]");
    expect(done(evs).promptTokens).toBe(49420);
    const reqs = await agentReqs(request);
    expect(reqs, "раунд 1 → раунд 2 (49152 — ровно порог, ещё не больше) → итог без инструментов").toHaveLength(3);
    expect(reqs[0].tools?.length).toBe(20);
    expect(reqs[1].tools?.length, `49122 + 30 = ${0.75 * WINDOW} — инструменты ещё разрешены`).toBe(20);
    expect(reqs[2].tools, "49123 + 30 > 75% окна — инструменты сняты").toBeUndefined();
    const nudge = reqs[2].messages.at(-1)!;
    expect(nudge.role).toBe("user");
    expect(nudge.content).toMatch(/^\[whitehat\] Контекст почти заполнен\. Инструменты на этот ход отключены/);
    expect(s(reqs[1].messages)).not.toContain("[whitehat]");
    expect(evs.filter((e) => e.type === "tool_end").map((e) => e.output.split("\n")[1])).toEqual(["CTX-EDGE-1", "CTX-EDGE-2"]);

    await openChat(page, { task: base.task, chat }, "ХОД-1");
    await expect(page.getByTestId("tool-block")).toHaveCount(2);
    await expect(page.getByTestId("tool-block").nth(1)).toHaveAttribute("data-status", "ok");
    await expect(page.getByTestId("msg-ai").last()).toContainText("отвечаю по уже полученным результатам");
    await expect(page.getByTestId("ctx-meter")).toHaveAttribute("data-tokens", "49420");
    await expect(page.getByTestId("ctx-label")).toHaveText("ctx 49.4K / 64K");

    // следующий ход: служебная подсказка не сохранилась, инструменты снова доступны
    await mockReset(request);
    done(await turn(request, chat.id, "ХОД-2 [[short]]"));
    const [r2] = await agentReqs(request);
    expect(r2.tools?.length).toBe(20);
    expect(s(r2.messages)).not.toContain("[whitehat]");
    expect(r2.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "tool", "assistant", "user"]);
  });

  test("уровень размышлений: medium/xhigh/неизвестный/по умолчанию, один на все раунды хода; служебные вызовы — без размышлений", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await newChat(request, base.task.id);
    done(await turn(request, chat.id, "ХОД-1 [[tool:shell:echo EFFORT]]", { effort: "medium" }));
    let reqs = await agentReqs(request);
    expect(reqs).toHaveLength(2);
    expect(reqs.map((r) => r.chat_template_kwargs)).toEqual([{ reasoning_effort: "medium" }, { reasoning_effort: "medium" }]);
    const prop = (await mockRequests(request)).find((r) => r.kind === "propose")!.body;
    expect(prop.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(prop.tools).toBeUndefined();
    expect([prop.max_tokens, prop.temperature]).toEqual([900, 0.3]);

    for (const [effort, want] of [["bogus", { reasoning_effort: "xhigh" }], [undefined, { reasoning_effort: "xhigh" }]] as const) {
      await mockReset(request);
      done(await turn(request, chat.id, `ХОД-${effort ?? "без"} [[ctx:tok:20000]]`, { effort }));
      expect((await agentReqs(request))[0].chat_template_kwargs, `effort=${effort}`).toEqual(want);
    }
    await mockReset(request);
    const evs = await turn(request, chat.id, "ХОД-4 [[ctx:tok:20000]]", { effort: "off" });
    expect((await agentReqs(request))[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(evs.find((e) => e.type === "compacted"), "4-й ход с большим контекстом сворачивает старое").toBeTruthy();
    const [sum] = await summaryReqs(request);
    expect(sum.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sum.tools).toBeUndefined();
    expect([sum.max_tokens, sum.temperature]).toEqual([1400, 0.3]);

    // из интерфейса: medium и xhigh (low/off проверяет 03-chat)
    await openChat(page, { task: base.task, chat }, "ХОД-1");
    await expect(page.getByTestId("effort-xhigh")).toHaveAttribute("aria-pressed", "true"); // по умолчанию
    for (const e of ["medium", "xhigh"]) {
      await mockReset(request);
      await page.getByTestId(`effort-${e}`).click();
      await send(page, `[[short]] ${e}`);
      await waitIdle(page);
      await settled(request, base.task.id, chat.id);
      expect((await agentReqs(request))[0].chat_template_kwargs).toEqual({ reasoning_effort: e });
    }
  });

  test("«стоп» при большом контексте: сворачивание откладывается, остановленная цепочка целиком уходит в следующий ход", async ({ request }) => {
    test.setTimeout(120_000);
    const chat = await newChat(request, base.task.id);
    done(await turn(request, chat.id, "ХОД-1 [[ctx:tok:3000]]"));
    done(await turn(request, chat.id, "ХОД-2 [[ctx:tok:3000]]"));
    await mockReset(request);
    const live = startTurn(chat.id, "ХОД-3 [[ctx:bigslow]]");
    // второй раунд (после инструмента) пошёл медленным потоком — жмём «стоп»
    await expect.poll(live.tokens, { timeout: 30_000 }).toContain("часть3");
    expect((await request.post(`/api/chats/${chat.id}/stop`)).ok()).toBe(true);
    const evs = await live.finished;
    const d = done(evs);
    expect(d.stopped).toBe(true);
    expect(d.promptTokens, "контекст выше порога — без «стоп» он бы свернулся").toBe(15030);
    expect(evs.some((e) => e.type === "compacting" || e.type === "compacted"), "после «стоп» не сворачиваем").toBe(false);
    expect(await summaryReqs(request)).toHaveLength(0);
    expect((await chatRow(request, base.task.id, chat.id)).summary).toBe("");

    await mockReset(request);
    const evs4 = await turn(request, chat.id, "ХОД-4 [[ctx:tok:15000]]");
    const [r4] = await agentReqs(request);
    const m = r4.messages;
    const i3 = m.findIndex((x) => x.role === "user" && textOf(x.content).startsWith("ХОД-3"));
    expect(m.slice(i3).map((x) => x.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(m[i3 + 2].tool_call_id).toBe(m[i3 + 1].tool_calls![0].id);
    expect(textOf(m[i3 + 2].content)).toContain("CTX-BIGSLOW");
    expect(textOf(m[i3 + 3].content)).toMatch(/часть0[\s\S]*_\(остановлено\)_$/);
    // отложенное сворачивание случилось на следующем ходе
    expect(evs4.find((e) => e.type === "compacted")?.removed).toBe(4);
    expect((await chatRow(request, base.task.id, chat.id)).summary).toBe("- ctx-резюме: ХОД-1, ХОД-2");
  });

  test("«стоп» во время сворачивания (резюме пишется долго): управление сразу возвращается, сворачивание повторяется на следующем ходе", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await newChat(request, base.task.id);
    done(await turn(request, chat.id, "ХОД-1 [[ctx:sumslow]] [[ctx:tok:20000]]"));
    done(await turn(request, chat.id, "ХОД-2 [[ctx:sumok]] [[ctx:tok:20000]]"));
    await openChat(page, { task: base.task, chat }, "ХОД-1");
    await mockReset(request);
    await send(page, "ХОД-3 [[ctx:tok:20000]]");
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: принято.");
    // ответ уже показан, а ход ещё идёт: модель пишет резюме — кнопка «стоп» всё ещё доступна
    await expect.poll(async () => (await summaryReqs(request)).length, { timeout: 20_000 }).toBe(1);
    await expect(page.getByTestId("stop")).toBeVisible();
    const t0 = Date.now();
    await page.getByTestId("stop").click();
    await waitIdle(page, 10_000);
    await settled(request, base.task.id, chat.id);
    expect(Date.now() - t0, "«стоп» прерывает служебный вызов резюме сразу").toBeLessThan(5000);
    await expect(page.getByTestId("marker-compacted")).toHaveCount(0);
    await expect(page.getByTestId("marker-error")).toHaveCount(0);
    const row = await chatRow(request, base.task.id, chat.id);
    expect(row.summary, "недописанное резюме не сохраняется").toBe("");
    expect(row.busy).toBe(false);

    // следующий ход: ничего не потеряно, сворачивание (ходы 1–2) проходит
    await mockReset(request);
    await send(page, "ХОД-4 [[ctx:tok:20000]]");
    await waitIdle(page);
    await settled(request, base.task.id, chat.id);
    const [r4] = await agentReqs(request);
    expect(usersOf(r4.messages).map((u) => u.slice(0, 5))).toEqual(["ХОД-1", "ХОД-2", "ХОД-3", "ХОД-4"]);
    await expect(page.getByTestId("marker-compacted")).toContainText("контекст свёрнут: 4 сообщ.");
    expect((await chatRow(request, base.task.id, chat.id)).summary).toBe("- ctx-резюме: ХОД-1, ХОД-2");
  });

  test("карточка памяти, подтверждённая посреди чата, не переписывает системный промпт этого чата (кэш промпта)", async ({ request }) => {
    // отдельная задача: подтверждённая память попала бы в системный промпт остальных тестов
    const t = await createTask(request, "Контекст: память и кэш");
    done(await turn(request, t.chat.id, "ХОД-1 Что такое ARP?")); // длинный ответ — агент предлагает карточки
    const [r1] = await agentReqs(request);
    const pending = ((await (await request.get(`/api/tasks/${t.task.id}/memories`)).json()) as any[]).filter((m) => m.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    expect((await request.post(`/api/memories/${pending[0].id}/confirm`, { data: {} })).ok()).toBe(true);
    await mockReset(request);
    done(await turn(request, t.chat.id, "ХОД-2 [[short]]"));
    const [r2] = await agentReqs(request);
    // README: «системный промпт тоже стабилен» — иначе каждый ход после подтверждения карточки пересчитывает весь чат.
    // Модель и так видела этот факт в текущем чате (карточка предложена по нему); память нужна НОВЫМ чатам.
    expect(textOf(r2.messages[0].content), "системный промпт второго хода совпадает с первым").toBe(textOf(r1.messages[0].content));
  });

  test("чекпоинты: после хода с инструментами, ошибки и «стоп» — один на чат; удаление чата и задачи убирает всё; параллельные чаты не смешиваются", async ({ request }) => {
    test.setTimeout(150_000);
    const chat = await newChat(request, base.task.id);
    done(await turn(request, chat.id, "ХОД-1 [[tool:shell:echo CP-1]] [[nomem]]"));
    const id1 = await expectOneCheckpoint(chat.id);
    done(await turn(request, chat.id, "ХОД-2 [[short]]"));
    const id2 = await expectOneCheckpoint(chat.id);
    expect(id2 > id1, "остался самый новый чекпоинт").toBe(true);
    const err = await turn(request, chat.id, "ХОД-3 [[error]]");
    expect(err.find((e) => e.type === "error")?.message).toContain("модель недоступна");
    await expectOneCheckpoint(chat.id);
    await mockReset(request);
    const slow = startTurn(chat.id, "ХОД-4 [[slow]] [[nomem]]");
    await expect.poll(slow.tokens).toContain("слово2");
    await request.post(`/api/chats/${chat.id}/stop`);
    expect(done(await slow.finished).stopped).toBe(true);
    await expectOneCheckpoint(chat.id);
    // оставленный чекпоинт — правильный: следующий ход видит всю историю
    await mockReset(request);
    done(await turn(request, chat.id, "ХОД-5 [[short]]"));
    expect(usersOf((await agentReqs(request))[0].messages).map((u) => u.slice(0, 5))).toEqual(["ХОД-1", "ХОД-2", "ХОД-3", "ХОД-4", "ХОД-5"]);
    expect((await request.delete(`/api/chats/${chat.id}`)).ok()).toBe(true);
    await expect.poll(() => cpRows(chat.id)).toEqual({ cps: [], writes: [] });

    // отдельная задача с двумя чатами, ходы идут одновременно
    const t = await createTask(request, "Контекст: удаление");
    const b = await newChat(request, t.task.id);
    await mockReset(request);
    const slowA = startTurn(t.chat.id, "ЧАТ-А [[slow]] [[nomem]]");
    await expect.poll(slowA.tokens).toContain("слово2");
    done(await turn(request, b.id, "ЧАТ-Б [[short]]"));
    const rb = (await agentReqs(request)).find((r) => textOf(r.messages.at(-1)!.content).startsWith("ЧАТ-Б"))!;
    expect(usersOf(rb.messages), "в соседний чат не попадает идущий параллельно ход").toEqual(["ЧАТ-Б [[short]]"]);
    expect(slowA.tokens(), "медленный ход всё ещё идёт").not.toContain("слово399");
    await request.post(`/api/chats/${t.chat.id}/stop`);
    expect(done(await slowA.finished).stopped).toBe(true);
    await mockReset(request);
    done(await turn(request, t.chat.id, "ЧАТ-А ещё [[short]]"));
    const [ra] = await agentReqs(request);
    expect(usersOf(ra.messages).map((u) => u.slice(0, 5))).toEqual(["ЧАТ-А", "ЧАТ-А"]);
    expect(s(ra.messages)).not.toContain("ЧАТ-Б");
    await expectOneCheckpoint(t.chat.id);
    await expectOneCheckpoint(b.id);
    expect((await request.delete(`/api/tasks/${t.task.id}`, { timeout: 60_000 })).ok()).toBe(true);
    await expect.poll(() => [cpRows(t.chat.id), cpRows(b.id)]).toEqual([{ cps: [], writes: [] }, { cps: [], writes: [] }]);
  });
});

// Свой экземпляр сервера на тех же данных: «выключили и включили» (SIGKILL — как падение или перезагрузка ПК).
test.describe.serial("управление контекстом: перезапуск сервера", () => {
  let srv: Srv | null = null;
  let port = 0;
  test.afterAll(async () => { await killServer(srv); });
  test.beforeAll(async ({ request }) => { await clearGlobalDocs(request); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("после перезапуска чат продолжается: история побайтно та же, резюме и уже показанные фрагменты на месте", async ({ page, request }) => {
    test.setTimeout(180_000);
    port = await freePort();
    srv = await startServer(port);
    const B = srv.base;
    const created = await (await request.post(`${B}/api/tasks`, { data: { title: "Контекст: перезапуск", course: "Сети", brief: "Проверка перезапуска." } })).json();
    const taskId = created.task.id as string, chatId = created.chat.id as string;
    await expect.poll(async () => (await (await request.get(`${B}/api/tasks/${taskId}/container`)).json()).status, { timeout: 40_000 }).toBe("running");
    done(await turn(request, chatId, "ХОД-1 [[ctx:tok:3000]]", { base: B }));
    done(await turn(request, chatId, "ХОД-2 [[ctx:tok:3000]]", { base: B }));
    expect((await turn(request, chatId, "ХОД-3 [[ctx:tok:15000]]", { base: B })).find((e) => e.type === "compacted")?.removed).toBe(2);
    await uploadDoc(request, taskId, B);
    await mockReset(request);
    done(await turn(request, chatId, "ХОД-4 [[ctx:tok:3000]]", { base: B }));
    const [r4] = await agentReqs(request);
    expect(textOf(r4.messages.at(-1)!.content)).toContain("МАРКЕР-ФРАГМЕНТА-1");

    await killServer(srv);
    srv = await startServer(port);
    expect((await request.get(`${B}/api/chats/${chatId}/stream`)).status(), "после перезапуска чат не «занят»").toBe(204);
    await mockReset(request);
    done(await turn(request, chatId, "ХОД-5 [[ctx:tok:3000]]", { base: B }));
    const [r5] = await agentReqs(request);
    // всё, что модель видела до перезапуска, уходит побайтно тем же (резюме в системном промпте, фрагменты в ходе 4)
    expect(r5.messages.slice(0, r4.messages.length).map(s)).toEqual(r4.messages.map(s));
    expect(textOf(r5.messages[0].content)).toContain("- ctx-резюме: ХОД-1");
    expect(usersOf(r5.messages).map((u) => u.slice(0, 5))).toEqual(["ХОД-2", "ХОД-3", "ХОД-4", "ХОД-5"]);
    expect(r5.messages.at(-1)!.content, "показанные до перезапуска фрагменты не подклеиваются снова").toBe("ХОД-5 [[ctx:tok:3000]]");
    await expectOneCheckpoint(chatId);

    // интерфейс нового процесса: полная история, маркер, шкала
    await openOn(page, B, taskId, chatId, "ХОД-1");
    await expect(page.getByTestId("msg-user")).toHaveCount(5);
    await expect(page.getByTestId("marker-compacted")).toHaveCount(1);
    await expect(page.getByTestId("ctx-meter")).toHaveAttribute("data-tokens", "3005");
    await page.goto("about:blank"); // страница не должна держать соединения со своим сервером, который дальше убивается
  });

  let crash: { taskId: string; chatId: string; req?: { messages: Msg[] } } | null = null;

  test("сервер упал посреди команды агента: после перезапуска чат свободен, журнал на месте, разговор продолжается", async ({ request }) => {
    test.setTimeout(180_000);
    if (!srv || srv.child.exitCode !== null) srv = await startServer(port || (port = await freePort()));
    const B = srv.base;
    const created = await (await request.post(`${B}/api/tasks`, { data: { title: "Контекст: падение", course: "Сети", brief: "Проверка падения." } })).json();
    const taskId = created.task.id as string, chatId = created.chat.id as string;
    await expect.poll(async () => (await (await request.get(`${B}/api/tasks/${taskId}/container`)).json()).status, { timeout: 40_000 }).toBe("running");
    const pending = startTurn(chatId, "ХОД-1 [[tool:shell:sleep 20; echo LATE]] [[nomem]]", B).finished.catch((e) => e);
    // команда уже запущена: она печатается в журнал терминала агента
    const agentLog = path.join(DATA, "tasks", taskId, "agent-terminal.log");
    await expect.poll(() => (fs.existsSync(agentLog) ? fs.readFileSync(agentLog, "utf8") : "").includes("sleep 20"), { timeout: 30_000 }).toBe(true);
    await killServer(srv);
    await pending;
    srv = await startServer(port);

    const log = (await (await request.get(`${B}/api/chats/${chatId}/log`)).json()) as { chat: { busy: boolean }; log: { kind: string; data: any }[] };
    expect(log.chat.busy).toBe(false);
    expect(log.log.map((x) => x.kind)).toEqual(["user", "assistant"]);
    expect(log.log[1].data.tool_calls[0].args.command).toBe("sleep 20; echo LATE");
    expect((await request.get(`${B}/api/chats/${chatId}/stream`)).status()).toBe(204);

    await mockReset(request);
    const evs = await turn(request, chatId, "ХОД-2 [[short]]", { base: B });
    done(evs);
    expect(evs.find((e) => e.type === "assistant_end")?.content).toBe("Коротко: да.");
    const [r2] = await agentReqs(request);
    expect(usersOf(r2.messages).map((u) => u.slice(0, 5))).toEqual(["ХОД-1", "ХОД-2"]);
    await expectOneCheckpoint(chatId);
    crash = { taskId, chatId, req: r2 };
  });

  test("после падения посреди команды блок инструмента не крутится вечно", async ({ page }) => {
    expect(crash, "нужен сценарий падения из предыдущего теста").toBeTruthy();
    await openOn(page, srv!.base, crash!.taskId, crash!.chatId, "ХОД-1");
    const block = page.getByTestId("tool-block").first();
    await expect(block).toContainText("$ sleep 20; echo LATE");
    try {
      // сервер давно перезапущен и ход закончился — ожидается «прервано»/ошибка, а не вечный спиннер
      await expect(block).not.toHaveAttribute("data-status", "running", { timeout: 3000 });
    } finally {
      await page.goto("about:blank");
    }
  });

  test("после падения посреди команды у каждого вызова инструмента в контексте модели есть результат", async () => {
    expect(crash?.req, "нужен сценарий падения из предыдущего теста").toBeTruthy();
    const msgs = crash!.req!.messages;
    const orphans: string[] = [];
    msgs.forEach((m, i) => {
      for (const tc of m.tool_calls ?? []) if (!msgs.slice(i + 1).some((x) => x.role === "tool" && x.tool_call_id === tc.id)) orphans.push(`${tc.function.name}(${tc.function.arguments})`);
    });
    expect(orphans, `роли: ${msgs.map((m) => m.role).join(",")}`).toEqual([]);
  });
});
