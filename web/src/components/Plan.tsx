import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, CircleDot, OctagonAlert, Plus, SkipForward, X } from "lucide-react";
import { api, type PlanItem, type PlanStatus, type Task } from "../api";
import { Button, Input, cx, useToast } from "../ui";

const NEXT: Record<PlanStatus, PlanStatus> = { todo: "doing", doing: "done", done: "blocked", blocked: "skipped", skipped: "todo" };
const STATUS_TITLE: Record<PlanStatus, string> = {
  todo: "в планах — клик: в работу",
  doing: "в работе — клик: готово",
  done: "готово — клик: заблокировано",
  blocked: "заблокировано — клик: пропустить",
  skipped: "пропущено — клик: снова в планы",
};
const STATUS_LABEL: Record<PlanStatus, string> = {
  todo: "в планах",
  doing: "в работе",
  done: "готово",
  blocked: "блок",
  skipped: "пропущен",
};
const STATUS_PILL: Record<PlanStatus, string> = {
  todo: "border-line text-dim",
  doing: "border-cyan/35 bg-cyan/10 text-cyan",
  done: "border-accent/35 bg-accent/10 text-accent",
  blocked: "border-warn/35 bg-warn/10 text-warn",
  skipped: "border-line bg-surface-2 text-faint",
};

function StatusIcon({ status }: { status: PlanStatus }) {
  const cls = "flex-none";
  if (status === "done") return <CheckCircle2 size={15} className={cx(cls, "text-accent")} />;
  if (status === "doing") return <CircleDot size={15} className={cx(cls, "text-cyan")} />;
  if (status === "blocked") return <OctagonAlert size={15} className={cx(cls, "text-warn")} />;
  if (status === "skipped") return <SkipForward size={15} className={cx(cls, "text-faint")} />;
  return <Circle size={15} className={cx(cls, "text-dim")} />;
}

function StatusBadge({ status }: { status: PlanStatus }) {
  return (
    <span data-testid="plan-status-badge" data-status={status}
      className={cx("inline-flex flex-none items-center rounded-full border px-1.5 py-px text-[10.5px] leading-tight whitespace-nowrap", STATUS_PILL[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function PlanPanel({ task, onChanged }: { task: Task; onChanged?: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<PlanItem[]>([]);
  const [phases, setPhases] = useState<readonly string[]>([]);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState("Recon");
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const noteCancel = useRef(false);

  const load = useCallback(async (quiet = false) => {
    try {
      const r = await api.plan(task.id);
      setItems(r.items);
      setPhases(r.phases);
    } catch (e: any) {
      if (!quiet) toast("error", e.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [task.id, toast]);

  useEffect(() => {
    setLoading(true);
    setEditId(null);
    void load();
    const t = setInterval(() => void load(true), 5000); // модель обновляет план на ходу
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); await load(true); onChanged?.(); } catch (e: any) { toast("error", e.message); }
  };

  const add = async () => {
    const v = text.trim();
    if (!v) return;
    setText("");
    await act(() => api.planAdd(task.id, phase, v));
  };

  const startNoteEdit = (i: PlanItem) => {
    noteCancel.current = false;
    setNoteDraft(i.note);
    setEditId(i.id);
  };
  const saveNote = (i: PlanItem) => {
    if (noteCancel.current) return;
    noteCancel.current = true; // blur после Enter не должен сохранять второй раз
    setEditId(null);
    const v = noteDraft.trim();
    if (v !== i.note) void act(() => api.planUpdate(task.id, i.id, { note: v }));
  };

  const orderedPhases = [...phases, ...items.map((i) => i.phase).filter((p) => !phases.includes(p))];
  const doneCount = items.filter((i) => i.status === "done").length;

  return (
    <div className="space-y-4 p-4" data-testid="plan-panel">
      <div className="rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-dim">
        {items.length > 0 ? (
          <>
            Общая карта решения: план ведёт модель инструментом plan_update, сводка подклеивается ей в каждый ход.
            Ты можешь править здесь сам — клик по иконке меняет статус, по заметке — правит её; модель увидит изменения следующим ходом.
            {" "}Готово: <span className="text-fg-2">{doneCount} из {items.length}</span>.
          </>
        ) : loading ? (
          <>Загружаю план…</>
        ) : (
          <>
            План пока пуст. Модель составит его инструментом <span className="font-mono text-fg-2">plan_update</span> в начале работы
            над машиной — по фазам Recon → Enumeration → Foothold → User → PrivEsc → Root — и сводка будет подклеиваться ей
            в каждый ход. Можно добавить пункты самому ниже: клик по иконке меняет статус, по заметке — правит её.
          </>
        )}
      </div>

      {orderedPhases.map((ph) => {
        const rows = items.filter((i) => i.phase === ph);
        if (!rows.length) return null;
        const phDone = rows.filter((i) => i.status === "done").length;
        return (
          <div key={ph} className="space-y-0.5">
            <div className="text-[11px] tracking-[0.08em] text-fg-2 uppercase" data-testid="plan-phase" data-phase={ph}>
              {ph} <span className="tracking-normal text-faint normal-case">— {phDone}/{rows.length}</span>
            </div>
            {rows.map((i) => (
              <div key={i.id} className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition hover:bg-surface-2"
                data-testid="plan-item" data-plan-id={i.id} data-status={i.status}>
                <button type="button" title={STATUS_TITLE[i.status]} data-testid="plan-status"
                  onClick={() => void act(() => api.planUpdate(task.id, i.id, { status: NEXT[i.status] }))}
                  className="mt-[1px] flex-none cursor-pointer">
                  <StatusIcon status={i.status} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <span className={cx("min-w-0 flex-1 text-[12.5px] leading-snug", i.status === "done" && "text-dim line-through", i.status === "skipped" && "text-faint")}>{i.text}</span>
                    <StatusBadge status={i.status} />
                  </div>
                  {editId === i.id ? (
                    <form onSubmit={(e) => { e.preventDefault(); saveNote(i); }}>
                      <input autoFocus value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Escape") { noteCancel.current = true; setEditId(null); } }}
                        onBlur={() => saveNote(i)}
                        placeholder="заметка… (Enter — сохранить)"
                        data-testid="plan-note-input"
                        className="mt-1 h-7 w-full rounded border border-transparent bg-surface-2 px-2 text-[11.5px] text-fg outline-none transition focus:border-fg" />
                    </form>
                  ) : i.note ? (
                    <button type="button" title="править заметку" data-testid="plan-note"
                      onClick={() => startNoteEdit(i)}
                      className="block cursor-text text-left text-[11.5px] leading-snug text-dim transition hover:text-fg-2">
                      {i.note}
                    </button>
                  ) : (
                    <button type="button" title="добавить заметку" data-testid="plan-note-add"
                      onClick={() => startNoteEdit(i)}
                      className="block cursor-text text-left text-[11px] leading-snug text-faint opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:text-fg-2">
                      + заметка
                    </button>
                  )}
                </div>
                <button type="button" title="удалить пункт" data-testid="plan-delete"
                  onClick={() => void act(() => api.planDelete(task.id, i.id))}
                  className="flex-none cursor-pointer text-faint opacity-0 transition group-hover:opacity-100 hover:text-err">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        );
      })}

      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <select value={phase} onChange={(e) => setPhase(e.target.value)} data-testid="plan-new-phase"
          className="h-9 w-[128px] flex-none rounded border border-transparent bg-surface-2 px-2 text-[12.5px] text-fg outline-none transition focus:border-fg">
          {orderedPhases.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <div className="min-w-0 flex-1">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="новый пункт плана…" data-testid="plan-new-text" />
        </div>
        <Button type="submit" size="icon-sm" title="добавить пункт" data-testid="plan-add"><Plus size={13} /></Button>
      </form>
    </div>
  );
}
