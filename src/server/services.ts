// Управление локальными сервисами моделей из веб-интерфейса: Qwen (~/ai.sh, :8080) и эмбеддинги (:8081) —
// те же процессы, pid-файлы (data/logs/*.pid) и логи, что у bin/whitehat, поэтому CLI и веб не спорят.
// Состояние не хранится как истина: каждый статус проверяется пробой порта и живым процессом,
// в памяти живут только переходные фазы (starting/stopping) после нажатия кнопок.
// WH_SERVICES=off отключает управление (e2e: там «модель» — мок, настоящую поднимать нельзя).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { cfg, DATA } from "./config.ts";

export type ServiceId = "llm" | "embed";
export type ServiceInfo = {
  id: ServiceId; name: string; url: string; managed: boolean;
  state: "running" | "starting" | "stopping" | "stopped" | "error";
  pid: number | null; detail?: string; log: string[];
};

const HOME = os.homedir();
const LOGS = path.join(DATA, "logs");
fs.mkdirSync(LOGS, { recursive: true });
const AI_SH = path.join(HOME, "ai.sh");
const LLAMA_BIN = path.join(HOME, "llama.cpp", "build", "bin", "llama-server");
const EMBED_MODEL = process.env.WH_EMBED_MODEL ?? path.join(HOME, "models", "Qwen3-Embedding-0.6B-f16.gguf");
const ENABLED = process.env.WH_SERVICES !== "off";

const localPort = (url: string): number | null => {
  try { const u = new URL(url); return u.hostname === "127.0.0.1" || u.hostname === "localhost" ? Number(u.port) || null : null; }
  catch { return null; }
};
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

type Def = { id: ServiceId; name: string; url: string; port: number | null; pidfile: string; logfile: string; startTimeoutMs: number; missing: () => string | null; spawnIt: () => number };
const runtime = new Map<ServiceId, { phase: "starting" | "stopping"; until: number; error?: string }>();

function spawnDetached(cmd: string, args: string[], logfile: string): number {
  const fd = fs.openSync(logfile, "a");
  const child = spawn(cmd, args, { detached: true, stdio: ["ignore", fd, fd], cwd: HOME });
  fs.closeSync(fd);
  if (!child.pid) throw new Error(`не удалось запустить ${cmd}`);
  child.unref();
  return child.pid;
}
function memAvailableGb(): number {
  try { const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8")); return m ? Math.floor(Number(m[1]) / 1048576) : 99; }
  catch { return 99; }
}

const DEFS: Record<ServiceId, Def> = {
  llm: {
    id: "llm", name: "Qwen · LLM", url: cfg.llmUrl, port: localPort(cfg.llmUrl),
    pidfile: path.join(LOGS, "llm.pid"), logfile: path.join(LOGS, "llm.log"), startTimeoutMs: 240_000,
    missing: () => (!fs.existsSync(AI_SH) ? `нет ${AI_SH}` : memAvailableGb() < 8 ? `свободно меньше 8 ГБ RAM (${memAvailableGb()} ГБ) — Qwen не запустится` : null),
    spawnIt() { return spawnDetached("bash", [AI_SH], this.logfile); },
  },
  embed: {
    id: "embed", name: "Эмбеддинги", url: cfg.embedUrl, port: localPort(cfg.embedUrl),
    pidfile: path.join(LOGS, "embed.pid"), logfile: path.join(LOGS, "embed.log"), startTimeoutMs: 90_000,
    missing: () => (!fs.existsSync(LLAMA_BIN) ? `нет ${LLAMA_BIN}` : !fs.existsSync(EMBED_MODEL) ? `нет модели эмбеддингов: ${EMBED_MODEL}` : null),
    spawnIt() {
      // как в bin/whitehat: oneAPI-окружение только если ещё не загружено; -ub = -b для эмбеддингов
      const cmd = `[ -n "\${SETVARS_COMPLETED:-}" ] || . /opt/intel/oneapi/setvars.sh >/dev/null 2>&1; ` +
        `export ZES_ENABLE_SYSMAN=1 ONEAPI_DEVICE_SELECTOR=level_zero:0; ` +
        `exec ${shq(LLAMA_BIN)} -m ${shq(EMBED_MODEL)} --embedding --pooling last -ngl 99 -c 8192 -b 4096 -ub 4096 --parallel 2 --host 127.0.0.1 --port ${this.port} -a embed`;
      return spawnDetached("bash", ["-c", cmd], this.logfile);
    },
  },
};

const cmdlineOf = (pid: number): string => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; } };
const isOurProcess = (pid: number) => /llama-server|ai\.sh/.test(cmdlineOf(pid));
function pidfilePid(def: Def): number | null {
  try { const p = Number(fs.readFileSync(def.pidfile, "utf8").trim()); return Number.isInteger(p) && p > 1 && isOurProcess(p) ? p : null; }
  catch { return null; }
}
function listenerPid(port: number): number | null {
  try {
    const out = spawnSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8", timeout: 3000 }).stdout ?? "";
    const p = Number(/pid=(\d+)/.exec(out)?.[1]);
    return Number.isInteger(p) && p > 1 && isOurProcess(p) ? p : null;
  } catch { return null; }
}
async function probe(def: Def): Promise<boolean> {
  const origin = (() => { try { return new URL(def.url).origin; } catch { return def.url; } })();
  for (const u of [`${origin}/health`, `${def.url}/models`]) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(1200) }); if (r.ok) return true; } catch { /* next */ }
  }
  return false;
}
function logTail(file: string, n = 15): string[] {
  try { const t = fs.readFileSync(file, "utf8"); return t.split("\n").filter((l) => l.trim()).slice(-n).map((l) => l.slice(0, 300)); }
  catch { return []; }
}
function managedOf(def: Def): { managed: boolean; detail?: string } {
  if (!ENABLED) return { managed: false, detail: "управление отключено (WH_SERVICES=off)" };
  if (def.port === null) return { managed: false, detail: "адрес не локальный — сервис внешний" };
  const miss = def.missing();
  return miss ? { managed: false, detail: miss } : { managed: true };
}

export async function serviceStatus(id: ServiceId): Promise<ServiceInfo> {
  const def = DEFS[id];
  const { managed, detail } = managedOf(def);
  const healthy = await probe(def);
  const pid = pidfilePid(def) ?? (def.port ? listenerPid(def.port) : null);
  const rt = runtime.get(id);
  let state: ServiceInfo["state"];
  // stopping важнее пробы: процесс ещё отвечает на /health, пока завершается, но пользователю уже сказана правда
  if (rt?.phase === "stopping" && Date.now() < rt.until) state = pid || healthy ? "stopping" : "stopped";
  else if (healthy) { state = "running"; if (rt?.phase === "starting") runtime.delete(id); }
  else if (rt?.error && Date.now() < rt.until) state = "error";
  else if (rt && Date.now() < rt.until) state = rt.phase === "stopping" && !pid ? "stopped" : rt.phase;
  else if (pid) state = "starting"; // процесс жив, порт ещё не отвечает — грузится (и при ручном старте не из веба)
  else state = "stopped";
  if (state === "stopped" && rt) runtime.delete(id);
  return {
    id, name: def.name, url: def.url, managed, state, pid,
    detail: rt?.error && state === "error" ? rt.error : detail,
    log: logTail(def.logfile),
  };
}
export const listServices = async (): Promise<ServiceInfo[]> => [await serviceStatus("llm"), await serviceStatus("embed")];

export async function startService(id: ServiceId): Promise<ServiceInfo> {
  const def = DEFS[id];
  const { managed, detail } = managedOf(def);
  if (!managed) throw new Error(detail ?? "сервис не управляется из веба");
  if (await probe(def)) return serviceStatus(id);
  const alive = pidfilePid(def) ?? (def.port ? listenerPid(def.port) : null);
  if (!alive) {
    try {
      const pid = def.spawnIt();
      fs.writeFileSync(def.pidfile, `${pid}\n`);
      await new Promise((r) => setTimeout(r, 700));
      if (!isOurProcess(pid) && !(def.port && listenerPid(def.port)))
        throw new Error("процесс сразу завершился — причина в логе ниже");
    } catch (e) {
      runtime.set(id, { phase: "starting", until: Date.now() + 30_000, error: (e as Error).message });
      return serviceStatus(id);
    }
  }
  runtime.set(id, { phase: "starting", until: Date.now() + def.startTimeoutMs });
  return serviceStatus(id);
}

export async function stopService(id: ServiceId): Promise<ServiceInfo> {
  const def = DEFS[id];
  const { managed, detail } = managedOf(def);
  if (!managed) throw new Error(detail ?? "сервис не управляется из веба");
  const cands = [...new Set([pidfilePid(def), def.port ? listenerPid(def.port) : null].filter((p): p is number => p !== null))];
  if (!cands.length) {
    if (await probe(def)) throw new Error(`порт ${def.port} отвечает, но процесс llama-server не найден — останавливать нечего из веба`);
    runtime.delete(id);
    return serviceStatus(id);
  }
  for (const pid of cands) {
    // сначала группу (ai.sh мог остаться родителем), потом сам процесс; чужие процессы сюда не попадают (isOurProcess)
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* уже вышел */ } }
  }
  try { fs.rmSync(def.pidfile, { force: true }); } catch { /* ignore */ }
  runtime.set(id, { phase: "stopping", until: Date.now() + 15_000 });
  return serviceStatus(id);
}
