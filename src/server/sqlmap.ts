import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as sandbox from "./sandbox.ts";
import { paths } from "./config.ts";

// Типизированная обёртка sqlmap (пакет 4, п.15): стадии вместо угадывания флагов — detect (поиск
// инъекции + баннер СУБД), dbs, tables, columns, dump. Сервер собирает команду из валидированных
// параметров (всегда --batch: интерактивные вопросы sqlmap в агенте недопустимы), запускает в
// терминале агента, полный лог кладёт в /work/scans/, а модели возвращает факты: СУБД, уязвимые
// параметры с техниками, списки баз/таблиц/колонок, строки дампа и путь к CSV. Сессия sqlmap живёт
// в /work/.whitehat/sqlmap — следующая стадия по той же цели не переищет инъекцию заново.
export type SqlmapStage = "detect" | "dbs" | "tables" | "columns" | "dump";
export type SqlmapOpts = {
  url: string;
  stage?: SqlmapStage;
  data?: string;
  cookie?: string;
  headers?: Record<string, string>;
  db?: string;
  table?: string;
  level?: number;
  risk?: number;
  technique?: string;
  threads?: number;
  fresh?: boolean;
  dumpLimit?: number;
  timeoutSec?: number;
};
export type SqlmapFacts = {
  dbms: string; banner: string;
  vulnerable: { param: string; types: string[] }[];
  notInjectable: boolean;
  databases: string[]; dbsNote: string;
  tables: string[]; tablesDb: string;
  columns: { name: string; type: string }[];
  dump: { table: string; entries: number; header: string[]; rows: string[][]; csvPath: string } | null;
};
export type SqlmapResult = {
  ok: boolean; error?: string;
  stage: SqlmapStage; url: string;
  facts: SqlmapFacts;
  logPath: string; timedOut: boolean; exitCode: number; secs: number;
};

const IDENT_RE = /^[A-Za-z0-9_$-]+$/;
const intIn = (v: unknown, lo: number, hi: number, def: number) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
};

export function validateSqlmapOpts(o: SqlmapOpts): string | null {
  let u: URL;
  try { u = new URL(o.url); } catch { return "url должен быть полным, например http://machine.htb/item?id=1"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "только http/https";
  if (/[\s'"`$\\]/.test(o.url)) return "url: без пробелов, кавычек и shell-спецсимволов";
  if (!u.search && !o.data) return "нужен параметр для проверки: в URL (?id=1) или в data для POST";
  const stage = o.stage ?? "detect";
  if ((stage === "columns" || stage === "dump") && !o.table) return `для стадии ${stage} нужен table`;
  if (o.db !== undefined && !IDENT_RE.test(o.db)) return "db: только буквы, цифры, _ $ -";
  if (o.table !== undefined && !IDENT_RE.test(o.table)) return "table: только буквы, цифры, _ $ -";
  if (o.technique !== undefined && !/^[BEUSTQ]+$/i.test(o.technique)) return "technique: буквы из B,E,U,S,T,Q";
  if (o.data !== undefined && (o.data.length > 4000 || /[\n\r]/.test(o.data))) return "data: одна строка до 4000 символов";
  if (o.cookie !== undefined && (o.cookie.length > 1000 || /[\n\r]/.test(o.cookie))) return "cookie: одна строка до 1000 символов";
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) return `заголовок ${k}: недопустимое имя`;
    if (/[\n\r]/.test(v)) return `заголовок ${k}: без переносов строк`;
  }
  return null;
}

// Строки ASCII-таблицы sqlmap после маркера: | a | b | -> ["a","b"], до первой не-табличной строки.
function gridRows(log: string, fromIdx: number): string[][] {
  const rows: string[][] = [];
  for (const line of log.slice(fromIdx).split("\n")) {
    const m = /^\|(.+)\|\s*$/.exec(line.trim());
    if (m) rows.push(m[1].split("|").map((c) => c.trim()));
    else if (rows.length && !/^\+[-+]+\+$/.test(line.trim())) break;
  }
  return rows;
}

export function parseSqlmapLog(log: string): SqlmapFacts {
  const f: SqlmapFacts = {
    dbms: "", banner: "", vulnerable: [], notInjectable: false,
    databases: [], dbsNote: "", tables: [], tablesDb: "", columns: [], dump: null,
  };
  const dbmsMatches = [...log.matchAll(/back-end DBMS: (.+)$/gm)];
  if (dbmsMatches.length) f.dbms = dbmsMatches.at(-1)![1].trim();
  const banner = /banner:\s*'([^']+)'/.exec(log);
  if (banner) f.banner = banner[1];
  f.notInjectable = /all tested parameters do not appear to be injectable/i.test(log);

  const summaryIdx = log.indexOf("sqlmap identified the following injection point");
  if (summaryIdx >= 0) {
    // сводка обёрнута в пару разделителей ---: параметры между первым и вторым
    const open = log.indexOf("\n---", summaryIdx);
    const close = open > 0 ? log.indexOf("\n---", open + 4) : -1;
    const block = open > 0 ? log.slice(open, close > 0 ? close : undefined) : "";
    let cur: { param: string; types: string[] } | null = null;
    for (const line of block.split("\n")) {
      const pm = /^Parameter: (.+)$/.exec(line.trim());
      if (pm) { cur = { param: pm[1].trim(), types: [] }; f.vulnerable.push(cur); continue; }
      const tm = /^\s*Type: (.+)$/.exec(line);
      if (tm && cur && !cur.types.includes(tm[1].trim())) cur.types.push(tm[1].trim());
    }
  }
  if (!f.vulnerable.length) {
    const seen = new Map<string, Set<string>>();
    for (const m of log.matchAll(/(?:GET|POST) parameter '([^']+)' is vulnerable/g)) seen.set(m[1], seen.get(m[1]) ?? new Set());
    for (const [param, types] of seen) f.vulnerable.push({ param, types: [...types] });
  }

  const dbs = /available databases \[\d+\]:/.exec(log);
  if (dbs) {
    for (const line of log.slice(dbs.index).split("\n").slice(1)) {
      const m = /^\[\*\]\s+(.+)$/.exec(line.trim());
      if (m) f.databases.push(m[1].trim());
      else if (line.trim() === "") break;
    }
  }
  const sqliteNote = /\[WARNING\] on SQLite it is not possible to enumerate databases[^\n]*/.exec(log);
  if (sqliteNote) f.dbsNote = "SQLite: базы не перечисляются, сразу стадия tables";

  const tbl = /\[(\d+) tables?\]/i.exec(log);
  if (tbl) {
    const before = log.slice(Math.max(0, tbl.index - 200), tbl.index);
    const dbm = /(?:Database:|fetching tables for database: ')([^\n']+)/.exec(before.split("\n").at(-2) + "\n" + before.split("\n").at(-1));
    if (dbm) f.tablesDb = dbm[1].trim();
    f.tables = gridRows(log, tbl.index).map((r) => r[0]).filter(Boolean);
  }

  const cols = /\[(\d+) columns\]/.exec(log);
  if (cols) {
    const rows = gridRows(log, cols.index);
    // первая строка грида — заголовок «Column | Type»
    f.columns = rows.slice(1).map((r) => ({ name: r[0] ?? "", type: r[1] ?? "" })).filter((c) => c.name);
  }

  const dump = /Table: (\S+)\s*\n\[(\d+) entries\]/.exec(log);
  if (dump) {
    const rows = gridRows(log, dump.index);
    const csv = /dumped to CSV file '([^']+)'/.exec(log);
    f.dump = {
      table: dump[1], entries: Number(dump[2]),
      header: rows[0] ?? [], rows: rows.slice(1), csvPath: csv ? csv[1] : "",
    };
  }
  return f;
}

export async function runSqlmap(taskId: string, o: SqlmapOpts, signal?: AbortSignal): Promise<SqlmapResult> {
  const stage = o.stage ?? "detect";
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${crypto.randomBytes(3).toString("hex")}`;
  const logRel = `scans/sqlmap-${stage}-${stamp}.log`;
  const logPath = `/work/${logRel}`;
  const level = intIn(o.level, 1, 5, 1), risk = intIn(o.risk, 1, 3, 1);
  const timeout = intIn(o.timeoutSec, 60, 900, 600);

  const args: string[] = [
    `-u ${sandbox.shq(o.url)}`, "--batch", `--level ${level}`, `--risk ${risk}`,
    `--threads ${intIn(o.threads, 1, 10, 4)}`, "--output-dir=/work/.whitehat/sqlmap",
  ];
  if (o.data) args.push(`--data ${sandbox.shq(o.data)}`);
  if (o.cookie) args.push(`--cookie ${sandbox.shq(o.cookie)}`);
  const headerStr = Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
  if (headerStr) args.push(`--headers ${sandbox.shq(headerStr)}`);
  if (o.technique) args.push(`--technique=${o.technique.toUpperCase()}`);
  if (o.fresh) args.push("--flush-session");
  if (stage === "detect") args.push("--banner");
  if (stage === "dbs") args.push("--dbs");
  if (stage === "tables") args.push("--tables");
  if (stage === "columns") args.push("--columns");
  if (stage === "dump") {
    args.push("--dump");
    const lim = intIn(o.dumpLimit, 0, 100000, 0);
    if (lim > 0) args.push(`--start 1 --stop ${lim}`);
  }
  if (o.db) args.push(`-D ${o.db}`);
  if (o.table && (stage === "columns" || stage === "dump")) args.push(`-T ${o.table}`);

  const cmd = `mkdir -p /work/scans && sqlmap ${args.join(" ")} 2>&1 | tee ${logPath}`;
  const r = await sandbox.runAgentCommand(taskId, cmd, timeout, signal);
  const empty: SqlmapFacts = { dbms: "", banner: "", vulnerable: [], notInjectable: false, databases: [], dbsNote: "", tables: [], tablesDb: "", columns: [], dump: null };
  const base: SqlmapResult = { ok: false, stage, url: o.url, facts: empty, logPath, timedOut: r.timedOut, exitCode: r.exitCode, secs: r.secs };
  if (r.aborted) return { ...base, error: "остановлено пользователем" };

  let log = "";
  try { log = fs.readFileSync(path.join(paths.taskWork(taskId), logRel), "utf8"); } catch { /* ниже */ }
  if (!log) return { ...base, error: r.timedOut ? `sqlmap не уложился в ${timeout} с, лога нет` : `sqlmap завершился без лога (exit ${r.exitCode}) — вывод в терминале агента` };
  return { ...base, ok: true, facts: parseSqlmapLog(log) };
}

export function formatSqlmap(r: SqlmapResult): string {
  if (!r.ok) return `ошибка: ${r.error ?? "sqlmap не отработал"}`;
  const f = r.facts;
  const lines: string[] = [];
  const head = `sqlmap_scan [${r.stage}]: ${r.url} (${r.secs} с)`;
  if (f.vulnerable.length) {
    lines.push(`${head} — СУБД: ${f.dbms || "?"}${f.banner ? `, баннер: ${f.banner}` : ""}`);
    lines.push("уязвимые параметры:");
    for (const v of f.vulnerable) lines.push(`- ${v.param}${v.types.length ? `: ${v.types.join(", ")}` : ""}`);
  } else if (f.notInjectable) {
    lines.push(`${head} — инъекций не найдено на этих level/risk. Не доказательство отсутствия: попробуй level 3-5, risk 2, другой параметр или POST-данные`);
  } else {
    lines.push(`${head} — СУБД: ${f.dbms || "?"}`);
  }
  if (f.databases.length) lines.push(`базы (${f.databases.length}): ${f.databases.join(", ")}`);
  if (f.dbsNote) lines.push(f.dbsNote);
  if (f.tables.length) lines.push(`таблицы${f.tablesDb ? ` базы ${f.tablesDb}` : ""} (${f.tables.length}): ${f.tables.join(", ")}`);
  if (f.columns.length) lines.push(`колонки: ${f.columns.map((c) => c.type ? `${c.name} (${c.type})` : c.name).join(", ")}`);
  if (f.dump) {
    lines.push(`дамп ${f.dump.table}: строк ${f.dump.entries}${f.dump.csvPath ? `, CSV: ${f.dump.csvPath}` : ""}`);
    if (f.dump.header.length) lines.push(f.dump.header.join(" | "));
    for (const row of f.dump.rows.slice(0, 10)) lines.push(row.join(" | "));
    if (f.dump.rows.length > 10) lines.push(`... остальные строки — в CSV`);
  }
  if (r.timedOut) lines.push("[прервано по таймауту — результат частичный, сессия сохранена: повтор той же стадии продолжит быстрее]");
  lines.push(`лог целиком: ${r.logPath}; сессия sqlmap: /work/.whitehat/sqlmap`);
  return lines.join("\n");
}
