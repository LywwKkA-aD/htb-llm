import { test, expect, box, right, createTask, expectNear, mockRequests, mockReset, openTask, send, textOf, waitIdle, PNG_1PX, type Ids } from "./helpers";

test.describe("чат", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Чат: проверки", { brief: "Разобраться с ARP." }); });
  test.beforeEach(async ({ page, request }) => {
    await mockReset(request);
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
  });

  test("ответ: поток, размышления, markdown, формулы, таблица, статистика", async ({ page }) => {
    await send(page, "Что такое ARP? [[nomem]]");
    // сообщение пользователя сразу появляется пузырём справа
    const user = page.getByTestId("msg-user").last();
    await expect(user).toContainText("Что такое ARP?");
    await expect(page.getByTestId("stop")).toBeVisible();
    await waitIdle(page);

    const ai = page.getByTestId("msg-ai").last();
    await expect(ai).toHaveAttribute("data-live", "0");
    await expect(ai.locator(".md h2")).toHaveText("Разбор");
    await expect(ai.locator(".md li")).toHaveCount(3);
    await expect(ai.locator(".md pre code")).toContainText("ip neigh show");
    await expect(ai.locator(".katex").first()).toBeVisible();
    await expect(ai.locator(".md table tr")).toHaveCount(3);
    // размышления свернуты после ответа и раскрываются по клику
    const r = ai.getByTestId("reasoning");
    await expect(r).not.toHaveAttribute("open", "");
    await r.locator("summary").click();
    await expect(r).toContainText("таблица соседей");
    // статистика скорости
    await expect(ai.getByTestId("stats")).toContainText("55.5 t/s");
    await expect(ai.getByTestId("stats")).toContainText("MTP 85%");
    await expect(page.getByTestId("statusbar")).toContainText("55.5 t/s");
    // шкала контекста обновилась
    expect(Number(await page.getByTestId("ctx-meter").getAttribute("data-tokens"))).toBeGreaterThan(1000);

    // геометрия: пузырь пользователя прижат вправо, ответ агента слева с аватаром
    const thread = await box(page.getByTestId("messages").locator("> div"));
    const ub = await box(user.locator("> div"));
    expectNear(right(ub), right(thread), "пузырь пользователя у правого края ленты");
    const ab = await box(ai);
    expectNear(ab.x, thread.x, "ответ агента от левого края ленты");
    expect(ub.width / thread.width, "пузырь не шире 82% ленты").toBeLessThanOrEqual(0.83);
  });

  test("Enter отправляет, Shift+Enter переносит строку, поле растёт и ограничено по высоте", async ({ page }) => {
    const input = page.getByTestId("composer-input");
    await input.click();
    await page.keyboard.type("первая строка");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("вторая строка");
    await expect(input).toHaveValue("первая строка\nвторая строка");
    await expect(page.getByTestId("msg-user")).toHaveCount(0);

    const h0 = (await box(input)).height;
    await input.fill(Array.from({ length: 30 }, (_, i) => `строка ${i}`).join("\n"));
    const h1 = (await box(input)).height;
    expect(h1, "поле выросло").toBeGreaterThan(h0 + 100);
    expect(h1, "но не больше 40% экрана").toBeLessThanOrEqual(page.viewportSize()!.height * 0.4 + 1);

    await input.fill("[[short]] короткий вопрос");
    await input.press("Enter");
    await expect(page.getByTestId("msg-user")).toHaveCount(1);
    await expect(input).toHaveValue("");
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
  });

  test("режим размышлений уходит в модель и запоминается", async ({ page, request }) => {
    await page.getByTestId("effort-low").click();
    await expect(page.getByTestId("effort-low")).toHaveAttribute("aria-pressed", "true");
    await send(page, "[[short]] low");
    await waitIdle(page);
    let reqs = (await mockRequests(request)).filter((r) => r.kind === "agent");
    expect(reqs.at(-1)!.body.chat_template_kwargs).toEqual({ reasoning_effort: "low" });

    await page.getByTestId("effort-off").click();
    await send(page, "[[short]] off");
    await waitIdle(page);
    reqs = (await mockRequests(request)).filter((r) => r.kind === "agent");
    expect(reqs.at(-1)!.body.chat_template_kwargs).toEqual({ enable_thinking: false });

    await page.reload();
    await expect(page.getByTestId("effort-off")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("effort-xhigh").click();
  });

  test("подсказка в пустом чате подставляет текст в поле ввода", async ({ page }) => {
    await expect(page.getByTestId("hero")).toBeVisible();
    await page.getByTestId("suggestion").first().click();
    await expect(page.getByTestId("composer-input")).toHaveValue(/VLSM/);
    await expect(page.getByTestId("composer-input")).toBeFocused();
  });

  test("копирование ответа и блока кода в буфер обмена", async ({ page }) => {
    // headless Chromium без фокуса окна может подвиснуть на clipboard.readText — перехватываем запись
    await page.evaluate(() => {
      (window as any).__copied = [];
      Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (t: string) => { (window as any).__copied.push(t); } });
    });
    const copied = () => page.evaluate(() => (window as any).__copied.at(-1) as string | undefined);
    await send(page, "Покажи команду [[nomem]]");
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    await ai.hover();
    await ai.getByTestId("copy-answer").click();
    await expect(ai.getByTestId("copy-answer")).toContainText("скопировано");
    await expect.poll(copied).toContain("ARP сопоставляет");
    await ai.locator(".md pre").hover();
    await ai.getByTestId("code-copy").click();
    await expect.poll(async () => (await copied())?.trim()).toBe("ip neigh show");
    await expect(ai.getByTestId("code-copy")).toContainText("скопировано");
  });

  test("стоп: генерация прерывается, частичный ответ сохраняется с пометкой", async ({ page }) => {
    await send(page, "[[slow]] долгий ответ");
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai).toContainText("слово5");
    await page.getByTestId("stop").click();
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("(остановлено)");
    await expect(page.getByTestId("send")).toBeVisible();
    await expect(page.getByTestId("proposals")).toHaveCount(0);
    // после остановки чат работает дальше
    await send(page, "[[short]] продолжаем");
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
  });

  test("ошибка модели показывается в ленте, интерфейс не ломается", async ({ page }) => {
    await send(page, "[[error]]");
    await expect(page.getByTestId("marker-error")).toContainText("модель недоступна");
    await waitIdle(page);
    await expect(page.getByTestId("send")).toBeVisible();
  });

  test("картинка: вложение, превью, удаление из превью, отправка в модель", async ({ page, request }) => {
    await page.getByTestId("attach-input").setInputFiles([{ name: "a.png", mimeType: "image/png", buffer: PNG_1PX }, { name: "b.png", mimeType: "image/png", buffer: PNG_1PX }]);
    await expect(page.getByTestId("thumb")).toHaveCount(2);
    await page.getByTestId("thumb").first().getByRole("button").click();
    await expect(page.getByTestId("thumb")).toHaveCount(1);
    await expect(page.getByTestId("send")).toBeEnabled();
    await page.getByTestId("composer-input").fill("[[short]] что на схеме?");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("msg-user").last().locator("img")).toHaveCount(1);
    await waitIdle(page);
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const user = req.body.messages.filter((m: any) => m.role === "user").at(-1);
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content.some((p: any) => p.type === "image_url" && String(p.image_url.url).startsWith("data:image/png"))).toBe(true);
  });

  test("длинная лента: кнопка «вниз» появляется при прокрутке вверх и возвращает в конец", async ({ page }) => {
    await send(page, "[[long]] [[nomem]]");
    await waitIdle(page);
    const msgs = page.getByTestId("messages");
    await expect(page.getByTestId("to-bottom")).toHaveCount(0);
    await msgs.evaluate((el) => { el.style.scrollBehavior = "auto"; el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
    await expect(page.getByTestId("to-bottom")).toBeVisible();
    await page.getByTestId("to-bottom").click();
    await expect.poll(() => msgs.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(80);
    await expect(page.getByTestId("to-bottom")).toHaveCount(0);
  });

  test("название чата берётся из первого сообщения; системный промпт содержит условие задачи", async ({ page, request }) => {
    await send(page, "[[short]] Как настроить статический маршрут?");
    await waitIdle(page);
    await expect(page.getByTestId("chat-title")).toContainText("Как настроить статический маршрут?");
    await expect(page.locator('[data-testid="chat-item"][aria-current="true"]')).toContainText("Как настроить статический");
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const sys = textOf(req.body.messages[0].content);
    expect(sys).toContain("ЗАДАЧА: Чат: проверки");
    expect(sys).toContain("Разобраться с ARP.");
    // дисциплина финала: журнал решений и валидация результата вместо запуска (из разбора CAI/Strix)
    expect(sys).toContain("Журнал решений:");
    expect(sys).toContain("шелл считается полученным, только когда в выводе сессии виден результат id/whoami");
    expect(req.body.tools.map((t: any) => t.function.name)).toEqual(["shell", "search_docs", "search_memory", "web_search", "web_fetch", "tcp_probe", "http_request", "nmap_scan", "ffuf_scan", "sqlmap_scan", "plan_update", "profile_update", "subnet_calc", "user_history", "job_start", "job_list", "job_output", "job_input", "job_stop", "read_rfc"]);
  });

  test("история чата сохраняется после перезагрузки страницы", async ({ page }) => {
    await send(page, "Первый вопрос [[nomem]]");
    await waitIdle(page);
    await page.reload();
    await expect(page.getByTestId("msg-user")).toContainText("Первый вопрос");
    await expect(page.getByTestId("msg-ai").locator(".md h2")).toHaveText("Разбор");
    await expect(page.getByTestId("msg-ai").getByTestId("stats")).toContainText("55.5 t/s");
  });
});
