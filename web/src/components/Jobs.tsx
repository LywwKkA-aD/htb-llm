import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, Play, Send, Square, Trash2 } from "lucide-react";
import { api, type JobInfo, type Task } from "../api";
import { Button, Dot, Field, Input, Seg, Textarea, cx, useConfirm, useToast } from "../ui";

type Preset = "listener" | "http" | "custom";

const presetCommand = (kind: Preset, port: string) => {
  const p = port.trim() || "4444";
  if (kind === "listener") return { name: `listener-${p}`, command: `nc -lvnp ${p}` };
  if (kind === "http") return { name: `http-${p}`, command: `cd /work/www && python3 -m http.server ${p}` };
  return { name: "", command: "" };
};

export function JobsPanel({ task }: { task: Task }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState<JobInfo[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [preset, setPreset] = useState<Preset>("listener");
  const [name, setName] = useState("listener-4444");
  const [port, setPort] = useState("4444");
  const [command, setCommand] = useState("nc -lvnp 4444");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;
  // Липкий низ вывода, как в чате: следим за хвостом сессии, пока пользователь сам не отмотал вверх;
  // своя отправка команды и смена сессии снова прижимают вниз.
  const outRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  const outTop = useRef(0);

  useLayoutEffect(() => { stickRef.current = true; }, [sel]);
  useLayoutEffect(() => {
    const el = outRef.current;
    if (el && stickRef.current) { el.scrollTop = el.scrollHeight; outTop.current = el.scrollTop; }
  }, [output, sel]);
  const onOutScroll = () => {
    const el = outRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const up = el.scrollTop < outTop.current - 0.5;
    outTop.current = el.scrollTop;
    if (up && gap > 1) stickRef.current = false;
    else if (gap < 80) stickRef.current = true;
  };

  const load = useCallback(async () => {
    try {
      const jobs = await api.jobs(task.id);
      setList(jobs);
      setSel((prev) => (prev && jobs.some((j) => j.id === prev) ? prev : jobs.at(-1)?.id ?? null));
    } catch { /* список обновится следующим опросом */ }
  }, [task.id]);

  useEffect(() => {
    setSel(null);
    setOutput("");
    void load();
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [load]);

  const loadOutput = useCallback(async () => {
    const id = selRef.current;
    if (!id) { setOutput(""); return; }
    try {
      const r = await api.jobOutput(task.id, id, 250);
      if (selRef.current === id) setOutput(r.output);
    } catch { /* job могли удалить */ }
  }, [task.id]);

  useEffect(() => {
    void loadOutput();
    if (!sel) return;
    const t = setInterval(() => void loadOutput(), 2500);
    return () => clearInterval(t);
  }, [sel, loadOutput]);

  const applyPreset = (kind: Preset, p = port) => {
    setPreset(kind);
    if (kind === "custom") return;
    const t = presetCommand(kind, p);
    setName(t.name);
    setCommand(t.command);
  };

  const create = async () => {
    if (!name.trim() || !command.trim() || busy) return;
    setBusy(true);
    try {
      const job = await api.createJob(task.id, name.trim(), command.trim());
      setSel(job.id);
      toast("success", `job «${job.name}» запущен`);
      await load();
    } catch (e: any) { toast("error", e.message); } finally { setBusy(false); }
  };

  const sendInput = async () => {
    if (!sel || !input.trim()) return;
    const text = input;
    setInput("");
    stickRef.current = true; // своя команда — показывай её вывод, даже если до этого читал старый
    try {
      await api.jobInput(task.id, sel, text, true);
      setTimeout(() => void loadOutput(), 350);
    } catch (e: any) { toast("error", e.message); }
  };

  const stop = async (job: JobInfo) => {
    try { await api.jobStop(task.id, job.id); await load(); await loadOutput(); }
    catch (e: any) { toast("error", e.message); }
  };
  const remove = async (job: JobInfo) => {
    const ok = await confirm({
      title: "Удалить job?",
      message: <>Сессия <span className="text-fg">«{job.name}»</span> будет остановлена и удалена из списка. Файлы в /work останутся.</>,
      confirmText: "удалить", danger: true,
    });
    if (!ok) return;
    try {
      await api.jobDelete(task.id, job.id);
      if (sel === job.id) setSel(null);
      await load();
    } catch (e: any) { toast("error", e.message); }
  };

  const selected = list.find((j) => j.id === sel) ?? null;

  return (
    <div className="space-y-4 p-3" data-testid="jobs-panel">
      <div className="rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-dim">
        Фоновые сессии в контейнере задачи (tmux): listener reverse shell, HTTP-сервер для <span className="font-mono text-fg-2">/work/www</span>,
        интерактивный shell. Живут между ходами агента и перезагрузками страницы, пока запущен контейнер. Агент управляет ими инструментами <span className="font-mono text-fg-2">job_*</span>.
      </div>

      <div className="space-y-3">
        <div className="text-[11px] tracking-[0.12em] text-fg-2 uppercase">Новый job</div>
        <Seg<Preset>
          testid="job-preset" value={preset} onChange={(v) => applyPreset(v)}
          options={[
            { value: "listener", label: "listener (nc)", title: "слушатель reverse shell на $LHOST" },
            { value: "http", label: "http (www)", title: "раздача /work/www цели по HTTP" },
            { value: "custom", label: "своя команда", title: "произвольная долгоживущая команда или bash -l" },
          ]}
        />
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label="имя">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="listener-4444" data-testid="job-name" />
          </Field>
          <Field label="порт">
            <Input value={port} inputMode="numeric" data-testid="job-port"
              onChange={(e) => { setPort(e.target.value); if (preset !== "custom") applyPreset(preset, e.target.value); }} />
          </Field>
        </div>
        <Field label="команда" hint="после её завершения сессия останется интерактивным bash">
          <Textarea rows={3} value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono text-[12px]" data-testid="job-command" />
        </Field>
        <Button variant="solid" disabled={!name.trim() || !command.trim() || busy} onClick={() => void create()} data-testid="job-create">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} запустить job
        </Button>
      </div>

      <div className="space-y-2">
        <div className="text-[11px] tracking-[0.12em] text-fg-2 uppercase">Сессии</div>
        {!list.length && <div className="text-[12.5px] text-dim" data-testid="jobs-empty">Пока нет ни одного job. Запусти listener перед пейлоадом — шелл прилетит в эту сессию.</div>}
        {list.map((j) => (
          <div key={j.id} data-testid="job-card" data-running={String(j.running)} onClick={() => setSel(j.id)}
            className={cx("cursor-pointer rounded-[10px] border px-3 py-2 transition",
              sel === j.id ? "border-accent/50 bg-surface-2" : "border-line bg-surface-2/60 hover:border-line-2")}>
            <div className="flex items-center gap-2">
              <Dot state={j.running ? "ok" : "off"} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-fg" title={j.name}>{j.name}</span>
              <span className="flex-none text-[11px] text-dim">{new Date(j.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
              {j.running && (
                <Button variant="ghost" size="icon-sm" title="остановить job" data-testid={`job-stop-${j.id}`}
                  onClick={(e) => { e.stopPropagation(); void stop(j); }}><Square size={12} /></Button>
              )}
              <Button variant="ghost" size="icon-sm" title="удалить job" data-testid={`job-delete-${j.id}`}
                onClick={(e) => { e.stopPropagation(); void remove(j); }}><Trash2 size={12} /></Button>
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-dim" title={j.command}>{j.command}</div>
          </div>
        ))}
      </div>

      {selected && (
        <div className="space-y-2">
          <div className="text-[11px] tracking-[0.12em] text-fg-2 uppercase">Вывод · {selected.name}</div>
          <pre ref={outRef} onScroll={onOutScroll} data-testid="job-output" className="max-h-80 overflow-auto rounded-[10px] border border-line-2 bg-term px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-2">
            {output || "(пока пусто)"}
          </pre>
          <div className="flex gap-2">
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="команда в сессию (Enter — отправить)"
              disabled={!selected.running} data-testid="job-input" className="font-mono"
              onKeyDown={(e) => { if (e.key === "Enter") void sendInput(); }} />
            <Button variant="solid" disabled={!selected.running || !input.trim()} onClick={() => void sendInput()} data-testid="job-send">
              <Send size={13} /> отправить
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
