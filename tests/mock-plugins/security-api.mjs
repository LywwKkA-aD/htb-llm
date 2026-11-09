// Плагин мока для набора security-api. Директивы с префиксом [[sec:...]].
//   [[sec:xss]] — ответ модели с «сырым» HTML и javascript:-ссылками (проверка, что markdown
//                 рендерит их как текст и не выполняет; экранирование + defaultUrlTransform).
// Проверяется в tests/e2e/26-security-api.spec.ts. Остальные сценарии берут штатный мок.
export async function handle({ kind, userText, promptTokens, res, h }) {
  if (kind !== "agent") return false;

  if (userText.includes("[[sec:xss]]")) {
    h.requests.push({ kind: "agent", body: {} });
    // payload: onerror=alert сработал бы при рендере как HTML (guard-фикстура поймала бы alert);
    // <script> не исполнится; javascript:-ссылки должны быть обезврежены react-markdown.
    const answer = [
      "## Ответ",
      'Картинка: <img src=x onerror=alert(1)>',
      "<script>alert(2)</script>",
      "[опасная ссылка](javascript:alert(3))",
      "![опасная картинка](javascript:alert(4))",
      "Обычный текст и `код` ниже.",
    ].join("\n\n");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    await h.streamText(res, "content", answer, 0, 12);
    return h.finish(res, "stop", promptTokens, 40);
  }

  return false;
}
