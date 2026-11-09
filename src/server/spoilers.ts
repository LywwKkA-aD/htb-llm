// Политика спойлеров: пользователь решает задачи САМ, поэтому готовые решения и прохождения
// машин (writeups/walkthrough HTB и CTF) модели недоступны — ни поиском, ни чтением страниц,
// ни curl-ом в shell. Детект эвристический, по токенам URL/заголовка/начала текста: слово решения
// (walkthrough/writeup/прохождение/решение) вместе с контекстом CTF или именем текущей задачи,
// либо имя задачи вместе с контекстом CTF (формат «htb-<машина>» у райтапов без явного слова).
// Техническая документация, методики и эксплойты по версиям спойлерами не являются.
const STRONG = /walk ?through|write ?ups?|райтап/;
const SOLUTION_RU = /прохождени|решени/;
const CTF_TOKENS = ["htb", "hackthebox", "tryhackme", "vulnhub", "ctf"];
const NAME_STOP = new Set(["htb", "hackthebox", "hack", "the", "box", "machine", "задача", "машина", "task", "and", "для"]);

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, " ").replace(/\s+/g, " ").trim()} `;
const hasTok = (normed: string, tok: string) => normed.includes(` ${tok} `);

// Токены имени задачи для детекта: название («Blocky», «Two Million») и hostname без суффикса.
export function taskNameTokens(title: string, hostname: string): string[] {
  const raw = `${title ?? ""} ${(hostname ?? "").replace(/\.(htb|local|lan|internal)$/i, "")}`;
  const toks = (norm(raw).split(" ").filter(Boolean)).filter((w) => w.length >= 3 && !NAME_STOP.has(w));
  // склеенное имя целиком (Two Million -> twomillion) — так оно встречается в URL райтапов
  const glued = norm(title ?? "").replace(/ /g, "");
  if (glued.length >= 5 && !toks.includes(glued)) toks.push(glued);
  return [...new Set(toks)];
}

// Похоже ли (URL, заголовок или начало текста) на готовое решение задачи.
export function looksLikeWriteup(text: string, taskNames: string[]): boolean {
  if (!text) return false;
  const t = norm(text);
  const strong = STRONG.test(t);
  const solution = strong || SOLUTION_RU.test(t);
  const ctf = t.includes(" hack the box ") || CTF_TOKENS.some((w) => hasTok(t, w));
  const task = taskNames.some((n) => n && hasTok(t, n)) || taskNames.some((n) => n && n.length >= 5 && t.replace(/ /g, "").includes(n));
  return (solution && (ctf || task)) || (task && ctf);
}

// Пользователь сам прямо просит показать решение — только он может снять запрет, и только на этот ход.
// Считается по тексту ЕГО сообщения на сервере, модель это разрешение себе выписать не может.
// Разрешение — только явная просьба: глагол («покажи/дай/открой/можно…») рядом с термином решения.
// Одно упоминание термина (в т.ч. в URL или «видел writeup случайно») разрешением НЕ является.
const SPOILER_TERM = "(?:write[-\\s]?ups?|walk[-\\s]?through|райтап\\w*|спойлер\\w*|решени\\w*|прохождени\\w*)";
const GIVE = "(?:покаж\\w*|показыва\\w*|дай\\w*|давай\\w*|откро\\w*|открыва\\w*|пришл\\w*|скин\\w*|найд\\w*|посмотр\\w*|почита\\w*|читай\\w*|можно|разреша\\w*|show|open|give|find)";
export function userAskedSpoilers(text: string): boolean {
  const t = ` ${(text ?? "").toLowerCase()} `;
  // отрицание у глагола или термина («не показывай решение», «без райтапов», «не надо решений») — не разрешение
  if (/(^|\s)не\s+(?:покаж|показыва|давай|откро|открыва|чита|смотр|ищ|надо|нужн|хоч|надо)/.test(t)) return false;
  if (/(^|\s)(?:не|без|никаких)(?:\s+\S+){0,3}?\s+(?:write|walk|райтап|спойлер|решени|прохождени)/.test(t)) return false;
  return new RegExp(`${GIVE}[^.!?\\n]{0,40}${SPOILER_TERM}`).test(t)
    || new RegExp(`${SPOILER_TERM}[^.!?\\n]{0,25}${GIVE}`).test(t);
}

// Текст модели при блокировке чтения страницы: честно пользователю, без пересказа и без обходов.
export const SPOILER_BLOCK_TEXT =
  "ошибка: запрещено политикой обучения — это похоже на готовое решение/writeup задачи, а пользователь решает сам. " +
  "Не читай и не пересказывай решения машин HTB/CTF и не ищи зеркала или кэши этой страницы. " +
  "Скажи пользователю одним предложением, что нашёлся writeup и ты его не открываешь; откроется только если он сам прямо попросит («покажи решение»). " +
  "Продолжай по технике: search_docs, документация сервисов и инструментов, эксплойты по версиям.";
