import { nanoid } from "nanoid";
import { db, now } from "./db.ts";

// План решения задачи: пункты по фазам со статусами. Ведёт модель инструментом plan_update,
// пользователь правит в панели «План». Идея — Pentesting Task Tree из PentestGPT, упрощённая
// до фаз HTB-машины: дерево не нужно, нужны видимый прогресс и следующая цель перед глазами у обоих.
export const PLAN_PHASES = ["Recon", "Enumeration", "Foothold", "User", "PrivEsc", "Root", "PostEx"] as const;
export type PlanStatus = "todo" | "doing" | "done" | "blocked" | "skipped";
export type PlanItem = {
  id: string;
  phase: string;
  text: string;
  status: PlanStatus;
  note: string;
  sort: number;
};

const STATUSES = new Set(["todo", "doing", "done", "blocked", "skipped"]);

export function listPlan(taskId: string): PlanItem[] {
  return db.prepare("select id, phase, text, status, note, sort from plan_items where task_id=? order by sort, created_at")
    .all(taskId) as PlanItem[];
}

function normPhase(phase: unknown): string {
  const p = String(phase ?? "").trim();
  const hit = PLAN_PHASES.find((x) => x.toLowerCase() === p.toLowerCase());
  return hit ?? (p ? p.slice(0, 40) : "Recon");
}

export function addPlanItem(taskId: string, phase: unknown, textRaw: unknown, statusRaw?: unknown): PlanItem {
  const text = String(textRaw ?? "").trim().slice(0, 300);
  if (!text) throw new Error("пустой текст пункта плана");
  const count = (db.prepare("select count(*) as n from plan_items where task_id=?").get(taskId) as { n: number }).n;
  if (count >= 80) throw new Error("план задачи переполнен (80 пунктов): закрой или удали завершённые через панель «План»");
  const status = STATUSES.has(String(statusRaw)) ? (String(statusRaw) as PlanStatus) : "todo";
  const maxSort = (db.prepare("select coalesce(max(sort), -1) as m from plan_items where task_id=?").get(taskId) as { m: number }).m;
  const item: PlanItem = { id: nanoid(8), phase: normPhase(phase), text, status, note: "", sort: maxSort + 1 };
  db.prepare("insert into plan_items(id, task_id, phase, text, status, note, sort, created_at, updated_at) values(?,?,?,?,?,?,?,?,?)")
    .run(item.id, taskId, item.phase, item.text, item.status, item.note, item.sort, now(), now());
  return item;
}

export function updatePlanItem(taskId: string, id: string, patch: { status?: unknown; note?: unknown; text?: unknown; phase?: unknown }): PlanItem {
  const cur = db.prepare("select id, phase, text, status, note, sort from plan_items where task_id=? and id=?").get(taskId, id) as PlanItem | undefined;
  if (!cur) {
    const all = listPlan(taskId);
    const list = all.length ? `существующие пункты: ${all.map((i) => `${i.id} «${i.text}»`).join(", ")}.` : "план пуст.";
    throw new Error(`нет такого пункта плана: ${id}; ${list}`);
  }
  const next: PlanItem = {
    ...cur,
    status: patch.status !== undefined && STATUSES.has(String(patch.status)) ? (String(patch.status) as PlanStatus) : cur.status,
    note: patch.note !== undefined ? String(patch.note).slice(0, 500) : cur.note,
    text: patch.text !== undefined ? (String(patch.text).trim().slice(0, 300) || cur.text) : cur.text,
    phase: patch.phase !== undefined ? normPhase(patch.phase) : cur.phase,
  };
  db.prepare("update plan_items set phase=?, text=?, status=?, note=?, updated_at=? where id=?")
    .run(next.phase, next.text, next.status, next.note, now(), id);
  return next;
}

export function removePlanItem(taskId: string, id: string) {
  const r = db.prepare("delete from plan_items where task_id=? and id=?").run(taskId, id);
  if (!r.changes) throw new Error(`нет такого пункта плана: ${id}`);
}

const MARK: Record<PlanStatus, string> = { todo: "TODO", doing: "DOING", done: "DONE", blocked: "BLOCKED", skipped: "SKIPPED" };

// Компактный текст плана для модели: активные пункты целиком, завершённые — счётчиком и последними тремя.
export function formatPlan(items: PlanItem[]): string {
  if (!items.length) return "(план пуст)";
  const lines: string[] = [];
  const done = items.filter((i) => i.status === "done");
  const active = items.filter((i) => i.status !== "done");
  if (done.length) lines.push(`готово ${done.length}: ${done.slice(-3).map((i) => i.text).join("; ")}${done.length > 3 ? " и др." : ""}`);
  for (const i of active) lines.push(`[${MARK[i.status]}] (${i.id}) ${i.phase}: ${i.text}${i.note ? ` — ${i.note}` : ""}`);
  return lines.join("\n").slice(0, 1600);
}
