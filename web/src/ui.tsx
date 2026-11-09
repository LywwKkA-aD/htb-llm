// UI-кит HTB LLM (Tailwind) + провайдеры диалогов подтверждения и уведомлений.
import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

export const cx = clsx;

// Собственный знак проекта: изометрический куб с терминальной стрелкой внутри. Не официальный логотип HTB.
export function BrandMark({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" data-testid="brand-logo" className={cx("flex-none text-accent", className)}>
      <path d="M16 2.8 27 9.1v13.8L16 29.2 5 22.9V9.1L16 2.8Z" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M5.2 9.2 16 15.4l10.8-6.2M16 15.4v13.6" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- кнопки ----------
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "solid" | "ghost" | "danger" | "danger-solid";
  size?: "xs" | "sm" | "md" | "icon" | "icon-sm";
};
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = "default", size = "md", className, type = "button", ...p }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      {...p}
      className={cx(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded border font-sans font-medium transition-all duration-150",
        "disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        size === "xs" && "h-6 px-2 text-[11px] rounded",
        size === "sm" && "h-7 px-2.5 text-[11.5px]",
        size === "md" && "h-8 px-3 text-[12.5px]",
        size === "icon" && "size-8",
        size === "icon-sm" && "size-7 rounded",
        variant === "default" && "border-line-2 bg-surface-2 text-fg-2 hover:border-line-3 hover:bg-surface-3 hover:text-accent",
        variant === "primary" && "border-accent/30 bg-accent/10 text-accent hover:bg-accent/15",
        variant === "solid" && "border-accent bg-accent font-bold text-accent-ink hover:bg-[#b2f233]",
        variant === "ghost" && "border-transparent bg-transparent text-fg-2 hover:bg-surface-3 hover:text-accent",
        variant === "danger" && "border-err/30 bg-err/10 text-err hover:bg-err/20",
        variant === "danger-solid" && "border-err bg-err font-bold text-[#2a0606] hover:bg-[#ff8a8a]",
        className,
      )}
    />
  );
});

// ---------- примитивы ----------
export const Panel = ({ className, children, ...p }: { className?: string; children: ReactNode } & Record<string, unknown>) => (
  <section {...p} className={cx("min-h-0 min-w-0 overflow-hidden rounded border border-line bg-surface", className)}>{children}</section>
);

export const Dot = ({ state, title, testid }: { state: "ok" | "bad" | "mid" | "off"; title?: string; testid?: string }) => (
  <span
    title={title}
    data-testid={testid}
    data-state={state}
    className={cx("inline-block size-[7px] flex-none rounded-full",
      state === "ok" && "bg-accent shadow-glow", state === "bad" && "bg-err shadow-[0_0_6px_rgb(255_107_107/0.5)]",
      state === "mid" && "bg-warn", state === "off" && "bg-dim")}
  />
);

export const Chip = ({ children, className, ...p }: { children: ReactNode; className?: string } & Record<string, unknown>) => (
  <span {...p} className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-line bg-surface-2 px-2.5 py-px text-[11.5px] text-fg-2", className)}>{children}</span>
);

export const Badge = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx("inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1.5 text-[10.5px] font-bold leading-none text-[#1d1500]", className)}>{children}</span>
);

export function Seg<T extends string>({ value, options, onChange, size = "sm", testid }: {
  value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: "sm" | "md"; testid?: string;
}) {
  return (
    <div data-testid={testid} className="inline-flex min-w-0 max-w-full gap-0.5 overflow-x-auto rounded border border-line bg-term p-[3px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          data-testid={testid ? `${testid}-${o.value}` : undefined}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-[3px] transition-all duration-150",
            size === "sm" ? "px-2.5 py-0.5 text-[11.5px]" : "px-3.5 py-1 text-[12px]",
            value === o.value ? "bg-surface-3 text-fg" : "text-dim hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const fieldCls = "w-full rounded border border-line-2 bg-term px-3 py-2 text-fg outline-none transition focus:border-accent/45 focus:ring-[3px] focus:ring-accent/10";
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} {...p} className={cx(fieldCls, "h-9", className)} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} {...p} className={cx(fieldCls, "min-h-16 resize-y leading-relaxed", className)} />;
});
export const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <label className="block">
    <span className="mb-1.5 block text-[12px] text-fg-2">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-[11px] text-dim">{hint}</span>}
  </label>
);
export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="rounded border border-line-2 bg-surface-3 px-1 py-px text-[10px] text-fg-2">{children}</kbd>
);

// ---------- модальное окно ----------
// Открытые модалки лежат в стеке; Esc, Tab и фокус обслуживает только верхняя.
// Всё под ней — #root (с xterm и root-shell) и нижние модалки — получает inert: туда не попасть
// ни мышью, ни Tab, ни программным focus(), и нажатия клавиш не уходят в терминал под затемнением.
type ModalEntry = { overlay: HTMLElement | null; dialog: HTMLElement | null; close: () => void };
const modalStack: ModalEntry[] = [];
/** открыта ли сейчас хоть одна модалка (терминалы не принимают ввод, пока она открыта) */
export const isModalOpen = () => modalStack.length > 0;

const FOCUSABLE = 'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),iframe,summary,[contenteditable]:not([contenteditable="false"]),[tabindex]';
function focusables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) =>
    el.tabIndex >= 0 && !el.closest("[inert]") && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
}

function syncInert() {
  const top = modalStack.at(-1);
  document.getElementById("root")?.toggleAttribute("inert", !!top);
  for (const m of modalStack) m.overlay?.toggleAttribute("inert", m !== top);
}

// один слушатель на фазе перехвата у window: срабатывает раньше обработчиков xterm и любых других
function onModalKey(e: KeyboardEvent) {
  const top = modalStack.at(-1);
  const dlg = top?.dialog;
  if (!top || !dlg) return;
  const a = document.activeElement as HTMLElement | null;
  if (e.key === "Escape") {
    if (e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    top.close();
    return;
  }
  if (e.key === "Tab") {
    // ловушка фокуса: Tab / Shift+Tab ходят по кругу внутри верхнего окна
    e.preventDefault();
    e.stopPropagation();
    const list = focusables(dlg);
    // прокручиваемое тело окна без своих полей (длинный текст подтверждения на низком экране) — тоже в круге,
    // как «keyboard-focusable scroller» у браузера: иначе его не прокрутить с клавиатуры
    const body = dlg.querySelector<HTMLElement>("[data-modal-body]");
    if (body && body.scrollHeight > body.clientHeight + 1 && !list.some((el) => body.contains(el))) {
      const at = list.findIndex((el) => !!(body.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
      list.splice(at < 0 ? list.length : at, 0, body);
    }
    if (!list.length) { dlg.focus(); return; }
    const i = a ? list.indexOf(a) : -1;
    const n = list.length;
    list[i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + n) % n].focus();
    return;
  }
  // фокус каким-то образом оказался под затемнением — клавиши туда не пускаем
  if (a && a.closest("[inert]")) {
    e.preventDefault();
    e.stopPropagation();
    dlg.focus();
  }
}

export function Modal({ open, onClose, title, icon, children, footer, className, testid = "modal", returnFocus }: {
  open: boolean; onClose: () => void; title: ReactNode; icon?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string; testid?: string;
  /** вернуть ли фокус на элемент, который открыл окно (по умолчанию да); вызывается в момент закрытия */
  returnFocus?: () => boolean;
}) {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, returnFocus });
  useLayoutEffect(() => { latest.current = { onClose, returnFocus }; });
  // элемент, с которого открыли окно, запоминаем прямо в рендере: эффект сработал бы уже после autoFocus внутри окна
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    const a = document.activeElement;
    opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
  }
  wasOpen.current = open;

  useLayoutEffect(() => {
    if (!open) return;
    const entry: ModalEntry = { overlay: overlayRef.current, dialog: dialogRef.current, close: () => latest.current.onClose() };
    modalStack.push(entry);
    if (modalStack.length === 1) window.addEventListener("keydown", onModalKey, true);
    syncInert();
    const dlg = dialogRef.current;
    if (dlg && !dlg.contains(document.activeElement)) dlg.focus({ preventScroll: true });
    return () => {
      const i = modalStack.indexOf(entry);
      if (i >= 0) modalStack.splice(i, 1);
      if (!modalStack.length) window.removeEventListener("keydown", onModalKey, true);
      syncInert();
      const back = opener.current;
      opener.current = null;
      const a = document.activeElement;
      const lost = !a || a === document.body || !a.isConnected;
      if (back?.isConnected && lost && (latest.current.returnFocus?.() ?? true)) back.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={overlayRef} className="fixed inset-0 z-50 flex animate-fadein items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      // клик по фону закрывает окно; preventDefault — чтобы браузер не сбросил на body фокус, возвращённый открывшей кнопке
      onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); latest.current.onClose(); } }}
    >
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid={testid}
        className={cx("flex max-h-full w-full max-w-xl animate-pop flex-col rounded border border-line-2 bg-surface shadow-[0_10px_34px_rgb(0_0_0/0.5)] outline-none", className)}
      >
        <div className="flex flex-none items-center gap-3 border-b border-line px-5 py-4">
          {icon}
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-[14px] font-bold text-fg" title={typeof title === "string" ? title : undefined}>{title}</h2>
          <Button variant="ghost" size="icon-sm" onClick={() => latest.current.onClose()} aria-label="закрыть" data-testid={`${testid}-close`}><X size={15} /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset" tabIndex={-1} data-modal-body data-testid={`${testid}-body`}>{children}</div>
        {footer && <div className="flex flex-none items-center justify-end gap-2 rounded-b border-t border-line bg-surface-2/40 px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- подтверждения (вместо window.confirm) ----------
type ConfirmOpts = { title: string; message?: ReactNode; confirmText?: string; cancelText?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  useEffect(() => { if (state) setTimeout(() => okRef.current?.focus(), 30); }, [state]);
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Modal
        open={!!state}
        onClose={() => close(false)}
        testid="confirm-dialog"
        className="max-w-md"
        icon={<span className={cx("flex size-8 items-center justify-center rounded", state?.danger ? "bg-err/10 text-err" : "bg-accent/10 text-accent")}>
          {state?.danger ? <AlertTriangle size={16} /> : <Info size={16} />}</span>}
        title={state?.title}
        footer={<>
          <Button onClick={() => close(false)} data-testid="confirm-cancel">{state?.cancelText ?? "отмена"}</Button>
          <Button ref={okRef} variant={state?.danger ? "danger-solid" : "solid"} onClick={() => close(true)} data-testid="confirm-ok">{state?.confirmText ?? "ок"}</Button>
        </>}
      >
        <div className="text-[13px] leading-relaxed break-words text-fg-2">{state?.message}</div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

// ---------- уведомления ----------
type ToastKind = "error" | "success" | "info";
type ToastItem = { id: number; kind: ToastKind; text: string };
const ToastCtx = createContext<(kind: ToastKind, text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = ++seq.current;
    setItems((a) => [...a.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((a) => a.filter((t) => t.id !== id)), kind === "error" ? 6500 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed right-4 bottom-12 z-[60] flex w-[min(380px,90vw)] flex-col gap-2">
          {items.map((t) => (
            <div
              key={t.id}
              role="status"
              data-testid="toast"
              data-kind={t.kind}
              className={cx("pointer-events-auto flex animate-slidein items-start gap-2.5 rounded border bg-surface-2 px-3.5 py-3 text-[12.5px] shadow-panel",
                t.kind === "error" && "border-err/40 text-err", t.kind === "success" && "border-accent/35 text-accent", t.kind === "info" && "border-cyan/35 text-cyan")}
            >
              <span className="mt-px flex-none">{t.kind === "error" ? <XCircle size={15} /> : t.kind === "success" ? <CheckCircle2 size={15} /> : <Info size={15} />}</span>
              <span className="min-w-0 flex-1 break-words text-fg">{t.text}</span>
              <button className="flex-none text-dim hover:text-fg" onClick={() => setItems((a) => a.filter((x) => x.id !== t.id))} aria-label="закрыть"><X size={14} /></button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}
