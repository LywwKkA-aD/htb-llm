// Песочница: отдельный Kali-контейнер на каждую задачу.
// /work контейнера = data/tasks/<id>/work на хосте (файлы задачи видны и из файлового менеджера).
// Команды агента транслируются в «терминал агента» (шина + лог для повтора после перезагрузки страницы).
import Docker from "dockerode";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { finished } from "node:stream/promises";
import { cfg, paths, DATA, hostPath, safeTask } from "./config.ts";
import { db } from "./db.ts";

// WH_DOCKER_SOCKET — другой сокет Docker (тесты проверяют сообщение «Docker недоступен» на несуществующем)
const DOCKER_SOCKET = process.env.WH_DOCKER_SOCKET || "/var/run/docker.sock";
export const docker = new Docker({ socketPath: DOCKER_SOCKET });
// safeTask — защита в глубину: id попадает и в имя контейнера, и в пути data/tasks/<id> (никаких «../»)
const cname = (taskId: string) => `${cfg.containerPrefix}${safeTask(taskId)}`;

// Сеть песочниц: свой мост wh0 без связи между контейнерами (enable_icc=false). На мосту docker0 по умолчанию
// задача видела контейнеры других задач и чужие сервисы (qdrant, searxng). Доступ с wh0 к сервисам самого
// хоста (llama :8080 на 0.0.0.0 и т.п.) режут правила iptables — их ставит root: `sudo bin/whitehat firewall install`.
export const SANDBOX_NET = "whitehat-sbx";
export const SANDBOX_BRIDGE = "wh0";
const NET_OPTS = { "com.docker.network.bridge.name": SANDBOX_BRIDGE, "com.docker.network.bridge.enable_icc": "false" };

// ---------- понятные ошибки Docker (вместо «connect ENOENT /var/run/docker.sock» и «(HTTP code 404) …») ----------
export function dockerError(e: any): Error {
  const code = e?.code;
  const msg = String(e?.json?.message ?? e?.reason ?? e?.message ?? e);
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE")
    return new Error(`Docker недоступен (${DOCKER_SOCKET}: ${code}) — запусти службу: sudo systemctl start docker`);
  if (code === "EACCES")
    return new Error(`нет доступа к Docker (${DOCKER_SOCKET}: EACCES) — добавь пользователя в группу docker и перелогинься`);
  if (e?.statusCode === 404 && /no such image/i.test(msg))
    return new Error(`нет образа песочницы ${cfg.image} — собери его: docker build -t ${cfg.image} docker/kali (bin/htb-llm start делает это сам)`);
  return e instanceof Error ? e : new Error(msg);
}
async function dockerAlive() {
  try { await docker.ping(); return true; } catch { return false; }
}

// ---------- терминал агента: шина событий + лог ----------
const buses = new Map<string, EventEmitter>();
export function agentBus(taskId: string) {
  let b = buses.get(taskId);
  if (!b) { b = new EventEmitter(); b.setMaxListeners(50); buses.set(taskId, b); }
  return b;
}
const AGENT_LOG_MAX = 2 * 1024 * 1024;
const agentLogWrites = new Map<string, number>();
function agentWrite(taskId: string, s: string) {
  const p = paths.agentLog(taskId);
  try {
    fs.appendFileSync(p, s);
  } catch {
    fs.mkdirSync(paths.taskDir(taskId), { recursive: true });
    fs.appendFileSync(p, s);
  }
  // размер проверяем не на каждой записи; при переполнении оставляем последнюю половину (с начала строки)
  const n = (agentLogWrites.get(taskId) ?? 0) + 1;
  agentLogWrites.set(taskId, n);
  if (n % 200 === 0 && fs.statSync(p).size > AGENT_LOG_MAX) fs.writeFileSync(p, tailBytes(p, AGENT_LOG_MAX / 2));
  agentBus(taskId).emit("data", s);
}
export function agentLogTail(taskId: string, maxBytes = 256 * 1024): string {
  return tailBytes(paths.agentLog(taskId), maxBytes);
}
// ---------- журнал терминала пользователя (что он видел: команды, вывод, ошибки) ----------
const USER_LOG_MAX = 512 * 1024;
export const shellSid = (sid: unknown) => {
  const n = Number(sid);
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : 1;
};
export function userLogWrite(taskId: string, s: string, sid = 1) {
  const p = paths.userLog(taskId, shellSid(sid));
  fs.mkdirSync(paths.taskDir(taskId), { recursive: true });
  fs.appendFileSync(p, s);
  if (fs.statSync(p).size > USER_LOG_MAX) fs.writeFileSync(p, tailBytes(p, USER_LOG_MAX / 2));
}
// Хвост файла. Срез по байтам может начаться посреди UTF-8 символа («�» в начале) или посреди ESC-последовательности —
// если начало отрезано, начинаем со следующей строки (а без перевода строки рядом — хотя бы с целого символа).
function tailBytes(p: string, maxBytes: number): string {
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { return ""; }
  const len = Math.min(st.size, maxBytes);
  const b = Buffer.alloc(len);
  const fd = fs.openSync(p, "r");
  let got = 0;
  try { got = fs.readSync(fd, b, 0, len, st.size - len); } finally { fs.closeSync(fd); }
  let start = 0;
  if (len < st.size) {
    const nl = b.indexOf(0x0a);
    if (nl >= 0 && nl < Math.min(got, 8192)) start = nl + 1;
    while (start < got && (b[start] & 0xc0) === 0x80) start++; // байты продолжения UTF-8
  }
  return b.subarray(start, got).toString("utf8");
}

// ---------- сырой поток терминала -> текст ----------
// ESC-последовательности: OSC (Kali шлёт OSC 3008 и заголовок окна), DCS/PM/APC, CSI (цвета, курсор),
// двухбайтовые (ESC ( B от tput sgr0, ESC =, ESC >, ESC 7/8, ESC M). OSC/DCS не переходят через перевод строки:
// незакрытая последовательность не должна съесть остаток вывода.
export function stripEscapes(s: string) {
  if (!s.includes("\x1b")) return s;
  return s
    .replace(/\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b[P^_X][^\x1b\n]*(?:\x1b\\)?/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[ -\/]+[0-~]/g, "")
    .replace(/\x1b[0-~]?/g, "");
}
const EL = ""; // временная метка «стереть до конца строки» (CSI K) — нужна, чтобы правильно наложить \r-перерисовки
// Строка с \r (прогресс-бары curl/wget/apt, перерисовка readline) и backspace: то, что осталось на экране.
function overwrite(line: string): string {
  if (!/[\r\b]/.test(line)) return line;
  const buf: string[] = [];
  let x = 0;
  for (const ch of line) {
    if (ch === "\r") x = 0;
    else if (ch === "\b") { if (x > 0) x--; }
    else if (ch === EL) buf.length = Math.min(buf.length, x);
    else buf[x++] = ch;
  }
  return buf.join("");
}
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g; // всё управляющее, кроме \t и \n
function cleanLines(s: string, trim: boolean): string[] {
  const t = stripEscapes(s.includes("\x1b[") ? s.replace(/\x1b\[([02]?)K/g, (_m, n) => (n === "2" ? "\r" + EL : EL)) : s);
  return t.replace(/\r+\n/g, "\n").split("\n").map((l) => {
    const v = overwrite(l).replace(CONTROLS, "").replaceAll(EL, "");
    return trim ? v.trimEnd() : v;
  });
}
// Текст вывода команды для модели: без ESC-последовательностей и управляющих символов, \r-прогресс схлопнут
// до итоговой строки. Пробелы и пустые строки не трогаем — это данные.
export function cleanOutput(s: string) {
  return cleanLines(s, false).join("\n");
}
// Полноэкранные программы (vim, less, htop, man) рисуют на альтернативном экране: позиционирование курсора
// без него превращается в кашу из обрывков. Их экран заменяется пометкой — команда, которой программа
// запущена, остаётся видна строкой выше.
const ALT = /\x1b\[\?(?:1049|1047|47)([hl])/g;
const ALT_DONE = "\n[полноэкранная программа (vim/less/htop/man…) — её экран не записывается]\n";
const ALT_OPEN = "\n[сейчас открыта полноэкранная программа (vim/less/htop/man…) — её экран не записывается]\n";
function dropAltScreens(s: string) {
  if (!s.includes("\x1b[?")) return s;
  let out = "", pos = 0, inAlt = false, seenOn = false;
  for (const m of s.matchAll(ALT)) {
    const on = m[1] === "h", at = m.index!;
    if (on && !inAlt) { out += s.slice(pos, at); inAlt = true; seenOn = true; }
    else if (!on && inAlt) { out += ALT_DONE; inAlt = false; pos = at + m[0].length; }
    else if (!on && !seenOn) { out = ALT_DONE; pos = at + m[0].length; seenOn = true; } // срез начался внутри программы
  }
  return inAlt ? out + ALT_OPEN : out + s.slice(pos);
}
// сырой поток терминала пользователя -> текст экрана (для user_history)
export function terminalToText(raw: string) {
  return cleanLines(dropAltScreens(raw), true).join("\n").replace(/\n{3,}/g, "\n\n");
}
const SHELL_CAPTURE_MARK = "\n[whitehat:shell-capture]\n";
function capturedLogText(p: string) {
  const raw = tailBytes(p, 96 * 1024);
  const i = raw.lastIndexOf(SHELL_CAPTURE_MARK);
  if (i >= 0) return raw.slice(i + SHELL_CAPTURE_MARK.length).trim();
  return terminalToText(raw).trim();
}
export function userTerminalTail(taskId: string, chars = 3500) {
  let files: { sid: number; p: string }[] = [];
  try {
    files = fs.readdirSync(paths.taskDir(taskId))
      .map((f) => {
        const m = /^user-terminal(?:-(\d+))?\.log$/.exec(f);
        return m ? { sid: m[1] ? Number(m[1]) : 1, p: path.join(paths.taskDir(taskId), f) } : null;
      })
      .filter((x): x is { sid: number; p: string } => !!x)
      .sort((a, b) => a.sid - b.sid);
  } catch { /* задачи ещё нет на диске */ }
  if (files.length <= 1) {
    const t = capturedLogText(paths.userLog(taskId));
    return t.length > chars ? "…" + t.slice(-chars) : t;
  }
  const per = Math.max(700, Math.floor(chars / files.length));
  const sections = files.map(({ sid, p }) => {
    const t = capturedLogText(p);
    return `[shell ${sid}]\n${t.length > per ? "…" + t.slice(-per) : t || "(пусто)"}`;
  });
  const out = sections.join("\n\n");
  return out.length > chars ? "…" + out.slice(-chars) : out;
}
// Экран для user_history: предпочитаем pipe-pane-лог самой tmux-панели (/work/.whitehat/shell-N.log) —
// это сырой вывод программ ДО отрисовки tmux, поэтому terminalToText честно вырезает полноэкранные
// less/vim/htop и оставляет команды вокруг них. capture-pane — только fallback для сессий без такого лога.
export async function userTerminalScreen(taskId: string, chars = 3500) {
  try {
    const dir = path.join(paths.taskWork(taskId), ".whitehat");
    const paneLogs = fs.readdirSync(dir)
      .map((f) => /^shell-(\d+)\.log$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ sid: Number(m[1]), p: path.join(dir, m[0]) }))
      .sort((a, b) => a.sid - b.sid);
    if (paneLogs.length) {
      const per = Math.max(700, Math.floor(chars / paneLogs.length));
      const sections = paneLogs.map(({ sid, p }) => {
        const t = terminalToText(tailBytes(p, 96 * 1024)).trim();
        const body = t.length > per ? "…" + t.slice(-per) : t || "(пусто)";
        return paneLogs.length > 1 ? `[shell ${sid}]\n${body}` : body;
      });
      const out = sections.join("\n\n");
      return out.length > chars ? "…" + out.slice(-chars) : out;
    }
  } catch { /* нет pipe-pane-логов — fallback ниже */ }
  if ((await status(taskId).catch(() => "missing")) !== "running") return userTerminalTail(taskId, chars);
  try {
    const c = await ensure(taskId);
    const script = `for s in $(tmux ls -F '#{session_name}' 2>/dev/null); do case "$s" in wh-shell-*) echo "[shell \${s#wh-shell-}]"; tmux capture-pane -p -J -S -160 -t "$s" 2>/dev/null;; esac; done`;
    const raw = (await execRaw(c, script, 8000)).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!raw.includes("[shell ")) return userTerminalTail(taskId, chars);
    const live = new Set([...raw.matchAll(/^\[shell (\d+)\]$/gm)].map((m) => Number(m[1])));
    let extra = "";
    try {
      const closed = fs.readdirSync(paths.taskDir(taskId))
        .map((f) => /^user-terminal-(\d+)\.log$/.exec(f))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => Number(m[1]))
        .filter((sid) => !live.has(sid));
      if (closed.length) {
        extra = closed.map((sid) => `[shell ${sid}]\n${capturedLogText(paths.userLog(taskId, sid)) || "(пусто)"}`).join("\n\n");
      }
    } catch { /* только живые сессии */ }
    const out = extra ? `${raw}\n\n${extra}` : raw;
    return out.length > chars ? "…" + out.slice(-chars) : out;
  } catch {
    return userTerminalTail(taskId, chars);
  }
}

const C = { green: "\x1b[1;32m", dim: "\x1b[2;37m", red: "\x1b[1;31m", yellow: "\x1b[33m", reset: "\x1b[0m", cyan: "\x1b[36m" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

// ---------- сеть песочниц ----------
// Правила iptables от `sudo bin/whitehat firewall install` (юнит whitehat-firewall.service). Без root правила не
// прочитать — смотрим на юнит. Для /api/health и предупреждения в журнале сервера.
export function firewallInstalled(): boolean {
  try { return spawnSync("systemctl", ["is-active", "--quiet", "whitehat-firewall.service"], { timeout: 3000 }).status === 0; } catch { return false; }
}
let netReady: Promise<void> | null = null;
export function ensureNetwork(): Promise<void> {
  if (!netReady) netReady = ensureNetworkOnce().catch((e) => { netReady = null; throw e; });
  return netReady;
}
async function ensureNetworkOnce() {
  await createNetwork();
  if (!firewallInstalled()) console.warn("[sandbox] из песочниц видны сервисы хоста на 0.0.0.0 (llama :8080 и др.) — закрыть: sudo bin/htb-llm firewall install");
}
async function createNetwork() {
  const check = (i: Docker.NetworkInspectInfo) => {
    const o = i.Options ?? {};
    if (o["com.docker.network.bridge.enable_icc"] !== "false" || o["com.docker.network.bridge.name"] !== SANDBOX_BRIDGE)
      console.warn(`[sandbox] сеть ${SANDBOX_NET} создана без изоляции (${JSON.stringify(o)}) — удали её (docker network rm ${SANDBOX_NET}), когда в ней не будет контейнеров`);
  };
  try { check(await docker.getNetwork(SANDBOX_NET).inspect()); return; } catch (e: any) { if (e?.statusCode !== 404) throw e; }
  try {
    await docker.createNetwork({
      Name: SANDBOX_NET, Driver: "bridge", CheckDuplicate: true, Internal: false, Options: NET_OPTS,
      Labels: { "whitehat.net": "sandbox" },
    });
    console.log(`[sandbox] создана сеть ${SANDBOX_NET} (мост ${SANDBOX_BRIDGE}, без связи между контейнерами)`);
  } catch (e) {
    // параллельный сервер (второй прогон тестов) успел создать её первым — 409; берём ту, что есть
    try { check(await docker.getNetwork(SANDBOX_NET).inspect()); } catch { throw e; }
  }
}
// Контейнер, созданный старой версией (мост docker0), переводится в сеть песочниц: подключить к ней и отключить
// от остальных. Система контейнера при этом сохраняется. Не вышло — пересоздаём (файлы /work остаются).
async function migrateNetwork(taskId: string, c: Docker.Container, info: Docker.ContainerInspectInfo): Promise<boolean> {
  const nets = Object.keys(info.NetworkSettings?.Networks ?? {});
  if (nets.length === 1 && nets[0] === SANDBOX_NET) return true;
  try {
    if (!nets.includes(SANDBOX_NET)) await docker.getNetwork(SANDBOX_NET).connect({ Container: info.Id });
    for (const n of nets) if (n !== SANDBOX_NET) await docker.getNetwork(n).disconnect({ Container: info.Id, Force: true });
    agentWrite(taskId, `${C.dim}# контейнер переведён в изолированную сеть ${SANDBOX_NET} (другие задачи и сервисы хоста не видны)${C.reset}\r\n`);
    return true;
  } catch (e) {
    console.warn(`[sandbox] перевод ${info.Name} в ${SANDBOX_NET} не удался (${(e as Error).message}) — пересоздаю контейнер`);
    try { await c.remove({ force: true }); } catch { /* ignore */ }
    return false;
  }
}

// ---------- контейнер ----------
export type CStatus = "running" | "stopped" | "missing";
// ---------- workspace задачи: каркас папок, TASK.md, TARGET/hosts ----------

export const WORKSPACE_DIRS = ["scans", "exploits", "www", "loot", "notes"] as const;
type TaskMeta = { title: string; brief: string; target: string; hostname: string };
const isIpv4 = (s: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
};
const isHostname = (s: string) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(s);
function taskMeta(taskId: string): TaskMeta {
  try {
    const t = db.prepare("select title,brief,target,hostname from tasks where id=?").get(taskId) as any;
    if (t) return { title: String(t.title ?? taskId), brief: String(t.brief ?? ""), target: String(t.target ?? ""), hostname: String(t.hostname ?? "") };
  } catch { /* задача могла быть удалена посреди вызова */ }
  return { title: taskId, brief: "", target: "", hostname: "" };
}
export function targetEnv(taskId: string): string[] {
  const m = taskMeta(taskId);
  const env: string[] = [];
  if (isIpv4(m.target)) {
    env.push(`TARGET=${m.target}`, `RHOSTS=${m.target}`);
    env.push(`TARGET_HOST=${isHostname(m.hostname) ? m.hostname : "machine.htb"}`);
  }
  return env;
}
// Каркас /work: папки под сканы/эксплойты/отдачу/loot/заметки и TASK.md. Существующие файлы не трогаем,
// в TASK.md обновляем только помеченный мета-блок (TARGET после респауна HTB-машины).
export function ensureWorkspace(taskId: string) {
  const work = paths.taskWork(taskId);
  fs.mkdirSync(work, { recursive: true });
  for (const d of WORKSPACE_DIRS) {
    const p = path.join(work, d);
    try { if (!fs.existsSync(p)) fs.mkdirSync(p); } catch { /* файл/симлинк с таким именем — не ломаем запуск */ }
  }
  const m = taskMeta(taskId);
  const meta = [
    "<!-- whitehat:task-meta:start -->",
    `- Задача: ${m.title} (\`${taskId}\`)`,
    `- TARGET: ${m.target || "(не задан)"} — переменная $TARGET в shell агента и пользователя`,
    `- Hostname: ${m.hostname || "(не задан)"} — $TARGET_HOST и запись в /etc/hosts контейнера (плюс алиас machine.htb)`,
    "<!-- whitehat:task-meta:end -->",
  ].join("\n");
  const file = path.join(work, "TASK.md");
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# ${m.title}\n\n${meta}\n\n## Папки\n\n- \`scans/\` — сканы и энумерация (nmap, ffuf, enum)\n- \`exploits/\` — эксплойты и скрипты под эту задачу\n- \`www/\` — файлы для отдачи цели (http.server, SMB)\n- \`loot/\` — флаги, хэши, креды, добытые файлы\n- \`notes/\` — заметки по ходу решения\n\n## Бриф\n\n${m.brief.trim() || "(пуст)"}\n`);
    } else {
      const cur = fs.readFileSync(file, "utf8");
      if (cur.includes("<!-- whitehat:task-meta:start -->")) {
        const next = cur.replace(/<!-- whitehat:task-meta:start -->[\s\S]*?<!-- whitehat:task-meta:end -->/, meta);
        if (next !== cur) fs.writeFileSync(file, next);
      }
    }
  } catch { /* TASK.md — удобство, не повод ронять запуск контейнера */ }
  return work;
}

const hostsSynced = new Map<string, string>();
async function syncHosts(taskId: string, c: Docker.Container, containerId: string) {
  const m = taskMeta(taskId);
  if (!isIpv4(m.target)) return;
  const hosts = [...new Set([m.hostname, "machine.htb"].filter(isHostname))];
  if (!hosts.length) return;
  const key = `${containerId}:${m.target}:${hosts.join(",")}`;
  if (hostsSynced.get(taskId) === key) return;
  const script = `python3 - <<'PY'\nimport re\np="/etc/hosts"\ns=open(p).read()\ns=re.sub(r"# whitehat-task-begin\\n.*?# whitehat-task-end\\n?", "", s, flags=re.S)\nblock="# whitehat-task-begin\\n${m.target} ${hosts.join(" ")}\\n# whitehat-task-end\\n"\nopen(p,"w").write(s.rstrip()+"\\n"+block)\nprint("whitehat-hosts-ok")\nPY`;
  try {
    const out = await execRaw(c, script, 8000);
    if (out.includes("whitehat-hosts-ok")) hostsSynced.set(taskId, key);
  } catch { /* hosts — удобство; TARGET по IP работает и без него */ }
}

export async function status(taskId: string): Promise<CStatus> {
  try {
    const i = await docker.getContainer(cname(taskId)).inspect();
    return i.State.Running ? "running" : "stopped";
  } catch { return "missing"; }
}

const containerIds = new Map<string, string>(); // id контейнера задачи (по нему видно, что его пересоздали посреди команды)
// Одновременные вызовы (создание задачи + shell + первая команда агента) ждут одну и ту же попытку:
// иначе 409 «имя занято» при создании или 304 «уже запущен» при старте.
const ensuring = new Map<string, Promise<Docker.Container>>();
export function ensure(taskId: string): Promise<Docker.Container> {
  let p = ensuring.get(taskId);
  if (!p) {
    p = ensureOnce(taskId).catch((e) => { throw dockerError(e); }).finally(() => ensuring.delete(taskId));
    ensuring.set(taskId, p);
  }
  return p;
}
async function ensureOnce(taskId: string) {
  const name = cname(taskId);
  const work = ensureWorkspace(taskId); // каркас папок + TASK.md; .whitehat внутри — территория root контейнера
  let c = docker.getContainer(name);
  let info: Docker.ContainerInspectInfo | null = null;
  try { info = await c.inspect(); } catch (e: any) { if (e?.statusCode !== 404) throw e; } // другие ошибки — не повод создавать заново
  await ensureNetwork();
  if (info && !(await migrateNetwork(taskId, c, info))) info = null;
  if (info) {
    if (!info.State.Running) {
      try { await c.start(); } catch (e: any) { if (e?.statusCode !== 304) throw e; } // 304 — уже запущен
    }
    containerIds.set(taskId, info.Id);
    await outputDir(taskId, c);
    await syncHosts(taskId, c, info.Id);
    return c;
  }
  const create = () => docker.createContainer({
    name,
    Image: cfg.image,
    Hostname: `task-${taskId.slice(0, 6)}`,
    WorkingDir: "/work",
    Cmd: ["sleep", "infinity"],
    Env: ["TERM=xterm-256color", "LANG=C.UTF-8"],
    Labels: { "whitehat.task": taskId, "whitehat.data": DATA }, // по метке data тесты убирают только свои контейнеры
    HostConfig: {
      Binds: [`${hostPath(work)}:/work`], // daemon видит хостовый путь; внутри app-контейнера DATA может быть /data
      NetworkMode: SANDBOX_NET, // изолированная сеть: интернет есть, соседних задач и сервисов на docker0 нет
      // /dev/net/tun: OpenVPN/WireGuard внутри контейнера (HTB), ligolo и прочие туннели. Нет на хосте — без него.
      ...(fs.existsSync("/dev/net/tun") ? { Devices: [{ PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun", CgroupPermissions: "rwm" }] } : {}),
      CapAdd: ["NET_ADMIN", "NET_RAW"], // сетевые лабы внутри контейнера: iptables, bridge/veth, сырые сокеты
      Init: true,
      Memory: 4 * 1024 ** 3,
      NanoCpus: 4e9, // 4 ядра: генерация в SYCL упирается и в CPU, не душим llama-server
      RestartPolicy: { Name: "no" },
    },
  });
  try {
    c = await create();
  } catch (e: any) {
    // сеть удалили, пока сервер работал (docker network prune) — создать заново и повторить
    if (e?.statusCode !== 404 || !/network/i.test(String(e?.json?.message ?? e?.message))) throw e;
    netReady = null;
    await ensureNetwork();
    c = await create();
  }
  await c.start();
  containerIds.set(taskId, c.id);
  await outputDir(taskId, c);
  await syncHosts(taskId, c, c.id);
  agentWrite(taskId, `${C.dim}# контейнер ${name} создан (Kali, NET_ADMIN, интернет; изолированная сеть ${SANDBOX_NET})${C.reset}\r\n`);
  return c;
}

// /work/.whitehat (файлы полного вывода) должна принадлежать пользователю сервера: если её создал root контейнера
// (mkdir, rm -rf и mkdir заново), сервер не может туда писать — отдаём её обратно изнутри контейнера.
// Симлинк или файл на её месте не трогаем: запись вывода всё равно откажется (см. openOutputFile), а запуск не ломается.
async function outputDir(taskId: string, c: Docker.Container) {
  const dir = path.join(paths.taskWork(taskId), ".whitehat");
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(dir); } catch { /* нет */ }
  if (!st) { try { fs.mkdirSync(dir); } catch { /* создаст позже openOutputFile */ } return; }
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (st.isDirectory() && uid !== undefined && st.uid !== uid)
    try { await execRaw(c, `chown -h ${uid}:${gid} /work/.whitehat`, 5000); } catch { /* ignore */ }
}

export async function stop(taskId: string) {
  try { await docker.getContainer(cname(taskId)).stop({ t: 2 }); } catch { /* уже остановлен */ }
}

// Полное удаление задачи: файлы в /work создаёт root контейнера, с хоста их не удалить — чистим изнутри.
export async function destroy(taskId: string) {
  const dir = paths.taskDir(taskId); // бросает на «../x» и прочих недопустимых id — до любых rm
  // файлы /work принадлежат root контейнера — чистим изнутри, даже если контейнер уже удалён (поднимаем временно)
  if (fs.existsSync(paths.taskWork(taskId))) {
    try {
      await ensure(taskId);
      await execCollect(taskId, "find /work -mindepth 1 -delete", 60);
    } catch (e) { console.warn("[destroy] очистка /work:", (e as Error).message); }
  }
  try { await docker.getContainer(cname(taskId)).remove({ force: true }); } catch { /* уже нет */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn("[destroy] rm:", (e as Error).message); }
  buses.delete(taskId);
  containerIds.delete(taskId);
  hostsSynced.delete(taskId);
  vpnCache.delete(taskId);
}

// Пересоздать контейнер с нуля (файлы в /work остаются)
export async function reset(taskId: string) {
  hostsSynced.delete(taskId);
  vpnCache.delete(taskId); // туннель жил в старом контейнере; конфиг в /work останется, подключится заново из вкладки VPN
  try { await docker.getContainer(cname(taskId)).remove({ force: true }); } catch { /* ignore */ }
  agentWrite(taskId, `${C.yellow}# контейнер пересоздаётся…${C.reset}\r\n`);
  await ensure(taskId);
}

// ---------- выполнение ----------
export type ExecResult = {
  exitCode: number; // -1 — неизвестен (контейнер или Docker пропали)
  timedOut: boolean; // сработал таймаут инструмента (а не свой exit 124/137 команды)
  aborted: boolean; // «стоп»
  note?: string; // почему команда кончилась не сама: OOM, контейнер остановлен/пересоздан, Docker пропал
};
// Сколько oom_kill уже было в cgroup контейнера (cgroup v2, v1) — только встроенные bash, без лишних процессов.
const OOM_COUNT = (v: string) =>
  `${v}=0; for _f in /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory/memory.oom_control; do ` +
  `[ -r "$_f" ] && while read -r _k _v; do [ "$_k" = oom_kill ] && ${v}=$_v; done < "$_f"; done`;

// Обёртка команды. Метка — $0 для bash -c: по ней «стоп» находит процесс. Сессия — сам docker exec (bash -lc
// с несколькими командами не делает exec, $$ = лидер сессии): вложенный `timeout` уходит в свою группу процессов,
// но не из сессии, поэтому «стоп» и таймаут добивают всю сессию (pkill -s). Номер сессии и счётчик OOM пишутся
// в /tmp/.<метка>.sid; при обычном завершении файл удаляется сразу, при 124/137 — после разбора на хосте.
// stderr обёртки на время команды — в /dev/null (у команды — настоящий, через fd 3): иначе bash печатал бы
// «line 1: 21 Killed timeout … bash -c '<команда>' wh…» в вывод, когда команду убил сигнал (OOM, kill -9).
function wrap(command: string, timeoutSec: number, mark: string, sid: string) {
  return `${OOM_COUNT("o")}; { echo "$$ $o" > ${sid}; } 2>/dev/null; ` +
    `{ timeout -k 5 ${timeoutSec} bash -c ${shq(command)} ${mark} 2>&3 3>&-; } 3>&2 2>/dev/null; ` +
    `rc=$?; case $rc in 124|137) ;; *) rm -f ${sid};; esac; exit $rc`;
}
// Служебная команда в контейнере напрямую (без обёртки и учёта): для уборки процессов и проверок.
async function execRaw(c: Docker.Container, script: string, limitMs = 15_000): Promise<string> {
  const ex = await c.exec({ Cmd: ["bash", "-c", script], AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await ex.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  out.setEncoding("utf8");
  let s = "";
  out.on("data", (d: string) => { s += d; });
  docker.modem.demuxStream(stream, out, out);
  const t = setTimeout(() => { try { stream.destroy(); } catch { /* ignore */ } }, limitMs);
  await new Promise<void>((resolve) => { stream.on("end", resolve); stream.on("close", resolve); stream.on("error", () => resolve()); });
  clearTimeout(t);
  return s;
}
// Добить всё, что запустила команда: TERM всей сессии, через ≤1 с KILL. Плюс по метке — если файл сессии не записался.
async function sweep(c: Docker.Container, mark: string, sid: string, waitSid: boolean) {
  const m = `[w]${mark.slice(1)}`;
  const script = [
    waitSid ? `for i in 1 2 3 4 5 6 7 8 9 10; do [ -r ${sid} ] && break; sleep 0.2; done` : ":", // «стоп» мог успеть раньше старта обёртки
    `s=; [ -r ${sid} ] && read -r s _ < ${sid}`,
    `case "$s" in ''|*[!0-9]*) s=;; esac; [ -n "$s" ] && [ "$s" -le 1 ] && s=`,
    `[ -n "$s" ] && pkill -TERM -s "$s"; pkill -TERM -f '${m}'`,
    `for i in 1 2 3 4 5 6 7 8 9 10; do { [ -n "$s" ] && pgrep -s "$s" >/dev/null; } || pgrep -f '${m}' >/dev/null || break; sleep 0.1; done`,
    `[ -n "$s" ] && pkill -KILL -s "$s"; pkill -KILL -f '${m}'`,
    `rm -f ${sid}; true`,
  ].join("\n");
  try { await execRaw(c, script); } catch { /* контейнер уже пропал — убирать нечего */ }
}
// exit 137 без таймаута: OOM, остановка/удаление/пересоздание контейнера или просто kill -9.
async function explain137(taskId: string, c: Docker.Container, sid: string, startId?: string): Promise<string | undefined> {
  const look = async () => { try { return await docker.getContainer(cname(taskId)).inspect(); } catch { return null; } };
  const gone = async (info: Docker.ContainerInspectInfo | null) => {
    if (!info) return (await dockerAlive()) ? "контейнер удалён во время команды — процессы команды убиты" : "Docker перестал отвечать во время команды";
    if (startId && info.Id !== startId) return "контейнер пересоздан во время команды — процессы команды убиты";
    if (!info.State.Running) return info.State.OOMKilled
      ? `OOM: контейнер остановлен ядром — не хватило памяти${limit(info)}`
      : "контейнер остановлен или удалён во время команды — процессы команды убиты";
    return null;
  };
  const limit = (info: Docker.ContainerInspectInfo) => (info.HostConfig?.Memory ? ` (лимит ${Math.round(info.HostConfig.Memory / 1024 ** 2)} МБ)` : "");
  // docker stop/rm -f сначала убивают процессы, состояние контейнера меняется чуть позже — даём ему устояться
  await sleep(250);
  let info = await look();
  const g = await gone(info);
  if (g) return g;
  let r: string[] | null = null;
  try {
    r = (await execRaw(c, `s=; o=; [ -r ${sid} ] && read -r s o < ${sid}; ${OOM_COUNT("n")}; rm -f ${sid}; echo "$o $n"`, 5000)).trim().split(/\s+/);
  } catch { /* контейнер уходит */ }
  if (r && r.length === 2 && /^\d+$/.test(r[0]) && /^\d+$/.test(r[1]))
    return Number(r[1]) > Number(r[0]) ? `OOM: ядро убило процесс — не хватило памяти контейнера${limit(info!)}` : undefined;
  await sleep(500);
  info = await look();
  return (await gone(info)) ?? undefined;
}

async function execStream(
  taskId: string,
  command: string,
  timeoutSec: number,
  onData: (s: string, stderr: boolean) => void,
  signal?: AbortSignal,
): Promise<ExecResult> {
  if (signal?.aborted) return { exitCode: 130, timedOut: false, aborted: true };
  const c = await ensure(taskId);
  const startId = containerIds.get(taskId);
  if (signal?.aborted) return { exitCode: 130, timedOut: false, aborted: true };
  const mark = `wh${crypto.randomBytes(5).toString("hex")}`;
  const sid = `/tmp/.${mark}.sid`;
  // Свой таймер на хосте: exit 124/137 — таймаут инструмента, только если время действительно вышло.
  // Иначе это код самой команды (timeout 1 …, kill -9, OOM) — раньше любой 124/137 выдавался за «таймаут 90 с».
  let expired = false, hard = false;
  const timer = setTimeout(() => { expired = true; }, timeoutSec * 1000);
  let ex: Docker.Exec, stream: NodeJS.ReadWriteStream & { destroy?: () => void };
  try {
    ex = await c.exec({
      Cmd: ["bash", "-lc", wrap(command, timeoutSec, mark, sid)],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: "/work",
      // LHOST/WH_VPN_IFACE из кэша статуса VPN (peek без exec: execStream сам обслуживает VPN-скрипты); TARGET — цель задачи
      Env: ["TERM=xterm-256color", "COLUMNS=120", "LANG=C.UTF-8", ...vpnEnv(taskId), ...targetEnv(taskId)],
    });
    stream = (await ex.start({ hijack: true, stdin: false })) as typeof stream;
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.statusCode === 404 || e?.statusCode === 409) // контейнер пропал/остановлен между ensure и exec
      throw new Error(`контейнер задачи остановлен или удалён (${String(e?.json?.message ?? e?.message).slice(0, 120)}) — повтори команду, он поднимется заново`);
    throw dockerError(e);
  }
  const out = new PassThrough();
  const err = new PassThrough();
  // декодер с состоянием: многобайтовый символ на границе кусков потока не превращается в «��»
  out.setEncoding("utf8");
  err.setEncoding("utf8");
  out.on("data", (d: string) => onData(d, false));
  err.on("data", (d: string) => onData(d, true));
  docker.modem.demuxStream(stream, out, err);
  const kill = () => { try { stream.destroy?.(); } catch { /* ignore */ } };
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted) kill(); // стоп нажали, пока exec запускался — событие уже прошло
  // запас сверх таймаута: timeout -k 5 добивает через 5 с, docker ждёт закрытия потоков ещё ~2 с
  const hardTimer = setTimeout(() => { hard = true; kill(); }, (timeoutSec + 15) * 1000);
  await new Promise<void>((resolve) => { stream.on("end", resolve); stream.on("close", resolve); stream.on("error", () => resolve()); });
  clearTimeout(timer);
  clearTimeout(hardTimer);
  signal?.removeEventListener("abort", kill);
  out.end();
  err.end();
  await Promise.all([finished(out).catch(() => {}), finished(err).catch(() => {})]); // дочитать хвост декодера
  const aborted = !!signal?.aborted;
  if (aborted || hard) await sweep(c, mark, sid, aborted);
  // код возврата: exec может ещё числиться работающим доли секунды после конца потока
  let info: Docker.ExecInspectInfo | null = null;
  for (let i = 0; i < 30; i++) {
    try { info = await ex.inspect(); } catch { info = null; break; }
    if (!info.Running) break;
    await sleep(100);
  }
  const exitCode = info && !info.Running && info.ExitCode !== null ? info.ExitCode : -1;
  if (aborted || hard) return { exitCode, timedOut: hard && !aborted, aborted, ...(hard && !aborted ? { note: "команда не завершилась после таймаута — процессы добиты" } : {}) };
  if (exitCode === 124 || exitCode === 137) {
    if (expired) { await sweep(c, mark, sid, false); return { exitCode, timedOut: true, aborted: false }; } // вложенные timeout и фон команды
    if (exitCode === 137) {
      const note = await explain137(taskId, c, sid, startId);
      return { exitCode, timedOut: false, aborted: false, ...(note ? { note } : {}) };
    }
    void execRaw(c, `rm -f ${sid}`, 5000).catch(() => {});
  }
  if (exitCode === -1) {
    const s = await status(taskId);
    const note = s === "running" ? "код возврата неизвестен" : (await dockerAlive()) ? "контейнер остановлен или удалён во время команды" : "Docker перестал отвечать во время команды";
    return { exitCode, timedOut: false, aborted: false, note };
  }
  return { exitCode, timedOut: false, aborted: false };
}

export async function execCollect(taskId: string, command: string, timeoutSec = 30) {
  let s = "";
  const r = await execStream(taskId, command, timeoutSec, (d) => { s += d; });
  return { ...r, output: s };
}

// ---------- tcp_probe: короткий диалог с сервисом цели из контейнера ----------
const TCP_PROBE_PY = String.raw`
import socket, sys, json, base64, time

cfg = json.loads(base64.b64decode(sys.argv[1]))
host, port = cfg["host"], int(cfg["port"])

def show(data):
    if not data:
        return "(пусто)"
    try:
        t = data.decode("utf-8")
        if all(ch.isprintable() or ch in "\r\n\t" for ch in t):
            return t.replace("\r", "\\r").rstrip()
    except UnicodeDecodeError:
        pass
    return "hex: " + data[:256].hex(" ") + (" ..." if len(data) > 256 else "")

def drain(sock, budget_ms):
    out = b""
    end = time.monotonic() + budget_ms / 1000
    while time.monotonic() < end and len(out) < 65536:
        sock.settimeout(max(0.05, end - time.monotonic()))
        try:
            chunk = sock.recv(8192)
        except socket.timeout:
            break
        except OSError:
            return out, True
        if not chunk:
            return out, True
        out += chunk
        end = min(end, time.monotonic() + 0.35)
    return out, False

t0 = time.monotonic()
try:
    sock = socket.create_connection((host, port), timeout=8)
except Exception as e:
    print(f"[не подключиться к {host}:{port}: {e}]"); sys.exit(0)
print(f"[подключено к {host}:{port} за {time.monotonic() - t0:.2f} с]")
banner, closed = drain(sock, cfg.get("banner_ms", 1200))
if banner:
    print(f"<< баннер ({len(banner)} байт): {show(banner)}")
for i, step in enumerate(cfg["steps"]):
    data = base64.b64decode(step["data_b64"])
    try:
        sock.sendall(data)
    except OSError as e:
        print(f"[ошибка отправки на шаге {i + 1}: {e}]"); break
    print(f">> шаг {i + 1} ({len(data)} байт): {show(data)}")
    resp, closed = drain(sock, int(step.get("wait_ms", 2500)))
    print(f"<< ({len(resp)} байт): {show(resp)}")
    if closed:
        print("[сервис закрыл соединение]"); break
else:
    if closed:
        print("[сервис закрыл соединение]")
sock.close()
`;

export async function tcpProbe(taskId: string, host: string, port: number, steps: { data: Buffer; waitMs: number }[], signal?: AbortSignal): Promise<string> {
  await ensure(taskId);
  const cfg64 = Buffer.from(JSON.stringify({
    host, port,
    steps: steps.map((s) => ({ data_b64: s.data.toString("base64"), wait_ms: s.waitMs })),
  })).toString("base64");
  const py64 = Buffer.from(TCP_PROBE_PY).toString("base64");
  const totalSec = Math.min(60, 12 + steps.reduce((a, s) => a + s.waitMs / 1000, 0));
  const cmd = `echo ${py64} | base64 -d | python3 - ${cfg64}`;
  let s = "";
  const r = await execStream(taskId, cmd, totalSec, (d) => { s += d; }, signal);
  const out = cleanOutput(s).trim();
  if (r.timedOut) return `${out}\n[прервано по общему таймауту ${totalSec} с]`;
  if (r.aborted) return `${out}\n[остановлено пользователем]`;
  if (r.exitCode !== 0 && !out) return `ошибка: tcp_probe не выполнился (exit ${r.exitCode})`;
  return out || "(сервис ничего не ответил)";
}

// ---------- http_request: HTTP из контейнера с persistent cookie-сессией задачи ----------
// Сессия живёт файлом кук в /work/.whitehat/http/<имя>.cookies: логин один раз — дальше все вызовы
// авторизованы; переживает ходы, чаты и пересоздание контейнера. Только stdlib (urllib + cookiejar):
// requests в образе не гарантирован, а curl-вывод парсить хрупко. Результат — одна строка WHHTTP <json>.
const HTTP_PY = String.raw`
import sys, json, base64, os, re, ssl, time
import urllib.request, urllib.error, urllib.parse
import http.cookiejar, http.client

cfg = json.loads(base64.b64decode(sys.argv[1]))
def emit(obj):
    print("WHHTTP " + json.dumps(obj, ensure_ascii=False))
    sys.exit(0)

work = "/work"
sess_dir = os.path.join(work, ".whitehat", "http")
os.makedirs(sess_dir, exist_ok=True)
sname = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(cfg.get("session") or "default"))[:40].strip("._") or "default"
jar_path = os.path.join(sess_dir, sname + ".cookies")
jar = http.cookiejar.MozillaCookieJar(jar_path)
if cfg.get("reset_session"):
    try: os.remove(jar_path)
    except OSError: pass
else:
    try: jar.load(ignore_discard=True, ignore_expires=True)
    except Exception: pass

chain = []
class Recorder(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        chain.append({"status": code, "url": req.full_url, "location": newurl})
        if cfg.get("follow", True):
            return super().redirect_request(req, fp, code, msg, headers, newurl)
        return None

opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(jar),
    urllib.request.HTTPSHandler(context=ssl._create_unverified_context()),
    Recorder())

method = str(cfg.get("method") or "GET").upper()
headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) htb-llm-unofficial"}
for k, v in (cfg.get("headers") or {}).items():
    headers[str(k)] = str(v)
data = None
if cfg.get("json") is not None:
    data = json.dumps(cfg["json"]).encode()
    headers.setdefault("Content-Type", "application/json")
elif cfg.get("form") is not None:
    data = urllib.parse.urlencode({str(k): str(v) for k, v in dict(cfg["form"]).items()}).encode()
    headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
elif cfg.get("data") is not None:
    data = str(cfg["data"]).encode()
    if cfg.get("content_type"):
        headers.setdefault("Content-Type", str(cfg["content_type"]))

req = urllib.request.Request(str(cfg["url"]), data=data, headers=headers, method=method)
t0 = time.monotonic()
try:
    resp = opener.open(req, timeout=float(cfg.get("timeout") or 20))
except urllib.error.HTTPError as e:
    resp = e
except Exception as e:
    emit({"ok": False, "error": f"{type(e).__name__}: {e}", "session": sname, "chain": chain})

MAX = 5 * 1024 * 1024
try:
    raw = resp.read(MAX + 1)
except http.client.IncompleteRead as e:
    raw = e.partial or b""
except Exception as e:
    emit({"ok": False, "error": f"чтение тела: {type(e).__name__}: {e}", "session": sname, "chain": chain})
truncated_dl = len(raw) > MAX
raw = raw[:MAX]
hdrs = resp.headers
try: jar.save(ignore_discard=True, ignore_expires=True)
except Exception: pass

ctype = hdrs.get("Content-Type", "") if hdrs else ""
m = re.search(r"charset=([A-Za-z0-9_.-]+)", ctype)
charset = m.group(1) if m else "utf-8"
textual_type = any(x in ctype.lower() for x in ("text/", "json", "xml", "javascript", "xhtml", "urlencoded"))
is_text = textual_type or (b"\x00" not in raw[:512])
text = raw.decode(charset, "replace") if is_text else ""
title = ""
if is_text and "html" in ctype.lower():
    tm = re.search(r"<title[^>]*>(.*?)</title>", text[:20000], re.I | re.S)
    if tm: title = re.sub(r"\s+", " ", tm.group(1)).strip()[:200]

saved = None
want_save = bool(cfg.get("save_to")) or len(raw) > 6000 or not is_text
if want_save and raw:
    if cfg.get("save_to"):
        sp = os.path.realpath(os.path.join(work, str(cfg["save_to"]).lstrip("/")))
        if not (sp == work or sp.startswith(work + "/")):
            emit({"ok": False, "error": "save_to выходит за /work", "session": sname})
    else:
        ext = ".txt" if is_text else ".bin"
        sp = os.path.join(sess_dir, time.strftime("body-%Y%m%d-%H%M%S-") + os.urandom(3).hex() + ext)
    try:
        os.makedirs(os.path.dirname(sp), exist_ok=True)
        with open(sp, "wb") as f: f.write(raw)
        saved = sp
    except OSError:
        saved = None

set_cookies = []
if hdrs:
    for v in hdrs.get_all("Set-Cookie") or []:
        set_cookies.append(str(v).split("=", 1)[0].strip())
headers_out = []
if hdrs:
    for k, v in hdrs.items():
        if k.lower() == "set-cookie": continue
        headers_out.append([str(k), str(v)[:300]])
        if len(headers_out) >= 50: break

emit({
  "ok": True, "session": sname, "method": method,
  "status": resp.getcode(), "reason": str(getattr(resp, "msg", "") or ""),
  "final_url": resp.geturl(), "chain": chain,
  "headers": headers_out, "set_cookies": set_cookies,
  "jar": [{"name": c.name, "domain": c.domain} for c in jar],
  "content_type": ctype, "body_len": len(raw), "truncated_download": truncated_dl,
  "body_saved": saved, "is_text": is_text, "title": title,
  "preview": text[:4000] if is_text else raw[:128].hex(" "),
  "elapsed_ms": int((time.monotonic() - t0) * 1000),
})
`;

export type HttpReqOpts = {
  method: string; url: string;
  headers?: Record<string, string>;
  data?: string; form?: Record<string, string>; json?: unknown; contentType?: string;
  follow?: boolean; session?: string; resetSession?: boolean;
  saveTo?: string; timeoutSec?: number;
};
export type HttpResult = {
  ok: boolean; error?: string; session: string; method?: string;
  status?: number; reason?: string; final_url?: string;
  chain?: { status: number; url: string; location: string }[];
  headers?: [string, string][]; set_cookies?: string[];
  jar?: { name: string; domain: string }[];
  content_type?: string; body_len?: number; truncated_download?: boolean;
  body_saved?: string | null; is_text?: boolean; title?: string;
  preview?: string; elapsed_ms?: number;
};

export async function httpRequest(taskId: string, o: HttpReqOpts, signal?: AbortSignal): Promise<HttpResult> {
  await ensure(taskId);
  const timeout = Math.min(60, Math.max(2, o.timeoutSec ?? 20));
  const cfg64 = Buffer.from(JSON.stringify({
    method: o.method, url: o.url, headers: o.headers ?? {},
    data: o.data ?? null, form: o.form ?? null, json: o.json ?? null, content_type: o.contentType ?? null,
    follow: o.follow !== false, session: o.session ?? "default", reset_session: !!o.resetSession,
    save_to: o.saveTo ?? null, timeout,
  })).toString("base64");
  const py64 = Buffer.from(HTTP_PY).toString("base64");
  const cmd = `echo ${py64} | base64 -d | python3 - ${cfg64}`;
  let s = "";
  const r = await execStream(taskId, cmd, timeout + 20, (d) => { s += d; }, signal);
  const line = s.split("\n").find((l) => l.startsWith("WHHTTP "));
  if (r.aborted) return { ok: false, error: "остановлено пользователем", session: o.session ?? "default" };
  if (!line) {
    const tail = cleanOutput(s).trim().slice(-400);
    return { ok: false, error: r.timedOut ? `таймаут ${timeout + 20} с` : `http-хелпер не ответил (exit ${r.exitCode})${tail ? `: ${tail}` : ""}`, session: o.session ?? "default" };
  }
  try { return JSON.parse(line.slice(7)) as HttpResult; }
  catch { return { ok: false, error: "битый ответ http-хелпера", session: o.session ?? "default" }; }
}

// ---------- вывод команды агента: очистка, голова+хвост в памяти, полный текст — файлом ----------
const HEAD_KEEP = 64 * 1024; // в памяти: начало и конец (в контекст модели идут их части)
const TAIL_KEEP = 64 * 1024;
const FILE_MAX = 64 * 1024 * 1024; // больше — в файле начало, пометка и конец
const PENDING_MAX = 64 * 1024;
export type CmdOutput = {
  head: string; // начало очищенного вывода (весь вывод, если total ≤ HEAD_KEEP)
  tail: string; // конец очищенного вывода
  total: number; // длина всего очищенного вывода, символов
  saved?: string; // путь в контейнере к полному выводу (/work/.whitehat/out-*.txt)
  savedNote?: string; // почему файл неполный или не сохранён
};
// Файл в /work/.whitehat. root контейнера управляет этой папкой: может подменить её симлинком наружу или
// заранее положить симлинк с именем будущего файла (сервер работает от пользователя хоста — запись пошла бы
// в его ~/.bashrc). Поэтому: папка открывается без перехода по симлинку и сверяется, файл создаётся через
// дескриптор папки (/proc/self/fd/N — подмена папки после проверки уже ничего не меняет) с O_EXCL|O_NOFOLLOW
// и случайным суффиксом имени.
function openOutputFile(taskId: string): { fd: number; name: string } {
  const work = fs.realpathSync(paths.taskWork(taskId));
  const dir = path.join(work, ".whitehat");
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(dir); } catch { /* нет — создадим */ }
  if (!st) { fs.mkdirSync(dir); st = fs.lstatSync(dir); }
  if (!st.isDirectory()) throw new Error("/work/.whitehat — не каталог");
  const K = fs.constants;
  const dfd = fs.openSync(dir, K.O_RDONLY | K.O_DIRECTORY | K.O_NOFOLLOW);
  try {
    let base = dir;
    try {
      const real = fs.readlinkSync(`/proc/self/fd/${dfd}`);
      if (real !== dir && !real.startsWith(work + path.sep)) throw new Error("/work/.whitehat указывает за пределы задачи");
      base = `/proc/self/fd/${dfd}`;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } // без /proc — обычный путь (O_NOFOLLOW всё равно)
    for (let i = 0; ; i++) {
      const name = `out-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}.txt`;
      try {
        return { fd: fs.openSync(path.join(base, name), K.O_WRONLY | K.O_CREAT | K.O_EXCL | K.O_NOFOLLOW, 0o644), name };
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" || i >= 5) throw e; }
    }
  } finally { fs.closeSync(dfd); }
}
class OutputSink {
  head = ""; tail = ""; total = 0;
  // неполная строка (ещё без \n) — своя у stdout и stderr: \r-перерисовки накладываются, когда строка закончится,
  // а строка из stderr не вклинивается в середину недописанной строки stdout
  private pending = ["", ""];
  private fd: number | null = null;
  private name = "";
  private fileChars = 0;
  private fileFull = false;
  private fileErr = "";
  constructor(private taskId: string, private command: string, private spillAt: number) {}
  push(raw: string, stderr = false) {
    const k = stderr ? 1 : 0;
    const s = this.pending[k] + raw;
    const nl = s.lastIndexOf("\n");
    let p = s;
    if (nl >= 0) { p = s.slice(nl + 1); this.emit(cleanOutput(s.slice(0, nl + 1))); }
    if (p.length > PENDING_MAX) {
      // длинная строка без \n: прогресс-бар (\r…\r…) — сворачиваем уже показанное; иначе — сбрасываем как есть
      const cr = p.lastIndexOf("\r", p.length - 2);
      if (cr > 0) p = cleanOutput(p.slice(0, cr)) + p.slice(cr);
      if (p.length > PENDING_MAX) { this.emit(cleanOutput(p)); p = ""; }
    }
    this.pending[k] = p;
  }
  private emit(t: string) {
    if (!t) return;
    if (this.fd === null && !this.fileErr && this.total + t.length > this.spillAt) {
      try {
        const f = openOutputFile(this.taskId);
        this.fd = f.fd; this.name = f.name;
        this.write(`$ ${this.command}\n${this.head}`); // всё, что было до сих пор (total ≤ spillAt < HEAD_KEEP)
      } catch (e) { this.fileErr = (e as Error).message; }
    }
    if (this.fd !== null) this.write(t);
    this.total += t.length;
    if (this.head.length < HEAD_KEEP) this.head += t.slice(0, HEAD_KEEP - this.head.length);
    this.tail = t.length >= TAIL_KEEP ? t.slice(-TAIL_KEEP) : (this.tail + t).slice(-TAIL_KEEP);
  }
  private write(t: string) {
    if (this.fd === null || this.fileFull) return;
    const room = FILE_MAX - this.fileChars;
    const part = t.length > room ? t.slice(0, room) : t;
    try { fs.writeSync(this.fd, part); } catch (e) { this.fileErr = (e as Error).message; this.fileFull = true; return; }
    this.fileChars += part.length;
    if (part.length < t.length) this.fileFull = true;
  }
  finish(): CmdOutput {
    for (const k of [0, 1]) if (this.pending[k]) { this.emit(cleanOutput(this.pending[k])); this.pending[k] = ""; }
    const r: CmdOutput = { head: this.head, tail: this.tail, total: this.total };
    if (this.fd !== null) {
      if (this.fileFull && !this.fileErr) {
        // в файле начало (FILE_MAX) — дописываем пометку и настоящий конец
        const written = this.fileChars - (this.command.length + 3);
        const tailFrom = Math.max(written, this.total - this.tail.length);
        const skipped = tailFrom - written;
        const end = this.tail.slice(this.tail.length - (this.total - tailFrom));
        try { fs.writeSync(this.fd, `\n…[в файл не записано ${skipped} символов из середины: вывод больше ${FILE_MAX / 1024 ** 2} МБ]…\n${end}`); } catch { /* ignore */ }
        r.savedNote = `в файле начало и конец, ${skipped} символов из середины не сохранено`;
      } else if (this.fileErr) r.savedNote = `файл неполный: ${this.fileErr}`;
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
      r.saved = `/work/.whitehat/${this.name}`;
    } else if (this.fileErr) r.savedNote = `полный вывод не сохранён: ${this.fileErr}`;
    return r;
  }
}

// Команда агента: печатается в терминал агента «как будто набирается», вывод идёт вживую.
export type AgentCmdResult = ExecResult & { out: CmdOutput; secs: number };
export async function runAgentCommand(taskId: string, command: string, timeoutSec: number, signal?: AbortSignal): Promise<AgentCmdResult> {
  if (signal?.aborted) return { exitCode: 130, timedOut: false, aborted: true, out: { head: "", tail: "", total: 0 }, secs: 0 };
  await ensure(taskId);
  agentWrite(taskId, `\r\n${C.green}agent@task${C.reset}:${C.green}/work${C.reset}$ `);
  // «Печать» команды — только визуальный эффект: команда выполняется параллельно, вывод придерживается до конца печати.
  // Раньше команда ждала анимацию (до 1.2 с; heredoc — ~2 с) — в ходе с 7 командами это ~3 с впустую.
  let typing = true;
  const held: string[] = [];
  const typed = (async () => {
    const shown = Array.from(command.replace(/\n/g, "\r\n> ")); // по символам: суррогатные пары не режутся
    const frames = Math.max(1, Math.min(18, Math.ceil(command.length / 2))); // ≤18 кадров по ~16 мс ≈ 0.3 с
    const per = Math.ceil(shown.length / frames);
    for (let i = 0; i < shown.length; i += per) {
      agentWrite(taskId, shown.slice(i, i + per).join(""));
      await sleep(16);
    }
    agentWrite(taskId, "\r\n");
    typing = false; // дальше — синхронно, без await: новые данные не вклинятся между флагом и выдачей придержанного
    for (const d of held.splice(0)) agentWrite(taskId, crlf(d));
  })();
  const sink = new OutputSink(taskId, command, cfg.toolOutputChars);
  const t0 = Date.now();
  let r: ExecResult;
  try {
    r = await execStream(taskId, command, timeoutSec, (d, stderr) => {
      sink.push(d, stderr);
      if (typing) held.push(d);
      else agentWrite(taskId, crlf(d));
    }, signal);
  } catch (e) {
    await typed;
    sink.finish(); // закрыть файл вывода
    agentWrite(taskId, `${C.red}[ошибка: ${(e as Error).message}]${C.reset}\r\n`);
    throw e;
  }
  await typed;
  const out = sink.finish();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const tail = r.timedOut ? `[таймаут ${timeoutSec} с]` : r.aborted ? "[остановлено]" : r.exitCode !== 0 ? `[exit ${r.exitCode}${r.note ? ` — ${r.note}` : ""}]` : "";
  agentWrite(taskId, `${C.dim}${tail ? `${C.red}${tail}${C.dim} ` : ""}(${secs} с)${C.reset}\r\n`);
  return { ...r, out, secs: Number(secs) };
}

export function agentNote(taskId: string, text: string) {
  agentWrite(taskId, `${C.cyan}# ${crlf(text)}${C.reset}\r\n`);
}

// ---------- интерактивный терминал пользователя (WebSocket <-> docker exec tty <-> tmux) ----------
// Вкладка браузера — только клиент tmux-сессии wh-shell-<sid> внутри контейнера: отключение WS
// (перезагрузка страницы, уход на другую панель, рестарт веба) detach-ит клиент, а bash, listener
// и reverse shell в сессии живут дальше. Сессия умирает от явного закрытия вкладки (killUserShell),
// exit внутри неё или пересоздания/остановки контейнера.
// mouse у tmux ВЫКЛЮЧЕНА сознательно: с mouse on терминал отдаёт drag мыши в tmux (его copy-mode),
// и обычное выделение с копированием в буфер браузера не работает. Скролл при этом — scrollback xterm.
export const shellSessionName = (sid: unknown) => `wh-shell-${shellSid(sid)}`;
export async function openUserShell(taskId: string, sid = 1) {
  const c = await ensure(taskId);
  const env = ["TERM=xterm-256color", "LANG=C.UTF-8", ...vpnEnv(taskId), ...targetEnv(taskId)];
  const envArgs = env.filter((e) => !e.startsWith("TERM=") && !e.startsWith("LANG=")).map((e) => ` -e ${shq(e)}`).join("");
  const sname = shellSessionName(sid);
  const script = `tmux start-server 2>/dev/null; tmux set -g history-limit 10000 2>/dev/null; tmux has-session -t ${sname} 2>/dev/null || tmux new-session -d -s ${sname} -c /work${envArgs} 'bash -l'; tmux set -t ${sname} status off 2>/dev/null; tmux set -t ${sname} mouse off 2>/dev/null; mkdir -p /work/.whitehat; [ "$(tmux display-message -p -t ${sname} '#{pane_pipe}' 2>/dev/null)" = "1" ] || tmux pipe-pane -t ${sname} 'stdbuf -o0 cat >> /work/.whitehat/shell-${shellSid(sid)}.log' 2>/dev/null; exec tmux attach-session -t ${sname}`;
  let ex: Docker.Exec, stream: NodeJS.ReadWriteStream;
  try {
    ex = await c.exec({
      Cmd: ["bash", "-lc", script],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: "/work",
      Env: ["TERM=xterm-256color", "LANG=C.UTF-8", ...vpnEnv(taskId), ...targetEnv(taskId)],
    });
    stream = await ex.start({ hijack: true, stdin: true, Tty: true } as any);
  } catch (e) { throw dockerError(e); }
  // Поток tty — сырые байты. Декодер с состоянием: 'data' отдаёт строки, и символ на границе кусков не бьётся
  // (раньше b.toString() на каждый кусок давал «��» в xterm и в user-terminal.log).
  stream.setEncoding("utf8");
  return {
    stream,
    resize: (cols: number, rows: number) => ex.resize({ w: cols, h: rows }).catch(() => {}),
  };
}

// Явное закрытие вкладки shell в UI: убить tmux-сессию и все её процессы.
export async function killUserShell(taskId: string, sid = 1) {
  if ((await status(taskId)) !== "running") return; // контейнер остановлен — сессий уже нет
  const c = await ensure(taskId);
  try {
    // pipe-pane-лог панели честнее снимка (в нём полноэкранные программы вырезаются при чтении);
    // capture-pane — только если такого лога нет, и не для полноэкранной программы.
    const paneLog = path.join(paths.taskWork(taskId), ".whitehat", `shell-${shellSid(sid)}.log`);
    if (!fs.existsSync(paneLog)) {
      const alt = (await execRaw(c, `tmux display-message -p -t ${shellSessionName(sid)} '#{alternate_on}' 2>/dev/null || true`, 8000)).trim();
      const shot = alt === "1"
        ? "[полноэкранная программа (vim/less/htop/man…) — её экран не записывается]"
        : (await execRaw(c, `tmux capture-pane -p -J -S -160 -t ${shellSessionName(sid)} 2>/dev/null || true`, 8000)).replace(/[ \t]+\n/g, "\n").trim();
      if (shot) userLogWrite(taskId, `${SHELL_CAPTURE_MARK}${shot}\n`, shellSid(sid));
    }
  } catch { /* снимок не удался — всё равно закрываем */ }
  await execRaw(c, `tmux kill-session -t ${shellSessionName(sid)} 2>/dev/null || true`, 8000);
}

// ---------- фоновые jobs: tmux-сессии wh-job-<id> в контейнере задачи ----------

export type JobInfo = { id: string; task_id: string; name: string; command: string; created_at: number; running: boolean };
type JobRow = Omit<JobInfo, "running"> & { last_output: string };
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const jobSessionName = (id: string) => `wh-job-${id}`;
export function getJob(taskId: string, id: string): JobRow | undefined {
  if (!JOB_ID_RE.test(id)) return undefined;
  return db.prepare("select * from jobs where task_id=? and id=?").get(taskId, id) as JobRow | undefined;
}
async function liveTmuxSessions(taskId: string): Promise<Set<string>> {
  if ((await status(taskId).catch(() => "missing")) !== "running") return new Set();
  try {
    const out = await execRaw(docker.getContainer(cname(taskId)), "tmux ls -F '#{session_name}' 2>/dev/null || true", 8000);
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch { return new Set(); }
}
export async function listJobs(taskId: string): Promise<JobInfo[]> {
  const rows = db.prepare("select * from jobs where task_id=? order by created_at").all(taskId) as JobRow[];
  const live = await liveTmuxSessions(taskId);
  return rows.map(({ last_output: _drop, ...r }) => ({ ...r, running: live.has(jobSessionName(r.id)) }));
}
export async function createJob(taskId: string, name: string, command: string): Promise<JobInfo> {
  const nm = name.trim().replace(/\s+/g, " ").slice(0, 80);
  const cmd = command.trim();
  if (!nm) throw new Error("нужно имя job");
  if (!cmd) throw new Error("нужна команда job");
  if (cmd.length > 8000) throw new Error("команда job слишком длинная");
  const id = crypto.randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "");
  db.prepare("insert into jobs(id,task_id,name,command,created_at) values(?,?,?,?,?)").run(id, taskId, nm, cmd, Date.now());
  try {
    const c = await ensure(taskId);
    const env = ["TERM=xterm-256color", "LANG=C.UTF-8", ...vpnEnv(taskId), ...targetEnv(taskId)];
    const envArgs = env.filter((e) => !e.startsWith("TERM=") && !e.startsWith("LANG=")).map((e) => ` -e ${shq(e)}`).join("");
    const inner = `${cmd}\n__wh_rc=$?; echo "[whitehat: команда завершилась rc=$__wh_rc; сессия осталась интерактивным shell]"; exec bash -l`;
    const shellCmd = `bash -lc ${shq(inner)}`;
    const sname = jobSessionName(id);
    const script = `tmux start-server 2>/dev/null; tmux set -g history-limit 10000 2>/dev/null; tmux set -g status off 2>/dev/null; tmux kill-session -t ${sname} 2>/dev/null; tmux new-session -d -s ${sname} -c /work${envArgs} ${shq(shellCmd)} && tmux has-session -t ${sname} && echo whitehat-job-ok`;
    const out = await execRaw(c, script, 15_000);
    if (!out.includes("whitehat-job-ok")) throw new Error("tmux не запустил сессию job");
  } catch (e) {
    db.prepare("delete from jobs where id=?").run(id);
    throw e;
  }
  return { id, task_id: taskId, name: nm, command: cmd, created_at: Date.now(), running: true };
}
// Модель регулярно зовёт job_* с выдуманным или устаревшим id (в логах — «нет такого job» впустую).
// Сразу подсказываем реальные id, чтобы исправилась за один раунд, а не гадала.
function jobNotFound(taskId: string, id: string): Error {
  const rows = db.prepare("select id, name from jobs where task_id=? order by created_at").all(taskId) as { id: string; name: string }[];
  const list = rows.length ? `Существующие job этой задачи: ${rows.map((r) => `${r.id} «${r.name}»`).join(", ")}.` : "Job-ов у этой задачи нет — создай через job_start.";
  return new Error(`нет такого job: ${id}. ${list}`);
}
export async function jobOutput(taskId: string, id: string, lines = 160): Promise<{ job: JobInfo; output: string }> {
  const row = getJob(taskId, id);
  if (!row) throw jobNotFound(taskId, id);
  const n = Math.max(10, Math.min(1000, Math.trunc(lines) || 160));
  let output = row.last_output || "";
  let running = false;
  if ((await status(taskId).catch(() => "missing")) === "running") {
    const c = docker.getContainer(cname(taskId));
    const live = await liveTmuxSessions(taskId);
    running = live.has(jobSessionName(id));
    if (running) {
      output = (await execRaw(c, `tmux capture-pane -p -J -S -${n} -t ${jobSessionName(id)} 2>/dev/null || true`, 8000))
        .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      db.prepare("update jobs set last_output=? where id=?").run(output.slice(-200_000), id);
    }
  }
  const { last_output: _drop, ...job } = row;
  return { job: { ...job, running }, output };
}
export async function jobInput(taskId: string, id: string, text: string, enter = true): Promise<JobInfo> {
  const row = getJob(taskId, id);
  if (!row) throw jobNotFound(taskId, id);
  if ((await status(taskId).catch(() => "missing")) !== "running") throw new Error("контейнер задачи не запущен");
  const c = await ensure(taskId);
  const sname = jobSessionName(id);
  const script = `tmux send-keys -t ${sname} -l -- ${shq(text)}${enter ? ` && tmux send-keys -t ${sname} Enter` : ""}`;
  await execRaw(c, script, 8000);
  const { job } = await jobOutput(taskId, id, 40);
  if (!job.running) throw new Error("job не запущен");
  return job;
}
export async function stopJob(taskId: string, id: string): Promise<JobInfo> {
  const row = getJob(taskId, id);
  if (!row) throw jobNotFound(taskId, id);
  if ((await status(taskId).catch(() => "missing")) === "running") {
    await jobOutput(taskId, id, 200).catch(() => {}); // снимок вывода перед остановкой
    const c = await ensure(taskId);
    await execRaw(c, `tmux kill-session -t ${jobSessionName(id)} 2>/dev/null || true`, 8000);
  }
  const { last_output: _drop, ...job } = getJob(taskId, id)!;
  return { ...job, running: false };
}
export async function deleteJob(taskId: string, id: string) {
  if (!getJob(taskId, id)) throw jobNotFound(taskId, id);
  await stopJob(taskId, id).catch(() => {});
  db.prepare("delete from jobs where task_id=? and id=?").run(taskId, id);
}

// ---------- файлы /work для вкладки «Файлы» ----------

export type WorkFile = { path: string; name: string; dir: boolean; size: number; mtime: number };
export function listWorkFiles(taskId: string): WorkFile[] {
  const root = ensureWorkspace(taskId);
  const out: WorkFile[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (out.length >= 1000 || depth > 10) return;
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= 1000) return;
      if (!rel && e.name === ".whitehat") continue; // служебное: VPN-конфиг и полные выводы — не для файлового браузера
      if (e.isSymbolicLink()) continue; // симлинки не показываем и не отдаём
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      if (e.isDirectory()) {
        out.push({ path: r, name: e.name, dir: true, size: 0, mtime: st.mtimeMs });
        walk(full, r, depth + 1);
      } else if (e.isFile()) {
        out.push({ path: r, name: e.name, dir: false, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, "", 0);
  return out;
}
function resolveWorkFile(taskId: string, relRaw: string) {
  const rel0 = String(relRaw ?? "").trim();
  if (!rel0 || rel0.includes("\0") || rel0.includes("\\") || path.posix.isAbsolute(rel0)) throw new Error("недопустимый путь файла");
  const rel = path.posix.normalize(rel0);
  const parts = rel.split("/");
  if (rel === "." || parts.includes("..") || parts[0] === ".whitehat") throw new Error("недопустимый путь файла");
  const root = fs.realpathSync(paths.taskWork(taskId));
  const full = path.join(root, ...parts);
  let st: fs.Stats;
  try { st = fs.lstatSync(full); } catch { throw new Error("файл не найден"); }
  if (st.isSymbolicLink()) throw new Error("симлинки не отдаём");
  const real = fs.realpathSync(full);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error("недопустимый путь файла");
  if (!st.isFile()) throw new Error("это не файл");
  return { path: rel, rel, size: st.size, mtime: st.mtimeMs };
}
// Чтение через контейнер: файлы создаёт root (0600), с хоста сервер их может не прочитать.
export async function readWorkFile(taskId: string, relRaw: string, maxBytes = 25 * 1024 * 1024) {
  const r = resolveWorkFile(taskId, relRaw);
  if (r.size > maxBytes) throw new Error(`файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ — скачай его из shell (scp/base64 частями)`);
  if ((await status(taskId).catch(() => "missing")) !== "running") throw new Error("контейнер задачи не запущен");
  const c = await ensure(taskId);
  const out = await execRaw(c, `base64 -w0 -- ${shq(`/work/${r.rel}`)}`, 30_000);
  const bytes = Buffer.from(out.replace(/\s/g, ""), "base64");
  return { ...r, bytes };
}
export async function previewWorkFile(taskId: string, relRaw: string) {
  const r = resolveWorkFile(taskId, relRaw);
  if (r.size > 256 * 1024) return { ...r, binary: true, tooLarge: true, text: "" };
  const f = await readWorkFile(taskId, relRaw, 256 * 1024);
  const binary = f.bytes.subarray(0, 4096).includes(0);
  return { ...r, binary, tooLarge: false, text: binary ? "" : f.bytes.toString("utf8") };
}

// История команд пользователя (bash пишет её в /work/.bash_history после каждой команды).
// Файл создаёт root контейнера с правами 0600 — с хоста не прочитать, поэтому читаем изнутри.
export async function userHistory(taskId: string, limit = 30) {
  if ((await status(taskId)) !== "running") return [] as { ts: number | null; cmd: string }[];
  const r = await execCollect(taskId, "test -f /work/.bash_history && tail -n 2000 /work/.bash_history || true", 10);
  const lines = r.output.split("\n");
  const out: { ts: number | null; cmd: string }[] = [];
  let ts: number | null = null;
  for (const l of lines) {
    const m = /^#(\d{9,})$/.exec(l);
    if (m) { ts = Number(m[1]) * 1000; continue; }
    if (l.trim() && !/^\s*exit\s*$/.test(l)) out.push({ ts, cmd: l }); // exit шлёт сервер при закрытии вкладки
    ts = null;
  }
  return out.slice(-limit);
}

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------- VPN внутри контейнера (HTB и лабы): OpenVPN/WireGuard, обратные соединения, SOCKS для хоста ----------
// Конфиг задачи лежит на хосте в work/.whitehat/vpn и виден из контейнера как /work/.whitehat/vpn.
// Рантайм (pid, лог, бэкап resolv.conf) — в /tmp контейнера: при пересоздании контейнера честно пропадает.
// Туннель живёт в netns контейнера, поэтому цели из VPN стучатся напрямую на tun-адрес контейнера (любой порт).
export type VpnKind = "openvpn" | "wireguard";
export type VpnConfigInfo = { name: string; kind: VpnKind; uploadedAt: number; proto?: "tcp" | "udp" | null };
export type VpnStatus = {
  state: "down" | "connecting" | "up";
  iface?: string;
  ip?: string;
  log: string[];
  socks: { running: boolean; url?: string };
};
const VPN_RT = "/tmp/whitehat-vpn";
const VPN_WORK = "/work/.whitehat/vpn";
const DOWN: VpnStatus = { state: "down", log: [], socks: { running: false } };

const vpnCache = new Map<string, { at: number; status: VpnStatus }>();
// Синхронный взгляд в кэш для env команд: без exec (execStream сам обслуживает VPN-скрипты — была бы рекурсия).
function vpnEnv(taskId: string): string[] {
  const s = vpnCache.get(taskId)?.status;
  return s?.state === "up" && s.ip ? [`LHOST=${s.ip}`, `WH_VPN_IFACE=${s.iface ?? "tun0"}`] : [];
}
const setVpnCache = (taskId: string, status: VpnStatus) => { vpnCache.set(taskId, { at: Date.now(), status }); return status; };

// Операции с VPN одной задачи — строго по очереди (двойной клик «подключить», удаление конфига на лету)
const vpnLocks = new Map<string, Promise<unknown>>();
function withVpnLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prev = vpnLocks.get(taskId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  vpnLocks.set(taskId, run.catch(() => {}));
  return run;
}

const vpnFile = (kind: VpnKind) => (kind === "wireguard" ? "wg0.conf" : "config.ovpn");
const isPlainFile = (p: string) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
function writeNoFollow(p: string, data: string | Buffer, mode: number) {
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, data); fs.fchmodSync(fd, mode); } finally { fs.closeSync(fd); }
}
// Каталог конфига внутри /work управляется и root'ом контейнера: симлинк на месте .whitehat/vpn — отказ, а не запись наружу.
function ensureVpnDir(taskId: string): string {
  const work = paths.taskWork(taskId);
  fs.mkdirSync(work, { recursive: true });
  for (const d of [path.join(work, ".whitehat"), paths.vpnDir(taskId)]) {
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(d); } catch { /* нет — создадим ниже */ }
    if (st && !st.isDirectory()) throw new Error(`${path.relative(work, d)} в /work — не каталог (симлинк?): убери его из контейнера и повтори`);
    if (!st) fs.mkdirSync(d, { recursive: true });
  }
  return paths.vpnDir(taskId);
}

export function getVpnConfig(taskId: string): VpnConfigInfo | null {
  try {
    const dir = paths.vpnDir(taskId);
    const metaP = path.join(dir, "meta.json");
    if (!isPlainFile(metaP)) return null;
    const m = JSON.parse(fs.readFileSync(metaP, "utf8")) as Partial<VpnConfigInfo>;
    if ((m.kind !== "openvpn" && m.kind !== "wireguard") || typeof m.name !== "string") return null;
    if (!isPlainFile(path.join(dir, vpnFile(m.kind)))) return null;
    let proto: "tcp" | "udp" | null = m.proto === "tcp" || m.proto === "udp" ? m.proto : null;
    if (proto === null && m.kind === "openvpn") {
      try { proto = ovpnProto(fs.readFileSync(path.join(dir, vpnFile(m.kind)), "utf8")); } catch { /* останется null */ }
    }
    return { name: m.name.slice(0, 120), kind: m.kind, uploadedAt: Number(m.uploadedAt) || 0, proto };
  } catch { return null; }
}

// DNS от VPN-сервера: openvpn up/down-скрипты. /etc/resolv.conf в Docker — bind-mount одного файла:
// заменять можно только содержимое (cat >), не сам файл. Оригинал сохраняется и возвращается в down/стопе.
const VPN_UP_SH = `#!/bin/sh
BAK=${VPN_RT}/resolv.conf.bak
mkdir -p ${VPN_RT}
[ -f "$BAK" ] || cp /etc/resolv.conf "$BAK" 2>/dev/null
dns=""
i=1
while :; do
  eval "opt=\\$foreign_option_$i"
  [ -z "$opt" ] && break
  case "$opt" in "dhcp-option DNS "*) dns="$dns \${opt#dhcp-option DNS }" ;; esac
  i=$((i+1))
done
if [ -n "$dns" ]; then
  { for d in $dns; do echo "nameserver $d"; done; cat "$BAK" 2>/dev/null; } > ${VPN_RT}/resolv.conf.new && cat ${VPN_RT}/resolv.conf.new > /etc/resolv.conf
fi
# Сервер пушит tun-mtu 1500, а реальный путь внутри сети лаб режет пакеты уже с ~1400 байт:
# полноразмерные TCP-сегменты молча умирают (PMTUD-дыра — ICMP frag-needed не доходит),
# страницы через SOCKS висят минутами при живом ping. Замерено на HTB: 1400 не проходит, 1328 — да.
# MTU 1280 с запасом ниже порога; очередь — чтобы локальный burst не дропался в tun.
[ -n "$1" ] && ip link set dev "$1" mtu 1280 txqueuelen 2000 2>/dev/null
exit 0
`;
const VPN_DOWN_SH = `#!/bin/sh
BAK=${VPN_RT}/resolv.conf.bak
[ -f "$BAK" ] && cat "$BAK" > /etc/resolv.conf && rm -f "$BAK"
exit 0
`;

// Транспорт OpenVPN-конфига: TCP-туннель под нагрузкой браузера деградирует (TCP-over-TCP),
// UI предупреждает и советует UDP-конфиг. Явный proto или суффикс в remote-строке.
function ovpnProto(text: string): "tcp" | "udp" | null {
  const m = /^[ \t]*proto[ \t]+(tcp|udp)/im.exec(text) ?? /^[ \t]*remote[ \t]+\S+[ \t]+\d+[ \t]+(tcp|udp)/im.exec(text);
  return m ? (m[1].toLowerCase() as "tcp" | "udp") : null;
}

export async function saveVpnConfig(taskId: string, name: string, buf: Buffer): Promise<VpnConfigInfo> {
  if (!buf.length) throw new Error("пустой файл конфига");
  if (buf.length > 1024 * 1024) throw new Error("конфиг VPN больше 1 МБ — это не конфиг");
  const text = buf.toString("utf8");
  if (text.includes("\0")) throw new Error("конфиг VPN должен быть текстовым (.ovpn или .conf)");
  const kind: VpnKind | null = /^\s*\[Interface\]/m.test(text) && /^\s*\[Peer\]/m.test(text) ? "wireguard"
    : /(^|\n)\s*(client|remote\s+\S+|dev\s+tun|proto\s+(udp|tcp))/i.test(text) ? "openvpn" : null;
  if (!kind) throw new Error("не похоже на конфиг OpenVPN (.ovpn) или WireGuard (.conf): не нашёл ни remote/client, ни [Interface]/[Peer]");
  return withVpnLock(taskId, async () => {
    const st = await vpnStatus(taskId).catch(() => DOWN);
    if (st.state !== "down") throw new Error("VPN сейчас подключён или подключается — останови его перед заменой конфига");
    const dir = ensureVpnDir(taskId);
    writeNoFollow(path.join(dir, vpnFile(kind)), buf, 0o600);
    writeNoFollow(path.join(dir, "wh-up.sh"), VPN_UP_SH, 0o700);
    writeNoFollow(path.join(dir, "wh-down.sh"), VPN_DOWN_SH, 0o700);
    fs.rmSync(path.join(dir, vpnFile(kind === "openvpn" ? "wireguard" : "openvpn")), { force: true });
    const info: VpnConfigInfo = { name: name.replace(/[\r\n]+/g, " ").trim().slice(0, 120) || vpnFile(kind), kind, uploadedAt: Date.now(), proto: kind === "openvpn" ? ovpnProto(text) : null };
    writeNoFollow(path.join(dir, "meta.json"), JSON.stringify(info), 0o644);
    agentNote(taskId, `VPN: импортирован конфиг «${info.name}» (${kind}) — подключение во вкладке VPN`);
    return info;
  });
}

export async function containerIp(taskId: string): Promise<string | null> {
  try {
    const i = await docker.getContainer(cname(taskId)).inspect();
    const nets = i.NetworkSettings?.Networks ?? {};
    return nets[SANDBOX_NET]?.IPAddress || Object.values(nets)[0]?.IPAddress || null;
  } catch { return null; }
}

const VPN_STATUS_SH = [
  `ip -o -4 addr show 2>/dev/null | awk '$2 ~ /^(tun|wg)/ {split($4,a,"/"); print "WHIFACE", $2, a[1]}'`,
  `p=$(cat ${VPN_RT}/pid 2>/dev/null); case "$p" in ''|*[!0-9]*) ;; *) kill -0 "$p" 2>/dev/null && echo WHPID ;; esac`,
  `sp=$(cat ${VPN_RT}/socks.pid 2>/dev/null); case "$sp" in ''|*[!0-9]*) ;; *) kill -0 "$sp" 2>/dev/null && echo WHSOCKS ;; esac`,
  `command -v wg >/dev/null 2>&1 && wg show interfaces 2>/dev/null | tr ' ' '\\n' | sed 's/^/WHWG /'`,
  `tail -n 20 ${VPN_RT}/vpn.log 2>/dev/null | sed 's/^/WHLOG /'`,
].join("\n");

export async function vpnStatus(taskId: string): Promise<VpnStatus> {
  if ((await status(taskId)) !== "running") return setVpnCache(taskId, { ...DOWN, log: vpnCache.get(taskId)?.status.log ?? [] });
  const out = (await execCollect(taskId, VPN_STATUS_SH, 10)).output;
  const s: VpnStatus = { state: "down", log: [], socks: { running: false } };
  let pidAlive = false, wgSeen = false;
  for (const line of out.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "WHIFACE" && p[1] && p[2] && !s.ip) { s.iface = p[1]; s.ip = p[2]; }
    else if (p[0] === "WHPID") pidAlive = true;
    else if (p[0] === "WHWG" && p[1]) wgSeen = true;
    else if (p[0] === "WHSOCKS") s.socks.running = true;
    else if (line.startsWith("WHLOG ")) s.log.push(line.slice(6));
  }
  s.state = s.ip ? "up" : pidAlive || wgSeen ? "connecting" : "down";
  if (s.socks.running) {
    const ip = await containerIp(taskId);
    if (ip) s.socks.url = `socks5://${ip}:${cfg.socksPort}`;
  }
  return setVpnCache(taskId, s);
}
// Статус для агента и интерфейса: свежий из кэша, иначе один exec в контейнер.
export async function vpnStatusCached(taskId: string, ttlMs = 15_000): Promise<VpnStatus> {
  const c = vpnCache.get(taskId);
  if (c && Date.now() - c.at < ttlMs) return c.status;
  return vpnStatus(taskId).catch(() => c?.status ?? DOWN);
}

const whErr = (out: string) => out.split("\n").find((l) => l.startsWith("WHERR "))?.slice(6);
const NO_TUN = `[ -c /dev/net/tun ] || { echo "WHERR в контейнере нет /dev/net/tun — пересоздай контейнер (кнопка ↻ в шапке справа), файлы /work сохранятся"; exit 3; }`;

async function startVpnLocked(taskId: string): Promise<VpnStatus> {
  const info = getVpnConfig(taskId);
  if (!info) throw new Error("сначала импортируй конфиг VPN (.ovpn или .conf)");
  // up/down-скрипты переписываем при каждом подключении: задачи с конфигом времён старых версий получат фиксы (MTU) без переимпорта
  if (info.kind === "openvpn") {
    const dir = ensureVpnDir(taskId);
    writeNoFollow(path.join(dir, "wh-up.sh"), VPN_UP_SH, 0o700);
    writeNoFollow(path.join(dir, "wh-down.sh"), VPN_DOWN_SH, 0o700);
  }
  await ensure(taskId);
  agentNote(taskId, `VPN: подключаю «${info.name}» (${info.kind}) внутри контейнера…`);
  const script = info.kind === "wireguard" ? [
    `mkdir -p ${VPN_RT}`,
    NO_TUN,
    `command -v wg-quick >/dev/null || { echo "WHERR в образе нет wireguard-tools — пересобери образ Kali"; exit 3; }`,
    `wg show wg0 >/dev/null 2>&1 && { echo WHALREADY; exit 0; }`,
    // resolvconf в контейнере нет: DNS= из конфига wg-quick применить не сможет и упадёт — вырезаем с пометкой в лог
    `sed '/^[[:space:]]*DNS[[:space:]]*=/d' ${VPN_WORK}/wg0.conf > ${VPN_RT}/wg0.conf`,
    `{ echo "whitehat: DNS= из конфига WireGuard не применяется (нет resolvconf) — имена целей пиши в /etc/hosts"; wg-quick up ${VPN_RT}/wg0.conf; } > ${VPN_RT}/vpn.log 2>&1`,
    `echo "WHSTARTED rc=$?"`,
  ] : [
    `mkdir -p ${VPN_RT}`,
    NO_TUN,
    `command -v openvpn >/dev/null || { echo "WHERR в образе нет openvpn — пересобери образ Kali (bin/htb-llm start сам пересоберёт)"; exit 3; }`,
    `p=$(cat ${VPN_RT}/pid 2>/dev/null); case "$p" in ''|*[!0-9]*) p= ;; esac; [ -n "$p" ] && kill -0 "$p" 2>/dev/null && { echo WHALREADY; exit 0; }`,
    `: > ${VPN_RT}/vpn.log`,
    `openvpn --config ${VPN_WORK}/config.ovpn --cd ${VPN_WORK} --daemon --log ${VPN_RT}/vpn.log --writepid ${VPN_RT}/pid --script-security 2 --up ${VPN_WORK}/wh-up.sh --down ${VPN_WORK}/wh-down.sh --auth-nocache >>${VPN_RT}/vpn.log 2>&1`,
    `echo "WHSTARTED rc=$?"`,
  ];
  const out = (await execCollect(taskId, script.join("\n"), 30)).output;
  const err = whErr(out);
  if (err) { agentNote(taskId, `VPN: не вышло — ${err}`); throw new Error(err); }
  // ждём поднятия туннеля: openvpn может соединяться секунды; упавший процесс (плохой конфиг) виден по state=down
  const deadline = Date.now() + 25_000;
  let st = await vpnStatus(taskId);
  while (st.state === "connecting" && Date.now() < deadline) { await sleep(1000); st = await vpnStatus(taskId); }
  agentNote(taskId, st.state === "up" ? `VPN поднят: ${st.iface} ${st.ip} — обратные соединения (reverse shell, http-сервер) доступны целям на этом адресе, любой порт`
    : st.state === "connecting" ? "VPN ещё подключается — статус и лог во вкладке VPN" : "VPN не поднялся — причина в логе во вкладке VPN");
  return st;
}

async function stopVpnLocked(taskId: string): Promise<VpnStatus> {
  if ((await status(taskId)) !== "running") { vpnCache.delete(taskId); return DOWN; }
  const script = [
    `p=$(cat ${VPN_RT}/pid 2>/dev/null); case "$p" in ''|*[!0-9]*) p= ;; esac`,
    `[ -n "$p" ] && kill -TERM "$p" 2>/dev/null`,
    `wg-quick down ${VPN_RT}/wg0.conf >/dev/null 2>&1`,
    `for i in $(seq 1 50); do [ -n "$p" ] && kill -0 "$p" 2>/dev/null || break; sleep 0.1; done`,
    `[ -n "$p" ] && kill -KILL "$p" 2>/dev/null`,
    // down-скрипт openvpn при SIGTERM вернул resolv.conf сам; если дошло до KILL — возвращаем здесь
    `[ -f ${VPN_RT}/resolv.conf.bak ] && cat ${VPN_RT}/resolv.conf.bak > /etc/resolv.conf && rm -f ${VPN_RT}/resolv.conf.bak`,
    `rm -f ${VPN_RT}/pid`,
    `sp=$(cat ${VPN_RT}/socks.pid 2>/dev/null); case "$sp" in ''|*[!0-9]*) sp= ;; esac; [ -n "$sp" ] && kill "$sp" 2>/dev/null; rm -f ${VPN_RT}/socks.pid`,
    `echo WHSTOPPED`,
  ].join("\n");
  await execCollect(taskId, script, 20).catch(() => {});
  vpnCache.delete(taskId);
  agentNote(taskId, "VPN: отключён");
  return vpnStatus(taskId).catch(() => DOWN);
}

export const startVpn = (taskId: string) => withVpnLock(taskId, () => startVpnLocked(taskId));
export const stopVpn = (taskId: string) => withVpnLock(taskId, () => stopVpnLocked(taskId));

export async function deleteVpnConfig(taskId: string): Promise<void> {
  await withVpnLock(taskId, async () => {
    await stopVpnLocked(taskId).catch(() => {});
    fs.rmSync(paths.vpnDir(taskId), { recursive: true, force: true });
    vpnCache.delete(taskId);
    agentNote(taskId, "VPN: конфиг удалён");
  });
}

// SOCKS5 в контейнере на адресе eth0 (мост wh0): браузер и Burp на хосте ходят в сеть VPN через контейнер.
// Слушает только адрес моста — со стороны туннеля (от целей) прокси не виден.
export const startSocks = (taskId: string) => withVpnLock(taskId, async (): Promise<VpnStatus> => {
  await ensure(taskId);
  const ip = await containerIp(taskId);
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error("не нашёл IP контейнера в сети песочниц");
  const script = [
    `mkdir -p ${VPN_RT}`,
    `command -v microsocks >/dev/null || { echo "WHERR в образе нет microsocks — пересобери образ Kali"; exit 3; }`,
    `sp=$(cat ${VPN_RT}/socks.pid 2>/dev/null); case "$sp" in ''|*[!0-9]*) sp= ;; esac; [ -n "$sp" ] && kill -0 "$sp" 2>/dev/null && { echo WHALREADY; exit 0; }`,
    `nohup microsocks -i ${ip} -p ${cfg.socksPort} </dev/null >${VPN_RT}/socks.log 2>&1 & echo $! > ${VPN_RT}/socks.pid`,
    `sleep 0.3; kill -0 $(cat ${VPN_RT}/socks.pid) 2>/dev/null && echo WHSOCKSOK || { echo "WHERR microsocks не стартовал:"; cat ${VPN_RT}/socks.log; }`,
  ].join("\n");
  const out = (await execCollect(taskId, script, 15)).output;
  const err = whErr(out);
  if (err) throw new Error(err);
  vpnCache.delete(taskId);
  const st = await vpnStatus(taskId);
  agentNote(taskId, `SOCKS5 для браузера/Burp на хосте: ${st.socks.url ?? `socks5://${ip}:${cfg.socksPort}`}`);
  return st;
});
export const stopSocks = (taskId: string) => withVpnLock(taskId, async (): Promise<VpnStatus> => {
  if ((await status(taskId)) === "running")
    await execCollect(taskId, `sp=$(cat ${VPN_RT}/socks.pid 2>/dev/null); case "$sp" in ''|*[!0-9]*) sp= ;; esac; [ -n "$sp" ] && kill "$sp" 2>/dev/null; rm -f ${VPN_RT}/socks.pid; true`, 10).catch(() => {});
  vpnCache.delete(taskId);
  return vpnStatus(taskId).catch(() => DOWN);
});
