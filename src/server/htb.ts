// HackTheBox Labs API (недокументированный v4/v5, личный App Token пользователя):
// профиль и прогресс, активная машина, поиск машин, spawn/stop — то же, что клики в app.hackthebox.com.
// Токен хранится локально в data/htb.json (0600) или берётся из WH_HTB_TOKEN; наружу из API не отдаётся.
// Формы ответов сверены по community-клиентам (gohtb, htb-operator); парсинг толерантный — API может меняться.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./config.ts";

const API = (process.env.WH_HTB_API_URL ?? "https://labs.hackthebox.com/api").replace(/\/$/, "");
const TOKEN_FILE = path.join(DATA, "htb.json");
const CACHE_MS = 60_000;

export type HtbMachine = {
  id: number; name: string; os: string; difficultyText: string; difficulty: number | null;
  points: number | null; state: string; free: boolean; rating: number | null;
  ownedUser: boolean; ownedRoot: boolean; ip: string | null;
};
export type HtbStatus = {
  configured: boolean; source?: "env" | "file"; fetchedAt?: number; error?: string;
  user?: {
    id: number; name: string; avatar: string | null; rank: string; ranking: number | null; points: number | null;
    userOwns: number; systemOwns: number; nextRank: string | null; rankProgress: number | null;
    isVip: boolean; isDedicatedVip: boolean;
    // новая система Experience (/api/experience/v1): Lvl 7 · Beginner · Grade 2, XP внутри уровня и до следующего
    level: number | null; levelTitle: string | null; levelGrade: string | null;
    xpInLevel: number | null; xpUntilNext: number | null; xpTotal: number | null;
  };
  activeMachine?: (HtbMachine & { expiresAt: string | null; isSpawning: boolean; type: string | null }) | null;
};

function readToken(): { token: string; source: "env" | "file" } | null {
  const env = process.env.WH_HTB_TOKEN?.trim();
  if (env) return { token: env, source: "env" };
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")) as { token?: unknown };
    return typeof j.token === "string" && j.token.trim() ? { token: j.token.trim(), source: "file" } : null;
  } catch { return null; }
}
export const htbConfigured = () => readToken() !== null;

export async function setToken(token: string): Promise<void> {
  const t = token.trim();
  if (t.length < 20) throw new Error("это не похоже на App Token HTB (слишком короткий)");
  if (process.env.WH_HTB_TOKEN) throw new Error("токен задан через WH_HTB_TOKEN — из интерфейса не меняется");
  await call(t, "GET", "/v4/user/info"); // валидируем до сохранения: битый/истёкший не пишем
  const fd = fs.openSync(TOKEN_FILE, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ token: t, savedAt: Date.now() })); fs.fchmodSync(fd, 0o600); }
  finally { fs.closeSync(fd); }
  cache = null;
}
export function deleteToken(): void {
  if (process.env.WH_HTB_TOKEN) throw new Error("токен задан через WH_HTB_TOKEN — убери переменную окружения");
  fs.rmSync(TOKEN_FILE, { force: true });
  cache = null;
}

async function call(token: string, method: string, p: string, body?: unknown): Promise<any> {
  let r: Response;
  try {
    r = await fetch(`${API}${p}`, {
      method,
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json", "User-Agent": "htb-llm-unofficial (local)", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    throw new Error(`HTB API недоступен: ${(e as Error).message}`);
  }
  if (r.status === 401 || r.status === 403) throw new Error("токен HTB недействителен или истёк — создай новый в account-settings → App Tokens");
  if (r.status === 429) throw new Error("HTB ограничивает частоту запросов (429) — подожди минуту");
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* не JSON — ниже по статусу */ }
  if (!r.ok) throw new Error(`HTB API ${method} ${p} → ${r.status}: ${String(j?.message ?? text).slice(0, 200)}`);
  return j;
}
const need = () => { const t = readToken(); if (!t) throw new Error("HTB не подключён: добавь App Token"); return t; };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const avatarUrl = (v: unknown): string | null =>
  typeof v !== "string" || !v ? null : v.startsWith("http") ? v : `https://app.hackthebox.com${v.startsWith("/") ? "" : "/"}${v}`;

function machineOf(m: any): HtbMachine {
  return {
    id: Number(m.id), name: String(m.name ?? "?"), os: String(m.os ?? ""),
    difficultyText: String(m.difficultyText ?? ""), difficulty: num(m.difficulty),
    points: num(m.points), state: String(m.state ?? (m.retired ? "retired" : "active")),
    free: Boolean(m.free), rating: num(m.rating ?? m.stars),
    ownedUser: Boolean(m.authUserInUserOwns), ownedRoot: Boolean(m.authUserInRootOwns),
    ip: typeof m.ip === "string" && m.ip ? m.ip : null,
  };
}

let cache: { at: number; data: HtbStatus } | null = null;
export function invalidateHtb() { cache = null; }

export async function htbStatus(force = false): Promise<HtbStatus> {
  const auth = readToken();
  if (!auth) return { configured: false };
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const info = (await call(auth.token, "GET", "/v4/user/info"))?.info ?? {};
  const uid = Number(info.id);
  const accountId = typeof info.account_id === "string" && info.account_id ? info.account_id : null;
  const [profile, activeRaw, xp] = await Promise.all([
    uid ? call(auth.token, "GET", `/v4/user/profile/basic/${uid}`) : Promise.resolve(null),
    call(auth.token, "GET", "/v4/machine/active"),
    // уровни живут отдельным Experience API (ключи — account UUID, не числовой id); его сбой статус не валит
    accountId ? call(auth.token, "GET", `/experience/v1/account/${encodeURIComponent(accountId)}`).catch(() => null) : Promise.resolve(null),
  ]);
  const pr = profile?.profile ?? {};
  let activeMachine: HtbStatus["activeMachine"] = null;
  const act = activeRaw?.info;
  if (act && typeof act === "object") {
    // в machine/active нет OS/сложности — дочитываем профиль машины (один вызов, ответ кэшируется вместе со статусом)
    let prof: any = {};
    try { prof = (await call(auth.token, "GET", `/v4/machine/profile/${act.id}`))?.info ?? {}; } catch { /* активная машина важнее деталей */ }
    const m = machineOf({ ...prof, ...act, ip: act.ip ?? prof.ip });
    activeMachine = { ...m, expiresAt: typeof act.expires_at === "string" ? act.expires_at : null, isSpawning: Boolean(act.isSpawning), type: typeof act.type === "string" ? act.type : null };
  }
  const data: HtbStatus = {
    configured: true, source: auth.source, fetchedAt: Date.now(),
    user: {
      id: uid, name: String(pr.name ?? info.name ?? "user"), avatar: avatarUrl(pr.avatar ?? info.avatar),
      rank: String(pr.rank ?? ""), ranking: num(pr.ranking), points: num(pr.points),
      userOwns: Number(pr.user_owns) || 0, systemOwns: Number(pr.system_owns) || 0,
      nextRank: typeof pr.next_rank === "string" && pr.next_rank ? pr.next_rank : null,
      rankProgress: num(pr.current_rank_progress),
      isVip: Boolean(pr.isVip ?? info.isVip), isDedicatedVip: Boolean(pr.isDedicatedVip ?? info.isDedicatedVip),
      level: num(xp?.level), levelTitle: typeof xp?.levelTitle === "string" && xp.levelTitle ? xp.levelTitle : null,
      levelGrade: xp?.levelGrade != null && String(xp.levelGrade) !== "" ? String(xp.levelGrade) : null,
      xpInLevel: num(xp?.levelExperiencePoints), xpUntilNext: num(xp?.experienceUntilNextLevel), xpTotal: num(xp?.totalExperiencePoints),
    },
    activeMachine,
  };
  cache = { at: Date.now(), data };
  return data;
}

export async function searchMachines(keyword: string): Promise<HtbMachine[]> {
  const { token } = need();
  const q = new URLSearchParams({ per_page: "20", page: "1" });
  if (keyword.trim()) q.set("keyword", keyword.trim());
  const r = await call(token, "GET", `/v5/machines?${q}`);
  const arr: any[] = Array.isArray(r?.data) ? r.data : [];
  return arr.filter((m) => Number.isFinite(Number(m?.id))).map(machineOf);
}

export async function machineProfile(id: number): Promise<HtbMachine> {
  const { token } = need();
  const r = await call(token, "GET", `/v4/machine/profile/${id}`);
  if (!r?.info) throw new Error("HTB не отдал профиль машины");
  return machineOf(r.info);
}

export async function spawnMachine(id: number): Promise<void> {
  const { token } = need();
  await call(token, "POST", "/v4/vm/spawn", { machine_id: id });
  cache = null;
}
export async function stopActiveMachine(): Promise<void> {
  const { token } = need();
  const act = (await call(token, "GET", "/v4/machine/active"))?.info;
  if (!act?.id) throw new Error("активной машины HTB сейчас нет");
  await call(token, "POST", "/v4/vm/terminate", { machine_id: Number(act.id) });
  cache = null;
}
