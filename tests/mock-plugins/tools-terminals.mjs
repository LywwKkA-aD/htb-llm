// Плагин мока для tests/e2e/22-tools-terminals.spec.ts.
// Директива [[tt:<base64url(JSON)>]] — сценарий агента из нескольких раундов вызовов инструментов:
//   { "rounds": [[{ "name": "shell", "args": { "command": "...", "timeout_sec": 2 } }, ...], ...], "answer": "..." }
// Раунд N выполняется, когда в ответах после сообщения пользователя уже N раундов вызовов. Любые аргументы
// (`]`, переводы строк, timeout_sec, read_rfc, несколько вызовов в раунде) — без ограничений регулярки [[tool:…]].
// В строковых аргументах {{saved}} заменяется на последний путь /work/.whitehat/out-*.txt из прошлых результатов
// (агент grep'ает сохранённый полный вывод).
const RE = /\[\[tt:([A-Za-z0-9_-]+)\]\]/;

export async function handle({ kind, body, userText, afterUser, promptTokens, res, h }) {
  if (kind !== "agent") return false;
  const m = RE.exec(userText);
  if (!m) return false;
  h.requests.push({ kind: "agent", body });
  let plan;
  try { plan = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")); } catch { plan = { rounds: [] }; }
  const rounds = Array.isArray(plan.rounds) ? plan.rounds : [];
  const done = afterUser.filter((x) => x.role === "assistant" && Array.isArray(x.tool_calls) && x.tool_calls.length).length;
  const toolOuts = afterUser.filter((x) => x.role === "tool").map((x) => h.textOf(x.content));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (done < rounds.length && body.tools?.length) {
    const saved = toolOuts.join("\n").match(/\/work\/\.whitehat\/out-[\w.-]+\.txt/g)?.at(-1) ?? "/work/.whitehat/НЕТ-ФАЙЛА";
    const sub = (v) => (typeof v === "string" ? v.replaceAll("{{saved}}", saved) : v);
    await h.streamText(res, "reasoning_content", `Раунд ${done + 1}.`, 0, 10);
    rounds[done].forEach((c, i) => {
      const args = Object.fromEntries(Object.entries(c.args ?? {}).map(([k, v]) => [k, sub(v)]));
      h.chunk(res, { tool_calls: [{ index: i, id: `call_tt_${Date.now()}_${done}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(args) } }] });
    });
    await h.finish(res, "tool_calls", promptTokens, 30);
    return true;
  }
  await h.streamText(res, "content", plan.answer ?? `Итог tt: выполнено раундов ${done}, результатов ${toolOuts.length}.`, 0, 12);
  await h.finish(res, "stop", promptTokens, 20);
  return true;
}
