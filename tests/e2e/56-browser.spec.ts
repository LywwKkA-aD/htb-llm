import { execFileSync, spawnSync } from "node:child_process";
import { test, expect, createTask, openTask, type Ids } from "./helpers";

// Встроенный браузер задачи: Selkies-Firefox сайдкаром в netns Kali-контейнера. Панель стрима
// опубликована на 127.0.0.1 хоста в спеке контейнера задачи; Firefox видит сеть задачи (и её VPN)
// напрямую. Первый старт в чистом окружении качает образ — таймауты с запасом.
test.describe("встроенный браузер задачи (Selkies)", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Браузер Selkies"); });
  test.afterAll(async ({ request }) => { await request.post(`/api/tasks/${ids.task.id}/browser/stop`).catch(() => {}); });

  test("старт поднимает Firefox в netns задачи, панель отвечает на 127.0.0.1, стоп убирает сайдкар", async ({ page, request }) => {
    test.setTimeout(600_000);
    const before = await (await request.get(`/api/tasks/${ids.task.id}/browser`)).json();
    expect(before.running).toBe(false);
    expect(before.image).toContain("firefox");

    const start = await request.post(`/api/tasks/${ids.task.id}/browser/start`, { timeout: 60_000 });
    expect(start.ok(), await start.text()).toBeTruthy();
    await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.task.id}/browser`)).json()).phase,
      { timeout: 540_000 }).toBe("running");
    const st = await (await request.get(`/api/tasks/${ids.task.id}/browser`)).json();
    expect(st.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    // панель Selkies реально отвечает хосту (с повторами: свежеинициализированный образ может блипнуть)
    await expect.poll(async () => {
      try { const r = await request.get(st.url); return r.status() === 200 && (await r.text()).includes("Selkies"); }
      catch { return false; }
    }, { timeout: 60_000 }).toBe(true);

    // сайдкар именно в netns контейнера задачи (видит её VPN и интерфейсы)
    const mode = execFileSync("docker", ["inspect", "-f", "{{.HostConfig.NetworkMode}}", `whitehat-browser-${ids.task.id}`]).toString().trim();
    expect(mode).toContain("container:");
    const code = execFileSync("docker", ["exec", `whitehat-${ids.task.id}`, "bash", "-c",
      "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/"]).toString().trim();
    expect(code).toBe("200"); // общий localhost: панель видна из самой задачи

    // UI: вкладка «Браузер» показывает iframe стрима; внутри — живой Selkies, а не ошибка
    // secure context (по bridge-IP Selkies отказывается работать: требует HTTPS/localhost)
    await openTask(page, ids, { tab: "browser" });
    await expect(page.getByTestId("browser-panel")).toBeVisible();
    await expect(page.getByTestId("browser-status")).toHaveAttribute("data-phase", "running");
    await expect(page.getByTestId("browser-frame")).toHaveAttribute("src", st.url);
    await expect(page.getByTestId("browser-stop")).toBeVisible();
    const frame = page.frameLocator('[data-testid="browser-frame"]');
    await expect(frame.locator("canvas").first()).toBeVisible({ timeout: 60_000 });
    await expect(frame.locator("body")).not.toContainText("requires a secure connection");

    const stop = await request.post(`/api/tasks/${ids.task.id}/browser/stop`, { timeout: 60_000 });
    expect(stop.ok(), await stop.text()).toBeTruthy();
    const fin = await (await request.get(`/api/tasks/${ids.task.id}/browser`)).json();
    expect(fin.running).toBe(false);
    expect(fin.phase).toBe("stopped");
    expect(spawnSync("docker", ["inspect", `whitehat-browser-${ids.task.id}`]).status).not.toBe(0);
  });
});
