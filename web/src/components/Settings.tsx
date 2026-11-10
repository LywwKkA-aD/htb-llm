import { useEffect, useRef, useState } from "react";
import { Bot, ChartColumn, CheckCircle2, Database, Download, KeyRound, Loader2, PlugZap, RefreshCw, Settings as SettingsIcon, TriangleAlert, XCircle } from "lucide-react";
import { api, type AgentsSettings, type AppSettings, type EmbedIndexInfo, type KnowledgeState, type OrStats, type Preset, type ReindexState } from "../api";
import { Button, Field, Input, Modal, Seg, useConfirm, useToast } from "../ui";

// Общие настройки моделей: для основной LLM и эмбеддингов — пресет (локальная / OpenRouter /
// свой OpenAI-совместимый API) со своим адресом, моделью, ключом и роутингом провайдера.
// Ключ сервер обратно не отдаёт: поле пустое = «не трогать», заполненное = заменить.
type Draft = { url: string; model: string; apiKey: string; clearKey: boolean; provider: string; quantization: string; ctxWindow: string; compactAt: string };
type SectionDraft = { active: Preset } & Record<Preset, Draft>;

const PRESET_LABEL: Record<Preset, string> = { local: "локальная", openrouter: "OpenRouter", custom: "свой API" };

const toDraft = (s: AppSettings["llm"] | AppSettings["embed"], llm: boolean): SectionDraft => {
  const one = (p: Preset): Draft => ({
    url: s[p].url, model: s[p].model, apiKey: "", clearKey: false,
    provider: s[p].provider, quantization: s[p].quantization,
    ctxWindow: llm ? String((s[p] as { ctxWindow: number }).ctxWindow) : "",
    compactAt: llm && (s[p] as { compactAt: number }).compactAt > 0 ? String((s[p] as { compactAt: number }).compactAt) : "",
  });
  return { active: s.active, local: one("local"), openrouter: one("openrouter"), custom: one("custom") };
};

const toPayload = (d: SectionDraft, llm: boolean) => {
  const one = (p: Preset) => {
    const x = d[p];
    const base: Record<string, unknown> = { url: x.url, model: x.model, provider: x.provider, quantization: x.quantization };
    if (x.clearKey) base.apiKey = "";
    else if (x.apiKey) base.apiKey = x.apiKey;
    if (llm) { base.ctxWindow = Number(x.ctxWindow); base.compactAt = Number(x.compactAt) || 0; }
    return base;
  };
  return { active: d.active, local: one("local"), openrouter: one("openrouter"), custom: one("custom") };
};

function EndpointForm({ kind, draft, onChange, saved }: {
  kind: "llm" | "embed"; draft: SectionDraft; onChange: (d: SectionDraft) => void; saved: AppSettings["llm"] | AppSettings["embed"];
}) {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const p = draft.active;
  const cur = draft[p];
  const keySet = saved[p].apiKeySet && !cur.clearKey;
  const set = (patch: Partial<Draft>) => { onChange({ ...draft, [p]: { ...cur, ...patch } }); setResult(null); };

  const test = async () => {
    setTesting(true); setResult(null);
    try {
      const r = await api.testSettings(kind, p, {
        url: cur.url, model: cur.model, provider: cur.provider, quantization: cur.quantization,
        ...(cur.apiKey ? { apiKey: cur.apiKey } : {}),
      });
      setResult(r);
    } catch (e: any) { toast("error", e.message); }
    setTesting(false);
  };

  return (
    <div className="space-y-3" data-testid={`set-${kind}`}>
      <Seg<Preset> testid={`set-${kind}-preset`} size="md" value={draft.active}
        options={(Object.keys(PRESET_LABEL) as Preset[]).map((v) => ({ value: v, label: PRESET_LABEL[v] }))}
        onChange={(v) => { onChange({ ...draft, active: v }); setResult(null); }} />
      <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Адрес API (OpenAI-совместимый, …/v1)">
          <Input value={cur.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://openrouter.ai/api/v1" data-testid={`set-${kind}-url`} />
        </Field>
        <Field label="Модель">
          <Input value={cur.model} onChange={(e) => set({ model: e.target.value })} placeholder={kind === "llm" ? "z-ai/glm-5.3-flash" : "cohere/embed-5-fast"} data-testid={`set-${kind}-model`} />
        </Field>
      </div>
      <Field label={p === "local" ? "API-ключ (локальному серверу обычно не нужен)" : "API-ключ"}>
        <div className="flex items-center gap-2">
          <Input type="password" value={cur.apiKey} autoComplete="off"
            onChange={(e) => set({ apiKey: e.target.value, clearKey: false })}
            placeholder={keySet ? "•••••• сохранён — введи новый, чтобы заменить" : "sk-…"} data-testid={`set-${kind}-key`} />
          {keySet && !cur.apiKey && (
            <Button size="sm" variant="ghost" className="flex-none" onClick={() => set({ clearKey: true })} data-testid={`set-${kind}-key-clear`}>
              убрать ключ
            </Button>
          )}
          {cur.clearKey && <span className="flex-none text-[11px] text-warn">ключ будет удалён при сохранении</span>}
        </div>
      </Field>
      {p === "openrouter" && (
        <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Провайдер OpenRouter" hint="slug провайдера; можно несколько через запятую по приоритету">
            <Input value={cur.provider} onChange={(e) => set({ provider: e.target.value })} placeholder="relace" data-testid={`set-${kind}-provider`} />
          </Field>
          {kind === "llm" && (
            <Field label="Квантизация" hint="напр. fp4, fp8, bf16 — фильтр эндпоинтов провайдера">
              <Input value={cur.quantization} onChange={(e) => set({ quantization: e.target.value })} placeholder="fp4" data-testid={`set-${kind}-quant`} />
            </Field>
          )}
        </div>
      )}
      {kind === "llm" && (
        <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Окно контекста (токены)" hint="размер окна модели — для счётчика контекста в чате">
            <Input value={cur.ctxWindow} inputMode="numeric" onChange={(e) => set({ ctxWindow: e.target.value })} data-testid="set-llm-ctx" />
          </Field>
          <Field label="Сворачивать историю после (токены)"
            hint={(() => { const w = Number(cur.ctxWindow) || 0; const auto = w >= 8192 ? (w <= 65536 ? 32000 : w - 24576) : null; return `пусто — авто${auto ? ` (≈${auto.toLocaleString("ru-RU")} для этого окна)` : ""}: после порога старые ходы заменяются резюме`; })()}>
            <Input value={cur.compactAt} inputMode="numeric" onChange={(e) => set({ compactAt: e.target.value })} placeholder="авто" data-testid="set-llm-compact" />
          </Field>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={testing} onClick={() => void test()} data-testid={`set-${kind}-test`}>
          {testing ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />} проверить соединение
        </Button>
        {result && (
          <span className={`inline-flex items-center gap-1.5 text-[12px] ${result.ok ? "text-accent" : "text-err"}`} data-testid={`set-${kind}-result`}>
            {result.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {result.detail}
          </span>
        )}
      </div>
    </div>
  );
}

// База знаний и векторный индекс: [скачать и построить базу] качает зафиксированные источники
// (HackTricks и др. + свои гайды) и индексирует их сохранённой моделью эмбеддингов — тот же
// пайплайн, что ./docker/run.sh knowledge. [переиндексировать] переэмбеддит уже скачанное.
// Для внешних эмбеддингов оба действия — платные запросы, поэтому каждое с подтверждением.
function IndexBlock({ info0, reindex0, knowledge0 }: { info0: EmbedIndexInfo; reindex0: ReindexState; knowledge0: KnowledgeState }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [info, setInfo] = useState(info0);
  const [st, setSt] = useState(reindex0);
  const [kb, setKb] = useState(knowledge0);
  const alive = useRef(true);
  useEffect(() => { setInfo(info0); }, [info0]);
  useEffect(() => {
    alive.current = true;
    if (!st.running) return;
    const t = setInterval(() => {
      api.reindexStatus().then((r) => { if (alive.current) { setSt(r.reindex); setInfo(r.embedIndex); } }).catch(() => {});
    }, 1000);
    return () => { alive.current = false; clearInterval(t); };
  }, [st.running]);
  useEffect(() => {
    if (!kb.running) return;
    const t = setInterval(() => {
      api.knowledgeStatus().then((r) => { if (alive.current) { setKb(r.knowledge); setInfo(r.embedIndex); } }).catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [kb.running]);

  const startBuild = async () => {
    const empty = info.chunks === 0;
    const ok = await confirm({
      title: empty ? "Скачать и построить базу знаний?" : "Обновить источники знаний?",
      message: <>Сервер скачает внешние корпуса зафиксированных ревизий (HackTricks, PayloadsAllTheThings, InternalAllTheThings, GTFOBins, LOLBAS — сотни мегабайт клонов) и проиндексирует их вместе с собственными гайдами проекта <b>сохранённой</b> моделью эмбеддингов. Если ты только что поменял эмбеддинги выше — сначала нажми «сохранить» внизу. Для внешнего API эмбеддингов это платные запросы (~17 тыс. фрагментов) и несколько минут работы.</>,
      confirmText: empty ? "скачать и построить" : "обновить источники",
    });
    if (!ok) return;
    try { setKb(await api.knowledgeStart()); toast("info", "построение базы запущено — ход виден здесь, вкладку можно не закрывать"); }
    catch (e: any) { toast("error", e.message); }
  };

  const start = async () => {
    const ok = await confirm({
      title: "Переиндексировать базу знаний?",
      message: <>Все фрагменты ({info.chunks}) и подтверждённая память будут переэмбедчены активной моделью эмбеддингов.
        Для внешнего API это платные запросы и может занять время. Старый векторный индекс заменится по мере готовности.</>,
      confirmText: "переиндексировать",
    });
    if (!ok) return;
    try { setSt(await api.reindexStart()); toast("info", "переиндексация запущена — прогресс виден здесь"); }
    catch (e: any) { toast("error", e.message); }
  };

  const pct = st.total > 0 ? Math.min(100, Math.round((st.done / st.total) * 100)) : 0;
  return (
    <div className="mt-3 rounded border border-line bg-surface-2 px-3 py-2.5" data-testid="embed-index" data-stale={info.stale}>
      <div className="flex flex-wrap items-center gap-2">
        <Database size={13} className="flex-none text-accent" />
        <span className="text-[12px] text-fg-2">
          индекс: <span className="text-fg">{info.chunks}</span> фрагментов · вектор {info.dim} · модель «{info.model}»
        </span>
        <span className="flex-1" />
        <Button size="sm" variant={info.chunks === 0 ? "primary" : "ghost"} disabled={kb.running || st.running}
          onClick={() => void startBuild()} data-testid="knowledge-build">
          {kb.running ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} {info.chunks === 0 ? "скачать и построить базу" : "обновить источники"}
        </Button>
        <Button size="sm" variant={info.stale ? "primary" : "ghost"} disabled={st.running || kb.running || info.chunks === 0}
          title={info.chunks === 0 ? "Сначала построй базу знаний кнопкой слева" : undefined}
          onClick={() => void start()} data-testid="reindex-start">
          {st.running ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} переиндексировать
        </Button>
      </div>
      {info.chunks === 0 && !st.running && !kb.running && (
        <div className="mt-1.5 text-[11.5px] leading-snug text-dim" data-testid="embed-index-empty">
          база знаний ещё не построена — переиндексировать нечего. Настрой эмбеддинги выше, сохрани настройки и нажми
          «скачать и построить базу» — сервер сам скачает зафиксированные источники знаний и построит индекс
          (то же, что <code className="rounded bg-surface-3 px-1 font-mono text-[11px] text-fg">./docker/run.sh knowledge</code> из терминала).
        </div>
      )}
      {(kb.running || kb.lines.length > 0) && (
        <pre className="mt-2 max-h-28 overflow-y-auto rounded bg-term px-2 py-1.5 font-mono text-[10.5px] leading-snug break-words whitespace-pre-wrap text-dim" data-testid="knowledge-log">{kb.lines.slice(-10).join("\n")}</pre>
      )}
      {!!kb.error && !kb.running && <div className="mt-1.5 text-[11.5px] leading-snug text-err" data-testid="knowledge-error">ошибка построения базы: {kb.error}</div>}
      {!kb.running && !kb.error && kb.finishedAt > 0 && <div className="mt-1.5 text-[11.5px] text-accent" data-testid="knowledge-done">база знаний построена: индекс — {info.chunks} фрагментов</div>}
      {info.stale && !st.running && (
        <div className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug text-warn" data-testid="embed-index-stale">
          <TriangleAlert size={12} className="mt-px flex-none" />
          <span>активная модель эмбеддингов отличается от той, что строила индекс — векторный поиск недоступен (работает полнотекстовый), пока не переиндексируешь.</span>
        </div>
      )}
      {st.running && (
        <div className="mt-2" data-testid="reindex-progress">
          <div className="mb-1 flex justify-between text-[10.5px] text-dim"><span>переэмбеддинг…</span><span className="font-mono">{st.done}/{st.total || "…"}</span></div>
          <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-label="прогресс переиндексации">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {!!st.error && !st.running && <div className="mt-1.5 text-[11.5px] leading-snug text-err" data-testid="reindex-error">ошибка переиндексации: {st.error}</div>}
      {!st.running && !st.error && st.finishedAt > 0 && <div className="mt-1.5 text-[11.5px] text-accent" data-testid="reindex-done">переиндексация завершена: {st.done} фрагментов</div>}
    </div>
  );
}

// Расходы OpenRouter: management-ключ (сохраняется общей кнопкой) + сводка с /activity, /keys, /auth/key.
// Статистика читается по СОХРАНЁННЫМ ключам — после ввода ключа сначала «сохранить», потом «обновить».
const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "$0");
const tok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

function OrStatsBlock({ mgmtKey, setMgmtKey, clearMgmt, setClearMgmt, savedSet }: {
  mgmtKey: string; setMgmtKey: (v: string) => void; clearMgmt: boolean; setClearMgmt: (v: boolean) => void; savedSet: boolean;
}) {
  const toast = useToast();
  const [stats, setStats] = useState<OrStats | null>(null);
  const [loading, setLoading] = useState(false);
  const load = (refresh = false) => {
    setLoading(true);
    api.orStats(refresh).then(setStats).catch((e) => toast("error", e.message)).finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  const keyAlive = savedSet && !clearMgmt;
  return (
    <div className="space-y-3" data-testid="or-stats">
      <Field label="Management-ключ OpenRouter" hint="отдельный provisioning-ключ (openrouter.ai → Settings → Management Keys): даёт доступ к статистике, но не к моделям">
        <div className="flex items-center gap-2">
          <Input type="password" value={mgmtKey} autoComplete="off" onChange={(e) => { setMgmtKey(e.target.value); setClearMgmt(false); }}
            placeholder={keyAlive ? "•••••• сохранён — введи новый, чтобы заменить" : "sk-or-…"} data-testid="set-or-mgmt-key" />
          {keyAlive && !mgmtKey && (
            <Button size="sm" variant="ghost" className="flex-none" onClick={() => setClearMgmt(true)} data-testid="set-or-mgmt-clear">убрать ключ</Button>
          )}
          {clearMgmt && <span className="flex-none text-[11px] text-warn">ключ будет удалён при сохранении</span>}
        </div>
      </Field>

      <div className="rounded border border-line bg-surface-2 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-fg-2">
            {stats?.scope ? "расходы и токены проекта" : "расходы и токены аккаунта"}
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => load(true)} data-testid="or-stats-refresh">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} обновить
          </Button>
        </div>
        {stats && (
          <div className="mt-1 text-[11px] leading-snug text-dim" data-testid="or-scope">
            {stats.scope ? (
              <>workspace ключа модели: {stats.scope.workspaces.map((w) => <span key={w.id} className="text-fg-2">«{w.name ?? w.id}»</span>).reduce<React.ReactNode[]>((a, el, i) => (i ? [...a, ", ", el] : [el]), [])} — чужие проекты аккаунта не считаются. Сводка по дням и моделям — последние 30 завершённых UTC-дней; сегодняшний расход есть в строке ключа и попадёт в сводку завтра.</>
            ) : stats.hasManagementKey ? (
              <>workspace ключа модели определить не удалось — сводка по всему аккаунту; проверь ключ модели в пресете OpenRouter.</>
            ) : null}
          </div>
        )}
        {stats && !stats.hasInferenceKey && !stats.hasManagementKey && (
          <div className="mt-1.5 text-[11.5px] leading-snug text-dim">ключей OpenRouter пока нет: укажи ключ модели в пресете OpenRouter выше и management-ключ здесь, сохрани — статистика подтянется.</div>
        )}
        {stats && stats.hasInferenceKey && !stats.hasManagementKey && (
          <div className="mt-1.5 text-[11.5px] leading-snug text-dim">есть только ключ модели: ниже — его лимит и usage. Полная статистика по моделям и дням — с management-ключом.</div>
        )}
        {stats?.key && (
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-fg-2" data-testid="or-key-info">
            <span>ключ{stats.key.label ? <> «{stats.key.label}»</> : ""}: потрачено <span className="text-fg">{usd(stats.key.usage)}</span>{stats.key.limit != null && <> из {usd(stats.key.limit)}</>}</span>
            <span>сегодня {usd(stats.key.usageDaily)}</span>
            <span>неделя {usd(stats.key.usageWeekly)}</span>
            <span>месяц {usd(stats.key.usageMonthly)}</span>
            {stats.key.freeTier && <span className="text-warn">free tier</span>}
          </div>
        )}
        {stats?.totals && (
          <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4" data-testid="or-totals">
            {([
              [`стоимость · ${stats.periodDays} дн.`, usd(stats.totals.cost)],
              ["запросов", String(stats.totals.requests)],
              ["токены вход/выход", `${tok(stats.totals.promptTokens)} / ${tok(stats.totals.completionTokens)}`],
              ["reasoning токены", tok(stats.totals.reasoningTokens)],
            ] as const).map(([k, v]) => (
              <div key={k} className="rounded bg-term px-2 py-1.5">
                <div className="text-[10px] text-dim">{k}</div>
                <div className="font-mono text-[13px] text-fg">{v}</div>
              </div>
            ))}
          </div>
        )}
        {stats?.totals && stats.totals.requests === 0 && !!stats.key && stats.key.usage > 0 && (
          <div className="mt-1.5 text-[11.5px] leading-snug text-dim">за последние 30 завершённых дней в сводке пока пусто — ключ начал тратиться сегодня, строки по моделям и дням появятся завтра.</div>
        )}
        {!!stats?.byModel.length && (
          <table className="mt-2 w-full text-[11.5px]" data-testid="or-bymodel">
            <thead><tr className="text-left text-[10px] text-dim"><th className="py-0.5 pr-2 font-normal">модель</th><th className="pr-2 font-normal">стоимость</th><th className="pr-2 font-normal">запросы</th><th className="font-normal">токены in/out</th></tr></thead>
            <tbody>
              {stats.byModel.slice(0, 8).map((m) => (
                <tr key={m.model} className="border-t border-line/60">
                  <td className="max-w-56 truncate py-1 pr-2 font-mono text-fg-2" title={m.model}>{m.model}</td>
                  <td className="py-1 pr-2 font-mono text-fg">{usd(m.cost)}</td>
                  <td className="py-1 pr-2 font-mono text-fg-2">{m.requests}</td>
                  <td className="py-1 font-mono text-fg-2">{tok(m.promptTokens)} / {tok(m.completionTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!!stats?.keys.length && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-fg-2" data-testid="or-keys">
            <span className="text-dim">по ключам:</span>
            {stats.keys.map((k) => (
              <span key={k.label} className={k.disabled ? "opacity-50" : ""}>{k.label}: <span className="font-mono text-fg">{usd(k.usage)}</span>{k.limit != null && <> / {usd(k.limit)}</>}</span>
            ))}
          </div>
        )}
        {stats && (stats.errors.key || stats.errors.activity || stats.errors.keys) && (
          <div className="mt-2 space-y-0.5 text-[11.5px] leading-snug text-err" data-testid="or-errors">
            {[stats.errors.key, stats.errors.activity, stats.errors.keys].filter(Boolean).map((e, i) => <div key={i}>{e}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

export function SettingsDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved?: () => void }) {
  const toast = useToast();
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [llm, setLlm] = useState<SectionDraft | null>(null);
  const [embed, setEmbed] = useState<SectionDraft | null>(null);
  const [agents, setAgents] = useState<AgentsSettings | null>(null);
  const [mgmtKey, setMgmtKey] = useState("");
  const [clearMgmt, setClearMgmt] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSaved(null); setLlm(null); setEmbed(null); setAgents(null); setMgmtKey(""); setClearMgmt(false);
    api.settings().then((s) => { setSaved(s); setLlm(toDraft(s.llm, true)); setEmbed(toDraft(s.embed, false)); setAgents(s.agents); })
      .catch((e) => toast("error", e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async () => {
    if (!llm || !embed || !agents) return;
    setBusy(true);
    try {
      const s = await api.saveSettings({
        llm: toPayload(llm, true), embed: toPayload(embed, false), agents,
        openrouterMgmt: clearMgmt ? { apiKey: "" } : mgmtKey ? { apiKey: mgmtKey } : {},
      });
      setSaved(s); setLlm(toDraft(s.llm, true)); setEmbed(toDraft(s.embed, false)); setAgents(s.agents); setMgmtKey(""); setClearMgmt(false);
      toast("success", "настройки моделей сохранены — действуют сразу, без перезапуска");
      onSaved?.();
      onClose();
    } catch (e: any) { toast("error", e.message); }
    setBusy(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Настройки моделей" icon={<SettingsIcon size={15} className="text-accent" />} testid="settings-dialog"
      className="max-w-2xl"
      footer={<>
        <Button onClick={onClose}>отмена</Button>
        <Button variant="solid" disabled={busy || !llm} onClick={() => void save()} data-testid="settings-save">
          {busy && <Loader2 size={13} className="animate-spin" />} сохранить
        </Button>
      </>}>
      {!saved || !llm || !embed || !agents ? (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-dim"><Loader2 size={13} className="animate-spin" /> загружаю…</div>
      ) : (
        <div className="space-y-6">
          <section>
            <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-fg"><KeyRound size={13} className="text-accent" /> Основная модель</div>
            <EndpointForm kind="llm" draft={llm} onChange={setLlm} saved={saved.llm} />
            <p className="mt-2 text-[11.5px] leading-snug text-dim">
              Локальный пресет — твоя Qwen (llama-server), кнопки запуска в сайдбаре управляют именно ей.
              Внешние API получают весь контекст задачи: условие, вывод инструментов, креды из профиля.
            </p>
          </section>
          <section>
            <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-fg"><KeyRound size={13} className="text-accent" /> Эмбеддинги (поиск по знаниям и памяти)</div>
            <EndpointForm kind="embed" draft={embed} onChange={setEmbed} saved={saved.embed} />
            <IndexBlock info0={saved.embedIndex} reindex0={saved.reindex} knowledge0={saved.knowledge} />
            <p className="mt-2 text-[11.5px] leading-snug text-dim">
              Если у новой модели другая размерность вектора, «проверить» покажет это. Переиндексация работает
              по сохранённому активному пресету: сначала сохрани настройки, потом запускай.
            </p>
          </section>
          <section data-testid="set-agents">
            <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-fg"><Bot size={13} className="text-accent" /> Подагенты (мультиагентность)</div>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Делегирование подзадач (spawn_subagent)">
                <Seg<"on" | "off"> testid="set-agents-toggle" size="md" value={agents.subagents ? "on" : "off"}
                  options={[{ value: "off", label: "выключено" }, { value: "on", label: "включено" }]}
                  onChange={(v) => setAgents({ ...agents, subagents: v === "on" })} />
              </Field>
              <Field label="Макс. подагентов за ход">
                <Input value={String(agents.maxPerTurn)} inputMode="numeric" className="max-w-24" data-testid="set-agents-per-turn"
                  onChange={(e) => setAgents({ ...agents, maxPerTurn: Number(e.target.value) })} />
              </Field>
              <Field label="Макс. раундов подагента">
                <Input value={String(agents.maxRounds)} inputMode="numeric" className="max-w-24" data-testid="set-agents-rounds"
                  onChange={(e) => setAgents({ ...agents, maxRounds: Number(e.target.value) })} />
              </Field>
              <Field label="Раундов действий на этап (управляемый режим, 3–24)">
                <Input value={String(agents.guidedRounds)} inputMode="numeric" className="max-w-24" data-testid="set-guided-rounds"
                  onChange={(e) => setAgents({ ...agents, guidedRounds: Number(e.target.value) })} />
              </Field>
            </div>
            <p className="mt-2 text-[11.5px] leading-snug text-dim">
              {saved.llm.active === "local"
                ? "Сейчас активна локальная модель — подагенты недоступны (Qwen одна, и параллельные ходы ей вредят). Включится само на внешнем пресете, когда опция сохранена включённой."
                : `Активен внешний пресет «${PRESET_LABEL[saved.llm.active]}» — подагенты ${agents.subagents ? "будут доступны модели после сохранения" : "выключены тумблером"}.`}
              {" "}Подагент — исследователь с чистым контекстом: поиск по базе и вебу, структурированные сканеры; без shell.
              Каждый его раунд — платные токены внешнего API.
            </p>
          </section>
          <section>
            <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-fg"><ChartColumn size={13} className="text-accent" /> OpenRouter · статистика</div>
            <OrStatsBlock mgmtKey={mgmtKey} setMgmtKey={setMgmtKey} clearMgmt={clearMgmt} setClearMgmt={setClearMgmt} savedSet={saved.openrouterMgmt.apiKeySet} />
          </section>
        </div>
      )}
    </Modal>
  );
}
