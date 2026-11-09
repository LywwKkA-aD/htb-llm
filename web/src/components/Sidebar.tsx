import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brain, Crown, Flag, KeyRound, Loader2, MessageSquare, Play, Plus, RefreshCw, Search, Settings as SettingsIcon, Square, Terminal as TermIcon, Trash2, User } from "lucide-react";
import { api, type Chat, type Health, type HtbMachine, type HtbStatus, type Preset, type ServiceInfo, type Task } from "../api";
import { Badge, Button, Dot, Field, Input, Modal, cx, useConfirm, useToast } from "../ui";
import { SettingsDialog } from "./Settings";

// Вкл/выкл локальных моделей прямо из интерфейса (Qwen LLM и эмбеддинги): те же процессы, что bin/whitehat.
// Состояние опрашивается, пока панель открыта; переходные состояния (модель грузится в VRAM) видны сразу.
const SERVICE_STATE_RU = { running: "работает", starting: "запускается…", stopping: "останавливается…", stopped: "выключен", error: "ошибка" } as const;
function ServicesControl({ refreshKey = 0 }: { refreshKey?: number }) {
  const toast = useToast();
  const [services, setServices] = useState<ServiceInfo[] | null>(null);
  const [presets, setPresets] = useState<{ llm: Preset; embed: Preset }>({ llm: "local", embed: "local" });
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    const [svc, cfg] = await Promise.allSettled([api.services(), api.settings()]);
    if (!alive.current) return;
    if (svc.status === "fulfilled") setServices(svc.value);
    if (cfg.status === "fulfilled") setPresets({ llm: cfg.value.llm.active, embed: cfg.value.embed.active });
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    const t = setInterval(load, 3000);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, refreshKey]);
  const act = async (s: ServiceInfo) => {
    const action = s.state === "running" || s.state === "starting" ? "stop" : "start";
    setBusy(s.id);
    try {
      const upd = await api.serviceAction(s.id, action);
      if (alive.current) setServices((a) => (a ?? []).map((x) => (x.id === upd.id ? upd : x)));
      toast(action === "start" ? "info" : "success", action === "start" ? `${s.name}: запускаю (модель грузится в VRAM, это до пары минут)` : `${s.name}: останавливаю`);
    } catch (e: any) { toast("error", e.message); }
    setBusy(null);
    void load();
  };
  if (!services) return null;
  // Внешнему пресету локальный процесс не нужен и только шумит «выключен»: показываем сервис
  // только пока соответствующий активный пресет локальный (LLM и эмбеддинги независимо).
  const visible = services.filter((s) => (s.id === "llm" ? presets.llm : presets.embed) === "local");
  if (!visible.length) return null;
  return (
    <div className="mt-2.5 space-y-1" data-testid="services">
      {visible.map((s) => {
        const on = s.state === "running" || s.state === "starting";
        const moving = s.state === "starting" || s.state === "stopping" || busy === s.id;
        return (
          <div key={s.id}>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5" data-testid={`service-${s.id}`} data-state={s.state}>
              <Dot state={s.state === "running" ? "ok" : s.state === "error" ? "bad" : moving ? "mid" : "off"} />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-2" title={s.url}>{s.name}</span>
              <span className="flex-none text-[10.5px] text-dim">{SERVICE_STATE_RU[s.state]}</span>
              <Button variant={on ? "ghost" : "primary"} size="icon-sm" disabled={!s.managed || moving}
                title={!s.managed ? (s.detail ?? "не управляется из веба") : on ? `выключить: ${s.name}` : `включить: ${s.name}`}
                aria-label={on ? `выключить ${s.name}` : `включить ${s.name}`}
                onClick={() => void act(s)} data-testid={`service-toggle-${s.id}`}>
                {moving ? <Loader2 size={12} className="animate-spin" /> : on ? <Square size={11} /> : <Play size={12} />}
              </Button>
            </div>
            {s.state === "error" && s.detail && <div className="px-1 pt-1 text-[11px] leading-snug text-err" data-testid={`service-error-${s.id}`}>{s.detail}</div>}
          </div>
        );
      })}
    </div>
  );
}

// HackTheBox: профиль и прогресс аккаунта, активная машина и поиск — через личный App Token (бэкенд htb.ts).
// Цвета сложности как в app.hackthebox.com: easy — лайм, medium — жёлтый, hard/insane — красный.
const diffCls = (d: string) => (/insane|hard/i.test(d) ? "text-err" : /medium/i.test(d) ? "text-warn" : "text-accent");
function HtbBlock({ onImportedTask }: { onImportedTask?: (taskId: string, chatId: string) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [st, setSt] = useState<HtbStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dlg, setDlg] = useState(false);
  const [token, setToken] = useState("");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<HtbMachine[] | null>(null);
  const alive = useRef(true);
  const load = useCallback((refresh = false) => api.htbStatus(refresh).then((s) => { if (alive.current) setSt(s); }).catch(() => {}), []);
  useEffect(() => {
    alive.current = true;
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);
  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e: any) { toast("error", e.message); }
    setBusy(null);
  };
  const importMachine = (machineId?: number) => void act("import", async () => {
    const r = await api.htbImport(machineId);
    toast("success", r.existed ? `задача «${r.task.title}» уже есть — открываю` : `задача «${r.task.title}» создана, контейнер поднимается`);
    onImportedTask?.(r.task.id, r.chat.id);
  });
  const spawn = (m: HtbMachine) => void (async () => {
    if (st?.activeMachine && st.activeMachine.id !== m.id &&
      !(await confirm({ title: "Запустить другую машину?", message: <>Сейчас активна «{st.activeMachine.name}». HTB держит одну машину: запуск «{m.name}» остановит текущую.</>, confirmText: "запустить" }))) return;
    await act("spawn", async () => { setSt(await api.htbSpawn(m.id)); toast("info", `«${m.name}» запускается — IP появится через минуту, блок сам обновится`); });
  })();
  const u = st?.user;
  const pct = u?.rankProgress == null ? null : Math.max(0, Math.min(100, Math.round(u.rankProgress <= 1 ? u.rankProgress * 100 : u.rankProgress)));
  // новая система HTB Experience: прогресс уровня — XP внутри уровня / (внутри + до следующего)
  const xpSum = u && u.xpInLevel != null && u.xpUntilNext != null ? u.xpInLevel + u.xpUntilNext : null;
  const xpPct = u && xpSum ? Math.max(0, Math.min(100, Math.round((u.xpInLevel! / xpSum) * 100))) : null;
  return (
    <div className="flex-none border-t border-line px-3 py-3" data-testid="htb-block">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-5 flex-none items-center justify-center rounded-sm bg-accent font-mono text-[8.5px] font-bold text-accent-ink">HTB</span>
        <span className="flex-1 text-[12px] font-medium text-fg">HackTheBox</span>
        {st?.configured && (
          <Button variant="ghost" size="icon-sm" title="обновить с HTB" aria-label="обновить HTB" onClick={() => void load(true)} data-testid="htb-refresh">
            <RefreshCw size={12} />
          </Button>
        )}
      </div>

      {!st && <div className="flex items-center gap-2 text-[11.5px] text-dim"><Loader2 size={12} className="animate-spin" /> проверяю…</div>}
      {st && !st.configured && (
        <div>
          <div className="mb-2 text-[11.5px] leading-snug text-dim">Подключи аккаунт: здесь будут ранг, прогресс, активная машина и запуск машин сразу в задачи.</div>
          <Button size="sm" variant="solid" onClick={() => setDlg(true)} data-testid="htb-connect"><KeyRound size={12} /> подключить HTB</Button>
        </div>
      )}
      {st?.error && <div className="mb-2 text-[11.5px] leading-snug text-err" data-testid="htb-error">{st.error}</div>}

      {u && (
        <div data-testid="htb-profile">
          <div className="mb-1.5 flex items-center gap-2.5">
            {u.avatar
              ? <img src={u.avatar} alt="" className="size-9 flex-none rounded object-cover" referrerPolicy="no-referrer" />
              : <span className="flex size-9 flex-none items-center justify-center rounded bg-surface-3 text-[13px] font-bold text-accent">{u.name.slice(0, 1).toUpperCase()}</span>}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium text-fg" data-testid="htb-user-name">{u.name}</span>
                {(u.isDedicatedVip || u.isVip) && <span className="flex-none rounded-sm bg-warn/15 px-1 text-[9px] font-bold text-warn">{u.isDedicatedVip ? "VIP+" : "VIP"}</span>}
              </span>
              <span className="block text-[10.5px] tracking-wide text-accent uppercase" data-testid="htb-level">
                {u.level != null ? <>Lvl {u.level} · {u.levelTitle ?? ""}{u.levelGrade ? ` · Grade ${u.levelGrade}` : ""}</> : (u.rank || "—")}
                {u.ranking ? <span className="text-dim normal-case"> · #{u.ranking}</span> : null}
              </span>
            </span>
            {u.xpTotal != null
              ? <span className="flex-none text-[12px] text-fg-2">{u.xpTotal} <span className="text-[10px] text-dim">XP</span></span>
              : u.points != null && <span className="flex-none text-[12px] text-fg-2">{u.points} <span className="text-[10px] text-dim">pts</span></span>}
          </div>
          <div className="flex items-center gap-3 text-[11.5px] text-fg-2" data-testid="htb-owns">
            <span className="inline-flex items-center gap-1" title="user owns"><User size={11} className="text-accent" /> {u.userOwns}</span>
            <span className="inline-flex items-center gap-1" title="root (system) owns"><Crown size={11} className="text-err" /> {u.systemOwns}</span>
            {xpPct == null && pct != null && u.nextRank && <span className="flex-1 text-right text-[10.5px] text-dim">до {u.nextRank}: {pct}%</span>}
          </div>
          {xpPct != null && xpSum != null && u.level != null ? (
            <div className="mt-1.5" data-testid="htb-xp">
              <div className="mb-1 flex justify-between text-[10.5px] text-dim">
                <span className="font-mono">{u.xpInLevel}/{xpSum} XP</span><span>до Lvl {u.level + 1}: {xpPct}%</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={xpPct} aria-label={`прогресс уровня ${u.level}`}>
                <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${xpPct}%` }} />
              </div>
            </div>
          ) : pct != null && u.nextRank && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-label={`прогресс до ${u.nextRank}`}>
              <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}

      {st?.configured && (st.activeMachine ? (
        <div className="mt-2.5 rounded border border-accent/30 bg-accent/[0.05] px-2.5 py-2" data-testid="htb-active">
          <div className="flex items-center gap-2">
            <Dot state={st.activeMachine.isSpawning ? "mid" : "ok"} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">{st.activeMachine.name}</span>
            <span className={cx("flex-none text-[10.5px]", diffCls(st.activeMachine.difficultyText))}>{st.activeMachine.difficultyText}</span>
            <span className="flex-none text-[10.5px] text-dim">{st.activeMachine.os}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            {st.activeMachine.ip
              ? <Flag size={11} className="flex-none text-accent" />
              : <Loader2 size={11} className="flex-none animate-spin text-warn" />}
            <code className="flex-1 text-[12px] text-accent" data-testid="htb-active-ip">{st.activeMachine.ip ?? "стартует…"}</code>
            <Button size="xs" variant="solid" disabled={busy !== null} onClick={() => importMachine()} data-testid="htb-import-active">
              {busy === "import" ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} в задачу</Button>
            <Button size="xs" variant="ghost" disabled={busy !== null} title="остановить машину на HTB" aria-label="остановить машину HTB" data-testid="htb-stop"
              onClick={async () => { if (await confirm({ title: "Остановить машину?", message: <>«{st.activeMachine!.name}» будет выключена на HTB, несохранённый прогресс на ней пропадёт.</>, confirmText: "остановить", danger: true })) void act("stop", async () => setSt(await api.htbStop())); }}>
              <Square size={10} /></Button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5">
          <form className="relative" onSubmit={(e) => { e.preventDefault(); void act("search", async () => setFound(await api.htbMachines(q))); }}>
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-dim" />
            <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="поиск машин HTB" data-testid="htb-search"
              className="w-full rounded border border-transparent bg-surface-2 py-1.5 pr-2.5 pl-8 text-[12px] text-fg outline-none transition focus:border-fg"
              placeholder="машина HTB: имя + Enter" />
          </form>
          {busy === "search" && <div className="mt-1.5 flex items-center gap-2 text-[11px] text-dim"><Loader2 size={11} className="animate-spin" /> ищу…</div>}
          {found && !found.length && busy !== "search" && <div className="mt-1.5 text-[11px] text-dim">ничего не нашлось</div>}
          <div className="mt-1 max-h-44 space-y-0.5 overflow-y-auto">
            {found?.map((m) => (
              <div key={m.id} className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-surface-2" data-testid={`htb-machine-${m.id}`}>
                <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{m.name}</span>
                {(m.ownedUser || m.ownedRoot) && <span className="flex-none text-[9px] text-dim uppercase">{m.ownedRoot ? "root" : "user"}</span>}
                <span className={cx("flex-none text-[10px]", diffCls(m.difficultyText))}>{m.difficultyText}</span>
                <span className="flex-none text-[10px] text-dim">{m.os}</span>
                <Button variant="ghost" size="icon-sm" disabled={busy !== null} title={`запустить «${m.name}» на HTB`} aria-label={`запустить ${m.name}`} onClick={() => spawn(m)} data-testid={`htb-spawn-${m.id}`}>
                  <Play size={11} /></Button>
                <Button variant="ghost" size="icon-sm" disabled={busy !== null} title={`задача под «${m.name}»`} aria-label={`задача под ${m.name}`} onClick={() => importMachine(m.id)} data-testid={`htb-import-${m.id}`}>
                  <Plus size={11} /></Button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {st?.configured && (
        <button type="button" className="mt-2 text-[10.5px] text-faint transition hover:text-err" data-testid="htb-disconnect"
          onClick={async () => { if (await confirm({ title: "Отключить HTB?", message: "Токен будет удалён с этого компьютера. Задачи и контейнеры не пострадают.", confirmText: "отключить", danger: true })) void act("disconnect", async () => { setSt(await api.htbDeleteToken()); setFound(null); }); }}>
          отключить аккаунт HTB</button>
      )}

      {dlg && (
        <Modal open title="Подключить HackTheBox" onClose={() => setDlg(false)} testid="htb-dialog"
          footer={<>
            <Button onClick={() => setDlg(false)}>отмена</Button>
            <Button variant="solid" disabled={token.trim().length < 20 || busy !== null} data-testid="htb-token-save"
              onClick={() => void act("token", async () => { setSt(await api.htbSetToken(token)); setDlg(false); setToken(""); toast("success", "HTB подключён"); })}>
              {busy === "token" && <Loader2 size={13} className="animate-spin" />} подключить</Button>
          </>}>
          <div className="mb-3 text-[12.5px] leading-relaxed text-fg-2">
            Открой <span className="text-accent">app.hackthebox.com → account-settings → App Tokens → Create App Token</span>, скопируй токен сюда.
            Он хранится только на этом компьютере (файл с правами 0600) и уходит только в labs.hackthebox.com.
          </div>
          <Field label="App Token">
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus placeholder="eyJ…" data-testid="htb-token-input" />
          </Field>
        </Modal>
      )}
    </div>
  );
}

type Props = {
  health: Health | null;
  tasks: Task[];
  chats: Chat[];
  taskId: string | null;
  chatId: string | null;
  taskQuery?: string;
  onTask: (id: string) => void;
  onChat: (id: string) => void;
  onNewTask: () => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onImportedTask?: (taskId: string, chatId: string) => void;
};

export function Sidebar(p: Props) {
  const h = p.health;
  const confirm = useConfirm();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTick, setSettingsTick] = useState(0);
  // Поиск живёт в верхней полосе приложения; App очищает запрос, когда задач снова ≤4.
  const query = (p.taskQuery ?? "").trim().toLowerCase();
  const tasks = useMemo(
    () => (query ? p.tasks.filter((t) => `${t.title} ${t.course}`.toLowerCase().includes(query)) : p.tasks),
    [p.tasks, query],
  );
  const st = (v?: boolean) => (v === undefined ? "off" : v ? "ok" : "bad") as "ok" | "bad" | "off";

  return (
    // flush-рейка на всю высоту, как левая навигация HTB Labs: без карточки и внешних отступов
    <section className="flex min-h-0 w-[272px] flex-none flex-col border-r border-line bg-bg" data-testid="sidebar">
      {/* статус инфраструктуры; бренд и глобальный поиск живут в верхней HTB-полосе App */}
      <div className="px-4 pt-3 pb-3">
        <div className="flex flex-wrap gap-1.5">
          {([
            ["llm", h?.llm, `основная модель${h?.model ? `: ${h.model}` : ""} (пресет: ${h?.preset ?? "локальная"}; настраивается шестерёнкой внизу)`],
            ["emb", h?.embed, "эмбеддинги — поиск по материалам и памяти (настраиваются шестерёнкой внизу)"],
            ["docker", h ? h.docker && h.image : undefined, "Docker и образ Kali (htb-llm-kali)"],
          ] as const).map(([k, v, title]) => (
            <span key={k} title={title} className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-px text-[11px] text-fg-2">
              <Dot state={st(v)} testid={`health-${k}`} /> {k}
            </span>
          ))}
        </div>
        <ServicesControl refreshKey={settingsTick} />
        {h && !h.llm && (
          <div className="mt-3 rounded border border-warn/25 bg-warn/[0.07] px-3 py-2 text-[11.5px] leading-snug text-warn" data-testid="llm-down">
            {h.preset && h.preset !== "local"
              ? `модель недоступна — агент не ответит; проверь адрес и ключ пресета «${h.preset}» в настройках (шестерёнка внизу)`
              : "модель выключена — агент не ответит, пока не включишь Qwen кнопкой выше"}
          </div>
        )}
      </div>

      <div className="px-2 pb-2">
        <Button variant="primary" className="w-full justify-start" onClick={p.onNewTask} data-testid="new-task">
          <Plus size={14} /> новая задача
        </Button>
      </div>

      <div className="px-5 pt-1 pb-1.5 text-[10.5px] tracking-[0.14em] text-dim uppercase">задачи · {p.tasks.length}</div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-testid="task-list">
        {!p.tasks.length && <div className="px-3 py-2 text-[12px] text-dim">пока пусто — создай первую задачу</div>}
        {!!p.tasks.length && !tasks.length && <div className="px-3 py-2 text-[12px] text-dim" data-testid="task-search-empty">ничего не найдено</div>}
        {tasks.map((t) => {
          const sel = t.id === p.taskId;
          return (
            <div key={t.id} className="mb-0.5">
              <button
                data-testid="task-item"
                data-task-id={t.id}
                aria-current={sel}
                onClick={() => p.onTask(t.id)}
                className={cx(
                  "relative block w-full rounded-lg px-3 py-2 text-left transition-colors",
                  sel ? "bg-surface-2" : "hover:bg-surface-2",
                )}
              >
                <div className={cx("truncate text-[13px]", sel ? "font-medium text-fg" : "text-fg-2")} title={t.title}>{t.title}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-dim">
                  <Dot state={t.container === "running" ? "ok" : t.container === "stopped" ? "mid" : "off"} title={`контейнер: ${t.container}`} />
                  {t.course && <span className="truncate" title={t.course}>{t.course}</span>}
                  <span className="inline-flex items-center gap-1" title="подтверждённых карточек памяти"><Brain size={11} />{t.memories ?? 0}</span>
                  {!!t.pending && <Badge>{t.pending}</Badge>}
                </div>
              </button>
              {sel && (
                <div className="mt-1 mb-2 ml-[18px] border-l border-line-2 pl-2" data-testid="chat-list">
                  {p.chats.map((c) => (
                    // строка чата: выбор — отдельная кнопка (в порядке Tab), рядом кнопка удаления (вложенные кнопки недопустимы)
                    <div
                      key={c.id}
                      data-testid="chat-item"
                      data-chat-id={c.id}
                      aria-current={c.id === p.chatId}
                      className={cx(
                        "group flex items-center gap-2 rounded-lg pr-2.5 text-[12.5px] transition-colors",
                        c.id === p.chatId ? "bg-surface-3 text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => p.onChat(c.id)}
                        aria-current={c.id === p.chatId ? "page" : undefined}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        {c.busy ? <Loader2 size={12} className="flex-none animate-spin text-warn" /> : <MessageSquare size={12} className="flex-none opacity-70" />}
                        <span className="min-w-0 flex-1 truncate" title={c.title}>{c.title}</span>
                      </button>
                      <button
                        type="button"
                        title="удалить чат"
                        aria-label={`удалить чат «${c.title}»`}
                        data-testid="chat-delete"
                        className="flex-none rounded p-0.5 text-dim opacity-0 outline-none group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-err/10 hover:text-err focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/40"
                        onClick={async () => {
                          const ok = await confirm({
                            title: "Удалить чат?",
                            message: <>Чат «{c.title}» и его история будут удалены. <span className="text-fg">Память задачи останется.</span></>,
                            confirmText: "удалить", danger: true,
                          });
                          if (ok) p.onDeleteChat(c.id);
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={p.onNewChat}
                    data-testid="new-chat"
                    title="новый чат с чистым контекстом: условие и память задачи подтянутся сами"
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-dim transition-colors hover:bg-surface-2 hover:text-accent"
                  >
                    <Plus size={12} /> новый чат
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <HtbBlock onImportedTask={p.onImportedTask} />
      <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-[11px] text-dim">
        <TermIcon size={12} /> kali · NET_ADMIN · internet
        <span className="flex-1" />
        <Button variant="ghost" size="icon-sm" title="настройки моделей (LLM и эмбеддинги: локальная, OpenRouter, свой API)" aria-label="настройки моделей"
          onClick={() => setSettingsOpen(true)} data-testid="settings-open">
          <SettingsIcon size={13} />
        </Button>
      </div>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={() => setSettingsTick((v) => v + 1)} />
    </section>
  );
}
