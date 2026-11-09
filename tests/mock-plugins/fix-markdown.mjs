// Плагин мока для tests/e2e/31-fix-markdown.spec.ts (markdown: формулы, код, $ в прозе). Директивы:
//   [[fixmd:say:<base64url>]]                    — ответ ровно этим текстом (utf-8 в base64url)
//   [[fixmd:hold:<base64url>:<base64url>:<ms>]]  — первая часть, пауза <ms> (ход ещё идёт), затем вторая часть
// Служебные вызовы (память, резюме) плагин не трогает.
const b64 = (s) => Buffer.from(s, "base64url").toString("utf8");

export async function handle({ kind, body, userText, promptTokens, res, h }) {
  if (kind !== "agent" || !userText.includes("[[fixmd:")) return false;
  h.requests.push({ kind: "agent", body });

  const say = /\[\[fixmd:say:([A-Za-z0-9_-]+={0,2})\]\]/.exec(userText);
  if (say) {
    const text = b64(say[1]);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    await h.streamText(res, "content", text, 1, 40);
    await h.finish(res, "stop", promptTokens, Math.ceil(text.length / 4));
    return true;
  }

  const hold = /\[\[fixmd:hold:([A-Za-z0-9_-]+={0,2}):([A-Za-z0-9_-]+={0,2}):(\d+)\]\]/.exec(userText);
  if (hold) {
    const a = b64(hold[1]), b = b64(hold[2]);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    await h.streamText(res, "content", a, 1, 40);
    await h.sleep(Number(hold[3]));
    if (res.destroyed) return true;
    await h.streamText(res, "content", b, 1, 40);
    await h.finish(res, "stop", promptTokens, Math.ceil((a.length + b.length) / 4));
    return true;
  }
  return false;
}
