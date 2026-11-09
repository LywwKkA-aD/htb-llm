import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Brain, Check, Copy, FileText, FolderOpen, Library, Loader2, Network, Pencil, Play, Plus, Square, Trash2, Upload, AlertCircle, ListTodo, X } from "lucide-react";
import { api, KIND_RU, type Doc, type Memory, type Task, type VpnInfo } from "../api";
import { Button, Dot, Field, Input, Modal, Seg, Textarea, cx, useConfirm, useToast } from "../ui";

const SectionTitle = ({ children, testid }: { children: React.ReactNode; testid?: string }) => (
  <div className="mt-1.5 mb-2.5 flex items-center gap-2 text-[11px] tracking-[0.12em] text-fg-2 uppercase" data-testid={testid}>{children}</div>
);
const Note = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-4 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-dim">{children}</div>
);

// ---------- карточка памяти ----------
// те же ограничения, что у сервера (memory.ts): заголовок до 200 символов, суть до 4000
const MEM_TITLE_MAX = 200, MEM_CONTENT_MAX = 4000;
const selectCls = "h-9 w-36 flex-none rounded-[10px] border border-line-2 bg-term px-2 text-[12.5px] text-fg outline-none focus:border-accent/45";

export const KIND_STYLE: Record<string, string> = {
  step: "text-cyan border-cyan/35 bg-cyan/10",
  command: "text-accent border-accent/35 bg-accent/10",
  fact: "text-blue border-blue/35 bg-blue/10",
  result: "text-lime border-lime/35 bg-lime/[0.07]",
  mistake: "text-err border-err/35 bg-err/10",
};

export function MemCard({ m, onDone }: { m: Memory; onDone: (id: number) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState({ kind: m.kind, title: m.title, content: m.content });
  // правка всегда начинается с сохранённой версии: «отмена» выбрасывает черновик
  const openEditor = () => { setDraft({ kind: m.kind, title: m.title, content: m.content }); setEdit(true); };
  const title = draft.title.trim(), content = draft.content.trim();
  const blank = edit && (!title || !content);
  const act = (p: Promise<unknown>, msg?: string) => p.then(() => { onDone(m.id); if (msg) toast("success", msg); return true; })
    .catch((e) => { toast("error", e.message); return false; });
  const save = async () => {
    if (blank) return; // пустой заголовок или суть ушли бы в системный промпт как «- [факт] : …»
    if (await act(api.confirmMemory(m.id, edit ? { kind: draft.kind, title, content } : undefined), "сохранено в память задачи")) setEdit(false);
  };
  return (
    <div className="mb-2 rounded-[10px] border border-line bg-surface px-3 py-2.5 transition-colors hover:border-line-2" data-testid="memory-card" data-status={m.status} data-id={m.id}>
      {edit ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} data-testid="mem-kind" aria-label="тип карточки" className={selectCls}>
              {Object.entries(KIND_RU).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} data-testid="mem-title"
              aria-label="заголовок карточки" aria-invalid={!title} maxLength={MEM_TITLE_MAX} placeholder="заголовок"
              className="h-9 min-w-0 flex-1 rounded-[10px] border border-line-2 bg-term px-3 text-fg outline-none focus:border-accent/45 aria-[invalid=true]:border-err/50" />
          </div>
          <Textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={3} data-testid="mem-content"
            aria-label="суть карточки" aria-invalid={!content} maxLength={MEM_CONTENT_MAX} placeholder="суть: команда, адрес, вывод…" className="aria-[invalid=true]:border-err/50" />
        </div>
      ) : (
        <>
          <div className="mb-1 flex items-center gap-2">
            <span className={cx("flex-none rounded-full border px-2 text-[10.5px] leading-[18px]", KIND_STYLE[m.kind] ?? KIND_STYLE.fact)}>{KIND_RU[m.kind] ?? m.kind}</span>
            <span className="min-w-0 truncate font-bold text-fg" title={m.title}>{m.title}</span>
          </div>
          <div className="text-[12.5px] break-words whitespace-pre-wrap text-fg-2">{m.content}</div>
        </>
      )}
      <div className="mt-2.5 flex gap-1.5">
        {(m.status === "pending" || edit) && (
          <Button size="xs" variant="primary" data-testid="mem-confirm" disabled={blank} onClick={() => void save()}>
            <Check size={12} /> сохранить
          </Button>
        )}
        <Button size="xs" onClick={() => (edit ? setEdit(false) : openEditor())} data-testid="mem-edit">{edit ? "отмена" : <><Pencil size={11} /> править</>}</Button>
        {m.status === "pending" ? (
          <Button size="xs" variant="ghost" className="hover:text-err" onClick={() => void act(api.rejectMemory(m.id))} data-testid="mem-reject"><X size={12} /> не нужно</Button>
        ) : (
          <Button size="xs" variant="ghost" className="hover:text-err" data-testid="mem-delete"
            onClick={async () => { if (await confirm({ title: "Удалить карточку?", message: <>«{m.title}» пропадёт из памяти задачи — агент больше не будет на неё опираться.</>, confirmText: "удалить", danger: true })) void act(api.deleteMemory(m.id), "карточка удалена"); }}>
            <X size={12} /> удалить
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------- память задачи ----------
const EMPTY_MEM = { kind: "fact", title: "", content: "" };
export function MemoryPanel({ task, version, onChanged }: { task: Task; version: number; onChanged: () => void }) {
  const toast = useToast();
  const [mem, setMem] = useState<Memory[]>([]);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState(EMPTY_MEM);
  // панель не пересоздаётся при смене задачи: черновик «вручную» и карточки прошлой задачи сбрасываем,
  // иначе «добавить» записал бы карточку задачи A в задачу B; поздний ответ по прошлой задаче не применяем
  const cur = useRef(task.id);
  useLayoutEffect(() => {
    if (cur.current === task.id) return;
    cur.current = task.id;
    setAdding(false); setF(EMPTY_MEM); setMem([]);
  }, [task.id]);
  const load = useCallback(() => {
    const id = task.id;
    return api.memories(id).then((m) => { if (cur.current === id) setMem(m); })
      .catch((e) => { if (cur.current === id) toast("error", e.message); });
  }, [task.id, toast]);
  useEffect(() => { void load(); }, [load, version]);
  const done = () => { void load(); onChanged(); };
  const pending = mem.filter((m) => m.status === "pending");
  const confirmed = mem.filter((m) => m.status === "confirmed");
  return (
    <div className="px-4 py-4" data-testid="memory-panel">
      <Note>Подтверждённая память подтягивается в каждый новый чат задачи — можно начинать с чистого контекста, ничего не теряя.</Note>
      {pending.length > 0 && (
        <div className="mb-4">
          <SectionTitle testid="mem-pending-title"><span className="text-warn">ждут подтверждения · {pending.length}</span></SectionTitle>
          {pending.map((m) => <MemCard key={m.id} m={m} onDone={done} />)}
        </div>
      )}
      <div className="flex items-center justify-between">
        <SectionTitle testid="mem-confirmed-title"><Brain size={13} className="text-accent" /> подтверждено · {confirmed.length}</SectionTitle>
        <Button size="xs" variant={adding ? "default" : "primary"} onClick={() => { if (adding) setF(EMPTY_MEM); setAdding(!adding); }} data-testid="mem-add">{adding ? "отмена" : <><Plus size={12} /> вручную</>}</Button>
      </div>
      {adding && (
        <div className="mb-3 space-y-2 rounded-[10px] border border-line-2 bg-surface-2 p-3" data-testid="mem-add-form">
          <div className="flex gap-2">
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="тип карточки" data-testid="mem-add-kind" className={selectCls}>
              {Object.entries(KIND_RU).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <Input placeholder="заголовок" aria-label="заголовок карточки" maxLength={MEM_TITLE_MAX} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} data-testid="mem-add-title" />
          </div>
          <Textarea placeholder="суть: команда, адрес, вывод…" aria-label="суть карточки" maxLength={MEM_CONTENT_MAX} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} data-testid="mem-add-content" />
          <div className="flex justify-end">
            <Button size="sm" variant="solid" disabled={!f.title.trim() || !f.content.trim()} data-testid="mem-add-save"
              onClick={() => { const id = task.id; void api.addMemory(id, { kind: f.kind, title: f.title.trim(), content: f.content.trim() })
                .then(() => { if (cur.current === id) { setF(EMPTY_MEM); setAdding(false); } toast("success", "карточка добавлена"); done(); }).catch((e) => toast("error", e.message)); }}>
              добавить
            </Button>
          </div>
        </div>
      )}
      {!confirmed.length && !adding && <div className="py-6 text-center text-[12px] text-dim" data-testid="mem-empty">пока пусто — агент предложит карточки после полезных шагов</div>}
      {confirmed.map((m) => <MemCard key={m.id} m={m} onDone={done} />)}
    </div>
  );
}

// ---------- библиотека ----------
export function LibraryPanel({ task }: { task: Task }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [scope, setScope] = useState<"lib" | "task">("lib");
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // поздний ответ по прошлой задаче (панель живёт при смене задачи) не подменяет список текущей
  const cur = useRef(task.id);
  useLayoutEffect(() => { cur.current = task.id; }, [task.id]);
  const load = useCallback(() => {
    const id = task.id;
    return api.docs(id).then((d) => { if (cur.current === id) setDocs(d); })
      .catch((e) => { if (cur.current === id) toast("error", e.message); });
  }, [task.id, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!docs.some((d) => d.status === "indexing")) return;
    const t = setInterval(load, 1200);
    return () => clearInterval(t);
  }, [docs, load]);
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const r = await api.uploadDocs(files, scope === "task" ? task.id : null);
      const bad = r.filter((x) => "error" in x && x.error);
      bad.forEach((x) => toast("error", `${x.name}: ${(x as { error: string }).error}`));
      if (r.length > bad.length) toast("success", `загружено: ${r.length - bad.length} — индексирую`);
    } catch (e: any) { toast("error", e.message); }
    setUploading(false);
    void load();
  };
  const lib = docs.filter((d) => !d.task_id);
  const mine = docs.filter((d) => d.task_id === task.id);
  const row = (d: Doc) => (
    <div key={d.id} className="group flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[12.5px] transition-colors hover:bg-surface-2" data-testid="doc-item" data-status={d.status} data-name={d.name}>
      <FileText size={14} className={cx("flex-none", d.kind === "pdf" ? "text-err/80" : "text-cyan")} />
      <span className="min-w-0 flex-1 truncate text-fg" title={d.name}>{d.name}</span>
      <span className={cx("flex-none text-[11px]", d.status === "ready" ? "text-dim" : d.status === "error" ? "text-err" : "text-warn")} title={d.error ?? ""}>
        {d.status === "ready" ? `${d.pages ? `${d.pages} с. · ` : ""}${d.chunks} фрагм.`
          : d.status === "indexing" ? <span className="inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> индексирую</span>
            : <span className="inline-flex items-center gap-1"><AlertCircle size={11} /> ошибка</span>}
      </span>
      <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:text-err" title="удалить" aria-label={`удалить «${d.name}»`} data-testid="doc-delete"
        onClick={async () => { if (await confirm({ title: "Удалить документ?", message: <>«{d.name}» пропадёт из библиотеки, агент перестанет его находить.</>, confirmText: "удалить", danger: true })) { await api.deleteDoc(d.id); toast("success", "документ удалён"); void load(); } }}>
        <Trash2 size={13} />
      </Button>
    </div>
  );
  return (
    <div className="px-4 py-4" data-testid="library-panel">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className="text-[12px] text-dim">загружать в</span>
        <Seg<"lib" | "task"> testid="lib-scope" value={scope} onChange={setScope}
          options={[{ value: "lib", label: <><Library size={12} /> общую библиотеку</> }, { value: "task", label: <><FolderOpen size={12} /> эту задачу</> }]} />
      </div>
      {/* зона загрузки — кнопка: доступна с клавиатуры (Tab, Enter/Space открывают выбор файлов), принимает перетаскивание */}
      <div
        role="button"
        tabIndex={0}
        aria-busy={uploading}
        data-testid="lib-drop"
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void upload(Array.from(e.dataTransfer.files)); }}
        className={cx("mb-5 block cursor-pointer rounded-[14px] border-[1.5px] border-dashed px-5 py-7 text-center transition outline-none focus-visible:border-accent focus-visible:text-fg-2 focus-visible:ring-2 focus-visible:ring-accent/40",
          over ? "border-accent bg-accent/10 text-accent shadow-glow" : "border-line-3 bg-surface-2 text-dim hover:border-accent/60 hover:text-fg-2")}
      >
        {uploading ? <span className="inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> загружаю…</span> : (
          <>
            <Upload size={22} className="mx-auto mb-2" />
            <div className="text-[12.5px]">перетащи PDF / md / txt — лекции, методички, свои заметки</div>
            <div className="mt-1 text-[11px]">или нажми, чтобы выбрать файлы</div>
          </>
        )}
      </div>
      <input ref={fileRef} type="file" multiple hidden data-testid="lib-input" accept=".pdf,.md,.markdown,.txt,.text,.conf,.cfg,.log,.rst"
        onChange={(e) => { if (e.target.files) void upload(Array.from(e.target.files)); e.target.value = ""; }} />
      <SectionTitle testid="lib-task-title"><FolderOpen size={13} className="text-accent" /> вложения задачи · {mine.length}</SectionTitle>
      {mine.length ? <div className="mb-5">{mine.map(row)}</div> : <div className="mb-5 px-2.5 text-[12px] text-dim">нет — условие, схемы и файлы именно этой задачи</div>}
      <SectionTitle testid="lib-global-title"><Library size={13} className="text-accent" /> общая библиотека · {lib.length}</SectionTitle>
      {lib.length ? lib.map(row) : <div className="px-2.5 text-[12px] text-dim">пусто — сюда лекции и учебники, доступные во всех задачах</div>}
    </div>
  );
}

// ---------- VPN задачи (HTB): туннель внутри контейнера ----------
export function VpnPanel({ task, onChanged }: { task: Task; onChanged?: (info: VpnInfo) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [info, setInfo] = useState<VpnInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  // панель живёт при смене задачи: поздний ответ по прошлой задаче не применяем (как в памяти и библиотеке)
  const cur = useRef(task.id);
  useLayoutEffect(() => { if (cur.current !== task.id) { cur.current = task.id; setInfo(null); } }, [task.id]);
  const apply = useCallback((id: string, v: VpnInfo) => { if (cur.current === id) { setInfo(v); onChanged?.(v); } }, [onChanged]);
  const load = useCallback(() => {
    const id = task.id;
    if (busyRef.current) return Promise.resolve();
    return api.vpn(id).then((v) => apply(id, v)).catch((e) => { if (cur.current === id) toast("error", e.message); });
  }, [task.id, apply, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  const act = async (key: string, fn: () => Promise<VpnInfo>, msg?: string) => {
    const id = task.id;
    busyRef.current = true; setBusy(key);
    try { apply(id, await fn()); if (msg && cur.current === id) toast("success", msg); }
    catch (e: any) { if (cur.current === id) toast("error", e.message); }
    busyRef.current = false; setBusy(null);
    void load();
  };
  const copy = (key: string, text: string) => { void navigator.clipboard?.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1200); };
  const upload = (f: File | undefined) => { if (f) void act("upload", () => api.uploadVpnConfig(task.id, f), "конфиг VPN импортирован"); };
  const st = info?.status;
  const up = st?.state === "up";
  return (
    <div className="px-4 py-4" data-testid="vpn-panel">
      <Note>OpenVPN или WireGuard поднимается <span className="text-fg">внутри Kali-контейнера задачи</span>: обратные соединения от машин HTB приходят прямо на листенер в контейнере, любой порт. Одно подключение HTB на аккаунт — OpenVPN на хосте с тем же конфигом перед этим отключи.</Note>

      <SectionTitle testid="vpn-status-title"><Network size={13} className="text-accent" /> состояние</SectionTitle>
      <div className="mb-4 rounded-[10px] border border-line bg-surface px-3 py-2.5" data-testid="vpn-status" data-state={st?.state ?? "loading"}>
        {!info ? <span className="inline-flex items-center gap-2 text-[12.5px] text-dim"><Loader2 size={13} className="animate-spin" /> проверяю…</span> : (
          <div className="flex flex-wrap items-center gap-2.5">
            <Dot state={up ? "ok" : st?.state === "connecting" ? "mid" : "off"} />
            <span className="text-[13px] text-fg">
              {up ? <>подключён · {st.iface}</> : st?.state === "connecting" ? <span className="inline-flex items-center gap-1.5"><Loader2 size={13} className="animate-spin text-warn" /> подключается…</span> : "не подключён"}
            </span>
            {up && st.ip && (
              <span className="inline-flex items-center gap-1.5">
                <code className="rounded-md border border-accent/30 bg-accent/10 px-2 py-0.5 text-[13px] font-bold text-accent" data-testid="vpn-ip">{st.ip}</code>
                <Button variant="ghost" size="icon-sm" title="скопировать адрес (LHOST)" aria-label="скопировать адрес VPN" onClick={() => copy("ip", st.ip!)} data-testid="vpn-copy-ip">
                  {copied === "ip" ? <Check size={13} /> : <Copy size={13} />}
                </Button>
              </span>
            )}
            <span className="flex-1" />
            {st?.state === "down"
              ? <Button size="sm" variant="solid" disabled={!info.config || !!busy} onClick={() => void act("start", () => api.vpnAction(task.id, "start"))} data-testid="vpn-start">
                  {busy === "start" ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} подключить</Button>
              : <Button size="sm" variant="danger" disabled={!!busy} onClick={() => void act("stop", () => api.vpnAction(task.id, "stop"), "VPN отключён")} data-testid="vpn-stop">
                  {busy === "stop" ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} />} отключить</Button>}
          </div>
        )}
        {up && st.ip && (
          <div className="mt-2.5 space-y-1 border-t border-line pt-2.5 text-[12px] leading-relaxed text-dim" data-testid="vpn-hints">
            <div>reverse shell: в своём терминале <code className="text-fg">nc -lvnp 4444</code>, в пейлоад — <code className="text-fg">{st.ip}:4444</code> (в shell уже есть <code className="text-fg">$LHOST</code>)</div>
            <div>отдать файл цели: <code className="text-fg">python3 -m http.server 8000</code> → <code className="text-fg">http://{st.ip}:8000/…</code></div>
            <div>имя машины в контейнер: <code className="text-fg">echo "&lt;ip-цели&gt; machine.htb" &gt;&gt; /etc/hosts</code></div>
          </div>
        )}
      </div>

      <SectionTitle><FileText size={13} className="text-accent" /> конфиг</SectionTitle>
      {info?.config ? (
        <div className="mb-4 flex flex-wrap items-center gap-2.5 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[12.5px]">
          <span className="min-w-0 flex-1 truncate text-fg" title={info.config.name} data-testid="vpn-config-name">{info.config.name}</span>
          <span className="flex-none rounded-full border border-cyan/35 bg-cyan/10 px-2 text-[10.5px] leading-[18px] text-cyan">{info.config.kind}</span>
          {info.config.proto && <span className={cx("flex-none rounded-full border px-2 text-[10.5px] leading-[18px]", info.config.proto === "tcp" ? "border-warn/40 bg-warn/10 text-warn" : "border-accent/40 bg-accent/10 text-accent")} data-testid="vpn-proto">{info.config.proto.toUpperCase()}</span>}
          <Button size="xs" disabled={!!busy || st?.state !== "down"} title={st?.state !== "down" ? "сначала отключи VPN" : "заменить конфиг"} onClick={() => fileRef.current?.click()} data-testid="vpn-replace">заменить</Button>
          <Button size="xs" variant="ghost" className="hover:text-err" disabled={!!busy} data-testid="vpn-delete-config"
            onClick={async () => { if (await confirm({ title: "Удалить конфиг VPN?", message: <>«{info.config!.name}» будет удалён из задачи{st?.state !== "down" ? ", туннель отключится" : ""}.</>, confirmText: "удалить", danger: true })) void act("delete", () => api.deleteVpnConfig(task.id), "конфиг VPN удалён"); }}>
            <Trash2 size={12} /> удалить</Button>
        </div>
      ) : (
        <div
          role="button" tabIndex={0} aria-busy={busy === "upload"} data-testid="vpn-drop"
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]); }}
          className={cx("mb-4 block cursor-pointer rounded-[14px] border-[1.5px] border-dashed px-5 py-6 text-center transition outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40",
            over ? "border-accent bg-accent/10 text-accent shadow-glow" : "border-line-3 bg-surface-2 text-dim hover:border-accent/60 hover:text-fg-2")}
        >
          {busy === "upload" ? <span className="inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> импортирую…</span> : (
            <>
              <Upload size={20} className="mx-auto mb-2" />
              <div className="text-[12.5px]">перетащи .ovpn или .conf от HTB — или нажми и выбери файл</div>
              <div className="mt-1 text-[11px]">конфиг хранится в задаче (права 0600) и переживает пересоздание контейнера</div>
            </>
          )}
        </div>
      )}
      {info?.config?.proto === "tcp" && (
        <div className="mb-4 rounded-[10px] border border-warn/35 bg-warn/[0.07] px-3 py-2.5 text-[12px] leading-relaxed text-dim" data-testid="vpn-proto-warn">
          <span className="text-warn">Конфиг на TCP:</span> веб через туннель (браузер/Burp по SOCKS) может тормозить и виснуть под параллельной нагрузкой. Для HTB скачай в Access конфиг <b className="text-fg-2">UDP</b> и замени этот кнопкой «заменить» — разница обычно огромная.
        </div>
      )}
      <input ref={fileRef} type="file" hidden data-testid="vpn-input" accept=".ovpn,.conf"
        onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />

      <SectionTitle><Network size={13} className="text-accent" /> браузер и Burp на хосте</SectionTitle>
      <div className="mb-4 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[12.5px]" data-testid="vpn-socks" data-running={st?.socks.running ? "1" : "0"}>
        <div className="flex flex-wrap items-center gap-2.5">
          <Dot state={st?.socks.running ? "ok" : "off"} />
          <span className="flex-1 text-fg-2">SOCKS5 через контейнер{st?.socks.url ? <>: <code className="text-accent" data-testid="vpn-socks-url">{st.socks.url}</code></> : ""}</span>
          {st?.socks.url && (
            <Button variant="ghost" size="icon-sm" title="скопировать адрес SOCKS" aria-label="скопировать адрес SOCKS" onClick={() => copy("socks", st.socks.url!)} data-testid="vpn-copy-socks">
              {copied === "socks" ? <Check size={13} /> : <Copy size={13} />}
            </Button>
          )}
          {st?.socks.running
            ? <Button size="xs" disabled={!!busy} onClick={() => void act("socks-stop", () => api.vpnAction(task.id, "socks-stop"))} data-testid="vpn-socks-stop">выключить</Button>
            : <Button size="xs" variant="primary" disabled={!!busy} onClick={() => void act("socks-start", () => api.vpnAction(task.id, "socks-start"))} data-testid="vpn-socks-start">
                {busy === "socks-start" && <Loader2 size={12} className="animate-spin" />} включить</Button>}
        </div>
        <div className="mt-1.5 text-[11.5px] leading-relaxed text-dim">Впиши адрес в FoxyProxy или в Burp (upstream SOCKS) — веб-интерфейсы машин откроются в браузере хоста через VPN контейнера. Прокси слушает только адрес моста песочниц: от целей из VPN он не виден.</div>
      </div>

      {!!st?.log.length && (
        <details key={st.state} open={st.state !== "up"} className="group mb-2" data-testid="vpn-log-wrap">
          <summary className="cursor-pointer text-[11px] tracking-[0.12em] text-fg-2 uppercase">лог подключения</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-[10px] border border-line bg-term px-3 py-2.5 text-[11.5px] break-words whitespace-pre-wrap text-fg-2" data-testid="vpn-log">{st.log.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

// ---------- создание / редактирование задачи ----------
export function TaskDialog({ task, open, onClose, onSave, onDelete }: {
  task: Task | null; open: boolean; onClose: () => void;
  onSave: (t: { title: string; course: string; brief: string; target: string; hostname: string }) => Promise<void>; onDelete?: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [title, setTitle] = useState("");
  const [course, setCourse] = useState("");
  const [brief, setBrief] = useState("");
  const [target, setTarget] = useState("");
  const [hostname, setHostname] = useState("");
  const [saving, setSaving] = useState(false);
  // создаём задачу: окно, закрытое этим сохранением, не возвращает фокус на «новая задача» — его заберёт
  // поле ввода первого чата новой задачи. Флаг ставится в начале сохранения и снимается, только когда
  // сохранение закончилось, а окно всё ещё открыто (App поймал ошибку и показал её) — или при следующем
  // открытии. Так он не зависит от того, успел ли React закрыть окно до возврата из onSave.
  const creating = useRef(false);
  // поля заполняются при открытии (или если окно переключили на другую задачу), а не при каждом
  // перечитывании списка задач — иначе фоновое обновление стирает несохранённую правку
  useEffect(() => {
    if (open) { setTitle(task?.title ?? ""); setCourse(task?.course ?? ""); setBrief(task?.brief ?? ""); setTarget(task?.target ?? ""); setHostname(task?.hostname ?? ""); setSaving(false); creating.current = false; }
  }, [open, task?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (open && !saving) creating.current = false; }, [open, saving]);
  const save = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    creating.current = !task;
    try { await onSave({ title: title.trim(), course: course.trim(), brief, target: target.trim(), hostname: hostname.trim().toLowerCase() }); } finally { setSaving(false); }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      testid="task-dialog"
      className="max-w-2xl"
      returnFocus={() => !creating.current}
      icon={<span className="flex size-8 items-center justify-center rounded-lg bg-accent/10 text-accent"><ListTodo size={16} /></span>}
      title={task ? "Задача" : "Новая задача"}
      footer={<>
        {task && onDelete && (
          <Button variant="danger" className="mr-auto" data-testid="task-delete"
            onClick={async () => {
              const ok = await confirm({
                title: "Удалить задачу?",
                message: <>Будут удалены: чаты, память задачи, вложения и Kali-контейнер <span className="text-fg">«{task.title}»</span> вместе с файлами в /work. Это нельзя отменить.</>,
                confirmText: "удалить навсегда", danger: true,
              });
              if (ok) await onDelete();
            }}>
            <Trash2 size={13} /> удалить
          </Button>
        )}
        <Button onClick={onClose} data-testid="task-cancel">отмена</Button>
        <Button variant="solid" disabled={!title.trim() || saving} onClick={() => void save()} data-testid="task-save">
          {saving && <Loader2 size={13} className="animate-spin" />}{task ? "сохранить" : "создать"}
        </Button>
      </>}
    >
      <div className="space-y-4" onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save(); }}>
        <div className="grid grid-cols-[1fr_200px] gap-3">
          <Field label="название">
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Лаба 3 — VLAN и маршрутизация" data-testid="task-title"
              onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
          </Field>
          <Field label="курс / предмет">
            <Input value={course} onChange={(e) => setCourse(e.target.value)} placeholder="Сети" data-testid="task-course" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="цель (IP)" hint="$TARGET в контейнере; HTB синкает сам">
            <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="10.129.x.x" data-testid="task-target" />
          </Field>
          <Field label="hostname цели" hint="/etc/hosts контейнера + machine.htb">
            <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="machine.htb" data-testid="task-hostname" />
          </Field>
        </div>
        <Field label="условие / цель" hint="всегда в контексте агента — вставь условие, исходные данные, требования к отчёту">
          <Textarea rows={6} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Настроить…" data-testid="task-brief" className="max-h-[55vh]" />
        </Field>
        {!task && (
          <div className="flex items-start gap-2 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[11.5px] leading-relaxed text-dim">
            <Brain size={14} className="mt-0.5 flex-none text-accent" />
            для задачи создастся свой Kali-контейнер (root, интернет, NET_ADMIN), своя память и первый чат
          </div>
        )}
      </div>
    </Modal>
  );
}
