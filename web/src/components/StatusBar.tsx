import { Activity, Box, Cpu, Gauge, Globe, Loader2, Network, Zap } from "lucide-react";
import { fmtK, type Health, type Task } from "../api";
import { Dot } from "../ui";
import type { TurnStats } from "./Chat";

export function StatusBar({ health, task, stats, ctxWindow, vpnIp }: { health: Health | null; task: Task | null; stats: TurnStats | null; ctxWindow: number; vpnIp?: string | null }) {
  const item = "inline-flex items-center gap-1.5 whitespace-nowrap";
  return (
    <footer className="flex h-7 flex-none items-center gap-4 border-t border-line bg-surface/80 px-4 text-[11px] text-dim" data-testid="statusbar">
      <span className={item} title={`основная модель (пресет: ${health?.preset ?? "локальная"}; настройки — шестерёнка в сайдбаре)`}>
        <Dot state={health ? (health.llm ? "ok" : "bad") : "off"} /> <Cpu size={12} /> {health?.model ?? "…"}
      </span>
      <span className={item} title="эмбеддинги (настройки — шестерёнка в сайдбаре)"><Dot state={health ? (health.embed ? "ok" : "bad") : "off"} /> emb</span>
      <span className={item} title="docker"><Dot state={health ? (health.docker && health.image ? "ok" : "bad") : "off"} /> docker</span>
      <span className={item} title="веб-поиск агента: твой SearXNG (web_search/web_fetch)" data-testid="status-web"><Dot state={health ? (health.web ? "ok" : "bad") : "off"} /> <Globe size={12} /> searxng</span>
      {task && (
        <span className={item} title="контейнер задачи" data-testid="status-container">
          <Box size={12} /> kali: <span className={task.container === "running" ? "text-accent" : "text-warn"}>{task.container === "running" ? "работает" : task.container === "stopped" ? "остановлен" : "нет"}</span>
        </span>
      )}
      {vpnIp && (
        <span className={item} title="VPN в контейнере задачи: адрес для обратных соединений (LHOST)" data-testid="status-vpn">
          <Network size={12} className="text-accent" /> vpn: <span className="text-accent">{vpnIp}</span>
        </span>
      )}
      <span className="flex-1" />
      {stats?.busy && <span className={`${item} text-warn`} data-testid="status-busy"><Loader2 size={12} className="animate-spin" /> агент работает</span>}
      {!!stats?.tps && <span className={item} title="скорость последнего ответа"><Zap size={12} /> {stats.tps} t/s</span>}
      {stats?.draftAccept != null && <span className={item} title="принято MTP-драфта"><Activity size={12} /> MTP {stats.draftAccept}%</span>}
      {stats && <span className={item} title="заполненный контекст текущего чата" data-testid="status-ctx"><Gauge size={12} /> ctx {fmtK(stats.promptTokens)} / {Math.round(ctxWindow / 1024)}K</span>}
    </footer>
  );
}
