import type { Page } from "@playwright/test";
import {
  test, expect, box, bottom, right, createTask, expectInside, expectNear, expectNoOverflowX, expectNoOverlap,
  mockRequests, mockReset, openTask, waitIdle, type Ids,
} from "./helpers";

// Раскладка на «неудобных» экранах, клавиатура и доступность (ARIA, фокус, уведомления, длинные тексты).
// Тесты, помеченные test.fail(true, "BUG …"), фиксируют настоящие баги интерфейса: спека зелёная,
// а когда баг починят, такой тест «неожиданно пройдёт» и его надо будет превратить в обычный.

const GAP = 10; // внешний отступ и промежутки между панелями
const TITLE = "Лабораторная работа №3 — настройка VLAN 802.1Q и маршрутизации между VLAN на Linux-мосту в контейнере Kali";

// ширина правой панели по формуле раскладки (App.tsx): min(max(доля% ширины сетки, 500px), 100vw − 272 − 480 − 40)
const expectedRight = (vw: number, pct = 44) => Math.min(Math.max((pct / 100) * (vw - 2 * GAP), 500), vw - 272 - 480 - 40);

// где сейчас фокус: тег, data-testid ближайшего помеченного предка и внутри ли он открытого диалога
async function focusInfo(page: Page) {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    const tagged = a?.closest("[data-testid]") as HTMLElement | null;
    return { tag: a?.tagName ?? "", testid: tagged?.dataset.testid ?? "", inDialog: !!a?.closest('[role="dialog"]') };
  });
}
const focusedWithin = (page: Page, testid: string) =>
  page.evaluate((t) => !!document.activeElement?.closest(`[data-testid="${t}"]`), testid);

async function dragSplitter(page: Page, toX: number) {
  const sp = await box(page.getByTestId("splitter"));
  await page.mouse.move(sp.x + sp.width / 2, sp.y + sp.height / 2);
  await page.mouse.down();
  await page.mouse.move(toX, sp.y + sp.height / 2, { steps: 8 });
  await page.mouse.up();
}

const noPageScroll = async (page: Page, vp: { width: number; height: number }) => {
  const s = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
  expect(s.w, "горизонтальной прокрутки страницы нет").toBeLessThanOrEqual(vp.width);
  expect(s.h, "вертикальной прокрутки страницы нет").toBeLessThanOrEqual(vp.height);
};

test.describe("раскладка, клавиатура и доступность", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, TITLE, { course: "Компьютерные сети", brief: "Настроить VLAN 10 и 20 на мосту br0 и проверить связность." });
  });

  // ---------- экраны и разделитель ----------

  test("живое изменение окна 1366×768 → 1440×900 → 1280×1024 → 2560×1440: без прокрутки страницы, панели по формуле, поле ввода и терминалы подстраиваются", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await openTask(page, ids);
    for (const vp of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1280, height: 1024 }, { width: 2560, height: 1440 }]) {
      await page.setViewportSize(vp); // без перезагрузки — как пользователь тянет окно или переключает монитор
      const at = `${vp.width}×${vp.height}`;
      await expect.poll(async () => Math.abs(right(await box(page.getByTestId("right-panel"))) - (vp.width - GAP)), { message: `${at}: правая панель у правого края` }).toBeLessThan(1.5);
      await noPageScroll(page, vp);

      const side = await box(page.getByTestId("sidebar"));
      const main = await box(page.getByTestId("main-panel"));
      const rp = await box(page.getByTestId("right-panel"));
      expectNear(side.width, 272, `${at}: сайдбар 272px`);
      expect(main.width, `${at}: чат не уже 480px`).toBeGreaterThanOrEqual(479);
      expectNear(rp.width, expectedRight(vp.width), `${at}: ширина правой панели`, 2);
      expectNear(main.x - right(side), GAP, `${at}: промежуток сайдбар → чат`);
      expectNear(rp.x - right(main), GAP, `${at}: промежуток чат → правая панель`);

      // поле ввода и кнопки — внутри чата и над статус-баром, ширина поля ограничена и по центру
      const status = await box(page.getByTestId("statusbar"));
      for (const id of ["composer", "composer-input", "effort", "attach", "send"]) {
        await expectInside(page.getByTestId(id), page.getByTestId("main-panel"), `${at}: ${id}`);
        expect(bottom(await box(page.getByTestId(id))), `${at}: ${id} над статус-баром`).toBeLessThanOrEqual(status.y);
      }
      const c = await box(page.getByTestId("composer"));
      expect(c.width, `${at}: поле ввода не шире 900px`).toBeLessThanOrEqual(900.5);
      expectNear(c.x - main.x, right(main) - right(c), `${at}: поле ввода по центру`, 1.5);
      // кнопки контейнера видны целиком, «новая задача» и карандаш на месте
      for (const id of ["container-stop", "container-reset"]) await expectInside(page.getByTestId(id), page.getByTestId("right-panel"), `${at}: ${id}`);
      await expectInside(page.getByTestId("new-task"), page.getByTestId("sidebar"), `${at}: новая задача`);
      await expectInside(page.getByTestId("edit-task"), page.getByTestId("chat-header"), `${at}: карандаш`);

      // xterm перестраивается под новый размер (ResizeObserver + fit): экран терминала заполняет тело окна
      // и НЕ уезжает за его нижний/правый отступы (padding тела 8px снизу и 4px справа): последняя строка видна целиком.
      for (const t of ["term-agent", "term-shell"]) {
        await expect.poll(async () => {
          const b = await box(page.getByTestId(t).locator(".term-body"));
          const s = await box(page.getByTestId(t).locator(".xterm-screen"));
          const d = b.width - s.width;
          const bottomGap = bottom(b) - 8 - bottom(s);
          const rightGap = right(b) - 4 - right(s);
          return d >= 0 && d < 40 && s.height > 100 && bottomGap >= -1 && bottomGap < 28 && rightGap >= -1;
        }, { message: `${at}: ${t} подогнан под окно, последняя строка целиком внутри` }).toBe(true);
      }
    }
  });

  test("разделитель: панель на максимум при 2560 → окно сузилось до 1366 и перезагрузка — чат не уже 480px, ничего не вылезает", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await openTask(page, ids);
    await dragSplitter(page, 40); // до упора влево
    expectNear((await box(page.getByTestId("right-panel"))).width, expectedRight(2560, 70), "панель упёрлась в максимум", 2);
    expect((await box(page.getByTestId("main-panel"))).width, "чат при максимальной панели").toBeGreaterThanOrEqual(479);
    expect(await page.evaluate(() => localStorage.getItem("wh.rightW")), "ширина запомнена").toBe("70");

    // ноутбук: сохранённые 70% не помещаются — панель ужимается, чат держит минимум
    const small = { width: 1366, height: 768 };
    await page.setViewportSize(small);
    await expect.poll(async () => Math.abs(right(await box(page.getByTestId("right-panel"))) - (small.width - GAP))).toBeLessThan(1.5);
    for (const phase of ["после сужения окна", "после перезагрузки"]) {
      const main = await box(page.getByTestId("main-panel"));
      const rp = await box(page.getByTestId("right-panel"));
      expect(main.width, `${phase}: чат не уже 480px`).toBeGreaterThanOrEqual(479);
      expectNear(rp.width, expectedRight(small.width, 70), `${phase}: правая панель ужалась`, 2);
      expectNear(rp.x - right(main), GAP, `${phase}: промежуток чат → панель`);
      await noPageScroll(page, small);
      await expectInside(page.getByTestId("send"), page.getByTestId("composer"), `${phase}: кнопка отправки`);
      await expectInside(page.getByTestId("container-reset"), page.getByTestId("right-panel"), `${phase}: кнопка пересоздания`);
      if (phase === "после сужения окна") { await page.reload(); await expect(page.getByTestId("chat-panel")).toBeVisible(); }
    }
  });

  test("правая панель минимальной ширины (разделитель до упора вправо): вкладки и кнопки контейнера не обрезаются", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openTask(page, ids);
    await dragSplitter(page, 1595);
    expectNear((await box(page.getByTestId("right-panel"))).width, expectedRight(1600, 24), "панель упёрлась в минимум 24%", 2);
    const header = page.getByTestId("right-header");
    for (const id of ["tab-term", "tab-mem", "tab-lib", "tab-vpn", "container-stop", "container-reset"]) await expectInside(page.getByTestId(id), header, id);
    await expectNoOverflowX(header, "шапка правой панели");
  });

  // ---------- клавиатура ----------

  test("клавиатура: Tab доходит до «новая задача», уровней размышлений и отправки, Space/Enter работают, фокус возвращается в поле; у всех кнопок есть имена", async ({ page, request }) => {
    await mockReset(request);
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
    const input = page.getByTestId("composer-input");
    await expect(input, "при открытии чата фокус сразу в поле ввода").toBeFocused();

    // от начала сайдбара первым по Tab идёт «новая задача»; Enter открывает диалог с фокусом в названии
    const sb = await box(page.getByTestId("sidebar"));
    await page.mouse.click(sb.x + sb.width - 24, sb.y + 18); // пустое место шапки сайдбара — точка старта Tab
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("new-task")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("task-title")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);

    // поле ввода → уровни размышлений: Space выбирает «low»
    await input.focus();
    await input.fill("Покажи ARP-таблицу контейнера");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("effort-xhigh")).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("effort-low")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("effort-low")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("effort-xhigh")).toHaveAttribute("aria-pressed", "false");
    // …и дальше до кнопки отправки (off, [вложение], отправить), Enter отправляет
    const sendBtn = page.getByTestId("send");
    for (let i = 0; i < 3 && !(await sendBtn.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(sendBtn).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("msg-user")).toHaveCount(1);
    await waitIdle(page);
    await expect(page.getByTestId("proposals")).toBeVisible();
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    expect(req.body.chat_template_kwargs, "уровень, выбранный с клавиатуры, ушёл в модель").toEqual({ reasoning_effort: "low" });
    await expect(input, "после ответа фокус снова в поле ввода — можно печатать дальше").toBeFocused();

    // в богатом состоянии (ответ с кодом, статистика, предложения памяти, терминалы) нет «немых» кнопок
    const snap = await page.locator("body").ariaSnapshot();
    const unnamed = snap.split("\n").filter((l) => /^\s*- button(?! ")/.test(l));
    expect(unnamed, "кнопки без доступного имени (иконки без title/aria-label)").toEqual([]);
    expect(snap).toContain('button "отправить (Enter)"');
    expect(snap).toContain('button "условие задачи, название, удаление"');
    expect(snap).toContain('button "пересоздать контейнер (файлы /work сохранятся)"');
  });

  test("клавиатура: приложить картинку к сообщению и загрузить файл в библиотеку можно без мыши", async ({ page }) => {
    await openTask(page, ids);
    await page.getByTestId("effort-off").focus();
    await page.keyboard.press("Tab");
    expect(await focusedWithin(page, "attach"), `после уровней размышлений Tab ведёт на «приложить картинку», а не на ${JSON.stringify(await focusInfo(page))}`).toBe(true);
    let chooser = page.waitForEvent("filechooser", { timeout: 3000 });
    await page.keyboard.press("Enter");
    await chooser;

    await page.getByTestId("tab-lib").click();
    await page.getByTestId("lib-scope-task").focus();
    await page.keyboard.press("Tab");
    expect(await focusedWithin(page, "lib-drop"), "после выбора «в эту задачу» Tab ведёт на зону загрузки").toBe(true);
    chooser = page.waitForEvent("filechooser", { timeout: 3000 });
    await page.keyboard.press("Enter");
    await chooser;
  });

  test("клавиатура: переключить чат задачи и дойти до его удаления без мыши", async ({ page, request }) => {
    const a = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    const b = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: b });
    await page.locator('[data-testid="task-item"][aria-current="true"]').focus();
    await page.keyboard.press("Tab");
    expect(await focusedWithin(page, "chat-item"), `Tab с выбранной задачи ведёт в список её чатов, а не на ${JSON.stringify(await focusInfo(page))}`).toBe(true);
    for (let i = 0; i < 12; i++) {
      const id = await page.evaluate(() => (document.activeElement?.closest('[data-testid="chat-item"]') as HTMLElement | null)?.dataset.chatId);
      if (id === a.id) break;
      await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Enter");
    await expect(page.locator(`[data-testid="chat-item"][data-chat-id="${a.id}"]`)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Tab");
    await expect(page.locator(`[data-testid="chat-item"][data-chat-id="${a.id}"]`).getByTestId("chat-delete")).toBeFocused();
    await expect(page.locator(`[data-testid="chat-item"][data-chat-id="${a.id}"]`).getByTestId("chat-delete")).toBeVisible();
  });

  // ---------- модальные окна ----------

  test("модальные окна: role=dialog + aria-modal, Esc / клик по фону / «отмена» с клавиатуры в подтверждении ничего не делают, крестик «закрыть» закрывает", async ({ page }) => {
    await openTask(page, ids);
    const resets: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/container/reset")) resets.push(r.method()); });
    const confirmDlg = page.getByTestId("confirm-dialog");

    await page.getByTestId("container-reset").click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    await expect(page.getByTestId("confirm-ok")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmDlg).toHaveCount(0);

    await page.getByTestId("container-reset").click();
    await expect(confirmDlg).toBeVisible();
    await page.mouse.click(5, 5); // фон
    await expect(confirmDlg).toHaveCount(0);

    await page.getByTestId("container-reset").click();
    await expect(page.getByTestId("confirm-ok")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("confirm-cancel")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(confirmDlg).toHaveCount(0);

    await page.getByTestId("edit-task").click();
    await expect(page.getByTestId("task-dialog")).toHaveAttribute("aria-modal", "true");
    await page.getByRole("dialog").getByRole("button", { name: "закрыть" }).click();
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
    await expect(page.getByTestId("chat-task-title")).toHaveText(TITLE);

    await expect(page.getByTestId("container-status")).toHaveAttribute("data-state", "running");
    expect(resets, "ни одна из отмен не пересоздала контейнер").toEqual([]);
  });

  test("Esc в подтверждении поверх диалога задачи закрывает только подтверждение — несохранённая правка не теряется", async ({ page }) => {
    await openTask(page, ids);
    await page.getByTestId("edit-task").click();
    const edited = `${TITLE} (вариант 2)`;
    await page.getByTestId("task-title").fill(edited);
    await page.getByTestId("task-delete").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText("Удалить задачу?");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
    await expect(page.getByTestId("task-dialog"), "диалог задачи остаётся открытым").toBeVisible({ timeout: 2000 });
    await expect(page.getByTestId("task-title"), "правка названия на месте").toHaveValue(edited);
  });

  test("Tab и Shift+Tab не выводят фокус из открытого модального окна", async ({ page }) => {
    await openTask(page, ids);
    await page.getByTestId("new-task").click();
    await expect(page.getByTestId("task-title")).toBeFocused();
    await page.getByTestId("task-title").fill("ловушка фокуса");
    for (let i = 1; i <= 8; i++) {
      await page.keyboard.press("Tab");
      const f = await focusInfo(page);
      expect(f.inDialog, `Tab №${i}: фокус ушёл из диалога на ${f.tag}#${f.testid}`).toBe(true);
    }
    await page.getByTestId("task-title").focus();
    for (let i = 1; i <= 4; i++) {
      await page.keyboard.press("Shift+Tab");
      const f = await focusInfo(page);
      expect(f.inDialog, `Shift+Tab №${i}: фокус ушёл из диалога на ${f.tag}#${f.testid}`).toBe(true);
    }
  });

  test("после закрытия модального окна фокус возвращается на кнопку, которая его открыла", async ({ page }) => {
    await openTask(page, ids);
    const edit = page.getByTestId("edit-task");
    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("task-title")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
    await expect(edit, "фокус вернулся на карандаш").toBeFocused({ timeout: 2000 });

    const reset = page.getByTestId("container-reset");
    await reset.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("confirm-ok")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(reset, "фокус вернулся на «пересоздать контейнер»").toBeFocused({ timeout: 2000 });
  });

  test("диалоги озвучиваются по заголовку: у role=dialog есть доступное имя", async ({ page }) => {
    await openTask(page, ids);
    await page.getByTestId("new-task").click();
    await expect(page.getByTestId("task-dialog")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Новая задача" })).toBeVisible({ timeout: 2000 });
    await page.keyboard.press("Escape");
    await page.getByTestId("container-reset").click();
    await expect(page.getByRole("dialog", { name: "Пересоздать контейнер?" })).toBeVisible({ timeout: 2000 });
  });

  test("модальное окно не уходит за экран: на ноутбуке 1366×650 растянули поле условия — крестик и «сохранить» видны", async ({ page }) => {
    const vp = { width: 1366, height: 650 };
    await page.setViewportSize(vp);
    await openTask(page, ids);
    await page.getByTestId("edit-task").click();
    const brief = page.getByTestId("task-brief");
    const h0 = (await box(brief)).height;
    // длинное условие: пользователь дважды тянет уголок поля к низу экрана
    for (let i = 0; i < 2; i++) {
      const b = await box(brief);
      await page.mouse.move(right(b) - 3, bottom(b) - 3);
      await page.mouse.down();
      await page.mouse.move(right(b) - 3, vp.height - 6, { steps: 10 });
      await page.mouse.up();
    }
    expect((await box(brief)).height, "поле условия растянуто").toBeGreaterThan(h0 + 150);
    const close = await box(page.getByTestId("task-dialog-close"));
    const save = await box(page.getByTestId("task-save"));
    // и шапка, и футер должны остаться на экране (сам диалог может прокручиваться внутри)
    expect({ крестикНаЭкране: close.y >= 0, сохранитьНаЭкране: bottom(save) <= vp.height },
      `крестик y=${close.y.toFixed(0)}, низ «сохранить»=${bottom(save).toFixed(0)} при высоте окна ${vp.height}`)
      .toEqual({ крестикНаЭкране: true, сохранитьНаЭкране: true });
  });

  // ---------- уведомления и длинные тексты ----------

  test("уведомления: в стопке не больше четырёх, новые снизу, без наложений, длинный текст переносится, закрываются с клавиатуры и сами", async ({ page }) => {
    const vp = { width: 1366, height: 768 };
    await page.setViewportSize(vp);
    await openTask(page, ids, { tab: "lib" });
    const LONG = `снимок_экрана_${"лабораторная_работа_vlan_".repeat(6)}финал.exe`;
    const files = [1, 2, 3, 4, 5].map((i) => ({ name: `вирус-${i}.exe`, mimeType: "application/octet-stream", buffer: Buffer.from("MZ") }));
    files.push({ name: LONG, mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await page.getByTestId("lib-input").setInputFiles(files);

    const toasts = page.getByTestId("toast");
    await expect(toasts).toHaveCount(4);
    // показаны четыре последних, новые снизу; это объявляемые области role=status
    for (const [i, t] of ["вирус-3.exe", "вирус-4.exe", "вирус-5.exe", LONG].entries()) await expect(toasts.nth(i)).toContainText(t);
    await expect(page.getByRole("status")).toHaveCount(4);
    for (let i = 0; i < 4; i++) await expect(toasts.nth(i)).toHaveAttribute("data-kind", "error");

    const status = await box(page.getByTestId("statusbar"));
    let prev: Awaited<ReturnType<typeof box>> | null = null;
    for (let i = 0; i < 4; i++) {
      const b = await box(toasts.nth(i));
      expectNear(right(b), vp.width - 16, `уведомление ${i}: отступ справа 16px`);
      expect(b.width, `уведомление ${i}: не шире 380px`).toBeLessThanOrEqual(380.5);
      expect(b.y, `уведомление ${i}: не уходит за верх экрана`).toBeGreaterThanOrEqual(0);
      if (prev) expectNear(b.y - bottom(prev), 8, `промежуток между уведомлениями ${i - 1} и ${i}`, 1);
      prev = b;
    }
    expect(bottom(prev!), "стопка выше статус-бара").toBeLessThanOrEqual(status.y);
    // длинное имя без пробелов переносится внутри карточки, а не растягивает её
    await expectNoOverflowX(toasts.nth(3), "уведомление с длинным именем");
    expect((await box(toasts.nth(3))).height, "длинный текст — в несколько строк").toBeGreaterThan(60);

    // закрыть верхнее с клавиатуры: Enter на кнопке «закрыть»
    await toasts.nth(0).getByRole("button", { name: "закрыть" }).focus();
    await page.keyboard.press("Enter");
    await expect(toasts).toHaveCount(3);
    await expect(toasts.filter({ hasText: "вирус-3.exe" })).toHaveCount(0);
    // остальные исчезают сами (ошибки живут ~6.5 с)
    await expect(toasts).toHaveCount(0, { timeout: 12_000 });
  });

  test("длинные тексты: название чата, карточка памяти (ключ без пробелов, URL) и имя файла в библиотеке не раздувают панели", async ({ page, request }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const KEY = `ssh-ed25519 AAAA${"C3NzaC1lZDI1NTE5".repeat(25)} student@kali`;
    const URL = `https://example.org/${"очень/длинный/путь/".repeat(12)}?q=1`;
    const MT = "Ключ доступа к стенду лабораторной №3: вход на маршрутизатор R1 через jump-host университета";
    expect((await request.post(`/api/tasks/${ids.task.id}/memories`, { data: { kind: "result", title: MT, content: `${KEY}\n${URL}` } })).ok()).toBe(true);
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    const CHAT = "Почему ARP-запрос из VLAN 10 не доходит до шлюза 10.0.10.1 на мосту br0 после включения vlan_filtering";
    expect((await request.patch(`/api/chats/${c.id}`, { data: { title: CHAT } })).ok()).toBe(true);
    await openTask(page, { task: ids.task, chat: c }, { tab: "mem" });

    // шапка чата: длинное название чата обрезано, шкала контекста и карандаш на месте
    const header = page.getByTestId("chat-header");
    const ct = page.getByTestId("chat-title");
    await expect(ct).toHaveText(CHAT);
    await expectNoOverflowX(header, "шапка чата");
    expect(await ct.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
    expect(await ct.evaluate((el) => el.scrollWidth > el.clientWidth), "название чата обрезано").toBe(true);
    await expectNoOverlap(ct, page.getByTestId("ctx-meter"), "название чата и шкала контекста");
    await expectInside(page.getByTestId("edit-task"), header, "карандаш");
    await expectInside(page.getByTestId("ctx-meter"), header, "шкала контекста");
    // сайдбар: чат в одну строку, список без горизонтальной прокрутки
    const ci = page.locator(`[data-testid="chat-item"][data-chat-id="${c.id}"]`);
    expect((await box(ci)).height, "чат в сайдбаре — одна строка").toBeLessThan(40);
    await expectInside(ci, page.getByTestId("sidebar"), "чат в сайдбаре");
    await expectNoOverflowX(page.getByTestId("task-list"), "список задач");

    // карточка памяти: заголовок в одну строку с многоточием, длинный ключ и URL переносятся
    const panel = page.getByTestId("memory-panel");
    const card = panel.getByTestId("memory-card").filter({ hasText: "ssh-ed25519" });
    await expectInside(card, panel, "карточка памяти");
    await expectNoOverflowX(page.getByTestId("tabbody-mem"), "вкладка памяти");
    await expectNoOverflowX(card, "карточка памяти");
    const title = card.locator("span.truncate");
    await expect(title).toHaveText(MT);
    expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth), "заголовок карточки обрезан").toBe(true);
    expect((await box(title)).height, "заголовок карточки — одна строка").toBeLessThan(26);
    expect((await box(card.locator("div.whitespace-pre-wrap"))).height, "ключ и URL перенесены на несколько строк").toBeGreaterThan(80);
    // режим правки тоже не вылезает
    await card.getByTestId("mem-edit").click();
    for (const id of ["mem-kind", "mem-title", "mem-content", "mem-confirm"]) await expectInside(card.getByTestId(id), card, `правка: ${id}`);
    await expectNoOverflowX(page.getByTestId("tabbody-mem"), "вкладка памяти в режиме правки");
    await card.getByTestId("mem-edit").click(); // «отмена»

    // библиотека: длинное имя файла обрезано, полное — в подсказке, статус индексации виден
    await page.getByTestId("tab-lib").click();
    const NAME = "Лекция 7 — канальный уровень, коммутация, VLAN 802.1Q, STP и агрегирование каналов LACP (дополненная версия для заочников, 2026).md";
    await page.getByTestId("lib-scope-task").click();
    await page.getByTestId("lib-input").setInputFiles({ name: NAME, mimeType: "text/markdown", buffer: Buffer.from("# VLAN\n\nТег 802.1Q — 4 байта, VID 12 бит.\n") });
    const doc = page.getByTestId("library-panel").getByTestId("doc-item").filter({ hasText: "Лекция 7" });
    await expect(doc).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    const name = doc.locator(`span[title]`).first();
    await expect(name).toHaveAttribute("title", NAME);
    expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth), "имя файла обрезано").toBe(true);
    await expectInside(doc.getByText(/фрагм\./), doc, "статус индексации");
    await expectInside(doc, page.getByTestId("library-panel"), "строка документа");
    await expectNoOverflowX(page.getByTestId("tabbody-lib"), "вкладка библиотеки");
  });

  test("обрезанные многоточием названия (задача, чат, карточка памяти) доступны во всплывающей подсказке", async ({ page, request }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const MT = "Маршрут по умолчанию после пересоздания контейнера: ip route add default via 10.0.10.1 dev br0.10";
    expect((await request.post(`/api/tasks/${ids.task.id}/memories`, { data: { kind: "command", title: MT, content: "ip route add default via 10.0.10.1" } })).ok()).toBe(true);
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    const CHAT = "Разбор вывода tcpdump -e на br0: почему кадры VLAN 20 уходят без тега 802.1Q в сторону шлюза";
    expect((await request.patch(`/api/chats/${c.id}`, { data: { title: CHAT } })).ok()).toBe(true);
    await openTask(page, { task: ids.task, chat: c }, { tab: "mem" });
    const card = page.getByTestId("memory-panel").getByTestId("memory-card").filter({ hasText: "10.0.10.1 dev br0.10" });
    const checks = [
      { what: "задача в сайдбаре", el: page.locator('[data-testid="task-item"][aria-current="true"] div.truncate').first(), full: TITLE },
      { what: "чат в сайдбаре", el: page.locator(`[data-testid="chat-item"][data-chat-id="${c.id}"] span.truncate`), full: CHAT },
      { what: "название чата в шапке", el: page.getByTestId("chat-title"), full: CHAT },
      { what: "заголовок карточки памяти", el: card.locator("span.truncate"), full: MT },
    ];
    // сначала убедиться, что текст действительно обрезан (иначе подсказка не нужна)
    for (const { what, el, full } of checks) {
      await expect(el, what).toHaveText(full);
      expect(await el.evaluate((e) => e.scrollWidth > e.clientWidth), `${what}: текст обрезан`).toBe(true);
    }
    for (const { what, el, full } of checks) {
      const tip = await el.evaluate((e) => (e.closest("[title]") as HTMLElement | null)?.title ?? "");
      expect(tip, `${what}: полный текст во всплывающей подсказке`).toBe(full);
    }
  });
});
