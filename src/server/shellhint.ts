// Детект пойманного reverse shell в выводе job (пакет 3, п.13): модель годами поллила пустой
// листенер и пропускала момент прилёта, а заметив — теряла раунды на стабилизацию. Сервер смотрит
// дельту job_output детерминированно: строка подключения листенера (OpenBSD nc: «Connection received
// on IP PORT», traditional nc: «connect to [..] from .. [IP]», ncat/socat аналогично), meterpreter-
// сессия msf или — только для job с листенер-командой — чужой шелл-промпт. Подсказка одна на каждое
// подключение (дедуп по подписи ip:port/промпта в памяти процесса), свой root-bash в job не триггерит.
// Отключается WH_SHELL_HINTS=off.

type Kind = "unix" | "windows" | "meterpreter";
type Catch = { sig: string; kind: Kind; evidence: string };

const CONNECT_RES: { rx: RegExp; sig: (m: RegExpExecArray) => string }[] = [
  { rx: /Connection received on (\d+\.\d+\.\d+\.\d+)\s+(\d+)/, sig: (m) => `conn:${m[1]}:${m[2]}` },
  { rx: /connect to \[[^\]]+\] from [^\n]*\[(\d+\.\d+\.\d+\.\d+)\]\s*(\d+)?/i, sig: (m) => `conn:${m[1]}:${m[2] ?? ""}` },
  { rx: /Ncat: Connection from (\d+\.\d+\.\d+\.\d+)(?::(\d+))?/i, sig: (m) => `conn:${m[1]}:${m[2] ?? ""}` },
  { rx: /accepting connection from (?:AF=\d+ )?(\d+\.\d+\.\d+\.\d+)[:\s](\d+)?/i, sig: (m) => `conn:${m[1]}:${m[2] ?? ""}` },
];
const METERPRETER_RE = /(Meterpreter session \d+ opened|Sending stage[^\n]*Meterpreter)/i;
const WIN_PROMPT_RE = /(?:^|\n)\s*(?:PS\s+)?[A-Z]:\\[^\n>]*>\s?$/m;
const WIN_BANNER_RE = /Microsoft Windows \[Version/i;
const UNIX_PROMPT_RE = /(?:^|\n)([a-z_][a-z0-9_-]*)@([a-z0-9._-]+):[^\n]*[$#]\s?$/m;
const SHELL_VER_PROMPT_RE = /(?:^|\n)((?:sh|bash)-\d+\.\d+\$)\s?$/m;
const LISTENER_CMD_RE = /\b(nc|ncat|netcat|socat|msfconsole|pwncat|penelope|rlwrap)\b/i;

const evidenceLine = (text: string, idx: number) => {
  const a = text.lastIndexOf("\n", idx) + 1;
  const b = text.indexOf("\n", idx);
  return text.slice(a, b < 0 ? undefined : b).trim().slice(0, 140);
};

export function detectCatch(text: string, listenerLike: boolean): Catch | null {
  const met = METERPRETER_RE.exec(text);
  if (met) return { sig: `msf:${met[1].toLowerCase()}`, kind: "meterpreter", evidence: evidenceLine(text, met.index) };
  for (const { rx, sig } of CONNECT_RES) {
    const m = rx.exec(text);
    if (m) {
      const kind: Kind = WIN_BANNER_RE.test(text) || WIN_PROMPT_RE.test(text) ? "windows" : "unix";
      return { sig: sig(m), kind, evidence: evidenceLine(text, m.index) };
    }
  }
  if (!listenerLike) return null;
  const win = WIN_PROMPT_RE.exec(text);
  if (win) return { sig: `winprompt:${evidenceLine(text, win.index)}`, kind: "windows", evidence: evidenceLine(text, win.index) };
  const ver = SHELL_VER_PROMPT_RE.exec(text);
  if (ver) return { sig: `prompt:${ver[1]}`, kind: "unix", evidence: evidenceLine(text, ver.index) };
  const unix = UNIX_PROMPT_RE.exec(text);
  if (unix && unix[1] !== "root") return { sig: `prompt:${unix[1]}@${unix[2]}`, kind: "unix", evidence: evidenceLine(text, unix.index) };
  return null;
}

const seen = new Map<string, Set<string>>();

// Подсказка для приклеивания к выводу job_output или "" (ничего нового не прилетело / уже подсказывали).
export function shellCatchHint(taskId: string, job: { id: string; name: string; command: string }, text: string): string {
  if (process.env.WH_SHELL_HINTS === "off" || !text) return "";
  try {
    const c = detectCatch(text, LISTENER_CMD_RE.test(job.command ?? ""));
    if (!c) return "";
    const key = `${taskId}:${job.id}`;
    let set = seen.get(key);
    if (!set) {
      if (seen.size > 100) seen.delete(seen.keys().next().value as string);
      set = new Set();
      seen.set(key, set);
    }
    if (set.has(c.sig)) return "";
    set.add(c.sig);
    if (set.size > 10) set.delete(set.values().next().value as string);
    if (c.kind === "meterpreter")
      return `[похоже, в job «${job.name}» открылась meterpreter-сессия (${c.evidence}). Проверь через job_input: getuid и sysinfo — шелл засчитан только по выводу getuid. Запиши доступ в profile_update kind=access и двигай пункт плана.]`;
    if (c.kind === "windows")
      return `[похоже, в job «${job.name}» прилетел Windows-shell (${c.evidence}). Проверь через job_input: whoami; hostname; ipconfig — шелл засчитан только по выводу whoami, один коннект ещё не доказательство. Запиши доступ в profile_update kind=access.]`;
    return `[похоже, в job «${job.name}» прилетел reverse shell (${c.evidence}). Сразу: 1) job_input «id; hostname; pwd» — шелл засчитан только когда виден вывод id, один коннект ещё не доказательство; 2) стабилизируй TTY: python3 -c 'import pty;pty.spawn("/bin/bash")' (нет python3 — script -qc /bin/bash /dev/null), затем export TERM=xterm SHELL=/bin/bash и stty rows 40 cols 160 — полноценный raw через Ctrl+Z тут недоступен, job_input шлёт строки; если шелл останется неудобным, подними второй листенер на socat с tty; 3) запиши доступ в profile_update kind=access и отметь пункт плана.]`;
  } catch {
    return "";
  }
}

// Детект зависшего промпта пароля в конце экрана job: модель запускает интерактивный sudo/su/ssh,
// а пароль отдельным вводом не шлёт — следующая обычная команда сгорает как попытка пароля
// (sudo даёт 3), а со стороны выглядит как «пароль не вводится». Подсказка не чаще раза в 2 минуты на job.
const PW_PROMPT_RES = [
  /\[sudo\] password for [^\n:]+:\s*$/,
  /^\s*Password:\s*$/m,
  /[\w.-]+@[\w.-]+'s password:\s*$/,
  /Enter password:\s*$/i,
];
const pwHintAt = new Map<string, number>();
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
export function passwordPromptHint(taskId: string, job: { id: string; name: string }, screen: string): string {
  if (process.env.WH_SHELL_HINTS === "off" || !screen) return "";
  try {
    const tail = stripAnsi(screen).slice(-600);
    const hit = PW_PROMPT_RES.find((rx) => rx.test(tail));
    if (!hit) return "";
    // промпт должен быть последним содержательным текстом экрана (ждёт ввода прямо сейчас)
    const m = hit.exec(tail);
    if (!m || tail.slice(m.index + m[0].length).trim().length > 0) return "";
    const key = `${taskId}:${job.id}`;
    const now = Date.now();
    if (now - (pwHintAt.get(key) ?? 0) < 120_000) return "";
    pwHintAt.set(key, now);
    if (pwHintAt.size > 100) pwHintAt.delete(pwHintAt.keys().next().value as string);
    const line = m[0].trim().slice(0, 80);
    return `[похоже, job «${job.name}» ждёт пароль (${line}). Отправь его ОДНИМ job_input только с паролем — ввод не отображается, это нормально. Следующая обычная команда сейчас станет попыткой пароля и сожжёт одну из трёх. Надёжнее без интерактива одной строкой: echo '<пароль>' | sudo -S <команда>. Если промпт от su/ssh в шелле без PTY — пароль читается из /dev/tty: сначала стабилизируй PTY.]`;
  } catch {
    return "";
  }
}

// Детект задачи расписания в выводе (Connected: модель видела cron, но цепочку исполнения не
// проследила и ушла в экзотику): строка crontab с путём скрипта, systemd-таймер или incron.
// Подсказка один раз на скрипт/строку в рамках scope (job или shell задачи), дедуп — общий seen.
const CRON_LINE_RE = /^[ \t]*((?:[\d*][\d*/,-]*[ \t]+){4}[\d*][\d*/,-]*|@(?:reboot|hourly|daily|weekly|monthly|yearly))[ \t]+(?:\w+[ \t]+)?(\S*\/\S+.*)$/m;
const TIMER_LINE_RE = /^.*\b([\w@.-]+\.timer)\s+([\w@.-]+\.service)\b.*$/m;
const INCRON_LINE_RE = /^[ \t]*(\/\S+)[ \t]+IN_\w+(?:,IN_\w+)*[ \t]+(\S*\/\S+.*)$/m;
export function cronChainHint(taskId: string, scope: string, text: string): string {
  if (process.env.WH_SHELL_HINTS === "off" || !text) return "";
  try {
    const plain = stripAnsi(text);
    const m = CRON_LINE_RE.exec(plain) ?? INCRON_LINE_RE.exec(plain) ?? TIMER_LINE_RE.exec(plain);
    if (!m) return "";
    const line = evidenceLine(plain, m.index);
    const scriptTok = (line.match(/\/[\w./-]+/) ?? [""])[0];
    const sig = `cron:${scriptTok || line}`;
    const key = `${taskId}:${scope}:cron`;
    let set = seen.get(key);
    if (!set) {
      if (seen.size > 100) seen.delete(seen.keys().next().value as string);
      set = new Set();
      seen.set(key, set);
    }
    if (set.has(sig)) return "";
    set.add(sig);
    if (set.size > 10) set.delete(set.values().next().value as string);
    return `[в выводе задача расписания (${line}). Это классический путь повышения через цепочку исполнения: прочитай скрипт целиком, выпиши всё, что он подключает (source/include/конфиги) и вызывает по PATH, и по каждому звену и его родительским папкам выполни namei -l <путь> — записываемое звено (файл ИЛИ папка над ним) даёт исполнение от владельца задачи. Вектор не закрывай по одному владельцу скрипта; реальные запуски сверь pspy.]`;
  } catch {
    return "";
  }
}

// Выжимка энумерации: linpeas и ручной enum-вывод модель простынёй не дочитывает (красные строки
// тонут в сотнях обычных; в capture-pane цветов и нет). Сервер выдёргивает строки-кандидаты по
// категориям векторов и показывает только новые для этого scope — без повторов на каждом поллинге.
const DIGEST_RULES: { cat: string; re: RegExp }[] = [
  { cat: "sudo", re: /NOPASSWD|^\s*\(\w[\w :]*\)\s+\// },
  { cat: "suid", re: /^-rws|\bsuid\b.*\//i },
  { cat: "caps", re: /cap_\w+(\+|=)/ },
  { cat: "cron", re: /^((?:[\d*][\d*/,-]*\s+){4}[\d*][\d*/,-]*|@(?:reboot|hourly|daily|weekly|monthly|yearly))\s+(?:\w+\s+)?\S*\// },
  { cat: "timer", re: /\b[\w@.-]+\.timer\s+[\w@.-]+\.service\b/ },
  { cat: "incron", re: /^\/?\S+\s+IN_\w+/ },
  { cat: "writable", re: /writable.*\/|\/.*writable/i },
  { cat: "groups", re: /groups=[^\n]*\((?:docker|disk|lxd|adm)\)/ },
  { cat: "nfs", re: /no_root_squash/ },
  { cat: "docker", re: /docker\.sock/ },
  { cat: "cve", re: /Vulnerable to CVE-|CVE-\d{4}-\d{4,7}.*(?:vulnerab|exploit)/i },
  { cat: "win", re: /SeImpersonatePrivilege|AlwaysInstallElevated/ },
];
export function enumDigest(taskId: string, scope: string, text: string): string {
  if (process.env.WH_SHELL_HINTS === "off" || !text) return "";
  try {
    const plain = stripAnsi(text);
    const lines = plain.split("\n");
    const hits: string[] = [];
    const cats = new Set<string>();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.length > 220) continue;
      for (const { cat, re } of DIGEST_RULES) if (re.test(line)) { hits.push(line.slice(0, 180)); cats.add(cat); break; }
      if (hits.length > 200) break;
    }
    const isLinpeas = /linpeas|Linux Privilege Escalation Awesome|LEGEND:/i.test(plain);
    if (!hits.length || (!isLinpeas && cats.size < 2)) return "";
    const key = `${taskId}:${scope}:digest`;
    let shown = seen.get(key);
    if (!shown) {
      if (seen.size > 100) seen.delete(seen.keys().next().value as string);
      shown = new Set();
      seen.set(key, shown);
    }
    const freshLines = [...new Set(hits)].filter((l) => !shown!.has(l));
    if (!freshLines.length) return "";
    for (const l of freshLines) shown.add(l);
    while (shown.size > 300) shown.delete(shown.values().next().value as string);
    const shownLines = freshLines.slice(0, 25);
    const more = freshLines.length > shownLines.length ? `\n…и ещё ${freshLines.length - shownLines.length} строк-кандидатов в полном выводе` : "";
    return `[серверная выжимка энумерации — строки-кандидаты на вектор, отработай каждую или закрой выводом, прежде чем искать дальше:\n${shownLines.join("\n")}${more}]`;
  } catch {
    return "";
  }
}
