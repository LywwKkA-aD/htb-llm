import type { APIRequestContext, Page } from "@playwright/test";
import {
  test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle,
  box, expectInside, expectNoOverflowX, type Ids,
} from "./helpers";

// Память задачи глубже, чем 05-memory: странные ответы служебного вызова propose (плагин мока tests/mock-plugins/memory.mjs,
// директивы [[mem:…]]), правка карточек, синхронизация чата и панели, большая память (бюджет системного промпта),
// изоляция задач и search_memory с all_tasks.

type Mem = { id: number; task_id: string; chat_id: string | null; kind: string; title: string; content: string; status: "pending" | "confirmed" | "rejected" };
type Chat = { id: string };

const mems = async (request: APIRequestContext, taskId: string) =>
  (await (await request.get(`/api/tasks/${taskId}/memories`)).json()) as Mem[]; // без отклонённых
async function addMem(request: APIRequestContext, taskId: string, m: { kind?: string; title: string; content: string }) {
  const r = await request.post(`/api/tasks/${taskId}/memories`, { data: m });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()) as Mem;
}
async function newChat(request: APIRequestContext, taskId: string) {
  const r = await request.post(`/api/tasks/${taskId}/chats`);
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as Chat;
}
// отклонить все ожидающие карточки задачи — у каждого теста чистые бейджи и счётчики
async function clearPending(request: APIRequestContext, taskId: string) {
  for (const m of (await mems(request, taskId)).filter((x) => x.status === "pending")) await request.post(`/api/memories/${m.id}/reject`);
}
const lastAgent = async (request: APIRequestContext) => {
  const r = (await mockRequests(request)).filter((x) => x.kind === "agent").at(-1);
  expect(r, "в модель должен уйти запрос агента").toBeTruthy();
  return r!;
};
const sysOf = (req: { body: any }) => textOf(req.body.messages[0].content);
const usersOf = (req: { body: any }) => req.body.messages.filter((m: any) => m.role === "user").map((m: any) => textOf(m.content)) as string[];
const toolOutOf = (req: { body: any }) => textOf(req.body.messages.filter((m: any) => m.role === "tool").at(-1)?.content ?? "");

// openTask из helpers гоняется с самим приложением: при первой загрузке оно выбирает самую свежую задачу и пишет её
// в localStorage; если это случилось после page.evaluate, после reload откроется не та задача. Доводим выбор кликами.
async function open(page: Page, ids: { task: { id: string; title: string }; chat: { id: string } }, tab: "term" | "mem" | "lib" = "mem") {
  await openTask(page, ids, { tab });
  const taskItem = page.locator(`[data-testid="task-item"][data-task-id="${ids.task.id}"]`);
  if ((await taskItem.getAttribute("aria-current")) !== "true") await taskItem.click();
  await expect(taskItem).toHaveAttribute("aria-current", "true");
  const chatItem = page.locator(`[data-testid="chat-item"][data-chat-id="${ids.chat.id}"]`);
  await expect(chatItem).toBeVisible();
  if ((await chatItem.getAttribute("aria-current")) !== "true") await chatItem.click();
  await expect(chatItem).toHaveAttribute("aria-current", "true");
  const tabBtn = page.getByTestId(`tab-${tab}`);
  if ((await tabBtn.getAttribute("aria-pressed")) !== "true") await tabBtn.click();
  await expect(tabBtn).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("chat-task-title")).toHaveText(ids.task.title);
}

const chatCards = (page: Page) => page.getByTestId("proposals").getByTestId("memory-card");
const panelCard = (page: Page, id: number | string) => page.getByTestId("memory-panel").locator(`[data-testid="memory-card"][data-id="${id}"]`);
const tabBadge = (page: Page) => page.getByTestId("tab-mem").locator("span.bg-warn");
const sideBadge = (page: Page) => page.locator('[data-testid="task-item"][aria-current="true"] span.bg-warn');

// большая память: 40 длинных карточек про маршруты + одна про wifi посередине
const ROUTES = Array.from({ length: 40 }, (_, i) => ({
  kind: i % 5 === 0 ? "step" : "fact",
  title: `Маршрут ${i + 1}: сеть 10.${i + 1}.0.0/16`,
  content: `Маршрут к сети 10.${i + 1}.0.0/16 через шлюз 192.168.${i + 1}.1, метрика ${i + 1}. ` +
    "Проверено командой ip route get, трассировка проходит через пограничный маршрутизатор кампуса, задержка стабильная, потерь нет. ".repeat(2),
}));
const WIFI = { kind: "fact", title: "Пароль wifi лаборатории", content: "wifi-пароль лаборатории: zebra-k9-лаб, сеть LAB-5G, ключ меняют каждый семестр" };
const BIG = [...ROUTES.slice(0, 20), WIFI, ...ROUTES.slice(20)];

// метка запуска: если воркер перезапустится, beforeAll создаст задачи заново — старые копии не должны путать проверки
const RUN = Math.random().toString(36).slice(2, 7);
const VLAN_TASK = `Задача А: VLAN ${RUN}`;
const VLAN_CARD = { kind: "command", title: `VLAN 30 на trunk ${RUN}`, content: "switchport trunk allowed vlan 10,20,30 — секретная-метка-альфа" };
const VLAN_Q = "vlan trunk секретная метка";

let main: Ids; // основная задача: разбор ответов propose, правка, синхронизация, удаление чата
let big: Ids;  // 41 карточка
let vlan: Ids; // «чужая» задача для изоляции и all_tasks

test.beforeAll(async ({ request }) => {
  test.setTimeout(180_000);
  [main, big, vlan] = await Promise.all([
    createTask(request, "Память: разбор", { brief: "Разобраться с адресацией и ARP в контейнере." }),
    createTask(request, "Большая память", { brief: "Много маршрутов кампуса." }),
    createTask(request, VLAN_TASK, { brief: "Настроить trunk между коммутаторами." }),
  ]);
  for (const m of BIG) await addMem(request, big.task.id, m);
  await addMem(request, vlan.task.id, VLAN_CARD);
  // у «чужой» задачи ещё ожидающая и отклонённая карточки, очень похожие на запрос
  const r = await request.post(`/api/chats/${vlan.chat.id}/send`, { data: { text: "[[mem:vlan]] запомни черновики", effort: "off" }, timeout: 45_000 });
  expect(r.ok()).toBeTruthy();
  const pend = (await mems(request, vlan.task.id)).filter((m) => m.status === "pending");
  expect(pend.map((m) => m.title).sort()).toEqual(["Отклонённый VLAN trunk", "Черновик VLAN trunk"]);
  await request.post(`/api/memories/${pend.find((m) => m.title.startsWith("Отклонённый"))!.id}/reject`);
});
test.beforeEach(async ({ request }) => { await mockReset(request); });

test.describe("память: разбор ответа модели на propose", () => {
  test("JSON в ```json-блоке, с пояснениями вокруг и внутри объекта — карточки извлекаются; служебный вызов без размышлений и инструментов", async ({ page, request }) => {
    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    const cards = chatCards(page);

    await send(page, "[[mem:fence]] какие адреса у контейнера?");
    await waitIdle(page);
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("Карточка из блока кода");
    await expect(cards.nth(0)).toContainText("команда");

    await send(page, "[[mem:prose]] а что в ARP-таблице?");
    await waitIdle(page);
    await expect(cards).toHaveCount(4);
    await expect(cards.nth(2)).toContainText("Карточка из пояснения");

    await send(page, "[[mem:object]] а почему ping завис?");
    await waitIdle(page);
    await expect(cards).toHaveCount(5);
    await expect(cards.nth(4)).toContainText("Карточка из объекта");
    await expect(cards.nth(4)).toContainText("ошибка");

    const mine = (await mems(request, main.task.id)).filter((m) => m.chat_id === chat.id);
    expect(mine.map((m) => [m.status, m.kind, m.title])).toEqual([
      ["pending", "command", "Карточка из блока кода"],
      ["pending", "fact", "Шлюз из блока кода"],
      ["pending", "step", "Карточка из пояснения"],
      ["pending", "result", "Итог из пояснения"],
      ["pending", "mistake", "Карточка из объекта"],
    ]);
    const props = (await mockRequests(request)).filter((r) => r.kind === "propose");
    expect(props).toHaveLength(3);
    for (const p of props) {
      expect(p.body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(p.body.tools).toBeUndefined();
      expect(textOf(p.body.messages[1].content)).toContain("Задача: Память: разбор");
      expect(textOf(p.body.messages[0].content)).toContain("content начинай с «Источник:");
      expect(textOf(p.body.messages[0].content)).toContain("слова пользователя (не проверено выводом)");
    }
    // уже предложенные карточки передаются модели как существующие — чтобы не повторяла
    expect(textOf(props[2].body.messages[1].content)).toContain("«Карточка из блока кода»");
  });

  test("мусор, обрезанный JSON и ошибка 500 в propose: ответ на месте, карточек и ошибок нет, следующий ход снова предлагает", async ({ page, request }) => {
    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    const ai = page.getByTestId("msg-ai");
    for (const [i, d] of ["garbage", "broken", "error"].entries()) {
      await send(page, `[[mem:${d}]] вопрос ${i + 1}`);
      await waitIdle(page);
      await expect(ai).toHaveCount(i + 1);
      await expect(ai.nth(i)).toContainText("ARP сопоставляет");
      await expect(ai.nth(i).getByTestId("stats")).toBeVisible();
    }
    await expect(page.getByTestId("marker-error")).toHaveCount(0);
    await expect(page.getByTestId("proposals")).toHaveCount(0);
    expect((await mockRequests(request)).filter((r) => r.kind === "propose")).toHaveLength(3);
    expect((await mems(request, main.task.id)).filter((m) => m.chat_id === chat.id)).toEqual([]);
    // в журнале чата тоже нет ошибок — сбой служебного вызова не портит историю
    const log = (await (await request.get(`/api/chats/${chat.id}/log`)).json()) as { chat: { busy: boolean }; log: { kind: string }[] };
    expect(log.log.filter((x) => x.kind === "marker")).toEqual([]);
    expect(log.chat.busy).toBe(false);

    await send(page, "[[mem:fence]] а теперь нормально");
    await waitIdle(page);
    await expect(chatCards(page)).toHaveCount(2);
  });

  test("битые элементы и больше трёх карточек: сохраняются ровно 3 валидные, неизвестный вид → «факт», HTML показывается текстом", async ({ page, request }) => {
    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    await send(page, "[[mem:mixed]] разбор");
    await waitIdle(page);
    const cards = chatCards(page);
    await expect(cards).toHaveCount(3);

    const mine = (await mems(request, main.task.id)).filter((m) => m.chat_id === chat.id);
    expect(mine.map((m) => [m.kind, m.title])).toEqual([
      ["fact", "Неизвестный вид"],
      ["step", "<b>жирный</b> & <img src=x onerror=alert(1)>"],
      ["result", "Итог разбора"],
    ]);
    await expect(cards.nth(0)).toContainText("факт");
    await expect(cards.nth(1)).toContainText("<b>жирный</b> & <img src=x onerror=alert(1)>");
    await expect(cards.nth(1)).toContainText("<script>alert(2)</script> разметка как текст");
    await expect(cards.nth(1).locator("b, img, script")).toHaveCount(0);
    await expect(page.getByTestId("proposals")).not.toContainText("Четвёртая валидная");

    // в панели — те же три ожидающие, заголовок с разметкой и там остаётся текстом
    const pc = panelCard(page, mine[1].id);
    await expect(pc).toHaveAttribute("data-status", "pending");
    await expect(pc).toContainText("<b>жирный</b>");
    await expect(pc.locator("b, img, script")).toHaveCount(0);
  });

  test("слишком длинные заголовок и текст обрезаются (200 / 4000), карточка не вылезает по ширине ни в чате, ни в панели", async ({ page, request }) => {
    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    await send(page, "[[mem:long]] длинный вывод");
    await waitIdle(page);
    const card = chatCards(page);
    await expect(card).toHaveCount(1);
    const [m] = (await mems(request, main.task.id)).filter((x) => x.chat_id === chat.id);
    expect(m.title.length).toBe(200);
    expect(m.content.length).toBe(4000);

    // заголовок — одна строка с многоточием, текст без пробелов переносится внутри карточки
    const title = card.getByText("Очень длинный заголовок", { exact: false }).first();
    const t = await title.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height }));
    expect(t.sw, "длинный заголовок обрезан многоточием").toBeGreaterThan(t.cw);
    expect(t.h, "заголовок в одну строку").toBeLessThan(30);
    expect((await box(card.getByText("Длинный вывод:", { exact: false }))).height, "текст переносится на много строк").toBeGreaterThan(150);
    await expectNoOverflowX(card, "карточка в чате");
    await expectNoOverflowX(page.getByTestId("messages"), "лента чата");
    await expectInside(card, page.getByTestId("proposals"), "карточка внутри блока предложений");

    const pc = panelCard(page, m.id);
    await expect(pc).toHaveAttribute("data-status", "pending");
    await expectNoOverflowX(pc, "карточка в панели");
    await expectNoOverflowX(page.getByTestId("tabbody-mem"), "вкладка памяти");
    await expectInside(pc, page.getByTestId("memory-panel"), "карточка внутри панели");

    // прибраться: длинная карточка не должна раздуть память задачи для следующих тестов
    await card.getByTestId("mem-reject").click();
    await expect(page.getByTestId("proposals")).toHaveCount(0);
    await expect(pc).toHaveCount(0);
  });

  test("примечание со [скобками] после JSON не теряет карточки", async ({ page, request }) => {
    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    await send(page, "[[mem:tail]] какие порты слушаются?");
    await waitIdle(page);
    expect((await mockRequests(request)).filter((r) => r.kind === "propose")).toHaveLength(1);
    await expect(chatCards(page)).toHaveCount(2, { timeout: 3000 });
  });

  test("карточка с заголовком уже сохранённой и дубли внутри одного ответа не предлагаются повторно", async ({ page, request }) => {
    await addMem(request, main.task.id, { kind: "fact", title: "Шлюз по умолчанию", content: "default via 10.0.0.1 dev eth0" });
    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    await send(page, "[[mem:dup:Шлюз по умолчанию]] проверь шлюз ещё раз");
    await waitIdle(page);
    const p = (await mockRequests(request)).filter((r) => r.kind === "propose").at(-1)!;
    expect(textOf(p.body.messages[1].content), "сервер передал модели существующие заголовки").toContain("«Шлюз по умолчанию»");
    await expect(chatCards(page)).toHaveCount(1, { timeout: 3000 });
    await expect(chatCards(page)).toContainText("Новая находка");
  });
});

test.describe("память: правка и синхронизация чата с панелью", () => {
  test("правка подтверждённой карточки в панели: вид, заголовок и текст переживают перезагрузку и уходят в промпт нового чата", async ({ page, request }) => {
    const m = await addMem(request, main.task.id, { kind: "fact", title: "Порт веб-сервера", content: "nginx слушает 8080" });
    await open(page, main);
    const confirmedBefore = (await mems(request, main.task.id)).filter((x) => x.status === "confirmed").length;
    const card = panelCard(page, m.id);
    await card.getByTestId("mem-edit").click();
    await expect(card.getByTestId("mem-title")).toHaveValue("Порт веб-сервера");
    await expect(card.getByTestId("mem-kind")).toHaveValue("fact");
    await card.getByTestId("mem-kind").selectOption("command");
    await card.getByTestId("mem-title").fill("Порт nginx (правка)");
    await card.getByTestId("mem-content").fill("ss -tlnp: nginx на 0.0.0.0:8081\nпроверено curl -I");
    await card.getByTestId("mem-confirm").click();
    await expect(page.getByTestId("toast").filter({ hasText: "сохранено в память задачи" })).toBeVisible();
    await expect(card.getByTestId("mem-title")).toHaveCount(0); // форма правки закрылась
    await expect(card).toHaveAttribute("data-status", "confirmed");
    await expect(card).toContainText("команда");
    await expect(card).toContainText("Порт nginx (правка)");
    // правка не создаёт копию
    await expect(page.getByTestId("mem-confirmed-title")).toContainText(`подтверждено · ${confirmedBefore}`);

    await page.reload();
    await expect(card).toContainText("Порт nginx (правка)");
    await expect(card).toContainText("ss -tlnp: nginx на 0.0.0.0:8081");
    const after = (await mems(request, main.task.id)).filter((x) => x.id === m.id || x.title === "Порт веб-сервера");
    expect(after.map((x) => [x.id, x.kind, x.title, x.content, x.status])).toEqual([
      [m.id, "command", "Порт nginx (правка)", "ss -tlnp: nginx на 0.0.0.0:8081\nпроверено curl -I", "confirmed"],
    ]);

    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    await send(page, "[[short]] где слушает nginx?");
    await waitIdle(page);
    const sys = sysOf(await lastAgent(request));
    expect(sys).toContain("- [команда] Порт nginx (правка): ss -tlnp: nginx на 0.0.0.0:8081\nпроверено curl -I");
    expect(sys).not.toContain("nginx слушает 8080");
  });

  test("правка: пустой заголовок сохранить нельзя", async ({ page, request }) => {
    const m = await addMem(request, main.task.id, { kind: "fact", title: "Исходный заголовок", content: "что-то важное про лабу" });
    await open(page, main);
    const card = panelCard(page, m.id);
    await card.getByTestId("mem-edit").click();
    await card.getByTestId("mem-title").fill("");
    const save = card.getByTestId("mem-confirm");
    if (await save.isEnabled()) {
      await save.click();
      await expect(page.getByTestId("toast").first()).toBeVisible(); // успех или ошибка — запрос завершился
    }
    const after = (await mems(request, main.task.id)).find((x) => x.id === m.id)!;
    expect(after.title).toBe("Исходный заголовок");
  });

  test("правка: «отмена» откатывает черновик — повторное открытие показывает сохранённое", async ({ page, request }) => {
    const m = await addMem(request, main.task.id, { kind: "fact", title: "Маска лабы", content: "255.255.255.192 (/26)" });
    await open(page, main);
    const card = panelCard(page, m.id);
    await card.getByTestId("mem-edit").click();
    await card.getByTestId("mem-title").fill("черновик, который отменили");
    await card.getByTestId("mem-content").fill("мусор");
    await card.getByTestId("mem-edit").click(); // «отмена»
    await expect(card.getByTestId("mem-title")).toHaveCount(0);
    await expect(card).toContainText("Маска лабы"); // показывается сохранённое
    await card.getByTestId("mem-edit").click();
    await expect(card.getByTestId("mem-title")).toHaveValue("Маска лабы", { timeout: 3000 });
    await expect(card.getByTestId("mem-content")).toHaveValue("255.255.255.192 (/26)", { timeout: 3000 });
  });

  test("предложения из чата сразу видны в открытой панели; действия в чате обновляют панель, бейдж вкладки и задачи", async ({ page, request }) => {
    await clearPending(request, main.task.id);
    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    const panel = page.getByTestId("memory-panel");
    const confirmedBefore = (await mems(request, main.task.id)).filter((x) => x.status === "confirmed").length;
    await expect(panel.getByTestId("mem-confirmed-title")).toContainText(`подтверждено · ${confirmedBefore}`);
    await expect(panel.getByTestId("mem-pending-title")).toHaveCount(0);
    await expect(tabBadge(page)).toHaveCount(0);
    await expect(sideBadge(page)).toHaveCount(0);

    await send(page, "Что такое ARP?");
    await waitIdle(page);
    const cards = chatCards(page);
    await expect(cards).toHaveCount(2);
    await expect(panel.getByTestId("mem-pending-title")).toContainText("ждут подтверждения · 2");
    await expect(panel.locator('[data-testid="memory-card"][data-status="pending"]')).toHaveCount(2);
    await expect(tabBadge(page)).toHaveText("2");
    await expect(sideBadge(page)).toHaveText("2");

    await cards.first().getByTestId("mem-confirm").click();
    await expect(cards).toHaveCount(1);
    await expect(panel.getByTestId("mem-pending-title")).toContainText("ждут подтверждения · 1");
    await expect(panel.getByTestId("mem-confirmed-title")).toContainText(`подтверждено · ${confirmedBefore + 1}`);
    await expect(tabBadge(page)).toHaveText("1");
    await expect(sideBadge(page)).toHaveText("1");

    await cards.first().getByTestId("mem-reject").click();
    await expect(page.getByTestId("proposals")).toHaveCount(0);
    await expect(panel.getByTestId("mem-pending-title")).toHaveCount(0);
    await expect(tabBadge(page)).toHaveCount(0);
    await expect(sideBadge(page)).toHaveCount(0);
    await expect(page.getByTestId("tab-mem")).toContainText(String(confirmedBefore + 1));
    await expect(page.locator('[data-testid="task-item"][aria-current="true"]')).toContainText(String(confirmedBefore + 1));
  });

  test("подтверждение в панели: устаревшее предложение в чате не должно стирать уже подтверждённую карточку", async ({ page, request }) => {
    // своя задача: в основной «Просмотр ARP-таблицы» уже подтверждена, а повторы не предлагаются (MEM-2)
    const main = (await (await request.post("/api/tasks", { data: { title: "Память: устаревшее предложение" } })).json()) as Ids;
    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    await send(page, "Что такое ARP?");
    await waitIdle(page);
    await expect(chatCards(page)).toHaveCount(2);
    const pend = page.getByTestId("memory-panel").locator('[data-testid="memory-card"][data-status="pending"]');
    await expect(pend).toHaveCount(2);
    const id = (await pend.first().getAttribute("data-id"))!;
    await pend.first().getByTestId("mem-confirm").click();
    await expect(panelCard(page, id)).toHaveAttribute("data-status", "confirmed");
    await expect(tabBadge(page)).toHaveText("1");

    const stale = page.getByTestId("proposals").locator(`[data-testid="memory-card"][data-id="${id}"]`);
    // если чат синхронизирован с панелью, карточка из предложений исчезнет сама
    await expect(stale).toHaveCount(0, { timeout: 3000 }).catch(() => {});
    if (await stale.count()) {
      await stale.getByTestId("mem-reject").click();
      await expect(stale).toHaveCount(0);
    }
    const after = (await mems(request, main.task.id)).find((m) => m.id === Number(id));
    expect(after?.status, "подтверждённая в панели карточка не должна стать отклонённой").toBe("confirmed");
  });

  test("удаление чата оставляет его карточки: подтверждённая — в промпте нового чата, ожидающую можно подтвердить из панели", async ({ page, request }) => {
    // своя задача: в основной карточки «Что такое ARP?» уже подтверждены/отклонены, а повторы не предлагаются (MEM-2)
    const main = (await (await request.post("/api/tasks", { data: { title: "Память: удаление чата" } })).json()) as Ids;
    await request.delete(`/api/chats/${main.chat.id}`); // иначе после удаления открылся бы пустой чат задачи и «новый чат» ниже не дождался бы своего
    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    await send(page, "Что такое ARP?");
    await waitIdle(page);
    const cards = chatCards(page);
    await expect(cards).toHaveCount(2);
    const [c1, c2] = await Promise.all([cards.nth(0).getAttribute("data-id"), cards.nth(1).getAttribute("data-id")]);
    await cards.first().getByTestId("mem-confirm").click();
    await expect(cards).toHaveCount(1);

    const item = page.locator(`[data-testid="chat-item"][data-chat-id="${chat.id}"]`);
    await item.hover();
    await item.getByTestId("chat-delete").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText("Память задачи останется");
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toast").filter({ hasText: "чат удалён" })).toBeVisible();
    await expect(item).toHaveCount(0);

    const left = (await mems(request, main.task.id)).filter((m) => m.id === Number(c1) || m.id === Number(c2));
    expect(left.map((m) => [m.id, m.status, m.chat_id])).toEqual([[Number(c1), "confirmed", chat.id], [Number(c2), "pending", chat.id]]);

    const pc = panelCard(page, c2!);
    await expect(pc).toHaveAttribute("data-status", "pending");
    await expect(tabBadge(page)).toHaveText("1");
    await pc.getByTestId("mem-edit").click();
    await pc.getByTestId("mem-title").fill("Хосты /24 — из удалённого чата");
    await pc.getByTestId("mem-confirm").click();
    await expect(panelCard(page, c2!)).toHaveAttribute("data-status", "confirmed");
    await expect(tabBadge(page)).toHaveCount(0);

    await page.getByTestId("new-chat").click();
    await expect(page.getByTestId("hero")).toBeVisible();
    await send(page, "[[short]] что уже известно?");
    await waitIdle(page);
    const sys = sysOf(await lastAgent(request));
    expect(sys).toContain("- [факт] Хосты /24 — из удалённого чата: 2^8 − 2 = 254 адреса под хосты");
    expect(sys).toContain("Просмотр ARP-таблицы: ip neigh show");
  });
});

test.describe("память: большая память и изоляция задач", () => {
  test("41 длинная карточка: в системном промпте только заголовки, релевантная — целиком в контексте хода; промпт стабилен между ходами; панель прокручивается", async ({ page, request }) => {
    await open(page, big);
    await send(page, "[[short]] какой пароль от wifi в лаборатории?");
    await waitIdle(page);
    const r1 = await lastAgent(request);
    const sys1 = sysOf(r1);
    expect(sys1).toContain("Карточек много (41), здесь только заголовки");
    for (const m of BIG) expect(sys1).toContain(`] ${m.title}`);
    expect(sys1, "содержимое карточек не в системном промпте").not.toContain("zebra-k9");
    expect(sys1).not.toContain("через шлюз 192.168.7.1");

    const u1 = usersOf(r1).at(-1)!;
    expect(u1).toContain("<контекст_хода>");
    expect(u1).toContain("Релевантные карточки памяти задачи:\n");
    expect(u1, "самая близкая по смыслу карточка подклеена целиком").toContain("- [факт] Пароль wifi лаборатории: wifi-пароль лаборатории: zebra-k9-лаб");
    const block = u1.split("Релевантные карточки памяти задачи:\n")[1].split("\n(ещё в памяти задачи")[0];
    expect(Math.ceil(block.length / 3), "подклеенные карточки укладываются в бюджет recallMemoryTokens").toBeLessThanOrEqual(1800);
    expect(u1).toContain("(ещё в памяти задачи, достать через search_memory: «");
    // каждая карточка либо подклеена целиком, либо названа в списке остальных
    for (const m of BIG) expect(block.includes(`] ${m.title}: `) || u1.includes(`«${m.title}»`), m.title).toBe(true);

    // второй ход: системный промпт и прошлое сообщение с его контекстом уходят побайтно теми же (кэш llama-server)
    await send(page, "[[short]] а какая метрика у маршрута в сеть 10.7?");
    await waitIdle(page);
    const r2 = await lastAgent(request);
    expect(sysOf(r2)).toBe(sys1);
    const users2 = usersOf(r2);
    expect(users2).toHaveLength(2);
    expect(users2[0]).toBe(u1);
    expect(users2[1]).toContain("Релевантные карточки памяти задачи:");

    // панель: 41 карточка прокручивается внутри вкладки, раскладка не растягивается
    const panel = page.getByTestId("memory-panel");
    await expect(panel.getByTestId("mem-confirmed-title")).toContainText("подтверждено · 41");
    const cards = panel.getByTestId("memory-card");
    await expect(cards).toHaveCount(41);
    await expect(page.getByTestId("tab-mem")).toContainText("41");
    const scroller = page.getByTestId("tabbody-mem");
    const sc = await scroller.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(sc.sh, "содержимое длиннее видимой области").toBeGreaterThan(sc.ch + 500);
    const headerBefore = await box(page.getByTestId("right-header"));
    await cards.last().scrollIntoViewIfNeeded();
    await expect(cards.last()).toContainText("Маршрут 40");
    await expectInside(cards.last(), scroller, "последняя карточка видна внутри вкладки", 1);
    const headerAfter = await box(page.getByTestId("right-header"));
    expect(headerAfter.y, "шапка правой панели не уезжает").toBeCloseTo(headerBefore.y, 0);
    const vp = page.viewportSize()!;
    expect((await box(page.getByTestId("right-panel"))).y + (await box(page.getByTestId("right-panel"))).height).toBeLessThanOrEqual(vp.height);
    expect(await page.evaluate(() => document.documentElement.scrollHeight), "страница целиком не прокручивается").toBeLessThanOrEqual(vp.height);
    await expectNoOverflowX(scroller, "вкладка памяти");
  });

  test("search_memory: all_tasks=\"false\" строкой ищет только в своей задаче", async ({ page, request }) => {
    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    await send(page, `[[mem:allstr:${VLAN_Q}]] [[nomem]]`);
    await waitIdle(page);
    const r = await lastAgent(request);
    const call = r.body.messages.find((m: any) => m.role === "assistant" && m.tool_calls?.length)?.tool_calls[0];
    expect(JSON.parse(call.function.arguments)).toEqual({ query: VLAN_Q, all_tasks: "false" });
    expect(toolOutOf(r)).not.toContain(VLAN_CARD.title);
  });

  test("изоляция задач: чужая память не попадает в промпт, контекст и обычный search_memory; all_tasks=true находит только подтверждённое с подписью задачи; после удаления задачи — ничего", async ({ page, request }) => {
    // у самой задачи VLAN карточка в системном промпте есть
    await open(page, vlan);
    await send(page, `[[short]] ${VLAN_Q}`);
    await waitIdle(page);
    expect(sysOf(await lastAgent(request))).toContain(`- [команда] ${VLAN_CARD.title}: switchport trunk allowed vlan 10,20,30`);

    // в другой задаче её нет ни в системном промпте, ни в контексте хода
    await mockReset(request);
    const chat = await newChat(request, main.task.id);
    await open(page, { task: main.task, chat });
    await send(page, `[[short]] ${VLAN_Q}`);
    await waitIdle(page);
    const r = await lastAgent(request);
    expect(sysOf(r)).toContain("# ЗАДАЧА: Память: разбор");
    for (const s of [VLAN_CARD.title, "секретная-метка-альфа", "Черновик VLAN trunk"]) {
      expect(sysOf(r)).not.toContain(s);
      expect(usersOf(r).join("\n")).not.toContain(s);
    }
    // обычный search_memory — только своя задача, без подписей задач
    await send(page, `[[tool:memory:${VLAN_Q}]] [[nomem]]`);
    await waitIdle(page);
    const own = toolOutOf(await lastAgent(request));
    expect(own.length).toBeGreaterThan(0);
    expect(own).not.toContain(VLAN_CARD.title);
    expect(own).not.toContain("задача «");

    // all_tasks=true — опыт других задач, каждая запись подписана своей задачей
    await send(page, `[[mem:all:${VLAN_Q}]] [[nomem]]`);
    await waitIdle(page);
    const tool = page.locator('[data-testid="tool-block"][data-tool="search_memory"]').last();
    await expect(tool).toHaveAttribute("data-status", "ok");
    await tool.locator("summary").click();
    await expect(tool.getByTestId("tool-output")).toContainText(`(задача «${VLAN_TASK}», команда) ${VLAN_CARD.title}: switchport trunk allowed vlan 10,20,30`);
    const all = toolOutOf(await lastAgent(request));
    const entries = all.split(/\n(?=- \()/);
    expect(entries.length, "не больше k=6 результатов").toBeLessThanOrEqual(6);
    expect(entries[0], "самая близкая карточка — первой").toContain(VLAN_CARD.title);
    for (const e of entries) expect(e).toMatch(/^- \(задача «[^»]+», /);
    expect(all, "ожидающая карточка не ищется").not.toContain("Черновик VLAN trunk");
    expect(all, "отклонённая карточка не ищется").not.toContain("Отклонённый VLAN trunk");

    // удалили задачу — её память пропала и из общего поиска
    const del = await request.delete(`/api/tasks/${vlan.task.id}`);
    expect(del.ok()).toBeTruthy();
    expect(await mems(request, vlan.task.id)).toEqual([]);
    await mockReset(request);
    await send(page, `[[mem:all:${VLAN_Q}]] [[nomem]]`);
    await waitIdle(page);
    const after = toolOutOf(await lastAgent(request));
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toContain(VLAN_CARD.title);
    expect(after).not.toContain(VLAN_TASK);
  });
});
