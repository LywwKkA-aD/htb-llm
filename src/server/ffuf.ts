import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as sandbox from "./sandbox.ts";
import { paths } from "./config.ts";

// Типизированная обёртка ffuf (пакет 4, п.15): сервер собирает команду из валидированных параметров,
// запускает в терминале агента, а JSON-результат парсит в факты — находки со статусами и размерами,
// а не простыню прогресс-бара. Два режима: path (FUZZ в URL) и vhost (Host: FUZZ.домен; базовый
// размер ответа сервер меряет сам одним запросом с несуществующим хостом и фильтрует по нему).
export const FFUF_WORDLISTS: Record<string, string> = {
  common: "/usr/share/seclists/Discovery/Web-Content/common.txt",
  big: "/usr/share/seclists/Discovery/Web-Content/big.txt",
  "raft-medium": "/usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt",
  api: "/usr/share/seclists/Discovery/Web-Content/common-api-endpoints-mazen160.txt",
};
export type FfufOpts = {
  url: string;
  mode?: "path" | "vhost";
  wordlist?: string;
  extensions?: string;
  headers?: Record<string, string>;
  matchCodes?: string;
  filterSizes?: string;
  threads?: number;
  recursionDepth?: number;
  timeoutSec?: number;
};
export type FfufHit = { url: string; status: number; length: number; words: number; redirect: string; input: string };
export type FfufResult = {
  ok: boolean; error?: string;
  url: string; mode: "path" | "vhost";
  hits: FfufHit[]; outPath: string;
  baselineSize: number | null;
  timedOut: boolean; exitCode: number; secs: number;
};

const intIn = (v: unknown, lo: number, hi: number, def: number) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
};

export function validateFfufOpts(o: FfufOpts): string | null {
  let u: URL;
  try { u = new URL(o.url); } catch { return "url должен быть полным, например http://machine.htb/FUZZ"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "только http/https";
  if (/[\s'"`$\\]/.test(o.url)) return "url: без пробелов, кавычек и shell-спецсимволов";
  if ((o.mode ?? "path") === "vhost") {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return "для режима vhost нужен домен в URL, не IP (Host будет FUZZ.домен)";
    if (o.url.includes("FUZZ")) return "в режиме vhost FUZZ в URL не нужен — он уйдёт в заголовок Host";
  }
  if (o.wordlist !== undefined && !FFUF_WORDLISTS[o.wordlist] && !(/^\/(usr\/share\/seclists|work)\/[A-Za-z0-9._/-]+$/.test(o.wordlist) && !o.wordlist.includes("..")))
    return `wordlist: пресет (${Object.keys(FFUF_WORDLISTS).join(", ")}) или путь в /usr/share/seclists/ либо /work/`;
  if (o.extensions !== undefined && !/^(\.[a-z0-9]+)(,\.[a-z0-9]+)*$/i.test(o.extensions)) return "extensions: вид .php,.bak";
  if (o.matchCodes !== undefined && !/^\d{3}(,\d{3})*$/.test(o.matchCodes)) return "match_codes: вид 200,301,403";
  if (o.filterSizes !== undefined && !/^\d+(,\d+)*$/.test(o.filterSizes)) return "filter_sizes: размеры через запятую";
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) return `заголовок ${k}: недопустимое имя`;
    if (/[\n\r]/.test(v)) return `заголовок ${k}: без переносов строк`;
  }
  return null;
}

export async function runFfuf(taskId: string, o: FfufOpts, signal?: AbortSignal): Promise<FfufResult> {
  const mode = o.mode ?? "path";
  const u = new URL(o.url);
  let url = o.url;
  if (mode === "path" && !url.includes("FUZZ")) url = url.endsWith("/") ? `${url}FUZZ` : `${url}/FUZZ`;
  const wordlist = FFUF_WORDLISTS[o.wordlist ?? "common"] ?? o.wordlist!;
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${crypto.randomBytes(3).toString("hex")}`;
  const outRel = `scans/ffuf-${stamp}.json`;
  const outPath = `/work/${outRel}`;
  const timeout = intIn(o.timeoutSec, 30, 900, 300);

  // vhost: базовый размер ответа на несуществующий хост — по нему фильтруем «все ответы одинаковые».
  let baselineSize: number | null = null;
  if (mode === "vhost") {
    const probe = await sandbox.execCollect(taskId, `curl -s -o /dev/null -w '%{size_download}' --max-time 10 -H ${sandbox.shq(`Host: wh-nonexist-${crypto.randomBytes(4).toString("hex")}.${u.hostname}`)} ${sandbox.shq(url)}`, 20).catch(() => null);
    const n = Math.trunc(Number((probe?.output ?? "").trim().split(/\s+/).at(-1)));
    if (Number.isFinite(n) && n > 0) baselineSize = n;
  }

  const args: string[] = [
    `-u ${sandbox.shq(url)}`, `-w ${wordlist}`, `-of json`, `-o ${outPath}`,
    `-mc ${o.matchCodes ?? "200,301,302,307,401,403"}`, `-t ${intIn(o.threads, 1, 200, 40)}`, `-timeout 10`, `-noninteractive`,
  ];
  if (o.extensions) args.push(`-e ${o.extensions}`);
  const fsizes = [o.filterSizes, baselineSize ? String(baselineSize) : ""].filter(Boolean).join(",");
  if (fsizes) args.push(`-fs ${fsizes}`);
  if (mode === "vhost") args.push(`-H ${sandbox.shq(`Host: FUZZ.${u.hostname}`)}`);
  for (const [k, v] of Object.entries(o.headers ?? {})) args.push(`-H ${sandbox.shq(`${k}: ${v}`)}`);
  const rec = intIn(o.recursionDepth, 0, 3, 0);
  if (rec > 0 && mode === "path") args.push(`-recursion -recursion-depth ${rec}`);

  const r = await sandbox.runAgentCommand(taskId, `mkdir -p /work/scans && ffuf ${args.join(" ")}`, timeout, signal);
  const base: FfufResult = { ok: false, url, mode, hits: [], outPath, baselineSize, timedOut: r.timedOut, exitCode: r.exitCode, secs: r.secs };
  if (r.aborted) return { ...base, error: "остановлено пользователем" };

  let hits: FfufHit[] = [];
  try {
    const raw = fs.readFileSync(path.join(paths.taskWork(taskId), outRel), "utf8");
    const data = JSON.parse(raw) as { results?: any[] };
    hits = (data.results ?? []).map((x) => ({
      url: String(x.url ?? ""), status: Number(x.status ?? 0), length: Number(x.length ?? 0),
      words: Number(x.words ?? 0), redirect: String(x.redirectlocation ?? ""), input: String(x.input?.FUZZ ?? ""),
    })).filter((h) => h.url).sort((a, b) => a.status - b.status || a.url.localeCompare(b.url));
  } catch {
    return { ...base, error: r.timedOut ? `ffuf не уложился в ${timeout} с, JSON не готов` : `ffuf завершился с exit ${r.exitCode} без JSON — сырой вывод в терминале агента` };
  }
  return { ...base, ok: true, hits };
}

export function formatFfuf(r: FfufResult): string {
  if (!r.ok) return `ошибка: ${r.error ?? "ffuf не отработал"}`;
  const lines: string[] = [];
  const baseNote = r.mode === "vhost" ? ` (vhost${r.baselineSize ? `, базовый размер ${r.baselineSize} отфильтрован` : ""})` : "";
  lines.push(`ffuf_scan: ${r.url}${baseNote} — находок: ${r.hits.length} (${r.secs} с)`);
  const shown = r.hits.slice(0, 40);
  for (const h of shown)
    lines.push(`- ${h.status} ${r.mode === "vhost" && h.input ? `${h.input} (${h.url})` : h.url} (размер ${h.length}, слов ${h.words})${h.redirect ? ` -> ${h.redirect}` : ""}`);
  if (r.hits.length > shown.length) lines.push(`... и ещё ${r.hits.length - shown.length} — все в файле ${r.outPath}`);
  if (!r.hits.length) lines.push("ничего не нашлось: попробуй другой словарь (big, raft-medium или свой), расширения (-extensions) или проверь, что цель отвечает на базовый запрос");
  if (r.timedOut) lines.push("[прервано по таймауту — результат частичный]");
  lines.push(`файл: ${r.outPath}`);
  return lines.join("\n");
}
