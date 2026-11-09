// Загрузка базы знаний для HTB в общую библиотеку (RAG): HackTricks, PayloadsAllTheThings,
// InternalAllTheThings, GTFOBins, LOLBAS + собственные гайды из knowledge/.
// Контент НЕ входит в репозиторий проекта: скрипт качает его в data/knowledge (gitignored)
// и индексирует в локальную базу пользователя. Точные коммиты зафиксированы в
// knowledge/sources.lock.json (WH_KNOWLEDGE_LATEST=1 — игнорировать lock и брать свежие HEAD).
// Лицензии источников — в манифесте data/knowledge/manifest.json; для личного локального использования.
//   pnpm knowledge [--only hacktricks] [--skip-clone] [--generate-only] [--force] [--list]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DATA, ROOT } from "../src/server/config.ts";
import { db, type Doc } from "../src/server/db.ts";
import * as library from "../src/server/library.ts";

const KDIR = path.join(DATA, "knowledge");
const SRC = path.join(KDIR, "src");
const PACKS = path.join(KDIR, "packs");
const MANIFEST = path.join(KDIR, "manifest.json");
for (const d of [SRC, PACKS]) fs.mkdirSync(d, { recursive: true });

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const only = (() => { const i = args.indexOf("--only"); return i >= 0 ? String(args[i + 1] ?? "") : ""; })();
const USE_LATEST = process.env.WH_KNOWLEDGE_LATEST === "1";
const SOURCE_LOCKS: Record<string, { repo?: string; commit?: string }> = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "knowledge", "sources.lock.json"), "utf8"))?.sources ?? {}; }
  catch { return {}; }
})();

// ---------- источники ----------
type Pack = { file: string; roots: string[]; deny?: string[]; render: "md" | "yaml"; exts: string[] };
type Source = { id: string; repo: string; license: string; sparse?: string[]; packs: Pack[] };

const SOURCES: Source[] = [
  {
    id: "hacktricks",
    repo: "https://github.com/HackTricks-wiki/hacktricks.git",
    license: "CC BY-NC 4.0 (src/LICENSE.md)",
    sparse: [
      "src/network-services-pentesting/**/*.md", "src/pentesting-web/**/*.md",
      "src/linux-hardening/**/*.md", "src/windows-hardening/**/*.md",
      "src/generic-methodologies-and-resources/**/*.md", "src/generic-hacking/**/*.md",
      "src/crypto/**/*.md", "src/stego/**/*.md", "src/SUMMARY.md", "src/LICENSE.md",
    ],
    packs: [
      { file: "hacktricks-network-services.md", roots: ["src/network-services-pentesting"], render: "md", exts: [".md"] },
      { file: "hacktricks-pentesting-web.md", roots: ["src/pentesting-web"], render: "md", exts: [".md"] },
      { file: "hacktricks-linux-hardening.md", roots: ["src/linux-hardening"], render: "md", exts: [".md"] },
      { file: "hacktricks-windows-hardening.md", roots: ["src/windows-hardening"], render: "md", exts: [".md"] },
      {
        file: "hacktricks-methodology.md", render: "md", exts: [".md"],
        roots: ["src/generic-methodologies-and-resources", "src/generic-hacking", "src/crypto", "src/stego"],
        deny: ["pentesting-wifi", "basic-forensic-methodology", "phishing-methodology"],
      },
    ],
  },
  {
    id: "payloadsallthethings",
    repo: "https://github.com/swisskyrepo/PayloadsAllTheThings.git",
    license: "MIT",
    packs: [{ file: "payloadsallthethings.md", roots: ["."], deny: [".github"], render: "md", exts: [".md"] }],
  },
  {
    id: "internalallthethings",
    repo: "https://github.com/swisskyrepo/InternalAllTheThings.git",
    license: "нет файла лицензии (all rights reserved) — только локальное использование",
    packs: [{ file: "internalallthethings.md", roots: ["docs"], deny: ["docs/cloud"], render: "md", exts: [".md"] }],
  },
  {
    id: "gtfobins",
    repo: "https://github.com/GTFOBins/GTFOBins.github.io.git",
    license: "GPL-3.0",
    packs: [{ file: "gtfobins.md", roots: ["_gtfobins"], render: "yaml", exts: [""] }],
  },
  {
    id: "lolbas",
    repo: "https://github.com/LOLBAS-Project/LOLBAS.git",
    license: "GPL-3.0",
    packs: [{ file: "lolbas.md", roots: ["yml"], deny: ["Archive-Old-Version"], render: "yaml", exts: [".yml", ".yaml"] }],
  },
];

// ---------- git ----------
function git(dir: string, a: string[], quiet = false) {
  const r = spawnSync("git", ["-C", dir, ...a], { stdio: quiet ? "pipe" : "inherit" });
  return r;
}
function checkoutLocked(dir: string, s: Source): boolean {
  const commit = USE_LATEST ? "" : String(SOURCE_LOCKS[s.id]?.commit ?? "");
  if (!commit) return true;
  const head = git(dir, ["rev-parse", "HEAD"], true);
  if (head.status === 0 && String(head.stdout).trim() === commit) return true;
  console.log(`[${s.id}] фиксирую коммит из sources.lock.json: ${commit.slice(0, 12)}…`);
  if (git(dir, ["fetch", "--depth", "1", "origin", commit]).status !== 0) {
    console.error(`[${s.id}] не удалось скачать зафиксированный коммит ${commit}`);
    return false;
  }
  if (git(dir, ["checkout", "--detach", "FETCH_HEAD"]).status !== 0) {
    console.error(`[${s.id}] checkout зафиксированного коммита не удался`);
    return false;
  }
  return true;
}
function cloneOrUpdate(s: Source): string | null {
  const dir = path.join(SRC, s.id);
  const locked = !USE_LATEST && !!SOURCE_LOCKS[s.id]?.commit;
  if (fs.existsSync(path.join(dir, ".git"))) {
    if (!locked) {
      console.log(`[${s.id}] обновляю…`);
      if (git(dir, ["pull", "--ff-only"]).status !== 0) console.warn(`[${s.id}] pull не удался — беру что есть`);
    }
  } else {
    console.log(`[${s.id}] клонирую ${s.repo}…`);
    fs.mkdirSync(SRC, { recursive: true });
    const base = s.sparse
      ? ["clone", "--depth", "1", "--single-branch", "--branch", "master", "--filter=blob:none", "--sparse", s.repo, dir]
      : ["clone", "--depth", "1", s.repo, dir];
    if (spawnSync("git", base, { stdio: "inherit" }).status !== 0) { console.error(`[${s.id}] клон не удался`); return null; }
    if (s.sparse && git(dir, ["sparse-checkout", "set", "--no-cone", ...s.sparse]).status !== 0) { console.error(`[${s.id}] sparse-checkout не удался`); return null; }
  }
  if (!checkoutLocked(dir, s)) return null;
  const head = git(dir, ["rev-parse", "HEAD"], true);
  return head.status === 0 ? String(head.stdout).trim() : null;
}

// ---------- сборка паков ----------
// Чистка markdown: директивы препроцессоров ({{…}}, {% …%}), картинки и рекламные баннеры — шум для эмбеддингов.
// Заголовки понижаются на уровень (вне блоков кода), чтобы H1 пака оставался путём файла (breadcrumb в чанках).
function cleanMd(text: string): string {
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !f[2].trim()) fence = null;
      out.push(line);
      continue;
    }
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) { fence = { ch: f[1][0], len: f[1].length }; out.push(line); continue; }
    if (/^\s*(\{\{|%\}|\{%)/.test(line)) continue;                       // директивы mdBook/GitBook и баннеры
    if (/hacktricks-training|support-hacktricks/i.test(line) && line.length < 400) continue;
    const demoted = line.replace(/^ {0,3}(#{1,5})(\s)/, "#$1$2");
    out.push(demoted.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<img[^>]*>/gi, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function walk(dir: string, acc: string[] = []): string[] {
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== ".git") walk(p, acc); }
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

function buildPack(srcDir: string, pack: Pack): { files: number; bytes: number } | null {
  const parts: string[] = [];
  let files = 0;
  for (const root of pack.roots) {
    for (const abs of walk(path.join(srcDir, root))) {
      const rel = path.relative(srcDir, abs);
      if (path.basename(abs) === "SUMMARY.md" || path.basename(abs) === "LICENSE.md") continue;
      if (pack.deny?.some((d) => rel.includes(d))) continue;
      if (!pack.exts.includes(path.extname(abs).toLowerCase())) continue;
      const raw = fs.readFileSync(abs, "utf8");
      if (raw.length > 2_000_000) { console.warn(`  пропуск (>2 МБ): ${rel}`); continue; }
      files++;
      parts.push(pack.render === "yaml"
        ? `# ${rel}\n\n\`\`\`yaml\n${raw.trim()}\n\`\`\``
        : `# ${rel}\n\n${cleanMd(raw)}`);
    }
  }
  if (!files) return null;
  const body = parts.join("\n\n---\n\n") + "\n";
  fs.writeFileSync(path.join(PACKS, pack.file), body);
  return { files, bytes: Buffer.byteLength(body) };
}

// ---------- манифест и индексация ----------
type Manifest = { packs: Record<string, { sha256: string; source?: string; commit?: string | null; license?: string; indexedAt?: number; chunks?: number }> };
const loadManifest = (): Manifest => { try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return { packs: {} }; } };
const saveManifest = (m: Manifest) => fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");
const sha256File = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function indexPack(filePath: string, name: string): Promise<Doc> {
  const old = db.prepare("select * from docs where name=? and task_id is null").get(name) as Doc | undefined;
  if (old) library.deleteDoc(old.id);
  const doc = library.addDoc(filePath, name, null);
  const t0 = Date.now();
  for (;;) {
    const d = db.prepare("select * from docs where id=?").get(doc.id) as Doc;
    if (d.status === "ready") return d;
    if (d.status === "error") throw new Error(d.error || "ошибка индексации");
    if (Date.now() - t0 > 30 * 60_000) throw new Error("индексация не уложилась в 30 минут (сервер эмбеддингов жив?)");
    await sleep(2000);
  }
}

type Job = { name: string; path: string; source: string; commit: string | null; license: string };

async function main() {
  const manifest = loadManifest();
  if (flag("--list")) {
    for (const s of SOURCES) for (const p of s.packs) {
      const d = db.prepare("select status,chunks from docs where name=? and task_id is null").get(p.file) as { status: string; chunks: number } | undefined;
      console.log(`${p.file.padEnd(38)} ${d ? `${d.status}, ${d.chunks} фрагментов` : "нет в библиотеке"}  (${s.id})`);
    }
    for (const f of fs.readdirSync(path.join(ROOT, "knowledge")).filter((x) => x.endsWith(".md"))) {
      const d = db.prepare("select status,chunks from docs where name=? and task_id is null").get(f) as { status: string; chunks: number } | undefined;
      console.log(`${f.padEnd(38)} ${d ? `${d.status}, ${d.chunks} фрагментов` : "нет в библиотеке"}  (свои гайды)`);
    }
    return;
  }

  const jobs: Job[] = [];
  // свои гайды из knowledge/ — без сети и всегда
  for (const f of fs.readdirSync(path.join(ROOT, "knowledge")).filter((x) => x.endsWith(".md")).sort()) {
    if (!only || f.includes(only)) jobs.push({ name: f, path: path.join(ROOT, "knowledge", f), source: "whitehat-agent knowledge/", commit: null, license: "свои материалы проекта" });
  }
  for (const s of SOURCES) {
    if (only && !s.id.includes(only) && !s.packs.some((p) => p.file.includes(only))) continue;
    const dir = path.join(SRC, s.id);
    const commit = flag("--skip-clone") ? (fs.existsSync(path.join(dir, ".git")) ? String(git(dir, ["rev-parse", "HEAD"], true).stdout).trim() || null : null) : cloneOrUpdate(s);
    if (!fs.existsSync(dir)) { console.error(`[${s.id}] нет исходников в ${dir} — пропуск`); continue; }
    for (const p of s.packs) {
      if (only && !p.file.includes(only) && !s.id.includes(only)) continue;
      const built = buildPack(dir, p);
      if (!built) { console.warn(`[${s.id}] пак ${p.file}: файлов не нашлось — пропуск`); continue; }
      console.log(`[${s.id}] ${p.file}: ${built.files} файлов, ${(built.bytes / 1048576).toFixed(2)} МБ`);
      jobs.push({ name: p.file, path: path.join(PACKS, p.file), source: s.repo, commit, license: s.license });
    }
  }

  if (!flag("--generate-only") && jobs.length) {
    // Пустой индекс подтянуть под размерность активной модели (свежая установка сразу на внешнем
    // эмбеддинге); непустой чужой размерности — стоп сейчас, а не ошибка на каждом паке после удалений.
    try {
      await library.ensureIndexDim();
      await library.assertEmbedDimMatchesIndex();
    } catch (e) {
      console.error(`ОСТАНОВ: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  let failed = 0;
  for (const j of jobs) {
    const sha = sha256File(j.path);
    const prev = manifest.packs[j.name];
    manifest.packs[j.name] = { sha256: sha, source: j.source, commit: j.commit, license: j.license, indexedAt: prev?.indexedAt, chunks: prev?.chunks };
    if (flag("--generate-only")) { console.log(`— ${j.name}: только генерация`); continue; }
    const existing = db.prepare("select status from docs where name=? and task_id is null").get(j.name) as { status: string } | undefined;
    if (!flag("--force") && prev?.sha256 === sha && existing?.status === "ready") { console.log(`= ${j.name}: без изменений`); continue; }
    try {
      console.log(`+ ${j.name}: индексирую (эмбеддинги)…`);
      const d = await indexPack(j.path, j.name);
      manifest.packs[j.name].indexedAt = Date.now();
      manifest.packs[j.name].chunks = d.chunks;
      console.log(`  готово: ${d.chunks} фрагментов`);
    } catch (e) {
      failed++;
      console.error(`  ОШИБКА ${j.name}: ${(e as Error).message}`);
    } finally {
      saveManifest(manifest);
    }
  }
  saveManifest(manifest);
  console.log(`\nИтого паков: ${jobs.length}, с ошибками: ${failed}. Манифест: ${path.relative(ROOT, MANIFEST)}`);
  if (failed) process.exitCode = 1;
}

try { await main(); } finally { try { db.close(); } catch { /* ignore */ } }
