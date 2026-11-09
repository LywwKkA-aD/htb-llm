// Память задачи: карточки «шаг / команда / факт / ошибка / результат».
// Агент предлагает (pending) -> пользователь подтверждает/правит (confirmed) или отклоняет (rejected).
// В контекст каждого хода попадает только подтверждённое — так новые чаты начинаются с минимума, но без потерь.
import { createHash } from "node:crypto";
import { cfg } from "./config.ts";
import { db, now, vecBuf, bufVec, type Memory } from "./db.ts";
import { embed, cosine, approxTokens, clip } from "./llm.ts";

export const KINDS = ["step", "command", "fact", "mistake", "result"] as const;
export const KIND_RU: Record<string, string> = { step: "шаг", command: "команда", fact: "факт", mistake: "ошибка", result: "результат" };

const cols = "id,task_id,chat_id,kind,title,content,status,created_at,updated_at";

export function list(taskId: string, status?: string) {
  return (status
    ? db.prepare(`select ${cols} from memories where task_id=? and status=? order by created_at`).all(taskId, status)
    : db.prepare(`select ${cols} from memories where task_id=? and status!='rejected' order by created_at`).all(taskId)) as Memory[];
}

// Заголовок и текст карточки уходят в системный промпт как «- [вид] заголовок: текст»: пустыми быть не могут,
// длина ограничена (по кодовым точкам — эмодзи на границе не режется пополам).
export const TITLE_MAX = 200, CONTENT_MAX = 4000;
const clean = (v: unknown, max: number) => clip(String(v ?? "").trim(), max).trim();
function cleanCard(m: { kind?: unknown; title?: unknown; content?: unknown }) {
  const title = clean(m.title, TITLE_MAX), content = clean(m.content, CONTENT_MAX);
  if (!title || !content) throw new Error("у карточки должны быть заголовок и текст");
  return { kind: normKind(String(m.kind ?? "")), title, content };
}

export function addPending(taskId: string, chatId: string | null, items: { kind: string; title: string; content: string }[]) {
  const rows = items.map(cleanCard); // проверяем всё до первой вставки
  const ins = db.prepare("insert into memories(task_id,chat_id,kind,title,content,status,created_at,updated_at) values(?,?,?,?,?,'pending',?,?)");
  const ids = rows.map((m) => Number(ins.run(taskId, chatId, m.kind, m.title, m.content, now(), now()).lastInsertRowid));
  return ids.map((id) => get(id)!);
}

export async function addConfirmed(taskId: string, m: { kind: string; title: string; content: string }) {
  const [x] = addPending(taskId, null, [m]);
  return confirm(x.id);
}

export const get = (id: number) => db.prepare(`select ${cols} from memories where id=?`).get(id) as Memory | undefined;

// Подтвердить (и, если переданы поля, поправить) карточку.
//  - отклонённую не воскрешаем: её уже нет ни в панели, ни в промпте — это устаревшая кнопка в другой вкладке/в чате;
//  - подтверждённую без правок не трогаем: «сохранить» на устаревшем предложении в чате не должно затирать правку из панели.
export async function confirm(id: number, edit?: { kind?: string; title?: string; content?: string }) {
  const m = get(id);
  if (!m) throw new Error("нет такой карточки");
  if (m.status === "rejected") throw new Error("карточка уже отклонена");
  const hasEdit = !!edit && (edit.kind !== undefined || edit.title !== undefined || edit.content !== undefined);
  if (m.status === "confirmed" && !hasEdit) return m;
  const c = cleanCard({ kind: edit?.kind ?? m.kind, title: edit?.title ?? m.title, content: edit?.content ?? m.content });
  let emb: Buffer | null = null;
  try { emb = vecBuf((await embed([`${c.title}\n${c.content}`], "doc"))[0]); } catch { /* эмбеддинги посчитаются позже */ }
  // карточку могли отклонить, пока считался эмбеддинг
  const r = db.prepare("update memories set kind=?, title=?, content=?, status='confirmed', embedding=?, updated_at=? where id=? and status!='rejected'")
    .run(c.kind, c.title, c.content, emb, now(), id);
  if (!r.changes) throw new Error(get(id) ? "карточка уже отклонена" : "нет такой карточки");
  return get(id)!;
}

// «Не нужно» действует только на ожидающую карточку. Устаревшее предложение в чате (карточку уже подтвердили
// в панели или в другой вкладке) не должно молча стирать подтверждённую память — тогда это ничего не делает.
export function reject(id: number) {
  return db.prepare("update memories set status='rejected', updated_at=? where id=? and status='pending'").run(now(), id).changes > 0;
}
export function remove(id: number) {
  db.prepare("delete from memories where id=?").run(id);
}

const normKind = (k: string) => { const x = String(k ?? "").trim().toLowerCase(); return (KINDS as readonly string[]).includes(x) ? x : "fact"; };
const fmt = (m: Pick<Memory, "kind" | "title" | "content">) => `- [${KIND_RU[m.kind] ?? m.kind}] ${m.title}: ${m.content}`;

async function ensureEmbeddings(rows: (Memory & { embedding: Buffer | null })[]) {
  const missing = rows.filter((r) => !r.embedding);
  if (!missing.length) return;
  const vecs = await embed(missing.map((r) => `${r.title}\n${r.content}`), "doc");
  const up = db.prepare("update memories set embedding=? where id=?");
  missing.forEach((r, i) => { r.embedding = vecBuf(vecs[i]); up.run(r.embedding, r.id); });
}

// Список заголовков в пределах бюджета токенов: при тысяче карточек он не должен раздувать промпт.
// Оставляем самые новые (они ближе к текущей работе), показываем в порядке создания.
function titleList(rows: Pick<Memory, "kind" | "title">[], budget: number, line: (r: Pick<Memory, "kind" | "title">) => string, sep: string) {
  const keep: number[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = approxTokens(line(rows[i]) + sep);
    if (used + t > budget) break;
    keep.push(i); used += t;
  }
  keep.reverse();
  return { text: keep.map((i) => line(rows[i])).join(sep), omitted: rows.length - keep.length };
}

// Блок памяти для системного промпта. full=false: влезли только заголовки, а релевантные
// карточки целиком подклеиваются к текущему сообщению через recall().
export function stable(taskId: string): { text: string; full: boolean } {
  const rows = list(taskId, "confirmed");
  if (!rows.length) return { text: "", full: true };
  const all = rows.map(fmt).join("\n");
  if (approxTokens(all) <= cfg.recallMemoryTokens) return { text: all, full: true };
  const tl = titleList(rows, cfg.recallMemoryTokens, (r) => `- [${KIND_RU[r.kind] ?? r.kind}] ${r.title}`, "\n");
  return {
    text: `Карточек много (${rows.length}), здесь только заголовки — содержимое релевантных подклеено к сообщению, остальное через search_memory:\n` + tl.text +
      (tl.omitted ? `\n(и ещё ${tl.omitted} более старых — через search_memory)` : ""),
    full: false,
  };
}

// ---------- снимок памяти на чат (кэш промпта) ----------
// Системный промпт чата строится из снимка памяти, сделанного в начале чата (и обновляемого при сворачивании,
// которое и так меняет промпт). Иначе каждое подтверждение/правка карточки посреди чата меняло бы начало промпта,
// и llama-server пересчитывал бы весь чат. Что поменялось после снимка, уходит в контекст хода (delta()).
// seen: какие карточки модель уже видела в этом чате — в снимке или в прошлых дельтах
// (id → заголовок для «удалены: …» и хэш строки карточки, чтобы заметить правку; снимок лежит в чекпоинте — держим его маленьким).
export type MemSnap = { text: string; full: boolean; seen: Record<string, { t: string; h: string }> };
const hashOf = (s: string) => createHash("sha1").update(s).digest("base64url").slice(0, 16);
const seenOf = (r: Memory) => ({ t: clip(r.title, 80), h: hashOf(fmt(r)) });

export function snapshot(taskId: string): MemSnap {
  const st = stable(taskId);
  return { ...st, seen: Object.fromEntries(list(taskId, "confirmed").map((r) => [String(r.id), seenOf(r)])) };
}

export function delta(taskId: string, snap: MemSnap): { text: string; seen: MemSnap["seen"] } {
  const rows = list(taskId, "confirmed");
  const seen: MemSnap["seen"] = {};
  const changed: string[] = [];
  for (const r of rows) {
    const v = seenOf(r);
    seen[String(r.id)] = v;
    if (snap.seen[String(r.id)]?.h !== v.h) changed.push(fmt(r));
  }
  const removed = Object.entries(snap.seen).filter(([id]) => !seen[id]).map(([, v]) => `«${v.t}»`);
  if (!changed.length && !removed.length) return { text: "", seen: snap.seen };
  const shown: string[] = [];
  let used = 0, more = 0;
  for (const h of changed) {
    const t = approxTokens(h);
    if (used + t > cfg.recallMemoryTokens) { more++; continue; }
    shown.push(h); used += t;
  }
  const parts = ["Память задачи изменилась после начала этого чата (это новее блока «ПАМЯТЬ ЗАДАЧИ» в системном промпте):"];
  if (shown.length) parts.push(shown.join("\n"));
  if (more) parts.push(`(ещё изменено карточек: ${more} — через search_memory)`);
  if (removed.length) parts.push(`Удалены из памяти — больше не опирайся на них: ${removed.slice(0, 30).join(", ")}${removed.length > 30 ? ` и ещё ${removed.length - 30}` : ""}`);
  return { text: parts.join("\n"), seen };
}

// Релевантные текущему вопросу карточки (когда вся память не влезает в стабильный блок)
export async function recall(taskId: string, query: string): Promise<string> {
  const rows = db.prepare(`select ${cols}, embedding from memories where task_id=? and status='confirmed' order by created_at`).all(taskId) as (Memory & { embedding: Buffer | null })[];
  if (!rows.length) return "";
  const all = rows.map(fmt);
  if (approxTokens(all.join("\n")) <= cfg.recallMemoryTokens) return all.join("\n");
  // не влезает целиком: самые близкие по смыслу + заголовки остальных (их можно достать search_memory)
  try {
    await ensureEmbeddings(rows);
    const [qv] = await embed([query], "query");
    const scored = rows.map((r, i) => ({ r, i, s: r.embedding ? cosine(qv, bufVec(r.embedding)) : 0 })).sort((a, b) => b.s - a.s);
    const picked: number[] = [];
    let used = 0;
    for (const x of scored) {
      const t = approxTokens(all[x.i]);
      if (used + t > cfg.recallMemoryTokens) continue;
      picked.push(x.i); used += t;
    }
    picked.sort((a, b) => a - b);
    const restRows = rows.filter((_, i) => !picked.includes(i));
    const rest = titleList(restRows, cfg.recallMemoryTokens, (r) => `«${r.title}»`, ", ");
    return picked.map((i) => all[i]).join("\n") + (restRows.length
      ? `\n(ещё в памяти задачи, достать через search_memory: ${rest.text}${rest.omitted ? ` и ещё ${rest.omitted}` : ""})` : "");
  } catch {
    return all.slice(-20).join("\n") + "\n(память показана не полностью: эмбеддинги недоступны)";
  }
}

// Поиск для инструмента search_memory: по задаче или по всем задачам
export async function search(query: string, taskId: string | null, k = 6) {
  const rows = (taskId
    ? db.prepare(`select m.${cols.split(",").join(",m.")}, m.embedding, t.title as task_title from memories m join tasks t on t.id=m.task_id where m.task_id=? and m.status='confirmed'`).all(taskId)
    : db.prepare(`select m.${cols.split(",").join(",m.")}, m.embedding, t.title as task_title from memories m join tasks t on t.id=m.task_id where m.status='confirmed'`).all()) as (Memory & { embedding: Buffer | null; task_title: string })[];
  if (!rows.length) return [];
  await ensureEmbeddings(rows);
  const [qv] = await embed([query], "query");
  return rows
    .map((r) => ({ r, s: r.embedding ? cosine(qv, bufVec(r.embedding)) : 0 }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(({ r, s }) => ({ id: r.id, task: r.task_title, kind: r.kind, title: r.title, content: r.content, score: Number(s.toFixed(3)) }));
}

export const titles = (taskId: string) =>
  (db.prepare("select title from memories where task_id=? and status in ('confirmed','pending')").all(taskId) as { title: string }[]).map((r) => r.title);

// ---------- для предложений памяти (propose) ----------
// Что уже есть в памяти задачи — модели, чтобы не предлагала повторно: подтверждённые и ожидающие с текстом,
// отклонённые — заголовками. В пределах бюджета; самые новые важнее.
export function proposeContext(taskId: string) {
  const live = db.prepare(`select ${cols} from memories where task_id=? and status in ('confirmed','pending') order by created_at`).all(taskId) as Memory[];
  const rejected = db.prepare("select title from memories where task_id=? and status='rejected' order by updated_at").all(taskId) as { title: string }[];
  const lines: string[] = [];
  let used = 0, omitted = 0;
  for (let i = live.length - 1; i >= 0; i--) {
    const r = live[i];
    const l = `- [${KIND_RU[r.kind] ?? r.kind}${r.status === "pending" ? ", ждёт подтверждения" : ""}] «${r.title}»: ${clip(r.content.replace(/\s+/g, " "), 200)}`;
    if (used + approxTokens(l) > 1200) { omitted = i + 1; break; }
    lines.push(l); used += approxTokens(l);
  }
  lines.reverse();
  const rej = titleList(rejected.map((r) => ({ kind: "", title: r.title })), 400, (r) => `«${r.title}»`, ", ");
  return [
    `Уже в памяти задачи — не предлагай это снова, даже другими словами:\n${lines.length ? lines.join("\n") : "нет"}${omitted ? `\n(и ещё ${omitted} более старых)` : ""}`,
    ...(rejected.length ? [`Пользователь отклонил — не предлагай снова: ${rej.text}${rej.omitted ? ` и ещё ${rej.omitted}` : ""}`] : []),
  ].join("\n");
}

// Отсеять повторы (сравнение без учёта регистра и лишних пробелов):
//  - заголовок уже подтверждён или отклонён пользователем в этой задаче;
//  - такое же предложение этого чата ещё ждёт ответа (оно видно прямо в ленте выше);
//  - повтор внутри одного ответа модели.
// Ожидающее предложение из ДРУГОГО чата не мешает: там оно могло устареть, а новое — уточнённая версия.
const normTitle = (t: string) => clip(String(t ?? "").trim(), TITLE_MAX).replace(/\s+/g, " ").trim().toLowerCase();
export function dedupe<T extends { title: string }>(taskId: string, chatId: string | null, items: T[]): T[] {
  const rows = db.prepare("select title from memories where task_id=? and (status!='pending' or chat_id is ?)").all(taskId, chatId) as { title: string }[];
  const seen = new Set(rows.map((r) => normTitle(r.title)));
  const out: T[] = [];
  for (const it of items) {
    const k = normTitle(it.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
