import { test, expect, createTask, mockReset, openTask, send, waitIdle, type Ids } from "./helpers";

// Визуальная регрессия: эталоны создаются при первом прогоне (updateSnapshots: "missing"),
// дальше любое заметное изменение отступов/цветов/вёрстки валит тест. Обновить: pnpm test:e2e:update
test.describe.serial("визуальные снимки", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Визуальная проверка", { course: "Сети" }); });

  test("чат с ответом и предложениями памяти", async ({ page, request }) => {
    await mockReset(request);
    await openTask(page, ids);
    await send(page, "Что такое ARP?");
    await waitIdle(page);
    await expect(page.getByTestId("proposals")).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot("chat-answer.png", {
      mask: [page.getByTestId("terminals"), page.getByTestId("statusbar"), page.getByTestId("health-llm")],
    });
  });

  test("панель памяти", async ({ page }) => {
    await openTask(page, ids, { tab: "mem" });
    await expect(page.getByTestId("memory-panel")).toBeVisible();
    await expect(page.getByTestId("right-panel")).toHaveScreenshot("memory-panel.png");
  });

  test("диалог задачи", async ({ page }) => {
    await openTask(page, ids);
    await page.getByTestId("edit-task").click();
    await expect(page.getByTestId("task-dialog")).toBeVisible();
    await expect(page.getByTestId("task-dialog")).toHaveScreenshot("task-dialog.png");
  });

  test("диалог подтверждения", async ({ page }) => {
    await openTask(page, ids);
    await page.getByTestId("container-reset").click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await expect(page.getByTestId("confirm-dialog")).toHaveScreenshot("confirm-dialog.png");
    await page.getByTestId("confirm-cancel").click();
  });
});
