// Плагин мока для tests/e2e/23-memory.spec.ts — странные ответы служебного вызова «память задачи» и search_memory c all_tasks.
// Все директивы с префиксом [[mem:…]], чужие запросы не трогает (return false).
//
// propose (директива видна в расшифровке хода — там текст пользователя):
//   [[mem:fence]]   — JSON внутри ```json-блока (2 карточки)
//   [[mem:prose]]   — пояснения до и после JSON, без скобок в тексте (2 карточки)
//   [[mem:object]]  — массив внутри объекта {"cards":[…]} (1 карточка)
//   [[mem:tail]]    — JSON, а после него примечание со [скобками] (2 карточки в JSON)
//   [[mem:garbage]] — вообще не JSON
//   [[mem:broken]]  — обрезанный JSON (finish=length)
//   [[mem:error]]   — HTTP 500 на служебный вызов
//   [[mem:mixed]]   — битые элементы, неизвестный вид, HTML в заголовке и 4 валидные карточки
//   [[mem:long]]    — заголовок 500 символов и текст 6400 символов без пробелов
//   [[mem:dup:<заголовок>]] — повтор уже существующего заголовка + две одинаковые новые
//   [[mem:vlan]]    — две карточки, похожие на запрос «vlan trunk секретная метка» (для проверки фильтра статуса)
// agent:
//   [[mem:all:<запрос>]]    — search_memory с all_tasks=true
//   [[mem:allstr:<запрос>]] — search_memory с all_tasks="false" (строкой, как иногда присылает модель)

const PROPOSE = {
  fence: () => "```json\n" + JSON.stringify([
    { kind: "command", title: "Карточка из блока кода", content: "ip -br addr — краткий список адресов интерфейсов" },
    { kind: "fact", title: "Шлюз из блока кода", content: "default via 172.17.0.1 dev eth0" },
  ], null, 2) + "\n```",
  prose: () => "Вот что стоит сохранить по итогам хода:\n\n" + JSON.stringify([
    { kind: "step", title: "Карточка из пояснения", content: "проверили ARP-таблицу: ip neigh show" },
    { kind: "result", title: "Итог из пояснения", content: "шлюз отвечает, MAC 02:42:ac:11:00:01" },
  ]) + "\n\nОстальное — общие знания, их не сохраняю.",
  object: () => JSON.stringify({ cards: [{ kind: "mistake", title: "Карточка из объекта", content: "ping без -c не завершается — всегда указывать -c 3" }] }),
  tail: () => JSON.stringify([
    { kind: "command", title: "Карточка перед примечанием", content: "ss -tlnp — слушающие TCP-порты" },
    { kind: "fact", title: "Вторая перед примечанием", content: "sshd слушает 0.0.0.0:22" },
  ]) + "\n\nПримечание: [общие знания] из учебника не сохраняю.",
  garbage: () => "Сохранять нечего: всё это общие знания из учебника.",
  broken: () => '[{"kind":"fact","title":"Обрезанная карточка","content":"ответ оборвался на сере',
  mixed: () => JSON.stringify([
    null,
    "просто строка",
    { kind: "fact", content: "нет заголовка" },
    { kind: "command", title: "   ", content: "пустой заголовок" },
    { kind: "step", title: "Пустой текст", content: "" },
    { kind: "fact", title: 123, content: "заголовок — число" },
    { kind: "weird", title: "Неизвестный вид", content: "вид карточки не из списка" },
    { kind: "step", title: "<b>жирный</b> & <img src=x onerror=alert(1)>", content: "<script>alert(2)</script> разметка как текст" },
    { kind: "result", title: "Итог разбора", content: "три валидные карточки из восьми элементов" },
    { kind: "mistake", title: "Четвёртая валидная", content: "лишняя — больше трёх не сохраняется" },
  ]),
  long: () => JSON.stringify([{
    kind: "fact",
    title: "Очень длинный заголовок карточки ".repeat(16).trim(), // ~530 символов
    content: "Длинный вывод: " + "0123456789abcdef".repeat(400), // 6415 символов, без пробелов
  }]),
  vlan: () => JSON.stringify([
    { kind: "fact", title: "Черновик VLAN trunk", content: "vlan trunk секретная метка — ещё не подтверждено" },
    { kind: "fact", title: "Отклонённый VLAN trunk", content: "vlan trunk секретная метка — отклонено пользователем" },
  ]),
};

async function sse(res, h, text, finish = "stop", promptTokens = 300) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  await h.streamText(res, "content", text, 0, 40);
  await h.finish(res, finish, promptTokens, 80);
}

export async function handle(ctx) {
  const { kind, body, userText, toolDone, promptTokens, afterUser, res, h } = ctx;

  if (kind === "propose") {
    const dup = /\[\[mem:dup:([^\]]+)\]\]/.exec(userText);
    const m = /\[\[mem:(fence|prose|object|tail|garbage|broken|error|mixed|long|vlan)\]\]/.exec(userText);
    if (!dup && !m) return false;
    h.requests.push({ kind: "propose", body });
    if (dup) {
      const t = dup[1].trim();
      return sse(res, h, JSON.stringify([
        { kind: "fact", title: t, content: "повтор уже сохранённой карточки" },
        { kind: "result", title: "Новая находка", content: "порт 8443 открыт" },
        { kind: "result", title: "Новая находка", content: "порт 8443 открыт" },
      ])).then(() => true);
    }
    if (m[1] === "error") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock: propose упал" } }));
      return true;
    }
    await sse(res, h, PROPOSE[m[1]](), m[1] === "broken" ? "length" : "stop");
    return true;
  }

  if (kind === "agent") {
    const m = /\[\[mem:(all|allstr):([^\]]*)\]\]/.exec(userText);
    if (!m) return false;
    h.requests.push({ kind: "agent", body });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (!toolDone && body.tools?.length) {
      const args = JSON.stringify({ query: m[2], all_tasks: m[1] === "all" ? true : "false" });
      h.chunk(res, { tool_calls: [{ index: 0, id: `call_mem_${Date.now()}`, type: "function", function: { name: "search_memory", arguments: args } }] });
      await h.finish(res, "tool_calls", promptTokens, 30);
      return true;
    }
    const out = h.textOf(afterUser.filter((x) => x.role === "tool").at(-1)?.content ?? "");
    await h.streamText(res, "content", `Нашёл в памяти:\n\n${out.split("\n").slice(0, 3).join("\n")}`, 0, 20);
    await h.finish(res, "stop", promptTokens, 40);
    return true;
  }
  return false;
}
