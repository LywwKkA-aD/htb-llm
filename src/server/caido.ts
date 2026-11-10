import { cfg } from "./config.ts";
import * as sandbox from "./sandbox.ts";

// Агентский доступ к Caido задачи (GraphQL поверх curl внутри контейнера — так не важны ни
// опубликованные порты, ни сеть app-контейнера в Docker-развёртывании). Формы API сверены живыми
// пробами на caido-cli 0.59.0: loginAsGuest даёт гостевой токен; без выбранного проекта история
// недоступна (и сам прокси трафик не пропускает) — проект выбираем/создаём сами и честно говорим об этом.
// raw у запросов/ответов — base64; реплей: createReplaySession → (правка черновика) → startReplayTask,
// который сам отправляет черновик; результат появляется новой записью source=REPLAY в истории.
type Gql = { data?: any; errors?: { message: string }[] };
const tokens = new Map<string, string>();
const ID_RE = /^[\w-]{1,64}$/;

async function rawGql(taskId: string, ip: string, query: string, variables?: Record<string, unknown>): Promise<Gql> {
  const token = tokens.get(taskId);
  const payload = Buffer.from(JSON.stringify({ query, ...(variables ? { variables } : {}) })).toString("base64");
  const auth = token ? ` -H 'Authorization: Bearer ${token}'` : "";
  const cmd = `printf %s ${payload} | base64 -d | curl -s --max-time 20 -X POST http://${ip}:${cfg.caidoPort}/graphql -H 'Content-Type: application/json'${auth} --data-binary @-`;
  const r = await sandbox.execCollect(taskId, cmd, 35);
  try { return JSON.parse(r.output) as Gql; }
  catch { throw new Error(`Caido GraphQL вернул не-JSON: ${r.output.slice(0, 200)}`); }
}

async function login(taskId: string, ip: string): Promise<void> {
  tokens.delete(taskId);
  const res = await rawGql(taskId, ip, "mutation { loginAsGuest { token { accessToken } } }");
  const t = res.data?.loginAsGuest?.token?.accessToken;
  if (!t) throw new Error(`Caido: гостевой вход не дал токен (${(res.errors ?? []).map((e) => e.message).join("; ").slice(0, 200) || "пустой ответ"})`);
  tokens.set(taskId, String(t));
}

async function gql(taskId: string, query: string, variables?: Record<string, unknown>): Promise<any> {
  const st = await sandbox.proxyStatus(taskId).catch(() => null);
  if (!st?.running) throw new Error("Caido не запущен: попроси пользователя включить прокси во вкладке «Прокси» задачи");
  const ip = await sandbox.containerIp(taskId);
  if (!ip) throw new Error("контейнер задачи не запущен");
  if (!tokens.has(taskId)) await login(taskId, ip);
  let res = await rawGql(taskId, ip, query, variables);
  if ((res.errors ?? []).some((e) => /unauth|not authenticated|invalid token|expired/i.test(e.message))) {
    await login(taskId, ip);
    res = await rawGql(taskId, ip, query, variables);
  }
  if (res.errors?.length) throw new Error(`Caido: ${res.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
  return res.data;
}

type Proj = { id: string; name: string; note: string };
async function ensureProject(taskId: string): Promise<Proj> {
  const cur = await gql(taskId, "{ currentProject { project { id name } } }");
  if (cur?.currentProject?.project) return { ...cur.currentProject.project, note: "" };
  const list = await gql(taskId, "{ projects { id name } }");
  const first = (list?.projects ?? [])[0];
  if (first) {
    await gql(taskId, `mutation { selectProject(id: "${first.id}") { currentProject { project { id } } } }`);
    return { id: first.id, name: first.name, note: `проект не был выбран — выбрал существующий «${first.name}»` };
  }
  const tryCreate = (temporary: boolean) =>
    gql(taskId, `mutation { createProject(input: {name: "HTB LLM", temporary: ${temporary}}) { project { id name } error { __typename } } }`);
  let made = await tryCreate(false);
  let p = made?.createProject?.project;
  let note = "проектов не было — создал и выбрал «HTB LLM» (без проекта прокси трафик не пропускает)";
  if (!p?.id) {
    // постоянный проект мог упереться в права на data-path контейнера — временный лучше, чем никакой
    made = await tryCreate(true);
    p = made?.createProject?.project;
    note = "проектов не было — создал временный «HTB LLM» (постоянный не создался; история переживёт только до остановки прокси)";
  }
  if (!p?.id) throw new Error(`Caido: не удалось создать проект (${JSON.stringify(made?.createProject ?? made).slice(0, 200)})`);
  await gql(taskId, `mutation { selectProject(id: "${p.id}") { currentProject { project { id } } } }`);
  return { id: p.id, name: p.name, note };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[обрезано, всего ${s.length} символов]` : s);
const dec = (b64: string) => { try { return Buffer.from(String(b64 ?? ""), "base64").toString("utf8"); } catch { return ""; } };

export type CaidoReqNode = {
  id: string; method: string; host: string; port: number; path: string; query?: string;
  isTls?: boolean; source?: string; length?: number;
  response?: { statusCode: number; length?: number; roundtripTime?: number } | null;
};

export async function caidoHistory(taskId: string, opts: { limit?: number; hostContains?: string; method?: string }): Promise<string> {
  const proj = await ensureProject(taskId);
  const n = Math.max(1, Math.min(50, Math.trunc(opts.limit ?? 0) || 20));
  const data = await gql(taskId,
    "query($n: Int) { requests(last: $n) { edges { node { id method host port path query isTls source length response { statusCode length roundtripTime } } } } }",
    { n });
  let nodes: CaidoReqNode[] = (data?.requests?.edges ?? []).map((e: any) => e.node as CaidoReqNode);
  const hostQ = String(opts.hostContains ?? "").toLowerCase();
  const methodQ = String(opts.method ?? "").toUpperCase();
  if (hostQ) nodes = nodes.filter((x) => `${x.host}${x.path}`.toLowerCase().includes(hostQ));
  if (methodQ) nodes = nodes.filter((x) => x.method.toUpperCase() === methodQ);
  const head = `[caido: проект «${proj.name}»${proj.note ? ` · ${proj.note}` : ""} · показано ${nodes.length} из последних ${n}]`;
  if (!nodes.length) return `${head}\nистория пуста — трафика через прокси ещё не было (браузер задачи ходит через Caido только если пользователь так настроил; http_request идёт мимо прокси)`;
  const lines = nodes.map((x) => {
    const url = `${x.isTls ? "https" : "http"}://${x.host}:${x.port}${x.path}${x.query ? `?${x.query}` : ""}`;
    const resp = x.response ? `→ ${x.response.statusCode} (${x.response.length ?? "?"}б${x.response.roundtripTime ? `, ${x.response.roundtripTime}мс` : ""})` : "→ без ответа";
    return `#${x.id} ${x.method} ${url} ${resp}${x.source && x.source !== "INTERCEPT" ? ` [${x.source}]` : ""}`;
  });
  return `${head}\n${lines.join("\n")}`;
}

export async function caidoRequestDetail(taskId: string, idRaw: string): Promise<string> {
  const id = String(idRaw ?? "").trim();
  if (!ID_RE.test(id)) throw new Error("нужен id запроса из caido_history (например 12)");
  await ensureProject(taskId);
  const data = await gql(taskId,
    "query($id: ID!) { request(id: $id) { id method host port path raw response { statusCode length roundtripTime raw } } }",
    { id });
  const r = data?.request;
  if (!r) throw new Error(`в истории Caido нет запроса #${id} (свежий список — caido_history)`);
  const resp = r.response
    ? `\n--- ответ ${r.response.statusCode} (${r.response.length ?? "?"}б${r.response.roundtripTime ? `, ${r.response.roundtripTime}мс` : ""}) ---\n${clip(dec(r.response.raw), 3500)}`
    : "\n--- ответа нет ---";
  return `[caido: запрос #${r.id} ${r.method} ${r.host}:${r.port}${r.path}]\n${clip(dec(r.raw), 2500)}${resp}`;
}

export async function caidoReplay(taskId: string, idRaw: string, rawOverride?: string, signal?: AbortSignal): Promise<string> {
  const id = String(idRaw ?? "").trim();
  if (!ID_RE.test(id)) throw new Error("нужен id запроса из caido_history (например 12)");
  await ensureProject(taskId);
  const data = await gql(taskId,
    "query($id: ID!) { request(id: $id) { id host port isTls } }", { id });
  const orig = data?.request;
  if (!orig) throw new Error(`в истории Caido нет запроса #${id}`);
  const before = await gql(taskId, "{ requests(last: 1) { edges { node { id } } } }");
  const beforeId = Number(before?.requests?.edges?.[0]?.node?.id ?? 0) || 0;
  const sess = await gql(taskId,
    `mutation { createReplaySession(input: {kind: HTTP, requestSource: {id: "${id}"}}) { session { id } } }`);
  const sid = sess?.createReplaySession?.session?.id;
  if (!sid) throw new Error("Caido: не создал replay-сессию");
  if (rawOverride && String(rawOverride).trim()) {
    let raw = String(rawOverride);
    if (!raw.includes("\r\n")) raw = raw.replace(/\n/g, "\r\n");
    await gql(taskId,
      "mutation($id: ID!, $raw: String, $host: String!, $port: Port!, $tls: Boolean!) { updateReplayEntryDraft(id: $id, input: {http: {raw: $raw, connection: {host: $host, port: $port, isTLS: $tls}, settings: {placeholders: []}, editorState: \"\"}}) { entry { ... on ReplayEntryHttp { id } } } }",
      { id: String(sid), raw: Buffer.from(raw, "utf8").toString("base64"), host: orig.host, port: orig.port, tls: Boolean(orig.isTls) });
  }
  await gql(taskId, `mutation { startReplayTask(sessionId: "${sid}") { task { id } } }`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 14; i++) {
    if (signal?.aborted) throw new Error("остановлено пользователем");
    await sleep(1500);
    const d = await gql(taskId, "{ requests(last: 6) { edges { node { id source response { statusCode } } } } }");
    const nodes: CaidoReqNode[] = (d?.requests?.edges ?? []).map((e: any) => e.node as CaidoReqNode);
    const hit = nodes.filter((x) => Number(x.id) > beforeId && x.source === "REPLAY" && x.response).at(-1);
    if (hit) return `[caido_replay: повтор #${id} выполнен как #${hit.id}${rawOverride ? " (с правкой raw)" : ""}]\n${await caidoRequestDetail(taskId, String(hit.id))}`;
  }
  return `[caido_replay: повтор #${id} отправлен (сессия ${sid}), но ответ за ~20 с в истории не появился — досмотри caido_history]`;
}
