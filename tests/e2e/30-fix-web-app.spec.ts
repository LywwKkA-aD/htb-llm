import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, box, right, createTask, expectInside, expectNoOverflowX, mockReset, openTask, send, waitIdle, PNG_1PX, type Ids } from "./helpers";

// Регрессии исправлений web-app (App.tsx, Sidebar.tsx, api.ts, Chat.tsx), для которых в спеках 20–27 нет своего теста:
// сетевые сбои при загрузке, удаление в другой вкладке, гонки переключения задач, закрытие потока отправки,
// индикатор «отвечает» после ухода из чата, синхронизация предложений памяти, неудачная отправка (413/сеть),
// файл мимо зоны загрузки, узкое окно, «ничего не найдено», видимость кнопок при фокусе с клавиатуры.

type ChatRow = { id: string; task_id: string; title: string; busy?: boolean };
const chatItem = (page: Page, id: string) => page.locator(`[data-testid="chat-item"][data-chat-id="${id}"]`);
const taskItem = (page: Page, id: string) => page.locator(`[data-testid="task-item"][data-task-id="${id}"]`);
const errorToasts = (page: Page) => page.locator('[data-testid="toast"][data-kind="error"]');
const spinner = (page: Page, chatId: string) => chatItem(page, chatId).locator(".animate-spin");

async function newChat(request: APIRequestContext, taskId: string): Promise<ChatRow> {
  const r = await request.post(`/api/tasks/${taskId}/chats`);
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function chatBusy(request: APIRequestContext, chatId: string) {
  const r = await request.get(`/api/chats/${chatId}/log`);
  return r.ok() ? !!(await r.json()).chat.busy : false;
}
// открыть приложение на задаче/чате, не дожидаясь панели чата (её ждут сами тесты — с нужными таймаутами)
async function preset(page: Page, taskId: string, chatId?: string) {
  await page.addInitScript(([t, c]) => {
    if (sessionStorage.getItem("fix-web-app-open")) return;
    sessionStorage.setItem("fix-web-app-open", "1");
    localStorage.clear();
    localStorage.setItem("wh.task", t);
    if (c) localStorage.setItem("wh.chat", c);
    localStorage.setItem("wh.tab", "term");
  }, [taskId, chatId ?? ""] as const);
}

test.describe("исправления web-app", () => {
  test.describe.configure({ timeout: 120_000 });
  let ids: Ids;
  const long = new Set<string>();
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Исправления web-app", { course: "Сети" }); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });
  test.afterEach(async ({ request }) => {
    for (const id of long) await request.post(`/api/chats/${id}/stop`).catch(() => {});
    for (const id of long) await expect.poll(() => chatBusy(request, id), { timeout: 20_000 }).toBe(false);
    long.clear();
  });

  test("gap 6: сеть мигнула при загрузке (ERR_NETWORK_CHANGED) — задачи и чаты дозагружаются сами, а не пустой экран", async ({ page }) => {
    let tasksFails = 5, chatsFails = 3;
    await page.route("**/api/tasks", (r) => (r.request().method() === "GET" && tasksFails-- > 0 ? r.abort("internetdisconnected") : r.continue()));
    await page.route(`**/api/tasks/${ids.task.id}/chats`, (r) => (r.request().method() === "GET" && chatsFails-- > 0 ? r.abort("failed") : r.continue()));
    await preset(page, ids.task.id, ids.chat.id);
    await page.goto("/");
    await expect(taskItem(page, ids.task.id), "список задач дозагрузился").toHaveAttribute("aria-current", "true", { timeout: 25_000 });
    await expect(page.getByTestId("chat-panel"), "чаты задачи дозагрузились").toBeVisible({ timeout: 25_000 });
    await expect(chatItem(page, ids.chat.id)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("empty-new-chat")).toHaveCount(0);
    expect(tasksFails, "все сбои отработаны").toBeLessThan(0);
    expect(chatsFails).toBeLessThan(0);
  });

  test("gap 7: открытый чат удалили в другой вкладке — отправка не падает: уведомление, выбран другой чат, можно работать дальше", async ({ page, request }) => {
    const a = await newChat(request, ids.task.id);
    await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat: a });
    expect((await request.delete(`/api/chats/${a.id}`)).ok()).toBe(true); // «другая вкладка»
    const input = page.getByTestId("composer-input");
    await input.fill("[[short]] [[nomem]] в удалённый чат");
    await input.press("Enter");
    await expect(page.getByTestId("toast").filter({ hasText: "чат удалён в другой вкладке" })).toBeVisible();
    await expect(chatItem(page, a.id)).toHaveCount(0);
    const sel = page.locator('[data-testid="chat-item"][aria-current="true"]');
    await expect(sel).toHaveCount(1);
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(errorToasts(page)).toHaveCount(0);
    await send(page, "[[short]] [[nomem]] дальше в другом чате");
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
  });

  test("gap 7: открытую задачу удалили в другой вкладке — при возврате во вкладку выбрана другая задача, без ошибок", async ({ page, request }) => {
    const p = await createTask(request, "Удаляемая в другой вкладке");
    await openTask(page, p);
    await page.waitForTimeout(2200); // сверка по фокусу не чаще раза в 2 с
    expect((await request.delete(`/api/tasks/${p.task.id}`)).ok()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("toast").filter({ hasText: "задача удалена в другой вкладке" })).toBeVisible();
    await expect(taskItem(page, p.task.id)).toHaveCount(0);
    await expect(page.locator('[data-testid="task-item"][aria-current="true"]')).toHaveCount(1);
    await expect(page.getByTestId("chat-task-title")).not.toHaveText("Удаляемая в другой вкладке");
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(errorToasts(page)).toHaveCount(0);
  });

  test("TC-2: быстрая смена задач при медленном списке чатов — остаются чаты последней выбранной; новый чат, созданный перед уходом, не перетягивает выбор", async ({ page, request }) => {
    const q = await createTask(request, "Гонка: Q (медленная)");
    const r = await createTask(request, "Гонка: R");
    await openTask(page, ids);
    await page.route(`**/api/tasks/${q.task.id}/chats`, async (route) => {
      if (route.request().method() === "GET") await new Promise((res) => setTimeout(res, 2500));
      await route.continue();
    });
    const qResp = page.waitForResponse((x) => x.url().endsWith(`/api/tasks/${q.task.id}/chats`));
    await taskItem(page, q.task.id).click();
    await expect(page.getByTestId("chats-loading"), "пока чатов Q нет — ни чата прежней задачи, ни «новый чат»").toBeVisible();
    await expect(page.getByTestId("empty-new-chat")).toHaveCount(0);
    await taskItem(page, r.task.id).click();
    await expect(page.getByTestId("chat-task-title")).toHaveText("Гонка: R");
    await expect(chatItem(page, r.chat.id)).toHaveAttribute("aria-current", "true");
    await qResp;
    await page.waitForTimeout(400);
    await expect(taskItem(page, r.task.id)).toHaveAttribute("aria-current", "true");
    await expect(chatItem(page, q.chat.id), "опоздавший список Q не подменил чаты R").toHaveCount(0);
    await expect(chatItem(page, r.chat.id)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("chat-task-title")).toHaveText("Гонка: R");

    // «новый чат» в R, ответ сервера медленный, а пользователь уже ушёл в исходную задачу
    await page.route(`**/api/tasks/${r.task.id}/chats`, async (route) => {
      if (route.request().method() === "POST") await new Promise((res) => setTimeout(res, 1500));
      await route.continue();
    });
    const created = page.waitForResponse((x) => x.url().endsWith(`/api/tasks/${r.task.id}/chats`) && x.request().method() === "POST");
    await page.getByTestId("new-chat").click();
    await taskItem(page, ids.task.id).click();
    const nc = (await (await created).json()) as ChatRow;
    await page.waitForTimeout(600);
    await expect(taskItem(page, ids.task.id)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("chat-task-title")).toHaveText("Исправления web-app");
    await expect(chatItem(page, nc.id), "чат задачи R не попал в список другой задачи").toHaveCount(0);
    await expect(page.locator('[data-testid="chat-item"][aria-current="true"]')).toHaveCount(1);
  });

  test("TC-5/TC-3: уход из чата во время ответа закрывает поток отправки; когда ход кончился, индикатор в сайдбаре гаснет сам", async ({ page, request }) => {
    const a = await newChat(request, ids.task.id);
    const b = await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat: a });
    const failed = page.waitForEvent("requestfailed", { predicate: (x) => x.url().endsWith(`/api/chats/${a.id}/send`), timeout: 20_000 });
    await send(page, "[[slow]] [[nomem]] уйду посреди ответа");
    long.add(a.id);
    await expect(page.getByTestId("msg-ai").last()).toContainText("слово2");
    await chatItem(page, b.id).click();
    await expect(page.getByTestId("hero")).toBeVisible();
    await failed; // поток /send закрыт браузером
    expect(await chatBusy(request, a.id), "ход на сервере продолжается").toBe(true);
    await expect(spinner(page, a.id), "у ушедшего чата индикатор «отвечает»").toHaveCount(1);
    // ход заканчивается сам (без «стоп» и без действий пользователя) — список перечитывается, индикатор гаснет
    await expect.poll(() => chatBusy(request, a.id), { timeout: 30_000 }).toBe(false);
    await expect(spinner(page, a.id)).toHaveCount(0, { timeout: 6000 });
    // ответ сохранён целиком
    await chatItem(page, a.id).click();
    await expect(page.getByTestId("msg-ai").last()).toContainText("слово399");
    await expect(page.getByTestId("msg-ai").last()).toHaveAttribute("data-live", "0");
  });

  test("MEM-5 (интерфейс): подтверждение карточки в панели само убирает её из предложений в чате", async ({ page, request }) => {
    const c = await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat: c }, { tab: "mem" });
    await send(page, "Что такое ARP?");
    await waitIdle(page);
    const chatCards = page.getByTestId("proposals").getByTestId("memory-card");
    await expect(chatCards).toHaveCount(2);
    const [id1, id2] = await Promise.all([chatCards.nth(0).getAttribute("data-id"), chatCards.nth(1).getAttribute("data-id")]);
    const panel = page.getByTestId("memory-panel");
    // «не нужно» на устаревшей карточке больше не нажать: её нет — без расчёта на защиту на сервере
    let rejects = 0;
    page.on("request", (x) => { if (x.url().includes(`/api/memories/${id1}/reject`)) rejects++; });
    await panel.locator(`[data-testid="memory-card"][data-id="${id1}"]`).getByTestId("mem-confirm").click();
    await expect(page.getByTestId("proposals").locator(`[data-id="${id1}"]`)).toHaveCount(0, { timeout: 5000 });
    await expect(chatCards).toHaveCount(1);
    await panel.locator(`[data-testid="memory-card"][data-id="${id2}"]`).getByTestId("mem-reject").click();
    await expect(page.getByTestId("proposals")).toHaveCount(0, { timeout: 5000 });
    const mem = (await (await request.get(`/api/tasks/${ids.task.id}/memories`)).json()) as { id: number; status: string }[];
    expect(mem.find((m) => m.id === Number(id1))?.status).toBe("confirmed");
    expect(rejects).toBe(0);
  });

  test("chat-ui-2: отправка не принята (413 HTML от сервера, обрыв сети) — понятная ошибка, текст и картинка возвращаются в поле", async ({ page, request }) => {
    const c = await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat: c });
    const url = `**/api/chats/${c.id}/send`;
    const typed = "вопрос с картинкой, который нельзя потерять [[short]] [[nomem]]";
    const input = page.getByTestId("composer-input");

    await page.route(url, (r) => r.fulfill({ status: 413, contentType: "text/html", body: "<!DOCTYPE html><html><body><pre>PayloadTooLargeError: request entity too large</pre></body></html>" }));
    await page.getByTestId("attach-input").setInputFiles([{ name: "схема.png", mimeType: "image/png", buffer: PNG_1PX }]);
    await expect(page.getByTestId("thumb")).toHaveCount(1);
    await input.fill(typed);
    await input.press("Enter");
    const t413 = errorToasts(page).filter({ hasText: "413" });
    await expect(t413).toBeVisible();
    await expect(t413).not.toContainText("<");
    await expect(input).toHaveValue(typed);
    await expect(page.getByTestId("thumb")).toHaveCount(1);
    await expect(page.getByTestId("msg-user"), "неотправленное сообщение не висит в ленте").toHaveCount(0);
    await expect(page.getByTestId("send")).toBeVisible();

    await page.unroute(url);
    await page.route(url, (r) => r.abort("internetdisconnected"));
    await input.press("Enter");
    await expect(errorToasts(page).filter({ hasText: /ERR_INTERNET_DISCONNECTED|Failed to fetch|network/i })).toBeVisible();
    await expect(input).toHaveValue(typed);
    await expect(page.getByTestId("thumb")).toHaveCount(1);
    await expect(page.getByTestId("send")).toBeVisible();

    await page.unroute(url);
    await input.press("Enter");
    await expect(page.getByTestId("msg-user")).toHaveCount(1);
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("thumb")).toHaveCount(0);
  });

  test("chat-ui-3: обрыв потока /send — уже показанная часть ответа не пропадает, пока вкладка переподключается, ответ дописывается", async ({ page, request }) => {
    // как в 21-chat-ui: тело ответа /send оборачивается, window.__cut() рвёт его, как упавшая сеть
    await page.addInitScript(() => {
      const orig = window.fetch.bind(window);
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const r = await orig(...args);
        const url = String(args[0] instanceof Request ? args[0].url : args[0]);
        if (!/\/api\/chats\/[^/]+\/send$/.test(url) || !r.body) return r;
        const reader = r.body.getReader();
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        let cut = false;
        const st = new ReadableStream<Uint8Array>({
          start(c) { ctl = c; },
          async pull(c) {
            try { const { value, done } = await reader.read(); if (cut) return; if (done) c.close(); else c.enqueue(value); } catch { /* оборван */ }
          },
          cancel(reason) { void reader.cancel(reason); },
        });
        (window as any).__cut = () => { cut = true; ctl.error(new TypeError("network error")); void reader.cancel(); };
        return new Response(st, { status: r.status, headers: r.headers });
      };
    });
    const c = await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[chatui:lines:40:100]] [[nomem]] обрыв без мигания");
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai).toContainText("Строка 5");
    // следим, не пропадает ли уже показанное хоть на один кадр
    await page.evaluate(() => {
      (window as any).__lost = 0;
      const check = () => {
        const shown = [...document.querySelectorAll('[data-testid="msg-ai"]')].some((e) => (e.textContent ?? "").includes("Строка 5"));
        if (!shown) (window as any).__lost++;
      };
      new MutationObserver(check).observe(document.querySelector('[data-testid="messages"]')!, { childList: true, subtree: true, characterData: true });
    });
    await page.evaluate(() => (window as any).__cut());
    await expect(ai).toContainText("Строка 40", { timeout: 20_000 });
    await waitIdle(page);
    expect(await page.evaluate(() => (window as any).__lost), "часть ответа не исчезала при переподключении").toBe(0);
    await expect(page.getByTestId("msg-ai")).toHaveCount(1);
    await expect(ai).toHaveAttribute("data-live", "0");
    const text = await ai.innerText();
    expect((text.match(/Строка 7:/g) ?? []).length, "повтор набранного не задвоил текст").toBe(1);
  });

  test("gap 11: файл, брошенный мимо зоны загрузки, не открывается браузером (черновик цел); поле ввода по-прежнему принимает перетаскивание", async ({ page }) => {
    await openTask(page, ids);
    const input = page.getByTestId("composer-input");
    await input.fill("черновик, который нельзя потерять");
    const res = await page.evaluate(([b64]) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const mk = () => { const dt = new DataTransfer(); dt.items.add(new File([bytes], "снимок.png", { type: "image/png" })); return dt; };
      const fire = (sel: string, type: string) => {
        const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: mk() });
        document.querySelector(sel)!.dispatchEvent(ev);
        return ev.defaultPrevented;
      };
      return {
        sidebarOver: fire('[data-testid="sidebar"]', "dragover"), sidebarDrop: fire('[data-testid="sidebar"]', "drop"),
        headerDrop: fire('[data-testid="chat-header"]', "drop"), statusDrop: fire('[data-testid="statusbar"]', "drop"),
        composerDrop: fire('[data-testid="composer"]', "drop"),
      };
    }, [PNG_1PX.toString("base64")] as const);
    expect(res, "браузер не должен обрабатывать брошенный файл сам (навигация на file://)").toEqual({ sidebarOver: true, sidebarDrop: true, headerDrop: true, statusDrop: true, composerDrop: true });
    await expect(page.getByTestId("thumb"), "в поле ввода картинка принята").toHaveCount(1);
    await expect(input).toHaveValue("черновик, который нельзя потерять");
    expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  test("gap 11: окно уже 1280px — правая панель не уже 380px, чат не уже 480px, раскладка прокручивается внутри, а не сминает панели", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openTask(page, ids);
    const scroller = page.getByTestId("layout-scroll");
    const noInnerScroll = () => scroller.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(await noInnerScroll(), "на широком экране раскладка без прокрутки").toBe(true);
    for (const vp of [{ width: 1100, height: 760 }, { width: 960, height: 700 }]) {
      await page.setViewportSize(vp);
      const at = `${vp.width}×${vp.height}`;
      await expect.poll(async () => (await box(page.getByTestId("right-panel"))).width, { message: `${at}: правая панель не ужалась` }).toBeGreaterThanOrEqual(379);
      expect((await box(page.getByTestId("main-panel"))).width, `${at}: чат не уже 480px`).toBeGreaterThanOrEqual(479);
      expect((await box(page.getByTestId("sidebar"))).width, `${at}: сайдбар 272px`).toBeGreaterThan(270);
      expect(await noInnerScroll(), `${at}: раскладка прокручивается по горизонтали`).toBe(false);
      const doc = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
      expect(doc.w, `${at}: у самой страницы нет горизонтальной прокрутки`).toBeLessThanOrEqual(vp.width);
      expect(doc.h, `${at}: и вертикальной`).toBeLessThanOrEqual(vp.height);
      // шапка правой панели целиком: вкладки (в узкой — только иконки с подсказкой) и кнопки контейнера
      const header = page.getByTestId("right-header");
      for (const id of ["tab-term", "tab-mem", "tab-lib", "tab-vpn", "container-stop", "container-reset"]) await expectInside(page.getByTestId(id), header, `${at}: ${id}`);
      await expectNoOverflowX(header, `${at}: шапка правой панели`);
      for (const [id, name] of [["tab-term", "терминал"], ["tab-mem", "память задачи"], ["tab-lib", "библиотека"], ["tab-vpn", "VPN в контейнере (HTB)"]] as const)
        await expect(page.getByTestId(id), `${at}: у вкладки-иконки есть имя`).toHaveAttribute("title", name);
      // прокрутили вправо — правая панель видна целиком, статус-бар на месте
      await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
      await expect.poll(async () => right(await box(page.getByTestId("right-panel")))).toBeLessThanOrEqual(vp.width);
      expect(right(await box(page.getByTestId("statusbar")))).toBeLessThanOrEqual(vp.width + 0.5);
      await scroller.evaluate((el) => { el.scrollLeft = 0; });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(noInnerScroll, { message: "1280: снова без прокрутки" }).toBe(true);
  });

  test("TC-1: поиск без совпадений — строка «ничего не найдено», а не пустой список без объяснений", async ({ page, request }) => {
    const have = ((await (await request.get("/api/tasks")).json()) as unknown[]).length;
    for (let i = have; i < 5; i++) expect((await request.post("/api/tasks", { data: { title: `Поиск-заполнитель ${i}`, course: "", brief: "" } })).ok()).toBe(true);
    await openTask(page, ids);
    const search = page.getByTestId("task-search");
    await search.fill("такой-задачи-точно-нет-42");
    await expect(page.getByTestId("task-item")).toHaveCount(0);
    await expect(page.getByTestId("task-search-empty")).toHaveText("ничего не найдено");
    await search.fill("");
    await expect(page.getByTestId("task-search-empty")).toHaveCount(0);
    await expect(taskItem(page, ids.task.id)).toBeVisible();
  });

  test("LA-3: кнопки, видимые только при наведении (удалить чат, копировать ответ), становятся видимыми при фокусе с клавиатуры", async ({ page, request }) => {
    const c = await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[short]] [[nomem]] ответ для копирования");
    await waitIdle(page);
    await page.mouse.move(0, 0);
    const copy = page.getByTestId("copy-answer").last();
    const del = chatItem(page, c.id).getByTestId("chat-delete");
    const opacity = (l: typeof copy) => l.evaluate((el) => getComputedStyle(el).opacity);
    expect(await opacity(copy), "без наведения кнопка «копировать» скрыта").toBe("0");
    expect(await opacity(del), "без наведения кнопка удаления скрыта").toBe("0");
    await copy.focus();
    await expect.poll(() => opacity(copy), { message: "«копировать» видна при фокусе" }).toBe("1");
    await chatItem(page, c.id).getByRole("button", { name: "[[short]] [[nomem]] ответ для копирования", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(del).toBeFocused();
    await expect.poll(() => opacity(del), { message: "удаление чата видно при фокусе" }).toBe("1");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-cancel").click();
    await expect(chatItem(page, c.id)).toBeVisible();
  });

  // ---- отработка замечаний ревью (второй круг) ----

  test("LA-1: шапка правой панели не обрезает вкладки и кнопки контейнера в полосе 1172–1300px (с бейджем предложений)", async ({ page, request }) => {
    const t = await createTask(request, "LA-1 полоса ширин", { course: "Сети" });
    await openTask(page, { task: t.task, chat: t.chat });
    await send(page, "Что такое ARP?"); // мок предложит 2 карточки → на вкладке «память» появится бейдж (самая широкая шапка)
    await waitIdle(page);
    await expect(page.getByTestId("proposals")).toBeVisible();
    await expect(page.getByTestId("tab-mem"), "бейдж предложений появился").toContainText("2");
    const header = page.getByTestId("right-header");
    for (let w = 1172; w <= 1300; w += 10) {
      await page.setViewportSize({ width: w, height: 820 });
      const at = `${w}px`;
      // container-status — тот самый блок (точка/kali/кнопки), который раньше уезжал под overflow шапки
      for (const id of ["tab-term", "tab-mem", "tab-lib", "tab-vpn", "container-status", "container-reset"])
        await expectInside(page.getByTestId(id), header, `${at}: ${id}`);
      await expectNoOverflowX(header, `${at}: шапка правой панели`);
    }
    // в узкой шапке вкладки — только иконки, но доступное имя не теряется (подпись sr-only, а не display:none)
    await page.setViewportSize({ width: 1200, height: 820 });
    await expect(page.getByTestId("tab-mem"), "вкладка-иконка не теряет имя").toHaveAccessibleName(/память/);
    await expect(page.getByTestId("tab-term")).toHaveAccessibleName(/терминал/);
    await expect(page.getByTestId("tab-lib")).toHaveAccessibleName(/библиотека/);
  });

  test("chat-ui-2: при недоступном сервере неудачная отправка сразу снимает «занят» (не держит «стоп» на всё время повторов)", async ({ page, request }) => {
    const c = await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat: c });
    // весь чат-эндпоинт недоступен: рвутся и /send, и /log, и /stream — follow() будет долго перебирать повторы
    await page.route(`**/api/chats/${c.id}/**`, (r) => r.abort("internetdisconnected"));
    const input = page.getByTestId("composer-input");
    await input.fill("сообщение при полном обрыве связи [[short]] [[nomem]]");
    await input.press("Enter");
    await expect(errorToasts(page)).not.toHaveCount(0);
    // раньше «стоп» висел ~25 с, пока follow() добирал попытки; теперь «занят» снимается сразу
    await expect(page.getByTestId("send"), "кнопка отправки вернулась сразу").toBeVisible({ timeout: 4000 });
    await expect(page.getByTestId("stop")).toHaveCount(0);
    await page.unroute(`**/api/chats/${c.id}/**`);
  });

  test("chat-ui-2: сеть оборвалась ПОСЛЕ приёма /send — набранное не возвращается в поле и сообщение не задваивается", async ({ page, request }) => {
    await page.addInitScript(() => {
      const orig = window.fetch.bind(window);
      let armed = true;
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const url = String(args[0] instanceof Request ? args[0].url : args[0]);
        if (armed && /\/api\/chats\/[^/]+\/send$/.test(url)) {
          armed = false;
          const r = await orig(...args); // сервер принимает сообщение и начинает ход
          try { await r.body?.cancel(); } catch { /* */ }
          throw new TypeError("network error"); // как ERR_NETWORK_CHANGED уже после приёма
        }
        return orig(...args);
      };
    });
    const c = await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat: c });
    long.add(c.id);
    const input = page.getByTestId("composer-input");
    const typed = "это сообщение уже ушло на сервер [[short]] [[nomem]]";
    await input.fill(typed);
    await input.press("Enter");
    // поле очищается: сообщение ушло, вслепую его не возвращаем (иначе был бы дубль)
    await expect(input).toHaveValue("");
    // ход доигрывается переподключением; в ленте ровно одно сообщение пользователя
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
    await expect(page.getByTestId("msg-user")).toHaveCount(1);
    await expect(input).toHaveValue("");
  });

  test("chat-ui-8: колесо вверх внутри блока размышлений прокручивает его, а не выключает автопрокрутку ленты", async ({ page, request }) => {
    const c = await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[chatui:think:800:20]] [[nomem]] долгие размышления"); // живой блок размышлений открыт, пока нет ответа
    long.add(c.id);
    // блок размышлений растёт в ленте и становится прокручиваемым (это он — нижний живой контент, лента за ним следит)
    const inner = page.getByTestId("reasoning").locator("div.overflow-y-auto");
    await expect(inner).toBeVisible();
    await expect.poll(() => inner.evaluate((el) => el.scrollHeight > el.clientHeight + 4), { timeout: 12_000 }).toBe(true);
    await expect(page.getByTestId("to-bottom"), "лента следит за живым ответом — кнопки «вниз» нет").toHaveCount(0);
    // прокрутить сам блок размышлений вниз (scrollTop > 0), затем колесо вверх внутри него
    await inner.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect(await inner.evaluate((el) => el.scrollTop), "блок размышлений прокручен вниз").toBeGreaterThan(0);
    const b = await box(inner);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(200);
    await expect(page.getByTestId("to-bottom"), "автопрокрутка ленты не отключилась из-за прокрутки вложенного блока").toHaveCount(0);
    await page.getByTestId("stop").click();
  });

  test("chat-ui-3: сбой первого /log на занятом чате не показывает «Новый чат» поверх истории", async ({ page, request }) => {
    const c = await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[short]] [[nomem]] первый ход — будет история");
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
    await send(page, "[[slow]] [[nomem]] медленный ход, чат занят");
    long.add(c.id);
    await expect(page.getByTestId("msg-ai").last()).toContainText("слово2");
    // перезагрузка посреди хода: первый /log срывается 4 раза (j() исчерпает свои повторы), /stream чуть задержан
    let logFails = 4;
    await page.route(`**/api/chats/${c.id}/log`, (r) => (r.request().method() === "GET" && logFails-- > 0 ? r.abort("failed") : r.continue()));
    await page.route(`**/api/chats/${c.id}/stream`, async (r) => { await new Promise((res) => setTimeout(res, 800)); await r.continue(); });
    await page.reload();
    await page.evaluate(() => {
      (window as any).__heroSeen = 0;
      const check = () => { if (document.querySelector('[data-testid="hero"]')) (window as any).__heroSeen++; };
      new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
      check();
    });
    await expect(page.getByTestId("msg-user").first(), "история занятого чата появилась").toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("msg-ai").last()).toContainText("слово", { timeout: 20_000 });
    expect(await page.evaluate(() => (window as any).__heroSeen), "экран «Новый чат» не мигал поверх истории").toBe(0);
    await page.unroute(`**/api/chats/${c.id}/log`);
    await page.unroute(`**/api/chats/${c.id}/stream`);
  });

  test("gap 7: набранный текст из удалённого в другой вкладке чата переносится в выбранный чат, а не теряется", async ({ page, request }) => {
    const a = await newChat(request, ids.task.id);
    await newChat(request, ids.task.id); // будет на что переключиться
    await openTask(page, { task: ids.task, chat: a });
    expect((await request.delete(`/api/chats/${a.id}`)).ok()).toBe(true); // «другая вкладка»
    const draft = "этот черновик нельзя потерять [[short]] [[nomem]]";
    const input = page.getByTestId("composer-input");
    await input.fill(draft);
    await input.press("Enter");
    await expect(page.getByTestId("toast").filter({ hasText: "чат удалён в другой вкладке" })).toBeVisible();
    await expect(chatItem(page, a.id)).toHaveCount(0);
    await expect(page.locator('[data-testid="chat-item"][aria-current="true"]')).toHaveCount(1);
    // текст перенесён в выбранный чат, а не потерян при переоткрытии экрана
    await expect(page.getByTestId("composer-input")).toHaveValue(draft);
  });

  test("TC-3: фоновый опрос занятого чата не сыплет уведомлениями, пока список чатов недоступен", async ({ page, request }) => {
    const c = await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[slow]] [[nomem]] долгий ход для опроса");
    long.add(c.id);
    await expect(page.getByTestId("msg-ai").last()).toContainText("слово2");
    // список чатов недоступен: фоновый опрос (раз в 3 с) не должен плодить уведомления об ошибке
    await page.route(`**/api/tasks/${ids.task.id}/chats`, (r) => (r.request().method() === "GET" ? r.abort("failed") : r.continue()));
    await page.waitForTimeout(9500); // ~3 цикла опроса
    expect(await errorToasts(page).count(), "фоновый опрос молчит при сбое").toBe(0);
    await page.unroute(`**/api/tasks/${ids.task.id}/chats`);
  });
});
