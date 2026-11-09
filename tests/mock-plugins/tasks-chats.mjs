// Плагин мока для tests/e2e/20-tasks-chats.spec.ts. Только директивы с префиксом [[tc:…]], чужие запросы не трогает.
//   [[tc:slow]] — очень долгий поток (до ~60 с) «токен0 токен1 …», пока его не остановят:
//                 окно для переключений задач/чатов, удаления и перезагрузки посреди ответа.
export async function handle({ kind, body, userText, promptTokens, res, h }) {
  if (kind !== "agent" || !userText.includes("[[tc:slow]]")) return false;
  h.requests.push({ kind: "agent", body });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  await h.streamText(res, "reasoning_content", "Думаю очень долго…", 0, 6);
  for (let i = 0; i < 1500 && !res.destroyed; i++) {
    h.chunk(res, { content: `токен${i} ` });
    await h.sleep(40);
  }
  if (!res.destroyed) await h.finish(res, "stop", promptTokens, 1500);
  return true;
}
