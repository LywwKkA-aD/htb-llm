import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, mockRequests, mockReset, textOf, MOCK, type Ids } from "./helpers";

// Регрессии исправлений владельца graph-memory (graph.ts, memory.ts, library.ts, llm.ts, prompts.ts):
// снимок памяти на чат (ctx-3), закрытие оборванных вызовов инструментов (ctx-1/ctx-2), разбор и дедупликация
// предложений памяти (MEM-1, MEM-2), защита подтверждения/отклонения (MEM-3, MEM-5), обрезка по кодовым точкам (TC-7),
// разбор md (LIB-1, LIB-2), таймауты LLM, ограничение блока заголовков памяти, правила промптов.
// Мок: директивы [[gm:…]] (tests/mock-plugins/fix-graph-memory.mjs).

const ROOT = path.resolve(import.meta.dirname, "../..");
const DATA = path.resolve(process.env.E2E_DATA ?? path.join(ROOT, "tests/.data"));

type Ev = Record<string, any>;
type Msg = { role: string; content: any; tool_calls?: any[]; tool_call_id?: string };
type Mem = { id: number; chat_id: string | null; kind: string; title: string; content: string; status: string };

async function turn(request: APIRequestContext, chatId: string, text: string, base = "") {
  const r = await request.post(`${base}/api/chats/${chatId}/send`, { data: { text, images: [], effort: "off" }, timeout: 90_000 });
  const body = await r.text();
  expect(r.status(), body).toBe(200);
  return body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))) as Ev[];
}
const done = (evs: Ev[]) => {
  const d = evs.find((e) => e.type === "done");
  expect(d, `ход должен закончиться без ошибки: ${JSON.stringify(evs.filter((e) => e.type === "error"))}`).toBeTruthy();
  return d!;
};
const agentReqs = async (request: APIRequestContext) =>
  (await mockRequests(request)).filter((r) => r.kind === "agent").map((r) => r.body as { messages: Msg[] });
const proposeReqs = async (request: APIRequestContext) => (await mockRequests(request)).filter((r) => r.kind === "propose").map((r) => r.body as { messages: Msg[] });
const sysOf = (b: { messages: Msg[] }) => textOf(b.messages[0].content);
const usersOf = (b: { messages: Msg[] }) => b.messages.filter((m) => m.role === "user").map((m) => textOf(m.content));

// задача без ожидания контейнера (ходам без shell он не нужен)
async function rawTask(request: APIRequestContext, title: string, base = "") {
  const r = await request.post(`${base}/api/tasks`, { data: { title, course: "Сети", brief: "Условие для проверки исправлений." } });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as Ids;
}
async function newChat(request: APIRequestContext, taskId: string) {
  const r = await request.post(`/api/tasks/${taskId}/chats`);
  expect(r.ok()).toBe(true);
  return (await r.json()) as { id: string };
}
const mems = async (request: APIRequestContext, taskId: string) => (await (await request.get(`/api/tasks/${taskId}/memories`)).json()) as Mem[];
async function addMem(request: APIRequestContext, taskId: string, m: { kind?: string; title: string; content: string }) {
  const r = await request.post(`/api/tasks/${taskId}/memories`, { data: m });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as Mem;
}
async function chatLog(request: APIRequestContext, chatId: string, base = "") {
  return ((await (await request.get(`${base}/api/chats/${chatId}/log`)).json()) as { log: { kind: string; data: any }[] }).log;
}
// карточки памяти прямо из базы — со статусом rejected, которого API не отдаёт
function memRow(id: number) {
  const db = new Database(path.join(DATA, "whitehat.db"), { readonly: true, fileMustExist: true });
  try { return db.prepare("select id,title,content,status,chat_id from memories where id=?").get(id) as Mem | undefined; } finally { db.close(); }
}
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|�/;

// ---------- свой экземпляр сервера на тех же данных ----------
type Srv = { child: ChildProcess; base: string; out: () => string };
async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const sv = net.createServer();
    sv.on("error", reject);
    sv.listen(0, "127.0.0.1", () => { const p = (sv.address() as net.AddressInfo).port; sv.close(() => resolve(p)); });
  });
}
async function startServer(port: number, env: Record<string, string> = {}): Promise<Srv> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, WH_PORT: String(port), WH_DATA: DATA, WH_LLM_URL: `${MOCK}/v1`, WH_EMBED_URL: `${MOCK}/v1`, WH_RECALL_MIN_SIM: "0", WH_LLM_MODEL: "Qwen3.8-27B-Turbo", ...env },
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
  srv.child.kill("SIGKILL"); // как падение: без корректного завершения
  await once(srv.child, "exit");
}

test.describe("граф и память: исправления", () => {
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("ctx-3: память, изменённая посреди чата, приходит в контексте хода, а системный промпт чата не меняется; новый чат и сворачивание берут свежую", async ({ request }) => {
    test.setTimeout(120_000);
    const t = await rawTask(request, "Снимок памяти");
    done(await turn(request, t.chat.id, "ХОД-1 [[short]] [[nomem]]"));
    const [r1] = await agentReqs(request);
    expect(sysOf(r1)).not.toContain("ПАМЯТЬ ЗАДАЧИ");

    const a = await addMem(request, t.task.id, { kind: "fact", title: "Шлюз лабы", content: "default via 10.0.0.1 dev eth0" });
    const b = await addMem(request, t.task.id, { kind: "command", title: "Порт ssh", content: "ss -tlnp: sshd на 0.0.0.0:22" });
    await mockReset(request);
    done(await turn(request, t.chat.id, "ХОД-2 [[short]] [[nomem]]"));
    const [r2] = await agentReqs(request);
    expect(sysOf(r2), "системный промпт чата не меняется (кэш llama-server)").toBe(sysOf(r1));
    const u2 = usersOf(r2).at(-1)!;
    expect(u2).toContain("<контекст_хода>");
    expect(u2).toContain("Память задачи изменилась после начала этого чата");
    expect(u2).toContain("- [факт] Шлюз лабы: default via 10.0.0.1 dev eth0");
    expect(u2).toContain("- [команда] Порт ssh: ss -tlnp: sshd на 0.0.0.0:22");

    // следующий ход: изменение не повторяется, прошлое сообщение уходит побайтно тем же
    await mockReset(request);
    done(await turn(request, t.chat.id, "ХОД-3 [[short]] [[nomem]]"));
    const [r3] = await agentReqs(request);
    expect(sysOf(r3)).toBe(sysOf(r1));
    const u3 = usersOf(r3);
    expect(u3.slice(0, 2)).toEqual([usersOf(r2)[0], u2]);
    expect(u3[2].startsWith("ХОД-3 [[short]] [[nomem]]")).toBe(true);
    expect(u3[2], "изменение памяти не повторяется").not.toContain("Память задачи изменилась");

    // правка и удаление тоже приходят как изменения
    expect((await request.post(`/api/memories/${a.id}/confirm`, { data: { title: "Шлюз лабы (правка)", content: "default via 10.0.0.254 dev eth0" } })).ok()).toBe(true);
    expect((await request.delete(`/api/memories/${b.id}`)).ok()).toBe(true);
    await mockReset(request);
    done(await turn(request, t.chat.id, "ХОД-4 [[short]] [[nomem]]"));
    const [r4] = await agentReqs(request);
    expect(sysOf(r4)).toBe(sysOf(r1));
    const u4 = usersOf(r4).at(-1)!;
    expect(u4).toContain("- [факт] Шлюз лабы (правка): default via 10.0.0.254 dev eth0");
    expect(u4).toContain("Удалены из памяти — больше не опирайся на них: «Порт ssh»");
    expect(u4).not.toContain("- [команда] Порт ssh");

    // новый чат начинается со свежей памятью в системном промпте и без «изменений»
    const other = await newChat(request, t.task.id);
    await mockReset(request);
    done(await turn(request, other.id, "[[short]] [[nomem]] новый чат"));
    const [rn] = await agentReqs(request);
    expect(sysOf(rn)).toContain("# ПАМЯТЬ ЗАДАЧИ (подтверждено пользователем)\n- [факт] Шлюз лабы (правка): default via 10.0.0.254 dev eth0\n");
    expect(sysOf(rn)).not.toContain("Порт ssh");
    expect(usersOf(rn)).toHaveLength(1);
    expect(usersOf(rn)[0], "в новом чате память — в системном промпте, не «изменением»").not.toContain("Память задачи изменилась");

    // сворачивание меняет системный промпт всё равно — снимок памяти в нём освежается
    await mockReset(request);
    const ev5 = await turn(request, t.chat.id, "ХОД-5 [[ctx:tok:20000]] [[nomem]]");
    done(ev5);
    expect(ev5.find((e) => e.type === "compacted"), "ход с большим контекстом сворачивает старое").toBeTruthy();
    await mockReset(request);
    done(await turn(request, t.chat.id, "ХОД-6 [[short]] [[nomem]]"));
    const [r6] = await agentReqs(request);
    expect(sysOf(r6)).toContain("- [факт] Шлюз лабы (правка): default via 10.0.0.254 dev eth0");
    expect(sysOf(r6)).toContain("# РАНЕЕ В ЭТОМ ЧАТЕ");
    expect(usersOf(r6).at(-1), "после освежения снимка изменений нет").not.toContain("Память задачи изменилась");
  });

  test("MEM-1: скобки и числовой массив вокруг JSON в ```json, скобки внутри строк JSON — карточка извлекается", async ({ request }) => {
    const t = await rawTask(request, "Скобки в предложениях");
    const evs = await turn(request, t.chat.id, "[[gm:brackets]] какие строки со скобкой?");
    done(evs);
    const p = evs.find((e) => e.type === "proposals");
    expect(p, "предложения не потерялись").toBeTruthy();
    expect(p!.items.map((m: Mem) => [m.title, m.content])).toEqual([["Скобки [1] в заголовке", "grep -c ']' /work/x.txt — считает строки с «]», вывод [3]"]]);
  });

  test("MEM-2: повторы подтверждённого и отклонённого не предлагаются, дубли внутри ответа и ожидающие в этом же чате — тоже; в другом чате ожидающее можно предложить заново", async ({ request }) => {
    const t = await rawTask(request, "Повторы в памяти");
    await addMem(request, t.task.id, { kind: "fact", title: "Шлюз по умолчанию", content: "default via 10.0.0.1 dev eth0" });
    const titlesOf = (evs: Ev[]) => (evs.find((e) => e.type === "proposals")?.items ?? []).map((m: Mem) => m.title);

    const first = await turn(request, t.chat.id, "[[gm:dup]] что нашли?");
    done(first);
    expect(titlesOf(first), "регистр и пробелы не делают повтор новой карточкой").toEqual(["Новая находка", "Отклонённая находка"]);
    const rej = (await mems(request, t.task.id)).find((m) => m.title === "Отклонённая находка")!;
    expect((await request.post(`/api/memories/${rej.id}/reject`)).ok()).toBe(true);

    await mockReset(request);
    const again = await turn(request, t.chat.id, "[[gm:dup]] ещё раз");
    done(again);
    expect(titlesOf(again), "всё уже есть: подтверждено, отклонено или ждёт в этом чате").toEqual([]);
    const [req] = await proposeReqs(request);
    const u = textOf(req.messages[1].content);
    expect(u, "модель видит текст существующих карточек").toContain("«Шлюз по умолчанию»: default via 10.0.0.1 dev eth0");
    expect(u).toContain("ждёт подтверждения] «Новая находка»: порт 8443 открыт");
    expect(u, "и отклонённые заголовки").toContain("Пользователь отклонил — не предлагай снова: «Отклонённая находка»");

    const other = await newChat(request, t.task.id);
    const elsewhere = await turn(request, other.id, "[[gm:dup]] в другом чате");
    done(elsewhere);
    expect(titlesOf(elsewhere), "ожидающее из другого чата может быть уточнено заново").toEqual(["Новая находка"]);
    const all = await mems(request, t.task.id);
    expect(all.filter((m) => m.title.toLowerCase().replace(/\s+/g, " ").trim() === "шлюз по умолчанию")).toHaveLength(1);
  });

  test("MEM-5/MEM-3: «не нужно» и «сохранить» действуют только на ожидающую карточку; пустые поля не сохраняются", async ({ request }) => {
    const t = await rawTask(request, "Защита карточек");
    const evs = await turn(request, t.chat.id, "[[gm:card:Карточка для панели]] вопрос");
    done(evs);
    const [x] = evs.find((e) => e.type === "proposals")!.items as Mem[];
    // подтвердили с правкой в панели…
    expect((await request.post(`/api/memories/${x.id}/confirm`, { data: { title: "Правка из панели", content: "исправлено в панели" } })).ok()).toBe(true);
    // …а устаревшее предложение в чате нажали «не нужно» и «сохранить» без правок
    expect((await request.post(`/api/memories/${x.id}/reject`)).ok(), "отклонение подтверждённой — тихий no-op").toBe(true);
    expect((await request.post(`/api/memories/${x.id}/confirm`, { data: {} })).ok()).toBe(true);
    expect(memRow(x.id)).toMatchObject({ status: "confirmed", title: "Правка из панели", content: "исправлено в панели" });

    // отклонённую не воскресить подтверждением
    const evs2 = await turn(request, t.chat.id, "[[gm:card:Отклоню и подтвержу]] вопрос");
    done(evs2);
    const [y] = evs2.find((e) => e.type === "proposals")!.items as Mem[];
    expect((await request.post(`/api/memories/${y.id}/reject`)).ok()).toBe(true);
    const c = await request.post(`/api/memories/${y.id}/confirm`, { data: {} });
    expect(c.status()).toBe(400);
    expect(memRow(y.id)?.status).toBe("rejected");

    // пустые и пробельные поля
    expect((await request.post(`/api/tasks/${t.task.id}/memories`, { data: { title: "   ", content: "текст" } })).status()).toBe(400);
    expect((await request.post(`/api/memories/${x.id}/confirm`, { data: { content: "  \n\t " } })).status()).toBe(400);
    expect(memRow(x.id)).toMatchObject({ title: "Правка из панели", content: "исправлено в панели" });
    expect((await mems(request, t.task.id)).every((m) => m.title.trim() && m.content.trim())).toBe(true);
  });

  test("TC-7: заголовок и текст карточки обрезаются по кодовым точкам — эмодзи на границе 200/4000 не режется пополам", async ({ request }) => {
    const t = await rawTask(request, "Эмодзи в карточке");
    const evs = await turn(request, t.chat.id, "[[gm:emoji]] длинная карточка");
    done(evs);
    const [m] = evs.find((e) => e.type === "proposals")!.items as Mem[];
    expect(m.title).toBe("а".repeat(199) + "😀");
    expect(m.content).toBe("б".repeat(3999) + "😀");
    const row = memRow(m.id)!;
    expect(row.title).not.toMatch(loneSurrogate);
    expect(row.content).not.toMatch(loneSurrogate);
  });

  test("ctx-1/ctx-2: сервер упал между двумя вызовами одного раунда — результат первого сохраняется, второй закрывается «(прервано)», и это навсегда", async ({ request }) => {
    test.setTimeout(180_000);
    let srv: Srv | null = null;
    try {
      const port = await freePort();
      srv = await startServer(port);
      const B = srv.base;
      const created = await rawTask(request, "Падение между вызовами", B);
      const chatId = created.chat.id;
      await expect.poll(async () => (await (await request.get(`${B}/api/tasks/${created.task.id}/container`)).json()).status, { timeout: 40_000 }).toBe("running");
      const pending = request.post(`${B}/api/chats/${chatId}/send`, { data: { text: "ХОД-1 [[gm:two]] [[nomem]]", images: [] }, timeout: 90_000 }).catch((e) => e);
      const agentLog = path.join(DATA, "tasks", created.task.id, "agent-terminal.log");
      await expect.poll(() => (fs.existsSync(agentLog) ? fs.readFileSync(agentLog, "utf8") : "").includes("sleep 30"), { timeout: 30_000 }).toBe(true);
      await killServer(srv);
      await pending;
      srv = await startServer(port);

      const before = await chatLog(request, chatId, B);
      expect(before.map((x) => x.kind), "первый вызов успел записать результат").toEqual(["user", "assistant", "tool_result"]);
      const calls = before[1].data.tool_calls as { id: string; args: { command: string } }[];
      expect(calls.map((c) => c.args.command)).toEqual(["echo GM-FIRST", "sleep 30; echo GM-LATE"]);

      await mockReset(request);
      done(await turn(request, chatId, "ХОД-2 [[short]]", B));
      const [r2] = await agentReqs(request);
      expect(r2.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
      const [t1, t2] = r2.messages.filter((m) => m.role === "tool");
      expect(t1.tool_call_id).toBe(calls[0].id);
      expect(textOf(t1.content), "результат первого вызова взят из журнала").toContain("GM-FIRST");
      expect(t2.tool_call_id).toBe(calls[1].id);
      expect(textOf(t2.content)).toMatch(/^\(прервано: /);

      const after = await chatLog(request, chatId, B);
      expect(after.map((x) => x.kind)).toEqual(["user", "assistant", "tool_result", "tool_result", "user", "assistant"]);
      expect(after[3].data).toMatchObject({ id: calls[1].id, name: "shell", interrupted: true });
      expect(String(after[3].data.output)).toMatch(/^\(прервано: /);

      // исправление сохранилось в состоянии: следующий ход видит ту же историю побайтно и ничего не дописывает
      await mockReset(request);
      done(await turn(request, chatId, "ХОД-3 [[short]]", B));
      const [r3] = await agentReqs(request);
      expect(r3.messages.slice(0, r2.messages.length).map((m) => JSON.stringify(m))).toEqual(r2.messages.map((m) => JSON.stringify(m)));
      expect((await chatLog(request, chatId, B)).filter((x) => x.kind === "tool_result")).toHaveLength(2);
    } finally {
      await killServer(srv);
    }
  });

  test("LLM не отвечает: таймаут первого байта, простой потока и отказ в соединении — понятная ошибка, чат свободен", async ({ request }) => {
    test.setTimeout(150_000);
    let srv: Srv | null = null;
    try {
      srv = await startServer(await freePort(), { WH_LLM_FIRST_BYTE_TIMEOUT: "2", WH_LLM_IDLE_TIMEOUT: "2" });
      const B = srv.base;
      const t = await rawTask(request, "Таймауты LLM");
      let t0 = Date.now();
      const hang = await turn(request, t.chat.id, "[[gm:hang]] вопрос", B);
      expect(hang.find((e) => e.type === "error")?.message).toMatch(/не начал отвечать за 2 с/);
      expect(Date.now() - t0, "ошибка через ~2 с, а не через 5 минут").toBeLessThan(20_000);
      t0 = Date.now();
      const stall = await turn(request, t.chat.id, "[[gm:stall]] вопрос", B);
      expect(stall.filter((e) => e.type === "token").map((e) => e.t).join("")).toContain("Начинаю");
      expect(stall.find((e) => e.type === "error")?.message).toMatch(/поток ответа замолчал на 2 с/);
      expect(Date.now() - t0).toBeLessThan(20_000);
      expect((await request.get(`${B}/api/chats/${t.chat.id}/stream`)).status(), "чат не остался «занятым»").toBe(204);
      const markers = (await chatLog(request, t.chat.id)).filter((x) => x.kind === "marker").map((x) => x.data.type);
      expect(markers).toEqual(["error", "error"]);
      await killServer(srv);

      // llama-server не запущен: сразу ясная причина вместо «fetch failed»
      srv = await startServer(await freePort(), { WH_LLM_URL: `http://127.0.0.1:${await freePort()}/v1` });
      const refused = await turn(request, t.chat.id, "[[short]] вопрос", srv.base);
      expect(refused.find((e) => e.type === "error")?.message).toMatch(/LLM недоступен .*соединение отклонено/);
    } finally {
      await killServer(srv);
    }
  });

  test("LIB-1/LIB-2: md с BOM и CRLF, блоки ``` и ~~~ (в том числе с длинным ограждением), заголовки с закрывающими #", async ({ request }) => {
    const t = await rawTask(request, "Разбор md");
    const NAME = "bom-crlf-гм.md";
    const md = "﻿" + [
      "# Сети",
      "## VLAN ##",
      "Тег 802.1Q занимает 4 байта, факт GMBOMWORD.",
      "~~~~bash",
      "# комментарий в тильдах",
      "~~~",
      "# всё ещё код: короткое ограждение не закрывает",
      "~~~~",
      "````md",
      "```",
      "# код внутри длинного ограждения",
      "````",
      "После кода GMAFTERWORD.",
      "## STP",
      "Корневой мост GMSTPWORD.",
    ].join("\r\n");
    const fd = new FormData();
    fd.append("files", new File([md], NAME, { type: "text/markdown" }));
    fd.append("task", t.task.id);
    const up = await request.post("/api/docs", { multipart: fd });
    expect(up.ok(), await up.text()).toBe(true);
    const [d] = (await up.json()) as { id: number }[];
    await expect.poll(async () => ((await (await request.get(`/api/docs?task=${t.task.id}`)).json()) as any[]).find((x) => x.id === d.id)?.status, { timeout: 30_000 }).toBe("ready");

    const db = new Database(path.join(DATA, "whitehat.db"), { readonly: true, fileMustExist: true });
    const chunks = (() => { try { return db.prepare("select heading, text from chunks where doc_id=? order by id").all(d.id) as { heading: string; text: string }[]; } finally { db.close(); } })();
    expect(chunks.map((c) => c.heading)).toEqual(["Сети › VLAN", "Сети › STP"]);
    const vlan = chunks[0].text;
    for (const s of ["# комментарий в тильдах", "# всё ещё код: короткое ограждение не закрывает", "# код внутри длинного ограждения", "GMAFTERWORD"]) expect(vlan).toContain(s);
    expect(vlan).not.toContain("\r");
    expect(vlan).not.toContain("﻿");
    expect(vlan).not.toContain("## VLAN");

    // цитата в выдаче search_docs — с путём разделов, начиная с первого заголовка после BOM
    const evs = await turn(request, t.chat.id, "[[tool:docs:GMBOMWORD]] [[nomem]]");
    done(evs);
    const out = String(evs.find((e) => e.type === "tool_end" && e.name === "search_docs")?.output ?? "");
    expect(out).toContain(`[${NAME} — Сети › VLAN]`);
  });

  test("промпты: правила песочницы, вывода, арифметики, проверки; резюме не выдумывает статус; propose знает про инструменты и существующие карточки", async ({ request }) => {
    const t = await rawTask(request, "Правила промптов");
    await addMem(request, t.task.id, { kind: "fact", title: "Адрес лабы", content: "10.7.0.0/22, шлюз 10.7.0.1" });
    done(await turn(request, t.chat.id, "[[gm:card:Без инструментов]] объясни"));
    const [r1] = await agentReqs(request);
    const sys = sysOf(r1);
    for (const s of [
      "Песочница — только этот контейнер", "172.16.0.0/12", "не сканируй их",
      "Вывод сам не обрезай (| head, | tail)", "/work/.whitehat/out-*.txt", "grep -c, wc -l, sort | uniq -c",
      "через python3 -c", "нет systemd и syslog", "никогда не печатай «OK» через ||", "перед итоговым ответом пройди по каждому",
      "# ЗАДАЧА: Правила промптов", "# ПАМЯТЬ ЗАДАЧИ",
    ]) expect(sys, s).toContain(s);
    expect(sys).not.toContain("работай с ним через grep/head");

    const [p1] = await proposeReqs(request);
    expect(textOf(p1.messages[0].content)).toContain("от 0 до 2 карточек");
    expect(textOf(p1.messages[0].content)).toContain("показал вывод инструмента");
    const u1 = textOf(p1.messages[1].content);
    expect(u1).toContain("В этом ходе инструменты не запускались");
    expect(u1).toContain("«Адрес лабы»: 10.7.0.0/22, шлюз 10.7.0.1");

    await mockReset(request);
    done(await turn(request, t.chat.id, "[[tool:subnet:10.7.0.0/22]] [[gm:card:С инструментом]]"));
    const [p2] = await proposeReqs(request);
    expect(textOf(p2.messages[1].content)).not.toContain("В этом ходе инструменты не запускались");
    expect(textOf(p2.messages[1].content)).toContain("«Без инструментов»");

    // резюме при сворачивании
    for (const i of [1, 2]) done(await turn(request, t.chat.id, `ХОД-${i} [[short]] [[nomem]]`));
    await mockReset(request);
    done(await turn(request, t.chat.id, "ХОД-3 [[ctx:tok:20000]] [[nomem]]"));
    const sum = (await mockRequests(request)).find((r) => r.kind === "summary");
    expect(sum, "сворачивание запросило резюме").toBeTruthy();
    const sp = textOf(sum!.body.messages[0].content);
    expect(sp).not.toContain("что планировалось дальше");
    expect(sp).toContain("тебе не показаны");
    expect(sp).toContain("Ничего не додумывай");
  });

  test("большая память: блок заголовков в системном промпте и список остальных в контексте хода ограничены бюджетом", async ({ request }) => {
    test.setTimeout(120_000);
    const t = await rawTask(request, "Очень много карточек");
    const N = 70;
    for (let i = 1; i <= N; i++) {
      await addMem(request, t.task.id, { kind: "fact", title: `Карточка ${String(i).padStart(3, "0")} ` + "длинный заголовок ".repeat(10).trim(), content: `содержимое ${i} ` + "текст ".repeat(40) });
    }
    done(await turn(request, t.chat.id, "[[short]] [[nomem]] что в памяти?"));
    const [r] = await agentReqs(request);
    const sys = sysOf(r);
    expect(sys).toContain(`Карточек много (${N}), здесь только заголовки`);
    const block = sys.split("# ПАМЯТЬ ЗАДАЧИ (подтверждено пользователем)\n")[1];
    const omitted = /\(и ещё (\d+) более старых — через search_memory\)/.exec(block);
    expect(omitted, "старые заголовки не влезли — об этом сказано").toBeTruthy();
    const titleLines = block.split("\n").filter((l) => l.startsWith("- ["));
    expect(Math.ceil(titleLines.join("\n").length / 3), "заголовки укладываются в бюджет recallMemoryTokens").toBeLessThanOrEqual(1800);
    expect(block, "самые новые — на месте").toContain(`Карточка ${String(N).padStart(3, "0")} `);
    expect(block, "самые старые — нет").not.toContain("Карточка 001 ");
    const shown = titleLines.filter((l) => /^- \[факт\] Карточка \d{3} /.test(l)).length;
    expect(shown + Number(omitted![1])).toBe(N);
    // в контексте хода: релевантные карточки (бюджет 1800) + список остальных заголовков (тоже в бюджете)
    const u = usersOf(r).at(-1)!;
    const rel = u.split("Релевантные карточки памяти задачи:\n")[1]?.split("\n\nВозможно полезные фрагменты")[0] ?? "";
    expect(rel, "релевантные карточки подклеены").toContain("(ещё в памяти задачи, достать через search_memory: «");
    expect(Math.ceil(rel.length / 3), "память в контексте хода не раздувается").toBeLessThanOrEqual(2 * 1800 + 100);
  });
});
