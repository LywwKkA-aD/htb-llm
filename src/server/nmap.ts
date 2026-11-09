import crypto from "node:crypto";
import * as sandbox from "./sandbox.ts";

// Типизированная обёртка nmap (пакет 4, п.15): сервер сам собирает команду из валидированных
// параметров (модель не угадывает флаги и не проходит preflight ради типового скана), запускает её
// в терминале агента — пользователь видит скан вживую — а XML парсит в факты: открытые порты,
// сервисы и версии структурно, а не простынёй текста. XML разбирает python-stdlib (ElementTree)
// внутри контейнера: регулярками по XML на сервере было бы хрупко.
export type NmapPort = {
  port: number; proto: string; state: string;
  service: string; product: string; version: string; extra: string;
  scripts: { id: string; output: string }[];
};
export type NmapHost = {
  addr: string; names: string[]; status: string;
  ports: NmapPort[]; extraports: { state: string; count: number }[];
};
export type NmapOpts = {
  target?: string;
  ports?: string; // "all" | "top1000" | "22,80,443-445"
  serviceDetection?: boolean; // -sV, по умолчанию да
  defaultScripts?: boolean; // -sC
  scripts?: string; // --script <имена через запятую>
  udp?: boolean; // отдельный -sU --top-ports 50
  skipHostDiscovery?: boolean; // -Pn, по умолчанию да
  timeoutSec?: number;
};
export type NmapScanResult = {
  ok: boolean; error?: string;
  targetLabel: string;
  hosts: NmapHost[];
  xmlPaths: string[]; txtPath: string;
  elapsed: string; timedOut: boolean; exitCode: number; secs: number;
};

const TARGET_RE = /^[A-Za-z0-9._-]+(\/\d{1,2})?$/;
const PORTS_RE = /^(\d{1,5})(-\d{1,5})?(,(\d{1,5})(-\d{1,5})?)*$/;
const SCRIPTS_RE = /^[a-z0-9_,.*+-]+$/i;

export function validateNmapOpts(o: NmapOpts): string | null {
  if (o.target !== undefined && o.target !== "$TARGET" && o.target !== "$TARGET_HOST" && !TARGET_RE.test(o.target))
    return "target должен быть одним IP, именем хоста или CIDR без спецсимволов (или пустым — тогда цель задачи $TARGET)";
  if (o.ports !== undefined && o.ports !== "all" && o.ports !== "top1000") {
    if (!PORTS_RE.test(o.ports)) return "ports: «all», «top1000» или список вида 22,80,443-445";
    for (const n of o.ports.match(/\d+/g) ?? []) if (Number(n) > 65535) return "ports: порт больше 65535";
  }
  if (o.scripts !== undefined && !SCRIPTS_RE.test(o.scripts)) return "scripts: только имена NSE-скриптов через запятую";
  return null;
}

const NMAP_PARSE_PY = String.raw`
import sys, json
import xml.etree.ElementTree as ET

hosts = {}
elapsed = ""
for path in sys.argv[1:]:
    try:
        root = ET.parse(path).getroot()
    except Exception as e:
        print("WHJSON " + json.dumps({"ok": False, "error": f"не распарсить {path}: {e}"}))
        sys.exit(0)
    fin = root.find("runstats/finished")
    if fin is not None and fin.get("elapsed"):
        elapsed = fin.get("elapsed")
    for h in root.iter("host"):
        st = h.find("status")
        addr = ""
        for a in h.iter("address"):
            if a.get("addrtype") in ("ipv4", "ipv6"):
                addr = a.get("addr") or ""
                break
        names = [hn.get("name") for hn in h.iter("hostname") if hn.get("name")]
        cur = hosts.setdefault(addr, {"addr": addr, "names": names, "status": st.get("state") if st is not None else "", "ports": [], "extraports": []})
        if names and not cur["names"]:
            cur["names"] = names
        pel = h.find("ports")
        if pel is None:
            continue
        for ep in pel.iter("extraports"):
            cur["extraports"].append({"state": ep.get("state") or "", "count": int(ep.get("count") or 0)})
        for p in pel.iter("port"):
            s = p.find("state")
            svc = p.find("service")
            g = (lambda el, k: (el.get(k) or "") if el is not None else "")
            scripts = [{"id": sc.get("id") or "", "output": (sc.get("output") or "")[:400]} for sc in p.iter("script")]
            cur["ports"].append({
                "port": int(p.get("portid") or 0), "proto": p.get("protocol") or "",
                "state": g(s, "state"), "service": g(svc, "name"), "product": g(svc, "product"),
                "version": g(svc, "version"), "extra": g(svc, "extrainfo"), "scripts": scripts,
            })
print("WHJSON " + json.dumps({"ok": True, "hosts": list(hosts.values()), "elapsed": elapsed}, ensure_ascii=False))
`;

export async function runNmapScan(taskId: string, o: NmapOpts, signal?: AbortSignal): Promise<NmapScanResult> {
  const target = o.target ?? "$TARGET";
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${crypto.randomBytes(3).toString("hex")}`;
  const base = `/work/scans/nmap-${stamp}`;
  const xmlPaths = [`${base}.xml`];
  if (o.udp) xmlPaths.push(`${base}-udp.xml`);
  const txtPath = `${base}.txt`;

  const common: string[] = [];
  if (o.serviceDetection !== false) common.push("-sV");
  if (o.defaultScripts) common.push("-sC");
  if (o.scripts) common.push(`--script ${o.scripts}`);
  if (o.skipHostDiscovery !== false) common.push("-Pn");
  common.push("-T4", "--max-retries", "2");
  const portFlag = o.ports === "all" ? "-p-" : o.ports && o.ports !== "top1000" ? `-p ${o.ports}` : "--top-ports 1000";
  const tcpCmd = `nmap ${portFlag} ${common.join(" ")} -oX ${xmlPaths[0]} -oN ${txtPath} ${target}`;
  const udpCmd = o.udp ? `; nmap -sU --top-ports 50 ${common.join(" ")} -oX ${xmlPaths[1]} ${target}` : "";
  const cmd = `mkdir -p /work/scans && ${tcpCmd}${udpCmd}`;

  const timeout = Math.min(900, Math.max(30, o.timeoutSec ?? 420));
  const r = await sandbox.runAgentCommand(taskId, cmd, timeout, signal);
  const baseRes: NmapScanResult = {
    ok: false, targetLabel: target, hosts: [], xmlPaths, txtPath,
    elapsed: "", timedOut: r.timedOut, exitCode: r.exitCode, secs: r.secs,
  };
  if (r.aborted) return { ...baseRes, error: "остановлено пользователем" };

  const py64 = Buffer.from(NMAP_PARSE_PY).toString("base64");
  const pr = await sandbox.execCollect(taskId, `echo ${py64} | base64 -d | python3 - ${xmlPaths.join(" ")}`, 30).catch(() => null);
  const line = pr?.output.split("\n").find((l) => l.startsWith("WHJSON "));
  if (!line) return { ...baseRes, error: r.timedOut ? `скан не уложился в ${timeout} с, XML не готов` : `nmap завершился с exit ${r.exitCode}, XML не распарсился — сырой вывод выше в терминале, файл: ${txtPath}` };
  let parsed: any;
  try { parsed = JSON.parse(line.slice(7)); } catch { return { ...baseRes, error: "битый ответ парсера nmap XML" }; }
  if (!parsed.ok) return { ...baseRes, error: String(parsed.error ?? "nmap XML не распарсился") };
  return { ...baseRes, ok: true, hosts: parsed.hosts ?? [], elapsed: String(parsed.elapsed ?? "") };
}

// Строка версии сервиса одной фразой: product + version + extrainfo, как в обычном nmap-выводе.
export function serviceVersion(p: NmapPort): string {
  return [p.product, p.version, p.extra ? `(${p.extra})` : ""].filter(Boolean).join(" ").trim();
}

export function formatNmap(r: NmapScanResult, profileSaved: number | null): string {
  if (!r.ok) return `ошибка: ${r.error ?? "скан не удался"}`;
  const lines: string[] = [];
  const timing = r.elapsed ? `скан ${r.elapsed} с` : `${r.secs} с`;
  if (!r.hosts.length) lines.push(`nmap_scan: ${r.targetLabel} — хостов в результатах нет (${timing})`);
  for (const h of r.hosts) {
    const open = h.ports.filter((p) => p.state === "open");
    const label = h.names.length ? `${h.addr} (${h.names.join(", ")})` : h.addr || r.targetLabel;
    if (h.status && h.status !== "up") {
      lines.push(`nmap_scan: ${label} — хост ${h.status} (${timing}); открытых портов нет`);
      continue;
    }
    lines.push(`nmap_scan: ${label} — открытых портов: ${open.length} (${timing})`);
    for (const p of open) {
      const ver = serviceVersion(p);
      lines.push(`- ${p.port}/${p.proto} ${p.service || "?"}${ver ? ` — ${ver}` : ""}`);
      for (const sc of p.scripts) {
        const out = sc.output.replace(/\s+/g, " ").trim();
        if (out) lines.push(`  ${sc.id}: ${out.slice(0, 200)}`);
      }
    }
    const closed = h.extraports.filter((e) => e.count > 0);
    if (closed.length) lines.push(`остальные порты: ${closed.map((e) => `${e.count} ${e.state}`).join(", ")}`);
    const notOpen = h.ports.filter((p) => p.state !== "open");
    if (notOpen.length) lines.push(`не открыты из проверенных: ${notOpen.map((p) => `${p.port}/${p.proto} ${p.state}`).join(", ")}`);
  }
  if (r.timedOut) lines.push("[скан прерван по таймауту — результат частичный]");
  lines.push(`файлы: ${[...r.xmlPaths, r.txtPath].join(", ")}`);
  if (profileSaved !== null) lines.push(`в профиль цели записано сервисов: ${profileSaved}`);
  return lines.join("\n");
}
