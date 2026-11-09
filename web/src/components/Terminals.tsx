import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Maximize2, Minimize2, Plus, RefreshCw, X } from "lucide-react";
import { api, wsUrl } from "../api";
import { Button, Dot, cx, isModalOpen } from "../ui";

const theme = {
  background: "#0f1623", foreground: "#d9e2f2", cursor: "#9fef00", cursorAccent: "#0f1623", selectionBackground: "#40600088",
  black: "#151f2e", brightBlack: "#526177", red: "#f35e5e", brightRed: "#f66f6f", green: "#9fef00", brightGreen: "#c5f566",
  yellow: "#f3cb5e", brightYellow: "#f6d26f", blue: "#5e94f3", brightBlue: "#6fa1f6", magenta: "#c06ff6", brightMagenta: "#d199f9",
  cyan: "#6ff6d2", brightCyan: "#8ff8dd", white: "#d9e2f2", brightWhite: "#f4f4f4",
};

type WsState = "connecting" | "open" | "closed";

function useXterm(kind: "agent" | "shell", taskId: string, sid = 1) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<WsState>("connecting");
  const [gen, setGen] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    const term = new Terminal({
      fontFamily: '"Roboto Mono", monospace', fontSize: 12.5, lineHeight: 1.2, theme, scrollback: 10000,
      cursorBlink: kind === "shell", disableStdin: kind === "agent", cursorStyle: kind === "agent" ? "underline" : "block",
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const doFit = () => { try { if (el.offsetWidth > 0 && el.offsetHeight > 0) fit.fit(); } catch { /* ignore */ } };
    doFit();
    setState("connecting");
    const ws = new WebSocket(wsUrl(`/ws/${kind}?task=${taskId}${kind === "shell" ? `&sid=${sid}` : ""}`));
    ws.onopen = () => {
      setState("open");
      if (kind === "shell") ws.send(JSON.stringify({ t: "resize", c: term.cols, r: term.rows }));
    };
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
    ws.onclose = () => {
      if (disposed) return;
      setState("closed");
      if (kind === "agent") setTimeout(() => !disposed && setGen((g) => g + 1), 2000); // лог агента — переподключаемся сами
      else term.write("\r\n\x1b[2m[сессия закрыта — нажми «переподключить»]\x1b[0m\r\n");
    };
    // пока открыто модальное окно, клавиши в терминал под затемнением не попадают
    // (основная защита — inert на #root и ловушка фокуса в Modal; это — страховка).
    // onData при этом не глушим: через него идут и автоматические ответы xterm на запросы программ
    // (DA, позиция курсора, цвета) — vim/tmux/fish ждут их и при открытом окне.
    // Копирование как в обычном терминале: Ctrl+Shift+C — копировать выделение; Ctrl+C при наличии
    // выделения — тоже копировать (не SIGINT), без выделения — прерывание как обычно. Вставка — Ctrl+Shift+V.
    term.attachCustomKeyEventHandler((e) => {
      if (isModalOpen()) return false;
      if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === "c" && term.hasSelection()) {
          void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
          if (!e.shiftKey) term.clearSelection();
          return false;
        }
        if (key === "v" && e.shiftKey && kind === "shell") {
          void navigator.clipboard?.readText().then((t) => { if (t) term.paste(t); }).catch(() => {});
          return false;
        }
      }
      return true;
    });
    const d1 = kind === "shell" ? term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "in", d }))) : null;
    const d2 = term.onResize(({ cols, rows }) => kind === "shell" && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "resize", c: cols, r: rows })));
    // fit через rAF: синхронный fit внутри ResizeObserver меняет размер экрана терминала и браузер
    // подавляет последнее уведомление цикла RO — подгон отстаёт на один ресайз (экран шире окна).
    let raf = 0;
    const scheduleFit = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (!disposed) doFit(); }); };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(el);
    window.addEventListener("resize", scheduleFit);
    // веб-шрифт может подгрузиться после первого fit: ширина ячейки изменится, а размер окна — нет,
    // ResizeObserver не сработает и экран останется шире окна. Перемеряем после загрузки шрифтов.
    document.fonts?.load('12.5px "Roboto Mono"').then(scheduleFit).catch(() => {});
    document.fonts?.ready.then(scheduleFit).catch(() => {});
    return () => { disposed = true; cancelAnimationFrame(raf); window.removeEventListener("resize", scheduleFit); ro.disconnect(); d1?.dispose(); d2.dispose(); ws.close(); term.dispose(); };
  }, [kind, taskId, sid, gen]);
  return { ref, state, reconnect: () => setGen((g) => g + 1) };
}

function Pane({ testid, title, subtitle, state, hidden, rootHidden, grow, maximized, onToggle, onReconnect, bodyRef, headerExtra }: {
  testid: string; title: string; subtitle: string; state: WsState; hidden: boolean; rootHidden?: boolean; grow: number; maximized: boolean;
  onToggle: () => void; onReconnect?: () => void; bodyRef: React.RefObject<HTMLDivElement | null>; headerExtra?: React.ReactNode;
}) {
  return (
    <div
      data-testid={testid}
      data-ws={state}
      className={cx(rootHidden ? "hidden" : "flex", "min-h-0 flex-col overflow-hidden rounded border border-line-2 bg-term")}
      style={{ flex: hidden || rootHidden ? "0 0 auto" : grow }}
    >
      <div className="flex h-9 flex-none items-center gap-2.5 border-b border-line bg-surface-2 px-3">
        <span className="flex gap-1.5" aria-hidden>
          <i className="block size-[9px] rounded-full bg-[#5a2b2b]" />
          <i className="block size-[9px] rounded-full bg-[#5a4a22]" />
          <i className="block size-[9px] rounded-full bg-[#23552f]" />
        </span>
        <Dot state={state === "open" ? "ok" : state === "closed" ? "bad" : "mid"} title={state} />
        <span className="flex-none text-[12px] font-bold text-fg">{title}</span>
        <span className="min-w-0 truncate text-[11px] text-dim" title={subtitle}>{subtitle}</span>
        {headerExtra}
        <span className="flex-1" />
        {onReconnect && state === "closed" && (
          <Button size="xs" onClick={onReconnect} data-testid={`${testid}-reconnect`}><RefreshCw size={11} /> переподключить</Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={onToggle} title={maximized ? "свернуть" : "развернуть"} data-testid={`${testid}-max`}>
          {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </Button>
      </div>
      <div ref={bodyRef} className={cx("term-body min-h-0 flex-1", hidden && "hidden")} />
    </div>
  );
}

const MAX_SHELL_TABS = 6;
type ShellTabsState = { ids: number[]; active: number; next: number };

function loadShellTabs(taskId: string): ShellTabsState {
  const fallback: ShellTabsState = { ids: [1], active: 1, next: 2 };
  try {
    const raw = localStorage.getItem(`wh.shellTabs.${taskId}`);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<ShellTabsState>;
    const ids = [...new Set((Array.isArray(p.ids) ? p.ids : []).filter((x) => Number.isInteger(x) && Number(x) > 0).map(Number))].slice(0, MAX_SHELL_TABS);
    if (!ids.length) return fallback;
    const active = ids.includes(Number(p.active)) ? Number(p.active) : ids[0];
    return { ids, active, next: Math.max(Number(p.next) || 0, Math.max(...ids) + 1) };
  } catch { return fallback; }
}

function ShellPane({ taskId, id, active, layout, onToggle, headerExtra }: {
  taskId: string; id: number; active: boolean; layout: "split" | "agent" | "shell";
  onToggle: () => void; headerExtra?: React.ReactNode;
}) {
  const s = useXterm("shell", taskId, id);
  return (
    <Pane
      testid={id === 1 ? "term-shell" : `term-shell-${id}`} title="твой shell" subtitle="kali · root · /work"
      state={s.state} bodyRef={s.ref} hidden={layout === "agent"} rootHidden={!active} grow={1} maximized={layout === "shell"}
      onToggle={onToggle} onReconnect={s.reconnect} headerExtra={active ? headerExtra : undefined}
    />
  );
}

export function Terminals({ taskId }: { taskId: string }) {
  const [layout, setLayout] = useState<"split" | "agent" | "shell">(() => (localStorage.getItem("wh.termLayout") as "split") || "split");
  useEffect(() => { try { localStorage.setItem("wh.termLayout", layout); } catch { /* ignore */ } }, [layout]);
  const [shells, setShells] = useState<ShellTabsState>(() => loadShellTabs(taskId));
  useEffect(() => { try { localStorage.setItem(`wh.shellTabs.${taskId}`, JSON.stringify(shells)); } catch { /* ignore */ } }, [shells, taskId]);
  const a = useXterm("agent", taskId);

  const addShell = () => setShells((s) => (s.ids.length >= MAX_SHELL_TABS ? s : { ids: [...s.ids, s.next], active: s.next, next: s.next + 1 }));
  const closeShell = (id: number) => {
    void api.killShell(taskId, id).catch(() => {}); // явное закрытие вкладки убивает tmux-сессию; простое отключение WS — нет
    setShells((s) => {
      if (s.ids.length <= 1) return s;
      const ids = s.ids.filter((x) => x !== id);
      return { ...s, ids, active: s.active === id ? ids[ids.length - 1] : s.active };
    });
  };
  const shellTabs = (
    <span className="flex min-w-0 flex-none items-center gap-1 overflow-x-auto" data-testid="term-shell-tabs">
      {shells.ids.map((id) => (
        <span key={id} className={cx("flex h-6 flex-none items-center rounded-md border",
          shells.active === id ? "border-accent/60 bg-accent/10 text-fg" : "border-line-2 bg-surface-3 text-dim")}>
          <button type="button" className="h-full px-2 text-[11px] font-semibold whitespace-nowrap"
            data-testid={`term-shell-tab-${id}`} aria-pressed={shells.active === id}
            onClick={() => setShells((s) => ({ ...s, active: id }))}>
            shell {id}
          </button>
          {shells.ids.length > 1 && (
            <button type="button" className="flex h-full items-center pr-1.5 text-dim transition hover:text-fg" data-testid={`term-shell-close-${id}`}
              title={`закрыть shell ${id}`} aria-label={`закрыть shell ${id}`} onClick={() => closeShell(id)}>
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      <Button variant="ghost" size="icon-sm" onClick={addShell} disabled={shells.ids.length >= MAX_SHELL_TABS}
        title={shells.ids.length >= MAX_SHELL_TABS ? `не больше ${MAX_SHELL_TABS} вкладок` : "новый shell"} data-testid="term-shell-add">
        <Plus size={13} />
      </Button>
    </span>
  );

  return (
    <div className="flex h-full flex-col gap-2.5 p-2.5" data-testid="terminals" data-layout={layout}>
      <Pane
        testid="term-agent" title="терминал агента" subtitle="команды и вывод вживую" state={a.state} bodyRef={a.ref}
        hidden={layout === "shell"} grow={layout === "agent" ? 1 : 1.15} maximized={layout === "agent"}
        onToggle={() => setLayout(layout === "agent" ? "split" : "agent")}
      />
      {shells.ids.map((id) => (
        <ShellPane key={id} taskId={taskId} id={id} active={shells.active === id} layout={layout}
          onToggle={() => setLayout(layout === "shell" ? "split" : "shell")} headerExtra={shellTabs} />
      ))}
    </div>
  );
}
