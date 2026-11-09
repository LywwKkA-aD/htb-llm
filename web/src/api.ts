// Клиент API whitehat-agent
export type Task = {
  id: string; title: string; course: string; brief: string; target: string; hostname: string; created_at: number; updated_at: number;
  chats?: number; pending?: number; memories?: number; plan_done?: number; plan_total?: number; profile_total?: number; container?: "running" | "stopped" | "missing";
};
export type Chat = { id: string; task_id: string; title: string; summary: string; last_prompt_tokens: number; updated_at: number; busy?: boolean };
export type Memory = { id: number; task_id: string; chat_id: string | null; kind: string; title: string; content: string; status: "pending" | "confirmed" | "rejected"; created_at: number };
export type Doc = { id: number; task_id: string | null; name: string; kind: string; pages: number; chunks: number; status: string; error: string | null; created_at: number };
export type ReasoningInfo = { supportedEfforts: Effort[]; defaultEffort: Effort | null; mandatory: boolean; supportsMaxTokens: boolean; source: "local" | "openrouter" | "custom" };
export type Health = { llm: boolean; embed: boolean; web: boolean; docker: boolean; image: boolean; model: string; ctxWindow: number; compactAt?: number; preset?: string; llmPreset?: string; embedPreset?: string; reasoning?: ReasoningInfo | null };
export type Preset = "local" | "openrouter" | "custom";
export type EndpointPub = { url: string; model: string; provider: string; quantization: string; apiKeySet: boolean };
export type LlmPub = EndpointPub & { ctxWindow: number; compactAt: number };
export type SectionPub<T> = { active: Preset } & Record<Preset, T>;
export type EmbedIndexInfo = { model: string; url: string; dim: number; chunks: number; stale: boolean; builtAt: number | null };
export type ReindexState = { running: boolean; done: number; total: number; error: string | null; startedAt: number; finishedAt: number };
export type AgentsSettings = { subagents: boolean; maxPerTurn: number; maxRounds: number };
export type AppSettings = { llm: SectionPub<LlmPub>; embed: SectionPub<EndpointPub>; agents: AgentsSettings; openrouterMgmt: { apiKeySet: boolean }; embedIndex: EmbedIndexInfo; reindex: ReindexState };
export type OrStats = {
  fetchedAt: number; hasInferenceKey: boolean; hasManagementKey: boolean;
  scope: { workspaces: { id: string; name: string | null }[] } | null;
  key: { label: string; usage: number; usageDaily: number; usageWeekly: number; usageMonthly: number; limit: number | null; limitReset: string | null; freeTier: boolean } | null;
  totals: { cost: number; requests: number; promptTokens: number; completionTokens: number; reasoningTokens: number } | null;
  periodDays: number;
  byModel: { model: string; cost: number; requests: number; promptTokens: number; completionTokens: number; reasoningTokens: number }[];
  byDay: { date: string; cost: number; requests: number; promptTokens: number; completionTokens: number }[];
  keys: { label: string; usage: number; limit: number | null; disabled: boolean; updatedAt: string | null }[];
  errors: { key?: string; activity?: string; keys?: string };
};
export type ServiceInfo = {
  id: "llm" | "embed"; name: string; url: string; managed: boolean;
  state: "running" | "starting" | "stopping" | "stopped" | "error";
  pid: number | null; detail?: string; log: string[];
};
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
    level: number | null; levelTitle: string | null; levelGrade: string | null;
    xpInLevel: number | null; xpUntilNext: number | null; xpTotal: number | null;
  };
  activeMachine?: (HtbMachine & { expiresAt: string | null; isSpawning: boolean; type: string | null }) | null;
};
export type VpnInfo = {
  config: { name: string; kind: "openvpn" | "wireguard"; uploadedAt: number; proto?: "tcp" | "udp" | null } | null;
  container: "running" | "stopped" | "missing";
  containerIp: string | null;
  status: { state: "down" | "connecting" | "up"; iface?: string; ip?: string; log: string[]; socks: { running: boolean; url?: string } };
};
export type JobInfo = { id: string; task_id: string; name: string; command: string; created_at: number; running: boolean };
export type PlanStatus = "todo" | "doing" | "done" | "blocked" | "skipped";
export type PlanItem = { id: string; phase: string; text: string; status: PlanStatus; note: string; sort: number };
export type ProfileKind = "service" | "cred" | "access" | "fact";
export type ProfileItem = {
  id: string; kind: ProfileKind; host: string; port: number | null; proto: string;
  service: string; version: string; username: string; secret: string; secret_type: string;
  source: string; text: string; sort: number;
};
export type ProfileNew = { kind: ProfileKind } & Partial<Omit<ProfileItem, "id" | "kind" | "sort">>;
export type WorkFile = { path: string; name: string; dir: boolean; size: number; mtime: number };
export type WorkFilePreview = { path: string; size: number; mtime: number; binary: boolean; tooLarge: boolean; text: string };
export type Stats = { tps: number; promptTokens: number; completionTokens: number; draftAccept: number | null; finish: string };
export type ToolCall = { id: string; name: string; args: any };
export type LogItem =
  | { id: number; kind: "user"; data: { text: string; images?: string[] }; created_at: number }
  | { id: number; kind: "assistant"; data: { content: string; reasoning: string; stats?: Stats; tool_calls: ToolCall[]; live?: boolean }; created_at: number }
  | { id: number; kind: "tool_result"; data: { id: string; name: string; output: string | null; ms?: number }; created_at: number }
  | { id: number; kind: "marker"; data: { type: "compacted" | "error"; removed?: number; before?: number; after?: number; message?: string }; created_at: number };
export type Effort = "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "off";
export type AgentMode = "guided" | "autonomous";

// Ошибка API с HTTP-статусом (status нет — запрос не дошёл: сеть, ERR_NETWORK_CHANGED и т. п.)
export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.name = "ApiError"; this.status = status; }
}
// Задачу или чат удалили (в другой вкладке): 404 или «не найден» от старых ручек, отвечающих 400
export const isGone = (e: unknown) =>
  e instanceof ApiError && (e.status === 404 || (e.status === 400 && /не найден|нет задачи/i.test(e.message)));
const isAbort = (e: unknown, signal?: AbortSignal | null) => !!signal?.aborted || (e as { name?: string })?.name === "AbortError";

// Пауза, которую можно прервать сигналом (уход с экрана)
export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done);
});

// Текст ошибки из ответа сервера: JSON {error}, иначе «413 Payload Too Large» (а не голое «413»)
async function errorOf(r: Response) {
  const body = await r.json().catch(() => null);
  return new ApiError(body?.error ?? `${r.status} ${r.statusText}`.trim(), r.status);
}

// GET повторяется при сетевых сбоях (Docker пересоздаёт veth → ERR_NETWORK_CHANGED рвёт запросы на лету):
// иначе приложение остаётся в пустом состоянии. Изменяющие запросы не повторяются — они не идемпотентны.
async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const tries = (init?.method ?? "GET").toUpperCase() === "GET" ? 4 : 1;
  for (let i = 1; ; i++) {
    let r: Response;
    try { r = await fetch(url, init); }
    catch (e) {
      if (isAbort(e, init?.signal) || i >= tries) throw e;
      await sleep(300 * 2 ** (i - 1), init?.signal ?? undefined);
      continue;
    }
    if (!r.ok) throw await errorOf(r);
    return (r.status === 204 ? null : await r.json().catch(() => null)) as T;
  }
}
const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  health: () => j<Health>("/api/health"),
  settings: () => j<AppSettings>("/api/settings"),
  saveSettings: (s: unknown) => j<AppSettings>("/api/settings", json("PUT", s)),
  testSettings: (kind: "llm" | "embed", preset: Preset, config: unknown) =>
    j<{ ok: boolean; detail: string }>("/api/settings/test", json("POST", { kind, preset, config })),
  reindexStart: () => j<ReindexState>("/api/settings/reindex", json("POST")),
  reindexStatus: () => j<{ reindex: ReindexState; embedIndex: EmbedIndexInfo }>("/api/settings/reindex"),
  orStats: (refresh = false) => j<OrStats>(`/api/stats/openrouter${refresh ? "?refresh=1" : ""}`),
  services: () => j<ServiceInfo[]>("/api/services"),
  serviceAction: (id: "llm" | "embed", action: "start" | "stop") => j<ServiceInfo>(`/api/services/${id}/${action}`, json("POST")),
  htbStatus: (refresh = false) => j<HtbStatus>(`/api/htb/status${refresh ? "?refresh=1" : ""}`),
  htbSetToken: (token: string) => j<HtbStatus>("/api/htb/token", json("POST", { token })),
  htbDeleteToken: () => j<HtbStatus>("/api/htb/token", json("DELETE")),
  htbMachines: (q: string) => j<HtbMachine[]>(`/api/htb/machines?q=${encodeURIComponent(q)}`),
  htbSpawn: (machineId: number) => j<HtbStatus>("/api/htb/spawn", json("POST", { machineId })),
  htbStop: () => j<HtbStatus>("/api/htb/stop", json("POST")),
  htbImport: (machineId?: number) => j<{ task: Task; chat: Chat; existed: boolean }>("/api/htb/import", json("POST", machineId ? { machineId } : {})),
  tasks: () => j<Task[]>("/api/tasks"),
  createTask: (t: { title: string; course: string; brief: string; target: string; hostname: string }) => j<{ task: Task; chat: Chat }>("/api/tasks", json("POST", t)),
  updateTask: (id: string, t: Partial<Task>) => j<Task>(`/api/tasks/${id}`, json("PATCH", t)),
  deleteTask: (id: string) => j(`/api/tasks/${id}`, json("DELETE")),
  container: (id: string, action?: "start" | "stop" | "reset") =>
    action ? j<{ status: string }>(`/api/tasks/${id}/container/${action}`, json("POST")) : j<{ status: string }>(`/api/tasks/${id}/container`),
  killShell: (taskId: string, sid: number) => j(`/api/tasks/${taskId}/shells/${sid}`, json("DELETE")),
  jobs: (taskId: string) => j<JobInfo[]>(`/api/tasks/${taskId}/jobs`),
  createJob: (taskId: string, name: string, command: string) => j<JobInfo>(`/api/tasks/${taskId}/jobs`, json("POST", { name, command })),
  jobOutput: (taskId: string, id: string, lines = 200) => j<{ job: JobInfo; output: string }>(`/api/tasks/${taskId}/jobs/${id}/output?lines=${lines}`),
  jobInput: (taskId: string, id: string, text: string, enter = true) => j<JobInfo>(`/api/tasks/${taskId}/jobs/${id}/input`, json("POST", { text, enter })),
  jobStop: (taskId: string, id: string) => j<JobInfo>(`/api/tasks/${taskId}/jobs/${id}/stop`, json("POST")),
  jobDelete: (taskId: string, id: string) => j(`/api/tasks/${taskId}/jobs/${id}`, json("DELETE")),
  plan: (taskId: string) => j<{ items: PlanItem[]; phases: readonly string[] }>(`/api/tasks/${taskId}/plan`),
  planAdd: (taskId: string, phase: string, text: string) => j<PlanItem>(`/api/tasks/${taskId}/plan`, json("POST", { phase, text })),
  planUpdate: (taskId: string, id: string, patch: Partial<Pick<PlanItem, "status" | "note" | "text" | "phase">>) => j<PlanItem>(`/api/tasks/${taskId}/plan/${id}`, json("PATCH", patch)),
  planDelete: (taskId: string, id: string) => j(`/api/tasks/${taskId}/plan/${id}`, json("DELETE")),
  profile: (taskId: string) => j<{ items: ProfileItem[]; kinds: readonly ProfileKind[] }>(`/api/tasks/${taskId}/profile`),
  profileAdd: (taskId: string, item: ProfileNew) => j<ProfileItem>(`/api/tasks/${taskId}/profile`, json("POST", item)),
  profileUpdate: (taskId: string, id: string, patch: Partial<ProfileItem>) => j<ProfileItem>(`/api/tasks/${taskId}/profile/${id}`, json("PATCH", patch)),
  profileDelete: (taskId: string, id: string) => j(`/api/tasks/${taskId}/profile/${id}`, json("DELETE")),
  files: (taskId: string) => j<{ files: WorkFile[] }>(`/api/tasks/${taskId}/files`),
  filePreview: (taskId: string, path: string) => j<WorkFilePreview>(`/api/tasks/${taskId}/files/preview?path=${encodeURIComponent(path)}`),
  fileDownloadUrl: (taskId: string, path: string) => `/api/tasks/${taskId}/files/download?path=${encodeURIComponent(path)}`,
  chats: (taskId: string) => j<Chat[]>(`/api/tasks/${taskId}/chats`),
  newChat: (taskId: string) => j<Chat>(`/api/tasks/${taskId}/chats`, json("POST")),
  renameChat: (id: string, title: string) => j<Chat>(`/api/chats/${id}`, json("PATCH", { title })),
  deleteChat: (id: string) => j(`/api/chats/${id}`, json("DELETE")),
  log: (chatId: string) => j<{ chat: Chat; ctxWindow: number; log: LogItem[] }>(`/api/chats/${chatId}/log`),
  stop: (chatId: string) => j(`/api/chats/${chatId}/stop`, json("POST")),
  memories: (taskId: string) => j<Memory[]>(`/api/tasks/${taskId}/memories`),
  addMemory: (taskId: string, m: { kind: string; title: string; content: string }) => j<Memory>(`/api/tasks/${taskId}/memories`, json("POST", m)),
  confirmMemory: (id: number, edit?: Partial<Memory>) => j<Memory>(`/api/memories/${id}/confirm`, json("POST", edit ?? {})),
  rejectMemory: (id: number) => j(`/api/memories/${id}/reject`, json("POST")),
  deleteMemory: (id: number) => j(`/api/memories/${id}`, json("DELETE")),
  docs: (taskId: string | null) => j<Doc[]>(`/api/docs${taskId ? `?task=${taskId}` : ""}`),
  uploadDocs: (files: File[], taskId: string | null) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, f.name));
    if (taskId) fd.append("task", taskId);
    return j<(Doc | { name: string; error: string })[]>("/api/docs", { method: "POST", body: fd });
  },
  deleteDoc: (id: number) => j(`/api/docs/${id}`, json("DELETE")),
  vpn: (taskId: string) => j<VpnInfo>(`/api/tasks/${taskId}/vpn`),
  uploadVpnConfig: (taskId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    return j<VpnInfo>(`/api/tasks/${taskId}/vpn/config`, { method: "POST", body: fd });
  },
  deleteVpnConfig: (taskId: string) => j<VpnInfo>(`/api/tasks/${taskId}/vpn/config`, json("DELETE")),
  vpnAction: (taskId: string, action: "start" | "stop" | "socks-start" | "socks-stop") =>
    j<VpnInfo>(`/api/tasks/${taskId}/vpn/${action}`, json("POST")),
};

// Сообщение не принято сервером (сеть до ответа, 409 «уже идёт ответ», 413, 404…): в журнал оно не попало,
// набранный текст и картинки можно вернуть в поле ввода.
export class NotSentError extends ApiError { constructor(message: string, status?: number) { super(message, status); this.name = "NotSentError"; } }

// Поток событий хода (SSE поверх POST или переподключение к идущему ходу).
// signal закрывает поток (уход из чата): иначе каждое переключение оставляет открытое соединение,
// и после шестого браузер ставит все запросы к серверу в очередь. Ход на сервере при этом продолжается.
// onOpen — сервер принял запрос (ход уже числится занятым): можно перечитать список чатов.
// Возвращает ended=true, если пришло завершающее событие хода (done/error).
export async function streamTurn(
  chatId: string,
  body: { text: string; images: string[]; effort: Effort; mode: AgentMode } | null,
  onEvent: (ev: any) => void,
  opts: { signal?: AbortSignal; onOpen?: () => void } = {},
): Promise<{ ended: boolean }> {
  const { signal, onOpen } = opts;
  let r: Response;
  try {
    r = body
      ? await fetch(`/api/chats/${chatId}/send`, { ...json("POST", body), signal })
      : await fetch(`/api/chats/${chatId}/stream`, { signal });
  } catch (e: any) {
    if (isAbort(e, signal) || !body) throw e;
    throw new NotSentError(e?.message ?? String(e));
  }
  if (r.status === 204) return { ended: true }; // хода нет
  if (!r.ok || !r.body) {
    const e = await errorOf(r);
    throw body ? new NotSentError(e.message, e.status) : e;
  }
  onOpen?.();
  const reader = r.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel);
  const dec = new TextDecoder();
  let buf = "";
  let ended = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          let ev: any;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (signal?.aborted) return { ended };
          if (ev?.type === "done" || ev?.type === "error") ended = true;
          onEvent(ev);
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  return { ended };
}

export const wsUrl = (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
export const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
export const KIND_RU: Record<string, string> = { step: "шаг", command: "команда", fact: "факт", mistake: "ошибка", result: "результат" };
