import { test, expect, box, expectNear, right, waitContainer } from "./helpers";

// Файл идёт первым (алфавитный порядок): база пустая — проверяем стартовый экран.
test.describe.serial("задачи и чаты", () => {
  test("пустая база: приветственный экран по центру, без правой панели", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("welcome")).toBeVisible();
    await expect(page.getByTestId("right-panel")).toHaveCount(0);
    await expect(page.getByTestId("sidebar")).toContainText("пока пусто");
    // карточка приветствия по центру основной панели
    const main = await box(page.getByTestId("main-panel"));
    const cta = await box(page.getByTestId("welcome-create"));
    expectNear(cta.x + cta.width / 2, main.x + main.width / 2, "кнопка «создать» по центру", 2);
    // индикаторы стека: мок модели отвечает, docker есть
    await expect(page.getByTestId("health-llm")).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId("health-emb")).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId("health-docker")).toHaveAttribute("data-state", "ok");
  });

  test("создание задачи через диалог: Esc и клик по фону закрывают, валидация названия", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("welcome-create").click();
    const dlg = page.getByTestId("task-dialog");
    await expect(dlg).toBeVisible();
    await expect(page.getByTestId("task-title")).toBeFocused();
    await expect(page.getByTestId("task-save")).toBeDisabled(); // пустое название
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);

    await page.getByTestId("new-task").click();
    await expect(dlg).toBeVisible();
    await page.mouse.click(5, 5); // фон
    await expect(dlg).toHaveCount(0);

    await page.getByTestId("new-task").click();
    await page.getByTestId("task-title").fill("Лаба 1 — ARP");
    await page.getByTestId("task-course").fill("Сети");
    await page.getByTestId("task-brief").fill("Изучить работу ARP и показать таблицу соседей.");
    await page.getByTestId("task-save").click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByTestId("toast").filter({ hasText: "задача создана" })).toBeVisible();

    const item = page.getByTestId("task-item").filter({ hasText: "Лаба 1 — ARP" });
    await expect(item).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("chat-task-title")).toHaveText("Лаба 1 — ARP");
    await expect(page.getByTestId("hero")).toBeVisible();
    await expect(page.getByTestId("right-panel")).toBeVisible();
    // контейнер поднимается в фоне — статус обновится
    const taskId = await item.getAttribute("data-task-id");
    await waitContainer(page.request, taskId!);
    await page.reload();
    await expect(page.getByTestId("container-status")).toHaveAttribute("data-state", "running");
    await expect(page.getByTestId("status-container")).toContainText("работает");
  });

  test("правка задачи: название в шапке и в сайдбаре обновляется, Ctrl+Enter сохраняет", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("edit-task").click();
    await expect(page.getByTestId("task-title")).toHaveValue("Лаба 1 — ARP");
    await expect(page.getByTestId("task-brief")).toHaveValue(/таблицу соседей/);
    await page.getByTestId("task-title").fill("Лаба 1 — ARP и соседи");
    await page.getByTestId("task-brief").press("Control+Enter");
    await expect(page.getByTestId("task-dialog")).toHaveCount(0);
    await expect(page.getByTestId("chat-task-title")).toHaveText("Лаба 1 — ARP и соседи");
    await expect(page.getByTestId("task-item").first()).toContainText("Лаба 1 — ARP и соседи");
  });

  test("чаты: новый чат появляется и выбирается, удаление — через своё подтверждение", async ({ page }) => {
    await page.goto("/");
    const chats = page.getByTestId("chat-item");
    await expect(chats).toHaveCount(1);
    await page.getByTestId("new-chat").click();
    await expect(chats).toHaveCount(2);
    await expect(page.getByTestId("hero")).toBeVisible();
    const selected = page.locator('[data-testid="chat-item"][aria-current="true"]');
    await expect(selected).toHaveCount(1);

    // удалить: появляется НАШ диалог; «отмена» ничего не трогает
    await selected.hover();
    await selected.getByTestId("chat-delete").click();
    const confirm = page.getByTestId("confirm-dialog");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Память задачи останется");
    await page.getByTestId("confirm-cancel").click();
    await expect(confirm).toHaveCount(0);
    await expect(chats).toHaveCount(2);

    // Enter в диалоге = подтверждение (фокус на кнопке «удалить»)
    await selected.hover();
    await selected.getByTestId("chat-delete").click();
    await expect(page.getByTestId("confirm-ok")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(chats).toHaveCount(1);
    await expect(page.getByTestId("toast").filter({ hasText: "чат удалён" })).toBeVisible();
  });

  test("удаление задачи: подтверждение с перечнем последствий, контейнер удаляется", async ({ page, request }) => {
    // вторая задача, чтобы после удаления было куда переключиться
    await page.goto("/");
    await page.getByTestId("new-task").click();
    await page.getByTestId("task-title").fill("Временная задача");
    await page.getByTestId("task-title").press("Enter");
    const tmp = page.getByTestId("task-item").filter({ hasText: "Временная задача" });
    await expect(tmp).toHaveAttribute("aria-current", "true");
    const id = (await tmp.getAttribute("data-task-id"))!;
    await waitContainer(request, id);

    await page.getByTestId("edit-task").click();
    await page.getByTestId("task-delete").click();
    const confirm = page.getByTestId("confirm-dialog");
    await expect(confirm).toContainText("Kali-контейнер");
    await expect(confirm).toContainText("нельзя отменить");
    // кнопка подтверждения — «опасная» (красная)
    const okBg = await page.getByTestId("confirm-ok").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(okBg).toBe("rgb(243, 94, 94)"); // HTB danger #f35e5e
    await page.getByTestId("confirm-ok").click();

    await expect(page.getByTestId("task-item").filter({ hasText: "Временная задача" })).toHaveCount(0);
    await expect(page.getByTestId("toast").filter({ hasText: "задача удалена" })).toBeVisible();
    await expect.poll(async () => (await (await request.get(`/api/tasks/${id}/container`)).json()).status).toBe("missing");
    // осталась первая задача и она выбрана
    await expect(page.getByTestId("task-item")).toHaveCount(1);
    await expect(page.getByTestId("chat-task-title")).toHaveText("Лаба 1 — ARP и соседи");
  });

  test("чат не ворует фокус у открытого диалога (регрессия)", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("new-task").click(); // сразу после загрузки, пока чат ещё монтируется
    await page.waitForTimeout(400);
    await page.keyboard.type("фокус в диалоге");
    await expect(page.getByTestId("task-title")).toHaveValue("фокус в диалоге");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("composer-input")).toHaveValue("");
  });

  test("модальное окно: по центру экрана, кнопки футера прижаты вправо", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("new-task").click();
    const vp = page.viewportSize()!;
    const m = await box(page.getByTestId("task-dialog"));
    expectNear(m.x + m.width / 2, vp.width / 2, "диалог по горизонтали", 1.5);
    expectNear(m.y + m.height / 2, vp.height / 2, "диалог по вертикали", 1.5);
    const save = await box(page.getByTestId("task-save"));
    expectNear(right(save), right(m) - 20 - 1, "кнопка «создать» у правого края с отступом 20px", 2);
    const cancel = await box(page.getByTestId("task-cancel"));
    expect(right(cancel)).toBeLessThan(save.x);
    expectNear(save.x - right(cancel), 8, "промежуток между кнопками 8px", 1);
  });
});
