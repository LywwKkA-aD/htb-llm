// Плагин мока для tests/e2e/25-context.spec.ts (управление контекстом). Директивы:
//   [[ctx:tok:<N>]]   — короткий ответ «Коротко: принято.» с usage.prompt_tokens = N (completion = 5):
//                       точное управление порогом сворачивания (state.promptTokens = prompt + completion)
//   [[ctx:edge]]      — цепочка инструментов у порога 75% окна (65536 * 0.75 = 49152):
//                       раунд 1: shell с prompt+completion = 49152 (ещё можно), раунд 2: 49153 (уже нельзя),
//                       без инструментов — итоговый ответ
//   [[ctx:bigslow]]   — раунд 1: shell с prompt_tokens 15000; после инструмента — бесконечно медленный ответ (для «стоп»)
// Резюме (служебный вызов сворачивания) плагин обрабатывает, только если в сворачиваемом диалоге есть «[[ctx:»:
//   ответ — «- ctx-резюме: ХОД-1, ХОД-2…» (все метки ХОД-N из запроса: предыдущее резюме + диалог) —
//   так тест видит, что новое резюме вобрало предыдущее.
//   [[ctx:sumfail]] — HTTP 500 на резюме, [[ctx:sumlen]] — резюме обрезано (finish=length),
//   [[ctx:sumslow]] — резюме пишется очень долго (для «стоп»);
//   все три отменяются, если в сворачиваемом диалоге есть [[ctx:sumok]].
export async function handle({ kind, body, msgs, userText, afterUser, promptTokens, res, h }) {
  if (kind === "summary") {
    const src = h.textOf(msgs[1]?.content ?? "");
    if (!src.includes("[[ctx:")) return false;
    h.requests.push({ kind: "summary", body });
    const ok = src.includes("[[ctx:sumok]]");
    if (src.includes("[[ctx:sumfail]]") && !ok) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock: резюме не удалось" } }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (src.includes("[[ctx:sumslow]]") && !ok) { // долгое резюме — для «стоп» во время сворачивания
      for (let i = 0; i < 1500 && !res.destroyed; i++) { h.chunk(res, { content: `- пункт ${i}\n` }); await h.sleep(40); }
      if (!res.destroyed) await h.finish(res, "stop", 500, 1500);
      return true;
    }
    if (src.includes("[[ctx:sumlen]]") && !ok) {
      await h.streamText(res, "content", "- ctx-резюме: начало, оборвано на полуслове", 0, 20);
      await h.finish(res, "length", 500, 1400);
      return true;
    }
    const tags = [...new Set(src.match(/ХОД-\d+/g) ?? [])].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
    await h.streamText(res, "content", `- ctx-резюме: ${tags.join(", ") || "пусто"}`, 0, 20);
    await h.finish(res, "stop", 500, 30);
    return true;
  }
  if (kind !== "agent" || !userText.includes("[[ctx:")) return false;

  const tok = /\[\[ctx:tok:(\d+)\]\]/.exec(userText);
  if (tok) {
    h.requests.push({ kind: "agent", body });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    await h.streamText(res, "content", "Коротко: принято.", 0, 6);
    await h.finish(res, "stop", Number(tok[1]), 5);
    return true;
  }

  const tools = afterUser.filter((m) => m.role === "tool").length;
  const call = (cmd) => h.chunk(res, { tool_calls: [{ index: 0, id: `call_ctx_${Date.now()}_${tools}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: cmd }) } }] });

  if (userText.includes("[[ctx:edge]]")) {
    h.requests.push({ kind: "agent", body });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (body.tools?.length && tools < 2) {
      await h.streamText(res, "reasoning_content", `Раунд ${tools + 1}.`, 0, 10);
      call(`echo CTX-EDGE-${tools + 1}`);
      await h.finish(res, "tool_calls", tools === 0 ? 49122 : 49123, 30); // 49152 — ровно порог (не больше), 49153 — уже больше
      return true;
    }
    await h.streamText(res, "content", "Итог: контекст почти заполнен, отвечаю по уже полученным результатам.", 0, 12);
    await h.finish(res, "stop", 49400, 20);
    return true;
  }

  if (userText.includes("[[ctx:bigslow]]")) {
    h.requests.push({ kind: "agent", body });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (body.tools?.length && tools === 0) {
      call("echo CTX-BIGSLOW");
      await h.finish(res, "tool_calls", 15000, 30);
      return true;
    }
    await h.streamText(res, "reasoning_content", "Пишу долго…", 0, 4);
    for (let i = 0; i < 1500 && !res.destroyed; i++) { h.chunk(res, { content: `часть${i} ` }); await h.sleep(40); }
    if (!res.destroyed) await h.finish(res, "stop", 15100, 1500);
    return true;
  }
  return false;
}
