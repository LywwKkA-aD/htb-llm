import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, box, bottom, createTask, expectNoOverflowX, mockRequests, mockReset, send, textOf, waitIdle } from "./helpers";

// Жизненный цикл задач и чатов, сайдбар: много задач и поиск, порядок по обновлению, переключение,
// новый чат и удаление посреди ответа, перезагрузка, юникод в названиях, правка условия задачи.
// Долгий ответ — директива [[tc:slow]] (tests/mock-plugins/tasks-chats.mjs): поток до ~60 с, пока его не остановят.

type ChatRow = { id: string; title: string; busy?: boolean; updated_at: number };

const chatItem = (page: Page, id: string) => page.locator(`[data-testid="chat-item"][data-chat-id="${id}"]`);
const taskItem = (page: Page, id: string) => page.locator(`[data-testid="task-item"][data-task-id="${id}"]`);
const spinner = (page: Page, chatId: string) => chatItem(page, chatId).locator(".animate-spin"); // индикатор «отвечает» в сайдбаре
const errorToasts = (page: Page) => page.locator('[data-testid="toast"][data-kind="error"]');

async function newChat(request: APIRequestContext, taskId: string): Promise<ChatRow> {
  const r = await request.post(`/api/tasks/${taskId}/chats`);
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function chatsOf(request: APIRequestContext, taskId: string): Promise<ChatRow[]> {
  return (await request.get(`/api/tasks/${taskId}/chats`)).json();
}
async function chatBusy(request: APIRequestContext, chatId: string): Promise<boolean> {
  const r = await request.get(`/api/chats/${chatId}/log`);
  if (!r.ok()) return false; // чата уже нет
  return !!(await r.json()).chat.busy;
}
// чистая база задач (контейнеры удаляет сам сервер)
async function wipeTasks(request: APIRequestContext) {
  const all = (await (await request.get("/api/tasks")).json()) as { id: string }[];
  for (const t of all) expect((await request.delete(`/api/tasks/${t.id}`)).ok()).toBe(true);
}

// Открыть приложение сразу на нужной задаче и чате. Не через openTask из helpers: там первый goto("/") успевает
// сам выбрать самую свежую задачу и записать её в localStorage уже ПОСЛЕ подстановки — перезагрузка открывает
// не ту задачу (ловилось здесь, когда в базе несколько задач). Скрипт до загрузки страницы срабатывает один раз.
let openSeq = 0;
async function openAt(page: Page, taskId: string, chatId: string) {
  const key = `${Date.now()}-${openSeq++}`;
  await page.addInitScript(([t, c, k]) => {
    try {
      if (!location.protocol.startsWith("http")) return;
      const used: string[] = JSON.parse(sessionStorage.getItem("tc-open") ?? "[]");
      if (used.includes(k)) return; // повторные загрузки в тесте (reload) выбор не трогают
      sessionStorage.setItem("tc-open", JSON.stringify([...used, k]));
      localStorage.clear();
      localStorage.setItem("wh.task", t);
      localStorage.setItem("wh.chat", c);
      localStorage.setItem("wh.tab", "term");
    } catch { /* about:blank и т. п. */ }
  }, [taskId, chatId, key] as const);
  await page.goto("/");
  await expect(taskItem(page, taskId)).toHaveAttribute("aria-current", "true");
  await expect(chatItem(page, chatId)).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("chat-panel")).toBeVisible();
}

// долгие ходы, начатые тестом, — после теста останавливаем и ждём конца, чтобы не влияли на следующие
const long = new Set<string>();
async function startSlow(page: Page, chatId: string, text: string) {
  await send(page, `${text} [[tc:slow]] [[nomem]]`);
  long.add(chatId);
  await expect(page.getByTestId("msg-ai").last()).toContainText("токен2");
}
const maxToken = (s: string) => Math.max(-1, ...[...s.matchAll(/токен(\d+)/g)].map((m) => Number(m[1])));

test.describe("задачи и чаты: жизненный цикл и сайдбар", () => {
  test.describe.configure({ timeout: 120_000 });
  test.beforeEach(async ({ request }) => { await mockReset(request); });
  test.afterEach(async ({ request }) => {
    for (const id of long) await request.post(`/api/chats/${id}/stop`).catch(() => {});
    for (const id of long) await expect.poll(() => chatBusy(request, id), { timeout: 20_000 }).toBe(false);
    long.clear();
  });

  test("удаление задачи посреди ответа выбирает оставшуюся с её чатами; удаление последней — приветствие, и после перезагрузки тоже", async ({ page, request }) => {
    await wipeTasks(request);
    const p = await createTask(request, "Удаляемая посреди ответа");
    const q = await createTask(request, "Остающаяся задача");
    const q2 = await newChat(request, q.task.id);
    await openAt(page, p.task.id, p.chat.id);
    await startSlow(page, p.chat.id, "долгий ответ перед удалением");

    await page.getByTestId("edit-task").click();
    await page.getByTestId("task-delete").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText("Удаляемая посреди ответа");
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toast").filter({ hasText: "задача удалена" })).toBeVisible({ timeout: 30_000 });
    await expect(taskItem(page, p.task.id)).toHaveCount(0);
    await expect(taskItem(page, q.task.id)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("chat-task-title")).toHaveText("Остающаяся задача");
    // чаты оставшейся задачи на месте, открыт один из них — не пустое «новый чат»
    await expect(page.getByTestId("chat-item")).toHaveCount(2);
    await expect(chatItem(page, q2.id)).toBeVisible();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("empty-new-chat")).toHaveCount(0);
    await expect(page.getByTestId("status-busy")).toHaveCount(0);
    await expect(errorToasts(page)).toHaveCount(0);
    // на сервере: ход прерван, чат и контейнер удалены, сервер жив
    expect((await request.get(`/api/chats/${p.chat.id}/log`)).ok(), "журнал удалённого чата недоступен").toBe(false);
    await expect.poll(async () => (await (await request.get(`/api/tasks/${p.task.id}/container`)).json()).status, { timeout: 30_000 }).toBe("missing");
    expect((await request.get("/api/health")).ok()).toBe(true);

    // удалить последнюю задачу
    await page.getByTestId("edit-task").click();
    await page.getByTestId("task-delete").click();
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("welcome")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("right-panel")).toHaveCount(0);
    await expect(page.getByTestId("chat-panel")).toHaveCount(0);
    await expect(page.getByTestId("status-container")).toHaveCount(0);
    await expect(page.getByTestId("sidebar")).toContainText("пока пусто");
    await expect(page.getByTestId("sidebar")).toContainText("задачи · 0");
    // в localStorage остался id удалённой задачи — после перезагрузки всё равно приветствие и без ошибок
    await page.reload();
    await expect(page.getByTestId("welcome")).toBeVisible();
    await expect(page.getByTestId("right-panel")).toHaveCount(0);
    await expect(errorToasts(page)).toHaveCount(0);
    // с приветствия можно начать заново
    await page.getByTestId("welcome-create").click();
    await page.getByTestId("task-title").fill("Новая после пустоты");
    await page.getByTestId("task-title").press("Enter");
    await expect(page.getByTestId("chat-task-title")).toHaveText("Новая после пустоты");
    await expect(page.getByTestId("hero")).toBeVisible();
    await expect(page.getByTestId("chat-item")).toHaveCount(1);
  });

  test("поиск задач: удалил найденную задачу — скрытый фильтр не прячет остальные задачи", async ({ page, request }) => {
    await wipeTasks(request);
    for (const t of ["Альфа-поиск", "Бета-поиск", "Гамма-поиск", "Дельта-поиск", "Эпсилон-поиск"])
      expect((await request.post("/api/tasks", { data: { title: t, course: "Поиск", brief: "" } })).ok()).toBe(true);
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const items = page.getByTestId("task-item");
    await expect(items).toHaveCount(5);
    const search = page.getByTestId("task-search");
    await search.fill("АЛЬФА"); // регистр не важен
    await expect(items).toHaveCount(1);
    await items.first().click();
    await expect(page.getByTestId("chat-task-title")).toHaveText("Альфа-поиск");
    await page.getByTestId("edit-task").click();
    await page.getByTestId("task-delete").click();
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toast").filter({ hasText: "задача удалена" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("sidebar")).toContainText("задачи · 4");
    await expect(search, "поле поиска пропало: задач ≤ 4").toHaveCount(0);
    // раз поля нет, фильтр не должен действовать: видны все 4 задачи
    await expect(items, "все оставшиеся задачи видны в сайдбаре").toHaveCount(4, { timeout: 3000 });
  });

  test("16 задач: список прокручивается внутри сайдбара, поиск по названию и курсу без учёта регистра; выбор задачи и чата переживает перезагрузку", async ({ page, request }) => {
    for (let i = 1; i <= 16; i++) {
      const r = await request.post("/api/tasks", { data: { title: `Скролл ${String(i).padStart(2, "0")} · маршрутизация`, course: i % 2 ? "Курс-Север" : "Курс-Юг", brief: "" } });
      expect(r.ok(), await r.text()).toBe(true);
    }
    const all = (await (await request.get("/api/tasks")).json()) as { id: string; title: string }[];
    const total = all.length;
    expect(total).toBeGreaterThanOrEqual(16);
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const items = page.getByTestId("task-item");
    await expect(items).toHaveCount(total);
    await expect(page.getByTestId("sidebar")).toContainText(`задачи · ${total}`);

    // прокручивается сам список; сайдбар и страница за экран не растут
    const list = page.getByTestId("task-list");
    const sc = await list.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(sc.sh, "список задач длиннее видимой области").toBeGreaterThan(sc.ch + 100);
    const sb = await box(page.getByTestId("sidebar"));
    const status = await box(page.getByTestId("statusbar"));
    expect(bottom(sb), "сайдбар не залезает на статус-бар").toBeLessThanOrEqual(status.y + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), "у страницы нет своей прокрутки").toBeLessThanOrEqual(0);
    await expectNoOverflowX(list, "список задач");
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(items.last()).toBeInViewport();

    // поиск: регистр не важен, ищется и по курсу; пустой результат; сброс
    const search = page.getByTestId("task-search");
    await search.fill("СКРОЛЛ 07");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("Скролл 07 · маршрутизация");
    await search.fill("курс-юг");
    await expect(items).toHaveCount(8);
    await search.fill("нет-такой-задачи");
    await expect(items).toHaveCount(0);
    await search.fill("");
    await expect(items).toHaveCount(total);

    // самая нижняя задача и в ней — не первый чат
    const last = items.last();
    const lastId = (await last.getAttribute("data-task-id"))!;
    const lastTitle = all.find((t) => t.id === lastId)!.title;
    await last.click();
    await expect(taskItem(page, lastId)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("chat-task-title")).toHaveText(lastTitle);
    const chats = page.getByTestId("chat-item");
    const before = await chats.count();
    await page.getByTestId("new-chat").click();
    await expect(chats).toHaveCount(before + 1);
    const older = chats.last(); // старый чат внизу: порядок — по времени обновления
    const olderId = (await older.getAttribute("data-chat-id"))!;
    await older.click();
    await expect(chatItem(page, olderId)).toHaveAttribute("aria-current", "true");

    await page.reload();
    await expect(taskItem(page, lastId)).toHaveAttribute("aria-current", "true");
    await expect(chatItem(page, olderId)).toHaveAttribute("aria-current", "true");
    await expect(page.locator('[data-testid="chat-item"][aria-current="true"]')).toHaveCount(1);
    await expect(page.getByTestId("chat-task-title")).toHaveText(lastTitle);
  });

  test("порядок: ход в старом чате поднимает этот чат и его задачу наверх списков (и после перезагрузки)", async ({ page, request }) => {
    const x = await createTask(request, "Порядок: старая задача");
    await newChat(request, x.task.id);
    await newChat(request, x.task.id);
    const y = await createTask(request, "Порядок: новая задача");
    await openAt(page, x.task.id, x.chat.id);
    const chats = page.getByTestId("chat-item");
    const tasks = page.getByTestId("task-item");
    await expect(chats).toHaveCount(3);
    await expect(chats.last(), "самый старый чат внизу").toHaveAttribute("data-chat-id", x.chat.id);
    await expect(tasks.first(), "свежая задача наверху").toHaveAttribute("data-task-id", y.task.id);

    await send(page, "[[short]] [[nomem]] подними этот чат");
    await waitIdle(page);
    await expect(chats.first()).toHaveAttribute("data-chat-id", x.chat.id);
    await expect(chatItem(page, x.chat.id)).toHaveAttribute("aria-current", "true");
    await expect(chatItem(page, x.chat.id)).toContainText("подними этот чат");
    await expect(tasks.first()).toHaveAttribute("data-task-id", x.task.id);

    await page.reload();
    await expect(chats.first()).toHaveAttribute("data-chat-id", x.chat.id);
    await expect(tasks.first()).toHaveAttribute("data-task-id", x.task.id);
  });

  test("переключение задач во время ответа: вернулся — ответ дописывается без дублей, индикатор в сайдбаре, «стоп» работает", async ({ page, request }) => {
    const p = await createTask(request, "Переключение: P");
    const q = await createTask(request, "Переключение: Q");
    await openAt(page, p.task.id, p.chat.id);
    await startSlow(page, p.chat.id, "объясни ARP подробно");
    // первое сообщение дало чату название — список чатов перечитан, у чата крутится индикатор
    await expect(spinner(page, p.chat.id)).toHaveCount(1);
    await expect(page.getByTestId("status-busy")).toBeVisible();

    await taskItem(page, q.task.id).click();
    await expect(page.getByTestId("chat-task-title")).toHaveText("Переключение: Q");
    await expect(page.getByTestId("hero")).toBeVisible();
    await expect(page.getByTestId("msg-user")).toHaveCount(0);
    await expect(page.getByTestId("status-busy")).toHaveCount(0);
    await page.getByTestId("composer-input").fill("черновик");
    await expect(page.getByTestId("send")).toBeEnabled(); // чужой ход не блокирует ввод в другой задаче

    await taskItem(page, p.task.id).click();
    await expect(page.getByTestId("chat-task-title")).toHaveText("Переключение: P");
    await expect(chatItem(page, p.chat.id)).toHaveAttribute("aria-current", "true");
    await expect(spinner(page, p.chat.id)).toHaveCount(1);
    await expect(page.getByTestId("stop")).toBeVisible();
    const ai = page.getByTestId("msg-ai");
    await expect(ai).toHaveCount(1);
    await expect(page.getByTestId("msg-user")).toHaveCount(1);
    await expect(ai.last()).toHaveAttribute("data-live", "1");
    const seen = maxToken(await ai.last().innerText());
    await expect.poll(async () => maxToken(await ai.last().innerText()), { message: "ответ продолжает дописываться" }).toBeGreaterThan(seen + 5);
    // уже набранная часть пришла один раз: каждое «токенN» встречается однажды
    const live = [...(await ai.last().innerText()).matchAll(/токен\d+/g)].map((m) => m[0]);
    expect(new Set(live).size, "текст ответа не задвоился после возврата").toBe(live.length);

    await page.getByTestId("stop").click();
    await waitIdle(page);
    await expect(ai).toHaveCount(1);
    await expect(page.getByTestId("msg-user")).toHaveCount(1);
    await expect(ai.last()).toContainText("(остановлено)");
    await expect(spinner(page, p.chat.id)).toHaveCount(0);
  });

  test("ход в задаче P закончился, пока открыта задача Q: список чатов и лента Q не подменяются чатами P", async ({ page, request }) => {
    const p = await createTask(request, "Фон: задача P");
    const q = await createTask(request, "Фон: задача Q");
    await openAt(page, p.task.id, p.chat.id);
    const sendResp = page.waitForResponse((r) => r.url().endsWith(`/api/chats/${p.chat.id}/send`));
    await startSlow(page, p.chat.id, "долгий вопрос в задаче P");
    const resp = await sendResp;

    await taskItem(page, q.task.id).click();
    await expect(page.getByTestId("chat-task-title")).toHaveText("Фон: задача Q");
    await expect(chatItem(page, q.chat.id)).toHaveAttribute("aria-current", "true");
    // ход в P заканчивается, пока пользователь в Q (здесь — «стоп» по API; так же бывает, когда модель просто договорила)
    expect((await request.post(`/api/chats/${p.chat.id}/stop`)).ok()).toBe(true);
    await expect.poll(() => chatBusy(request, p.chat.id), { timeout: 20_000 }).toBe(false); // ход кончился; resp.finished() не годится: при уходе из P поток /send закрывается (TC-5) — для Playwright это requestfailed
    // после конца хода клиент перечитывает данные — ждём возможный запрос чатов P (или 4 с тишины)
    await page.waitForResponse((r) => r.url().includes(`/api/tasks/${p.task.id}/chats`), { timeout: 4000 }).catch(() => {});

    await expect(taskItem(page, q.task.id)).toHaveAttribute("aria-current", "true");
    await expect(chatItem(page, p.chat.id), "чат задачи P не должен оказаться под задачей Q").toHaveCount(0, { timeout: 3000 });
    await expect(page.getByTestId("empty-new-chat"), "открытый чат Q не пропал").toHaveCount(0, { timeout: 3000 });
    await expect(chatItem(page, q.chat.id)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("chat-task-title")).toHaveText("Фон: задача Q");
  });

  test("индикатор «отвечает» в сайдбаре есть и у чата, у которого уже есть название", async ({ page, request }) => {
    const p = await createTask(request, "Индикатор: чат с названием");
    const b = await newChat(request, p.task.id);
    await openAt(page, p.task.id, p.chat.id);
    await send(page, "[[short]] [[nomem]] первый вопрос");
    await waitIdle(page);
    await expect(chatItem(page, p.chat.id)).toContainText("первый вопрос");

    await startSlow(page, p.chat.id, "второй, долгий вопрос");
    await chatItem(page, b.id).click();
    await expect(page.getByTestId("hero")).toBeVisible();
    await expect.poll(() => chatBusy(request, p.chat.id), { message: "первый чат всё ещё отвечает" }).toBe(true);
    await expect(spinner(page, p.chat.id), "у отвечающего чата в сайдбаре крутится индикатор").toHaveCount(1, { timeout: 3000 });
  });

  test("перезагрузка посреди ответа: индикатор чата в сайдбаре гаснет, когда ход закончился", async ({ page, request }) => {
    const p = await createTask(request, "Индикатор после перезагрузки");
    await openAt(page, p.task.id, p.chat.id);
    await startSlow(page, p.chat.id, "вопрос перед перезагрузкой");
    await page.reload();
    await expect(page.getByTestId("msg-ai").last()).toHaveAttribute("data-live", "1");
    await expect(spinner(page, p.chat.id)).toHaveCount(1);
    await page.getByTestId("stop").click();
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("(остановлено)");
    await expect.poll(() => chatBusy(request, p.chat.id)).toBe(false);
    await expect(spinner(page, p.chat.id), "ход закончился — индикатор погас").toHaveCount(0, { timeout: 5000 });
  });

  test("многократное переключение на отвечающий чат не вешает интерфейс (потоки ушедших экранов закрываются)", async ({ page, request }) => {
    const p = await createTask(request, "Переключения туда-обратно");
    const b = await newChat(request, p.task.id);
    await openAt(page, p.task.id, p.chat.id);
    await startSlow(page, p.chat.id, "долгий ответ");
    for (let i = 1; i <= 7; i++) {
      await chatItem(page, b.id).click();
      await expect(page.getByTestId("hero"), `пустой чат открылся (заход ${i})`).toBeVisible({ timeout: 5000 });
      await chatItem(page, p.chat.id).click();
      await expect(page.getByTestId("msg-user"), `история отвечающего чата загрузилась (заход ${i})`).toHaveCount(1, { timeout: 5000 });
      await expect(page.getByTestId("msg-ai").last()).toHaveAttribute("data-live", "1", { timeout: 5000 });
    }
  });

  test("новый чат во время ответа: он свободен, в нём можно спросить параллельно; первый чат дописывается и останавливается", async ({ page, request }) => {
    const p = await createTask(request, "Параллельные чаты");
    await openAt(page, p.task.id, p.chat.id);
    await startSlow(page, p.chat.id, "первый долгий вопрос");

    await page.getByTestId("new-chat").click();
    const items = page.getByTestId("chat-item");
    await expect(items).toHaveCount(2);
    const sel = page.locator('[data-testid="chat-item"][aria-current="true"]');
    await expect(sel).toHaveCount(1);
    await expect(sel).not.toHaveAttribute("data-chat-id", p.chat.id);
    const nid = (await sel.getAttribute("data-chat-id"))!;
    await expect(page.getByTestId("hero")).toBeVisible();
    await expect(page.getByTestId("stop")).toHaveCount(0);
    await expect(page.getByTestId("status-busy")).toHaveCount(0);
    await expect(spinner(page, p.chat.id), "у первого чата индикатор «отвечает»").toHaveCount(1);

    await send(page, "[[short]] [[nomem]] параллельный вопрос");
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
    expect(await chatBusy(request, p.chat.id), "первый чат всё ещё отвечает").toBe(true);
    await expect(chatItem(page, nid)).toContainText("параллельный вопрос");

    await chatItem(page, p.chat.id).click();
    const ai = page.getByTestId("msg-ai");
    await expect(page.getByTestId("msg-user")).toHaveCount(1);
    await expect(page.getByTestId("msg-user")).toContainText("первый долгий вопрос");
    await expect(ai).toHaveCount(1);
    await expect(ai.last()).toHaveAttribute("data-live", "1");
    await expect(ai.last(), "ответ параллельного чата не попал в первый").not.toContainText("Коротко: да.");
    await page.getByTestId("stop").click();
    await waitIdle(page);
    await expect(ai.last()).toContainText("(остановлено)");
    await expect(spinner(page, p.chat.id)).toHaveCount(0);
  });

  test("удаление отвечающего чата через своё подтверждение, затем последнего: выбор переходит, удалённый не возвращается", async ({ page, request }) => {
    const p = await createTask(request, "Удаление чатов");
    const b = await newChat(request, p.task.id);
    await openAt(page, p.task.id, p.chat.id);
    await startSlow(page, p.chat.id, "удали меня посреди ответа");
    const a = chatItem(page, p.chat.id);
    await expect(a).toContainText("удали меня посреди ответа");
    await a.hover();
    await a.getByTestId("chat-delete").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText("удали меня посреди ответа");
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toast").filter({ hasText: "чат удалён" })).toBeVisible();
    await expect(a).toHaveCount(0);
    await expect(chatItem(page, b.id)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("hero")).toBeVisible();
    await expect(page.getByTestId("stop")).toHaveCount(0);
    await expect(page.getByTestId("status-busy")).toHaveCount(0);
    expect((await chatsOf(request, p.task.id)).map((c) => c.id)).toEqual([b.id]);
    expect((await request.get("/api/health")).ok(), "сервер жив").toBe(true);
    await page.waitForTimeout(800); // поздние ответы ушедшего экрана не должны вернуть удалённый чат в список
    await expect(a).toHaveCount(0);
    await expect(page.getByTestId("chat-item")).toHaveCount(1);
    await expect(errorToasts(page)).toHaveCount(0);

    // последний чат задачи; Enter в подтверждении = «удалить»
    const bi = chatItem(page, b.id);
    await bi.hover();
    await bi.getByTestId("chat-delete").click();
    await expect(page.getByTestId("confirm-ok")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("chat-item")).toHaveCount(0);
    await expect(page.getByTestId("empty-new-chat")).toBeVisible();
    await expect(page.getByTestId("right-panel")).toBeVisible();
    await expect(page.getByTestId("new-chat")).toBeVisible();
    // в localStorage — id удалённого чата: после перезагрузки то же состояние и без ошибок
    await page.reload();
    await expect(page.getByTestId("empty-new-chat")).toBeVisible();
    await expect(errorToasts(page)).toHaveCount(0);
    await page.getByTestId("empty-new-chat").click();
    await expect(page.getByTestId("chat-item")).toHaveCount(1);
    await expect(page.locator('[data-testid="chat-item"][aria-current="true"]')).toHaveCount(1);
    await expect(page.getByTestId("hero")).toBeVisible();
    await send(page, "[[short]] [[nomem]] снова работаем");
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
  });

  test("смена задачи при медленном ответе сервера: сообщение, набранное под заголовком новой задачи, не уходит в чат старой", async ({ page, request }) => {
    const p = await createTask(request, "Медленный список: P");
    const q = await createTask(request, "Медленный список: Q");
    await openAt(page, p.task.id, p.chat.id);
    await send(page, "[[short]] [[nomem]] сообщение в задаче P");
    await waitIdle(page);
    // список чатов Q приходит с задержкой (сервер занят: индексация PDF, диск и т. п.)
    await page.route(`**/api/tasks/${q.task.id}/chats`, async (route) => {
      if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    const sent = page.waitForRequest((r) => r.method() === "POST" && /\/api\/chats\/[^/]+\/send$/.test(r.url()));
    await taskItem(page, q.task.id).click();
    await expect(page.getByTestId("chat-task-title")).toHaveText("Медленный список: Q");
    // пользователь видит задачу Q и сразу пишет
    const input = page.getByTestId("composer-input");
    await input.fill("[[short]] [[nomem]] вопрос по задаче Q");
    await input.press("Enter");
    const req = await sent;
    expect(req.url(), `сообщение не должно уйти в чат задачи P (${p.chat.id})`).not.toContain(p.chat.id);
    expect(req.url(), "сообщение ушло в чат задачи Q").toContain(q.chat.id);
  });

  test("юникод, эмодзи, RTL и HTML в названии, курсе и условии: показываются как текст, без переполнения, в модель уходят без искажений", async ({ page, request }) => {
    const title = "🛡️ Лаба ‏שלום‏ مرحبا 👨‍👩‍👧 <img src=x onerror=alert(1)> «ёлка» & co";
    const course = "Сети 🌐 ‏עברית‏";
    const brief = "Условие ‏בדיקה‏ و عربي:\n  1) ping -c1 10.0.0.1 👋\n  2) <script>alert('xss')</script> <b>жирный?</b>\n  3) ${HOME} `uname -a` $x^2$\n";
    await page.goto("/");
    await page.getByTestId("new-task").click();
    await page.getByTestId("task-title").fill(title);
    await page.getByTestId("task-course").fill(course);
    await page.getByTestId("task-brief").fill(brief);
    await page.getByTestId("task-save").click();
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);

    const header = page.getByTestId("chat-task-title");
    await expect(header).toHaveText(title);
    await expect(header, "подсказка в шапке — условие как есть").toHaveAttribute("title", brief);
    const sel = page.locator('[data-testid="task-item"][aria-current="true"]');
    await expect(sel).toContainText(title);
    await expect(sel).toContainText(course);
    await expect(page.getByTestId("hero")).toContainText(title);
    // разметка не исполняется и не превращается в элементы
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.locator("script", { hasText: "xss" })).toHaveCount(0);
    await expectNoOverflowX(page.getByTestId("task-list"), "список задач");
    await expectNoOverflowX(page.getByTestId("chat-header"), "шапка чата");

    await mockReset(request);
    await send(page, "[[short]] проверь условие 🙂");
    await waitIdle(page);
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const sys = textOf(req.body.messages[0].content);
    expect(sys).toContain(`# ЗАДАЧА: ${title}  (курс: ${course})`);
    expect(sys).toContain(brief.trim());
    expect(textOf(req.body.messages.at(-1).content)).toContain("проверь условие 🙂");
    await expect(page.getByTestId("chat-title")).toContainText("проверь условие 🙂");

    // повторное открытие диалога и перезагрузка: значения те же до символа
    await page.getByTestId("edit-task").click();
    await expect(page.getByTestId("task-title")).toHaveValue(title);
    await expect(page.getByTestId("task-course")).toHaveValue(course);
    await expect(page.getByTestId("task-brief")).toHaveValue(brief);
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(header).toHaveText(title);
    await expect(header).toHaveAttribute("title", brief);
  });

  test("название чата из первого сообщения: эмодзи на границе 60 символов не разрезается пополам", async ({ page, request }) => {
    const p = await createTask(request, "Эмодзи в названии чата");
    await openAt(page, p.task.id, p.chat.id);
    await send(page, "а".repeat(59) + "😀 хвост сообщения [[short]] [[nomem]]");
    await waitIdle(page);
    await expect(page.getByTestId("msg-user"), "само сообщение не пострадало").toContainText("а".repeat(59) + "😀 хвост");
    const title = (await chatsOf(request, p.task.id)).find((c) => c.id === p.chat.id)!.title;
    expect(title.startsWith("а".repeat(59))).toBe(true);
    expect(title, "в названии нет U+FFFD и половинок суррогатной пары").not.toMatch(/�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    await expect(chatItem(page, p.chat.id)).not.toContainText("�");
  });

  test("правка задачи меняет системный промпт следующего хода: название, курс, условие; пустое условие — заглушка", async ({ page, request }) => {
    const p = await createTask(request, "Условие: до правки", { course: "Сети", brief: "Старое условие: настроить VLAN 10 на коммутаторе." });
    await openAt(page, p.task.id, p.chat.id);
    await send(page, "[[short]] [[nomem]] что в условии?");
    await waitIdle(page);
    let sys = textOf((await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!.body.messages[0].content);
    expect(sys).toContain("# ЗАДАЧА: Условие: до правки  (курс: Сети)");
    expect(sys).toContain("Старое условие: настроить VLAN 10");

    const NEW = "Новое условие: поднять OSPF между R1 и R2, area 0.";
    await page.getByTestId("edit-task").click();
    await page.getByTestId("task-title").fill("Условие: после правки");
    await page.getByTestId("task-course").fill("Linux");
    await page.getByTestId("task-brief").fill(NEW);
    await page.getByTestId("task-save").click();
    await expect(page.getByTestId("toast").filter({ hasText: "задача сохранена" })).toBeVisible();
    await expect(page.getByTestId("chat-task-title")).toHaveText("Условие: после правки");
    await expect(page.getByTestId("chat-task-title")).toHaveAttribute("title", NEW);
    await expect(taskItem(page, p.task.id)).toContainText("Linux");
    await expect(page.getByTestId("msg-user"), "правка задачи не сбрасывает открытый чат").toHaveCount(1);

    await mockReset(request);
    await send(page, "[[short]] [[nomem]] а теперь?");
    await waitIdle(page);
    sys = textOf((await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!.body.messages[0].content);
    expect(sys).toContain("# ЗАДАЧА: Условие: после правки  (курс: Linux)");
    expect(sys).toContain(NEW);
    expect(sys).not.toContain("Старое условие");
    expect(sys).not.toContain("до правки");

    // стёрли курс и условие (Ctrl+Enter сохраняет)
    await page.getByTestId("edit-task").click();
    await page.getByTestId("task-course").fill("");
    await page.getByTestId("task-brief").fill("");
    await page.getByTestId("task-brief").press("Control+Enter");
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
    await expect(page.getByTestId("chat-task-title"), "без условия подсказка — название").toHaveAttribute("title", "Условие: после правки");
    await mockReset(request);
    await send(page, "[[short]] [[nomem]] и без условия?");
    await waitIdle(page);
    sys = textOf((await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!.body.messages[0].content);
    expect(sys).toContain("# ЗАДАЧА: Условие: после правки\n(условие не записано");
    expect(sys).not.toContain("(курс:");
    expect(sys).not.toContain("OSPF");
  });
});
