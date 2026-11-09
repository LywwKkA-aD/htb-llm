import http from "node:http";
import { WebSocket as WS } from "ws";
import { test, expect, createTask, mockReset, openTask, send, waitIdle, APP_PORT, type Ids } from "./helpers";

// Находки независимого ревью кода — каждая закреплена тестом.
test.describe("надёжность", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Надёжность"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("удаление чата посреди ответа не роняет сервер", async ({ page, request }) => {
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[slow]] [[nomem]]");
    await expect(page.getByTestId("msg-ai").last()).toContainText("слово3");
    // раньше: прерванный ход писал в журнал удалённого чата → FK-исключение → необработанный reject → процесс падал
    expect((await request.delete(`/api/chats/${c.id}`)).ok()).toBe(true);
    await page.waitForTimeout(500);
    expect((await request.get("/api/health")).ok(), "сервер жив").toBe(true);
    const c2 = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c2 });
    await send(page, "[[short]] после удаления");
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
  });

  test("стоп во время долгой команды со спецсимволами убивает процесс в контейнере", async ({ page, request }) => {
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
    // раньше pkill -f брал начало команды как regex: «(» и «|» ломали поиск, sleep жил до таймаута
    await send(page, "[[tool:shell:(sleep 47) | cat]] [[nomem]]");
    await expect(page.getByTestId("tool-block").first()).toHaveAttribute("data-status", "running");
    await page.waitForTimeout(800);
    const t0 = Date.now();
    await page.getByTestId("stop").click();
    await waitIdle(page, 15_000);
    expect(Date.now() - t0, "ход остановился быстро").toBeLessThan(8000);
    await send(page, "[[tool:shell:pgrep -af 'sleep 47' || echo NO-SLEEP]] [[nomem]]");
    await waitIdle(page);
    const tool = page.getByTestId("tool-block").last();
    await tool.locator("summary").click();
    await expect(tool.getByTestId("tool-output")).toContainText("NO-SLEEP");
  });

  test("перезагрузка страницы посреди ответа: недописанный ответ появляется и дописывается", async ({ page, request }) => {
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[slow]] [[nomem]]");
    await expect(page.getByTestId("msg-ai").last()).toContainText("слово5");
    await page.reload();
    const ai = page.getByTestId("msg-ai").last();
    // сразу после переподключения — уже набранное (раньше лента была пустой до конца хода)
    await expect(ai).toContainText("слово5", { timeout: 5000 });
    await expect(ai).toHaveAttribute("data-live", "1");
    await expect(ai).toContainText("слово30", { timeout: 10_000 }); // и продолжает дописываться
    await page.getByTestId("stop").click();
    await waitIdle(page);
  });

  test("картинки в ответе не загружаются сами (утечка через ![](url)), а показываются ссылкой", async ({ page, request }) => {
    const leaked: string[] = [];
    page.on("request", (r) => { if (r.url().includes("leak.png")) leaked.push(r.url()); });
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[img]] [[nomem]]");
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai.locator("img")).toHaveCount(0);
    await expect(ai.getByTestId("md-image-link")).toContainText("секрет");
    await page.waitForTimeout(300);
    expect(leaked).toEqual([]);
  });

  test("чужой Host (DNS-rebinding) отклоняется: API и WebSocket shell", async () => {
    const req = (path: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: APP_PORT, path, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on("error", reject); r.end();
    });
    expect(await req("/api/tasks", { Host: `evil.example:${APP_PORT}` })).toBe(403);
    expect(await req("/api/tasks", { Host: `127.0.0.1:${APP_PORT}` })).toBe(200);
    // WebSocket с чужим Origin — соединение сбрасывается
    const tryWs = (origin: string) => new Promise<string>((resolve) => {
      const ws = new WS(`ws://127.0.0.1:${APP_PORT}/ws/agent?task=${ids.task.id}`, { headers: { Origin: origin } });
      ws.on("open", () => { ws.close(); resolve("open"); });
      ws.on("error", () => resolve("rejected"));
    });
    expect(await tryWs("http://evil.example")).toBe("rejected");
    expect(await tryWs(`http://127.0.0.1:${APP_PORT}`)).toBe("open");
  });
});
