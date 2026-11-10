import { test, expect, createTask, mockRequests, mockReset, openTask, send, waitIdle, type Ids } from "./helpers";

// Восстановление доступа: в профиле есть access, живых job нет (респаун) → контекст хода прямо
// говорит модели восстанавливать по рецепту, а не начинать с нуля. С живой сессией подсказки нет.
test.describe("восстановление доступа после респауна", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, "Восстановление доступа");
    const r = await request.post(`/api/tasks/${ids.task.id}/profile`, {
      data: { kind: "access", text: "Reverse shell как www-data через upload в /uploads (shell.php), листенер penelope 4444" },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("без живых job подсказка о восстановлении уходит в контекст хода", async ({ page, request }) => {
    test.setTimeout(120_000);
    await openTask(page, ids);
    await send(page, "продолжим с этой машиной [[nomem]]");
    await waitIdle(page);
    expect(JSON.stringify(await mockRequests(request))).toContain("живых job-сессий сейчас нет");
  });

  test("с живой сессией подсказки нет", async ({ page, request }) => {
    test.setTimeout(120_000);
    const job = await (await request.post(`/api/tasks/${ids.task.id}/jobs`, {
      data: { name: "alive-shell", command: "sleep 120" },
    })).json();
    try {
      const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
      await openTask(page, { task: ids.task, chat });
      await send(page, "продолжим с этой машиной [[nomem]]");
      await waitIdle(page);
      expect(JSON.stringify(await mockRequests(request))).not.toContain("живых job-сессий сейчас нет");
    } finally {
      await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/stop`).catch(() => {});
    }
  });
});
