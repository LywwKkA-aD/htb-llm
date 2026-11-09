// Граф агента (LangGraph):
//   recall -> agent <-> tools -> propose -> compact -> END
// recall  — релевантные фрагменты лекций (+ карточки памяти, если вся память не влезла в системный промпт);
//           подклеиваются к ПОСЛЕДНЕМУ сообщению, чтобы начало промпта не менялось и кэш llama-server работал.
// agent   — Qwen с инструментами; поток токенов/размышлений уходит в интерфейс.
// tools   — исполнение; shell транслируется в терминал агента.
// propose — 0..3 карточки памяти «на подтверждение».
// compact — если контекст перерос порог, старые ходы сворачиваются в резюме чата и удаляются из состояния.
import { StateGraph, Annotation, START, END, REMOVE_ALL_MESSAGES, messagesStateReducer, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { AIMessage, HumanMessage, ToolMessage, RemoveMessage, isAIMessage, isHumanMessage, isToolMessage, type BaseMessage } from "@langchain/core/messages";
import { nanoid } from "nanoid";
import Database from "better-sqlite3";
import { cfg, paths, type AgentMode } from "./config.ts";
import { getSettings, llmCompactAt, llmCtxWindow, subagentsAvailable } from "./settings.ts";
import { SPAWN_TOOL, runSubagent } from "./subagent.ts";
import { db, now, type Task, type Chat } from "./db.ts";
import { chat as llm, approxTokens, clip, type OAMsg, type OAToolCall, type Effort } from "./llm.ts";
import { TOOLS, runTool } from "./tools.ts";
import * as library from "./library.ts";
import * as memory from "./memory.ts";
import * as sandbox from "./sandbox.ts";
import { systemPrompt, PROPOSE_PROMPT, SUMMARY_PROMPT } from "./prompts.ts";
import { looksLikeWriteup, taskNameTokens, userAskedSpoilers } from "./spoilers.ts";
import { formatPlan, listPlan } from "./plan.ts";
import { formatProfile, listProfile, profileLabel } from "./profile.ts";

export type Emit = (ev: Record<string, unknown>) => void;
type Run = { emit: Emit; signal: AbortSignal; effort: Effort; mode: AgentMode; taskId: string; chatId: string };
const runs = new Map<string, Run>(); // в checkpoint уходит только run_id (строка), функции живут здесь

const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  turnContext: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }), // устарело: контекст хода теперь живёт в additional_kwargs сообщения
  promptTokens: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  toolRounds: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  actionRounds: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }), // выполненных раундов действий (без справок/поиска и заблокированных)
  repeats: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }), // повторных вызовов за ход (защита от зацикливания)
  stuckRounds: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }), // раундов действий подряд без новых фактов (советник при застревании)
  stuckAdvised: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }), // сколько раз советник уже срабатывал в этом ходе
  stopped: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  // снимок памяти задачи для системного промпта этого чата: делается на первом ходе и обновляется при сворачивании
  memSnap: Annotation<memory.MemSnap | null>({ reducer: (_a, b) => b, default: () => null }),
});
type S = typeof State.State;

const runOf = (config: LangGraphRunnableConfig) => {
  const r = runs.get(config.configurable?.run_id as string);
  if (!r) throw new Error("контекст запуска потерян");
  return r;
};
export const getTask = (id: string) => db.prepare("select * from tasks where id=?").get(id) as Task;
export const getChat = (id: string) => db.prepare("select * from chats where id=?").get(id) as Chat | undefined;
export function log(chatId: string, kind: string, data: unknown) {
  db.prepare("insert into chat_log(chat_id,kind,data,created_at) values(?,?,?,?)").run(chatId, kind, JSON.stringify(data), now());
}

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (p?.type === "text" ? p.text : p?.type === "image_url" ? "[изображение]" : "")).join("\n") : "";
const lastIndex = <T>(a: T[], f: (x: T) => boolean) => { for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return i; return -1; };
const safeJson = (s: string) => { try { return s ? JSON.parse(s) : {}; } catch { return { _raw: s }; } };
// подпись вызова: имя + аргументы с отсортированными ключами
const callSig = (name: string, args: unknown) =>
  name + ":" + JSON.stringify(args ?? {}, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

type ToolCallLike = { id?: string; name: string; args?: any };
const REFERENCE_TOOLS = new Set(["search_docs", "search_memory", "web_search", "web_fetch", "read_rfc", "subnet_calc", "user_history", "job_list", "job_output", "plan_update", "profile_update"]);
// «Рабочие» инструменты для советника при застревании: шире, чем действия guided-бюджета, —
// read-only shell и поллинг job_output тоже могут крутиться раундами без новых фактов.
const WORK_TOOLS = new Set(["shell", "http_request", "tcp_probe", "nmap_scan", "ffuf_scan", "sqlmap_scan", "job_start", "job_input", "job_output"]);
// Специализированные CLI, где угаданный синтаксис особенно вреден. Базовые Unix-утилиты сюда не входят:
// их карточки есть в базе, но жёсткий гейт на каждый ls/cat превратил бы инструмент в бюрократию.
const SPECIALIZED_COMMANDS = new Set([
  "searchsploit", "ffuf", "feroxbuster", "gobuster", "dirsearch", "wfuzz", "sqlmap", "commix", "nikto", "nuclei",
  "whatweb", "wpscan", "rustscan", "masscan", "autorecon", "dnsrecon", "dnsenum", "subfinder", "httpx", "httpx-toolkit",
  "sslscan", "onesixtyone", "snmp-check", "snmpcheck", "nxc", "netexec", "enum4linux-ng", "smbmap", "ldapdomaindump", "katana",
  "certipy-ad", "bloodhound-python", "bloodyad", "evil-winrm", "responder", "coercer", "kerbrute", "hydra", "medusa", "john",
  "hashcat", "hashid", "cewl", "crunch", "msfconsole", "msfvenom", "jwt_tool", "penelope", "chisel", "ligolo-proxy",
]);
const TOOL_ALIASES: Record<string, string[]> = {
  nxc: ["nxc", "netexec"], netexec: ["netexec", "nxc"],
  "certipy-ad": ["certipy-ad", "certipy"], "bloodhound-python": ["bloodhound-python", "bloodhound.py", "bloodhound"],
  "enum4linux-ng": ["enum4linux-ng", "enum4linux"], nmap: ["nmap", "nse"],
  "ligolo-proxy": ["ligolo-proxy", "ligolo-ng", "ligolo"],
};
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const queryMentionsTool = (query: string, key: string) => {
  // по целым токенам, не подстрокой: иначе «response» засчитал бы алиас nse, а «johnny» — john
  const toks = new Set((query.toLowerCase().match(/[a-z0-9]+(?:[-_.][a-z0-9]+)*/g) ?? []).map(normKey));
  return (TOOL_ALIASES[key] ?? [key]).some((a) => toks.has(normKey(a)));
};
function mentionedToolKeys(query: string): string[] {
  const out = new Set<string>();
  for (const key of [...SPECIALIZED_COMMANDS, "nmap"]) if (queryMentionsTool(query, key)) out.add(key);
  for (const m of query.toLowerCase().matchAll(/impacket-[a-z0-9]+/g)) out.add(m[0]);
  return [...out];
}

type ShellSegment = { exe: string; tokens: string[] };
const shellTokens = (seg: string) => [...seg.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
function parseShell(command: string): ShellSegment[] {
  return command.split(/\n|&&|\|\||;|\|/).map((raw) => {
    const tokens = shellTokens(raw.trim());
    let i = 0;
    const skipAssignments = () => { while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i++; };
    skipAssignments();
    while (["sudo", "command", "env", "nice", "stdbuf"].includes((tokens[i] ?? "").toLowerCase())) {
      const wrapper = (tokens[i] ?? "").toLowerCase(); i++; skipAssignments();
      if (wrapper === "stdbuf") while ((tokens[i] ?? "").startsWith("-")) i++;
    }
    if ((tokens[i] ?? "").toLowerCase() === "timeout") {
      i++;
      while (/^-|^\d+(?:\.\d+)?[smhd]?$/.test(tokens[i] ?? "")) i++;
    }
    const exe = (tokens[i] ?? "").split("/").filter(Boolean).at(-1)?.toLowerCase() ?? "";
    return { exe, tokens: tokens.slice(i) };
  }).filter((s) => s.exe);
}
const segmentIsHelp = (seg: ShellSegment) => {
  const rest = seg.tokens.slice(1);
  // -h последним токеном — справка (в т.ч. подкоманды: certipy-ad find -h); nikto -h <хост> справкой не является
  return rest.includes("--help") || rest.some((t) => t.startsWith("--script-help")) || rest[0] === "help" || rest.at(-1) === "-h"
    || (rest.length === 1 && ["-V", "--version", "-version"].includes(rest[0]));
};
function canonicalSpecialized(seg: ShellSegment, _forHelp = false): string | null {
  const exe = seg.exe;
  if (exe.startsWith("impacket-")) return exe;
  if (exe === "nmap") return "nmap";
  if (exe === "certipy") return "certipy-ad";
  if (exe === "bloodhound.py") return "bloodhound-python";
  if (/^(linpeas|winpeas|pspy|linux-exploit-suggester)/.test(exe)) return exe.replace(/\.(sh|bat|exe)$/, "");
  return SPECIALIZED_COMMANDS.has(exe) ? exe : null;
}
function shellHelpKeys(command: string): string[] {
  const out = new Set<string>();
  for (const seg of parseShell(command)) {
    if (seg.exe === "man") {
      const target = seg.tokens.slice(1).find((t) => !t.startsWith("-"))?.split("/").filter(Boolean).at(-1)?.toLowerCase();
      if (target) { const key = canonicalSpecialized({ exe: target, tokens: [target] }, true); if (key) out.add(key); }
    } else if (segmentIsHelp(seg)) {
      const key = canonicalSpecialized(seg, true); if (key) out.add(key);
    }
  }
  return [...out];
}
function shellActionKeys(command: string): string[] {
  const out = new Set<string>();
  for (const seg of parseShell(command)) {
    if (seg.exe === "man" || segmentIsHelp(seg)) continue;
    const key = canonicalSpecialized(seg); if (key) out.add(key);
  }
  return [...out];
}
const READONLY_SHELL_COMMANDS = new Set([
  "test", "[", "which", "type", "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "stat", "file",
  "du", "df", "pwd", "echo", "printf", "true", "false", "id", "whoami", "hostname", "uname", "date", "printenv",
]);
// Локальная проверка/чтение не должна съедать бюджет этапа: в живых чатах ход обрывался на `test -f словаря`
// прямо перед самим ffuf и на `cat` файла вывода. Запись в файл и подстановки команд сюда не входят.
function isReadOnlyShell(command: string) {
  if (/(?:^|\s)(?:\d*>>?)\s*(?!\/dev\/null\b|&)/.test(command)) return false;
  if (/`|\$\((?!\()/.test(command)) return false;
  const segs = parseShell(command);
  return segs.length > 0 && segs.every((s) => READONLY_SHELL_COMMANDS.has(s.exe));
}
const isReferenceCall = (tc: ToolCallLike) => REFERENCE_TOOLS.has(tc.name)
  || (tc.name === "shell" && (isReadOnlyShell(String(tc.args?.command ?? ""))
    || (shellActionKeys(String(tc.args?.command ?? "")).length === 0 && shellHelpKeys(String(tc.args?.command ?? "")).length > 0)));
const outputBody = (o: string) => o.replace(/^\[(?:exit|таймаут|прервано)[^\]]*\]\s*/i, "").trim();
function isNoProgressOutput(o: string) {
  const b = outputBody(o);
  if (!b || b === "(пустой вывод)") return true;
  if (/^\[exit [1-9]\d*/.test(o) || o.startsWith("[таймаут") || o.startsWith("[прервано")) return true;
  const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
  const onlyNoResults = lines.length > 0 && lines.every((l) => /^(?:Exploits|Shellcodes): No Results$/i.test(l));
  return onlyNoResults || /^(ничего не найдено|в подтверждённой памяти ничего нет|ошибка[: ]|ошибка инструмента|\[нужна сверка|\[повтор)/i.test(b);
}
const isSkippedOutput = (o: string) => /^\[(?:повтор|нужна сверка|спойлер)/.test(outputBody(o));
const isTimeoutOutput = (o: string) => o.startsWith("[таймаут");
// Политика спойлеров: URL готовых решений в shell/job_start — обход web-фильтра curl-ом, блокируется так же.
const spoilerUrlInCommand = (command: string, taskNames: string[]): string | null => {
  for (const m of command.matchAll(/https?:\/\/[^\s'"<>\\]+/gi)) if (looksLikeWriteup(m[0], taskNames)) return m[0];
  return null;
};
// Справка многих утилит печатается с ненулевым кодом (searchsploit --help → exit 2): сверка засчитывается
// по наличию содержательного текста, а не по exit 0. Пустой поиск и ошибки инструмента сверкой не считаются.
const hasCheckOutput = (o: string) => {
  const b = outputBody(o);
  return b.length >= 20 && !isSkippedOutput(o) && !/^(ничего не найдено|в подтверждённой памяти ничего нет|ошибка[: ]|ошибка инструмента)/i.test(b);
};
const normalizeOutput = (o: string) => outputBody(o).toLowerCase().replace(/\s+/g, " ").trim();
// Сигнатура вывода для «это уже видели»: без времён/дат/длительностей, чтобы повторный отказ с новым
// Date-заголовком не выглядел новым фактом для советника при застревании.
const outSig = (o: string) => normalizeOutput(o)
  .replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, "")
  .replace(/· [\d.]+ с\b/g, "")
  .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
  .slice(0, 2000);
// Флаг в выводе инструмента (п.19 плана): отдельная строка из 32 hex — формат HTB-флагов. Контекст
// обязателен, чтобы md5 из листингов не шумел: команда/URL про user.txt|root.txt либо вывод job
// (туда флаг приносит cat внутри пойманного шелла, а md5sum печатает имя файла рядом с хэшем).
const FLAG_LINE_RE = /^[ \t]*([0-9a-f]{32})[ \t]*$/m;
function flagEvidence(tc: ToolCallLike, res: string): { which: "user" | "root" | "flag"; hash: string } | null {
  if (process.env.WH_FLAG_RECIPE === "off") return null;
  const m = FLAG_LINE_RE.exec(res);
  if (!m) return null;
  const ctxText = tc.name === "shell" ? String(tc.args?.command ?? "")
    : tc.name === "http_request" ? String(tc.args?.url ?? "")
    : tc.name === "job_input" ? String(tc.args?.text ?? "") : "";
  if (tc.name !== "job_output" && !/(user|root)\.txt/i.test(ctxText)) return null;
  const which = /root\.txt/i.test(ctxText) ? "root" : /user\.txt/i.test(ctxText) ? "user" : "flag";
  return { which, hash: m[1] };
}
// Черновик «рецепта захода»: сервер собирает вектор из профиля и ключевые команды хода; карточка
// уходит пользователю на подтверждение как обычное предложение памяти (proposeNode путь не заменяет).
function recipeDraft(taskId: string, which: "user" | "root" | "flag", hash: string, calls: ToolCallLike[]): { title: string; content: string } {
  const title = which === "flag" ? "Рецепт захода (флаг в выводе job)" : `Рецепт захода: ${which}.txt`;
  const prof = listProfile(taskId);
  const lines: string[] = [
    `Сервер заметил флаг${which === "flag" ? "" : ` ${which}.txt`} (${hash}) в выводе инструмента и собрал этот черновик — поправь перед подтверждением: оставь вектор и ключевые команды, убери шум.`,
  ];
  const access = prof.filter((i) => i.kind === "access").map((i) => i.text);
  if (access.length) lines.push(`Доступы из профиля: ${access.join("; ")}`);
  const services = prof.filter((i) => i.kind === "service").map(profileLabel);
  if (services.length) lines.push(`Сервисы цели: ${services.join(", ")}`);
  const cmds: string[] = [];
  for (const c of calls) {
    const s = c.name === "shell" ? String(c.args?.command ?? "")
      : c.name === "http_request" ? `${String(c.args?.method ?? "GET")} ${String(c.args?.url ?? "")}`
      : c.name === "job_input" ? `job_input: ${String(c.args?.text ?? "")}`
      : c.name === "nmap_scan" ? `nmap_scan ${String(c.args?.target ?? "$TARGET")}` : "";
    if (s) cmds.push(s.replace(/\s+/g, " ").trim().slice(0, 160));
  }
  if (cmds.length) lines.push(`Команды этого хода:\n${cmds.slice(-8).map((c) => `- ${c}`).join("\n")}`);
  return { title, content: lines.join("\n") };
}
// Сводка известного для советника: коротко, без секретов (полный профиль и так в контексте хода).
function knownSummary(taskId: string): string {
  const plan = listPlan(taskId);
  const prof = listProfile(taskId);
  const parts: string[] = [];
  if (plan.length) {
    const doing = plan.filter((i) => i.status === "doing").map((i) => `«${i.text}»`).slice(0, 2).join(", ");
    parts.push(`план: готово ${plan.filter((i) => i.status === "done").length} из ${plan.length}${doing ? `; в работе: ${doing}` : ""}`);
  }
  const services = prof.filter((i) => i.kind === "service");
  if (services.length) parts.push(`сервисы: ${services.slice(0, 6).map(profileLabel).join(", ")}${services.length > 6 ? " и др." : ""}`);
  const creds = prof.filter((i) => i.kind === "cred");
  if (creds.length) parts.push(`креды: ${creds.slice(0, 4).map((c) => `${c.service || "?"}/${c.username || "?"}`).join(", ")}`);
  const access = prof.filter((i) => i.kind === "access");
  if (access.length) parts.push(`доступы: ${access.length} (${access[0].text.slice(0, 80)})`);
  return parts.length ? parts.join("; ") : "план и профиль пусты — сначала зафиксируй уже известное через plan_update/profile_update";
}
function checkedToolsFromHistory(messages: BaseMessage[]): Set<string> {
  const checked = new Set<string>();
  const byId = new Map<string, { checkKeys: string[]; actionKeys: string[] }>();
  for (const m of messages) {
    if (isAIMessage(m)) {
      for (const tc of (m.tool_calls ?? []) as ToolCallLike[]) {
        if (!tc.id) continue;
        let checkKeys: string[] = [], actionKeys: string[] = [];
        if (tc.name === "search_docs" || tc.name === "search_memory" || tc.name === "web_search") checkKeys = mentionedToolKeys(String(tc.args?.query ?? ""));
        else if (tc.name === "shell" || tc.name === "job_start") {
          const cmd = String(tc.args?.command ?? "");
          if (tc.name === "shell") checkKeys = shellHelpKeys(cmd);
          actionKeys = shellActionKeys(cmd);
        }
        byId.set(tc.id, { checkKeys, actionKeys });
      }
    } else if (isToolMessage(m)) {
      const info = byId.get(m.tool_call_id); if (!info) continue;
      const out = textOf(m.content);
      if (hasCheckOutput(out)) for (const k of info.checkKeys) checked.add(k);
      // таймаут сверку НЕ сжигает: команда была принята и работала, умерла сеть/цель, а не синтаксис.
      // В плохой сети HTB иначе каждый второй скан уходил в круг поиск -> блок -> поиск (29 эпизодов в логах).
      if (isNoProgressOutput(out) && !isTimeoutOutput(out)) for (const k of info.actionKeys) checked.delete(k);
    }
  }
  return checked;
}
const searchWords = (tc: ToolCallLike) => new Set((String(tc.args?.query ?? "").toLowerCase().match(/[\p{L}\p{N}.+-]{2,}/gu) ?? []));
function coarseCallSig(tc: ToolCallLike): string {
  if (tc.name === "search_docs" || tc.name === "search_memory" || tc.name === "web_search") return `${tc.name}:words:${[...searchWords(tc)].sort().join(" ")}`;
  if (tc.name !== "shell") return callSig(tc.name, tc.args);
  const command = String(tc.args?.command ?? "");
  const noQuery = command.replace(/(https?:\/\/[^\s'"<>]+?)\?[^\s'"<>]*/gi, "$1");
  const seg = parseShell(noQuery)[0];
  if (!seg) return callSig(tc.name, tc.args);
  let url = "";
  const um = noQuery.match(/https?:\/\/[^\s'"<>]+/i)?.[0];
  if (um) { try { const u = new URL(um); url = u.origin + u.pathname; } catch { url = um; } }
  const salient = [...new Set(seg.tokens.slice(1).map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3 && !t.startsWith("-") && !/^(?:2>&1|1>&2|>\/dev\/null|2>\/dev\/null)$/.test(t)))].sort();
  return `shell:${seg.exe}:${url}:${salient.join(" ")}`;
}
function sameCoarse(a: ToolCallLike, b: ToolCallLike) {
  if (a.name !== b.name) return false;
  if (a.name === "search_docs" || a.name === "search_memory" || a.name === "web_search") {
    const aw = searchWords(a), bw = searchWords(b);
    if (!aw.size || !bw.size) return false;
    const inter = [...aw].filter((w) => bw.has(w)).length;
    return inter / new Set([...aw, ...bw]).size >= 0.6 || inter === Math.min(aw.size, bw.size);
  }
  return coarseCallSig(a) === coarseCallSig(b);
}
// Qwen без инструментов иногда пишет вызов текстом — пользователю это не нужно
const stripToolMarkup = (s: string) =>
  s.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").replace(/<tool_call>[\s\S]*$/, "").replace(/<function=[\w.-]+>[\s\S]*?<\/function>/g, "").replace(/\n{3,}/g, "\n\n").trimEnd();

// Результат вызова инструмента, который так и не выполнился до конца: процесс сервера упал/был остановлен
// между «модель вызвала инструмент» и «результат записан». Без него в контексте остаётся assistant.tool_calls
// без ответа role=tool: строгие OpenAI-совместимые серверы отвечают 400, Qwen выдумывает вывод.
const INTERRUPTED = "(прервано: ход оборвался до результата — сервер был остановлен или перезапущен; выполнилась ли команда и что она вывела, неизвестно)";

// LangChain-сообщения -> формат OpenAI для llama-server
// Контекст хода (фрагменты лекций, карточки памяти) хранится в самом сообщении пользователя (additional_kwargs.turn_context)
// и отправляется с ним на КАЖДОМ ходе в одном и том же виде. Если бы он исчезал из старых сообщений, промпт менялся бы
// в середине, и llama-server пересчитывал бы всё заново (у гибридной Qwen3.8 кэш продолжается только с контрольной точки):
// замер — 4.5K токенов, 5.7 с до первого токена на каждом ходе.
function toOA(messages: BaseMessage[]): OAMsg[] {
  const lastHuman = lastIndex(messages, isHumanMessage);
  const out: OAMsg[] = [];
  // страховка: у каждого tool_call должен быть ответ сразу после сообщения ассистента (состояние чинит runTurn)
  let open: OAToolCall[] = [];
  const flush = () => { for (const t of open) out.push({ role: "tool", tool_call_id: t.id, content: INTERRUPTED }); open = []; };
  messages.forEach((m, i) => {
    if (!isToolMessage(m)) flush();
    if (isHumanMessage(m)) {
      const ctx = m.additional_kwargs?.turn_context;
      const extra = typeof ctx === "string" && ctx ? `\n\n<контекст_хода>\n${ctx}\n</контекст_хода>` : "";
      if (typeof m.content === "string") { out.push({ role: "user", content: m.content + extra }); return; }
      // картинки отправляем только в текущем ходе — старые заменяются пометкой (каждая стоит ~1000+ токенов)
      type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
      const parts: Part[] = [];
      for (const p of m.content as any[]) {
        if (p?.type === "text") parts.push({ type: "text", text: String(p.text) });
        else if (p?.type === "image_url") {
          if (i === lastHuman) parts.push({ type: "image_url", image_url: { url: String(p.image_url?.url ?? p.image_url) } });
          else parts.push({ type: "text", text: "[изображение из прошлого хода]" });
        }
      }
      if (extra) parts.push({ type: "text", text: extra });
      out.push({ role: "user", content: parts });
    } else if (isAIMessage(m)) {
      const tc: OAToolCall[] = (m.tool_calls ?? []).map((t) => ({ id: t.id!, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } }));
      // размышления нужны модели только внутри текущей цепочки инструментов
      const rc = m.additional_kwargs?.reasoning_content;
      out.push({
        role: "assistant",
        content: textOf(m.content) || (tc.length ? null : ""),
        ...(tc.length ? { tool_calls: tc } : {}),
        ...(i > lastHuman && typeof rc === "string" && rc ? { reasoning_content: rc } : {}),
      });
      open = tc;
    } else if (isToolMessage(m)) {
      open = open.filter((t) => t.id !== m.tool_call_id);
      out.push({ role: "tool", tool_call_id: m.tool_call_id, content: textOf(m.content) });
    }
  });
  flush();
  return out;
}

function transcript(msgs: BaseMessage[], limits = { user: 1500, ai: 2500, tool: 400 }) {
  return msgs.map((m) => {
    if (isHumanMessage(m)) return `ПОЛЬЗОВАТЕЛЬ: ${clip(textOf(m.content), limits.user)}`;
    if (isAIMessage(m)) {
      const calls = (m.tool_calls ?? []).map((t) => `  → ${t.name}(${clip(JSON.stringify(t.args ?? {}), 300)})`).join("\n");
      const c = textOf(m.content).trim();
      return `АССИСТЕНТ: ${c ? clip(c, limits.ai) : "(вызов инструментов)"}${calls ? "\n" + calls : ""}`;
    }
    if (isToolMessage(m)) return `  ← ${clip(textOf(m.content), limits.tool)}`;
    return "";
  }).filter(Boolean).join("\n");
}

// ---------- узлы ----------
async function recallNode(state: S, config: LangGraphRunnableConfig) {
  const run = runOf(config);
  const reset: Partial<S> = { turnContext: "", toolRounds: 0, actionRounds: 0, repeats: 0, stuckRounds: 0, stuckAdvised: 0, stopped: false };
  const parts: string[] = [];
  // память: в системном промпте — снимок с начала чата (стабильный префикс = кэш llama-server),
  // а то, что подтвердили, поправили или удалили после, — здесь, в контексте этого хода
  let snap = state.memSnap;
  if (!snap) reset.memSnap = snap = memory.snapshot(run.taskId);
  else {
    const d = memory.delta(run.taskId, snap);
    if (d.text) { parts.push(d.text); reset.memSnap = { ...snap, seen: d.seen }; }
  }
  const li = lastIndex(state.messages, isHumanMessage);
  const last = state.messages[li];
  const q = last ? textOf(last.content).trim() : "";
  const sources: { doc: string; page: number }[] = [];
  if (q && !snap.full) {
    const rel = await memory.recall(run.taskId, q).catch(() => "");
    if (rel) parts.push(`Релевантные карточки памяти задачи:\n${rel}`);
  }
  // фрагменты, уже показанные в этом чате, остаются в его истории — второй раз не подклеиваем
  const shown = new Set<number>();
  for (const m of state.messages) if (isHumanMessage(m)) for (const id of (m.additional_kwargs?.recall_ids as number[] | undefined) ?? []) shown.add(id);
  const ids: number[] = [];
  const hasDocs = q && db.prepare("select 1 from docs where status='ready' and (task_id is null or task_id=?) limit 1").get(run.taskId);
  if (hasDocs && cfg.recallDocChunks > 0) {
    const hits = (await library.search(q, run.taskId, cfg.recallDocChunks).catch(() => []))
      .filter((h) => h.sim >= cfg.recallMinSim && !shown.has(h.id)); // ниже порога — шум, который только съедает контекст
    if (hits.length) {
      parts.push("Возможно полезные фрагменты материалов курса (проверь релевантность; больше — search_docs):\n" + hits.map(library.fmtHit).join("\n---\n"));
      sources.push(...hits.map((h) => ({ doc: h.doc, page: h.page })));
      ids.push(...hits.map((h) => h.id));
    }
  }
  // VPN внутри контейнера: агент должен знать адрес для обратных соединений именно на этом ходе
  // (в системном промпте его нет — адрес меняется при переподключении, а префикс дорог из-за кэша).
  const taskRow = getTask(run.taskId);
  if (taskRow.target)
    parts.push(`Цель задачи: $TARGET=${taskRow.target}${taskRow.hostname ? `, $TARGET_HOST=${taskRow.hostname} (прописан в /etc/hosts контейнера, плюс алиас machine.htb)` : ""}. Используй $TARGET/$TARGET_HOST в командах вместо хардкода IP из брифа.`);
  const vpn = await sandbox.vpnStatusCached(run.taskId).catch(() => null);
  if (vpn?.state === "up" && vpn.ip)
    parts.push(`VPN внутри контейнера поднят: интерфейс ${vpn.iface ?? "tun0"}, адрес ${vpn.ip} (он же $LHOST в shell). Обратные соединения от целей из VPN (reverse shell на nc -lvnp, скачивание с python3 -m http.server, impacket-smbserver) направляй на ${vpn.ip}:<порт> — порт любой, листенер в контейнере слушает на 0.0.0.0.`);
  // План решения задачи: общая карта у модели и пользователя; без подклейки модель теряет нить между чатами.
  const planItems = listPlan(run.taskId);
  if (planItems.length) parts.push(`План решения задачи (ведёшь через plan_update; план — не разрешение выходить за порученный этап):\n${formatPlan(planItems)}`);
  // Профиль цели: уже найденные сервисы, креды и доступы — чтобы не пересканировать и не терять между чатами.
  const profileItems = listProfile(run.taskId);
  if (profileItems.length) parts.push(`Профиль цели (ведёшь через profile_update; если новый вывод противоречит записи — обнови её):\n${formatProfile(profileItems)}`);
  // Команды самого пользователя в ЕГО терминале: модель почти никогда не зовёт user_history сама (0 вызовов
  // в реальных чатах), а работа между ходами теряется. Последние свежие команды — прямо в контекст хода.
  const myCmds = (await sandbox.userHistory(run.taskId, 6).catch(() => []))
    .filter((x) => x.ts === null || Date.now() - x.ts < 60 * 60 * 1000);
  if (myCmds.length)
    parts.push("Пользователь недавно сам вводил в своём терминале (последние команды; вывод и контекст — user_history, если понадобится):\n" + myCmds.map((x) => `$ ${x.cmd}`).join("\n"));
  if (sources.length) run.emit({ type: "recall", sources });
  if (!parts.length || !last) return reset;
  const upd = new HumanMessage({ id: last.id, content: last.content as any, additional_kwargs: { ...last.additional_kwargs, turn_context: parts.join("\n\n"), recall_ids: ids } });
  return { ...reset, messages: [upd] };
}

async function agentNode(state: S, config: LangGraphRunnableConfig) {
  const run = runOf(config);
  const task = getTask(run.taskId);
  const chat = getChat(run.chatId)!;
  const subOn = subagentsAvailable();
  const sys = systemPrompt(task, (state.memSnap ?? memory.snapshot(run.taskId)).text, chat.summary, run.mode, subOn);
  const guidedLimitHit = run.mode === "guided" && state.actionRounds >= cfg.guidedToolRounds;
  const limitHit = guidedLimitHit || state.toolRounds >= cfg.maxToolRounds;
  const loopHit = state.repeats >= cfg.maxRepeats;
  // сворачивание работает только между ходами; внутри длинной цепочки инструментов контекст может дорасти до окна
  const fullHit = state.toolRounds > 0 && state.promptTokens > llmCtxWindow() * 0.75;
  const allowTools = !limitHit && !loopHit && !fullHit;
  const msgs: OAMsg[] = [{ role: "system", content: sys }, ...toOA(state.messages)];
  if (!allowTools) {
    // инструменты сняты — прямо говорим модели, иначе она пишет <tool_call> текстом или снова «вызывает» то же самое
    const reason = loopHit ? "Ты несколько раз подряд повторил одни и те же вызовы инструментов"
      : fullHit ? "Контекст почти заполнен"
      : guidedLimitHit ? `В управляемом режиме исчерпан лимит действий этого порученного этапа (${cfg.guidedToolRounds} раунда)`
      : `Достигнут лимит: ${cfg.maxToolRounds} раундов инструментов за ход`;
    const tail = guidedLimitHit && !loopHit && !fullHit
      ? "Подведи итог именно по порученному этапу по уже полученным результатам, перечисли находки и неопределённости и предложи следующие шаги, но не начинай их — управление возвращается пользователю. Если этап не завершён, прямо так и скажи («этап не завершён»), где остановился и что осталось сделать."
      : "Дай итоговый ответ по уже полученным результатам (они выше); если данных не хватает — скажи, что ещё нужно проверить.";
    msgs.push({ role: "user", content: `[whitehat] ${reason}. Инструменты на этот ход отключены. Не вызывай их и не пиши <tool_call>. ${tail}` });
  }
  // Советник при застревании: инструменты НЕ снимаем (это не лимит, а пинок сменить ветку) — вставляем
  // эфемерную сводку известного только в этот вызов, как подсказку лимита выше; в историю не пишется.
  const stuckHit = allowTools && cfg.stuckRounds > 0 && state.stuckRounds >= cfg.stuckRounds && state.stuckAdvised < 3 && !run.signal.aborted;
  if (stuckHit) {
    msgs.push({ role: "user", content: `[whitehat] Советник при застревании: несколько раундов подряд действия не дали новых фактов (ошибки, пустые или уже виденные результаты). Известное сейчас: ${knownSummary(run.taskId)}. Не продолжай эту ветку новыми формулировками тех же проверок. Смени подход: другой вектор или поверхность из плана, сверка с базой по сервису/версии (search_docs), иной инструмент — либо подведи итог этапа и спроси пользователя, куда дальше. Что не сработало — зафиксируй в плане (blocked + note), чтобы не ходить по кругу.` });
  }
  run.emit({ type: "assistant_start" });
  const toolList = subOn ? [...TOOLS, SPAWN_TOOL] : TOOLS;
  const r = await llm(msgs, {
    tools: allowTools ? (toolList as unknown as unknown[]) : undefined,
    effort: run.effort,
    signal: run.signal,
    onToken: (t) => run.emit({ type: "token", t }),
    onReasoning: (t) => run.emit({ type: "reasoning", t }),
  });
  const toolCalls = allowTools ? r.toolCalls.map((c) => ({ id: c.id, name: c.function.name, args: safeJson(c.function.arguments), type: "tool_call" as const })) : [];
  const stats = { tps: Number(r.tps.toFixed(1)), promptTokens: r.promptTokens, completionTokens: r.completionTokens, draftAccept: r.draftAccept, finish: r.finish };
  const aborted = r.finish === "aborted";
  const text = stripToolMarkup(r.content);
  // Живая Qwen на границе этапа иногда заканчивает ход одним reasoning без текста: пустое сообщение в ленте
  // выглядит как молчаливый обрыв посреди дела. Честная серверная заглушка лучше пустоты.
  const emptyFinal = !aborted && !toolCalls.length && !text
    ? guidedLimitHit
      ? "Остановился на границе порученного этапа: модель не дала текстовый итог. Результаты выполненных действий — выше в выводах инструментов; напиши «продолжай», если этап нужно довести дальше."
      : loopHit
        ? "Остановился из-за повторяющихся вызовов: модель не дала текстовый итог. Результаты выполненных действий — выше; уточни следующий шаг."
        : fullHit
          ? "Контекст почти заполнен, а модель не дала текстовый итог. Результаты выполненных действий — выше; напиши «продолжай»."
          : "Модель не дала текстовый ответ. Попробуй переформулировать запрос или напиши «продолжай»."
    : "";
  const content = aborted ? `${text}${text ? "\n\n" : ""}_(остановлено)_` : (text || emptyFinal);
  log(run.chatId, "assistant", { content, reasoning: r.reasoning, stats, tool_calls: toolCalls });
  run.emit({ type: "assistant_end", stats, tool_calls: toolCalls, content });
  return {
    messages: [new AIMessage({ content, tool_calls: toolCalls, additional_kwargs: { reasoning_content: r.reasoning } })],
    promptTokens: r.promptTokens + r.completionTokens || state.promptTokens,
    stopped: aborted,
    stuckRounds: stuckHit ? 0 : state.stuckRounds,
    stuckAdvised: state.stuckAdvised + (stuckHit ? 1 : 0),
  };
}

async function toolsNode(state: S, config: LangGraphRunnableConfig) {
  const run = runOf(config);
  const last = state.messages[state.messages.length - 1] as AIMessage;
  const currentCalls = (last.tool_calls ?? []) as ToolCallLike[];
  // Защита от зацикливания. Повтором считается РАУНД без ничего нового:
  //  - его набор вызовов совпадает с прошлым раундом (модель переиздаёт тот же раунд — так залипала Qwen), или
  //  - тот же набор вызовов уже дважды встречался в этом ходе (A → B → A → B → A…), или
  //  - это уже четвёртый семантически тот же вариант (тот же инструмент/цель/путь, поменялся только query/filter),
  //    а предыдущие три дали один и тот же или пустой результат — так Qwen перебирала параметры поиска Exploit-DB.
  // Если в раунде есть хоть один новый вызов, выполняется всё: «ping шлюза, затем снова ip neigh» — законная проверка.
  const turn = state.messages.slice(lastIndex(state.messages, isHumanMessage) + 1, -1);
  type PastCall = { tc: ToolCallLike; output?: string };
  const pastCalls: PastCall[] = [];
  const pastById = new Map<string, PastCall>();
  for (const m of turn) {
    if (isAIMessage(m)) for (const tc of (m.tool_calls ?? []) as ToolCallLike[]) { const rec = { tc }; pastCalls.push(rec); if (tc.id) pastById.set(tc.id, rec); }
    else if (isToolMessage(m)) { const rec = pastById.get(m.tool_call_id); if (rec) rec.output = textOf(m.content); }
  }
  //  Подмножество прошлого раунда — НЕ повтор: «ip neigh; ping» → «ip neigh» покажет новую запись.
  //  В прошлые раунды идут только ВЫПОЛНЕННЫЕ вызовы: заблокированный preflight/повтором вызов не выполнялся,
  //  поэтому та же команда после сверки с инструкцией обязана запуститься, а не получить ложный «уже выполнено».
  const keyOf = (calls: { name: string; args?: unknown }[]) => [...new Set(calls.map((t) => callSig(t.name, t.args)))].sort().join("\n");
  const rounds: string[] = [];
  for (const m of turn) {
    if (!isAIMessage(m) || !m.tool_calls?.length) continue;
    const executed = (m.tool_calls as ToolCallLike[]).filter((tc) => {
      const rec = tc.id ? pastById.get(tc.id) : undefined;
      return !!rec?.output && !isSkippedOutput(rec.output);
    });
    if (executed.length) rounds.push(keyOf(executed));
  }
  const batchKey = keyOf(currentCalls);
  const exactStale = !!batchKey && (rounds.at(-1) === batchKey || rounds.filter((k) => k === batchKey).length >= 2);
  const semanticStaleFor = (tc: ToolCallLike) => {
    const same = pastCalls.filter((p) => p.output && !isSkippedOutput(p.output) && sameCoarse(p.tc, tc));
    if (same.length < 3) return false;
    const outs = same.map((p) => p.output!);
    return new Set(outs.map(normalizeOutput)).size === 1 || outs.every(isNoProgressOutput);
  };
  const staleRound = exactStale || (currentCalls.length > 0 && currentCalls.every(semanticStaleFor));
  const repeats = state.repeats + (staleRound ? 1 : 0);
  // Политика спойлеров: разрешение читать решения даёт только сам пользователь своим сообщением этого хода.
  const humanIdx = lastIndex(state.messages, isHumanMessage);
  const spoilersAllowed = humanIdx >= 0 && userAskedSpoilers(textOf(state.messages[humanIdx].content));
  const task = getTask(run.taskId);
  const taskNames = taskNameTokens(task?.title ?? "", task?.hostname ?? "");
  const checkedTools = checkedToolsFromHistory(state.messages.slice(0, -1));
  const out: ToolMessage[] = [];
  let didAction = false;
  let didWork = false;
  // Советник при застревании: «новый факт» раунда — выполненный вызов с содержательным выводом,
  // которого в этом ходе ещё не было (isNoProgressOutput + сигнатура без времён/дат).
  const seenSigs = new Set(pastCalls.filter((p) => p.output).map((p) => outSig(p.output!)));
  let roundProgress = false;
  // Подагенты: доступность и лимит на ход проверяются здесь же (инструмент мог остаться в списке,
  // пока настройки меняли; модель могла выдумать вызов и без него).
  const agentsCfg = getSettings().agents;
  const subAvailable = subagentsAvailable();
  let spawnsUsed = pastCalls.filter((p) => p.tc.name === "spawn_subagent" && p.output && !isSkippedOutput(p.output)).length;
  for (const tc of currentCalls) {
    let res: string;
    const repeat = staleRound;
    let skipped = false;
    let skipReason: "repeat" | "preflight" | "spoiler" | undefined;
    const actionKeys = tc.name === "shell" || tc.name === "job_start" ? shellActionKeys(String(tc.args?.command ?? "")) : [];
    const missing = actionKeys.filter((k) => !checkedTools.has(k));
    const spoilerUrl = !spoilersAllowed && (tc.name === "shell" || tc.name === "job_start")
      ? spoilerUrlInCommand(String(tc.args?.command ?? ""), taskNames) : null;
    if (run.signal.aborted) res = "(остановлено пользователем)";
    else if (spoilerUrl) {
      skipped = true; skipReason = "spoiler";
      res = `[спойлер — не выполнено] Команда читает готовое решение/writeup (${spoilerUrl}), а пользователь решает сам. Не открывай и не пересказывай решения машин HTB/CTF ни веб-инструментами, ни curl, ни через зеркала и кэши. Скажи пользователю, что нашёлся writeup и ты его не открываешь; откроется, только если он сам прямо попросит («покажи решение»). Продолжай по технике.`;
      run.emit({ type: "tool_start", id: tc.id, name: tc.name, args: tc.args });
      run.emit({ type: "tool_end", id: tc.id, name: tc.name, output: res, ms: 0, skipped: true });
    } else if (repeat) {
      skipped = true; skipReason = "repeat";
      res = `[повтор — не выполнено] Этот же вызов ${tc.name} уже выполнен в этом ходе, и с тех пор ничего не менялось — его результат выше в истории. Не вызывай его снова: опирайся на тот результат, сделай другой шаг или дай итоговый ответ.`;
      run.emit({ type: "tool_start", id: tc.id, name: tc.name, args: tc.args });
      run.emit({ type: "tool_end", id: tc.id, name: tc.name, output: res, ms: 0, skipped: true });
    } else if (missing.length) {
      skipped = true; skipReason = "preflight";
      const labels = missing.join(", ");
      const first = missing[0];
      res = `[нужна сверка с инструкцией — не выполнено] Перед запуском ${labels} сверься: сначала search_docs("${first} использование флаги примеры ошибки"), если деталей мало — shell: ${first} --help или man ${first}. После сверки повтори команду с точным синтаксисом; словарь/файл и имя NSE-скрипта проверь заранее.`;
      run.emit({ type: "tool_start", id: tc.id, name: tc.name, args: tc.args });
      run.emit({ type: "tool_end", id: tc.id, name: tc.name, output: res, ms: 0, skipped: true });
    } else if (tc.name === "spawn_subagent" && (!subAvailable || spawnsUsed >= agentsCfg.maxPerTurn)) {
      skipped = true; skipReason = "repeat";
      res = !subAvailable
        ? "[подагенты недоступны — не выполнено] spawn_subagent работает только на внешнем пресете модели при включённой опции в настройках. Выполни подзадачу сам обычными инструментами."
        : `[лимит подагентов — не выполнено] В этом ходе уже запущено ${spawnsUsed} подагент(ов), лимит ${agentsCfg.maxPerTurn}. Работай с уже полученными сводками или сам.`;
      run.emit({ type: "tool_start", id: tc.id, name: tc.name, args: tc.args });
      run.emit({ type: "tool_end", id: tc.id, name: tc.name, output: res, ms: 0, skipped: true });
    } else {
      run.emit({ type: "tool_start", id: tc.id, name: tc.name, args: tc.args });
      const t0 = Date.now();
      if (tc.name === "spawn_subagent") {
        spawnsUsed++;
        res = await runSubagent(String(tc.args?.task ?? ""), String(tc.args?.label ?? "").slice(0, 80), {
          task: task!, known: knownSummary(run.taskId), maxRounds: agentsCfg.maxRounds,
          effort: run.effort, signal: run.signal, emit: run.emit,
          logTool: (id, name, output) => log(run.chatId, "tool_result", { id, name, output, subagent: true }),
          spoilersAllowed, taskNames,
        });
      } else {
        res = await runTool(tc.name, JSON.stringify(tc.args ?? {}), { taskId: run.taskId, signal: run.signal, emit: run.emit, spoilersAllowed, taskNames });
      }
      run.emit({ type: "tool_end", id: tc.id, name: tc.name, output: res, ms: Date.now() - t0 });
      if (!isReferenceCall(tc)) didAction = true;
      if (WORK_TOOLS.has(tc.name)) didWork = true;
      const sig = outSig(res);
      if (!isNoProgressOutput(res) && !seenSigs.has(sig) && !res.includes("экран без изменений")) roundProgress = true;
      seenSigs.add(sig);
      const flag = flagEvidence(tc, res);
      if (flag) {
        const draft = recipeDraft(run.taskId, flag.which, flag.hash, [...pastCalls.map((p) => p.tc), ...currentCalls]);
        const fresh = memory.dedupe(run.taskId, run.chatId, [{ kind: "result", title: draft.title, content: draft.content }]);
        if (fresh.length) run.emit({ type: "proposals", items: memory.addPending(run.taskId, run.chatId, fresh) });
      }
      if (hasCheckOutput(res)) {
        if (tc.name === "search_docs" || tc.name === "search_memory" || tc.name === "web_search") for (const k of mentionedToolKeys(String(tc.args?.query ?? ""))) checkedTools.add(k);
        if (tc.name === "shell") for (const k of shellHelpKeys(String(tc.args?.command ?? ""))) checkedTools.add(k);
      }
      if (isNoProgressOutput(res) && !isTimeoutOutput(res)) for (const k of actionKeys) checkedTools.delete(k);
    }
    log(run.chatId, "tool_result", { id: tc.id, name: tc.name, output: res, ...(skipped ? { skipped: true, reason: skipReason } : {}) });
    out.push(new ToolMessage({ tool_call_id: tc.id!, content: res, name: tc.name }));
  }
  // Рабочий раунд без прогресса растит счётчик застревания; прогресс (в т.ч. справочный раунд
  // с результатом — ушёл в базу/веб за новой веткой) сбрасывает. Пропущенные раунды не трогаем:
  // повторы и preflight уже ведёт свой счётчик repeats.
  let stuckRounds = state.stuckRounds;
  if (didWork) stuckRounds = roundProgress ? 0 : stuckRounds + 1;
  else if (roundProgress) stuckRounds = 0;
  return { messages: out, toolRounds: state.toolRounds + 1, actionRounds: state.actionRounds + (didAction ? 1 : 0), repeats, stuckRounds, stopped: run.signal.aborted };
}

// JSON-массив из ответа модели. Модель пишет пояснения вокруг JSON, иногда со [скобками] («[общие знания]»),
// оборачивает в ```json или в объект {"cards":[…]}. Поэтому не «от первой [ до последней ]», а сбалансированные
// участки от каждой «[» (скобки внутри строк JSON не считаются); берём первый массив с объектами.
export function parseJsonArray(s: string): any[] {
  let fallback: any[] | null = null;
  for (let a = s.indexOf("["); a >= 0; a = s.indexOf("[", a + 1)) {
    let depth = 0, str = false, esc = false, end = -1;
    for (let i = a; i < s.length; i++) {
      const c = s[i];
      if (str) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') str = true;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") { if (--depth === 0) { end = i; break; } if (depth < 0) break; }
    }
    if (end < 0) continue;
    let v: unknown;
    try { v = JSON.parse(s.slice(a, end + 1)); } catch { continue; }
    if (!Array.isArray(v)) continue;
    if (v.some((x) => x && typeof x === "object" && !Array.isArray(x))) return v;
    fallback ??= v;
  }
  if (!fallback && s.includes("[")) console.warn("[propose] в ответе модели не нашёлся JSON-массив:", clip(s.replace(/\s+/g, " "), 200));
  return fallback ?? [];
}

async function proposeNode(state: S, config: LangGraphRunnableConfig) {
  const run = runOf(config);
  if (run.signal.aborted) return {};
  const turn = state.messages.slice(lastIndex(state.messages, isHumanMessage));
  const finalText = textOf(turn[turn.length - 1]?.content).trim();
  const usedTools = turn.some((m) => isToolMessage(m));
  if (!usedTools && finalText.length < 200) return {}; // болтовня/короткий ответ — нечего сохранять
  try {
    // ход без инструментов обычно — объяснение из учебника: прямо говорим модели, что сохранять тут почти нечего
    const noTools = usedTools ? "" : "\nВ этом ходе инструменты не запускались: сохраняй только конкретику ЭТОЙ задачи, которую сообщил пользователь (адреса, вариант, условия, его вывод), или результат, вычисленный именно для неё. Объяснения и общие знания не сохраняй — скорее всего, ответ [].\n";
    const r = await llm([
      { role: "system", content: PROPOSE_PROMPT },
      { role: "user", content: `Задача: ${getTask(run.taskId).title}\n${memory.proposeContext(run.taskId)}\n${noTools}\nПоследний ход:\n${transcript(turn)}` },
    ], { effort: "off", maxTokens: 900, temperature: 0.3, signal: run.signal });
    if (r.finish === "aborted") return {};
    const valid = parseJsonArray(r.content)
      .filter((x) => x && typeof x.title === "string" && typeof x.content === "string" && x.title.trim() && x.content.trim());
    // повторы уже сохранённого/отклонённого и дубли внутри ответа отсеиваем ДО лимита — иначе они съедают места
    const items = memory.dedupe(run.taskId, run.chatId, valid).slice(0, 3);
    if (items.length) run.emit({ type: "proposals", items: memory.addPending(run.taskId, run.chatId, items) });
  } catch (e) {
    console.warn("[propose]", (e as Error).message);
  }
  return {};
}

async function compactNode(state: S, config: LangGraphRunnableConfig) {
  const run = runOf(config);
  // после «стоп» пользователь ждёт управление сразу — свернём на следующем ходе
  if (run.signal.aborted || state.promptTokens < llmCompactAt()) return {};
  const humans = state.messages.map((m, i) => (isHumanMessage(m) ? i : -1)).filter((i) => i >= 0);
  if (humans.length <= cfg.keepRecentTurns) return {};
  const cut = humans[humans.length - cfg.keepRecentTurns];
  const old = state.messages.slice(0, cut); // режем по границе хода — вызовы инструментов не разрываются
  const chat = getChat(run.chatId)!;
  run.emit({ type: "compacting" });
  try {
    const r = await llm([
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: `Условие задачи (для контекста): ${getTask(run.taskId).title}\n${clip(getTask(run.taskId).brief.trim(), 1500)}\n\n${chat.summary ? `Предыдущее резюме:\n${chat.summary}\n\n` : ""}Диалог для сжатия:\n${transcript(old, { user: 2000, ai: 3000, tool: 600 })}` },
    ], { effort: "off", maxTokens: 1400, temperature: 0.3, signal: run.signal });
    const summary = r.content.trim();
    if (!summary || r.finish === "aborted" || r.finish === "length") return {}; // обрезанное резюме хуже, чем никакого
    db.prepare("update chats set summary=?, updated_at=? where id=?").run(summary, now(), run.chatId);
    const kept = state.messages.slice(cut);
    const estimate = approxTokens(summary + transcript(kept, { user: 1e6, ai: 1e6, tool: 1e6 })) + 2500;
    log(run.chatId, "marker", { type: "compacted", removed: old.length, before: state.promptTokens, after: estimate });
    run.emit({ type: "compacted", removed: old.length, before: state.promptTokens, after: estimate, summary });
    // системный промпт всё равно меняется (новое резюме) — заодно освежаем в нём снимок памяти задачи
    return { messages: old.map((m) => new RemoveMessage({ id: m.id! })), promptTokens: estimate, memSnap: memory.snapshot(run.taskId) };
  } catch (e) {
    console.warn("[compact]", (e as Error).message);
    return {};
  }
}

const afterAgent = (s: S) => {
  if (s.stopped) return "compact";
  const last = s.messages[s.messages.length - 1];
  return isAIMessage(last) && last.tool_calls?.length ? "tools" : "propose";
};
const afterTools = (s: S) => (s.stopped ? "compact" : "agent");

// Свой экземпляр better-sqlite3 (v13, собран): у checkpoint-sqlite своя копия v12, pnpm её не собирает.
const cpDb = new Database(paths.checkpoints);
cpDb.pragma("journal_mode = WAL");
export const checkpointer = new SqliteSaver(cpDb as any);
export const graph = new StateGraph(State)
  .addNode("recall", recallNode)
  .addNode("agent", agentNode)
  .addNode("tools", toolsNode)
  .addNode("propose", proposeNode)
  .addNode("compact", compactNode)
  .addEdge(START, "recall")
  .addEdge("recall", "agent")
  .addConditionalEdges("agent", afterAgent, ["tools", "propose", "compact"])
  .addConditionalEdges("tools", afterTools, ["agent", "compact"])
  .addEdge("propose", "compact")
  .addEdge("compact", END)
  .compile({ checkpointer });

// ---------- запуск хода ----------
const active = new Map<string, { ac: AbortController; done: Promise<void> }>();
export const isBusy = (chatId: string) => active.has(chatId);
export const stopTurn = (chatId: string) => { active.get(chatId)?.ac.abort(); };
// Удаление чата/задачи: сначала дождаться, пока прерванный ход реально закончится, — иначе он пишет в журнал
// удалённого чата (FK → исключение) и создаёт чекпоинты для удалённого потока.
export async function stopAndWait(chatId: string) {
  const a = active.get(chatId);
  if (!a) return;
  a.ac.abort();
  await a.done.catch(() => {});
}

// Чекпоинтер пишет полное состояние на каждом шаге графа; нам нужен только последний (возобновление хода).
// Без чистки база растёт без предела: картинка 5 МБ в ходе из 10 раундов — это ~24 копии.
function pruneCheckpoints(chatId: string) {
  try {
    const keep = cpDb.prepare("select checkpoint_id from checkpoints where thread_id=? order by checkpoint_id desc limit 1").get(chatId) as { checkpoint_id: string } | undefined;
    if (!keep) return;
    cpDb.prepare("delete from writes where thread_id=? and checkpoint_id<>?").run(chatId, keep.checkpoint_id);
    cpDb.prepare("delete from checkpoints where thread_id=? and checkpoint_id<>?").run(chatId, keep.checkpoint_id);
  } catch (e) {
    console.warn("[checkpoints]", (e as Error).message);
  }
}

// Вызовы инструментов, оборванные падением/остановкой сервера (SIGKILL, OOM, `whitehat stop`, перезапуск tsx watch)
// между «модель вызвала инструмент» и «результат записан». Закрываем их перед следующим ходом этого чата:
//  - в журнале чата (chat_log) — tool_result с пометкой interrupted, иначе блок инструмента в интерфейсе крутится вечно;
//  - в состоянии LangGraph — ToolMessage сразу после сообщения ассистента, иначе assistant.tool_calls без ответа
//    навсегда остаётся в контексте модели. Если результат успел попасть в журнал, берём его оттуда.
// Возвращает исправленный список сообщений (или null, если чинить нечего).
async function closeInterrupted(chatId: string): Promise<BaseMessage[] | null> {
  const logged = new Map<string, string>();
  for (const r of db.prepare("select json_extract(data,'$.id') as id, json_extract(data,'$.output') as output from chat_log where chat_id=? and kind='tool_result'").all(chatId) as { id: string | null; output: string | null }[])
    if (r.id) logged.set(String(r.id), String(r.output ?? ""));
  const asked = db.prepare("select json_extract(data,'$.tool_calls') as tc from chat_log where chat_id=? and kind='assistant' and json_array_length(data,'$.tool_calls') > 0 order by id").all(chatId) as { tc: string }[];
  for (const row of asked) {
    let calls: { id?: string; name?: string }[] = [];
    try { calls = JSON.parse(row.tc); } catch { continue; }
    for (const c of calls) {
      if (!c?.id || logged.has(c.id)) continue;
      log(chatId, "tool_result", { id: c.id, name: c.name, output: INTERRUPTED, interrupted: true });
      logged.set(c.id, INTERRUPTED);
    }
  }
  const snap = await graph.getState({ configurable: { thread_id: chatId } });
  const msgs = ((snap?.values as Partial<S> | undefined)?.messages ?? []) as BaseMessage[];
  const answered = new Set(msgs.filter(isToolMessage).map((m) => (m as ToolMessage).tool_call_id));
  const fixed: BaseMessage[] = [];
  let changed = false;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    fixed.push(m);
    if (!isAIMessage(m) || !m.tool_calls?.length) continue;
    while (i + 1 < msgs.length && isToolMessage(msgs[i + 1])) fixed.push(msgs[++i]);
    for (const tc of m.tool_calls) {
      if (!tc.id || answered.has(tc.id)) continue;
      fixed.push(new ToolMessage({ tool_call_id: tc.id, name: tc.name, content: logged.get(tc.id) ?? INTERRUPTED }));
      answered.add(tc.id);
      changed = true;
    }
  }
  return changed ? fixed : null;
}

export async function runTurn(chatId: string, text: string, images: string[], effort: Effort, mode: AgentMode, emit: Emit) {
  const chat = getChat(chatId);
  if (!chat) throw new Error("чат не найден");
  if (active.has(chatId)) throw new Error("в этом чате уже идёт ответ");
  const ac = new AbortController();
  let finished!: () => void;
  active.set(chatId, { ac, done: new Promise<void>((r) => (finished = r)) });
  const runId = nanoid();
  runs.set(runId, { emit, signal: ac.signal, effort, mode, taskId: chat.task_id, chatId });
  const content = images.length ? [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : text;
  try {
    // всё, что может бросить (чат удалили между /send и этим местом), — внутри try: иначе active не очистится
    const fixed = await closeInterrupted(chatId);
    log(chatId, "user", { text, images: images.length ? images : undefined });
    if (chat.title === "новый чат" && text.trim()) {
      const title = clip(text.trim().replace(/\s+/g, " "), 60);
      db.prepare("update chats set title=? where id=?").run(title, chatId);
      emit({ type: "chat_title", title });
    }
    const human = new HumanMessage({ content: content as any });
    const final = await graph.invoke(
      // оборванные вызовы закрываются на своих местах: список пересобирается целиком (REMOVE_ALL + исправленный)
      { messages: fixed ? [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...fixed, human] : [human] },
      { configurable: { thread_id: chatId, run_id: runId }, recursionLimit: cfg.maxToolRounds * 2 + 12 },
    );
    db.prepare("update chats set last_prompt_tokens=?, updated_at=? where id=?").run(final.promptTokens, now(), chatId);
    db.prepare("update tasks set updated_at=? where id=?").run(now(), chat.task_id);
    emit({ type: "done", promptTokens: final.promptTokens, ctxWindow: llmCtxWindow(), stopped: final.stopped });
  } catch (e: any) {
    const message = e?.message ?? String(e);
    try { log(chatId, "marker", { type: "error", message }); } catch { /* чат уже удалён */ }
    emit({ type: "error", message });
  } finally {
    pruneCheckpoints(chatId);
    active.delete(chatId);
    runs.delete(runId);
    finished();
  }
}

export async function deleteChatState(chatId: string) {
  try { await checkpointer.deleteThread(chatId); } catch { /* ignore */ }
}
