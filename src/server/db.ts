import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { cfg, paths } from "./config.ts";

export const db = new Database(paths.db);
sqliteVec.load(db);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
create table if not exists tasks(
  id text primary key,
  title text not null,
  course text not null default '',
  brief text not null default '',          -- условие/цель задачи, всегда в контексте
  target text not null default '',         -- IP цели задачи ($TARGET в контейнере), для HTB синкается с активным инстансом
  hostname text not null default '',       -- имя цели для /etc/hosts контейнера и $TARGET_HOST
  created_at integer not null,
  updated_at integer not null
);
create table if not exists chats(
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  title text not null default 'новый чат',
  summary text not null default '',        -- свёрнутые старые ходы этого чата
  last_prompt_tokens integer not null default 0,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists memories(
  id integer primary key autoincrement,
  task_id text not null references tasks(id) on delete cascade,
  chat_id text,
  kind text not null default 'fact',       -- step | command | fact | mistake | result
  title text not null,
  content text not null,
  status text not null check(status in ('pending','confirmed','rejected')),
  embedding blob,                          -- float32[${cfg.embedDim}], считается при подтверждении
  created_at integer not null,
  updated_at integer not null
);
create index if not exists memories_task on memories(task_id, status);
create table if not exists docs(
  id integer primary key autoincrement,
  task_id text references tasks(id) on delete cascade,   -- null = общая библиотека
  name text not null,
  kind text not null,
  path text not null,
  pages integer not null default 0,
  chunks integer not null default 0,
  status text not null default 'indexing', -- indexing | ready | error
  error text,
  created_at integer not null
);
create table if not exists chunks(
  id integer primary key autoincrement,
  doc_id integer not null references docs(id) on delete cascade,
  scope text not null,                      -- 'lib' | 'task:<id>'
  page integer not null default 0,
  heading text not null default '',
  text text not null
);
create index if not exists chunks_doc on chunks(doc_id);
create virtual table if not exists chunks_fts using fts5(text, heading, content='chunks', content_rowid='id', tokenize='unicode61');
-- Полная история чата для интерфейса. Модель видит СЖАТЫЙ контекст (LangGraph-чекпоинты + резюме),
-- а пользователь — всё, что было, включая свёрнутые ходы.
create table if not exists chat_log(
  id integer primary key autoincrement,
  chat_id text not null references chats(id) on delete cascade,
  kind text not null,                       -- user | assistant | tool_call | tool_result | marker
  data text not null,                       -- json
  created_at integer not null
);
create index if not exists chat_log_chat on chat_log(chat_id, id);
-- Фоновые jobs задачи: tmux-сессии wh-job-<id> в её контейнере (listener, http-сервер, интерактивный shell).
-- Статус вычисляется по живому tmux; last_output — последний снимок вывода (виден и после остановки).
create table if not exists jobs(
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  name text not null,
  command text not null,
  last_output text not null default '',
  created_at integer not null
);
create index if not exists jobs_task on jobs(task_id, created_at);
-- План решения задачи (дерево фаз в духе PTT из PentestGPT): пункты ведёт модель инструментом
-- plan_update, пользователь видит и правит в панели «План»; компактная сводка подклеивается в каждый ход.
create table if not exists plan_items(
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  phase text not null default 'Recon',
  text text not null,
  status text not null default 'todo' check(status in ('todo','doing','done','blocked','skipped')),
  note text not null default '',
  sort integer not null default 0,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists plan_task on plan_items(task_id, sort, created_at);
-- Профиль цели и хранилище кред: сервисы/версии, креды с источником, полученные доступы и факты —
-- ведёт модель инструментом profile_update, пользователь видит и правит в панели «Цель»;
-- компактная сводка подклеивается в каждый ход, чтобы найденное не терялось между чатами.
create table if not exists profile_items(
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  kind text not null default 'fact' check(kind in ('service','cred','access','fact')),
  host text not null default '',
  port integer,
  proto text not null default 'tcp',
  service text not null default '',
  version text not null default '',
  username text not null default '',
  secret text not null default '',
  secret_type text not null default 'password',
  source text not null default '',
  text text not null default '',
  sort integer not null default 0,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists profile_task on profile_items(task_id, kind, sort, created_at);
-- Общие настройки приложения (модели/эмбеддинги): key -> json; ключи API живут только здесь и наружу не отдаются.
create table if not exists settings(
  key text primary key,
  value text not null
);
`);

// Векторная таблица создаётся отдельно: размерность зависит от активной эмбеддинг-модели и хранится
// в settings (embed_dim). Смена модели с другой размерностью = пересоздание таблицы + переиндексация
// (library.reindexAll); до неё поиск честно деградирует в полнотекстовый (llm.embed падает на гарде).
function storedEmbedDim(): number {
  try {
    const row = db.prepare("select value from settings where key='embed_dim'").get() as { value: string } | undefined;
    const n = row ? Number(JSON.parse(row.value)) : NaN;
    return Number.isInteger(n) && n >= 8 && n <= 16384 ? n : cfg.embedDim;
  } catch { return cfg.embedDim; }
}
export const embedDimState = { dim: storedEmbedDim() };
db.exec(`create virtual table if not exists chunks_vec using vec0(scope text, embedding float[${embedDimState.dim}] distance_metric=cosine)`);
export function recreateVecTable(dim: number) {
  db.exec("drop table if exists chunks_vec");
  db.exec(`create virtual table chunks_vec using vec0(scope text, embedding float[${dim}] distance_metric=cosine)`);
  embedDimState.dim = dim;
  db.prepare("insert into settings(key,value) values('embed_dim',?) on conflict(key) do update set value=excluded.value")
    .run(JSON.stringify(dim));
}
// Размерность мог сменить соседний процесс с той же базой (CLI-сборка базы знаний рядом с живым
// сервером): embedDimState в памяти тогда врёт. Перечитать сохранённое значение из settings.
export function reloadEmbedDim() {
  const d = storedEmbedDim();
  if (d !== embedDimState.dim) embedDimState.dim = d;
}

// Миграции существующих баз + бэкфилл TARGET/hostname для уже импортированных HTB-задач (IP жил только в брифе).
{
  const cols = new Set((db.prepare("pragma table_info(tasks)").all() as any[]).map((c) => String(c.name)));
  if (!cols.has("target")) db.exec("alter table tasks add column target text not null default ''");
  if (!cols.has("hostname")) db.exec("alter table tasks add column hostname text not null default ''");
  const slugHost = (title: string) => {
    const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s ? `${s}.htb` : "";
  };
  const rows = db.prepare("select id,title,brief,target,hostname from tasks where target='' or hostname=''").all() as any[];
  const upd = db.prepare("update tasks set target=?, hostname=? where id=?");
  for (const r of rows) {
    if (!/^HTB machine #\d+/m.test(String(r.brief ?? ""))) continue;
    const ip = /IP \(текущий инстанс\):\s*(\d{1,3}(?:\.\d{1,3}){3})/.exec(String(r.brief ?? ""))?.[1] ?? "";
    upd.run(String(r.target || ip), String(r.hostname || slugHost(String(r.title ?? ""))), String(r.id));
  }
}

export const now = () => Date.now();
export const taskExists = (id: string) => !!db.prepare("select 1 from tasks where id=?").get(id);
export const chatExists = (id: string) => !!db.prepare("select 1 from chats where id=?").get(id);

export type Task = { id: string; title: string; course: string; brief: string; target: string; hostname: string; created_at: number; updated_at: number };
export type Chat = { id: string; task_id: string; title: string; summary: string; last_prompt_tokens: number; created_at: number; updated_at: number };
export type Memory = {
  id: number; task_id: string; chat_id: string | null; kind: string; title: string; content: string;
  status: "pending" | "confirmed" | "rejected"; created_at: number; updated_at: number;
};
export type Doc = { id: number; task_id: string | null; name: string; kind: string; path: string; pages: number; chunks: number; status: string; error: string | null; created_at: number };

export const vecBuf = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const bufVec = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
