import { test, expect, box, createTask, openTask, type Ids } from "./helpers";

// Дизайн-контракт сверен с реальным CSS app.hackthebox.com (тема HTBTheme в бандле index-*.css):
// фон приложения #141d2b, карточка .htb-card #151f2e, радиус карточек 8px, контролов — 4px,
// верхняя полоса 64px, левая навигация — flush-рейка, логотип-куб без подложки/фона.
test.describe("HTB LLM shell", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "HTB shell: проверка"); });

  test("верхняя полоса и карточки HTB Labs, логотип без фона", async ({ page }) => {
    await openTask(page, ids);
    await expect(page).toHaveTitle(/HTB LLM/);
    const header = page.getByTestId("app-header");
    await expect(header).toBeVisible();
    expect((await box(header)).height).toBeCloseTo(64, 0);
    await expect(page.getByTestId("brand-logo")).toBeVisible();
    await expect(header).toContainText("HTB LLM");
    await expect(header).toContainText("UNOFFICIAL");
    await expect(page.getByText("whitehat-agent", { exact: true })).toHaveCount(0);

    // логотип — только контур куба: ни подложки-rect, ни фона у svg и его родителя
    const logo = page.getByTestId("brand-logo");
    await expect(logo.locator("rect")).toHaveCount(0);
    expect(await logo.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

    // фон приложения и карточек — точные значения HTBTheme
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(20, 29, 43)"); // #141d2b
    for (const id of ["main-panel", "right-panel"]) {
      const el = page.getByTestId(id);
      expect(await el.evaluate((e) => getComputedStyle(e).backgroundColor), `${id}: фон .htb-card`).toBe("rgb(21, 31, 46)"); // #151f2e
      const radius = await el.evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius));
      expect(radius, `${id}: радиус карточки HTB — 8px`).toBe(8);
      expect((await box(el)).y).toBeGreaterThanOrEqual(64);
    }
    // сайдбар — flush-рейка: без радиуса и у левого края окна
    const side = page.getByTestId("sidebar");
    expect(await side.evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius))).toBe(0);
    expect((await box(side)).x).toBe(0);
  });
});
