import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Plus, X } from "lucide-react";
import { api, type ProfileItem, type ProfileKind, type ProfileNew, type Task } from "../api";
import { Button, Input, cx, useToast } from "../ui";

const KIND_ORDER: ProfileKind[] = ["service", "cred", "access", "fact"];
const KIND_TITLE: Record<ProfileKind, string> = {
  service: "Сервисы",
  cred: "Креды",
  access: "Доступы",
  fact: "Факты",
};
const KIND_OPTION: Record<ProfileKind, string> = {
  service: "сервис",
  cred: "креды",
  access: "доступ",
  fact: "факт",
};

const selectCls = "h-9 flex-none rounded border border-transparent bg-surface-2 px-2 text-[12.5px] text-fg outline-none transition focus:border-fg";

export function ProfilePanel({ task, onChanged }: { task: Task; onChanged?: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<ProfileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSecrets, setShowSecrets] = useState(false);
  const [copied, setCopied] = useState("");
  const [kind, setKind] = useState<ProfileKind>("cred");
  const [form, setForm] = useState({ host: "", port: "", service: "", version: "", username: "", secret: "", source: "", text: "" });

  const load = useCallback(async (quiet = false) => {
    try {
      const r = await api.profile(task.id);
      setItems(r.items);
    } catch (e: any) {
      if (!quiet) toast("error", e.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [task.id, toast]);

  useEffect(() => {
    setLoading(true);
    setShowSecrets(false);
    void load();
    const t = setInterval(() => void load(true), 5000); // модель пишет находки на ходу
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); await load(true); onChanged?.(); } catch (e: any) { toast("error", e.message); }
  };

  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 1200);
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const add = async () => {
    const item: ProfileNew = { kind };
    if (kind === "service") {
      const port = Math.trunc(Number(form.port));
      if (!(port >= 1 && port <= 65535)) { toast("error", "укажи порт 1..65535"); return; }
      Object.assign(item, { host: form.host.trim(), port, service: form.service.trim(), version: form.version.trim(), source: form.source.trim() });
    } else if (kind === "cred") {
      if (!form.secret) { toast("error", "секрет пуст"); return; }
      Object.assign(item, { service: form.service.trim(), username: form.username.trim(), secret: form.secret, source: form.source.trim() });
    } else {
      if (!form.text.trim()) { toast("error", "текст записи пуст"); return; }
      Object.assign(item, { text: form.text.trim(), source: form.source.trim() });
    }
    setForm({ host: "", port: "", service: "", version: "", username: "", secret: "", source: "", text: "" });
    await act(() => api.profileAdd(task.id, item));
  };

  const canAdd = kind === "service" ? form.port.trim() !== "" : kind === "cred" ? form.secret !== "" : form.text.trim() !== "";

  return (
    <div className="space-y-4 p-4" data-testid="profile-panel">
      <div className="rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-dim">
        {items.length > 0 ? (
          <>
            Что известно о цели: сервисы с версиями, креды с источником, доступы и факты. Ведёт модель инструментом
            profile_update, сводка подклеивается ей в каждый ход; ты можешь добавлять и удалять сам.
          </>
        ) : loading ? (
          <>Загружаю профиль…</>
        ) : (
          <>
            Профиль цели пока пуст. Модель запишет сюда сервисы после скана и креды, как только найдёт, инструментом{" "}
            <span className="font-mono text-fg-2">profile_update</span> — и будет видеть это в каждом ходе и каждом новом чате,
            не пересканируя заново. Можно добавить записи самому формой ниже.
          </>
        )}
      </div>

      {KIND_ORDER.map((k) => {
        const rows = items.filter((i) => i.kind === k);
        if (!rows.length) return null;
        const sorted = k === "service" ? [...rows].sort((a, b) => (a.port ?? 99999) - (b.port ?? 99999)) : rows;
        return (
          <div key={k} className="space-y-0.5">
            <div className="flex items-center gap-2 text-[11px] tracking-[0.08em] text-fg-2 uppercase" data-testid="profile-group" data-kind={k}>
              <span>{KIND_TITLE[k]} <span className="tracking-normal text-faint normal-case">· {rows.length}</span></span>
              <span className="flex-1" />
              {k === "cred" && (
                <button type="button" data-testid="profile-toggle-secrets" title={showSecrets ? "скрыть секреты" : "показать секреты"}
                  onClick={() => setShowSecrets((v) => !v)}
                  className="flex cursor-pointer items-center gap-1 text-[11px] tracking-normal text-dim normal-case transition hover:text-fg">
                  {showSecrets ? <EyeOff size={12} /> : <Eye size={12} />} {showSecrets ? "скрыть" : "показать"}
                </button>
              )}
            </div>
            {sorted.map((i) => (
              <div key={i.id} className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition hover:bg-surface-2"
                data-testid="profile-item" data-profile-id={i.id} data-kind={i.kind}>
                <div className="min-w-0 flex-1">
                  {i.kind === "service" && (
                    <div className="font-mono text-[12px] leading-snug">
                      <span className="text-cyan">{i.port ?? "?"}</span>
                      <span className="text-faint">/{i.proto}</span>
                      {i.host && <span className="text-dim"> · {i.host}</span>}
                      {i.service && <span className="text-fg"> · {i.service}</span>}
                      {i.version && <span className="text-fg-2"> · {i.version}</span>}
                    </div>
                  )}
                  {i.kind === "cred" && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <KeyRound size={12} className="flex-none text-warn" />
                      <span className="text-[12.5px] leading-snug text-fg">{i.service || "?"}</span>
                      <span className="font-mono text-[11.5px] leading-snug text-fg-2">
                        {i.username || "(без логина)"}
                        {" / "}
                        <span data-testid="profile-secret">{showSecrets ? i.secret : "••••••"}</span>
                      </span>
                      <span className="inline-flex flex-none items-center rounded-full border border-line bg-surface-2 px-1.5 py-px text-[10.5px] leading-tight text-dim">{i.secret_type}</span>
                      <button type="button" data-testid="profile-copy" title="скопировать секрет"
                        onClick={() => copy(i.id, i.secret)}
                        className="flex cursor-pointer items-center gap-1 text-[11px] text-faint transition hover:text-fg">
                        {copied === i.id ? <><Check size={11} /> скопировано</> : <><Copy size={11} /> копировать</>}
                      </button>
                    </div>
                  )}
                  {(i.kind === "access" || i.kind === "fact") && (
                    <div className="text-[12.5px] leading-snug">{i.text}</div>
                  )}
                  {i.source && <div className="text-[11.5px] leading-snug text-dim" data-testid="profile-source">{i.source}</div>}
                </div>
                <button type="button" title="удалить запись" data-testid="profile-delete"
                  onClick={() => void act(() => api.profileDelete(task.id, i.id))}
                  className="flex-none cursor-pointer text-faint opacity-0 transition group-hover:opacity-100 hover:text-err">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        );
      })}

      <form className="space-y-2 rounded-[10px] border border-line bg-surface-2/60 p-2.5" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <div className="flex items-center gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value as ProfileKind)} data-testid="profile-new-kind" className={cx(selectCls, "w-[110px]")}>
            {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_OPTION[k]}</option>)}
          </select>
          <span className="text-[11.5px] text-dim">добавить запись в профиль</span>
          <span className="flex-1" />
          <Button type="submit" size="icon-sm" title="добавить запись" data-testid="profile-add" disabled={!canAdd}><Plus size={13} /></Button>
        </div>
        {kind === "service" && (
          <div className="flex flex-wrap gap-2">
            <div className="w-[80px]"><Input value={form.port} onChange={set("port")} inputMode="numeric" placeholder="порт" data-testid="profile-new-port" /></div>
            <div className="min-w-[110px] flex-1"><Input value={form.service} onChange={set("service")} placeholder="сервис (http, ssh…)" data-testid="profile-new-service" /></div>
            <div className="min-w-[110px] flex-1"><Input value={form.version} onChange={set("version")} placeholder="версия / баннер" data-testid="profile-new-version" /></div>
            <div className="min-w-[90px] flex-1"><Input value={form.host} onChange={set("host")} placeholder="хост (необяз.)" data-testid="profile-new-host" /></div>
          </div>
        )}
        {kind === "cred" && (
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0"><Input value={form.service} onChange={set("service")} placeholder="сервис (ssh, wordpress…)" data-testid="profile-new-service" /></div>
            <div className="min-w-0"><Input value={form.username} onChange={set("username")} placeholder="логин" data-testid="profile-new-username" /></div>
            <div className="min-w-0"><Input value={form.secret} onChange={set("secret")} placeholder="пароль / хэш / ключ" data-testid="profile-new-secret" /></div>
            <div className="min-w-0"><Input value={form.source} onChange={set("source")} placeholder="где нашёл (источник)" data-testid="profile-new-source" /></div>
          </div>
        )}
        {(kind === "access" || kind === "fact") && (
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[160px] flex-1"><Input value={form.text} onChange={set("text")} placeholder={kind === "access" ? "доступ: что и как получен…" : "факт о цели…"} data-testid="profile-new-text" /></div>
            <div className="min-w-[120px] flex-1"><Input value={form.source} onChange={set("source")} placeholder="источник (необяз.)" data-testid="profile-new-source" /></div>
          </div>
        )}
      </form>
    </div>
  );
}
