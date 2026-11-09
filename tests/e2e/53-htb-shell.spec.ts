import { test, expect, box, createTask, openTask, type Ids } from "./helpers";

test.describe("HTB LLM shell", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "HTB shell: проверка"); });

  test("верхняя полоса HTB Labs-стиля, собственный логотип и прямые панели", async ({ page }) => {
    await openTask(page, ids);
    await expect(page).toHaveTitle(/HTB LLM/);
    const header = page.getByTestId("app-header");
    await expect(header).toBeVisible();
    expect((await box(header)).height).toBeCloseTo(56, 0);
    await expect(page.getByTestId("brand-logo")).toBeVisible();
    await expect(header).toContainText("HTB LLM");
    await expect(header).toContainText("UNOFFICIAL");
    await expect(page.getByText("whitehat-agent", { exact: true })).toHaveCount(0);

    for (const id of ["sidebar", "main-panel", "right-panel"]) {
      const radius = await page.getByTestId(id).evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
      expect(radius, `${id}: радиус не больше 4px`).toBeLessThanOrEqual(4);
      expect((await box(page.getByTestId(id))).y).toBeGreaterThanOrEqual(56);
    }
  });
});
