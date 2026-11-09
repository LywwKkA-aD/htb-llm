import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import multer from "multer";
import { WebSocketServer, type WebSocket } from "ws";
import { nanoid, customAlphabet } from "nanoid";
import { cfg, paths, ROOT, isTaskId, type AgentMode } from "./config.ts";
import { db, now, taskExists, type Task, type Chat } from "./db.ts";
import { health, clip, activeReasoningInfo, ALL_EFFORTS } from "./llm.ts"; // clip — по кодовым точкам: эмодзи на границе не режется пополам (иначе «�»)
import * as sandbox from "./sandbox.ts";
import * as library from "./library.ts";
import * as memory from "./memory.ts";
import * as plan from "./plan.ts";
import * as profile from "./profile.ts";
import { runTurn, stopTurn, stopAndWait, isBusy, getChat, deleteChatState } from "./graph.ts";
import { listServices, startService, stopService, type ServiceId } from "./services.ts";
import { activeEmbed, activeLlm, llmCompactAt, publicSettings, saveSettings, testConnection, embedIndexInfo, PRESETS, type Preset } from "./settings.ts";
import { invalidateOrStats, openRouterStats } from "./openrouter.ts";
import * as htb from "./htb.ts";
import type { Effort } from "./llm.ts";

const taskId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 10); // имя контейнера — только [a-z0-9]
const app = express();
// Защита от DNS-rebinding: чужая страница, чьё имя вдруг резолвится в 127.0.0.1, не должна дотянуться
// до API и root-shell контейнера. Принимаем только свои имена хоста и свой Origin (WebSocket и /api, см. ниже).
const okHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `${cfg.host}:${cfg.port}`, `[::1]:${cfg.port}`,
  "localhost:5173", "127.0.0.1:5173", // pnpm dev:web (vite проксирует с исходным Host)
  ...(process.env.WH_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean)]);
const hostOk = (h?: string) => {
  if (!h) return false;
  const lower = h.toLowerCase();
  if (okHosts.has(lower)) return true;
  // Docker публикует внутренний порт на произвольный loopback-порт хоста. Граница безопасности —
  // именно loopback-имя, а не совпадение внешнего порта с внутренним cfg.port.
  try {
    const u = new URL(`http://${lower}`);
    return !!u.port && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]");
  } catch { return false; }
};
const exactHostOk = (h?: string) => !!h && okHosts.has(h.toLowerCase());
// Origin строже Host: loopback с другим портом — это уже другая локальная страница. Свой UI на
// опубликованном Docker-порту узнаём по равенству Origin и Host самого запроса (same-origin).
const originOk = (o?: string, reqHost?: string) => !o || (() => {
  try {
    const originHost = new URL(o).host.toLowerCase();
    return exactHostOk(originHost) || (!!reqHost && originHost === reqHost.toLowerCase());
  } catch { return false; }
})();
app.use((req, res, next) => (hostOk(req.headers.host) ? next() : res.status(403).json({ error: "недопустимый Host" })));
// CSRF: чужая страница не прочитает ответ (CORS), но «простой» POST (multipart, text/plain, no-cors) браузер
// отправит — с Host 127.0.0.1:7331 и своим Origin. Так можно было бы залить 50×200 МБ в библиотеку
// или остановить контейнер. Браузер ставит Origin на любой не-GET и на любой кросс-доменный запрос,
// поэтому чужой (и «null» — песочница, file://) отклоняем; без Origin — curl, тесты, свои GET.
app.use("/api", (req, res, next) => (originOk(req.headers.origin, req.headers.host) ? next() : res.status(403).json({ error: "запрос с чужой страницы отклонён (Origin)" })));
let shuttingDown = false; // SIGTERM/SIGINT: новые запросы не принимаем, идущие ходы останавливаем (см. конец файла)
const notStopping = (_req: express.Request, res: express.Response, next: express.NextFunction) =>
  (shuttingDown ? res.status(503).json({ error: "сервер останавливается" }) : next());
app.use(notStopping);
const MAX_JSON_MB = 40, MAX_FILES = 50, MAX_FILE_MB = 200;
app.use(express.json({ limit: `${MAX_JSON_MB}mb` })); // картинки в чат приходят data-URL'ами
// и ещё раз после разбора тела: запрос, начатый до SIGTERM (тело 30 МБ ещё грузилось), не должен начать ход,
// которого остановка уже не увидит. От этой проверки до runTurn (active.set) всё синхронно — щели нет.
app.use(notStopping);

// Ошибка с HTTP-статусом (по умолчанию ручки отвечают 400 — это ошибки ввода)
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) =>
  async (req: express.Request, res: express.Response) => {
    try {
      const r = await fn(req, res);
      if (!res.headersSent) res.json(r ?? { ok: true });
    } catch (e: any) {
      console.error("[api]", req.method, req.path, e?.message ?? e);
      if (!res.headersSent) res.status(e instanceof HttpError ? e.status : 400).json({ error: e?.message ?? String(e) });
    }
  };
const P = (req: express.Request, k: string) => String(req.params[k]);
// необязательное строковое поле тела: undefined → дефолт, строка → как есть, остальное (null, число, объект) — 400
function str(v: unknown, field: string, def = ""): string {
  if (v === undefined) return def;
  if (typeof v !== "string") throw new HttpError(400, `поле ${field} должно быть строкой`);
  return v;
}

// id задачи в пути: router декодирует %2F, и «..%2F..%2Fx» превратился бы в путь вне data/tasks
// (mkdir при старте контейнера, rm -rf при удалении). Пропускаем только формат, который генерирует сервер;
// существование задачи не проверяем — у удалённой задачи контейнер честно «missing».
app.use("/api/tasks/:id", (req, res, next) => (isTaskId(P(req, "id")) ? next() : res.status(404).json({ error: "нет такой задачи" })));

// ---------- состояние ----------
app.get("/api/health", wrap(async () => {
  const h = await health();
  let dockerOk = false, image = false;
  try { await sandbox.docker.ping(); dockerOk = true; image = (await sandbox.docker.listImages({ filters: { reference: [cfg.image] } })).length > 0; } catch { /* ignore */ }
  const act = activeLlm();
  const emb = activeEmbed();
  const reasoning = await activeReasoningInfo(act).catch(() => null);
  return { ...h, docker: dockerOk, image, model: act.model, ctxWindow: act.ctxWindow || cfg.ctxWindow, compactAt: llmCompactAt(), preset: act.preset, llmPreset: act.preset, embedPreset: emb.preset, reasoning };
}));

// ---------- общие настройки (модель и эмбеддинги: пресеты локальная / OpenRouter / свой API) ----------
app.get("/api/settings", wrap(() => ({ ...publicSettings(), embedIndex: embedIndexInfo(), reindex: library.reindexState, knowledge: library.knowledgeState })));
app.put("/api/settings", wrap((req) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (b.llm === undefined && b.embed === undefined && b.agents === undefined && b.openrouterMgmt === undefined) throw new Error("пустые настройки");
  const saved = saveSettings({ llm: b.llm, embed: b.embed, agents: b.agents, openrouterMgmt: b.openrouterMgmt });
  invalidateOrStats(); // новые адрес/ключи должны подействовать при следующем открытии статистики сразу
  return { ...publicSettings(saved), embedIndex: embedIndexInfo(saved), reindex: library.reindexState, knowledge: library.knowledgeState };
}));
app.post("/api/settings/reindex", wrap(() => library.startReindex()));
app.get("/api/settings/reindex", wrap(() => ({ reindex: library.reindexState, embedIndex: embedIndexInfo() })));
// Построение базы знаний из веба: тот же пайплайн, что ./docker/run.sh knowledge (скачать источники + индекс)
app.post("/api/settings/knowledge", wrap(() => library.startKnowledgeBuild()));
app.get("/api/settings/knowledge", wrap(() => ({ knowledge: library.knowledgeState, embedIndex: embedIndexInfo() })));
// Статистика расходов OpenRouter (инференс-ключ + management-ключ); ?refresh=1 — мимо минутного кэша
app.get("/api/stats/openrouter", wrap((req) => openRouterStats(req.query.refresh === "1")));
app.post("/api/settings/test", wrap(async (req) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const kind = b.kind === "embed" ? "embed" : b.kind === "llm" ? "llm" : null;
  if (!kind) throw new Error("kind: llm или embed");
  if (!PRESETS.includes(b.preset as Preset)) throw new Error("неизвестный пресет");
  return testConnection(kind, b.preset as Preset, (b.config ?? undefined) as never);
}));

// ---------- сервисы моделей (Qwen и эмбеддинги из веба) ----------
app.get("/api/services", wrap(() => listServices()));
app.post("/api/services/:id/:action", wrap(async (req) => {
  const id = P(req, "id"), a = P(req, "action");
  if (id !== "llm" && id !== "embed") throw new HttpError(404, "нет такого сервиса");
  if (a === "start") return startService(id as ServiceId);
  if (a === "stop") return stopService(id as ServiceId);
  throw new Error("неизвестное действие");
}));

// ---------- задачи ----------
app.get("/api/tasks", wrap(async () => {
  const tasks = db.prepare(`select t.*,
      (select count(*) from chats c where c.task_id=t.id) as chats,
      (select count(*) from memories m where m.task_id=t.id and m.status='pending') as pending,
      (select count(*) from memories m where m.task_id=t.id and m.status='confirmed') as memories,
      (select count(*) from plan_items p where p.task_id=t.id) as plan_total,
      (select count(*) from plan_items p where p.task_id=t.id and p.status='done') as plan_done,
      (select count(*) from profile_items pf where pf.task_id=t.id) as profile_total
    from tasks t order by updated_at desc`).all() as (Task & Record<string, number>)[];
  return Promise.all(tasks.map(async (t) => ({ ...t, container: await sandbox.status(t.id) })));
}));
const TITLE_MAX = 200;
const taskTitle = (v: unknown) => {
  const t = clip(str(v, "title").trim(), TITLE_MAX).trim(); // trim и после обрезки: срез мог прийтись на пробел
  if (!t) throw new HttpError(400, "нужно название задачи");
  return t;
};
const isIpv4 = (s: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
};
function optTarget(v: unknown, fallback = "") {
  if (v === undefined || v === null) return fallback;
  const s = str(v, "target").trim();
  if (s && !isIpv4(s)) throw new HttpError(400, "target должен быть IPv4-адресом");
  return s;
}
function optHostname(v: unknown, fallback = "") {
  if (v === undefined || v === null) return fallback;
  const s = str(v, "hostname").trim().toLowerCase();
  if (s && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(s)) throw new HttpError(400, "hostname должен быть DNS-именем");
  return s;
}
const htbHostname = (name: string) => {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s ? `${s}.htb` : "";
};
// Активный HTB-инстанс получил новый IP — обновить TARGET/hostname и строку IP в брифе существующей задачи
// и разнести новый адрес по живому контейнеру (hosts/TASK.md/профиль — sandbox.applyTargetChange).
async function syncHtbTaskTarget(m: { id: number; name?: string; ip?: string | null } | null | undefined) {
  if (!m?.ip || !isIpv4(m.ip)) return;
  const marker = `HTB machine #${m.id}`;
  let t = db.prepare("select * from tasks where brief like ?").get(`${marker}%`) as Task | undefined;
  if (!t && m.name) {
    // задача создана вручную без маркера импорта: единственный кандидат с hostname этой машины
    const rows = db.prepare("select * from tasks where hostname=?").all(htbHostname(m.name)) as Task[];
    if (rows.length === 1) t = rows[0];
  }
  if (!t) return;
  const hostname = t.hostname || htbHostname(m.name ?? t.title);
  let brief = t.brief;
  if (/^IP \(текущий инстанс\):.*$/m.test(brief)) brief = brief.replace(/^IP \(текущий инстанс\):.*$/m, `IP (текущий инстанс): ${m.ip}`);
  else brief = brief.replace(/^IP:.*$/m, `IP (текущий инстанс): ${m.ip}`);
  if (t.target !== m.ip || t.hostname !== hostname || brief !== t.brief) {
    db.prepare("update tasks set target=?, hostname=?, brief=?, updated_at=? where id=?").run(m.ip, hostname, brief, now(), t.id);
    if (t.target !== m.ip) await sandbox.applyTargetChange(t.id, t.target, m.ip).catch(() => {});
  }
}
async function htbStatusSynced(refresh = false) {
  const st = await htb.htbStatus(refresh);
  await syncHtbTaskTarget(st.activeMachine);
  return st;
}
function createTaskWithChat(title: string, course: string, brief: string, target = "", hostname = "") {
  const id = taskId();
  db.prepare("insert into tasks(id,title,course,brief,target,hostname,created_at,updated_at) values(?,?,?,?,?,?,?,?)").run(id, title, course, brief, target, hostname, now(), now());
  const chat = newChat(id);
  void sandbox.ensure(id).catch((e) => console.error("[sandbox]", e.message)); // контейнер поднимается в фоне
  return { task: db.prepare("select * from tasks where id=?").get(id) as Task, chat };
}
app.post("/api/tasks", wrap(async (req) => {
  const b = req.body ?? {};
  return createTaskWithChat(taskTitle(b.title), str(b.course, "course"), str(b.brief, "brief"), optTarget(b.target), optHostname(b.hostname));
}));

// ---------- HackTheBox: профиль и прогресс, активная машина, импорт в задачу ----------
app.get("/api/htb/status", wrap((req) => htbStatusSynced(req.query.refresh === "1").catch((e) => ({ configured: htb.htbConfigured(), error: (e as Error).message }))));
app.post("/api/htb/token", wrap(async (req) => {
  await htb.setToken(str(req.body?.token, "token"));
  return htbStatusSynced(true);
}));
app.delete("/api/htb/token", wrap(() => { htb.deleteToken(); return { configured: false }; }));
app.get("/api/htb/machines", wrap((req) => htb.searchMachines(str(req.query.q ?? "", "q"))));
app.post("/api/htb/spawn", wrap(async (req) => {
  const id = Number(req.body?.machineId);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "нужен machineId");
  await htb.spawnMachine(id);
  return htbStatusSynced(true);
}));
app.post("/api/htb/stop", wrap(async () => { await htb.stopActiveMachine(); return htbStatusSynced(true); }));
app.post("/api/htb/import", wrap(async (req) => {
  const bodyId = Number(req.body?.machineId);
  let m: htb.HtbMachine | null = null;
  let ipNote = "";
  if (Number.isInteger(bodyId) && bodyId > 0) { m = await htb.machineProfile(bodyId); if (m.ip) ipNote = `\nIP (текущий инстанс): ${m.ip}`; }
  else {
    const st = await htbStatusSynced(true);
    if (!st.activeMachine) throw new HttpError(400, "у HTB сейчас нет активной машины — запусти её поиском ниже или на сайте");
    m = st.activeMachine;
    ipNote = st.activeMachine.ip ? `\nIP (текущий инстанс): ${st.activeMachine.ip}` : "\nIP: машина ещё стартует, адрес появится в блоке HTB";
  }
  // одна задача на машину: маркер первой строкой брифа, повторный импорт открывает существующую
  const marker = `HTB machine #${m.id}`;
  const exist = db.prepare("select * from tasks where brief like ?").get(`${marker}%`) as Task | undefined;
  if (exist) {
    syncHtbTaskTarget({ id: m.id, name: m.name, ip: m.ip });
    const task = db.prepare("select * from tasks where id=?").get(exist.id) as Task;
    const chat = db.prepare("select * from chats where task_id=? order by created_at desc limit 1").get(exist.id) as Chat;
    return { task, chat, existed: true };
  }
  const brief = `${marker} · ${m.os} · ${m.difficultyText}${m.points ? ` · ${m.points} pts` : ""}${ipNote}
Цель — user.txt и root.txt. VPN этой задачи подключается во вкладке VPN (.ovpn от HTB), адрес для обратных соединений — $LHOST в контейнере.
Возможный порядок этапов (общая цель, не поручение выполнять этапы без указания пользователя): скан портов и энумерация сервисов → точка входа → стабильный шелл → user → повышение привилегий → root. Находки и креды — карточками в память задачи.`;
  return { ...createTaskWithChat(taskTitle(m.name), "HackTheBox", brief, m.ip && isIpv4(m.ip) ? m.ip : "", htbHostname(m.name)), existed: false };
}));
app.patch("/api/tasks/:id", wrap(async (req) => {
  const t = db.prepare("select * from tasks where id=?").get(P(req, "id")) as Task | undefined;
  if (!t) throw new HttpError(404, "нет задачи");
  const b = req.body ?? {};
  const title = b.title === undefined ? t.title : taskTitle(b.title);
  const course = str(b.course, "course", t.course), brief = str(b.brief, "brief", t.brief);
  const target = optTarget(b.target, t.target), hostname = optHostname(b.hostname, t.hostname);
  db.prepare("update tasks set title=?, course=?, brief=?, target=?, hostname=?, updated_at=? where id=?").run(title, course, brief, target, hostname, now(), t.id);
  if (target !== t.target) await sandbox.applyTargetChange(t.id, t.target, target).catch(() => {});
  return db.prepare("select * from tasks where id=?").get(t.id);
}));
app.delete("/api/tasks/:id", wrap(async (req) => {
  const id = P(req, "id");
  for (const c of db.prepare("select id from chats where task_id=?").all(id) as { id: string }[]) {
    await stopAndWait(c.id); // прерванный ход должен закончиться до удаления записей
    await deleteChatState(c.id);
    chatBuses.delete(c.id);
  }
  for (const d of db.prepare("select id from docs where task_id=?").all(id) as { id: number }[]) library.deleteDoc(d.id);
  await sandbox.destroy(id).catch((e) => console.warn("[destroy]", e.message));
  db.prepare("delete from tasks where id=?").run(id);
}));

// ---------- контейнер ----------
app.get("/api/tasks/:id/container", wrap(async (req) => ({ status: await sandbox.status(P(req, "id")) })));
app.post("/api/tasks/:id/container/:action", wrap(async (req) => {
  const id = P(req, "id"), a = P(req, "action");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи"); // не создавать контейнеры-сироты для чужих id
  if (a === "start") await sandbox.ensure(id);
  else if (a === "stop") await sandbox.stop(id);
  else if (a === "reset") await sandbox.reset(id);
  else throw new Error("неизвестное действие");
  return { status: await sandbox.status(id) };
}));
app.get("/api/tasks/:id/history", wrap((req) => sandbox.userHistory(P(req, "id"), 200)));
app.delete("/api/tasks/:id/shells/:sid", wrap(async (req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  await sandbox.killUserShell(id, sandbox.shellSid(P(req, "sid")));
  return { ok: true };
}));

// ---------- фоновые jobs (tmux-сессии в контейнере задачи) ----------
const jobOr404 = (taskId: string, jobId: string) => {
  if (!taskExists(taskId)) throw new HttpError(404, "нет такой задачи");
  if (!sandbox.getJob(taskId, jobId)) throw new HttpError(404, "нет такого job");
};
app.get("/api/tasks/:id/jobs", wrap(async (req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return sandbox.listJobs(id);
}));
app.post("/api/tasks/:id/jobs", wrap(async (req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return sandbox.createJob(id, str(req.body?.name, "name"), str(req.body?.command, "command"));
}));
app.get("/api/tasks/:id/jobs/:job/output", wrap(async (req) => {
  jobOr404(P(req, "id"), P(req, "job"));
  return sandbox.jobOutput(P(req, "id"), P(req, "job"), Number(req.query.lines) || 160);
}));
app.post("/api/tasks/:id/jobs/:job/input", wrap(async (req) => {
  jobOr404(P(req, "id"), P(req, "job"));
  return sandbox.jobInput(P(req, "id"), P(req, "job"), str(req.body?.text, "text"), req.body?.enter !== false);
}));
app.post("/api/tasks/:id/jobs/:job/stop", wrap(async (req) => {
  jobOr404(P(req, "id"), P(req, "job"));
  return sandbox.stopJob(P(req, "id"), P(req, "job"));
}));
app.delete("/api/tasks/:id/jobs/:job", wrap(async (req) => {
  jobOr404(P(req, "id"), P(req, "job"));
  await sandbox.deleteJob(P(req, "id"), P(req, "job"));
  return { ok: true };
}));

// ---------- план решения задачи ----------
app.get("/api/tasks/:id/plan", wrap((req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return { items: plan.listPlan(id), phases: plan.PLAN_PHASES };
}));
app.post("/api/tasks/:id/plan", wrap((req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return plan.addPlanItem(id, req.body?.phase, req.body?.text, req.body?.status);
}));
app.patch("/api/tasks/:id/plan/:item", wrap((req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return plan.updatePlanItem(id, P(req, "item"), req.body ?? {});
}));
app.delete("/api/tasks/:id/plan/:item", wrap((req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  plan.removePlanItem(id, P(req, "item"));
  return { ok: true };
}));

// ---------- профиль цели и креды ----------
app.get("/api/tasks/:id/profile", wrap((req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return { items: profile.listProfile(id), kinds: profile.PROFILE_KINDS };
}));
app.post("/api/tasks/:id/profile", wrap((req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return profile.addProfileItem(id, req.body?.kind, req.body ?? {});
}));
app.patch("/api/tasks/:id/profile/:item", wrap((req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return profile.updateProfileItem(id, P(req, "item"), req.body ?? {});
}));
app.delete("/api/tasks/:id/profile/:item", wrap((req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  profile.removeProfileItem(id, P(req, "item"));
  return { ok: true };
}));

// ---------- файлы /work задачи ----------
app.get("/api/tasks/:id/files", wrap((req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return { files: sandbox.listWorkFiles(id) };
}));
app.get("/api/tasks/:id/files/preview", wrap(async (req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return sandbox.previewWorkFile(id, String(req.query.path ?? ""));
}));
app.get("/api/tasks/:id/files/download", wrap(async (req, res) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  const f = await sandbox.readWorkFile(id, String(req.query.path ?? ""));
  const name = f.rel.split("/").at(-1) || "file";
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(f.bytes);
}));

// ---------- чаты ----------
function newChat(task: string) {
  const id = nanoid(12);
  db.prepare("insert into chats(id,task_id,created_at,updated_at) values(?,?,?,?)").run(id, task, now(), now());
  return getChat(id)!;
}
app.get("/api/tasks/:id/chats", wrap((req) =>
  (db.prepare("select * from chats where task_id=? order by updated_at desc").all(P(req, "id")) as Chat[]).map((c) => ({ ...c, busy: isBusy(c.id) }))));
app.post("/api/tasks/:id/chats", wrap((req) => {
  if (!taskExists(P(req, "id"))) throw new HttpError(404, "нет такой задачи");
  return newChat(P(req, "id"));
}));
app.patch("/api/chats/:id", wrap((req) => {
  const id = P(req, "id");
  if (!getChat(id)) throw new HttpError(404, "чат не найден");
  const title = clip(str(req.body?.title, "title").trim().replace(/\s+/g, " "), 120).trim() || "чат";
  db.prepare("update chats set title=? where id=?").run(title, id);
  return getChat(id);
}));
app.delete("/api/chats/:id", wrap(async (req) => {
  const id = P(req, "id");
  await stopAndWait(id);
  await deleteChatState(id);
  chatBuses.delete(id);
  partial.delete(id);
  db.prepare("delete from chats where id=?").run(id);
}));
app.get("/api/chats/:id/log", wrap((req) => {
  const chat = getChat(P(req, "id"));
  if (!chat) throw new HttpError(404, "чат не найден");
  const rows = db.prepare("select id,kind,data,created_at from chat_log where chat_id=? order by id").all(chat.id) as { id: number; kind: string; data: string; created_at: number }[];
  return { chat: { ...chat, busy: isBusy(chat.id) }, ctxWindow: activeLlm().ctxWindow || cfg.ctxWindow, log: rows.map((r) => ({ ...r, data: JSON.parse(r.data) })) };
}));

// Ход агента: события идут в шину чата; SSE-клиент (или переподключившийся) читает из шины.
const chatBuses = new Map<string, EventEmitter>();
// Подписчик шины — один SSE-ответ (вкладка, переподключение). Вкладок может быть сколько угодно, каждый
// подписчик снимается по close ответа, поэтому предела нет (setMaxListeners(20) давал MaxListenersExceededWarning).
const busOf = (id: string) => { let b = chatBuses.get(id); if (!b) { b = new EventEmitter(); b.setMaxListeners(0); chatBuses.set(id, b); } return b; };

// Что произошло после последней записи в журнал чата (недописанный ответ, идущая команда) — для клиента,
// который переподключился посреди хода (перезагрузил страницу): журнал + это = полная картина.
const partial = new Map<string, Record<string, any>[]>();
function track(chatId: string, ev: Record<string, any>) {
  let p = partial.get(chatId) ?? [];
  if (["assistant_end", "tool_end", "done", "error"].includes(ev.type)) p = []; // это уже в журнале
  else if (ev.type === "token" || ev.type === "reasoning") {
    const last = p.at(-1);
    if (last && last.type === ev.type) last.t += ev.t; else p.push({ ...ev });
  } else if (["assistant_start", "tool_start", "recall", "compacting"].includes(ev.type)) p.push({ ...ev });
  partial.set(chatId, p);
}

function sse(res: express.Response, bus: EventEmitter, replay: Record<string, any>[] = []) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": ok\n\n");
  for (const ev of replay) res.write(`data: ${JSON.stringify(ev)}\n\n`); // синхронно, до подписки — без пропусков
  const on = (ev: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (ev.type === "done" || ev.type === "error") { cleanup(); res.end(); }
  };
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  const cleanup = () => { clearInterval(ping); bus.off("ev", on); };
  bus.on("ev", on);
  res.on("close", cleanup);
}

const EFFORTS: Effort[] = ALL_EFFORTS;
app.post("/api/chats/:id/send", (req, res) => {
  const id = P(req, "id");
  const b = req.body ?? {};
  if (!getChat(id)) return res.status(404).json({ error: "чат не найден" });
  // тело нормализуем ДО ответа 200: после sse() ошибку уже не вернуть статусом
  if (b.text !== undefined && typeof b.text !== "string") return res.status(400).json({ error: "text должен быть строкой" });
  if (b.images !== undefined && !Array.isArray(b.images)) return res.status(400).json({ error: "images должен быть массивом data:image/-адресов" });
  const text: string = b.text ?? "";
  const images = ((b.images ?? []) as unknown[]).filter((u): u is string => typeof u === "string" && u.startsWith("data:image/")).slice(0, 4);
  const effort: Effort = EFFORTS.includes(b.effort) ? b.effort : "xhigh";
  const mode: AgentMode = b.mode === "autonomous" ? "autonomous" : "guided"; // отсутствующий/битый режим — безопасный ведомый
  if (!text.trim() && !images.length) return res.status(400).json({ error: "пустое сообщение" }); // после фильтра картинок
  if (isBusy(id)) return res.status(409).json({ error: "в этом чате уже идёт ответ" });
  const bus = busOf(id);
  sse(res, bus);
  void runTurn(id, text, images, effort, mode, (ev) => { track(id, ev); bus.emit("ev", ev); })
    .catch((e) => console.error("[turn]", e)); // необработанный reject уронил бы весь сервер (Node 24)
});
app.get("/api/chats/:id/stream", (req, res) => {
  const id = P(req, "id");
  if (!isBusy(id)) return res.status(204).end();
  sse(res, busOf(id), partial.get(id) ?? []);
});
app.post("/api/chats/:id/stop", wrap((req) => { stopTurn(P(req, "id")); }));

// ---------- память ----------
app.get("/api/tasks/:id/memories", wrap((req) => memory.list(P(req, "id"))));
// Заголовок и текст карточки уходят в системный промпт как «- [вид] заголовок: текст» — пустыми быть не могут.
const memField = (v: unknown, field: "title" | "content") => {
  const s = str(v, field).trim();
  if (!s) throw new HttpError(400, field === "title" ? "заголовок карточки не может быть пустым" : "текст карточки не может быть пустым");
  return s;
};
app.post("/api/tasks/:id/memories", wrap(async (req) => {
  const b = req.body ?? {};
  if (b.title === undefined || b.content === undefined) throw new HttpError(400, "нужны заголовок и текст");
  const m = { kind: str(b.kind, "kind", "fact"), title: memField(b.title, "title"), content: memField(b.content, "content") };
  if (!taskExists(P(req, "id"))) throw new HttpError(404, "нет такой задачи");
  return memory.addConfirmed(P(req, "id"), m);
}));
app.post("/api/memories/:id/confirm", wrap((req) => {
  const b = req.body ?? {};
  // подтверждение без правок — {}; с правками — только переданные поля, и пустые запрещены
  const edit: { kind?: string; title?: string; content?: string } = {};
  if (b.kind !== undefined) edit.kind = str(b.kind, "kind");
  if (b.title !== undefined) edit.title = memField(b.title, "title");
  if (b.content !== undefined) edit.content = memField(b.content, "content");
  return memory.confirm(Number(P(req, "id")), edit);
}));
app.post("/api/memories/:id/reject", wrap((req) => { memory.reject(Number(P(req, "id"))); }));
app.delete("/api/memories/:id", wrap((req) => { memory.remove(Number(P(req, "id"))); }));

// ---------- библиотека ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: paths.uploads,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${nanoid(6)}${path.extname(fixName(file.originalname)).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});
// multer отдаёт originalname в latin1 — кириллица превращается в кракозябры
const fixName = (n: string) => { const u = Buffer.from(n, "latin1").toString("utf8"); return u.includes("�") ? n : u; };
app.get("/api/docs", wrap((req) => library.listDocs(req.query.task ? String(req.query.task) : null)));
app.post("/api/docs", upload.array("files", MAX_FILES), wrap((req) => {
  const task = req.body?.task ? String(req.body.task) : null;
  const files = (req.files as Express.Multer.File[]) ?? [];
  const reject = (status: number, msg: string) => { for (const f of files) fs.rmSync(f.path, { force: true }); throw new HttpError(status, msg); };
  // загрузка шла, когда пришёл SIGTERM: индексацию уже не довести — файлы убираем, клиент повторит
  if (shuttingDown) reject(503, "сервер останавливается");
  if (task && !taskExists(task)) reject(404, "нет такой задачи");
  const out = [];
  for (const f of files) {
    const name = fixName(f.originalname);
    try { out.push(library.addDoc(f.path, name, task)); }
    catch (e: any) { fs.rmSync(f.path, { force: true }); out.push({ name, error: e.message }); }
  }
  return out;
}));
app.delete("/api/docs/:id", wrap((req) => { library.deleteDoc(Number(P(req, "id"))); }));

// ---------- VPN задачи (HTB): конфиг файлом, туннель внутри контейнера, SOCKS для браузера хоста ----------
const uploadVpn = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });
async function vpnPayload(id: string) {
  const container = await sandbox.status(id);
  const status = await sandbox.vpnStatus(id).catch(() => ({ state: "down" as const, log: [] as string[], socks: { running: false } }));
  return { config: sandbox.getVpnConfig(id), container, containerIp: container === "running" ? await sandbox.containerIp(id) : null, status };
}
app.get("/api/tasks/:id/vpn", wrap((req) => vpnPayload(P(req, "id"))));
app.post("/api/tasks/:id/vpn/config", uploadVpn.single("file"), wrap(async (req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  const f = req.file;
  if (!f) throw new HttpError(400, "нужен файл конфига в поле file (.ovpn или .conf)");
  await sandbox.saveVpnConfig(id, fixName(f.originalname), f.buffer);
  return vpnPayload(id);
}));
app.delete("/api/tasks/:id/vpn/config", wrap(async (req) => {
  await sandbox.deleteVpnConfig(P(req, "id"));
  return vpnPayload(P(req, "id"));
}));
app.post("/api/tasks/:id/vpn/:action", wrap(async (req) => {
  const id = P(req, "id"), a = P(req, "action");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  if (a === "start") await sandbox.startVpn(id);
  else if (a === "stop") await sandbox.stopVpn(id);
  else if (a === "socks-start") await sandbox.startSocks(id);
  else if (a === "socks-stop") await sandbox.stopSocks(id);
  else throw new Error("неизвестное действие");
  return vpnPayload(id);
}));

// ---------- встроенный браузер задачи (Selkies-Firefox в netns контейнера) ----------
app.get("/api/tasks/:id/browser", wrap(async (req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return sandbox.browserStatus(id);
}));
app.post("/api/tasks/:id/browser/:action", wrap(async (req) => {
  const id = P(req, "id"), a = P(req, "action");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  if (a === "start") return sandbox.startBrowser(id);
  if (a === "stop") return sandbox.stopBrowser(id);
  throw new Error("неизвестное действие");
}));

// ---------- перехватывающий прокси задачи (Caido) ----------
app.get("/api/tasks/:id/proxy", wrap(async (req) => {
  const id = P(req, "id");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  return sandbox.proxyStatus(id);
}));
app.post("/api/tasks/:id/proxy/:action", wrap(async (req) => {
  const id = P(req, "id"), a = P(req, "action");
  if (!taskExists(id)) throw new HttpError(404, "нет такой задачи");
  if (a === "start") return sandbox.startProxy(id);
  if (a === "stop") return sandbox.stopProxy(id);
  throw new Error("неизвестное действие");
}));

// ---------- статика (собранный интерфейс) ----------
// WH_WEB_DIST — собрать интерфейс в свой каталог (параллельные e2e-прогоны с разными сборками не мешают друг другу)
const dist = process.env.WH_WEB_DIST || path.join(ROOT, "web", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

// ---------- ошибки: JSON {error} вместо HTML-страницы finalhandler'а со стеком ----------
// Сюда приходят ошибки, которые случились вне wrap(): multer (лимиты загрузки), express.json (размер, кривой JSON),
// декодирование пути. Интерфейс показывает поле error — значит, текст должен объяснять причину.
app.use("/api", (_req, res) => { res.status(404).json({ error: "нет такого метода API" }); });
function describeError(err: any, req: express.Request): [number, string] {
  if (err instanceof multer.MulterError) {
    const fname = (err as { filename?: string }).filename; // multer 2.x кладёт имя файла (в latin1), в типах его нет
    const file = fname ? `«${fixName(fname)}»` : "файл";
    if (err.code === "LIMIT_UNEXPECTED_FILE")
      return err.field === "files" ? [400, `не больше ${MAX_FILES} файлов за раз`] : [400, `неожиданное поле «${err.field}»: файлы передаются в поле files`];
    if (err.code === "LIMIT_FILE_SIZE") return [413, `${file} больше ${MAX_FILE_MB} МБ`];
    return [400, `загрузка отклонена: ${err.message}`];
  }
  if (err?.type === "entity.too.large") return [413, `запрос больше ${MAX_JSON_MB} МБ (картинки?)`];
  if (err?.type === "entity.parse.failed") return [400, "некорректный JSON в теле запроса"];
  const status = Number(err?.status ?? err?.statusCode);
  if (status >= 400 && status < 500) return [status, String(err?.message || "некорректный запрос")];
  if (req.is("multipart")) return [400, `загрузка прервана или повреждена: ${err?.message ?? err}`]; // ошибки busboy — без статуса
  return [500, `внутренняя ошибка сервера: ${err?.message ?? err}`];
}
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const [status, error] = describeError(err, req);
  if (status >= 500) console.error("[api]", req.method, req.path, err);
  else console.warn("[api]", req.method, req.path, status, error);
  res.status(status).json({ error });
});

// ---------- WebSocket: терминал агента и shell пользователя ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  const task = url.searchParams.get("task") ?? "";
  const ok = !shuttingDown && isTaskId(task) && taskExists(task);
  if (!ok || !["/ws/agent", "/ws/shell"].includes(url.pathname) || !hostOk(req.headers.host) || !originOk(req.headers.origin, req.headers.host)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => (url.pathname === "/ws/agent" ? agentTerm(ws, task) : userShell(ws, task, sandbox.shellSid(url.searchParams.get("sid")))));
});

function agentTerm(ws: WebSocket, task: string) {
  ws.send(sandbox.agentLogTail(task));
  const on = (s: string) => ws.readyState === ws.OPEN && ws.send(s);
  const bus = sandbox.agentBus(task);
  bus.on("data", on);
  ws.on("close", () => bus.off("data", on));
}

async function userShell(ws: WebSocket, task: string, sid = 1) {
  // Обработчики вешаем СРАЗУ: клиент шлёт размер терминала в момент открытия, а shell ещё поднимается
  // (контейнер может стартовать секунды). Ввод и последний размер придерживаем до готовности.
  let sh: Awaited<ReturnType<typeof sandbox.openUserShell>> | null = null;
  let closed = false;
  const pendingIn: string[] = [];
  let size = null as { c: number; r: number } | null; // as — иначе TS сужает до null (присваивание в колбэке не видит)
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(String(raw));
      if (m.t === "in") { if (sh) sh.stream.write(m.d); else pendingIn.push(String(m.d)); }
      else if (m.t === "resize") { size = { c: Number(m.c) || 80, r: Number(m.r) || 24 }; if (sh) void sh.resize(size.c, size.r).catch(() => {}); }
    } catch { /* ignore */ }
  });
  const shutdown = () => {
    // WS закрылся — только detach tmux-клиента: сессия и её процессы в контейнере живут дальше.
    try { (sh?.stream as any)?.end?.(); (sh?.stream as any)?.destroy?.(); } catch { /* ignore */ }
  };
  ws.on("close", () => { closed = true; shutdown(); });
  try {
    sh = await sandbox.openUserShell(task, sid);
    if (closed) return shutdown(); // клиент ушёл, пока shell поднимался — detach, сессия останется для переподключения
    sh.stream.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      sandbox.userLogWrite(task, s, sid);
      if (ws.readyState === ws.OPEN) ws.send(s);
    });
    sh.stream.on("end", () => ws.close());
    sh.stream.on("error", () => ws.close());
    if (size) void sh.resize(size.c, size.r).catch(() => {});
    for (const d of pendingIn.splice(0)) sh.stream.write(d);
  } catch (e: any) {
    if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[31mне удалось открыть shell: ${e.message}\x1b[0m\r\n`);
    ws.close();
  }
}

server.listen(cfg.port, cfg.host, () => console.log(`HTB LLM (unofficial): http://${cfg.host}:${cfg.port}`));

// ---------- корректная остановка (whitehat stop, Ctrl+C, перезапуск dev-сервера) ----------
// Идущие ходы прерываются как по «стоп»: команда в контейнере снимается, ответ и чекпоинт дописываются.
// Без этого SIGTERM посреди хода оставлял работающие процессы в контейнере и незакрытый вызов инструмента.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stopAt = 0;
// Прервать все идущие ходы и дождаться их конца (done stopped:true, tool_result в журнале, команда снята)
async function abortTurns() {
  let n = 0;
  try {
    for (let round = 0; round < 3; round++) {
      const busy = (db.prepare("select id from chats").all() as { id: string }[]).map((c) => c.id).filter(isBusy);
      if (!busy.length) break;
      await Promise.all(busy.map((id) => stopAndWait(id).catch(() => {})));
      n += busy.length;
    }
  } catch (e) { console.warn("[stop] ходы:", (e as Error).message); }
  return n;
}
async function gracefulStop(sig: NodeJS.Signals) {
  if (shuttingDown) {
    // Ctrl+C под `tsx watch` (pnpm dev:server) приходит дважды в одну миллисекунду: терминал шлёт SIGINT всей
    // группе процессов, а tsx ещё и пересылает его ребёнку. Это одно нажатие, а не «второй Ctrl+C»:
    // без выдержки сервер выходил мгновенно, не сняв команду в контейнере. Осознанное повторное нажатие — позже 1 с.
    if (sig === "SIGINT" && performance.now() - stopAt > 1000) { console.warn("[stop] второй Ctrl+C — выход без ожидания"); process.exit(130); }
    return; // повторный SIGTERM (whitehat stop бьёт и по группе, и по порту) — уже останавливаемся
  }
  shuttingDown = true;
  stopAt = performance.now();
  console.log(`[stop] ${sig}: прерываю идущие ходы, закрываю соединения…`);
  setTimeout(() => { console.warn("[stop] не уложились в 15 с — выход"); process.exit(1); }, 15_000).unref();
  const closed = new Promise<void>((r) => server.close(() => r())); // новые соединения больше не принимаются
  let allClosed = false;
  void closed.then(() => { allClosed = true; });
  const aborted = await abortTurns();
  if (aborted) console.log(`[stop] прервано ходов: ${aborted}`);
  // терминалы: close только detach-ит tmux-клиентов (сессии в контейнерах переживут рестарт веба); ждём закрытия (до 2 с), остальных обрываем
  for (const ws of wss.clients) ws.close(1001, "server stop");
  for (let t = Date.now(); wss.clients.size && Date.now() - t < 2000;) await sleep(50);
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  // SSE-ответы закрылись событием done/error прерванного хода; доотдаём их и закрываем простаивающие соединения
  for (let t = Date.now(); !allClosed && Date.now() - t < 1500;) { server.closeIdleConnections(); await sleep(50); }
  server.closeAllConnections();
  // страховка: ход, начатый, пока закрывались соединения (запросы после SIGTERM получают 503, но мало ли), —
  // тоже прерываем, а не обрываем выходом посреди команды
  const late = await abortTurns();
  if (late) console.warn(`[stop] прервано поздних ходов: ${late}`);
  try { db.close(); } catch { /* ignore */ }
  console.log("[stop] готово");
  process.exit(0);
}
process.on("SIGTERM", (s) => void gracefulStop(s));
process.on("SIGINT", (s) => void gracefulStop(s));
