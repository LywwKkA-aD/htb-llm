import * as sandbox from "./sandbox.ts";
import * as profile from "./profile.ts";

// Типизированная проверка кред (netexec): модель вручную строила «матрицы пароль × точка входа»
// циклами, жгла раунды и в новых чатах пробовала уже отвергнутые пары. Один вызов проверяет пару
// по сервисам (по умолчанию — из профиля цели), успехи пишет кредами в профиль, отказы — одной
// обновляемой факт-записью «не подошёл: …», чтобы негативы переживали чаты.
export const CRED_PROTOS = ["smb", "winrm", "ssh", "ftp", "mssql", "ldap", "rdp", "wmi", "vnc"] as const;
export type CredProto = (typeof CRED_PROTOS)[number];
const HASH_PROTOS = new Set<CredProto>(["smb", "winrm", "mssql", "ldap", "rdp", "wmi"]);
const PORT_PROTO: Record<number, CredProto> = {
  445: "smb", 139: "smb", 5985: "winrm", 5986: "winrm", 22: "ssh", 21: "ftp",
  1433: "mssql", 389: "ldap", 636: "ldap", 3389: "rdp", 135: "wmi", 5900: "vnc",
};
const HOST_RE = /^[A-Za-z0-9._-]+$/;

export type CredCheckOpts = {
  host?: string;
  username: string;
  secret: string;
  secretType?: string; // password | hash
  services?: string[];
};
export type CredResult = { proto: CredProto; status: "ok" | "fail" | "unknown"; line: string };
export type CredCheckResult = {
  ok: boolean; error?: string; hostLabel: string;
  results: CredResult[]; secs: number; savedCreds: number; negFact: boolean;
};

export function validateCredOpts(o: CredCheckOpts): string | null {
  if (!String(o.username ?? "").trim()) return "нужен username";
  if (String(o.username).length > 120) return "username длиннее 120 символов";
  if (!String(o.secret ?? "")) return "нужен secret (пароль или NTLM-хэш)";
  if (String(o.secret).length > 220) return "secret длиннее 220 символов";
  if (o.host !== undefined && o.host !== "$TARGET" && o.host !== "$TARGET_HOST" && !HOST_RE.test(o.host))
    return "host: только IP, имя хоста или $TARGET/$TARGET_HOST";
  const st = String(o.secretType ?? "password").toLowerCase();
  if (st !== "password" && st !== "hash") return "secret_type: password или hash";
  if (st === "hash" && !/^[0-9a-fA-F]{32}(:[0-9a-fA-F]{32})?$/.test(String(o.secret).trim()))
    return "для secret_type=hash нужен NTLM-хэш (32 hex или LM:NT)";
  for (const s of o.services ?? [])
    if (!CRED_PROTOS.includes(String(s).toLowerCase() as CredProto)) return `неизвестный сервис: ${s}; есть: ${CRED_PROTOS.join(", ")}`;
  return null;
}

function pickProtos(taskId: string, requested?: string[]): CredProto[] {
  if (requested?.length) return [...new Set(requested.map((s) => String(s).toLowerCase() as CredProto))];
  const fromProfile = new Set<CredProto>();
  for (const it of profile.listProfile(taskId))
    if (it.kind === "service" && it.port !== null && PORT_PROTO[it.port]) fromProfile.add(PORT_PROTO[it.port]);
  return fromProfile.size ? [...fromProfile] : ["smb", "ssh", "winrm", "ftp"];
}

export async function runCredCheck(taskId: string, o: CredCheckOpts, signal?: AbortSignal): Promise<CredCheckResult> {
  const host = (o.host ?? "$TARGET").trim() || "$TARGET";
  const hostLabel = host;
  const hostArg = host === "$TARGET" || host === "$TARGET_HOST" ? `"${host}"` : sandbox.shq(host);
  const st = String(o.secretType ?? "password").toLowerCase() === "hash" ? "hash" : "password";
  const protos = pickProtos(taskId, o.services);
  const user = String(o.username);
  const secret = String(o.secret);
  const parts = [`NXC=$(command -v nxc || command -v netexec); [ -n "$NXC" ] || { echo __WHCC_NO_NXC__; exit 3; }`];
  for (const p of protos) {
    const secretFlag = st === "hash" && HASH_PROTOS.has(p) ? `-H ${sandbox.shq(secret)}` : `-p ${sandbox.shq(secret)}`;
    parts.push(`echo __WHCC_${p}__; timeout 40 "$NXC" ${p} ${hostArg} -u ${sandbox.shq(user)} ${secretFlag} 2>&1 | tail -4`);
  }
  const timeout = Math.min(600, 30 + protos.length * 45);
  const t0 = Date.now();
  const r = await sandbox.runAgentCommand(taskId, parts.join("; "), timeout, signal);
  const secs = Math.round((Date.now() - t0) / 1000);
  const out = `${r.out.head}\n${r.out.tail}`;
  if (out.includes("__WHCC_NO_NXC__"))
    return { ok: false, error: "netexec (nxc) не найден в контейнере", hostLabel, results: [], secs, savedCreds: 0, negFact: false };
  const results: CredResult[] = [];
  let cur: CredProto | null = null;
  const byProto = new Map<CredProto, string[]>();
  for (const rawLine of out.split("\n")) {
    const m = /__WHCC_(\w+)__/.exec(rawLine);
    if (m && CRED_PROTOS.includes(m[1] as CredProto)) { cur = m[1] as CredProto; byProto.set(cur, []); continue; }
    if (cur) byProto.get(cur)!.push(rawLine.trim());
  }
  for (const p of protos) {
    const ls = byProto.get(p) ?? [];
    const okLine = ls.find((l) => l.includes("[+]"));
    const failLine = ls.find((l) => l.includes("[-]"));
    results.push(okLine
      ? { proto: p, status: "ok", line: okLine.slice(0, 200) }
      : failLine
        ? { proto: p, status: "fail", line: failLine.slice(0, 200) }
        : { proto: p, status: "unknown", line: (ls.filter(Boolean).at(-1) ?? "нет ответа (таймаут/порт закрыт?)").slice(0, 200) });
  }
  // Исходы в профиль: успехи — креды, отказы — одна обновляемая факт-запись на юзер/хост/пароль.
  let savedCreds = 0;
  let negFact = false;
  try {
    for (const x of results) if (x.status === "ok") {
      profile.addProfileItem(taskId, "cred", {
        service: x.proto, username: user, secret, secret_type: st === "hash" ? "ntlm" : "password",
        source: `cred_check: подтверждён вход ${x.proto} на ${hostLabel}`,
      });
      savedCreds++;
    }
    const fails = results.filter((x) => x.status === "fail").map((x) => x.proto);
    if (fails.length) {
      const prefix = `cred_check: ${user} / ${secret.slice(0, 40)} — НЕ подходит (${hostLabel}):`;
      const existing = profile.listProfile(taskId).find((i) => i.kind === "fact" && i.text.startsWith(prefix));
      const merged = [...new Set([...(existing ? existing.text.slice(prefix.length).split(",").map((s) => s.trim()).filter(Boolean) : []), ...fails])];
      const text = `${prefix} ${merged.join(", ")}`;
      if (existing) profile.updateProfileItem(taskId, existing.id, { text });
      else profile.addProfileItem(taskId, "fact", { text, source: "cred_check" });
      negFact = true;
    }
  } catch { /* профиль не валит проверку */ }
  return { ok: true, hostLabel, results, secs, savedCreds, negFact };
}

export function formatCredCheck(r: CredCheckResult, user: string): string {
  if (!r.ok) return `ошибка: ${r.error}`;
  const lines = [`[cred_check: ${user} → ${r.hostLabel} · ${r.secs} с]`];
  for (const x of r.results)
    lines.push(x.status === "ok" ? `${x.proto}: ВХОД ЕСТЬ — ${x.line}`
      : x.status === "fail" ? `${x.proto}: отказ — ${x.line}`
      : `${x.proto}: неясно — ${x.line}`);
  const notes: string[] = [];
  if (r.savedCreds) notes.push(`работающие доступы записаны в профиль (${r.savedCreds})`);
  if (r.negFact) notes.push("отказы зафиксированы фактом профиля — эту пару по этим сервисам повторно не проверяй");
  if (notes.length) lines.push(`[${notes.join("; ")}]`);
  return lines.join("\n");
}
