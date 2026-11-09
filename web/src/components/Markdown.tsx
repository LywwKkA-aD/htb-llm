import { memo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { Button } from "../ui";

// ---------- формулы в прозе: \( \) и \[ \] → $ и $$, «$HOME … $PATH» и «$$» (PID) — не формулы ----------
// Правка идёт по сырому тексту ДО разбора: в mdast обратные слэши уже съедены (\( → «(»), так что плагин на текстовых
// узлах не годится. Код (```/~~~/отступ/`…`), блоки $$, сырой HTML и автоссылки не трогаются — их границы даёт первый
// разбор micromark (он точно знает списки, цитаты и незакрытый ``` во время потока).

type MdNode = {
  type: string;
  meta?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
};
type Parse = (doc: string, file: never) => MdNode;
type Range = [number, number];
type Marks = { skip: Range[]; inline: Range[]; fences: Range[] };

const OPAQUE = new Set(["code", "inlineCode", "math", "html"]);
const INLINE_ONLY = new Set(["heading", "table"]); // здесь \[…\] не может стать блоком — только формулой в строке

/** Разметка первого разбора (отрезки по возрастанию):
 *  skip   — что правка прозы не трогает: код, блоки $$, сырой HTML, автоссылки (<smb://host/C$>, www.…, http://…);
 *  inline — заголовки и таблицы;
 *  fences — «блоки $$» с текстом после открывающих $$ («$$ — PID оболочки»): это проза, которую micromark принял за
 *           незакрытую формулу до конца пункта/документа. Их содержимое не разобрано (там может быть код), поэтому
 *           они чинятся отдельным проходом и разбираются заново. */
function marks(n: MdNode, doc: string, m: Marks = { skip: [], inline: [], fences: [] }): Marks {
  for (const c of n.children ?? []) {
    const a = c.position?.start.offset, b = c.position?.end.offset;
    if (a === undefined || b === undefined) { marks(c, doc, m); continue; }
    if (c.type === "math" && c.meta?.trim()) { m.fences.push([a, b]); m.skip.push([a, b]); }
    else if (OPAQUE.has(c.type) || (c.type === "link" && doc[a] !== "[")) m.skip.push([a, b]);
    else { if (INLINE_ONLY.has(c.type)) m.inline.push([a, b]); marks(c, doc, m); }
  }
  return m;
}

const PUNCT = /[!-/:-@[-`{-~]/; // ASCII-пунктуация: CommonMark экранирует только её
const SPACE = /\s/;
const AFTER_CLOSE = /[\w{]/; // «$x$USER», «$5-$10», «${A}${B}» — закрывающий $ не может стоять вплотную к этому
const BLANK = /\n[ \t>]*(?=\n)/g; // пустая строка (и пустая строка цитаты) — граница абзаца
// граница абзаца построже — для пары «$$»: ещё и строка нового пункта списка, заголовка или забора кода
// («- $$ — PID\n- $! — PID фона\n- kill $$» — три пункта, а не одна формула)
const PARA = /\n[ \t>]*(?=$|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|`{3}|~{3}|#{1,6}(?:[ \t]|$))/gm;
const PREFIX = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*/; // отступ, «>» и маркеры списка в начале строки
const SPECIAL = /[\\`$hw<]/g; // с чего может начаться что-то интересное
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/y; // <smb://10.0.0.5/C$> — экраны внутри не работают
const WJ = "⁠"; // невидимый разделитель: «$a$⁠$b$» — две формулы, а не одна «a$$b»

/** Готовит сырой markdown для remark-math. Формула $…$ — по правилам pandoc: после открывающего $ не пробел, перед
 *  закрывающим не пробел, и сразу за ним не цифра/буква/_/{; между ними нет ни $, ни `, и всё в одной строке.
 *  $$…$$ на своей строке (или от начала одной строки до конца другой) — блок; внутри строки — только «плотно» ($$x$$).
 *  Всё, что формулой не стало, экранируется (\$): remark-math парует любые два $ и склеил бы «$HOME … $PATH».
 *  fencesOnly — чинить только открывающие $$ из m.fences (см. marks), остальное не трогать. */
function prepMath(s: string, m: Marks, fencesOnly = false): string {
  const out: string[] = [];
  let last = 0;
  const edit = (from: number, to: number, text: string) => { out.push(s.slice(last, from), text); last = to; };
  const prevOut = (i: number) => (i === last && out.length ? out[out.length - 1].slice(-1) : s[i - 1]);
  const n = s.length;
  let stop = n; // дальше этой точки (код и т.п.) прозу не смотрим
  const lineEnd = (i: number) => { const e = s.indexOf("\n", i); return e < 0 || e > stop ? stop : e; };
  const until = (re: RegExp, i: number) => { re.lastIndex = i; const x = re.exec(s); return x && x.index < stop ? x.index : stop; };
  const head = (i: number) => s.slice(s.lastIndexOf("\n", i - 1) + 1, i); // строка до позиции i
  const lineStart = (i: number) => { const h = head(i); return PREFIX.exec(h)![0] === h; };
  const inside = (r: Range[], i: number) => r.some(([a, b]) => a <= i && i < b);

  /** формула в строке: $body$ (с разделителем, если вплотную другой $) */
  const inlineMath = (from: number, to: number, body: string) => {
    edit(from, to, `${prevOut(from) === "$" ? WJ : ""}$${body.trim()}$${s[to] === "$" ? WJ : ""}`);
  };
  /** блок $$ с тем же отступом/«>», что у строки: формула остаётся внутри пункта списка или цитаты. Переводы строки
   *  добавляются, только если на строке до/после формулы есть текст: пустая строка сделала бы плотный список «рыхлым» */
  const block = (from: number, to: number, body: string) => {
    const h = head(from);
    const p = PREFIX.exec(h)![0];
    const pre = p.replace(/[-*+]|\d{1,9}[.)]/g, (x) => " ".repeat(x.length));
    const strip = pre.includes(">") ? /^[ \t>]*/ : /^[ \t]*/;
    const lines = body.split("\n").map((l) => l.replace(strip, "").trimEnd()).filter(Boolean);
    if (!lines.length) return false;
    const before = p === h ? "" : `\n${pre}`;
    const after = /^[ \t]*$/.test(s.slice(to, lineEnd(to))) ? "" : `\n${pre}`;
    edit(from, to, `${before}$$\n${lines.map((l) => pre + l).join("\n")}\n${pre}$$${after}`);
    return true;
  };

  /** $ в позиции i; возвращает, откуда смотреть дальше */
  const dollar = (i: number): number => {
    let k = 1;
    while (s[i + k] === "$") k++;
    if (k === 1) {
      const end = lineEnd(i);
      let j = i + 1, ok = false;
      if (j < end && !SPACE.test(s[j])) {
        for (; j < end; j++) {
          const ch = s[j];
          if (ch === "`" || s.startsWith("://", j)) break;
          if (ch === "\\") { if (/[$([]/.test(s[j + 1] ?? "")) break; j++; continue; }
          if (ch === "$") { ok = s[j + 1] !== "$" && !SPACE.test(s[j - 1]) && !AFTER_CLOSE.test(s[j + 1] ?? ""); break; }
        }
      }
      if (ok) return j + 1;
      edit(i, i + 1, "\\$");
      return i + 1;
    }
    // $$: пара — ближайшая следующая серия $ той же длины. От начала строки до конца строки (в т.ч. «$$ a +⏎b $$»)
    // — блок $$; внутри строки — только плотно ($$x^2$$).
    // «echo $$ … kill $$», «$$ — PID оболочки», «$$ и $! — PID» — текст.
    const atStart = lineStart(i);
    const end = atStart ? until(PARA, i) : lineEnd(i);
    let j = i + k;
    while (j < end && s[j] !== "$" && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
    let r = 0;
    while (j < end && s[j + r] === "$") r++;
    if (r === k) {
      // формула на всю строку (или на несколько строк) — блок, как у pandoc/GitHub
      if (atStart && /^[ \t]*$/.test(s.slice(j + k, lineEnd(j))) && block(i, j + k, s.slice(i + k, j))) return j + k;
      if (j < lineEnd(i) && !SPACE.test(s[i + k]) && !SPACE.test(s[j - 1])) return j + k; // $$…$$ в строке — как есть
    }
    edit(i, i + k, "\\$".repeat(k));
    return i + k;
  };

  if (fencesOnly) {
    for (const [a, b] of m.fences) { stop = b; dollar(a); }
  } else {
    const skip = m.skip;
    let r = 0;
    let i = 0;
    while (i < n) {
      while (r < skip.length && skip[r][1] <= i) r++;
      stop = r < skip.length ? skip[r][0] : n;
      if (i >= stop) { i = skip[r][1]; continue; }
      SPECIAL.lastIndex = i;
      const hit = SPECIAL.exec(s);
      if (!hit || hit.index >= stop) { i = stop; continue; }
      i = hit.index;
      const c = s[i];

      if (c === "\\") {
        const d = s[i + 1];
        if (d === "(" || d === "[") {
          const end = until(BLANK, i);
          const j = s.indexOf(d === "(" ? "\\)" : "\\]", i + 2);
          const body = j >= 0 && j + 2 <= end ? s.slice(i + 2, j) : "";
          if (body.trim() && !/[`$]/.test(body)) {
            // \[…\] в заголовке или ячейке таблицы — формула в строке: блок разорвал бы заголовок/таблицу
            if (d === "(" || (!body.includes("\n") && inside(m.inline, i))) { inlineMath(i, j + 2, body); i = j + 2; continue; }
            if (block(i, j + 2, body)) { i = j + 2; continue; }
          }
        }
        i += d !== undefined && PUNCT.test(d) ? 2 : 1; // \$, \`, \\ и т.п. — уже экранированы, не трогаем
        continue;
      }

      if (c === "`") {
        // инлайн-код, который первый разбор не увидел (его съела ложная формула «$5 … `echo $HOME`»)
        let k = 1;
        while (s[i + k] === "`") k++;
        const end = until(BLANK, i);
        let j = i + k;
        for (;;) {
          j = s.indexOf("`", j);
          if (j < 0 || j >= end) { j = -1; break; }
          let q = 1;
          while (s[j + q] === "`") q++;
          if (q === k) break;
          j += q;
        }
        i = j < 0 ? i + k : j + k;
        continue;
      }

      if (c === "$") { i = dollar(i); continue; }

      // автоссылка <scheme:…>: её $ — часть адреса, а \$ внутри показался бы как есть
      if (c === "<") {
        AUTOLINK.lastIndex = i;
        const a = AUTOLINK.exec(s);
        i = a && i + a[0].length <= stop ? i + a[0].length : i + 1;
        continue;
      }

      // ссылка-автолинк: её $ — часть адреса (\$ испортил бы href), а micromark сам не начнёт в ней формулу
      if ((s.startsWith("http://", i) || s.startsWith("https://", i) || s.startsWith("www.", i)) && !/\w/.test(s[i - 1] ?? "")) {
        const e = /[\s<]/g;
        e.lastIndex = i;
        const x = e.exec(s);
        i = x && x.index < stop ? x.index : stop;
        continue;
      }
      i++;
    }
  }
  if (!last) return s;
  out.push(s.slice(last));
  return out.join("");
}

// Плагин unified: оборачивает парсер remark-parse. Разбор → границы кода → правка прозы → разбор правленого текста.
function remarkTexDelims(this: { parser?: Parse }) {
  const parse = this.parser;
  if (!parse) return;
  this.parser = (doc, file) => {
    if (!/[$\\]/.test(doc)) return parse(doc, file);
    let src = doc;
    let tree = parse(doc, file);
    let m = marks(tree, src);
    // «$$ — PID …» в начале строки: сначала чиним такие «блоки» и разбираем заново — их содержимое ещё не разобрано
    for (let k = 0; k < 8 && m.fences.length; k++) {
      const next = prepMath(src, m, true);
      if (next === src) break;
      src = next;
      tree = parse(src, file);
      m = marks(tree, src);
    }
    const fixed = prepMath(src, m);
    return fixed === src ? tree : parse(fixed, file);
  };
}

// Кнопка — соседка <pre>, а не его ребёнок: <pre> прокручивается по горизонтали и увозил бы её с собой
function Pre({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [ok, setOk] = useState(false);
  return (
    <div className="code-wrap">
      <Button
        size="xs"
        className="copy absolute top-1.5 right-1.5"
        data-testid="code-copy"
        onClick={() => {
          void navigator.clipboard?.writeText(ref.current?.querySelector("code")?.textContent ?? "");
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        }}
      >
        {ok ? <><Check size={12} /> скопировано</> : <><Copy size={12} /> копировать</>}
      </Button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

export const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkTexDelims, remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: false }]]}
        components={{
          pre: Pre,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
          // картинки из ответа модели не грузим сами: ![](https://x/?q=<секрет>) — утечка данных по одному взгляду
          img: ({ src, alt }) => <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer" data-testid="md-image-link">🖼 {alt || "картинка"}</a>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
