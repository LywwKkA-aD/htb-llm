import { nanoid } from "nanoid";
import * as sandbox from "./sandbox.ts";
import * as profile from "./profile.ts";
import { enumDigest } from "./shellhint.ts";

// Типизированная локальная энумерация после шелла: модель вручную собирала чеклист 3–4 раундами
// и пропускала звенья (Connected). Бандл уходит одним job_input в пойманную сессию, секции помечены
// маркерами с нонсом (эхо самой команды парсер отличает по равенству строки), вывод собирается
// поллингом job_output до конечного маркера и возвращается секциями + серверной выжимкой.
const SECTIONS: { name: string; title: string; cmd: string }[] = [
  { name: "id_os", title: "ID / хост / ОС", cmd: "id; hostname; uname -a; head -3 /etc/os-release 2>/dev/null" },
  { name: "sudo", title: "sudo -l (без запроса пароля)", cmd: "sudo -n -l 2>&1 | head -30" },
  { name: "suid", title: "SUID-бинари", cmd: "find / -xdev -perm -4000 -type f 2>/dev/null | head -60" },
  { name: "caps", title: "Capabilities", cmd: "getcap -r /usr/bin /usr/sbin /bin /sbin /opt 2>/dev/null | grep -v '=$' | head -30" },
  { name: "cron", title: "Cron: crontab и /etc/cron.d", cmd: "crontab -l 2>&1 | head -20; grep -Rhs . /etc/cron.d 2>/dev/null | grep -v '^#' | head -30; grep -v '^#' /etc/crontab 2>/dev/null | grep -v '^$'" },
  { name: "timers", title: "systemd-таймеры и incron", cmd: "systemctl list-timers --all --no-pager 2>/dev/null | head -25; ls /etc/incron.d /var/spool/incron 2>/dev/null" },
  { name: "procs", title: "Процессы (первые 40 строк ps)", cmd: "ps auxww 2>/dev/null | head -40" },
  { name: "net", title: "Слушающие порты (в т.ч. localhost)", cmd: "ss -tlnp 2>/dev/null | head -30 || netstat -tlnp 2>/dev/null | head -30" },
  { name: "writable", title: "Записываемое в /etc", cmd: "ls -ld /etc/passwd /etc/shadow /etc/sudoers 2>/dev/null; find /etc -maxdepth 2 -writable -type f 2>/dev/null | head -20" },
];

export type PrivescResult = { ok: boolean; error?: string; text: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runPrivescEnum(taskId: string, jobArg: string, timeoutSecRaw: number | undefined, signal?: AbortSignal): Promise<PrivescResult> {
  const arg = String(jobArg ?? "").trim();
  if (!arg) return { ok: false, error: "укажи job (id или имя сессии с пойманным шеллом)", text: "" };
  const jobs = await sandbox.listJobs(taskId).catch(() => []);
  const job = jobs.find((j) => j.id === arg || j.name === arg);
  if (!job) {
    const list = jobs.length ? jobs.map((j) => `${j.id} «${j.name}»${j.running ? "" : " (остановлен)"}`).join(", ") : "job нет";
    return { ok: false, error: `нет такого job: ${arg}; существующие: ${list}`, text: "" };
  }
  if (!job.running) return { ok: false, error: `job «${job.name}» не запущен — энумерация идёт в живую сессию шелла`, text: "" };
  const timeoutSec = Math.max(20, Math.min(240, Math.trunc(timeoutSecRaw ?? 0) || 90));
  const nonce = nanoid(6);
  const mark = (s: string) => `__WHPE_${nonce}_${s}__`;
  const parts = [`echo ${mark("START")}`];
  for (const s of SECTIONS) parts.push(`echo ${mark(`SEC_${s.name}`)}`, s.cmd);
  parts.push(`echo ${mark("END")}`);
  const t0 = Date.now();
  await sandbox.jobInput(taskId, job.id, parts.join("; "));
  let output = "";
  let done = false;
  while (Date.now() - t0 < timeoutSec * 1000) {
    if (signal?.aborted) return { ok: false, error: "остановлено пользователем", text: "" };
    await sleep(1500);
    output = (await sandbox.jobOutput(taskId, job.id, 600).catch(() => ({ output }))).output;
    if (output.split("\n").some((l) => l.trim() === mark("END"))) { done = true; break; }
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  // Разбор по маркерам: строки, в точности равные маркеру (эхо длинной команды не совпадает).
  const lines = output.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === mark("START"));
  const bySection = new Map<string, string[]>();
  if (startIdx >= 0) {
    let cur = "";
    for (const raw of lines.slice(startIdx + 1)) {
      const t = raw.trim();
      const sec = SECTIONS.find((s) => t === mark(`SEC_${s.name}`));
      if (sec) { cur = sec.name; bySection.set(cur, []); continue; }
      if (t === mark("END")) break;
      if (cur) bySection.get(cur)!.push(raw.replace(/\s+$/, ""));
    }
  }
  const clip = (s: string, n = 900) => (s.length > n ? `${s.slice(0, n)}\n…[обрезано]` : s);
  const blocks = SECTIONS.map((s) => {
    const body = (bySection.get(s.name) ?? []).join("\n").trim();
    return `== ${s.title} ==\n${body ? clip(body) : "(пусто)"}`;
  });
  // Факт в профиль: кто/где/какая ОС — один раз на уникальную связку.
  try {
    const idos = (bySection.get("id_os") ?? []).join("\n");
    const user = /uid=\d+\(([^)]+)\)/.exec(idos)?.[1] ?? "";
    const host = (bySection.get("id_os") ?? [])[1]?.trim() ?? "";
    const os = /PRETTY_NAME="?([^"\n]+)"?/.exec(idos)?.[1] ?? "";
    const kernel = /^Linux \S+ ([^ ]+)/m.exec(idos)?.[1] ?? "";
    if (user && host) {
      const text = `privesc_enum: ${user}@${host}${os ? `, ${os}` : ""}${kernel ? `, ядро ${kernel}` : ""}`;
      const have = profile.listProfile(taskId).some((i) => i.kind === "fact" && i.text === text);
      if (!have) profile.addProfileItem(taskId, "fact", { text, source: `privesc_enum job ${job.name}` });
    }
  } catch { /* профиль — не повод валить энумерацию */ }
  const digest = enumDigest(taskId, `privesc:${job.id}`, output);
  const head = done
    ? `[privesc_enum: job «${job.name}» · ${secs} с · секции обрезаны до ~900 символов, полный экран — job_output]`
    : `[privesc_enum: job «${job.name}» · не дождался конца бандла за ${timeoutSec} с — секции ниже частичные; возможно, шелл занят или find медленный. Досмотри job_output]`;
  return { ok: true, text: [head, ...blocks, digest].filter(Boolean).join("\n") };
}
