import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { test, expect, createTask, openTask, type Ids } from "./helpers";

// Перехватывающий прокси задачи (Caido): бинарь ставится сервером в /work, процесс слушает eth0
// контейнера, панель и сам прокси опубликованы на 127.0.0.1 хоста. До выбора проекта в UI Caido
// отвечает страницей «select a project» — для теста это тоже доказательство, что запрос прошёл
// именно через прокси-листенер в netns задачи.
const DATA = path.resolve(process.env.E2E_DATA ?? "tests/.data");

function dexec(taskId: string, script: string) {
  const name = `whitehat-${taskId}`;
  const label = execFileSync("docker", ["inspect", "-f", '{{index .Config.Labels "whitehat.data"}}', name]).toString().trim();
  expect(label, "контейнер принадлежит этому тестовому прогону").toBe(DATA);
  return execFileSync("docker", ["exec", name, "bash", "-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test.describe("прокси задачи (Caido)", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Прокси Caido"); });
  test.afterAll(async ({ request }) => { await request.post(`/api/tasks/${ids.task.id}/proxy/stop`).catch(() => {}); });

  test("старт ставит Caido, UI отвечает на 127.0.0.1, запрос проходит через прокси-листенер, стоп гасит процесс", async ({ page, request }) => {
    test.setTimeout(600_000);
    const before = await (await request.get(`/api/tasks/${ids.task.id}/proxy`)).json();
    expect(before.running).toBe(false);
    expect(before.version).toBeTruthy();

    const start = await request.post(`/api/tasks/${ids.task.id}/proxy/start`, { timeout: 60_000 });
    expect(start.ok(), await start.text()).toBeTruthy();
    await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.task.id}/proxy`)).json()).phase,
      { timeout: 420_000 }).toBe("running");
    const st = await (await request.get(`/api/tasks/${ids.task.id}/proxy`)).json();
    expect(st.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(st.lanUrl).toMatch(/^http:\/\/172\.\d+\.\d+\.\d+:8181\/$/);

    const ui = await request.get(st.url);
    expect(ui.status()).toBe(200);
    expect(await ui.text()).toMatch(/caido/i);
    expect(dexec(ids.task.id, "test -x /work/.whitehat/caido/caido-cli && echo BINOK")).toContain("BINOK");

    // маркерный HTTP-сервис внутри задачи; запрос с хоста через опубликованный прокси-порт
    expect(dexec(ids.task.id, "mkdir -p /tmp/pxsite && echo WH-CAIDO-OK > /tmp/pxsite/m.txt && nohup python3 -m http.server 18080 --directory /tmp/pxsite </dev/null >/tmp/px.log 2>&1 & for i in $(seq 1 20); do curl -sf http://127.0.0.1:18080/m.txt && { echo READY; break; }; sleep 0.25; done")).toContain("READY");
    const lanHost = new URL(st.lanUrl).hostname;
    const via = spawnSync("curl", ["-s", "--max-time", "20", "-x", st.url.replace(/\/$/, ""), `http://${lanHost}:18080/m.txt`], { encoding: "utf8" });
    expect(via.stdout).toMatch(/WH-CAIDO-OK|selecting a project/i);

    await openTask(page, ids, { tab: "proxy" });
    await expect(page.getByTestId("proxy-panel")).toBeVisible();
    await expect(page.getByTestId("proxy-status")).toHaveAttribute("data-phase", "running");
    await expect(page.getByTestId("proxy-frame")).toHaveAttribute("src", st.url);
    await expect(page.getByTestId("proxy-url")).toHaveText(st.url.replace(/\/$/, ""));

    const stop = await request.post(`/api/tasks/${ids.task.id}/proxy/stop`, { timeout: 60_000 });
    expect(stop.ok(), await stop.text()).toBeTruthy();
    const fin = await (await request.get(`/api/tasks/${ids.task.id}/proxy`)).json();
    expect(fin.running).toBe(false);
    expect(fin.phase).toBe("stopped");
    expect(dexec(ids.task.id, "pgrep -f '[c]aido-cli' || echo NONE")).toContain("NONE");
    dexec(ids.task.id, "pkill -f '[h]ttp.server 18080' 2>/dev/null; true");
  });
});
