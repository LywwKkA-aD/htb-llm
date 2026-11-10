// Общие настройки моделей: основная LLM и эмбеддинги настраиваются из веб-UI (пресеты
// локальная / OpenRouter / свой OpenAI-совместимый API), хранятся в БД (таблица settings).
// Для каждого пресета свой конфиг — переключение не теряет ключи и модели. Дефолты локального
// пресета берутся из env (WH_LLM_URL и т.д. через cfg), поэтому CLI и e2e работают как раньше.
// API-ключи наружу не отдаются: публичный вид содержит только apiKeySet.
import { db, embedDimState, reloadEmbedDim } from "./db.ts";
import { cfg } from "./config.ts";

export type Preset = "local" | "openrouter" | "custom";
export const PRESETS: Preset[] = ["local", "openrouter", "custom"];
export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

export type EndpointCfg = { url: string; model: string; apiKey: string; provider: string; quantization: string };
// compactAt — граница сворачивания истории в резюме (prompt-токены), своя у каждого пресета; 0 = авто.
export type LlmCfg = EndpointCfg & { ctxWindow: number; compactAt: number };
export type Section<T extends EndpointCfg> = { active: Preset } & Record<Preset, T>;
// Подагенты (spawn_subagent): делегирование подзадач отдельной модели с чистым контекстом.
// Доступны только на внешних пресетах — локальная Qwen одна, и параллельные ходы ей вредят.
export type AgentsSettings = { subagents: boolean; maxPerTurn: number; maxRounds: number; guidedRounds: number };
// Management-ключ OpenRouter (provisioning): отдельный от инференс-ключей, нужен статистике
// расходов (/activity, /keys). Создаётся на openrouter.ai → Settings → Management Keys.
export type OpenRouterMgmt = { apiKey: string };
export type AppSettings = { llm: Section<LlmCfg>; embed: Section<EndpointCfg>; agents: AgentsSettings; openrouterMgmt: OpenRouterMgmt };

const ep = (url: string, model: string, extra: Partial<EndpointCfg> = {}): EndpointCfg =>
  ({ url, model, apiKey: "", provider: "", quantization: "", ...extra });

export function defaultSettings(): AppSettings {
  return {
    llm: {
      active: "local",
      local: { ...ep(cfg.llmUrl, cfg.llmModel), ctxWindow: cfg.ctxWindow, compactAt: 0 },
      openrouter: { ...ep(OPENROUTER_URL, "z-ai/glm-5.3-flash", { provider: "relace", quantization: "fp4" }), ctxWindow: 131072, compactAt: 0 },
      custom: { ...ep("", ""), ctxWindow: cfg.ctxWindow, compactAt: 0 },
    },
    embed: {
      active: "local",
      local: ep(cfg.embedUrl, "embed"),
      openrouter: ep(OPENROUTER_URL, "cohere/embed-5-fast"),
      custom: ep("", ""),
    },
    agents: { subagents: false, maxPerTurn: 3, maxRounds: 8, guidedRounds: cfg.guidedToolRounds },
    openrouterMgmt: { apiKey: "" },
  };
}

function stored<T>(key: string): Partial<T> | null {
  try {
    const row = db.prepare("select value from settings where key=?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Partial<T>) : null;
  } catch { return null; }
}

function mergeSection<T extends EndpointCfg>(def: Section<T>, saved: Partial<Section<T>> | null): Section<T> {
  if (!saved) return def;
  const out = { ...def };
  if (PRESETS.includes(saved.active as Preset)) out.active = saved.active as Preset;
  for (const p of PRESETS) {
    const s = (saved as Record<string, unknown>)[p];
    if (s && typeof s === "object") out[p] = { ...def[p], ...(s as Partial<T>) };
  }
  return out;
}

export function getSettings(): AppSettings {
  const def = defaultSettings();
  const ag = stored<AgentsSettings>("agents");
  return {
    llm: mergeSection(def.llm, stored<Section<LlmCfg>>("llm")),
    embed: mergeSection(def.embed, stored<Section<EndpointCfg>>("embed")),
    agents: { ...def.agents, ...(ag ?? {}) },
    openrouterMgmt: { ...def.openrouterMgmt, ...(stored<OpenRouterMgmt>("openrouter_mgmt") ?? {}) },
  };
}

export const subagentsAvailable = (s: AppSettings = getSettings()): boolean =>
  s.agents.subagents && s.llm.active !== "local";

export const activeLlm = (): LlmCfg & { preset: Preset } => {
  const s = getSettings().llm;
  return { ...s[s.active], preset: s.active };
};
export const activeEmbed = (): EndpointCfg & { preset: Preset } => {
  const s = getSettings().embed;
  return { ...s[s.active], preset: s.active };
};
export const llmCtxWindow = (): number => activeLlm().ctxWindow || cfg.ctxWindow;

// Авто-граница сворачивания по окну: малым окнам (локальная Qwen 64K) — прежние 32K
// (скорость падает от заполненного контекста), большим — окно минус запас на системный
// промпт, резюме и ответ. Явная настройка пресета (compactAt > 0) важнее авто и env.
export const autoCompactAt = (win: number): number =>
  win <= 65536 ? Math.min(cfg.compactAtPromptTokens, Math.max(4096, win - 2048)) : win - 24576;

export const llmCompactAt = (): number => {
  const a = activeLlm();
  const win = a.ctxWindow || cfg.ctxWindow;
  if (a.compactAt > 0) return Math.min(a.compactAt, Math.max(4096, win - 4096));
  if (cfg.compactAtEnv != null && Number.isFinite(cfg.compactAtEnv)) return cfg.compactAtEnv;
  return autoCompactAt(win);
};

// ---------- валидация и сохранение ----------
const cleanUrl = (v: unknown, field: string): string => {
  const s = String(v ?? "").trim().replace(/\/+$/, "");
  if (!s) return "";
  let u: URL;
  try { u = new URL(s); } catch { throw new Error(`${field}: некорректный URL`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${field}: нужен http(s) URL`);
  if (s.length > 300) throw new Error(`${field}: URL длиннее 300 символов`);
  return s;
};
const cleanStr = (v: unknown, field: string, max: number): string => {
  const s = String(v ?? "").trim();
  if (s.length > max) throw new Error(`${field}: длиннее ${max} символов`);
  return s;
};

function cleanEndpoint(raw: any, prev: EndpointCfg, label: string): EndpointCfg {
  if (!raw || typeof raw !== "object") return prev;
  return {
    url: raw.url !== undefined ? cleanUrl(raw.url, `${label}: адрес API`) : prev.url,
    model: raw.model !== undefined ? cleanStr(raw.model, `${label}: модель`, 200) : prev.model,
    // undefined — ключ не трогаем; "" — очистить; строка — заменить
    apiKey: raw.apiKey !== undefined ? String(raw.apiKey).trim().slice(0, 500) : prev.apiKey,
    provider: raw.provider !== undefined ? cleanStr(raw.provider, `${label}: провайдер`, 200) : prev.provider,
    quantization: raw.quantization !== undefined ? cleanStr(raw.quantization, `${label}: квантизация`, 50) : prev.quantization,
  };
}

function cleanSection<T extends EndpointCfg>(raw: any, prev: Section<T>, label: string, llm: boolean): Section<T> {
  if (!raw || typeof raw !== "object") return prev;
  const out: Section<T> = { ...prev };
  if (raw.active !== undefined) {
    if (!PRESETS.includes(raw.active)) throw new Error(`${label}: неизвестный пресет`);
    out.active = raw.active;
  }
  for (const p of PRESETS) {
    if (raw[p] === undefined) continue;
    const cleaned = cleanEndpoint(raw[p], prev[p], `${label}/${p}`) as T;
    if (llm) {
      const c = raw[p]?.ctxWindow;
      const prevCtx = (prev[p] as unknown as LlmCfg).ctxWindow;
      (cleaned as unknown as LlmCfg).ctxWindow = c !== undefined
        ? (() => { const n = Math.floor(Number(c)); if (!Number.isFinite(n) || n < 8192 || n > 1_048_576) throw new Error(`${label}/${p}: окно контекста — число от 8192 до 1048576`); return n; })()
        : prevCtx;
      const ca = raw[p]?.compactAt;
      (cleaned as unknown as LlmCfg).compactAt = ca !== undefined
        ? (() => { const n = Math.floor(Number(ca)); if (!Number.isFinite(n) || (n !== 0 && (n < 4096 || n > 1_048_576))) throw new Error(`${label}/${p}: граница сворачивания — 0 (авто) или число от 4096 до 1048576`); return n; })()
        : ((prev[p] as unknown as LlmCfg).compactAt ?? 0);
    }
    out[p] = cleaned;
  }
  // активный пресет обязан быть пригоден к работе: пустой адрес/модель ловим сразу, а не на первом ходе
  const act = out[out.active];
  if (out.active !== "local" || act.url || act.model) {
    if (!act.url) throw new Error(`${label}: у активного пресета «${out.active}» пуст адрес API`);
    if (!act.model) throw new Error(`${label}: у активного пресета «${out.active}» пуста модель`);
  }
  return out;
}

function cleanAgents(raw: any, prev: AgentsSettings): AgentsSettings {
  if (!raw || typeof raw !== "object") return prev;
  const num = (v: unknown, field: string, min: number, max: number, was: number) => {
    if (v === undefined) return was;
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`подагенты: ${field} — число от ${min} до ${max}`);
    return n;
  };
  return {
    subagents: raw.subagents !== undefined ? raw.subagents === true : prev.subagents,
    maxPerTurn: num(raw.maxPerTurn, "макс. подагентов за ход", 1, 10, prev.maxPerTurn),
    maxRounds: num(raw.maxRounds, "макс. раундов подагента", 1, 30, prev.maxRounds),
    guidedRounds: num(raw.guidedRounds, "раундов действий на этап", 3, 24, prev.guidedRounds),
  };
}

export function saveSettings(patch: { llm?: unknown; embed?: unknown; agents?: unknown; openrouterMgmt?: unknown }): AppSettings {
  const cur = getSettings();
  const mgmtRaw = (patch.openrouterMgmt ?? null) as { apiKey?: unknown } | null;
  const next: AppSettings = {
    llm: patch.llm !== undefined ? cleanSection(patch.llm, cur.llm, "модель", true) : cur.llm,
    embed: patch.embed !== undefined ? cleanSection(patch.embed, cur.embed, "эмбеддинги", false) : cur.embed,
    agents: patch.agents !== undefined ? cleanAgents(patch.agents, cur.agents) : cur.agents,
    // та же семантика, что у инференс-ключей: undefined — не трогать, "" — очистить, строка — заменить
    openrouterMgmt: mgmtRaw && mgmtRaw.apiKey !== undefined
      ? { apiKey: String(mgmtRaw.apiKey).trim().slice(0, 500) }
      : cur.openrouterMgmt,
  };
  const up = db.prepare("insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value");
  if (patch.llm !== undefined) up.run("llm", JSON.stringify(next.llm));
  if (patch.embed !== undefined) up.run("embed", JSON.stringify(next.embed));
  if (patch.agents !== undefined) up.run("agents", JSON.stringify(next.agents));
  if (patch.openrouterMgmt !== undefined) up.run("openrouter_mgmt", JSON.stringify(next.openrouterMgmt));
  return next;
}

// ---------- публичный вид (без ключей) ----------
type PublicEp = Omit<EndpointCfg, "apiKey"> & { apiKeySet: boolean };
type PublicSection<T> = { active: Preset } & Record<Preset, T>;
export type PublicSettings = { llm: PublicSection<PublicEp & { ctxWindow: number; compactAt: number }>; embed: PublicSection<PublicEp>; agents: AgentsSettings; openrouterMgmt: { apiKeySet: boolean } };

export function publicSettings(s: AppSettings = getSettings()): PublicSettings {
  const pub = <T extends EndpointCfg>(sec: Section<T>) => {
    const out = { active: sec.active } as any;
    for (const p of PRESETS) {
      const { apiKey, ...rest } = sec[p];
      out[p] = { ...rest, apiKeySet: !!apiKey };
    }
    return out;
  };
  return { llm: pub(s.llm), embed: pub(s.embed), agents: s.agents, openrouterMgmt: { apiKeySet: !!s.openrouterMgmt.apiKey } };
}

// ---------- состояние векторного индекса ----------
// Чем построен индекс (модель+адрес), записывает переиндексация. Записи нет — индекс строился
// исходной локальной моделью (дефолты env). Активная модель разошлась с записью -> индекс устарел:
// векторный поиск встанет на гарде размерности/модели, останется полнотекст, UI покажет кнопку.
export type EmbedIndexInfo = { model: string; url: string; dim: number; chunks: number; stale: boolean; builtAt: number | null };

export function recordEmbedIndex(model: string, url: string) {
  db.prepare("insert into settings(key,value) values('embed_index',?) on conflict(key) do update set value=excluded.value")
    .run(JSON.stringify({ model, url, at: Date.now() }));
}

export function embedIndexInfo(s: AppSettings = getSettings()): EmbedIndexInfo {
  reloadEmbedDim(); // размерность могла смениться в соседнем процессе (CLI-сборка базы)
  const rec = stored<{ model: string; url: string; at: number }>("embed_index");
  const act = s.embed[s.embed.active];
  const chunks = (db.prepare("select count(*) as n from chunks").get() as { n: number }).n;
  // Пустой индекс не «устарел» — ему нечего терять при смене модели: первая сборка сама подтянет
  // размерность (library.ensureIndexDim), а подсказка «переиндексируй» при 0 фрагментов — тупик.
  if (!rec?.model) {
    // индекс строился локальной моделью по умолчанию; устарел только если активен не локальный пресет
    return { model: "embed", url: cfg.embedUrl, dim: embedDimState.dim, chunks, stale: chunks > 0 && s.embed.active !== "local", builtAt: null };
  }
  return {
    model: rec.model, url: rec.url ?? "", dim: embedDimState.dim, chunks,
    stale: chunks > 0 && (act.model !== rec.model || act.url !== (rec.url ?? "")), builtAt: rec.at ?? null,
  };
}

// ---------- проверка соединения (кнопка «проверить» в UI) ----------
// draft — несохранённый конфиг пресета из формы; отсутствующий ключ добирается из сохранённого.
export async function testConnection(kind: "llm" | "embed", preset: Preset, draft?: Partial<EndpointCfg>):
  Promise<{ ok: boolean; detail: string }> {
  const s = getSettings();
  const saved = kind === "llm" ? s.llm[preset] : s.embed[preset];
  const conf: EndpointCfg = { ...saved, ...(draft ?? {}), apiKey: draft?.apiKey ? draft.apiKey : saved.apiKey };
  const url = cleanUrl(conf.url, "адрес API");
  if (!url) return { ok: false, detail: "пуст адрес API" };
  if (!conf.model.trim()) return { ok: false, detail: "пуста модель" };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (conf.apiKey) headers.Authorization = `Bearer ${conf.apiKey}`;
  try {
    if (kind === "llm") {
      const r = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return { ok: false, detail: `GET /models → ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
      const j: any = await r.json().catch(() => null);
      const ids: string[] = Array.isArray(j?.data) ? j.data.map((m: any) => String(m.id ?? "")) : [];
      if (ids.length && !ids.includes(conf.model.trim()))
        return { ok: true, detail: `API отвечает, но модели «${conf.model.trim()}» в списке нет (доступно ${ids.length}; роутеры вроде OpenRouter список могут отдавать не полностью)` };
      return { ok: true, detail: ids.length ? `модель «${conf.model.trim()}» доступна` : "API отвечает" };
    }
    const r = await fetch(`${url}/embeddings`, {
      method: "POST", headers, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ model: conf.model.trim(), input: ["проверка соединения"], encoding_format: "float" }),
    });
    if (!r.ok) return { ok: false, detail: `POST /embeddings → ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
    const j: any = await r.json().catch(() => null);
    const dim = Array.isArray(j?.data?.[0]?.embedding) ? j.data[0].embedding.length : 0;
    if (!dim) return { ok: false, detail: "ответ без вектора" };
    return {
      ok: true,
      detail: dim === embedDimState.dim
        ? `вектор ${dim} — совпадает с текущим индексом`
        : `вектор ${dim}, а индекс построен на ${embedDimState.dim} — после смены нужна переиндексация базы знаний`,
    };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
