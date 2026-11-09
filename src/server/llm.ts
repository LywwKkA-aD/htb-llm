// Тонкий клиент к OpenAI-совместимому API модели. Свой, а не ChatOpenAI из LangChain:
// нужен reasoning_content в потоке, timings (t/s), chat_template_kwargs (reasoning_effort per request)
// и точный usage.prompt_tokens для управления контекстом. Адрес/модель/ключ берутся из активных
// настроек (settings.ts): локальный llama-server, OpenRouter или любой OpenAI-совместимый API.
import { cfg } from "./config.ts";
import { embedDimState, reloadEmbedDim } from "./db.ts";
import { activeLlm, activeEmbed, type EndpointCfg } from "./settings.ts";
import { openRouterReasoningInfo } from "./openrouter.ts";

// Канонический набор OpenRouter; локальная llama-server получает из него только свои старые значения.
export type Effort = "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "off";
export const ALL_EFFORTS: Effort[] = ["max", "xhigh", "high", "medium", "low", "minimal", "off"];
export type ReasoningInfo = {
  supportedEfforts: Effort[];
  defaultEffort: Effort | null;
  mandatory: boolean;
  supportsMaxTokens: boolean;
  source: "local" | "openrouter" | "custom";
};
const LOCAL_EFFORTS: Effort[] = ["xhigh", "medium", "low", "off"];
const EFFORT_RANK: Record<Effort, number> = { max: 6, xhigh: 5, high: 4, medium: 3, low: 2, minimal: 1, off: 0 };
const asEffort = (v: unknown): Effort | null => {
  const s = String(v ?? "").toLowerCase();
  if (s === "none") return "off";
  return (ALL_EFFORTS as string[]).includes(s) ? s as Effort : null;
};
const clampEffort = (effort: Effort, supported: Effort[]): Effort => {
  if (!supported.length || supported.includes(effort)) return effort;
  const below = supported.filter((e) => EFFORT_RANK[e] <= EFFORT_RANK[effort]).sort((a, b) => EFFORT_RANK[b] - EFFORT_RANK[a]);
  return below[0] ?? [...supported].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b])[0];
};
const localEffort = (effort: Effort): Effort =>
  effort === "off" ? "off" : effort === "medium" ? "medium" : effort === "low" || effort === "minimal" ? "low" : "xhigh";
export type OAToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type OAMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }
  | { role: "assistant"; content: string | null; tool_calls?: OAToolCall[]; reasoning_content?: string }
  | { role: "tool"; content: string; tool_call_id: string };

export type ChatOpts = {
  tools?: unknown[];
  effort?: Effort;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onToken?: (t: string) => void;
  onReasoning?: (t: string) => void;
};
export type ChatResult = {
  content: string;
  reasoning: string;
  toolCalls: OAToolCall[];
  finish: string;
  promptTokens: number;
  completionTokens: number;
  tps: number; // скорость генерации, t/s
  draftAccept: number | null; // доля принятых MTP-токенов, %
};

// Обрезка по кодовым точкам: String.slice считает единицы UTF-16 и режет эмодзи пополам — половинка суррогатной
// пары превращается в «�» в SQLite и в экранированный мусор в JSON для llama-server.
export function clip(s: string, n: number): string {
  if (s.length <= n) return s; // кодовых точек не больше, чем единиц UTF-16
  let out = "", k = 0;
  for (const ch of s) { if (k++ >= n) break; out += ch; }
  return out;
}

// Таймауты llama-server. Сервер может молчать долго: очередь (--parallel 1, его делит pentest-стек) и prefill
// длинного промпта, а новые сборки llama-server в потоковом режиме отдают даже заголовки только после первого токена.
// Поэтому до первого байта ждём щедро; между кусками потока — меньше (во время генерации токены идут непрерывно).
// Встроенный fetch (undici) сам рвёт соединение через 300 с без заголовков — свой таймаут чуть меньше, с понятной ошибкой.
const envSec = (name: string, def: number) => { const v = Number(process.env[name]); return (Number.isFinite(v) && v > 0 ? v : def) * 1000; };
const FIRST_BYTE_MS = Math.min(envSec("WH_LLM_FIRST_BYTE_TIMEOUT", 290), 295_000);
const IDLE_MS = Math.min(envSec("WH_LLM_IDLE_TIMEOUT", 120), 295_000);
const EMBED_MS = envSec("WH_EMBED_TIMEOUT", 120);

// «fetch failed» без подробностей — бесполезно: достаём причину (нет соединения, таймаут подключения)
function netError(e: unknown, what: string, url: string): Error {
  const c = (e as any)?.cause;
  const code = String(c?.code ?? (e as any)?.code ?? "");
  if (code === "ECONNREFUSED") return new Error(`${what} недоступен (${url}): соединение отклонено — сервер не запущен?`);
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return new Error(`${what} (${url}) не отвечает на подключение`);
  if (code === "UND_ERR_HEADERS_TIMEOUT") return new Error(`${what} (${url}) не начал отвечать за 300 с — занят другим запросом или завис`);
  if (code === "UND_ERR_BODY_TIMEOUT") return new Error(`${what} (${url}): поток ответа замолчал больше чем на 300 с`);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new Error(`${what}: не найден адрес ${url}`);
  const msg = (e as Error)?.message ?? String(e);
  return new Error(c?.message && msg === "fetch failed" ? `${what} (${url}): ${c.message}` : msg);
}

const authHeaders = (epCfg: EndpointCfg): Record<string, string> => {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (epCfg.apiKey) h.Authorization = `Bearer ${epCfg.apiKey}`;
  return h;
};
const isOpenRouter = (epCfg: EndpointCfg & { preset?: string }) =>
  epCfg.preset === "openrouter" || /(^|\.)openrouter\.ai/.test((() => { try { return new URL(epCfg.url).hostname; } catch { return ""; } })());

export async function activeReasoningInfo(epd = activeLlm()): Promise<ReasoningInfo> {
  if (epd.preset === "local") {
    return { supportedEfforts: LOCAL_EFFORTS, defaultEffort: "xhigh", mandatory: false, supportsMaxTokens: false, source: "local" };
  }
  if (isOpenRouter(epd)) {
    const raw = await openRouterReasoningInfo(epd.url, epd.model, epd.apiKey);
    if (raw) {
      let supported = raw.supportedEfforts === null || raw.supportedEfforts.length === 0
        ? ALL_EFFORTS
        : raw.supportedEfforts.map(asEffort).filter((e): e is Effort => !!e);
      if (!supported.length) supported = ALL_EFFORTS;
      if (raw.mandatory) supported = supported.filter((e) => e !== "off");
      supported = ALL_EFFORTS.filter((e) => supported.includes(e));
      return {
        supportedEfforts: supported,
        defaultEffort: asEffort(raw.defaultEffort),
        mandatory: raw.mandatory,
        supportsMaxTokens: raw.supportsMaxTokens,
        source: "openrouter",
      };
    }
    return { supportedEfforts: ALL_EFFORTS, defaultEffort: "high", mandatory: false, supportsMaxTokens: false, source: "openrouter" };
  }
  return { supportedEfforts: ALL_EFFORTS, defaultEffort: "high", mandatory: false, supportsMaxTokens: false, source: "custom" };
}

export async function chat(messages: OAMsg[], o: ChatOpts = {}): Promise<ChatResult> {
  const epd = activeLlm();
  const local = epd.preset === "local";
  const effort = o.effort ?? "xhigh";
  const body: Record<string, unknown> = {
    model: epd.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: o.maxTokens ?? 12000,
  };
  if (local) {
    // llama-server: глубина размышлений — через шаблон чата; новые gateway-значения сводим к его старому набору
    const localValue = localEffort(effort);
    body.chat_template_kwargs = localValue === "off" ? { enable_thinking: false } : { reasoning_effort: localValue };
  } else if (isOpenRouter(epd)) {
    // OpenRouter: значения и обязательность reasoning берём из метаданных именно этой модели.
    const info = await activeReasoningInfo(epd);
    const selected = clampEffort(effort, info.supportedEfforts);
    body.reasoning = { effort: selected === "off" ? "none" : selected };
    if (epd.provider.trim() || epd.quantization.trim()) {
      const prov: Record<string, unknown> = { allow_fallbacks: true };
      const order = epd.provider.split(",").map((s) => s.trim()).filter(Boolean);
      if (order.length) prov.order = order;
      if (epd.quantization.trim()) prov.quantizations = [epd.quantization.trim()];
      body.provider = prov;
    }
  } else {
    // Произвольный OpenAI-совместимый API: метаданных модели нет, поэтому max/xhigh консервативно сводим к high.
    body.reasoning = effort === "off" ? { enabled: false } : { effort: effort === "max" || effort === "xhigh" ? "high" : effort };
  }
  if (o.tools?.length) body.tools = o.tools;
  if (o.temperature !== undefined) body.temperature = o.temperature;

  const out: ChatResult = { content: "", reasoning: "", toolCalls: [], finish: "", promptTokens: 0, completionTokens: 0, tps: 0, draftAccept: null };
  const calls: Record<number, OAToolCall> = {};
  try {
    await streamInto(epd, body, o, out, calls);
  } catch (e) {
    // «Стоп» от пользователя — не ошибка: возвращаем то, что успело сгенерироваться, без вызовов инструментов.
    if (o.signal?.aborted) { out.finish = "aborted"; out.toolCalls = []; return out; }
    throw e;
  }
  out.toolCalls = Object.values(calls).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
  return out;
}

async function streamInto(epd: EndpointCfg & { preset: string }, body: Record<string, unknown>, o: ChatOpts, out: ChatResult, calls: Record<number, OAToolCall>) {
  const local = epd.preset === "local";
  // свой контроллер: таймаут — это ошибка («модель не отвечает»), а «стоп» пользователя (o.signal) — нет
  const ac = new AbortController();
  let timedOut = "";
  let timer: NodeJS.Timeout | undefined;
  const arm = (ms: number, why: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = why; ac.abort(); }, ms);
  };
  const signal = o.signal ? AbortSignal.any([o.signal, ac.signal]) : ac.signal;
  const fail = (e: unknown) => {
    if (o.signal?.aborted) return e; // «стоп» — chat() вернёт то, что успело прийти
    if (timedOut) return new Error(timedOut);
    return netError(e, "LLM", epd.url);
  };
  arm(FIRST_BYTE_MS, `LLM (${epd.url}) не начал отвечать за ${Math.round(FIRST_BYTE_MS / 1000)} с${local ? " — llama-server занят другим запросом или завис" : ""}`);
  try {
    let res: Response;
    try {
      res = await fetch(`${epd.url}/chat/completions`, {
        method: "POST",
        headers: authHeaders(epd),
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) { throw fail(e); }
    if (!res.ok || !res.body) {
      const t = await res.text().catch((e) => { throw fail(e); });
      throw new Error(`LLM ${res.status}: ${clip(t, 500)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try { r = await reader.read(); } catch (e) { throw fail(e); }
      if (r.done) break;
      // данные пошли — дальше следим только за паузами внутри потока
      arm(IDLE_MS, `LLM (${epd.url}): поток ответа замолчал на ${Math.round(IDLE_MS / 1000)} с${local ? " — llama-server завис?" : ""}`);
      buf += dec.decode(r.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        handleLine(line, o, out, calls);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function handleLine(line: string, o: ChatOpts, out: ChatResult, calls: Record<number, OAToolCall>) {
  if (!line.startsWith("data:")) return;
  const data = line.slice(5).trim();
  if (data === "[DONE]") return;
  let j: any;
  try { j = JSON.parse(data); } catch { return; }
  if (j.error) throw new Error(`LLM: ${j.error.message ?? JSON.stringify(j.error)}`);
  const ch = j.choices?.[0];
  const d = ch?.delta;
  // llama-server шлёт reasoning_content, OpenRouter и многие внешние API — reasoning
  const reasoning = d?.reasoning_content ?? d?.reasoning;
  if (reasoning) { out.reasoning += reasoning; o.onReasoning?.(reasoning); }
  if (d?.content) { out.content += d.content; o.onToken?.(d.content); }
  for (const tc of d?.tool_calls ?? []) {
    const c = (calls[tc.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
    if (tc.id) c.id = tc.id;
    if (tc.function?.name) c.function.name += tc.function.name;
    if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
  }
  if (ch?.finish_reason) out.finish = ch.finish_reason;
  if (j.usage) { out.promptTokens = j.usage.prompt_tokens ?? 0; out.completionTokens = j.usage.completion_tokens ?? 0; }
  if (j.timings) {
    out.tps = j.timings.predicted_per_second ?? 0;
    if (j.timings.draft_n) out.draftAccept = Math.round((100 * (j.timings.draft_n_accepted ?? 0)) / j.timings.draft_n);
  }
}

// ---------- эмбеддинги (Qwen3-Embedding-0.6B, last-token pooling) ----------
// В GGUF нет add_eos, а пулинг по последнему токену требует EOS в конце — дописываем сами.
const EOS = "<|endoftext|>";
const QUERY_INSTRUCT =
  "Instruct: Given a question or task about computer networks, Linux, protocols or IT tools, retrieve passages and notes that help solve it\nQuery:";

export async function embed(texts: string[], kind: "query" | "doc"): Promise<Float32Array[]> {
  const epd = activeEmbed();
  const local = epd.preset === "local";
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 16) {
    // локальный llama-server: 4096 токенов на последовательность -> режем текст с запасом;
    // instruct-префикс и EOS — специфика Qwen3-Embedding, внешним моделям (Cohere и др.) они вредят
    const batch = texts.slice(i, i + 16).map((t) =>
      local ? clip(kind === "query" ? `${QUERY_INSTRUCT}${t}` : t, 7000) + EOS : clip(t, 7000));
    // без таймаута зависший сервер эмбеддингов вешал ход (recall) и индексацию документа навсегда
    const signal = AbortSignal.timeout(EMBED_MS);
    let j: any;
    try {
      const res = await fetch(`${epd.url}/embeddings`, {
        method: "POST",
        headers: authHeaders(epd),
        body: JSON.stringify({ input: batch, model: epd.model, encoding_format: "float" }),
        signal,
      });
      if (!res.ok) throw new Error(`embeddings ${res.status}: ${clip(await res.text(), 300)}`);
      j = await res.json();
    } catch (e) {
      if (signal.aborted) throw new Error(`сервер эмбеддингов (${epd.url}) не ответил за ${Math.round(EMBED_MS / 1000)} с`);
      throw netError(e, "сервер эмбеддингов", epd.url);
    }
    for (const row of j.data.sort((a: any, b: any) => a.index - b.index)) {
      const v = Float32Array.from(row.embedding as number[]);
      // чужая размерность молча ломала бы векторный поиск — падаем с понятной причиной;
      // но сначала перечитать размерность из БД: её мог сменить соседний процесс (CLI-сборка базы)
      if (v.length !== embedDimState.dim) reloadEmbedDim();
      if (v.length !== embedDimState.dim)
        throw new Error(`эмбеддинг-модель «${epd.model}» вернула вектор ${v.length}, а индекс базы знаний построен на ${embedDimState.dim} — переиндексируй базу в настройках или верни прежнюю модель эмбеддингов`);
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      for (let k = 0; k < v.length; k++) v[k] /= n;
      out.push(v);
    }
  }
  return out;
}

// Размерность активной эмбеддинг-модели одним пробным запросом — в обход гарда embed():
// переиндексация сначала узнаёт размерность, потом под неё пересоздаёт векторную таблицу.
export async function probeEmbedDim(): Promise<number> {
  const epd = activeEmbed();
  const res = await fetch(`${epd.url}/embeddings`, {
    method: "POST",
    headers: authHeaders(epd),
    body: JSON.stringify({ input: ["размерность вектора"], model: epd.model, encoding_format: "float" }),
    signal: AbortSignal.timeout(EMBED_MS),
  }).catch((e) => { throw netError(e, "сервер эмбеддингов", epd.url); });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${clip(await res.text(), 300)}`);
  const j: any = await res.json();
  const dim = Array.isArray(j?.data?.[0]?.embedding) ? j.data[0].embedding.length : 0;
  if (!dim) throw new Error("эмбеддинг-модель вернула ответ без вектора");
  return dim;
}

export const cosine = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export async function health() {
  // пингуем АКТИВНЫЕ эндпоинты из настроек (с ключом, если задан), а не захардкоженные локальные
  const ping = async (epCfg: EndpointCfg) => {
    try {
      const r = await fetch(`${epCfg.url}/models`, { headers: authHeaders(epCfg), signal: AbortSignal.timeout(2500) });
      return r.ok;
    } catch { return false; }
  };
  const webPing = async () => {
    try {
      const r = await fetch(`${cfg.searxngUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  };
  const [llm, embedOk, web] = await Promise.all([ping(activeLlm()), ping(activeEmbed()), webPing()]);
  return { llm, embed: embedOk, web };
}

// грубая оценка токенов для бюджета (русский текст у Qwen ≈ 3 символа на токен)
export const approxTokens = (s: string) => Math.ceil(s.length / 3);
