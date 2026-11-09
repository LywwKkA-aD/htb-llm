// Плагин мока для tests/e2e/24-library.spec.ts (библиотека / RAG).
//   [[lib:docs:<scope>:<k>:<query>]] — модель вызывает search_docs с явными scope и k
//                                      (пустое поле = аргумент не передаётся), потом коротко отвечает.
// Обычный [[tool:docs:<query>]] передаёт только query — для проверки областей поиска этого мало.
export async function handle({ kind, body, userText, toolDone, promptTokens, res, h }) {
  if (kind !== "agent") return false;
  const m = /\[\[lib:docs:([^:\]]*):([^:\]]*):([^\]]*)\]\]/.exec(userText);
  if (!m) return false;
  h.requests.push({ kind: "agent", body });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (!toolDone && body.tools?.length) {
    const args = { query: m[3] };
    if (m[1]) args.scope = m[1];
    if (m[2]) args.k = Number(m[2]);
    h.chunk(res, { tool_calls: [{ index: 0, id: `call_lib_${Date.now()}`, type: "function", function: { name: "search_docs", arguments: JSON.stringify(args) } }] });
    await h.finish(res, "tool_calls", promptTokens, 20);
    return true;
  }
  await h.streamText(res, "content", "Нашёл фрагменты, ссылки выше.", 0, 20);
  await h.finish(res, "stop", promptTokens, 6);
  return true;
}
