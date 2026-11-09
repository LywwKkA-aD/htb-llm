// Плагин мока для tests/e2e/35-fix-graph-memory.spec.ts (граф, память, библиотека, клиент LLM).
// Все директивы с префиксом [[gm:…]]; чужие запросы не трогает (return false).
//
// agent:
//   [[gm:two]]   — раунд 1: два вызова shell в одном раунде: «echo GM-FIRST» и «sleep 30; echo GM-LATE»
//                  (сервер роняют посреди второго); после инструментов — «Готово: два вызова.»
//   [[gm:hang]]  — ничего не отвечает (даже заголовки), пока клиент не оборвёт соединение (таймаут первого байта)
//   [[gm:stall]] — заголовки и пара токенов, потом тишина до обрыва (таймаут простоя потока)
// propose (директива видна в расшифровке хода):
//   [[gm:brackets]]     — пояснения со [скобками] и числовым массивом до и после JSON в ```json, скобки внутри строк JSON
//   [[gm:dup]]          — повтор подтверждённого «Шлюз по умолчанию» (другой регистр/пробелы), «Новая находка» дважды,
//                         «Отклонённая находка»
//   [[gm:emoji]]        — заголовок 199 «а» + эмодзи на границе 200, текст 3999 «б» + эмодзи на границе 4000
//   [[gm:card:<title>]] — одна карточка с этим заголовком

const PROPOSE = {
  brackets: () => "Варианты [1, 2] разобраны. Смотри [заметку] ниже:\n```json\n" + JSON.stringify([
    { kind: "command", title: "Скобки [1] в заголовке", content: "grep -c ']' /work/x.txt — считает строки с «]», вывод [3]" },
  ]) + "\n```\n[примечание: остальное — общие знания]",
  dup: () => JSON.stringify([
    { kind: "fact", title: "  шлюз   по УМОЛЧАНИЮ ", content: "повтор уже подтверждённой карточки" },
    { kind: "result", title: "Новая находка", content: "порт 8443 открыт" },
    { kind: "result", title: "новая  находка", content: "тот же порт ещё раз" },
    { kind: "fact", title: "Отклонённая находка", content: "пользователь её отклонит" },
  ]),
  emoji: () => JSON.stringify([
    { kind: "fact", title: "а".repeat(199) + "😀 хвост заголовка", content: "б".repeat(3999) + "😀 хвост текста" },
  ]),
};

async function sse(res, h, text, finish = "stop", promptTokens = 300) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  await h.streamText(res, "content", text, 0, 40);
  await h.finish(res, finish, promptTokens, 80);
}
const closed = (res) => new Promise((r) => { if (res.destroyed || res.writableEnded) r(); else res.on("close", r); });

export async function handle(ctx) {
  const { kind, body, userText, afterUser, promptTokens, res, h } = ctx;
  if (!userText.includes("[[gm:")) return false;

  if (kind === "propose") {
    const card = /\[\[gm:card:([^\]]+)\]\]/.exec(userText);
    const m = /\[\[gm:(brackets|dup|emoji)\]\]/.exec(userText);
    if (!card && !m) return false;
    h.requests.push({ kind: "propose", body });
    const text = card
      ? JSON.stringify([{ kind: "fact", title: card[1].trim(), content: `содержимое: ${card[1].trim()}` }])
      : PROPOSE[m[1]]();
    await sse(res, h, text);
    return true;
  }

  if (kind !== "agent") return false;
  if (userText.includes("[[gm:hang]]")) {
    h.requests.push({ kind: "agent", body });
    await closed(res); // как llama-server, занятый чужим запросом: ни заголовков, ни данных
    return true;
  }
  if (userText.includes("[[gm:stall]]")) {
    h.requests.push({ kind: "agent", body });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    await h.streamText(res, "content", "Начинаю отвечать", 0, 6);
    await closed(res); // поток замолчал посреди ответа
    return true;
  }
  if (userText.includes("[[gm:two]]")) {
    h.requests.push({ kind: "agent", body });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const tools = afterUser.filter((x) => x.role === "tool").length;
    if (body.tools?.length && tools === 0) {
      const calls = [["echo GM-FIRST"], ["sleep 30; echo GM-LATE"]];
      calls.forEach(([cmd], i) => h.chunk(res, { tool_calls: [{ index: i, id: `call_gm_${Date.now()}_${i}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: cmd }) } }] }));
      await h.finish(res, "tool_calls", promptTokens, 30);
      return true;
    }
    await h.streamText(res, "content", "Готово: два вызова.", 0, 6);
    await h.finish(res, "stop", promptTokens, 10);
    return true;
  }
  return false;
}
