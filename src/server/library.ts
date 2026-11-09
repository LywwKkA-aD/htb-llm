// Библиотека знаний (RAG): общие материалы (лекции, учебники, заметки) + вложения конкретной задачи.
// Поиск гибридный: вектора (смысл) + FTS5/BM25 (точные термины: -sS, RFC 791, TTL, SYN) -> RRF.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { extractText, getDocumentProxy } from "unpdf";
import { db, now, vecBuf, embedDimState, recreateVecTable, reloadEmbedDim, type Doc } from "./db.ts";
import { embed, probeEmbedDim } from "./llm.ts";
import { activeEmbed, recordEmbedIndex } from "./settings.ts";
import { ROOT } from "./config.ts";

const CHUNK = 1400; // символов (~450 токенов русского текста)
const OVERLAP = 200;

type RawChunk = { page: number; heading: string; text: string };

function splitText(text: string, page: number, heading: string): RawChunk[] {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const out: RawChunk[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(clean.length, i + CHUNK);
    if (end < clean.length) {
      // резать по абзацу/предложению, а не посреди слова
      const win = clean.slice(i + CHUNK * 0.6, end);
      const cut = Math.max(win.lastIndexOf("\n\n"), win.lastIndexOf(". "), win.lastIndexOf("\n"));
      if (cut > 0) end = i + Math.floor(CHUNK * 0.6) + cut + 1;
    }
    out.push({ page, heading, text: clean.slice(i, end).trim() });
    if (end >= clean.length) break;
    i = Math.max(end - OVERLAP, i + 1);
  }
  return out;
}

async function parse(file: string, kind: string): Promise<{ pages: number; chunks: RawChunk[] }> {
  if (kind === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return { pages: totalPages, chunks: pages.flatMap((t, idx) => splitText(t, idx + 1, "")) };
  }
  // BOM и переводы строк Windows/старого Mac убираем сразу: иначе «# Заголовок\r» и «\uFEFF# Заголовок» не узнаются
  const src = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (kind === "md") {
    // по заголовкам, с путём «H1 › H2» — он же попадает в выдачу как контекст
    const chunks: RawChunk[] = [];
    const stack: string[] = [];
    let body: string[] = [];
    const flush = () => { chunks.push(...splitText(body.join("\n"), 0, stack.filter(Boolean).join(" › "))); body = []; };
    // Блоки кода (``` или ~~~, как в CommonMark): «# комментарий» внутри — это текст, а не заголовок.
    // Закрывает блок строка из того же символа, не короче открывающей и без текста после.
    let fence: { ch: string; len: number } | null = null;
    for (const line of src.split("\n")) {
      const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !f[2].trim()) fence = null;
        body.push(line);
        continue;
      }
      if (f && !(f[1][0] === "`" && f[2].includes("`"))) { fence = { ch: f[1][0], len: f[1].length }; body.push(line); continue; }
      const m = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (m && m[2].trim()) { flush(); stack.length = m[1].length - 1; stack[m[1].length - 1] = m[2].trim(); }
      else body.push(line);
    }
    flush();
    return { pages: 0, chunks };
  }
  return { pages: 0, chunks: splitText(src, 0, "") };
}

export function kindOf(name: string) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".markdown") return "md";
  if ([".txt", ".text", ".log", ".conf", ".cfg", ".rst"].includes(ext)) return "txt";
  return null;
}

const scopeOf = (taskId: string | null) => (taskId ? `task:${taskId}` : "lib");

export function addDoc(file: string, name: string, taskId: string | null): Doc {
  const kind = kindOf(name);
  if (!kind) throw new Error(`неподдерживаемый тип файла: ${name} (нужен pdf, md или txt)`);
  const r = db.prepare("insert into docs(task_id,name,kind,path,created_at) values(?,?,?,?,?)").run(taskId, name, kind, file, now());
  const id = Number(r.lastInsertRowid);
  void indexDoc(id).catch((e) => db.prepare("update docs set status='error', error=? where id=?").run(String(e?.message ?? e), id));
  return db.prepare("select * from docs where id=?").get(id) as Doc;
}

// Свежая установка: chunks_vec создана на дефолтной размерности локальной модели (1024), а пользователь
// первым делом включил внешний эмбеддинг другой размерности (Cohere — 2048). Пока индекс пуст — нет ни
// фрагментов, ни векторов памяти — терять нечего: пересоздать таблицу под активную модель прямо здесь.
// Иначе первая же индексация падает на гарде embed(), а «переиндексировать» в UI при 0 фрагментов
// отключена — тупик. Непустой индекс не трогаем: там смена размерности = осознанная переиндексация.
export async function ensureIndexDim() {
  const chunks = (db.prepare("select count(*) as n from chunks").get() as { n: number }).n;
  if (chunks > 0) return;
  const mems = (db.prepare("select count(*) as n from memories where embedding is not null").get() as { n: number }).n;
  if (mems > 0) return;
  const dim = await probeEmbedDim().catch(() => null);
  if (dim && dim !== embedDimState.dim) recreateVecTable(dim);
}

// Полная сборка базы при непустом индексе чужой размерности: упасть сразу и честно, до того как
// indexPack начнёт удалять старые паки и получать ошибку размерности на каждом.
export async function assertEmbedDimMatchesIndex() {
  const dim = await probeEmbedDim();
  if (dim !== embedDimState.dim) {
    const act = activeEmbed();
    throw new Error(`активная модель эмбеддингов «${act.model}» даёт вектор ${dim}, а индекс построен на ${embedDimState.dim} и не пуст — сначала переиндексируй базу в настройках (кнопка «переиндексировать»), потом обновляй источники`);
  }
}

async function indexDoc(id: number) {
  const d = db.prepare("select * from docs where id=?").get(id) as Doc;
  const { pages, chunks } = await parse(d.path, d.kind);
  if (!chunks.length) throw new Error("в файле не найден текст (скан без OCR?)");
  const wasEmpty = (db.prepare("select count(*) as n from chunks").get() as { n: number }).n === 0;
  await ensureIndexDim();
  const vecs = await embed(chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)), "doc");
  const scope = scopeOf(d.task_id);
  const ins = db.prepare("insert into chunks(doc_id,scope,page,heading,text) values(?,?,?,?,?)");
  const insF = db.prepare("insert into chunks_fts(rowid,text,heading) values(?,?,?)");
  const insV = db.prepare("insert into chunks_vec(rowid,scope,embedding) values(?,?,?)");
  db.transaction(() => {
    chunks.forEach((c, i) => {
      const cid = ins.run(id, scope, c.page, c.heading, c.text).lastInsertRowid;
      insF.run(cid, c.text, c.heading);
      insV.run(BigInt(cid), scope, vecBuf(vecs[i]));
    });
    db.prepare("update docs set status='ready', pages=?, chunks=?, error=null where id=?").run(pages, chunks.length, id);
  })();
  // Первый документ пустого индекса задаёт, чем индекс построен — иначе настройки вечно показывают
  // «устарел» свежей установке на внешнем пресете, хотя база только что построена активной моделью.
  if (wasEmpty) {
    const act = activeEmbed();
    recordEmbedIndex(act.model, act.url);
  }
}

export function deleteDoc(id: number) {
  const d = db.prepare("select * from docs where id=?").get(id) as Doc | undefined;
  if (!d) return;
  const rows = db.prepare("select id,text,heading from chunks where doc_id=?").all(id) as { id: number; text: string; heading: string }[];
  db.transaction(() => {
    const delF = db.prepare("insert into chunks_fts(chunks_fts,rowid,text,heading) values('delete',?,?,?)");
    const delV = db.prepare("delete from chunks_vec where rowid=?");
    for (const r of rows) { delF.run(r.id, r.text, r.heading); delV.run(BigInt(r.id)); }
    db.prepare("delete from chunks where doc_id=?").run(id);
    db.prepare("delete from docs where id=?").run(id);
  })();
  if (d.path.includes(`${path.sep}uploads${path.sep}`)) fs.rmSync(d.path, { force: true });
}

export function listDocs(taskId: string | null) {
  return (taskId
    ? db.prepare("select * from docs where task_id=? or task_id is null order by task_id is null, created_at desc").all(taskId)
    : db.prepare("select * from docs where task_id is null order by created_at desc").all()) as Doc[];
}

export type Hit = { id: number; doc: string; page: number; heading: string; text: string; score: number; sim: number; scope: string };

function ftsQuery(q: string) {
  const words = q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._:/-]*/gu) ?? [];
  const uniq = [...new Set(words.filter((w) => w.length >= 2))].slice(0, 24);
  return uniq.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

// scope: 'all' = библиотека + вложения задачи; 'task' = только вложения задачи; 'lib' = только общая библиотека
export async function search(query: string, taskId: string | null, k = 5, which: "all" | "task" | "lib" = "all"): Promise<Hit[]> {
  const scopes = which === "lib" || !taskId ? ["lib"] : which === "task" ? [`task:${taskId}`] : ["lib", `task:${taskId}`];
  const ranks = new Map<number, number>();
  const sims = new Map<number, number>(); // косинусная близость к запросу (1 - distance) — абсолютная мера релевантности
  const add = (ids: number[]) => ids.forEach((id, r) => ranks.set(id, (ranks.get(id) ?? 0) + 1 / (60 + r)));

  // вектора (по каждой области отдельно — фильтр по metadata-колонке vec0)
  try {
    const [qv] = await embed([query], "query");
    const vids: { id: number; dist: number }[] = [];
    const st = db.prepare("select rowid as id, distance as dist from chunks_vec where embedding match ? and k = ? and scope = ?");
    for (const s of scopes) vids.push(...(st.all(vecBuf(qv), 30, s) as { id: number; dist: number }[]));
    for (const v of vids) sims.set(Number(v.id), Math.max(sims.get(Number(v.id)) ?? -1, 1 - v.dist));
    add(vids.sort((a, b) => a.dist - b.dist).map((v) => Number(v.id)));
  } catch (e) {
    console.warn("[search] вектора недоступны, только полнотекст:", (e as Error).message);
  }
  // полнотекст
  const fq = ftsQuery(query);
  if (fq) {
    const ph = scopes.map(() => "?").join(",");
    const fids = db
      .prepare(`select c.id from chunks_fts f join chunks c on c.id=f.rowid where chunks_fts match ? and c.scope in (${ph}) order by bm25(chunks_fts) limit 30`)
      .all(fq, ...scopes) as { id: number }[];
    add(fids.map((r) => r.id));
  }
  const top = [...ranks.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  if (!top.length) return [];
  const get = db.prepare("select c.id, c.page, c.heading, c.text, c.scope, d.name as doc from chunks c join docs d on d.id=c.doc_id where c.id=?");
  return top.map(([id, score]) => ({ ...(get.get(id) as Omit<Hit, "score" | "sim">), score, sim: sims.get(id) ?? 0 }));
}

export const fmtHit = (h: Hit) =>
  `[${h.doc}${h.page ? `, с.${h.page}` : ""}${h.heading ? ` — ${h.heading}` : ""}]\n${h.text}`;

// ---------- полная переиндексация под активную эмбеддинг-модель ----------
// Запускается из настроек вручную (для внешних API это платные запросы на все фрагменты).
// Порядок: проба размерности -> при смене пересоздать vec-таблицу -> переэмбеддить все фрагменты
// и подтверждённую память -> записать, чем построен индекс. Сбой на середине оставляет частичный
// векторный индекс (полнотекст цел), повторный запуск доводит дело до конца.
export type ReindexState = { running: boolean; done: number; total: number; error: string | null; startedAt: number; finishedAt: number };
export const reindexState: ReindexState = { running: false, done: 0, total: 0, error: null, startedAt: 0, finishedAt: 0 };

export function startReindex(): ReindexState {
  if (reindexState.running) throw new Error("переиндексация уже идёт");
  if (knowledgeState.running) throw new Error("идёт построение базы знаний — подожди его завершения");
  reindexState.running = true;
  reindexState.done = 0; reindexState.total = 0; reindexState.error = null;
  reindexState.startedAt = Date.now(); reindexState.finishedAt = 0;
  void runReindex().catch((e) => { reindexState.error = String((e as Error)?.message ?? e); })
    .finally(() => { reindexState.running = false; reindexState.finishedAt = Date.now(); });
  return reindexState;
}

const REINDEX_BATCH = 64;

async function runReindex() {
  const act = activeEmbed();
  const dim = await probeEmbedDim();
  if (dim !== embedDimState.dim) recreateVecTable(dim);
  const chunks = db.prepare("select id, scope, heading, text from chunks order by id").all() as { id: number; scope: string; heading: string; text: string }[];
  const mems = db.prepare("select id, title, content from memories where embedding is not null").all() as { id: number; title: string; content: string }[];
  reindexState.total = chunks.length + mems.length;

  const delV = db.prepare("delete from chunks_vec where rowid=?");
  const insV = db.prepare("insert into chunks_vec(rowid,scope,embedding) values(?,?,?)");
  for (let i = 0; i < chunks.length; i += REINDEX_BATCH) {
    const part = chunks.slice(i, i + REINDEX_BATCH);
    const vecs = await embed(part.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)), "doc");
    db.transaction(() => part.forEach((c, k) => { delV.run(BigInt(c.id)); insV.run(BigInt(c.id), c.scope, vecBuf(vecs[k])); }))();
    reindexState.done += part.length;
  }
  const updM = db.prepare("update memories set embedding=? where id=?");
  for (let i = 0; i < mems.length; i += REINDEX_BATCH) {
    const part = mems.slice(i, i + REINDEX_BATCH);
    const vecs = await embed(part.map((m) => `${m.title}\n${m.content}`), "doc");
    db.transaction(() => part.forEach((m, k) => updM.run(vecBuf(vecs[k]), m.id)))();
    reindexState.done += part.length;
  }
  recordEmbedIndex(act.model, act.url);
}

// ---------- построение базы знаний из веба (кнопка в настройках) ----------
// Тот же пайплайн, что `pnpm knowledge` / `./docker/run.sh knowledge`: сервер запускает
// scripts/knowledge.mts дочерним процессом (свои гайды из knowledge/ + внешние корпуса
// зафиксированных в knowledge/sources.lock.json ревизий) и стримит его вывод в состояние.
// WH_KNOWLEDGE_ARGS — необязательные доп. аргументы скрипту (например "--only hacktricks"; в e2e
// ограничивает сборку одним своим гайдом без сети).
export type KnowledgeState = { running: boolean; lines: string[]; error: string | null; startedAt: number; finishedAt: number };
export const knowledgeState: KnowledgeState = { running: false, lines: [], error: null, startedAt: 0, finishedAt: 0 };

export function startKnowledgeBuild(): KnowledgeState {
  if (knowledgeState.running) throw new Error("построение базы знаний уже идёт");
  if (reindexState.running) throw new Error("идёт переиндексация — подожди её завершения");
  const script = path.join(ROOT, "scripts", "knowledge.mts");
  if (!fs.existsSync(script)) throw new Error("скрипт scripts/knowledge.mts не найден в установке");
  knowledgeState.running = true;
  knowledgeState.lines = [];
  knowledgeState.error = null;
  knowledgeState.startedAt = Date.now();
  knowledgeState.finishedAt = 0;
  const extra = (process.env.WH_KNOWLEDGE_ARGS ?? "").split(/\s+/).filter(Boolean);
  const child = spawn(process.execPath, ["--import", "tsx", script, ...extra], { cwd: ROOT, env: process.env });
  const push = (buf: Buffer) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      const t = line.trimEnd();
      if (t) knowledgeState.lines.push(t);
    }
    if (knowledgeState.lines.length > 80) knowledgeState.lines.splice(0, knowledgeState.lines.length - 80);
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("error", (e) => {
    knowledgeState.error = `не удалось запустить построение базы: ${e.message}`;
    knowledgeState.running = false;
    knowledgeState.finishedAt = Date.now();
  });
  child.on("close", (code) => {
    reloadEmbedDim(); // дочерний процесс мог пересоздать vec-таблицу под другую размерность
    if (code !== 0 && !knowledgeState.error) {
      const lastErr = [...knowledgeState.lines].reverse().find((l) => /ОШИБКА|error|fatal/i.test(l));
      knowledgeState.error = lastErr ?? `построение завершилось с кодом ${code} — детали в логе выше`;
    }
    knowledgeState.running = false;
    knowledgeState.finishedAt = Date.now();
  });
  return knowledgeState;
}
