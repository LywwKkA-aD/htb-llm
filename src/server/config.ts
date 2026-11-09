import path from "node:path";
import fs from "node:fs";

export type AgentMode = "guided" | "autonomous";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const DATA = process.env.WH_DATA ?? path.join(ROOT, "data");
fs.mkdirSync(DATA, { recursive: true });
// Путь к тому же каталогу данных с точки зрения Docker daemon на хосте. Когда сервер сам работает
// в контейнере (Compose: WH_DATA=/data, bind ./data:/data), bind-путь для Kali должен быть хостовым.
export const HOST_DATA = process.env.WH_HOST_DATA ?? DATA;
export const hostPath = (p: string): string => {
  const rel = path.relative(DATA, p);
  return rel === "" ? HOST_DATA : rel.startsWith("..") || path.isAbsolute(rel) ? p : path.join(HOST_DATA, rel);
};

export const cfg = {
  host: process.env.WH_HOST ?? "127.0.0.1",
  port: Number(process.env.WH_PORT ?? 7331),

  // Основная модель: ~/ai.sh (llama-server, OpenAI API)
  llmUrl: process.env.WH_LLM_URL ?? "http://127.0.0.1:8080/v1",
  llmModel: process.env.WH_LLM_MODEL ?? "Qwen3.8-27B-Turbo",
  // Эмбеддинги: второй llama-server с Qwen3-Embedding-0.6B (bin/whitehat поднимает его на :8081)
  embedUrl: process.env.WH_EMBED_URL ?? "http://127.0.0.1:8081/v1",
  embedDim: 1024,

  // Веб-поиск агента: собственный SearXNG пользователя (self-hosted, JSON API без ключей)
  searxngUrl: (process.env.WH_SEARXNG_URL ?? "http://127.0.0.1:8888").replace(/\/+$/, ""),
  // web_fetch не ходит на loopback/приватные адреса (SSRF-гард от хостовых сервисов).
  // WH_WEB_ALLOW_PRIVATE=1 — только для e2e со стабом на localhost (tests/start-app.sh).
  webAllowPrivate: process.env.WH_WEB_ALLOW_PRIVATE === "1",
  // web_fetch дочитывает JS-страницы (SPA) headless Chromium из кэша Playwright, если обычный fetch дал пустой каркас.
  // WH_WEB_RENDER=off отключает (например, когда браузер в окружении недоступен).
  webRender: process.env.WH_WEB_RENDER !== "off",
  // Явный системный Chromium для Docker-образа приложения; без него Playwright ищет свой кэш браузеров.
  browserPath: process.env.WH_BROWSER_PATH || undefined,

  // Песочница
  image: process.env.WH_IMAGE ?? "htb-llm-kali:latest",
  containerPrefix: "whitehat-",
  defaultCmdTimeoutSec: 90,
  maxCmdTimeoutSec: 900,
  // SOCKS5 внутри контейнера (microsocks) для браузера/Burp на хосте через VPN задачи
  socksPort: 1080,

  // Бюджет контекста (токены). Скорость генерации падает от ЗАПОЛНЕННОГО контекста,
  // поэтому держим живую историю короткой, а знания — в памяти задачи и библиотеке.
  ctxWindow: 65536,
  compactAtPromptTokens: Number(process.env.WH_COMPACT_AT ?? 32000), // после хода: свернуть старое в резюме (половина окна 64K)
  keepRecentTurns: 2, // столько последних ходов пользователя остаются дословно
  toolOutputChars: 6000, // больше — в контекст идут голова+хвост, полный вывод лежит файлом в /work/.whitehat
  recallMemoryTokens: 1800, // память задачи целиком, пока влезает; иначе топ по смыслу + список заголовков
  recallDocChunks: 4,
  // порог косинусной близости для автоподклейки фрагментов (Qwen3-Embedding-0.6B: по делу 0.53–0.77, мимо ≤0.45);
  // явный search_docs порогом не ограничен
  recallMinSim: Number(process.env.WH_RECALL_MIN_SIM ?? 0.5),
  maxToolRounds: 30,
  guidedToolRounds: 6, // управляемый режим: предохранитель — раундов действий на этап (справки/поиск/локальные проверки не считаются)
  maxRepeats: 2, // столько повторённых вызовов за ход — и инструменты снимаются, модель обязана ответить
  stuckRounds: Number(process.env.WH_STUCK_ROUNDS ?? 3), // советник при застревании: столько раундов действий подряд без новых фактов — и сервер вставляет сводку известного с требованием сменить ветку (0 — выключен)
};

// id задачи — ровно 10 символов [a-z0-9] (так его генерирует index.ts). Он же — часть имени контейнера и
// каталога data/tasks/<id>: всё остальное («../x», «a/b», пусто) — обход каталога, отказываем.
export const TASK_ID = /^[a-z0-9]{10}$/;
export const isTaskId = (id: unknown): id is string => typeof id === "string" && TASK_ID.test(id);
export function safeTask(id: string) {
  if (!isTaskId(id)) throw new Error(`недопустимый id задачи: ${JSON.stringify(String(id).slice(0, 40))}`);
  return id;
}

export const paths = {
  db: path.join(DATA, "whitehat.db"),
  checkpoints: path.join(DATA, "checkpoints.db"),
  uploads: path.join(DATA, "uploads"),
  rfcCache: path.join(DATA, "rfc"),
  // safeTask — вторая линия защиты: даже если ручка забыла проверить id, путь не уйдёт из data/tasks
  taskDir: (taskId: string) => path.join(DATA, "tasks", safeTask(taskId)),
  taskWork: (taskId: string) => path.join(DATA, "tasks", safeTask(taskId), "work"),
  // конфиг VPN задачи: внутри /work/.whitehat, виден из контейнера как /work/.whitehat/vpn
  vpnDir: (taskId: string) => path.join(DATA, "tasks", safeTask(taskId), "work", ".whitehat", "vpn"),
  agentLog: (taskId: string) => path.join(DATA, "tasks", safeTask(taskId), "agent-terminal.log"),
  userLog: (taskId: string, sid = 1) => path.join(DATA, "tasks", safeTask(taskId), sid > 1 ? `user-terminal-${sid}.log` : "user-terminal.log"), // поток shell-вкладки — агент видит вывод и ошибки
};
for (const p of [paths.uploads, paths.rfcCache, path.join(DATA, "tasks")]) fs.mkdirSync(p, { recursive: true });
