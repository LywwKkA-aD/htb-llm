import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from "react";
import {
  ArrowDown, ArrowLeftRight, ArrowUp, BookOpen, Brain, Cable, Calculator, Check, ChevronRight, Copy, Crosshair, Database, FileText, FolderSearch, Globe, History, ImagePlus, Link2, ListTodo, Loader2,
  Pencil, Radar, Search, Square, SquareTerminal, X,
} from "lucide-react";
import { api, streamTurn, fmtK, isGone, sleep, NotSentError, type AgentMode, type Chat as TChat, type Effort, type LogItem, type Memory, type ReasoningInfo, type Task, type ToolCall, type Stats } from "../api";
import { Md } from "./Markdown";
import { MemCard } from "./Panels"; // одна карточка памяти на чат и панель (правка, проверка, «отмена»)
import { Button, Chip, Kbd, Seg, cx, useToast } from "../ui";

// Запасной порог сворачивания, пока health не пришёл; рабочее значение сервер отдаёт в health.compactAt
export const COMPACT_AT = 32000;
export type TurnStats = { promptTokens: number; tps?: number; draftAccept?: number | null; busy: boolean };

type Props = {
  task: Task; chat: TChat; ctxWindow: number; compactAt?: number; reasoning?: ReasoningInfo | null;
  memVersion: number; // растёт, когда память задачи меняется вне чата (панель памяти, конец хода)
  onChanged: () => void; onGone: (draft?: { text: string; images: string[] }) => void; onEditTask: () => void; onStats: (s: TurnStats) => void;
  takeDraft?: () => { text: string; images: string[] } | null; // черновик, перенесённый из удалённого чата (App → новому экрану)
};

// картинки уходят data-URL'ами в JSON (лимит сервера 40 МБ): общий объём держим с запасом
const IMAGES_MAX_CHARS = 38_000_000;

const EFFORT_ORDER: Effort[] = ["max", "xhigh", "high", "medium", "low", "minimal", "off"];
const EFFORT_RANK: Record<Effort, number> = { max: 6, xhigh: 5, high: 4, medium: 3, low: 2, minimal: 1, off: 0 };
const EFFORT_META: Record<Effort, { label: string; title: string }> = {
  max: { label: "max", title: "максимальный бюджет размышлений модели" },
  xhigh: { label: "xhigh", title: "очень глубоко" },
  high: { label: "high", title: "глубоко" },
  medium: { label: "medium", title: "обычно" },
  low: { label: "low", title: "кратко" },
  minimal: { label: "minimal", title: "минимум размышлений" },
  off: { label: "off", title: "без размышлений — быстрее всего" },
};

const SUGGESTIONS = [
  { k: "подсети", t: "Разбей 192.168.10.0/24 по VLSM под 60, 30, 12 и 2 хоста и объясни выбор масок" },
  { k: "практика", t: "Покажи интерфейсы, адреса и маршруты контейнера и объясни, что значит каждая строка" },
  { k: "проверка", t: "Посмотри, что я вводил в своём терминале, и проверь мои шаги" },
  { k: "протоколы", t: "Как работает ARP? Найди в материалах и покажи на практике в песочнице" },
];

export function ChatView({ task, chat, ctxWindow, compactAt, reasoning, memVersion, onChanged, onGone, onEditTask, onStats, takeDraft }: Props) {
  const compactMark = compactAt && compactAt > 0 ? compactAt : COMPACT_AT;
  const toast = useToast();
  const [items, setItems] = useState<LogItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [promptTokens, setPromptTokens] = useState(chat.last_prompt_tokens);
  const [lastStats, setLastStats] = useState<Stats | null>(null);
  const [sources, setSources] = useState<{ doc: string; page: number }[]>([]);
  const [proposals, setProposals] = useState<Memory[]>([]);
  const [effort, setEffort] = useState<Effort>(() => {
    const saved = localStorage.getItem("wh.effort") as Effort | null;
    return saved && EFFORT_ORDER.includes(saved) ? saved : "xhigh";
  });
  const [mode, setMode] = useState<AgentMode>(() => (localStorage.getItem("wh.mode") === "autonomous" ? "autonomous" : "guided"));
  // при открытии чата забираем перенесённый черновик (из чата, удалённого в другой вкладке) — один раз
  const seededDraft = useState(() => takeDraft?.() ?? { text: "", images: [] as string[] })[0];
  const [text, setText] = useState(seededDraft.text);
  const [images, setImages] = useState<string[]>(seededDraft.images);
  const [dragOver, setDragOver] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const lastTop = useRef(0); // scrollTop после последней прокрутки (своей или пользователя): направление движения
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const tmpId = useRef(-1);
  // Один AbortController на экран чата: уход из чата закрывает и поток отправки, и переподключение (/stream).
  // Ход на сервере продолжается; вернёмся — /stream досылает уже набранную часть.
  const ctrl = useRef<AbortController | null>(null); // задаётся при открытии чата (эффект ниже)
  const proposalsRef = useRef<Memory[]>([]);
  proposalsRef.current = proposals;

  useEffect(() => { try { localStorage.setItem("wh.effort", effort); } catch { /* ignore */ } }, [effort]);
  // Список усилий диктует активная модель (health): GLM, например, умеет только max/high/low и не отключается.
  const effortOptions = useMemo<Effort[]>(() => {
    const supported = reasoning?.supportedEfforts?.filter((e) => EFFORT_ORDER.includes(e)) ?? [];
    return supported.length ? EFFORT_ORDER.filter((e) => supported.includes(e)) : ["xhigh", "medium", "low", "off"];
  }, [reasoning]);
  useEffect(() => {
    if (effortOptions.includes(effort)) return;
    const below = effortOptions.filter((e) => EFFORT_RANK[e] <= EFFORT_RANK[effort]);
    setEffort(below[0] ?? effortOptions.at(-1) ?? "xhigh");
  }, [effort, effortOptions]);
  useEffect(() => { try { localStorage.setItem("wh.mode", mode); } catch { /* ignore */ } }, [mode]);
  // фокус в поле ввода — только если пользователь сейчас не в другом поле/диалоге (не воруем фокус у модалки)
  const focusInput = () => {
    const a = document.activeElement;
    const inComposer = !!a && !!input.current?.closest('[data-testid="composer"]')?.contains(a);
    if (!a || a === document.body || inComposer) input.current?.focus();
  };
  useEffect(() => { onStats({ promptTokens, tps: lastStats?.tps, draftAccept: lastStats?.draftAccept, busy }); }, [promptTokens, lastStats, busy, onStats]);

  // Журнал, отложенный до первого события /stream: при переподключении посреди хода уже показанная часть ответа
  // не пропадает (в журнале её ещё нет) — журнал и повтор набранного заменяют её одним обновлением.
  const pendingLog = useRef<LogItem[] | null>(null);
  const applyPending = () => { const l = pendingLog.current; if (l) { pendingLog.current = null; setItems(l); setLoaded(true); } };
  // «возможно, ушло»: /send оборвался по сети уже ПОСЛЕ приёма сервером. Набранное не возвращаем вслепую —
  // follow() перечитает журнал и вернёт текст, только если сообщения там нет (иначе это задвоило бы его в ленте).
  const maybeSent = useRef<{ raw: string; imgs: string[] } | null>(null);

  // live() — результат ещё нужен (экран не закрыт, не началась новая отправка); иначе ничего не трогать.
  // defer — если ход идёт, не заменять ленту сразу (см. pendingLog).
  const reload = useCallback(async (live: () => boolean = () => true, defer = false) => {
    const r = await api.log(chat.id);
    if (!live()) return null;
    pendingLog.current = null;
    // defer держит журнал, только если ленту есть что сохранить (идёт свой ход / переподключение). На первой
    // загрузке defer не нужен: иначе сбой первого /log на занятом чате оставлял бы ленту пустой (экран
    // «Новый чат» поверх истории) до первого события /stream.
    if (defer && r.chat.busy) pendingLog.current = r.log; else { setItems(r.log); setLoaded(true); }
    setPromptTokens(r.chat.last_prompt_tokens);
    const lastAi = [...r.log].reverse().find((x) => x.kind === "assistant");
    if (lastAi && lastAi.kind === "assistant" && lastAi.data.stats) setLastStats(lastAi.data.stats);
    const ms = maybeSent.current;
    if (ms) {
      const lastUser = [...r.log].reverse().find((x) => x.kind === "user");
      const inLog = !!lastUser && lastUser.kind === "user" && lastUser.data.text === ms.raw.trim()
        && (lastUser.data.images?.length ?? 0) === ms.imgs.length;
      if (inLog) maybeSent.current = null; // сообщение ушло — черновик не возвращаем (иначе задвоился бы)
      else if (!r.chat.busy) { maybeSent.current = null; setText((cur) => (cur.trim() ? cur : ms.raw)); setImages((cur) => (cur.length ? cur : ms.imgs)); } // не ушло — вернуть
      // иначе: занят, но в журнале ещё нет — решим на следующем перечитывании
    }
    const mem = await api.memories(task.id);
    if (live()) setProposals(mem.filter((m) => m.status === "pending" && m.chat_id === chat.id));
    return r.chat;
  }, [chat.id, task.id]);

  // события хода -> локальное состояние
  const handle = useCallback((ev: any) => {
    applyPending();
    const upd = (f: (a: LogItem[]) => LogItem[]) => setItems(f);
    const patchLast = (f: (d: any) => any) => upd((a) => {
      const i = a.length - 1;
      const last = a[i];
      if (!last || last.kind !== "assistant") return a;
      const b = a.slice(); b[i] = { ...last, data: f(last.data) }; return b;
    });
    switch (ev.type) {
      case "assistant_start":
        upd((a) => [...a, { id: tmpId.current--, kind: "assistant", created_at: Date.now(), data: { content: "", reasoning: "", tool_calls: [], live: true } }]);
        break;
      case "token": patchLast((d) => ({ ...d, content: d.content + ev.t })); break;
      case "reasoning": patchLast((d) => ({ ...d, reasoning: d.reasoning + ev.t })); break;
      case "assistant_end":
        // сервер присылает итоговый текст (вычищенный от сырого <tool_call>) — он заменяет поток
        patchLast((d) => ({ ...d, live: false, stats: ev.stats, tool_calls: ev.tool_calls, content: typeof ev.content === "string" ? ev.content : d.content }));
        if (ev.stats?.promptTokens) setPromptTokens(ev.stats.promptTokens + (ev.stats.completionTokens ?? 0));
        if (ev.stats?.tps) setLastStats(ev.stats);
        break;
      case "tool_start":
        upd((a) => [...a, { id: tmpId.current--, kind: "tool_result", created_at: Date.now(), data: { id: ev.id, name: ev.name, output: null } }]);
        break;
      case "tool_end":
        upd((a) => a.map((x) => (x.kind === "tool_result" && x.data.id === ev.id ? { ...x, data: { ...x.data, output: ev.output, ms: ev.ms, skipped: ev.skipped } } : x)));
        break;
      case "recall": setSources(ev.sources ?? []); break;
      case "proposals": setProposals((p) => [...p, ...ev.items]); onChanged(); break;
      case "compacted":
        upd((a) => [...a, { id: tmpId.current--, kind: "marker", created_at: Date.now(), data: { type: "compacted", removed: ev.removed, before: ev.before, after: ev.after } }]);
        setPromptTokens(ev.after ?? 0);
        break;
      case "chat_title": onChanged(); break;
      case "error":
        upd((a) => [...a, { id: tmpId.current--, kind: "marker", created_at: Date.now(), data: { type: "error", message: ev.message } }]);
        break;
    }
  }, [onChanged]);

  // Следить за ходом на сервере: перечитать журнал и, пока сервер говорит busy, читать /stream (он досылает уже
  // набранную часть). Оборвался поток (сеть, ERR_NETWORK_CHANGED) — переподключиться с паузой, ограниченное
  // число раз. В конце busy=false и onChanged(): список чатов перечитывается, индикатор в сайдбаре гаснет.
  // afterTurn — вызвано после своей отправки (ход был, обновить список в конце надо в любом случае);
  // ended — поток отправки дошёл до done/error (сервер вот-вот снимет «занят»).
  // Слежение одно на экран: новая отправка (или новое слежение) делает прежнее устаревшим — иначе открытие чата,
  // совпавшее с быстрой отправкой, подписалось бы на /stream вдобавок к потоку /send (токены задвоились бы).
  const followGen = useRef(0);
  const follow = useCallback(async (signal: AbortSignal, afterTurn = false, ended = false) => {
    const my = ++followGen.current;
    const live = () => !signal.aborted && followGen.current === my;
    let fails = 0, rounds = 0, grace = 0;
    let turnSeen = afterTurn, justEnded = ended;
    for (;;) {
      if (!live()) return;
      let c: TChat | null;
      try { c = await reload(live, afterTurn || rounds > 0); }
      catch (e: any) {
        if (!live()) return;
        if (isGone(e)) { setBusy(false); onGone(); return; }
        if (++fails > 5) { toast("error", e.message); break; }
        await sleep(400 * 2 ** (fails - 1), signal);
        continue;
      }
      if (!c || !live()) return;
      if (!c.busy) break;
      // только что пришёл конец хода, а сервер ещё не снял «занят» — подождать, а не подписываться на ход,
      // который уже закончился (такой поток не получил бы больше ни одного события)
      if (justEnded && grace++ < 5) { await sleep(300, signal); continue; } // live() — в начале цикла
      if (++rounds > 100) break;
      turnSeen = true;
      setBusy(true);
      try {
        const r = await streamTurn(chat.id, null, handle, { signal });
        if (!live()) return;
        applyPending(); // поток закончился без событий
        fails = 0;
        justEnded = r.ended;
        grace = 0;
      } catch (e: any) {
        if (!live()) return;
        if (isGone(e)) { setBusy(false); onGone(); return; }
        justEnded = false;
        if (++fails > 5) { toast("error", `поток ответа прервался: ${e.message}`); break; }
        await sleep(400 * 2 ** (fails - 1), signal);
      }
    }
    if (!live()) return;
    setBusy(false);
    // follow() завершился, так и не перечитав журнал (сервер недоступен) — вернуть отложенный черновик
    if (maybeSent.current) { const ms = maybeSent.current; maybeSent.current = null; setText((cur) => (cur.trim() ? cur : ms.raw)); setImages((cur) => (cur.length ? cur : ms.imgs)); }
    if (turnSeen) onChanged();
  }, [chat.id, handle, onChanged, onGone, reload, toast]);

  // открыли чат: загрузить историю; если ход ещё идёт (перезагрузили страницу, вернулись в чат) — подцепиться к потоку.
  // Уход из чата (размонтирование) закрывает все его потоки.
  useEffect(() => {
    const ac = new AbortController();
    ctrl.current = ac;
    setItems([]); setSources([]); setBusy(false); setLoaded(false); setAtBottom(true); maybeSent.current = null;
    void follow(ac.signal);
    const t = setTimeout(focusInput, 50);
    return () => { ac.abort(); clearTimeout(t); };
  }, [chat.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Память изменилась вне чата (подтвердили/отклонили/удалили в панели, в другой вкладке): из предложений убрать
  // всё, что уже не ждёт решения. Только фильтр — предложения, пришедшие по потоку после запроса, не теряются.
  const memSeen = useRef(memVersion);
  useEffect(() => {
    if (memVersion === memSeen.current) return;
    memSeen.current = memVersion;
    const asked = new Set(proposalsRef.current.map((m) => m.id));
    if (!asked.size) return;
    let live = true;
    api.memories(task.id).then((mem) => {
      if (!live) return;
      const pending = new Set(mem.filter((m) => m.status === "pending").map((m) => m.id));
      setProposals((p) => p.filter((m) => !asked.has(m.id) || pending.has(m.id)));
    }).catch(() => {});
    return () => { live = false; };
  }, [memVersion, task.id]);

  // Автопрокрутка, пока пользователь сам не отмотал вверх. Любое движение вверх (колесо, тачпад, ползунок,
  // клавиши) отключает слежение сразу, а не после 80px: иначе мелкие шаги колеса съедаются следующим токеном.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom) { el.scrollTop = el.scrollHeight; lastTop.current = el.scrollTop; }
  }, [items, proposals, atBottom]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const up = el.scrollTop < lastTop.current - 0.5;
    lastTop.current = el.scrollTop;
    if (up && gap > 1) setAtBottom(false);
    else if (gap < 80) setAtBottom(true);
  };
  const onWheel = (e: ReactWheelEvent) => {
    const el = scroller.current;
    if (e.deltaY >= 0 || !el || el.scrollTop <= 0 || el.scrollHeight <= el.clientHeight + 1) return;
    // колесо вверх внутри вложенного прокручиваемого блока (размышления, вывод инструмента) прокрутит его,
    // а не ленту — тогда автопрокрутку ленты не трогаем
    for (let n = e.target as HTMLElement | null; n && n !== el; n = n.parentElement) {
      if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight + 1) return;
    }
    setAtBottom(false);
  };

  // поле ввода растёт по содержимому (3 строки минимум, до ~40% экрана)
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  const send = async () => {
    const raw = text;
    const t = raw.trim();
    if ((!t && !images.length) || busy) return;
    const imgs = images;
    if (imgs.reduce((n, s) => n + s.length, 0) > IMAGES_MAX_CHARS) { toast("error", "картинки слишком большие: вместе больше ~28 МБ — убери часть"); return; }
    const signal = ctrl.current?.signal;
    if (!signal) return;
    followGen.current++; // открытие чата ещё читает журнал — его результат уже не нужен
    pendingLog.current = null;
    maybeSent.current = null;
    const tmp = tmpId.current--;
    setText(""); setImages([]); setSources([]); setBusy(true); setAtBottom(true);
    setItems((a) => [...a, { id: tmp, kind: "user", created_at: Date.now(), data: { text: t, images: imgs } }]);
    let ended = false;
    try {
      // onOpen: сервер принял сообщение и уже считает чат занятым — перечитать список (индикатор в сайдбаре)
      ended = (await streamTurn(chat.id, { text: t, images: imgs, effort, mode }, handle, { signal, onOpen: onChanged })).ended;
    } catch (e: any) {
      if (signal.aborted) return;
      if (e instanceof NotSentError) {
        // сообщение не принято: оптимистичный пузырь убрать — журнал/реплей покажут, что на самом деле ушло
        setItems((a) => a.filter((x) => x.id !== tmp));
        if (isGone(e)) { setBusy(false); onGone({ text: raw, images: imgs }); return; } // чат удалён — черновик уедет в следующий чат
        if (e.status === 409) {
          // «уже идёт ответ» (другая вкладка): сообщение не записано — вернуть набранное, подцепиться к идущему ходу
          setText((cur) => (cur.trim() ? cur : raw));
          setImages((cur) => (cur.length ? cur : imgs));
          toast("error", e.message);
        } else if (e.status !== undefined) {
          // сервер ответил ошибкой (413, 400…): ход не начался — снять «занят» и вернуть набранное сразу
          setBusy(false);
          setText((cur) => (cur.trim() ? cur : raw));
          setImages((cur) => (cur.length ? cur : imgs));
          toast("error", e.message);
        } else {
          // сеть оборвалась ДО ответа: сообщение могло уйти. Снять «занят» сразу (не держать «стоп», пока
          // follow() выясняет), а возврат черновика отложить — follow() вернёт, только если его нет в журнале.
          setBusy(false);
          maybeSent.current = { raw, imgs };
          toast("error", e.message);
        }
      } else {
        toast("error", `связь с сервером прервалась (${e.message}) — переподключаюсь к ответу`);
      }
    }
    // ход закончился, оборвался или идёт в другой вкладке (409): дочитать/подцепиться и обновить список
    await follow(signal, true, ended);
    if (!signal.aborted) focusInput();
  };

  const stop = () => { api.stop(chat.id).catch((e) => toast("error", e.message)); };

  const toolResults = useMemo(() => {
    const m = new Map<string, { output: string | null; ms?: number }>();
    for (const x of items) if (x.kind === "tool_result") m.set(x.data.id, x.data);
    return m;
  }, [items]);

  const addImages = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > IMAGES_MAX_CHARS * 0.7) { toast("error", `«${f.name}» слишком большая картинка (${(f.size / 1048576).toFixed(0)} МБ)`); continue; }
      const r = new FileReader();
      r.onload = () => setImages((a) => (a.length < 4 ? [...a, String(r.result)] : a));
      r.readAsDataURL(f);
    }
  };

  const pct = Math.min(100, (promptTokens / ctxWindow) * 100);
  const lastAiIdx = items.map((x) => x.kind).lastIndexOf("assistant");
  const empty = loaded && !items.length;

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="chat-panel">
      {/* шапка */}
      <header className="@container flex h-14 flex-none items-center gap-3 border-b border-line px-5" data-testid="chat-header">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px]">
          {task.course && <span className="hidden flex-none text-dim @[640px]:inline">{task.course}</span>}
          {task.course && <ChevronRight size={13} className="hidden flex-none text-faint @[640px]:inline" />}
          <span className="min-w-[72px] truncate font-bold text-fg" title={task.brief || task.title} data-testid="chat-task-title">{task.title}</span>
          <ChevronRight size={13} className="flex-none text-faint" />
          <span className="max-w-[30%] min-w-[64px] truncate text-dim" title={chat.title} data-testid="chat-title">{chat.title}</span>
          <Button variant="ghost" size="icon-sm" onClick={onEditTask} title="условие задачи, название, удаление" data-testid="edit-task"><Pencil size={13} /></Button>
        </div>
        <div className="flex flex-none items-center gap-2.5" title="заполненный контекст: чем меньше, тем быстрее генерация. Жёлтая метка — порог сворачивания старых ходов в резюме">
          <span className="text-[11px] whitespace-nowrap text-dim" data-testid="ctx-label">ctx {fmtK(promptTokens)} / {Math.round(ctxWindow / 1024)}K</span>
          <div className="relative h-1.5 w-28 rounded-full border border-line-2 bg-term" data-testid="ctx-meter" data-tokens={promptTokens}>
            <div
              className={cx("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500", promptTokens > compactMark ? "bg-warn" : "bg-accent")}
              style={{ width: `${pct}%` }}
            />
            <div className="absolute -inset-y-1 w-0.5 rounded bg-warn/80" style={{ left: `${Math.min(100, (compactMark / ctxWindow) * 100)}%` }} />
          </div>
        </div>
      </header>

      {/* лента */}
      <div ref={scroller} onScroll={onScroll} onWheel={onWheel} className="min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-5" data-testid="messages">
        <div className="mx-auto max-w-[900px]">
          {empty && <Hero task={task} onPick={(t) => { setText(t); input.current?.focus(); }} />}
          {items.map((it, idx) => {
            if (it.kind === "user") return <UserMsg key={it.id} text={it.data.text} images={it.data.images} />;
            if (it.kind === "assistant")
              return (
                <div key={it.id}>
                  <AiMsg data={it.data} results={it.data.tool_calls.length ? toolResults : null} />
                  {idx === lastAiIdx && sources.length > 0 && (
                    <div className="-mt-3 mb-5 ml-[42px] flex flex-wrap gap-1.5" data-testid="recall-sources">
                      {[...new Set(sources.map((s) => `${s.doc}${s.page ? ` · с.${s.page}` : ""}`))].map((s) => (
                        <Chip key={s} className="text-[11px]"><BookOpen size={11} className="text-cyan" />{s}</Chip>
                      ))}
                    </div>
                  )}
                </div>
              );
            if (it.kind === "marker")
              return (
                <div key={it.id} data-testid={it.data.type === "compacted" ? "marker-compacted" : "marker-error"}
                  className={cx("my-2 mb-5 flex items-center gap-3 text-[11.5px] before:h-px before:flex-1 after:h-px after:flex-1",
                    it.data.type === "error" ? "text-err before:bg-err/30 after:bg-err/30" : "text-dim before:bg-line-2 after:bg-line-2")}>
                  {it.data.type === "compacted"
                    ? <>контекст свёрнут: {it.data.removed} сообщ. → резюме · {fmtK(it.data.before ?? 0)} → ~{fmtK(it.data.after ?? 0)} ток.</>
                    : <>ошибка: {it.data.message}</>}
                </div>
              );
            return null;
          })}
          {busy && items[items.length - 1]?.kind !== "assistant" && (
            <div className="mb-5 ml-[42px] flex items-center gap-2 text-[12px] text-dim" data-testid="thinking"><Loader2 size={13} className="animate-spin text-warn" /> агент думает…</div>
          )}
          {proposals.length > 0 && (
            <Proposals items={proposals} onDone={(id) => { setProposals((p) => p.filter((x) => x.id !== id)); onChanged(); }} />
          )}
        </div>
      </div>

      {!atBottom && (
        <button
          onClick={() => setAtBottom(true)}
          data-testid="to-bottom"
          className="absolute right-7 bottom-52 z-10 flex size-9 items-center justify-center rounded-full border border-line-2 bg-surface-3 text-accent shadow-panel transition hover:shadow-glow"
          title="вниз"
        >
          <ArrowDown size={16} />
        </button>
      )}

      {/* поле ввода */}
      <div className="flex-none px-6 pt-1 pb-5">
        <div
          data-testid="composer"
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); addImages(e.dataTransfer.files); }}
          className={cx(
            "@container mx-auto max-w-[900px] rounded-lg border bg-surface-2 px-4 pt-3 pb-2.5 transition",
            dragOver ? "border-dashed border-accent" : "border-transparent focus-within:border-fg",
          )}
        >
          {images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2" data-testid="thumbs">
              {images.map((src, i) => (
                <div key={i} className="relative" data-testid="thumb">
                  <img src={src} className="h-14 rounded-lg border border-line-2" />
                  <button onClick={() => setImages((a) => a.filter((_, j) => j !== i))} className="absolute -top-1.5 -right-1.5 flex size-[18px] items-center justify-center rounded-full bg-err text-white" aria-label="убрать картинку"><X size={10} /></button>
                </div>
              ))}
            </div>
          )}
          <div className="mb-2 flex min-w-0 items-center gap-2" data-testid="mode-bar">
            <span className="hidden flex-none text-[11px] text-dim @[520px]:inline">режим</span>
            <Seg<AgentMode>
              testid="mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: "guided", label: "ведомый", title: "доводит только порученный этап до результата (предохранитель — 6 раундов действий), отчитывается и ждёт следующего указания" },
                { value: "autonomous", label: "автономный", title: "может сам продолжать открытую задачу в пределах хода; узкий запрос всё равно не расширяет" },
              ]}
            />
            <span className="hidden min-w-0 truncate text-[11px] text-dim @[720px]:inline">
              {mode === "guided" ? "один порученный этап — и стоп" : "может вести открытую задачу дальше"}
            </span>
          </div>
          <textarea
            ref={input}
            value={text}
            rows={3}
            data-testid="composer-input"
            placeholder={busy ? "агент работает… можно остановить" : "Опиши задачу, задай вопрос или следующий шаг…"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addImages(e.clipboardData.files); } }}
            className="block max-h-[40vh] min-h-[72px] w-full resize-none border-none bg-transparent px-0.5 text-[14px] leading-relaxed text-fg outline-none"
          />
          <div className="mt-1.5 flex min-w-0 items-center gap-2" data-testid="composer-bar">
            <span className="hidden flex-none text-[11px] text-dim @[480px]:inline">размышления</span>
            <Seg<Effort>
              testid="effort"
              value={effort}
              onChange={setEffort}
              options={effortOptions.map((value) => ({
                value,
                label: EFFORT_META[value].label,
                title: `${EFFORT_META[value].title}${reasoning?.mandatory && value === effortOptions.at(-1) ? " (ниже модель не умеет: reasoning обязателен)" : ""}`,
              }))}
            />
            {/* кнопка, а не <label> со скрытым input: доступна с клавиатуры (Tab, Enter/Space открывают выбор файла) */}
            <Button variant="ghost" size="icon" title="приложить картинку (или перетащи / Ctrl+V)" aria-label="приложить картинку"
              onClick={() => fileInput.current?.click()} data-testid="attach">
              <ImagePlus size={16} />
            </Button>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden tabIndex={-1} data-testid="attach-input" onChange={(e) => { if (e.target.files) addImages(e.target.files); e.target.value = ""; }} />
            <span className="flex-1" />
            <span className="hidden flex-none items-center gap-1 text-[11px] whitespace-nowrap text-faint @[700px]:inline-flex" data-testid="composer-hint"><Kbd>Enter</Kbd> отправить · <Kbd>Shift+Enter</Kbd> перенос</span>
            {busy ? (
              <button onClick={stop} data-testid="stop" title="остановить"
                className="flex size-[38px] flex-none items-center justify-center rounded border border-err/45 bg-err/10 text-err transition hover:bg-err/20">
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button onClick={() => void send()} disabled={!text.trim() && !images.length} data-testid="send" title="отправить (Enter)"
                className="flex size-[38px] flex-none items-center justify-center rounded bg-accent text-accent-ink transition hover:bg-[#b2f233] disabled:bg-surface-3 disabled:text-dim">
                <ArrowUp size={18} strokeWidth={2.6} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Hero({ task, onPick }: { task: Task; onPick: (t: string) => void }) {
  return (
    <div className="mx-auto mt-[8vh] max-w-[660px] animate-fadein text-center" data-testid="hero">
      <div className="text-[46px] leading-none font-bold text-accent [text-shadow:0_0_24px_rgb(159_239_0/0.5)]">&gt;_<span className="animate-blink">▋</span></div>
      <h2 className="mt-5 mb-1.5 text-[16px] font-bold text-fg">Новый чат · {task.title}</h2>
      <p className="mb-6 text-[12.5px] text-dim">Условие и подтверждённая память задачи подтянутся сами — можно начинать с чистого листа.</p>
      <div className="grid grid-cols-1 gap-2.5 text-left sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button key={s.k} data-testid="suggestion" onClick={() => onPick(s.t)}
            className="rounded border border-line bg-surface-2 px-4 py-3 text-[12.5px] leading-snug text-fg-2 transition hover:border-line-3 hover:bg-surface-3 hover:text-fg">
            <span className="mb-1 block text-[11px] text-accent">{s.k}</span>{s.t}
          </button>
        ))}
      </div>
    </div>
  );
}

const UserMsg = memo(function UserMsg({ text, images }: { text: string; images?: string[] }) {
  return (
    <div className="mb-5 flex animate-fadein justify-end" data-testid="msg-user">
      <div className="max-w-[82%] rounded-lg bg-[#242f40] px-4 py-2.5 break-words whitespace-pre-wrap text-fg">
        {text}
        {images?.length ? <div className="mt-2 flex flex-wrap gap-2">{images.map((s, i) => <img key={i} src={s} className="max-h-48 max-w-64 rounded-lg border border-line-2" />)}</div> : null}
      </div>
    </div>
  );
});

const TOOL_ICON: Record<string, typeof SquareTerminal> = {
  shell: SquareTerminal, search_docs: Search, search_memory: Brain, subnet_calc: Calculator, read_rfc: FileText, user_history: History,
  web_search: Globe, web_fetch: Link2, tcp_probe: Cable, http_request: ArrowLeftRight, nmap_scan: Radar, ffuf_scan: FolderSearch, sqlmap_scan: Database, plan_update: ListTodo, profile_update: Crosshair,
};

function toolHeadline(tc: ToolCall) {
  const a = tc.args ?? {};
  switch (tc.name) {
    case "shell": return `$ ${a.command ?? ""}`;
    case "search_docs": return a.query ?? "";
    case "web_search": return a.query ?? "";
    case "web_fetch": return a.url ?? "";
    case "tcp_probe": return a.host ? `${a.host}:${a.port ?? ""}` : "";
    case "http_request": return `${a.method ?? (a.form || a.json || a.data ? "POST" : "GET")} ${a.url ?? ""}${a.session ? ` · сессия ${a.session}` : ""}`;
    case "nmap_scan": return `${a.target ?? "$TARGET"}${a.ports ? ` · порты ${a.ports}` : " · top1000"}${a.udp ? " · +UDP" : ""}`;
    case "ffuf_scan": return `${a.mode === "vhost" ? "vhost " : ""}${a.url ?? ""}${a.wordlist ? ` · ${a.wordlist}` : ""}${a.extensions ? ` · ${a.extensions}` : ""}`;
    case "sqlmap_scan": return `${a.stage ?? "detect"} ${a.url ?? ""}${a.table ? ` · ${a.db ? `${a.db}.` : ""}${a.table}` : ""}`;
    case "plan_update": return a.action === "add" ? `+ ${a.phase ?? ""}: ${a.text ?? ""}` : a.action === "remove" ? `удалить ${a.id ?? ""}` : `${a.id ?? ""}${a.status ? ` → ${a.status}` : ""}${a.note ? ` · ${a.note}` : ""}`;
    case "profile_update": {
      if (a.action === "remove") return `удалить ${a.id ?? ""}`;
      const what = a.kind === "service" ? `${a.port ?? ""}/${a.proto ?? "tcp"} ${a.service ?? ""} ${a.version ?? ""}`.trim()
        : a.kind === "cred" ? `${a.service ?? ""} ${a.username ?? ""}`.trim()
        : (a.text ?? a.id ?? "");
      return `${a.action === "add" ? "+ " : ""}${a.kind ?? ""}: ${what}`.trim();
    }
    case "search_memory": return `${a.query ?? ""}${a.all_tasks ? " (все задачи)" : ""}`;
    case "subnet_calc": return `${a.address ?? ""}${a.split_prefix ? ` → /${a.split_prefix}` : ""}${a.vlsm_hosts ? ` · VLSM ${JSON.stringify(a.vlsm_hosts)}` : ""}`;
    case "read_rfc": return `RFC ${a.number}${a.section ? ` §${a.section}` : ""}${a.grep ? ` · «${a.grep}»` : ""}`;
    case "user_history": return "команды пользователя в терминале";
    default: return JSON.stringify(a);
  }
}

function ToolBlock({ tc, res }: { tc: ToolCall; res?: { output: string | null; ms?: number } }) {
  const out = res?.output;
  const running = out === null || out === undefined;
  const head = out ? /^\[(exit \d+|таймаут[^\]]*|прервано[^\]]*)/.exec(out)?.[1] : null;
  const stoppedByUser = !!head && head.startsWith("прервано");
  const bad = !!head && head !== "exit 0" && !stoppedByUser;
  const preflight = !!out && out.startsWith("[нужна сверка"); // специализированный инструмент без сверки с инструкцией не выполнялся
  const spoiler = !!out && out.startsWith("[спойлер"); // политика обучения: готовое решение/writeup сервер не открыл
  const skipped = preflight || spoiler || (!!out && out.startsWith("[повтор")); // защита от зацикливания: тот же вызов не выполнялся
  const Icon = TOOL_ICON[tc.name] ?? SquareTerminal;
  return (
    <details className="group my-2 overflow-hidden rounded border border-line bg-surface-2 text-[12.5px] transition-colors hover:border-line-2"
      data-testid="tool-block" data-tool={tc.name} data-status={running ? "running" : skipped ? "skipped" : bad ? "error" : "ok"}>
      <summary className="flex cursor-pointer items-center gap-2.5 px-3 py-2">
        <span className="flex size-[22px] flex-none items-center justify-center rounded-md bg-cyan/10 text-cyan"><Icon size={13} /></span>
        <span className="flex-none text-[11.5px] text-cyan">{tc.name}</span>
        <span className="min-w-0 flex-1 truncate text-fg">{toolHeadline(tc)}</span>
        <span className="flex-none text-[11px]">
          {running ? <Loader2 size={13} className="animate-spin text-warn" />
            : skipped ? <span className="text-warn">{preflight ? "нужна инструкция · пропущен" : spoiler ? "спойлер · пропущен" : "повтор · пропущен"}</span>
            : <span className={bad ? "text-err" : stoppedByUser ? "text-warn" : "text-dim"}>{head ?? "ok"}{res?.ms ? ` · ${(res.ms / 1000).toFixed(1)}с` : ""}</span>}
        </span>
        <ChevronRight size={13} className="flex-none text-dim transition-transform group-open:rotate-90" />
      </summary>
      {!running && <pre className="max-h-80 overflow-auto border-t border-line bg-term px-3 py-2.5 text-[12px] break-words whitespace-pre-wrap text-fg-2" data-testid="tool-output">{out}</pre>}
    </details>
  );
}

const AiMsg = memo(function AiMsg({ data, results }: {
  data: { content: string; reasoning: string; stats?: Stats; tool_calls: ToolCall[]; live?: boolean };
  results: Map<string, { output: string | null; ms?: number }> | null;
}) {
  const s = data.stats;
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/msg mb-5 grid animate-fadein grid-cols-[30px_minmax(0,1fr)] gap-3" data-testid="msg-ai" data-live={data.live ? "1" : "0"}>
      <div className="flex size-[30px] items-center justify-center rounded bg-accent font-mono text-[11px] font-bold text-accent-ink">&gt;_</div>
      <div className="min-w-0 pt-1">
        {data.reasoning && (
          <details className="group/r mb-2" open={!!data.live && !data.content} data-testid="reasoning">
            <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-0.5 text-[11.5px] text-dim transition hover:border-line-2 hover:text-fg-2">
              <ChevronRight size={12} className="transition-transform group-open/r:rotate-90" />
              {data.live && !data.content ? <><Loader2 size={11} className="animate-spin" /> размышляю</> : "размышления"} · ~{fmtK(Math.round(data.reasoning.length / 3))} ток.
            </summary>
            <div className="mt-1.5 max-h-80 overflow-y-auto rounded border border-line bg-term px-3 py-2.5 text-[12px] whitespace-pre-wrap text-dim">{data.reasoning}</div>
          </details>
        )}
        {data.content ? <Md text={data.content} /> : data.live && !data.reasoning ? <span className="caret" /> : null}
        {data.live && data.content && <span className="caret" />}
        {data.tool_calls.map((tc) => <ToolBlock key={tc.id} tc={tc} res={results?.get(tc.id)} />)}
        {s && !data.live && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="stats">
            {!!s.tps && <Chip className="py-0 text-[10.5px] text-dim">{s.tps} t/s</Chip>}
            {s.draftAccept != null && <Chip className="py-0 text-[10.5px] text-dim">MTP {s.draftAccept}%</Chip>}
            {!!s.completionTokens && <Chip className="py-0 text-[10.5px] text-dim">{s.completionTokens} ток.</Chip>}
            {!!s.promptTokens && <Chip className="py-0 text-[10.5px] text-dim">ctx {fmtK(s.promptTokens)}</Chip>}
            {s.finish === "length" && <Chip className="py-0 text-[10.5px] text-warn">обрезано по длине</Chip>}
            {data.content && (
              <button
                className="ml-1 inline-flex items-center gap-1 rounded-md px-1.5 text-[11px] text-dim opacity-0 outline-none transition group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 hover:text-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => { void navigator.clipboard?.writeText(data.content); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
                data-testid="copy-answer"
              >
                {copied ? <><Check size={11} /> скопировано</> : <><Copy size={11} /> копировать ответ</>}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function Proposals({ items, onDone }: { items: Memory[]; onDone: (id: number) => void }) {
  return (
    <div className="mb-5 ml-[42px] animate-fadein rounded border border-warn/30 bg-warn/[0.06] px-4 pt-3 pb-1.5" data-testid="proposals">
      <div className="mb-2.5 flex items-center gap-2 text-[12px] text-warn"><Brain size={14} /> агент предлагает сохранить в память задачи</div>
      {items.map((m) => <MemCard key={m.id} m={m} onDone={onDone} />)}
    </div>
  );
}
