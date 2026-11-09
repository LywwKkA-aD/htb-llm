// Статистика расходов OpenRouter — только по проекту этого приложения.
// У OpenRouter каждый ключ живёт в workspace (в UI это «проект»), а GET /activity без
// workspace_id агрегирует ВСЕ workspace аккаунта — чужие расходы примешиваются к нашим.
// Поэтому scope берём из инференс-ключей самих пресетов модели/эмбеддингов:
//  - инференс-ключ -> GET /auth/key (usage именно этого ключа + его workspace_id);
//  - management/provisioning ключ -> GET /activity?workspace_id=… и GET /keys?workspace_id=…
//    только по workspace проекта, GET /workspaces — имя проекта для UI.
// /activity покрывает последние 30 ЗАВЕРШЁННЫХ UTC-дней: сегодняшний расход виден в
// /auth/key сразу, а в сводку по дням/моделям попадёт завтра.
// Базовый адрес берётся из openrouter-пресета основной модели (статистика работает и пока
// активна локальная модель — ключи-то сохранены). Ответы кэшируются на минуту; ошибка одного
// эндпоинта не валит остальные — UI покажет частичные данные и текст ошибки.
import { createHash } from "node:crypto";
import { getSettings, OPENROUTER_URL } from "./settings.ts";

export type OrKeyInfo = {
  label: string; usage: number; usageDaily: number; usageWeekly: number; usageMonthly: number;
  limit: number | null; limitReset: string | null; freeTier: boolean;
};
export type OrModelRow = { model: string; cost: number; requests: number; promptTokens: number; completionTokens: number; reasoningTokens: number };
export type OrDayRow = { date: string; cost: number; requests: number; promptTokens: number; completionTokens: number };
export type OrApiKeyRow = { label: string; usage: number; limit: number | null; disabled: boolean; updatedAt: string | null };
export type OrScope = { workspaces: { id: string; name: string | null }[] };
export type OrStats = {
  fetchedAt: number;
  hasInferenceKey: boolean;
  hasManagementKey: boolean;
  // null = workspace проекта определить не удалось (нет инференс-ключа) — сводка по аккаунту целиком
  scope: OrScope | null;
  key: OrKeyInfo | null;
  totals: { cost: number; requests: number; promptTokens: number; completionTokens: number; reasoningTokens: number } | null;
  periodDays: number;
  byModel: OrModelRow[];
  byDay: OrDayRow[];
  keys: OrApiKeyRow[];
  errors: { key?: string; activity?: string; keys?: string };
};

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const CACHE_MS = 60_000;
// Отпечаток включает адрес и оба ключа: замена ключа не должна ещё минуту показывать чужой результат.
let cache: { at: number; fingerprint: string; stats: OrStats } | null = null;
const fingerprintOf = (base: string, inferenceKey: string, mgmtKey: string) =>
  createHash("sha256").update(`${base}\n${inferenceKey}\n${mgmtKey}`).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function orGet(base: string, path: string, apiKey: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(`${base}${path}`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (attempt === 0) { await sleep(500); continue; }
      throw e;
    }
    const text = await r.text().catch(() => "");
    if (r.ok) return JSON.parse(text);
    // OpenRouter исторически отдавал сбой auth-lookup как 401 User not found; один повтор отличает
    // кратковременную рассинхронизацию только что созданного ключа от действительно неверного.
    const transient = r.status >= 500 || (r.status === 401 && /user not found/i.test(text));
    if (attempt === 0 && transient) { await sleep(700); continue; }
    throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  }
}

export async function openRouterStats(force = false): Promise<OrStats> {
  const s = getSettings();
  const base = (s.llm.openrouter.url || OPENROUTER_URL).replace(/\/+$/, "");
  const llmKey = s.llm.openrouter.apiKey || "";
  const embedKey = s.embed.openrouter.apiKey || "";
  const inferenceKey = llmKey || embedKey;
  const mgmtKey = s.openrouterMgmt.apiKey || "";
  const fingerprint = fingerprintOf(base, `${llmKey}\n${embedKey}`, mgmtKey);
  if (!force && cache?.fingerprint === fingerprint && Date.now() - cache.at < CACHE_MS) return cache.stats;
  const out: OrStats = {
    fetchedAt: Date.now(),
    hasInferenceKey: !!inferenceKey,
    hasManagementKey: !!mgmtKey,
    scope: null,
    key: null, totals: null, periodDays: 0, byModel: [], byDay: [], keys: [], errors: {},
  };

  // Scope проекта: workspace_id каждого настроенного инференс-ключа (модель + эмбеддинги).
  const workspaceIds: string[] = [];
  const addWorkspace = (d: any) => {
    const ws = d?.workspace_id ? String(d.workspace_id) : "";
    if (ws && !workspaceIds.includes(ws)) workspaceIds.push(ws);
  };
  let rawKeyLabel = "";
  if (inferenceKey) {
    try {
      const j = await orGet(base, "/auth/key", inferenceKey);
      const d = j?.data ?? {};
      addWorkspace(d);
      rawKeyLabel = String(d.label ?? "");
      out.key = {
        label: rawKeyLabel,
        usage: num(d.usage), usageDaily: num(d.usage_daily), usageWeekly: num(d.usage_weekly), usageMonthly: num(d.usage_monthly),
        limit: d.limit === null || d.limit === undefined ? null : num(d.limit),
        limitReset: d.limit_reset ? String(d.limit_reset) : null,
        freeTier: !!d.is_free_tier,
      };
    } catch (e) { out.errors.key = (e as Error).message; }
  }
  // Второй инференс-ключ (эмбеддинги отдельным ключом) может жить в другом workspace — его расход тоже наш.
  const secondKey = llmKey && embedKey && embedKey !== llmKey ? embedKey : "";
  if (secondKey) {
    try { addWorkspace((await orGet(base, "/auth/key", secondKey))?.data); } catch { /* scope по основному ключу уже есть */ }
  }

  if (mgmtKey) {
    if (workspaceIds.length) {
      const names = new Map<string, string>();
      try {
        const j = await orGet(base, "/workspaces", mgmtKey);
        for (const w of Array.isArray(j?.data) ? j.data : []) if (w?.id) names.set(String(w.id), String(w.name ?? w.title ?? ""));
      } catch { /* имя проекта — косметика, без него UI покажет id */ }
      out.scope = { workspaces: workspaceIds.map((id) => ({ id, name: names.get(id) || null })) };
    }
    const scoped = (path: string) => workspaceIds.length
      ? workspaceIds.map((ws) => `${path}?workspace_id=${encodeURIComponent(ws)}`)
      : [path];
    try {
      const rows: any[] = [];
      for (const p of scoped("/activity")) {
        const j = await orGet(base, p, mgmtKey);
        if (Array.isArray(j?.data)) rows.push(...j.data);
      }
      const byModel = new Map<string, OrModelRow>();
      const byDay = new Map<string, OrDayRow>();
      const tot = { cost: 0, requests: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
      for (const r of rows) {
        const cost = num(r.usage), req = num(r.requests), pt = num(r.prompt_tokens), ct = num(r.completion_tokens), rt = num(r.reasoning_tokens);
        tot.cost += cost; tot.requests += req; tot.promptTokens += pt; tot.completionTokens += ct; tot.reasoningTokens += rt;
        const model = String(r.model_permaslug ?? r.model ?? "—");
        const m = byModel.get(model) ?? { model, cost: 0, requests: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
        m.cost += cost; m.requests += req; m.promptTokens += pt; m.completionTokens += ct; m.reasoningTokens += rt;
        byModel.set(model, m);
        const date = String(r.date ?? "").slice(0, 10);
        if (date) {
          const dd = byDay.get(date) ?? { date, cost: 0, requests: 0, promptTokens: 0, completionTokens: 0 };
          dd.cost += cost; dd.requests += req; dd.promptTokens += pt; dd.completionTokens += ct;
          byDay.set(date, dd);
        }
      }
      out.totals = tot;
      // /activity всегда окно последних 30 завершённых UTC-дней, а не «дней с активностью»
      out.periodDays = 30;
      out.byModel = [...byModel.values()].sort((a, b) => b.cost - a.cost).slice(0, 20);
      out.byDay = [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 31);
    } catch (e) { out.errors.activity = (e as Error).message; }

    try {
      const rows: any[] = [];
      for (const p of scoped("/keys")) {
        const j = await orGet(base, p, mgmtKey);
        if (Array.isArray(j?.data)) rows.push(...j.data);
      }
      // Настоящее имя ключа — поле name; label на OpenRouter — замаскированный ключ вида «sk-or-...be8».
      const isMasked = (v: string) => v.startsWith("[REDACTED]") || v.includes("...") || v.includes("…");
      const keyName = (k: any) => {
        const name = String(k.name ?? "").trim();
        if (name) return name;
        const label = String(k.label ?? "").trim();
        return label && !isMasked(label) ? label : String(k.hash ?? "—");
      };
      out.keys = rows.map((k) => ({
        label: keyName(k),
        usage: num(k.usage),
        limit: k.limit === null || k.limit === undefined ? null : num(k.limit),
        disabled: !!k.disabled,
        updatedAt: k.updated_at ? String(k.updated_at) : null,
      })).sort((a, b) => b.usage - a.usage).slice(0, 20);
      // Заголовок ключа модели: замаскированный label из /auth/key заменяем именем того же
      // ключа из /keys проекта (тот же usage), иначе показываем без имени.
      if (out.key && isMasked(rawKeyLabel)) {
        const same = rows.find((k) => Math.abs(num(k.usage) - out.key!.usage) < 1e-6 && String(k.name ?? "").trim());
        out.key.label = same ? String(same.name) : "";
      }
    } catch (e) { out.errors.keys = (e as Error).message; }
  }

  // Частичный ответ с ошибкой не кэшируем: иначе исправленный ключ ещё минуту выглядит сломанным.
  cache = Object.keys(out.errors).length ? null : { at: Date.now(), fingerprint, stats: out };
  return out;
}

export const invalidateOrStats = () => { cache = null; };

// ---------- reasoning-метаданные конкретной модели ----------
// OpenRouter в GET /models для reasoning-моделей отдаёт supported_efforts/default_effort/mandatory.
// Это нельзя угадывать по общему списку: например GLM 5.3 Flash принимает только max/high/low
// и запрещает отключать reasoning. Список моделей большой, поэтому успешный ответ кэшируем на час,
// а отсутствие модели/ошибку — только на минуту.
export type OrReasoningInfo = {
  supportedEfforts: string[] | null; // null = OpenRouter принимает все gateway-значения; [] = модель не expose-ит выбор
  defaultEffort: string | null;
  mandatory: boolean;
  supportsMaxTokens: boolean;
};
const reasoningCache = new Map<string, { expiresAt: number; info: OrReasoningInfo | null }>();

export async function openRouterReasoningInfo(base: string, model: string, apiKey: string): Promise<OrReasoningInfo | null> {
  const cleanBase = base.replace(/\/+$/, "");
  const key = `${cleanBase}\n${model}`;
  const hit = reasoningCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.info;
  try {
    const j = await orGet(cleanBase, "/models", apiKey);
    const rows: any[] = Array.isArray(j?.data) ? j.data : [];
    const m = rows.find((x) => String(x?.id ?? "") === model);
    if (!m) {
      reasoningCache.set(key, { expiresAt: Date.now() + 60_000, info: null });
      return null;
    }
    const r = m.reasoning && typeof m.reasoning === "object" ? m.reasoning : null;
    const info: OrReasoningInfo = r ? {
      supportedEfforts: Array.isArray(r.supported_efforts) ? r.supported_efforts.map((x: unknown) => String(x)) : null,
      defaultEffort: r.default_effort ? String(r.default_effort) : null,
      mandatory: !!r.mandatory,
      supportsMaxTokens: !!r.supports_max_tokens,
    } : { supportedEfforts: [], defaultEffort: null, mandatory: false, supportsMaxTokens: false };
    reasoningCache.set(key, { expiresAt: Date.now() + 60 * 60_000, info });
    return info;
  } catch {
    reasoningCache.set(key, { expiresAt: Date.now() + 60_000, info: null });
    return null;
  }
}
