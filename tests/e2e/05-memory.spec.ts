import { test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle, type Ids } from "./helpers";

test.describe.serial("память задачи", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Память"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("агент предлагает карточки: сохранить, поправить перед сохранением, отклонить", async ({ page }) => {
    await openTask(page, ids);
    await send(page, "Что такое ARP?");
    await waitIdle(page);
    const props = page.getByTestId("proposals");
    await expect(props).toBeVisible();
    const cards = props.getByTestId("memory-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toHaveAttribute("data-status", "pending");
    await expect(cards.first()).toContainText("Просмотр ARP-таблицы");
    await expect(page.getByTestId("tab-mem")).toContainText("2"); // бейдж «ждут»

    // 1) поправить и сохранить
    await cards.first().getByTestId("mem-edit").click();
    await cards.first().getByTestId("mem-title").fill("ARP-таблица: ip neigh");
    await cards.first().getByTestId("mem-confirm").click();
    await expect(page.getByTestId("toast").filter({ hasText: "сохранено в память" })).toBeVisible();
    await expect(cards).toHaveCount(1);
    // 2) отклонить вторую
    await cards.first().getByTestId("mem-reject").click();
    await expect(props).toHaveCount(0);

    // вкладка памяти: одна подтверждённая с правленым заголовком
    await page.getByTestId("tab-mem").click();
    const panel = page.getByTestId("memory-panel");
    await expect(panel.getByTestId("mem-confirmed-title")).toContainText("подтверждено · 1");
    await expect(panel.getByTestId("memory-card")).toHaveCount(1);
    await expect(panel.getByTestId("memory-card")).toContainText("ARP-таблица: ip neigh");
    await expect(page.locator('[data-testid="task-item"][aria-current="true"]')).toContainText("1");
  });

  test("новый чат стартует с памятью задачи в системном промпте", async ({ page, request }) => {
    await openTask(page, ids);
    await page.getByTestId("new-chat").click();
    await expect(page.getByTestId("hero")).toBeVisible();
    await send(page, "[[short]] продолжим");
    await waitIdle(page);
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const sys = textOf(req.body.messages[0].content);
    expect(sys).toContain("ПАМЯТЬ ЗАДАЧИ");
    expect(sys).toContain("ARP-таблица: ip neigh");
    expect(sys).not.toContain("Хостов в /24"); // отклонённое не попадает
    // в истории нового чата нет сообщений старого чата — контекст минимальный
    expect(req.body.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
  });

  test("ручное добавление и удаление карточки через подтверждение", async ({ page }) => {
    await openTask(page, ids, { tab: "mem" });
    const panel = page.getByTestId("memory-panel");
    await panel.getByTestId("mem-add").click();
    await expect(panel.getByTestId("mem-add-save")).toBeDisabled();
    await panel.getByTestId("mem-add-title").fill("Шлюз лабы");
    await panel.getByTestId("mem-add-content").fill("default via 10.0.0.1 dev eth0");
    await panel.getByTestId("mem-add-save").click();
    await expect(page.getByTestId("toast").filter({ hasText: "карточка добавлена" })).toBeVisible();
    const card = panel.getByTestId("memory-card").filter({ hasText: "Шлюз лабы" });
    await expect(card).toHaveAttribute("data-status", "confirmed");

    await card.getByTestId("mem-delete").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText("Шлюз лабы");
    await page.getByTestId("confirm-cancel").click();
    await expect(card).toHaveCount(1);
    await card.getByTestId("mem-delete").click();
    await page.getByTestId("confirm-ok").click();
    await expect(card).toHaveCount(0);
  });

  test("search_memory находит карточку задачи", async ({ page }) => {
    await openTask(page, ids);
    await send(page, "[[tool:memory:arp таблица]] [[nomem]]");
    await waitIdle(page);
    const tool = page.getByTestId("tool-block").first();
    await tool.locator("summary").click();
    await expect(tool.getByTestId("tool-output")).toContainText("ARP-таблица: ip neigh");
  });

  test("короткий ответ без инструментов — память не предлагается (нет шума)", async ({ page, request }) => {
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[short]] ок");
    await waitIdle(page);
    await expect(page.getByTestId("proposals")).toHaveCount(0);
    expect((await mockRequests(request)).filter((r) => r.kind === "propose")).toHaveLength(0);
  });
});
