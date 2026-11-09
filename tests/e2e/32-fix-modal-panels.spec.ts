import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, createTask, openTask, send, termText, waitContainer, type Ids } from "./helpers";

// Регрессии к правкам модальных окон (ui.tsx), панелей памяти/библиотеки и диалога задачи (Panels.tsx),
// терминалов (Terminals.tsx): стек модалок, inert + ловушка фокуса, возврат фокуса, правка карточек памяти,
// зона загрузки библиотеки с клавиатуры.

type Mem = { id: number; kind: string; title: string; content: string; status: string };
const mems = async (request: APIRequestContext, taskId: string) =>
  (await (await request.get(`/api/tasks/${taskId}/memories`)).json()) as Mem[];
async function addMem(request: APIRequestContext, taskId: string, m: { kind?: string; title: string; content: string }) {
  const r = await request.post(`/api/tasks/${taskId}/memories`, { data: m });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()) as Mem;
}
const panelCard = (page: Page, id: number) => page.getByTestId("memory-panel").locator(`[data-testid="memory-card"][data-id="${id}"]`);
const inDialog = (page: Page, testid: string) =>
  page.evaluate((t) => !!document.activeElement?.closest(`[data-testid="${t}"]`), testid);
const activeTestId = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? document.activeElement?.tagName ?? "");

const TITLE = "Фикс модалок: VLAN и маршрутизация";

// Синтетические keydown прямо в textarea xterm — как если бы фокус всё-таки оказался в терминале под окном.
// Обходят inert и ловушку фокуса (фокус остаётся в диалоге), так что проверяют именно страховку в Terminals.tsx.
// Только строчные латинские буквы и цифры: их xterm превращает в ввод уже на keydown.
const xtermKeys = (page: Page, text: string) => page.evaluate((t) => {
  const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="term-shell"] .xterm-helper-textarea')!;
  const key = (k: string, keyCode: number) =>
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: k, keyCode, bubbles: true, cancelable: true } as KeyboardEventInit));
  for (const ch of t) key(ch, ch.toUpperCase().charCodeAt(0));
  key("Enter", 13);
}, text);

// Первый GET /api/tasks после создания задачи отвечает без сети (одними микрозадачами): onSave в App
// возвращается раньше, чем React успевает закрыть окно. Так воспроизводится гонка флага «создаём задачу».
function instantTasksAfterCreate() {
  const w = window as any;
  const real = w.fetch.bind(w);
  let last: unknown[] = [], created: { id: string } | null = null, armed = false;
  w.fetch = async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.pathname === "/api/tasks" && method === "GET" && armed && created) {
      armed = false;
      const list = [created, ...last.filter((t: any) => t.id !== created!.id)];
      return { ok: true, status: 200, statusText: "OK", json: () => Promise.resolve(list) };
    }
    const r: Response = await real(input, init);
    if (url.pathname === "/api/tasks" && r.ok) {
      if (method === "GET") last = await r.clone().json().catch(() => last);
      else if (method === "POST") { created = (await r.clone().json()).task; armed = true; }
    }
    return r;
  };
}

test.describe("модальные окна: стек, inert, фокус", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, TITLE, { course: "Сети", brief: "Условие для проверки модальных окон." });
  });

  test("пока открыт диалог, нажатия не доходят до root-shell под затемнением (inert на #root)", async ({ page }) => {
    await openTask(page, ids, { tab: "term" });
    const shell = page.getByTestId("term-shell");
    await expect(shell).toHaveAttribute("data-ws", "open", { timeout: 20_000 });
    // контроль способа ввода: без окна синтетические клавиши в xterm доходят до shell (он их эхом печатает)
    await xtermKeys(page, "okctl42");
    await expect.poll(() => termText(page, "shell"), { timeout: 15_000 }).toContain("okctl42");
    await page.getByTestId("edit-task").click();
    await expect(page.getByTestId("task-dialog")).toBeVisible();
    await expect(page.locator("#root")).toHaveAttribute("inert", "");

    // попытка увести фокус в xterm программно и Shift+Tab'ами — фокус остаётся в диалоге
    await shell.locator(".xterm-helper-textarea").focus();
    expect(await inDialog(page, "task-dialog"), "focus() на элемент под затемнением не срабатывает").toBe(true);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await inDialog(page, "task-dialog"), `Shift+Tab №${i + 1}`).toBe(true);
    }
    // клавиши, нацеленные прямо в xterm при открытом окне, в shell не уходят (страховка Terminals.tsx)
    await xtermKeys(page, "leak42");
    expect(await inDialog(page, "task-dialog")).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
    await expect(page.locator("#root")).not.toHaveAttribute("inert", "");

    // после закрытия ввод в shell работает. Эхо идёт по порядку: когда видно OK_42, эхо leak42 уже было бы видно
    await shell.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("echo OK_$((6*7))");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page, "shell"), { timeout: 15_000 }).toContain("OK_42");
    expect(await termText(page, "shell")).not.toContain("leak42");
  });

  test("пока открыто окно, автоматические ответы xterm на запросы программ (DA) доходят до shell", async ({ page }) => {
    await openTask(page, ids, { tab: "term" });
    const shell = page.getByTestId("term-shell");
    await expect(shell).toHaveAttribute("data-ws", "open", { timeout: 20_000 });
    await shell.locator(".xterm-helper-textarea").focus();
    // запрос DA (ESC[c) уходит через 6 с, когда окно уже открыто; read ждёт ответ xterm (ESC[?1;2c) до 10 с
    await page.keyboard.type("sleep 6; printf '\\033[c'; IFS= read -rs -t 10 -d c R; echo DA_LEN_${#R}");
    await page.keyboard.press("Enter");
    await page.getByTestId("edit-task").click();
    await expect(page.getByTestId("task-dialog")).toBeVisible();
    expect(await termText(page, "shell"), "запрос ещё не ушёл, когда окно открылось").not.toMatch(/DA_LEN_\d/);
    await expect.poll(() => termText(page, "shell"), { timeout: 30_000 }).toMatch(/DA_LEN_\d/);
    expect(await termText(page, "shell"), "ответ на DA дошёл до программы в shell").toMatch(/DA_LEN_[1-9]/);
    await expect(page.getByTestId("task-dialog"), "всё это время окно было открыто").toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
  });

  test("подтверждение поверх диалога задачи: клик по фону закрывает только его, нижнее окно недоступно, фокус — обратно на «удалить»", async ({ page, request }) => {
    await openTask(page, ids);
    await page.getByTestId("edit-task").click();
    const edited = `${TITLE} — правка`;
    await page.getByTestId("task-title").fill(edited);
    await page.getByTestId("task-delete").click();
    const confirm = page.getByTestId("confirm-dialog");
    await expect(confirm).toContainText("Удалить задачу?");
    // нижнее окно (его затемнение) и всё приложение — inert; верхний диалог назван по заголовку
    await expect(page.getByTestId("task-dialog").locator("xpath=..")).toHaveAttribute("inert", "");
    await expect(page.getByTestId("confirm-dialog").locator("xpath=..")).not.toHaveAttribute("inert", "");
    await expect(page.locator("#root")).toHaveAttribute("inert", "");
    await expect(page.getByRole("dialog", { name: "Удалить задачу?" })).toBeVisible();
    await expect(page.getByTestId("confirm-ok")).toBeFocused();
    // Tab ходит по кругу только внутри подтверждения
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      expect(await inDialog(page, "confirm-dialog"), `Tab №${i + 1} внутри подтверждения`).toBe(true);
    }
    await page.mouse.click(5, 5); // фон верхнего окна
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId("task-dialog")).toBeVisible();
    await expect(page.getByTestId("task-title")).toHaveValue(edited);
    await expect(page.getByTestId("task-dialog").locator("xpath=..")).not.toHaveAttribute("inert", "");
    await expect(page.getByTestId("task-delete"), "фокус вернулся на «удалить» в диалоге задачи").toBeFocused();
    // Esc теперь закрывает диалог задачи (верхний в стеке), правка не сохраняется
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
    await expect(page.getByTestId("edit-task")).toBeFocused();
    const t = (await (await request.get("/api/tasks")).json()) as { id: string; title: string }[];
    expect(t.find((x) => x.id === ids.task.id)?.title).toBe(TITLE);
  });

  test("«отмена» и крестик возвращают фокус на кнопку, открывшую окно; подтверждение удаления карточки — тоже", async ({ page, request }) => {
    const m = await addMem(request, ids.task.id, { kind: "fact", title: "Карточка для фокуса", content: "проверка возврата фокуса" });
    await openTask(page, ids, { tab: "mem" });
    await page.getByTestId("new-task").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("task-title")).toBeFocused();
    await page.getByTestId("task-cancel").click();
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
    await expect(page.getByTestId("new-task")).toBeFocused();

    await page.getByTestId("edit-task").focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("task-dialog-close").click();
    await expect(page.getByTestId("edit-task")).toBeFocused();

    const del = panelCard(page, m.id).getByTestId("mem-delete");
    await del.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("confirm-ok")).toBeFocused();
    await page.getByTestId("confirm-cancel").click();
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
    await expect(del).toBeFocused();
    expect((await mems(request, ids.task.id)).some((x) => x.id === m.id)).toBe(true);
    await request.delete(`/api/memories/${m.id}`);
  });

  test("несохранённая правка в диалоге задачи переживает фоновое обновление списка задач", async ({ page, request }) => {
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[slow]] долгий ответ, пока правлю условие");
    await expect(page.getByTestId("stop")).toBeVisible();
    await page.getByTestId("edit-task").click();
    const edited = `${TITLE} — не сохранено`;
    await page.getByTestId("task-title").fill(edited);
    await page.getByTestId("task-brief").fill("новое условие, ещё не сохранено");
    // конец хода (стоп через API) → ChatView.onChanged → App перечитывает /api/tasks (новые объекты задач)
    let reloads = 0;
    page.on("response", (r) => { if (r.request().method() === "GET" && new URL(r.url()).pathname === "/api/tasks") reloads++; });
    const before = reloads;
    expect((await request.post(`/api/chats/${c.id}/stop`)).ok()).toBe(true);
    await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => reloads, { message: "после конца хода список задач перечитан", timeout: 15_000 }).toBeGreaterThan(before);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("task-dialog")).toBeVisible();
    await expect(page.getByTestId("task-title")).toHaveValue(edited);
    await expect(page.getByTestId("task-brief")).toHaveValue("новое условие, ещё не сохранено");
    expect(await inDialog(page, "task-dialog"), "конец хода не увёл фокус из диалога в поле ввода").toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
  });

  test("после создания задачи фокус — в поле ввода её первого чата, а не на «новая задача»", async ({ page, request }) => {
    await openTask(page, ids);
    await page.getByTestId("new-task").focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("task-title").fill("Фикс модалок: временная задача");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
    const item = page.getByTestId("task-item").filter({ hasText: "Фикс модалок: временная задача" });
    await expect(item).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("composer-input")).toBeFocused({ timeout: 5000 });
    const id = (await item.getAttribute("data-task-id"))!;
    await waitContainer(request, id);
    expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true);
  });

  test("после создания задачи фокус в поле ввода, даже если onSave вернулся раньше, чем окно закрылось", async ({ page, request }) => {
    await page.addInitScript(instantTasksAfterCreate);
    await openTask(page, ids);
    await page.getByTestId("new-task").focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("task-title").fill("Фикс модалок: быстрый список задач");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
    const item = page.getByTestId("task-item").filter({ hasText: "Фикс модалок: быстрый список задач" });
    await expect(item).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("composer-input")).toBeFocused({ timeout: 5000 });
    const id = (await item.getAttribute("data-task-id"))!;
    await waitContainer(request, id);
    expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true);
  });

  test("создать задачу не удалось: окно остаётся с введённым, «отмена» возвращает фокус на «новая задача»", async ({ page, request }) => {
    const before = ((await (await request.get("/api/tasks")).json()) as unknown[]).length;
    await openTask(page, ids);
    await page.route("**/api/tasks", (r) => r.request().method() === "POST"
      ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "сбой создания задачи" }) })
      : r.continue());
    await page.getByTestId("new-task").focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("task-title").fill("Фикс модалок: не создастся");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("toast").filter({ hasText: "сбой создания задачи" })).toBeVisible();
    await expect(page.getByTestId("task-dialog")).toBeVisible();
    await expect(page.getByTestId("task-title")).toHaveValue("Фикс модалок: не создастся");
    await expect(page.getByTestId("task-save")).toBeEnabled();
    await page.getByTestId("task-cancel").click();
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
    await expect(page.getByTestId("new-task"), "фокус вернулся на кнопку, открывшую окно").toBeFocused();
    await page.unroute("**/api/tasks");
    expect(((await (await request.get("/api/tasks")).json()) as unknown[]).length).toBe(before);
  });

  test("длинный текст подтверждения на низком экране прокручивается с клавиатуры: тело окна — в круге Tab", async ({ page, request }) => {
    const long = "маршрут по умолчанию через br0.10 после пересоздания контейнера и сброса таблицы ".repeat(3).slice(0, 200).trim();
    const m = await addMem(request, ids.task.id, { kind: "fact", title: long, content: "длинная карточка для прокрутки" });
    await openTask(page, ids, { tab: "mem" });
    await page.setViewportSize({ width: 1366, height: 260 });
    const del = panelCard(page, m.id).getByTestId("mem-delete");
    await del.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("confirm-ok")).toBeFocused();
    const body = page.getByTestId("confirm-dialog-body");
    const sz = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(sz.sh, "текст не помещается — тело окна прокручивается").toBeGreaterThan(sz.ch + 1);
    await page.keyboard.press("Shift+Tab"); // «отмена»
    await page.keyboard.press("Shift+Tab"); // тело окна
    await expect(body).toBeFocused();
    await page.keyboard.press("PageDown");
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("confirm-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
    await expect(del).toBeFocused();
    expect((await mems(request, ids.task.id)).some((x) => x.id === m.id)).toBe(true);
    await request.delete(`/api/memories/${m.id}`);
  });
});

test.describe("карточки памяти и библиотека", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, "Фикс панелей: память и библиотека");
  });

  test("правка карточки: пробелы вместо заголовка или сути сохранить нельзя, значения обрезаются, «отмена» откатывает", async ({ page, request }) => {
    const m = await addMem(request, ids.task.id, { kind: "fact", title: "Шлюз лабы", content: "10.0.10.1" });
    await openTask(page, ids, { tab: "mem" });
    const card = panelCard(page, m.id);
    const save = card.getByTestId("mem-confirm");
    await card.getByTestId("mem-edit").click();
    await expect(card.getByRole("combobox", { name: "тип карточки" })).toBeVisible();
    await card.getByTestId("mem-title").fill("   ");
    await expect(save, "заголовок из одних пробелов").toBeDisabled();
    await card.getByTestId("mem-title").fill("Шлюз VLAN 10");
    await card.getByTestId("mem-content").fill(" \n ");
    await expect(save, "суть из одних пробелов").toBeDisabled();
    await card.getByTestId("mem-content").fill("  ip route add default via 10.0.10.1  \n");
    await card.getByTestId("mem-kind").selectOption("command");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(card.getByTestId("mem-title")).toHaveCount(0);
    await expect(card).toContainText("Шлюз VLAN 10");
    const saved = (await mems(request, ids.task.id)).find((x) => x.id === m.id)!;
    expect([saved.kind, saved.title, saved.content]).toEqual(["command", "Шлюз VLAN 10", "ip route add default via 10.0.10.1"]);

    // «отмена» выбрасывает черновик, в том числе вид карточки
    await card.getByTestId("mem-edit").click();
    await card.getByTestId("mem-kind").selectOption("mistake");
    await card.getByTestId("mem-title").fill("");
    await card.getByTestId("mem-edit").click();
    await card.getByTestId("mem-edit").click();
    await expect(card.getByTestId("mem-kind")).toHaveValue("command");
    await expect(card.getByTestId("mem-title")).toHaveValue("Шлюз VLAN 10");
    await expect(save).toBeEnabled();
    await card.getByTestId("mem-edit").click();
  });

  test("ошибка сохранения правки не закрывает редактор и не теряет черновик", async ({ page, request }) => {
    const m = await addMem(request, ids.task.id, { kind: "fact", title: "Маска лабы", content: "/26" });
    await openTask(page, ids, { tab: "mem" });
    const card = panelCard(page, m.id);
    await card.getByTestId("mem-edit").click();
    await card.getByTestId("mem-title").fill("Маска лабы (уточнено)");
    await page.route(`**/api/memories/${m.id}/confirm`, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "сбой сохранения" }) }));
    await card.getByTestId("mem-confirm").click();
    await expect(page.getByTestId("toast").filter({ hasText: "сбой сохранения" })).toBeVisible();
    await expect(card.getByTestId("mem-title")).toHaveValue("Маска лабы (уточнено)");
    await page.unroute(`**/api/memories/${m.id}/confirm`);
    await card.getByTestId("mem-confirm").click();
    await expect(card.getByTestId("mem-title")).toHaveCount(0);
    await expect(card).toContainText("Маска лабы (уточнено)");
  });

  test("ручное добавление: «отмена» очищает форму, пустое не добавить, значения обрезаются", async ({ page, request }) => {
    await openTask(page, ids, { tab: "mem" });
    await page.getByTestId("mem-add").click();
    const form = page.getByTestId("mem-add-form");
    await expect(form.getByRole("combobox", { name: "тип карточки" })).toBeVisible();
    await page.getByTestId("mem-add-kind").selectOption("mistake");
    await page.getByTestId("mem-add-title").fill("черновик");
    await page.getByTestId("mem-add-content").fill("который отменили");
    await page.getByTestId("mem-add").click(); // «отмена»
    await expect(form).toHaveCount(0);
    await page.getByTestId("mem-add").click();
    await expect(page.getByTestId("mem-add-title")).toHaveValue("");
    await expect(page.getByTestId("mem-add-content")).toHaveValue("");
    await expect(page.getByTestId("mem-add-kind")).toHaveValue("fact");
    await page.getByTestId("mem-add-title").fill("  ");
    await page.getByTestId("mem-add-content").fill("что-то");
    await expect(page.getByTestId("mem-add-save")).toBeDisabled();
    await page.getByTestId("mem-add-title").fill("  Пароль стенда  ");
    await page.getByTestId("mem-add-content").fill("\n student / kali \n");
    await page.getByTestId("mem-add-save").click();
    await expect(form).toHaveCount(0);
    const m = (await mems(request, ids.task.id)).find((x) => x.title.includes("Пароль стенда"))!;
    expect([m.title, m.content, m.status]).toEqual(["Пароль стенда", "student / kali", "confirmed"]);
  });

  test("смена задачи при открытой форме «вручную»: черновик не переезжает в другую задачу, карточки прошлой не видны", async ({ page, request }) => {
    const other = await createTask(request, "Фикс панелей: вторая задача");
    const secret = await addMem(request, ids.task.id, { kind: "fact", title: "Карточка только задачи A", content: "секрет задачи A" });
    const item = (id: string) => page.locator(`[data-testid="task-item"][data-task-id="${id}"]`);
    const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
    await openTask(page, ids, { tab: "mem" });
    await expect(panelCard(page, secret.id)).toBeVisible();
    await page.getByTestId("mem-add").click();
    await page.getByTestId("mem-add-title").fill("секрет задачи A");
    await page.getByTestId("mem-add-content").fill("набрано в задаче A");

    // карточки задачи B грузятся медленно — всё это время карточек A под задачей B быть не должно
    await page.route(`**/api/tasks/${other.task.id}/memories`, async (r) => { await delay(2500); await r.continue().catch(() => {}); });
    await item(other.task.id).click();
    await expect(item(other.task.id)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("mem-add-form"), "форма задачи A закрылась").toHaveCount(0, { timeout: 1000 });
    await expect(panelCard(page, secret.id), "карточки задачи A не видны под задачей B").toHaveCount(0, { timeout: 1000 });
    await page.unroute(`**/api/tasks/${other.task.id}/memories`);
    await expect(page.getByTestId("mem-empty")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("mem-add").click();
    await expect(page.getByTestId("mem-add-title")).toHaveValue("");
    await expect(page.getByTestId("mem-add-content")).toHaveValue("");
    await page.getByTestId("mem-add").click();

    // поздний ответ по задаче A (туда и сразу обратно) не подменяет карточки задачи B
    await page.route(`**/api/tasks/${ids.task.id}/memories`, async (r) => { await delay(2500); await r.continue().catch(() => {}); });
    await item(ids.task.id).click();
    await expect(item(ids.task.id)).toHaveAttribute("aria-current", "true");
    await item(other.task.id).click();
    await expect(item(other.task.id)).toHaveAttribute("aria-current", "true");
    await page.waitForTimeout(3500);
    await expect(panelCard(page, secret.id)).toHaveCount(0);
    await expect(page.getByTestId("mem-empty")).toBeVisible();
    await page.unroute(`**/api/tasks/${ids.task.id}/memories`);

    expect(await mems(request, other.task.id), "в задачу B ничего не записано").toEqual([]);
    expect((await mems(request, ids.task.id)).map((x) => x.title)).not.toContain("секрет задачи A");
    await request.delete(`/api/memories/${secret.id}`);
    expect((await request.delete(`/api/tasks/${other.task.id}`)).ok()).toBe(true);
  });

  test("карточка-предложение в ленте чата: «отмена» откатывает черновик, пустой заголовок не сохранить", async ({ page, request }) => {
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[tool:shell:echo proposal]] покажи и запомни");
    const card = page.getByTestId("proposals").getByTestId("memory-card").first();
    await expect(card).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 45_000 });
    const saved = (await card.locator("span.truncate").textContent())!;
    await card.getByTestId("mem-edit").click();
    await card.getByTestId("mem-title").fill("   ");
    await expect(card.getByTestId("mem-confirm"), "заголовок из пробелов не сохранить").toBeDisabled({ timeout: 2000 });
    await card.getByTestId("mem-title").fill("черновик, который отменили");
    await card.getByTestId("mem-edit").click(); // «отмена»
    await card.getByTestId("mem-edit").click();
    await expect(card.getByTestId("mem-title")).toHaveValue(saved, { timeout: 2000 });
  });

  test("подсказки с полным текстом: заголовок карточки памяти, подпись терминала", async ({ page, request }) => {
    const MT = "Очень длинный заголовок карточки памяти про маршрут по умолчанию после пересоздания контейнера через br0.10";
    const m = await addMem(request, ids.task.id, { kind: "command", title: MT, content: "ip route add default via 10.0.10.1 dev br0.10" });
    await page.setViewportSize({ width: 1366, height: 768 });
    await openTask(page, ids, { tab: "mem" });
    const title = panelCard(page, m.id).locator("span.truncate");
    await expect(title).toHaveText(MT);
    await expect(title).toHaveAttribute("title", MT);
    await page.getByTestId("tab-term").click();
    await expect(page.getByTestId("term-shell").locator("span.truncate")).toHaveAttribute("title", "kali · root · /work");
  });

  test("библиотека с клавиатуры: Tab на зону загрузки, Enter и Space открывают выбор файлов; удаление видно при фокусе", async ({ page }) => {
    await openTask(page, ids, { tab: "lib" });
    await page.getByTestId("lib-scope-task").click();
    await page.getByTestId("lib-scope-task").focus();
    await page.keyboard.press("Tab");
    const drop = page.getByTestId("lib-drop");
    await expect(drop).toBeFocused();
    await expect(drop).toHaveAttribute("role", "button");

    let chooser = page.waitForEvent("filechooser", { timeout: 5000 });
    await page.keyboard.press("Space");
    await (await chooser).setFiles({ name: "клавиатура-space.md", mimeType: "text/markdown", buffer: Buffer.from("# Space\n\nзагружено пробелом\n") });
    const doc = page.getByTestId("library-panel").getByTestId("doc-item").filter({ hasText: "клавиатура-space.md" });
    await expect(doc).toHaveAttribute("data-status", "ready", { timeout: 20_000 });

    await drop.focus();
    chooser = page.waitForEvent("filechooser", { timeout: 5000 });
    await page.keyboard.press("Enter");
    await (await chooser).setFiles({ name: "клавиатура-enter.md", mimeType: "text/markdown", buffer: Buffer.from("# Enter\n\nзагружено Enter\n") });
    await expect(page.getByTestId("library-panel").getByTestId("doc-item").filter({ hasText: "клавиатура-enter.md" }))
      .toHaveAttribute("data-status", "ready", { timeout: 20_000 });

    // мышью зона по-прежнему открывает выбор файлов
    chooser = page.waitForEvent("filechooser", { timeout: 5000 });
    await drop.click();
    await chooser;

    // кнопка удаления документа, до которой дошли с клавиатуры, видима
    await drop.focus();
    let found = false;
    for (let i = 0; i < 6 && !found; i++) {
      await page.keyboard.press("Tab");
      found = (await activeTestId(page)) === "doc-delete";
    }
    expect(found, "Tab доходит до кнопки удаления документа").toBe(true);
    const del = page.locator('[data-testid="doc-delete"]:focus');
    await expect(del).toHaveAccessibleName(/удалить «клавиатура-/);
    await expect.poll(() => del.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("confirm-dialog")).toContainText("Удалить документ?");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
    await expect(del, "фокус вернулся на кнопку удаления").toHaveCount(1);
  });

  test("подтверждение с длинным именем без пробелов: имя переносится, окно целиком на низком экране", async ({ page }) => {
    const vp = { width: 1366, height: 520 };
    await page.setViewportSize(vp);
    await openTask(page, ids, { tab: "lib" });
    await page.getByTestId("lib-scope-task").click();
    const NAME = `конспект_${"очень_длинное_имя_файла_без_пробелов_".repeat(8)}финал.md`;
    await page.getByTestId("lib-input").setInputFiles({ name: NAME, mimeType: "text/markdown", buffer: Buffer.from("# X\n\nтекст\n") });
    const row = page.getByTestId("library-panel").getByTestId("doc-item").filter({ hasText: "конспект_" });
    await expect(row).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    await row.hover();
    await row.getByTestId("doc-delete").click();
    const dlg = page.getByTestId("confirm-dialog");
    await expect(dlg).toContainText("финал.md");
    const body = page.getByTestId("confirm-dialog-body");
    const r = await body.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(r.sw, "имя переносится, горизонтальной прокрутки в окне нет").toBeLessThanOrEqual(r.cw + 1);
    const b = (await dlg.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
    await expect(page.getByTestId("confirm-ok")).toBeInViewport();
    await page.getByTestId("confirm-ok").click();
    await expect(row).toHaveCount(0);
  });
});
