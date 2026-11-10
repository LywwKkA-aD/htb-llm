import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { db, type Task } from "./db.ts";
import { paths } from "./config.ts";
import { formatPlan, listPlan } from "./plan.ts";
import { formatProfile, listProfile } from "./profile.ts";
import { machineIdFromBrief } from "./htb.ts";
import * as memory from "./memory.ts";

// Экспорт задачи одним .tar.gz: /work (без служебного .whitehat — там VPN-креды и бинари),
// отчёт (бриф/план/профиль/память) и транскрипты чатов. tar пишем сами (ustar): зависимости ради
// одной кнопки не тянем; архив собирается в памяти с честным лимитом и списком пропущенного в отчёте.
const MAX_FILE = 50 * 1024 * 1024;
const MAX_TOTAL = 150 * 1024 * 1024;

type Ent = { name: string; buf: Buffer };

function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  let nm = name;
  let prefix = "";
  if (Buffer.byteLength(nm) > 100) {
    const idx = nm.lastIndexOf("/", nm.length - (Buffer.byteLength(nm) - 100) - 1);
    const cut = idx > 0 ? idx : nm.lastIndexOf("/");
    prefix = nm.slice(0, cut);
    nm = nm.slice(cut + 1);
  }
  h.write(nm.slice(0, 100), 0);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + " ", 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + " ", 136);
  h.write("        ", 148); // chksum считается с пробелами на этом месте
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  if (prefix) h.write(prefix.slice(0, 155), 345);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function tarOf(entries: Ent[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(tarHeader(e.name, e.buf.length), e.buf);
    const pad = (512 - (e.buf.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function walkWork(taskId: string): { entries: Ent[]; skipped: string[] } {
  const root = paths.taskWork(taskId);
  const entries: Ent[] = [];
  const skipped: string[] = [];
  let total = 0;
  const walk = (dir: string, rel: string) => {
    let list: fs.Dirent[] = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (r === ".whitehat" || r.startsWith(".whitehat/")) continue; // VPN-креды, бинари, логи сессий
      const abs = path.join(dir, d.name);
      if (d.isSymbolicLink()) { skipped.push(`${r} (симлинк)`); continue; }
      if (d.isDirectory()) { walk(abs, r); continue; }
      if (!d.isFile()) continue;
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { skipped.push(`${r} (не читается)`); continue; }
      if (st.size > MAX_FILE) { skipped.push(`${r} (${Math.round(st.size / 1048576)} МБ — больше лимита файла)`); continue; }
      if (total + st.size > MAX_TOTAL) { skipped.push(`${r} (превышен общий лимит архива)`); continue; }
      entries.push({ name: `work/${r}`, buf: fs.readFileSync(abs) });
      total += st.size;
    }
  };
  walk(root, "");
  return { entries, skipped };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[обрезано]` : s);
const when = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16);

function chatsMd(taskId: string): string {
  const chats = db.prepare("select id, title, summary, created_at, updated_at from chats where task_id=? order by created_at").all(taskId) as any[];
  const out: string[] = ["# Чаты задачи", ""];
  for (const c of chats) {
    out.push(`## ${c.title || "чат"} (${when(c.created_at)} — ${when(c.updated_at)})`);
    if (c.summary) out.push("", `Сводка свёрнутых ходов: ${clip(String(c.summary), 2000)}`);
    const rows = db.prepare("select kind, data, created_at from chat_log where chat_id=? order by id").all(c.id) as any[];
    for (const row of rows) {
      let d: any = {};
      try { d = JSON.parse(row.data); } catch { continue; }
      if (row.kind === "user") out.push("", `### Пользователь`, clip(String(d.content ?? ""), 4000));
      else if (row.kind === "assistant") {
        if (d.content) out.push("", `### Ассистент`, clip(String(d.content), 4000));
        for (const tc of d.tool_calls ?? []) out.push(`- вызов: ${tc.name} ${clip(JSON.stringify(tc.args ?? {}), 300)}`);
      } else if (row.kind === "tool_result") {
        out.push(`- результат ${d.name}: ${clip(String(d.output ?? "").replace(/\n+/g, " ⏎ "), 600)}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

export function buildTaskExport(task: Task): { filename: string; gz: Buffer } {
  const plan = listPlan(task.id);
  const prof = listProfile(task.id);
  const mem = memory.snapshot(task.id).text;
  const { entries: workEntries, skipped } = walkWork(task.id);
  const htbId = machineIdFromBrief(task.brief);
  const report = [
    `# ${task.title} — экспорт задачи HTB LLM`,
    "",
    `- Курс: ${task.course || "—"} · создана: ${when(task.created_at)} · обновлена: ${when(task.updated_at)}`,
    `- Цель: ${task.target || "—"}${task.hostname ? ` (${task.hostname})` : ""}${htbId ? ` · HTB machine #${htbId}` : ""}`,
    "",
    "## Бриф",
    "",
    task.brief || "—",
    "",
    "## План",
    "",
    plan.length ? formatPlan(plan) : "—",
    "",
    "## Профиль цели",
    "",
    prof.length ? formatProfile(prof) : "—",
    "",
    "## Подтверждённая память задачи",
    "",
    mem || "—",
    "",
    "## Состав архива",
    "",
    `- work/ — файлы задачи (без служебного .whitehat: VPN-конфиги и бинари туда не входят), файлов: ${workEntries.length}`,
    "- report.md — этот файл",
    "- chats.md — транскрипты чатов (выводы инструментов обрезаны)",
    ...(skipped.length ? ["", "Не вошло в архив:", ...skipped.map((s) => `- ${s}`)] : []),
    "",
  ].join("\n");
  const entries: Ent[] = [
    { name: "report.md", buf: Buffer.from(report, "utf8") },
    { name: "chats.md", buf: Buffer.from(chatsMd(task.id), "utf8") },
    ...workEntries,
  ];
  const slug = (task.title || "task").toLowerCase().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  return { filename: `${slug}-export.tar.gz`, gz: gzipSync(tarOf(entries)) };
}
