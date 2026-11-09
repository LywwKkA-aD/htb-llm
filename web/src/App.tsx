import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Brain, Briefcase, Crosshair, FolderOpen, Globe, Library, ListTodo, Loader2, Network, Play, Plus, RotateCcw, Search, Square, SquareTerminal, BookOpen, ShieldCheck, Wifi } from "lucide-react";
import { api, isGone, sleep, type Chat, type Health, type Task, type VpnInfo } from "./api";
import { Sidebar } from "./components/Sidebar";
import { ChatView, type TurnStats } from "./components/Chat";
import { Terminals } from "./components/Terminals";
import { BrowserPanel, LibraryPanel, MemoryPanel, ProxyPanel, TaskDialog, VpnPanel } from "./components/Panels";
import { JobsPanel } from "./components/Jobs";
import { FilesPanel } from "./components/Files";
import { PlanPanel } from "./components/Plan";
import { ProfilePanel } from "./components/Profile";
import { StatusBar } from "./components/StatusBar";
import { Badge, BrandMark, Button, ConfirmProvider, Dot, Panel, Seg, ToastProvider, cx, useConfirm, useToast } from "./ui";

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
type Tab = "term" | "mem" | "lib" | "jobs" | "files" | "plan" | "target" | "vpn" | "browser" | "proxy";

export function Root() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  );
}

// Ширины колонок раскладки: сайдбар (flush-рейка как в HTB Labs), минимум чата, «удобный» минимум
// правой панели (шапка с вкладками и кнопками контейнера целиком) и жёсткий минимум, ниже которого
// панель не ужимается — тогда раскладка получает min-width и прокручивается по горизонтали
// (окна уже ~1180px), а не сминает терминалы в 170px. GAPS — поля контента: p-4 по краям + gap-4.
const SIDEBAR_W = 272, CHAT_MIN = 480, RIGHT_MIN = 500, RIGHT_HARD_MIN = 380, GAPS = 48;
const LAYOUT_MIN_W = SIDEBAR_W + CHAT_MIN + RIGHT_HARD_MIN + GAPS;

function App() {
  const toast = useToast();
  const confirm = useConfirm();
  const [health, setHealth] = useState<Health | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsFor, setChatsFor] = useState<string | null>(null); // задача, которой принадлежит список chats
  const [taskId, setTaskId] = useState<string | null>(ls.get("wh.task"));
  const [chatId, setChatId] = useState<string | null>(ls.get("wh.chat"));
  const [tab, setTab] = useState<Tab>((ls.get("wh.tab") as Tab) || "term");
  const [dialog, setDialog] = useState<"new" | "edit" | null>(null);
  const [memVersion, setMemVersion] = useState(0);
  const [vpnIp, setVpnIp] = useState<string | null>(null); // адрес туннеля открытой задачи (статус-бар и точка у вкладки)
  const [stats, setStats] = useState<TurnStats | null>(null);
  const [rightW, setRightW] = useState(() => Number(ls.get("wh.rightW")) || 44);
  const [dragging, setDragging] = useState(false);
  const [taskQuery, setTaskQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const rightWRef = useRef(rightW);

  // Выбранная задача — в ref: ответы, пришедшие после переключения (список чатов, конец хода в старой задаче),
  // не должны подменять данные открытой задачи. Ref меняется сразу при выборе, до перерисовки.
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  const selectTask = useCallback((id: string | null) => { taskIdRef.current = id; setTaskId(id); }, []);
  // что уже видели (чтобы отличить «удалено в другой вкладке» от устаревшего id в localStorage) и что удалили сами
  const seenTasks = useRef(new Set<string>());
  const seenChats = useRef(new Map<string, string>()); // chat id → task id
  const ownDeleted = useRef(new Set<string>());
  const created = useRef<string | null>(null); // только что созданная задача: её ещё нет в списке, но выбор не сбрасывать
  // черновик из удалённого в другой вкладке чата (ход не начался): переносится в следующий выбранный чат задачи
  const pendingDraft = useRef<{ task: string; text: string; images: string[] } | null>(null);
  // ответы приходят не по порядку: применяется только самый свежий запрос
  const tasksSeq = useRef({ sent: 0, applied: 0 });
  const chatsSeq = useRef({ sent: 0, applied: 0 });

  const loadTasks = useCallback(async (quiet = false) => {
    const n = ++tasksSeq.current.sent;
    try {
      const t = await api.tasks();
      if (n < tasksSeq.current.applied) return null;
      tasksSeq.current.applied = n;
      t.forEach((x) => seenTasks.current.add(x.id));
      setTasks(t);
      setTasksLoaded(true);
      return t;
    } catch (e: any) {
      if (!quiet) toast("error", e.message);
      throw e;
    }
  }, [toast]);
  const loadChats = useCallback(async (tid: string) => {
    const n = ++chatsSeq.current.sent;
    const c = await api.chats(tid);
    if (taskIdRef.current === tid && n >= chatsSeq.current.applied) {
      chatsSeq.current.applied = n;
      c.forEach((x) => seenChats.current.set(x.id, x.task_id));
      setChats(c);
      setChatsFor(tid);
    }
    return c;
  }, []);
  // перечитать список чатов открытой задачи; «задача удалена» здесь молчит — её покажет перечитанный список задач
  // quiet — фоновый опрос (раз в 3 с): молчит при сбое, чтобы при недоступном сервере не сыпать уведомлениями
  const reloadChats = useCallback((quiet = false) => {
    const tid = taskIdRef.current;
    if (tid) loadChats(tid).catch((e) => { if (!quiet && !isGone(e) && taskIdRef.current === tid) toast("error", e.message); });
  }, [loadChats, toast]);

  useEffect(() => {
    const tick = () => api.health().then(setHealth).catch(() => setHealth({ llm: false, embed: false, web: false, docker: false, image: false, model: "?", ctxWindow: 65536 }));
    tick();
    const t = setInterval(tick, 8000);
    return () => clearInterval(t);
  }, []);
  // первая загрузка задач: при сетевом сбое (ERR_NETWORK_CHANGED, сервер перезапускается) пробуем ещё, а не
  // оставляем пустой экран
  useEffect(() => {
    let stop = false;
    (async () => {
      for (let i = 0; !stop; i++) {
        try { await loadTasks(i > 0); return; } catch { await sleep(Math.min(10_000, 1500 * 2 ** i)); }
      }
    })();
    return () => { stop = true; };
  }, [loadTasks]);
  // смена задачи: список чатов сразу считается чужим (chatsFor), чат выбирается, когда придёт список этой задачи;
  // сетевой сбой — пробовать дальше, пока задача выбрана (иначе вечный индикатор загрузки)
  useEffect(() => {
    if (!taskId) return;
    ls.set("wh.task", taskId);
    const tid = taskId;
    let stop = false;
    (async () => {
      for (let i = 0; !stop && taskIdRef.current === tid; i++) {
        try { await loadChats(tid); return; } catch (e: any) {
          if (stop || taskIdRef.current !== tid) return;
          if (isGone(e)) { void loadTasks(true).catch(() => {}); return; } // задачи нет — список задач выберет другую
          if (i === 2) toast("error", e.message);
          await sleep(Math.min(10_000, 1000 * 2 ** i));
        }
      }
    })();
    return () => { stop = true; };
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Адрес VPN открытой задачи для статус-бара: редкий опрос (панель VPN опрашивает чаще и обновляет через onVpn).
  // GET на сервере дёргает статус внутри контейнера только если он запущен.
  const onVpn = useCallback((v: VpnInfo) => setVpnIp(v.status.state === "up" ? (v.status.ip ?? null) : null), []);
  useEffect(() => {
    setVpnIp(null);
    if (!taskId) return;
    const tid = taskId;
    let stop = false;
    const tick = () => api.vpn(tid).then((v) => { if (!stop && taskIdRef.current === tid) onVpn(v); }).catch(() => {});
    tick();
    const t = setInterval(tick, 15_000);
    return () => { stop = true; clearInterval(t); };
  }, [taskId, onVpn]);
  useEffect(() => { if (chatId) ls.set("wh.chat", chatId); }, [chatId]);
  useEffect(() => { ls.set("wh.tab", tab); }, [tab]);
  // выбранная задача пропала (удалена здесь или в другой вкладке, устаревший id в localStorage) — выбрать другую
  useEffect(() => {
    if (!tasksLoaded || (taskId && tasks.some((t) => t.id === taskId))) return;
    if (taskId && taskId === created.current && !seenTasks.current.has(taskId)) return; // список запрошен до создания
    if (taskId && seenTasks.current.has(taskId) && !ownDeleted.current.has(taskId)) toast("info", "задача удалена в другой вкладке");
    if (tasks.length) selectTask(tasks[0].id);
    else if (taskId) selectTask(null);
  }, [tasks, tasksLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const searchable = tasks.length > 4;
  useEffect(() => { if (!searchable) setTaskQuery(""); }, [searchable]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "/") { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const task = tasks.find((t) => t.id === taskId) ?? null;
  // чат всегда из списка ЭТОЙ задачи: пока список новой задачи не пришёл, чата прежней задачи под её заголовком нет
  const taskChats = useMemo(() => (taskId && chatsFor === taskId ? chats.filter((c) => c.task_id === taskId) : []), [chats, chatsFor, taskId]);
  const chatsReady = !!taskId && chatsFor === taskId;
  const chat = taskChats.find((c) => c.id === chatId) ?? null;

  // выбранного чата нет в списке задачи (переключили задачу, чат удалён здесь или в другой вкладке) — первый из списка
  useEffect(() => {
    if (!chatsReady || (chatId && taskChats.some((c) => c.id === chatId))) return;
    if (chatId && seenChats.current.get(chatId) === taskId && !ownDeleted.current.has(chatId)) toast("info", "чат удалён в другой вкладке");
    setChatId(taskChats[0]?.id ?? null);
  }, [taskChats, chatsReady, chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => {
    void loadTasks().catch(() => {});
    reloadChats();
    setMemVersion((v) => v + 1);
  }, [loadTasks, reloadChats]);

  // Индикатор «отвечает» в сайдбаре: пока какой-то чат задачи занят, список перечитывается раз в 3 с
  // (ход мог начаться в другой вкладке или закончиться в чате, из которого ушли). Когда ходы закончились —
  // полное обновление: счётчики памяти и предложения могли измениться.
  const anyBusy = taskChats.some((c) => c.busy);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !anyBusy) { void loadTasks().catch(() => {}); setMemVersion((v) => v + 1); }
    wasBusy.current = anyBusy;
    if (!anyBusy) return;
    const t = setInterval(() => reloadChats(true), 3000);
    return () => clearInterval(t);
  }, [anyBusy, loadTasks, reloadChats]);

  // Сверка с сервером после изменений в другой вкладке: сначала задачи (пропала открытая — эффект выше выберет
  // другую и скажет об этом), потом чаты открытой задачи и память.
  const resync = useCallback(async () => {
    const t = await loadTasks().catch(() => null);
    if (t && !t.some((x) => x.id === taskIdRef.current)) return;
    reloadChats();
    setMemVersion((v) => v + 1);
  }, [loadTasks, reloadChats]);
  // вернулись во вкладку — сверить (задачу, чат, карточки памяти могли изменить в другой вкладке)
  useEffect(() => {
    let last = Date.now();
    const on = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 2000) return;
      last = Date.now();
      void resync();
    };
    window.addEventListener("focus", on);
    document.addEventListener("visibilitychange", on);
    return () => { window.removeEventListener("focus", on); document.removeEventListener("visibilitychange", on); };
  }, [resync]);

  // Файл, брошенный мимо зоны загрузки, браузер открыл бы вместо приложения — черновик и поток пропали бы.
  // Зоны (поле ввода, библиотека) сами вызывают preventDefault; здесь — всё остальное.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const over = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "none";
    };
    const drop = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
  }, []);

  // перетаскиваемый разделитель чат | правая панель
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      // процент треков сетки считается от её content-box: окно минус flush-рейка сайдбара и поля p-4
      const gridW = window.innerWidth - SIDEBAR_W - 32;
      const w = Math.min(70, Math.max(24, ((window.innerWidth - e.clientX - 16) / gridW) * 100));
      rightWRef.current = w;
      setRightW(w);
    };
    const up = () => { setDragging(false); ls.set("wh.rightW", String(Math.round(rightWRef.current))); };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
    };
  }, [dragging]);

  const newChat = async () => {
    const tid = taskIdRef.current;
    if (!tid) return;
    try {
      const c = await api.newChat(tid);
      await loadChats(tid);
      if (taskIdRef.current === tid) setChatId(c.id); // пока ждали, пользователь мог уйти в другую задачу
    } catch (e: any) { toast("error", e.message); }
  };
  const selectChat = (id: string) => { setChatId(id); reloadChats(); };
  // открытый чат или его задачу удалили в другой вкладке (сервер ответил 404) — перечитать и выбрать другое;
  // draft — набранное в удалённом чате, чтобы перенести его в следующий выбранный чат задачи
  const onGone = useCallback((draft?: { text: string; images: string[] }) => {
    const tid = taskIdRef.current;
    if (draft && tid) pendingDraft.current = { task: tid, text: draft.text, images: draft.images };
    void resync();
  }, [resync]);
  const containerAct = async (a: "start" | "stop" | "reset") => {
    if (!task) return;
    if (a === "reset" && !(await confirm({
      title: "Пересоздать контейнер?",
      message: <>Kali-контейнер задачи будет создан заново. <span className="text-fg">Файлы в /work сохранятся</span>, а установленные пакеты, правила iptables и настройки сети — нет.</>,
      confirmText: "пересоздать", danger: true,
    }))) return;
    try {
      await api.container(task.id, a);
      toast("success", a === "start" ? "контейнер запущен" : a === "stop" ? "контейнер остановлен" : "контейнер пересоздан");
    } catch (e: any) { toast("error", e.message); }
    void loadTasks().catch(() => {});
  };

  // правая колонка: доля из разделителя, но не уже RIGHT_MIN (шапка помещается) и не шире, чем оставляет чат
  const rightCol = `max(${RIGHT_HARD_MIN}px, min(max(${rightW}%, ${RIGHT_MIN}px), calc(100vw - ${SIDEBAR_W + CHAT_MIN + GAPS}px)))`;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-16 flex-none items-center border-b border-line bg-bg" data-testid="app-header">
        <div className="flex h-full w-[272px] flex-none items-center gap-2.5 border-r border-line px-4">
          <BrandMark size={31} />
          <div className="min-w-0 leading-none">
            <div className="text-[17px] font-bold tracking-[0.08em] whitespace-nowrap text-fg">HTB <span className="text-accent">LLM</span></div>
            <div className="mt-1 text-[8.5px] font-bold tracking-[0.22em] text-dim">UNOFFICIAL</div>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-3 px-4">
          {searchable ? (
            <label className="relative block w-[340px] max-w-[42vw] flex-none">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dim" />
              <input
                ref={searchRef}
                value={taskQuery}
                onChange={(e) => setTaskQuery(e.target.value)}
                placeholder="Поиск задач"
                data-testid="task-search"
                className="h-10 w-full rounded border border-transparent bg-surface-2 pr-16 pl-9 text-[12.5px] text-fg outline-none transition placeholder:text-dim focus:border-fg"
              />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[10.5px] text-faint">Ctrl + /</span>
            </label>
          ) : (
            <div className="hidden min-w-0 truncate text-[12.5px] text-dim md:block">Лабораторный LLM-ассистент для HackTheBox и HTB Academy</div>
          )}
          <span className="flex-1" />
          <span className="hidden max-w-72 min-w-0 truncate text-[11.5px] text-dim xl:block" title={health?.model}>{health?.model ?? ""}</span>
          <span
            className={cx("inline-flex h-9 flex-none items-center gap-1.5 rounded px-3.5 text-[12px] font-bold", task && vpnIp ? "bg-accent text-accent-ink" : "bg-surface-2 text-dim")}
            data-testid="header-connection"
            title={task && vpnIp ? `HTB VPN подключён: ${vpnIp}` : "HTB VPN не подключён"}
          >
            <Wifi size={13} /> {task && vpnIp ? "Connected" : "VPN off"}
          </span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 max-[1180px]:overflow-x-auto max-[1180px]:overflow-y-hidden" data-testid="layout-scroll">
      <div className="flex min-h-0 flex-1" style={{ minWidth: task ? LAYOUT_MIN_W : undefined }} data-testid="layout">
        <Sidebar
          health={health} tasks={tasks} chats={taskChats} taskId={taskId} chatId={chatId} taskQuery={searchable ? taskQuery : ""}
          onTask={selectTask} onChat={selectChat} onNewTask={() => setDialog("new")} onNewChat={() => void newChat()}
          onImportedTask={(tid, cid) => { void refresh(); selectTask(tid); setChatId(cid); }}
          onDeleteChat={async (id) => {
            const tid = taskIdRef.current;
            ownDeleted.current.add(id);
            try { await api.deleteChat(id); toast("success", "чат удалён"); } catch (e: any) { if (!isGone(e)) toast("error", e.message); }
            if (tid && taskIdRef.current === tid) await loadChats(tid).catch(() => {}); // выбор следующего чата — эффект выше
          }}
        />

      <div
        className="grid min-h-0 flex-1 gap-4 p-4"
        style={{ gridTemplateColumns: task ? `minmax(${CHAT_MIN}px,1fr) ${rightCol}` : "minmax(0,1fr)" }}
      >
        <Panel className="relative" data-testid="main-panel">
          {task && chat ? (
            <ChatView key={`${task.id}:${chat.id}`} task={task} chat={chat} ctxWindow={health?.ctxWindow ?? 65536} compactAt={health?.compactAt} reasoning={health?.reasoning ?? null} memVersion={memVersion}
              onChanged={refresh} onGone={onGone} onEditTask={() => setDialog("edit")} onStats={setStats}
              takeDraft={() => { const d = pendingDraft.current; pendingDraft.current = null; return d && d.task === task.id ? { text: d.text, images: d.images } : null; }} />
          ) : task && !chatsReady ? (
            <div className="flex h-full items-center justify-center text-dim" data-testid="chats-loading">
              <Loader2 size={18} className="animate-spin" aria-label="загрузка чатов" />
            </div>
          ) : task ? (
            <div className="flex h-full items-center justify-center">
              <Button variant="solid" onClick={() => void newChat()} data-testid="empty-new-chat"><Plus size={14} /> новый чат</Button>
            </div>
          ) : tasksLoaded ? (
            <Welcome onCreate={() => setDialog("new")} />
          ) : null}
        </Panel>

        {task && (
          <Panel className="relative flex flex-col overflow-visible" data-testid="right-panel">
            <div
              role="separator"
              aria-orientation="vertical"
              data-testid="splitter"
              onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
              className="group absolute top-0 bottom-0 -left-[13px] z-10 flex w-2.5 cursor-col-resize justify-center"
            >
              <span className={cx("my-auto h-1/3 w-0.5 rounded-full transition-all", dragging ? "h-4/5 bg-accent shadow-glow" : "bg-line-2 group-hover:h-4/5 group-hover:bg-accent/70")} />
            </div>
            {/* @container: в узкой панели у вкладок остаются только иконки (подпись — во всплывающей подсказке),
                кнопки контейнера не сжимаются и не уезжают под overflow */}
            <div className="@container flex h-14 flex-none items-center gap-3 overflow-hidden rounded-t-lg border-b border-line px-2" data-testid="right-header">
              <Seg<Tab>
                testid="tab"
                size="sm"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "term", title: "терминал", label: <><SquareTerminal size={13} className="flex-none" /> <span className="sr-only @[720px]:not-sr-only">терминал</span></> },
                  { value: "mem", title: "память задачи", label: <><Brain size={13} className="flex-none" /> <span className="sr-only @[720px]:not-sr-only">память</span> {task.pending ? <Badge>{task.pending}</Badge> : <span className="sr-only text-[11px] opacity-60 @[720px]:not-sr-only">{task.memories ?? 0}</span>}</> },
                  { value: "lib", title: "библиотека", label: <><Library size={13} className="flex-none" /> <span className="sr-only @[720px]:not-sr-only">библиотека</span></> },
                  { value: "jobs", title: "фоновые сессии (listener, http-сервер)", label: <><Briefcase size={13} className="flex-none" /> <span className="sr-only @[720px]:not-sr-only">jobs</span></> },
                  { value: "files", title: "файлы задачи в /work", label: <><FolderOpen size={13} className="flex-none" /> <span className="sr-only @[720px]:not-sr-only">файлы</span></> },
                  { value: "plan", title: "план решения задачи по фазам", label: <><ListTodo size={13} className="flex-none" /> <span className="sr-only @[720px]:not-sr-only">план</span> {!!task.plan_total && <span className="sr-only text-[11px] opacity-60 @[720px]:not-sr-only" data-testid="tab-plan-progress">{task.plan_done ?? 0}/{task.plan_total}</span>}</> },
                  { value: "target", title: "профиль цели: сервисы, креды, доступы", label: <><Crosshair size={13} className="flex-none" /> <span className="sr-only @[720px]:not-sr-only">цель</span> {!!task.profile_total && <span className="sr-only text-[11px] opacity-60 @[720px]:not-sr-only" data-testid="tab-profile-count">{task.profile_total}</span>}</> },
                  { value: "vpn", title: vpnIp ? `VPN: ${vpnIp}` : "VPN в контейнере (HTB)", label: <><Network size={13} className="flex-none" /> <span className="sr-only @[720px]:not-sr-only">vpn</span>{vpnIp && <Dot state="ok" testid="tab-vpn-dot" />}</> },
                  { value: "browser", title: "Firefox в контейнере задачи (веб цели через VPN)", label: <><Globe size={13} className="flex-none" /> <span className="sr-only @[720px]:not-sr-only">браузер</span></> },
                  { value: "proxy", title: "Caido: перехватывающий прокси и анализ трафика", label: <><ArrowLeftRight size={13} className="flex-none" /> <span className="sr-only @[720px]:not-sr-only">прокси</span></> },
                ]}
              />
              <span className="flex-1" />
              <div className="flex flex-none items-center gap-1.5" data-testid="container-status" data-state={task.container}>
                <Dot state={task.container === "running" ? "ok" : task.container === "stopped" ? "mid" : "off"} title={`контейнер: ${task.container}`} />
                <span className="hidden text-[11px] text-dim @[520px]:inline">kali</span>
                {task.container === "running"
                  ? <Button variant="ghost" size="icon-sm" title="остановить контейнер" onClick={() => void containerAct("stop")} data-testid="container-stop"><Square size={12} /></Button>
                  : <Button variant="ghost" size="icon-sm" title="запустить контейнер" onClick={() => void containerAct("start")} data-testid="container-start"><Play size={13} /></Button>}
                <Button variant="ghost" size="icon-sm" title="пересоздать контейнер (файлы /work сохранятся)" onClick={() => void containerAct("reset")} data-testid="container-reset"><RotateCcw size={13} /></Button>
              </div>
            </div>
            <div className={cx("min-h-0 flex-1 rounded-b-lg", tab === "term" || tab === "browser" || tab === "proxy" ? "overflow-hidden" : "overflow-y-auto")} data-testid={`tabbody-${tab}`}>
              {tab === "term" && <Terminals key={task.id} taskId={task.id} />}
              {tab === "mem" && <MemoryPanel task={task} version={memVersion} onChanged={refresh} />}
              {tab === "lib" && <LibraryPanel task={task} />}
              {tab === "jobs" && <JobsPanel key={task.id} task={task} />}
              {tab === "files" && <FilesPanel key={task.id} task={task} />}
              {tab === "plan" && <PlanPanel key={task.id} task={task} onChanged={() => void loadTasks(true).catch(() => {})} />}
              {tab === "target" && <ProfilePanel key={task.id} task={task} onChanged={() => void loadTasks(true).catch(() => {})} />}
              {tab === "vpn" && <VpnPanel task={task} onChanged={onVpn} />}
              {tab === "browser" && <BrowserPanel key={task.id} task={task} />}
              {tab === "proxy" && <ProxyPanel key={task.id} task={task} />}
            </div>
          </Panel>
        )}
      </div>
      </div>
      </div>

      <StatusBar health={health} task={task} stats={task && chat ? stats : null} ctxWindow={health?.ctxWindow ?? 65536} vpnIp={task ? vpnIp : null} />

      <TaskDialog
        open={dialog !== null}
        task={dialog === "edit" ? task : null}
        onClose={() => setDialog(null)}
        onSave={async (t) => {
          try {
            if (dialog === "edit" && task) { await api.updateTask(task.id, t); toast("success", "задача сохранена"); }
            else { const r = await api.createTask(t); created.current = r.task.id; selectTask(r.task.id); setChatId(r.chat.id); toast("success", "задача создана — поднимаю Kali-контейнер"); }
            setDialog(null);
            await loadTasks().catch(() => {});
            if (dialog === "new") setTimeout(() => void loadTasks().catch(() => {}), 2500); // статус контейнера
          } catch (e: any) { toast("error", e.message); }
        }}
        onDelete={dialog === "edit" && task ? async () => {
          setDialog(null);
          ownDeleted.current.add(task.id);
          try { await api.deleteTask(task.id); toast("success", "задача удалена"); } catch (e: any) { if (!isGone(e)) toast("error", e.message); }
          selectTask(null); setChatId(null); setChats([]); setChatsFor(null);
          await loadTasks().catch(() => {});
        } : undefined}
      />
    </div>
  );
}

function Welcome({ onCreate }: { onCreate: () => void }) {
  const feats = [
    { icon: SquareTerminal, t: "Kali на каждую задачу", d: "Свой контейнер с root, интернетом и NET_ADMIN. Видно, как агент печатает команды, и рядом твой shell." },
    { icon: Brain, t: "Память с подтверждением", d: "Агент предлагает сохранить шаги и находки — новые чаты стартуют с чистым контекстом, но без потерь." },
    { icon: BookOpen, t: "Лекции и RFC", d: "Загрузи PDF и заметки — ответы опираются на материалы курса со ссылками на страницы." },
  ];
  return (
    <div className="flex h-full items-center justify-center p-8" data-testid="welcome">
      <div className="max-w-[760px] animate-fadein text-center">
        <div className="mb-5 flex justify-center"><BrandMark size={56} /></div>
        <h1 className="text-[20px] font-bold text-fg">HTB LLM <span className="text-[11px] font-medium tracking-[0.18em] text-dim">UNOFFICIAL</span></h1>
        <p className="mt-2 mb-8 text-[13px] text-dim">Локальный ассистент для HackTheBox и HTB Academy: Kali, терминалы, VPN, память и RAG. Ты управляешь — модель объясняет, проверяет и показывает на практике.</p>
        <div className="mb-8 grid grid-cols-1 gap-3 text-left md:grid-cols-3">
          {feats.map((f) => (
            <div key={f.t} className="rounded-lg border border-line bg-surface-2 p-4">
              <f.icon size={18} className="mb-2.5 text-accent" />
              <div className="mb-1 text-[13px] font-bold text-fg">{f.t}</div>
              <div className="text-[12px] leading-relaxed text-dim">{f.d}</div>
            </div>
          ))}
        </div>
        <Button variant="solid" size="md" className="h-10 px-5 text-[13px]" onClick={onCreate} data-testid="welcome-create"><Plus size={15} /> создать первую задачу</Button>
        <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-faint"><ShieldCheck size={12} /> только учебные и разрешённые цели</div>
      </div>
    </div>
  );
}
