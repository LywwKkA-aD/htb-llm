import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Download, File, FileText, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { api, type Task, type WorkFile, type WorkFilePreview } from "../api";
import { Button, Input, cx, useToast } from "../ui";

const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

type Node = { name: string; path: string; dir: boolean; size: number; children: Node[]; filesUnder: number };

// Плоский список путей от API -> дерево. Папки присутствуют в списке сами (dir), файлы вкладываются по пути.
function buildTree(files: WorkFile[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, size: 0, children: [], filesUnder: 0 };
  const byPath = new Map<string, Node>([["", root]]);
  const ensureDir = (path: string): Node => {
    let node = byPath.get(path);
    if (node) return node;
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const parent = ensureDir(parentPath);
    node = { name: path.slice(parentPath ? parentPath.length + 1 : 0), path, dir: true, size: 0, children: [], filesUnder: 0 };
    byPath.set(path, node);
    parent.children.push(node);
    return node;
  };
  for (const f of files) {
    if (f.dir) { ensureDir(f.path); continue; }
    const parentPath = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    const parent = ensureDir(parentPath);
    parent.children.push({ name: f.name, path: f.path, dir: false, size: f.size, children: [], filesUnder: 0 });
  }
  const sortCount = (n: Node): number => {
    n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    n.filesUnder = n.children.reduce((s, c) => s + (c.dir ? sortCount(c) : 1), 0);
    return n.filesUnder;
  };
  sortCount(root);
  return root.children;
}

function loadExpanded(taskId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`wh.filesExpanded.${taskId}`);
    const arr = raw ? JSON.parse(raw) as unknown : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}

const TEXT_EXT = [".txt", ".md", ".py", ".sh", ".json", ".log", ".xml", ".html", ".php", ".js", ".conf", ".ovpn"];

export function FilesPanel({ task }: { task: Task }) {
  const toast = useToast();
  const [files, setFiles] = useState<WorkFile[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkFilePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(task.id));
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const r = await api.files(task.id);
      setFiles(r.files);
    } catch (e: any) {
      if (!quiet) toast("error", e.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [task.id, toast]);

  useEffect(() => {
    setSel(null);
    setPreview(null);
    setExpanded(loadExpanded(task.id));
    void load();
    const t = setInterval(() => void load(true), 5000);
    return () => clearInterval(t);
  }, [load, task.id]);

  useEffect(() => {
    try { localStorage.setItem(`wh.filesExpanded.${task.id}`, JSON.stringify([...expanded])); } catch { /* ignore */ }
  }, [expanded, task.id]);

  const open = async (f: { path: string; dir: boolean }) => {
    if (f.dir) return;
    setSel(f.path);
    setPreview(null);
    // раскрыть папки-предки, чтобы выбранный файл был виден в дереве и после снятия фильтра
    const parts = f.path.split("/").slice(0, -1);
    if (parts.length) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
        return next;
      });
    }
    try {
      const p = await api.filePreview(task.id, f.path);
      if (selRef.current === f.path) setPreview(p);
    } catch (e: any) {
      toast("error", e.message);
    }
  };

  const toggleDir = (path: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const query = q.trim().toLowerCase();
  const tree = useMemo(() => buildTree(files), [files]);
  const allDirPaths = useMemo(() => files.filter((f) => f.dir).map((f) => f.path), [files]);
  const anyExpanded = expanded.size > 0;
  const selected = files.find((f) => f.path === sel) ?? null;

  const fileRow = (n: Node, depth: number, label: string) => (
    <button key={n.path} type="button" data-testid="file-row" data-path={n.path}
      onClick={() => void open(n)}
      className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-surface-2",
        sel === n.path && "bg-surface-2 outline outline-1 outline-accent/40")}
      style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="size-[14px] flex-none" aria-hidden />
      {TEXT_EXT.some((e) => n.name.toLowerCase().endsWith(e))
        ? <FileText size={14} className="flex-none text-dim" /> : <File size={14} className="flex-none text-dim" />}
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={n.path}>{label}</span>
      <span className="flex-none text-[10.5px] text-faint">{fmtSize(n.size)}</span>
    </button>
  );

  const renderNodes = (nodes: Node[], depth: number): React.ReactNode[] =>
    nodes.flatMap((n) => {
      if (!n.dir) return [fileRow(n, depth, n.name)];
      const openDir = expanded.has(n.path);
      const head = (
        <button key={n.path} type="button" data-testid="file-row" data-path={n.path} aria-expanded={openDir}
          onClick={() => toggleDir(n.path)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-fg-2 transition hover:bg-surface-2"
          style={{ paddingLeft: 8 + depth * 14 }}>
          <ChevronRight size={13} className={cx("flex-none text-dim transition-transform", openDir && "rotate-90")} />
          {openDir ? <FolderOpen size={14} className="flex-none text-accent" /> : <Folder size={14} className="flex-none text-accent" />}
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={n.path}>{n.name}/</span>
          <span className="flex-none text-[10.5px] text-faint">{n.filesUnder || ""}</span>
        </button>
      );
      return openDir ? [head, ...renderNodes(n.children, depth + 1)] : [head];
    });

  return (
    <div className="space-y-4 p-4" data-testid="files-panel">
      <div className="rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-dim">
        Файлы задачи в <span className="font-mono text-fg-2">/work</span>: сканы — <span className="font-mono text-fg-2">scans/</span>,
        эксплойты — <span className="font-mono text-fg-2">exploits/</span>, отдача цели — <span className="font-mono text-fg-2">www/</span>,
        добыча — <span className="font-mono text-fg-2">loot/</span>, заметки — <span className="font-mono text-fg-2">notes/</span>.
        Служебный <span className="font-mono text-fg-2">.whitehat</span> и симлинки здесь не показываются.
      </div>

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="фильтр по пути…" data-testid="files-filter" />
        </div>
        {!query && (
          <Button variant="ghost" size="sm" data-testid="files-toggle-all"
            title={anyExpanded ? "свернуть все папки" : "развернуть все папки"}
            onClick={() => setExpanded(anyExpanded ? new Set() : new Set(allDirPaths))}>
            {anyExpanded ? "свернуть все" : "развернуть все"}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" title="обновить список" onClick={() => void load()} data-testid="files-refresh">
          <RefreshCw size={13} />
        </Button>
      </div>

      <div className="space-y-0.5">
        {loading && <div className="text-[12.5px] text-dim">Загружаю список файлов…</div>}
        {!loading && !files.length && <div className="text-[12.5px] text-dim">Файлов не видно. Агент сохраняет сканы в scans/, отдачу — в www/.</div>}
        {!loading && !!files.length && (query
          ? files.filter((f) => !f.dir && f.path.toLowerCase().includes(query))
              .map((f) => fileRow({ name: f.name, path: f.path, dir: false, size: f.size, children: [], filesUnder: 0 }, 0, f.path))
          : renderNodes(tree, 0))}
        {!loading && !!query && !files.some((f) => !f.dir && f.path.toLowerCase().includes(query)) && (
          <div className="text-[12.5px] text-dim">По фильтру ничего нет.</div>
        )}
      </div>

      {selected && !selected.dir && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-[11px] tracking-[0.08em] text-fg-2 uppercase" title={selected.path}>Файл · {selected.path}</div>
            <a href={api.fileDownloadUrl(task.id, selected.path)} download data-testid="file-download"
              className="flex h-7 flex-none items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[12px] font-semibold text-black transition hover:brightness-110">
              <Download size={13} /> скачать
            </a>
          </div>
          <pre data-testid="file-preview" className="max-h-96 overflow-auto rounded-[10px] border border-line-2 bg-term px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-2">
            {preview === null ? "Загружаю предпросмотр…" : preview.tooLarge ? "Файл больше 256 КБ — предпросмотр недоступен, скачай его." : preview.binary ? "Бинарный файл — предпросмотр недоступен, скачай его." : preview.text || "(пустой файл)"}
          </pre>
        </div>
      )}
    </div>
  );
}
