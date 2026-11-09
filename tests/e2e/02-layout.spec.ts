import { test, expect, box, bottom, right, createTask, expectInside, expectNear, expectNoOverflowX, expectNoOverlap, openTask, type Ids } from "./helpers";

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];
const GAP = 10; // внутренние промежутки окон терминалов
const PAD = 16; // поля контента и промежутки между карточками (gap-4/p-4), как карточки HTB Labs
const SIDEBAR_W = 272;
const STATUS_H = 28;
const HEADER_H = 56;
const TOPBAR_H = 64; // верхняя полоса приложения как в HTB Labs

test.describe("раскладка и отступы", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, "Раскладка: очень длинное название задачи, чтобы проверить обрезание текста в шапке чата и в сайдбаре", { course: "Компьютерные сети" });
  });

  for (const vp of VIEWPORTS) {
    test.describe(`${vp.width}×${vp.height}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize(vp);
        await openTask(page, ids);
      });

      test("сайдбар flush-рейкой, карточки с полями 16px, статус-бар внизу", async ({ page }) => {
        const side = await box(page.getByTestId("sidebar"));
        const main = await box(page.getByTestId("main-panel"));
        const rp = await box(page.getByTestId("right-panel"));
        const status = await box(page.getByTestId("statusbar"));

        expectNear(side.x, 0, "сайдбар: flush к левому краю, как навигация HTB Labs");
        expectNear(side.width, SIDEBAR_W, "сайдбар: ширина");
        expectNear(main.x - right(side), PAD, "промежуток сайдбар → чат");
        expectNear(rp.x - right(main), PAD, "промежуток чат → правая панель");
        expectNear(right(rp), vp.width - PAD, "правая панель: отступ справа");
        expectNear(side.y, TOPBAR_H, "сайдбар: сразу под верхней полосой");
        expectNear(bottom(side), status.y, "сайдбар: flush до статус-бара");
        for (const [name, p] of [["чат", main], ["правая панель", rp]] as const) {
          expectNear(p.y, TOPBAR_H + PAD, `${name}: отступ под HTB-полосой`);
          expectNear(bottom(p), status.y - PAD, `${name}: отступ до статус-бара`);
        }
        expectNear(status.height, STATUS_H, "статус-бар: высота");
        expectNear(bottom(status), vp.height, "статус-бар прижат к низу");
        expectNear(status.width, vp.width, "статус-бар на всю ширину");
        expect(main.width, "чат не уже 480px на любом экране").toBeGreaterThanOrEqual(479);

        const scroll = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
        expect(scroll.w, "горизонтальной прокрутки страницы нет").toBeLessThanOrEqual(vp.width);
        expect(scroll.h, "вертикальной прокрутки страницы нет").toBeLessThanOrEqual(vp.height);
      });

      test("шапки чата и правой панели: высота 56px и общая нижняя линия", async ({ page }) => {
        const h1 = await box(page.getByTestId("chat-header"));
        const h2 = await box(page.getByTestId("right-header"));
        expectNear(h1.height, HEADER_H, "шапка чата");
        expectNear(h2.height, HEADER_H, "шапка правой панели");
        expectNear(bottom(h1), bottom(h2), "нижние границы шапок на одной линии");
        await expectNoOverflowX(page.getByTestId("chat-header"), "шапка чата");
        // длинное название обрезается многоточием, а шапка остаётся в одну строку
        const title = page.getByTestId("chat-task-title");
        expect(await title.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
        expectNear((await box(title)).height, 21.5, "заголовок в одну строку", 3);
        await expectNoOverlap(page.getByTestId("chat-title"), page.getByTestId("ctx-meter"), "название чата и шкала контекста");
      });

      test("поле ввода: многострочное, по центру, отступ снизу 20px, всё внутри", async ({ page }) => {
        const main = await box(page.getByTestId("main-panel"));
        const composer = page.getByTestId("composer");
        const c = await box(composer);
        expect(c.width, "ширина поля ввода ограничена").toBeLessThanOrEqual(900.5);
        const leftGap = c.x - main.x, rightGap = right(main) - right(c);
        expectNear(leftGap, rightGap, "поле ввода по центру чата", 1.5);
        expect(leftGap, "есть боковые отступы").toBeGreaterThanOrEqual(24);
        expectNear(bottom(main) - bottom(c), 20 + 1, "отступ поля ввода от низа панели", 1.5);
        const ta = await box(page.getByTestId("composer-input"));
        expect(ta.height, "минимум три строки текста").toBeGreaterThanOrEqual(70);
        expect(c.height, "поле ввода — карточка, а не одна строка").toBeGreaterThanOrEqual(118);
        for (const id of ["composer-input", "send", "attach", "effort", "composer-bar"]) await expectInside(page.getByTestId(id), composer, id);
        await expectNoOverflowX(page.getByTestId("composer-bar"), "панель кнопок поля ввода");
        await expectNoOverlap(page.getByTestId("effort"), page.getByTestId("send"), "переключатель размышлений и кнопка отправки");
        // кнопка отправки квадратная 38×38 (радиус контрола HTB — 4px) и прижата к правому краю с внутренним отступом 16px
        const s = await box(page.getByTestId("send"));
        expectNear(s.width, 38, "кнопка отправки: ширина"); expectNear(s.height, 38, "кнопка отправки: высота");
        expectNear(right(c) - right(s), 16 + 1, "кнопка отправки: отступ справа", 1.5);
      });

      test("пустой чат: приветствие и подсказки по центру ленты без перекрытий", async ({ page }) => {
        const msgs = await box(page.getByTestId("messages"));
        const hero = await box(page.getByTestId("hero"));
        expectNear(hero.x + hero.width / 2, msgs.x + msgs.width / 2, "приветствие по центру", 6); // полоса прокрутки
        const cards = page.getByTestId("suggestion");
        await expect(cards).toHaveCount(4);
        for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) await expectNoOverlap(cards.nth(i), cards.nth(j), `подсказки ${i} и ${j}`);
        for (let i = 0; i < 4; i++) await expectInside(cards.nth(i), page.getByTestId("hero"), `подсказка ${i}`);
      });

      test("терминалы: два окна с отступом 10px, шапки 36px, тело не пустое по высоте", async ({ page }) => {
        const tb = page.getByTestId("tabbody-term");
        const a = await box(page.getByTestId("term-agent"));
        const s = await box(page.getByTestId("term-shell"));
        const body = await box(tb);
        expectNear(a.x - body.x, GAP, "терминалы: отступ слева");
        expectNear(right(body) - right(a), GAP, "терминалы: отступ справа");
        expectNear(a.y - body.y, GAP, "терминалы: отступ сверху");
        expectNear(s.y - bottom(a), GAP, "промежуток между терминалами");
        expectNear(bottom(body) - bottom(s), GAP, "терминалы: отступ снизу");
        for (const t of ["term-agent", "term-shell"]) {
          const head = await box(page.getByTestId(t).locator("> div").first());
          expectNear(head.height, 36, `${t}: высота шапки`);
          const xt = await box(page.getByTestId(t).locator(".xterm-screen"));
          expect(xt.height, `${t}: область терминала`).toBeGreaterThan(100);
        }
      });

      test("сайдбар: выбранная задача подсвечена, список чатов с отступом, ничего не вылезает", async ({ page }) => {
        const side = page.getByTestId("sidebar");
        await expectNoOverflowX(page.getByTestId("task-list"), "список задач");
        const item = page.locator('[data-testid="task-item"][aria-current="true"]');
        await expectInside(item, side, "выбранная задача");
        const bg = await item.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bg, "фон выбранной задачи подсвечен").not.toBe("rgba(0, 0, 0, 0)");
        const chatList = await box(page.getByTestId("chat-list"));
        const ib = await box(item);
        expect(chatList.x - ib.x, "чаты сдвинуты вправо относительно задачи").toBeGreaterThanOrEqual(16);
        await expectInside(page.getByTestId("new-task"), side, "кнопка «новая задача»");
      });
    });
  }

  test("тема HTB Labs: Roboto, фон приложения #141d2b, лаймовый акцент #9fef00", async ({ page }) => {
    await openTask(page, ids);
    const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(font).toContain("Roboto");
    // точные значения из CSS-темы HTBTheme на app.hackthebox.com: .v-application background #141d2b
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(20, 29, 43)");
    const sendBg = await page.getByTestId("send").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(["rgb(159, 239, 0)", "rgb(44, 56, 74)"]).toContain(sendBg); // акцент или «неактивно» (surface-3 #2c384a)
    await page.getByTestId("composer-input").fill("x");
    await expect.poll(() => page.getByTestId("send").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(159, 239, 0)");
    // шрифты реально загружены, а не подменены запасными
    expect(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('13px "Roboto"') && document.fonts.check('13px "Roboto Mono"'); })).toBe(true);
  });

  test("разделитель: перетаскивание меняет ширину, чат не уже 480px, ширина запоминается", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openTask(page, ids);
    const drag = async (toX: number) => {
      const sp = await box(page.getByTestId("splitter"));
      await page.mouse.move(sp.x + sp.width / 2, sp.y + sp.height / 2);
      await page.mouse.down();
      await page.mouse.move(toX, sp.y + sp.height / 2, { steps: 8 });
      await page.mouse.up();
    };
    const before = await box(page.getByTestId("right-panel"));
    await drag((await box(page.getByTestId("splitter"))).x - 100);
    const grown = await box(page.getByTestId("right-panel"));
    expect(grown.width - before.width, "панель выросла вслед за мышью").toBeGreaterThan(80);

    await drag(100); // тянем до упора влево
    const main = await box(page.getByTestId("main-panel"));
    const rp = await box(page.getByTestId("right-panel"));
    expect(main.width, "чат не сжимается меньше 480px").toBeGreaterThanOrEqual(479);
    expectNear(rp.x - right(main), PAD, "промежуток сохраняется после перетаскивания");
    expectNear(right(rp), 1600 - PAD, "правая панель не вылезает за экран");

    await drag(1300); // и вправо
    const narrowed = await box(page.getByTestId("right-panel"));
    expect(narrowed.width).toBeLessThan(rp.width);
    await page.reload();
    expectNear((await box(page.getByTestId("right-panel"))).width, narrowed.width, "ширина запомнилась", 8);
  });

  test("уведомления: правый нижний угол над статус-баром, не перекрывают поле ввода", async ({ page }) => {
    await openTask(page, ids);
    await page.getByTestId("container-stop").click();
    const toast = page.getByTestId("toast").first();
    await expect(toast).toContainText("контейнер остановлен");
    const t = await box(toast);
    const vp = page.viewportSize()!;
    const status = await box(page.getByTestId("statusbar"));
    expectNear(right(t), vp.width - 16, "уведомление: отступ справа 16px");
    expect(bottom(t), "уведомление выше статус-бара").toBeLessThanOrEqual(status.y);
    await page.getByTestId("container-start").click();
    await expect(page.getByTestId("container-status")).toHaveAttribute("data-state", "running");
  });
});
