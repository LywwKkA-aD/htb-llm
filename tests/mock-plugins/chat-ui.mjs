// Плагин мока для tests/e2e/21-chat-ui.spec.ts (область chat-ui). Директивы:
//   [[chatui:say:<base64url>]]       — ответ ровно этим текстом (utf-8 в base64url): markdown/HTML/LaTeX из теста
//   [[chatui:lines:<n>:<ms>]]        — n абзацев, по одному раз в <ms> мс (автопрокрутка во время потока)
//   [[chatui:think:<n>:<ms>]]        — медленные размышления (n кусков по <ms> мс), затем медленный ответ (столько же)
// Служебные вызовы (память, резюме) плагин не трогает.
export async function handle({ kind, body, userText, promptTokens, res, h }) {
  if (kind !== "agent" || !userText.includes("[[chatui:")) return false;
  h.requests.push({ kind: "agent", body });

  const say = /\[\[chatui:say:([A-Za-z0-9_-]+={0,2})\]\]/.exec(userText);
  if (say) {
    const text = Buffer.from(say[1], "base64url").toString("utf8");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    await h.streamText(res, "reasoning_content", "Формирую ответ.", 0, 8);
    await h.streamText(res, "content", text, 1, 40);
    await h.finish(res, "stop", promptTokens, Math.ceil(text.length / 4));
    return true;
  }

  const lines = /\[\[chatui:lines:(\d+):(\d+)\]\]/.exec(userText);
  if (lines) {
    const n = Number(lines[1]), ms = Number(lines[2]);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    await h.streamText(res, "reasoning_content", "Пишу длинный ответ.", 0, 8);
    for (let i = 1; i <= n && !res.destroyed; i++) {
      h.chunk(res, { content: `Строка ${i}: поток для проверки автопрокрутки ленты.\n\n` });
      await h.sleep(ms);
    }
    if (!res.destroyed) await h.finish(res, "stop", promptTokens, n * 10);
    return true;
  }

  const think = /\[\[chatui:think:(\d+):(\d+)\]\]/.exec(userText);
  if (think) {
    const n = Number(think[1]), ms = Number(think[2]);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (let i = 1; i <= n && !res.destroyed; i++) { h.chunk(res, { reasoning_content: `мысль${i} ` }); await h.sleep(ms); }
    for (let i = 1; i <= n && !res.destroyed; i++) { h.chunk(res, { content: `ответ${i} ` }); await h.sleep(ms); }
    if (!res.destroyed) await h.finish(res, "stop", promptTokens, n * 2);
    return true;
  }
  return false;
}
