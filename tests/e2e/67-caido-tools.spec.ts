import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect, createTask, mockReset, openTask, send, waitIdle, type Ids } from "./helpers";

// Агентские инструменты Caido: история трафика прокси, сырой запрос/ответ и реплей с правкой raw.
// Проект Caido при первом обращении создаётся сам (без проекта прокси трафик не пропускает).
const DATA = path.resolve(process.env.E2E_DATA ?? "tests/.data");
function dexec(taskId: string, script: string) {
  const name = `whitehat-${taskId}`;
  const label = execFileSync("docker", ["inspect", "-f", '{{index .Config.Labels "whitehat.data"}}', name]).toString().trim();
  expect(label, "контейнер принадлежит этому тестовому прогону").toBe(DATA);
  return execFileSync("docker", ["exec", name, "bash", "-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

type Call = { name: string; args: Record<string, unknown> };
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;
const toolOuts = async (request: any, chatId: string): Promise<string> => {
  const log = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return log.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output)).join("\n");
};

test.describe("инструменты Caido у агента", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Caido инструменты"); });
  test.afterAll(async ({ request }) => {
    await request.post(`/api/tasks/${ids.task.id}/proxy/stop`).catch(() => {});
    try { dexec(ids.task.id, "pkill -f '[h]ttp.server 18080' 2>/dev/null; true"); } catch { /* контейнер мог уже лечь */ }
  });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("history → detail → replay с правкой пути", async ({ page, request }) => {
    test.setTimeout(600_000);
    const start = await request.post(`/api/tasks/${ids.task.id}/proxy/start`, { timeout: 60_000 });
    expect(start.ok(), await start.text()).toBeTruthy();
    await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.task.id}/proxy`)).json()).phase,
      { timeout: 420_000 }).toBe("running");
    const st = await (await request.get(`/api/tasks/${ids.task.id}/proxy`)).json();
    const lan = new URL(st.lanUrl);
    expect(dexec(ids.task.id, "mkdir -p /tmp/csite && echo WH-CAIDO-OK > /tmp/csite/m.txt && echo WH-SECOND > /tmp/csite/m2.txt && nohup python3 -m http.server 18080 --directory /tmp/csite </dev/null >/tmp/cs.log 2>&1 & for i in $(seq 1 20); do curl -sf http://127.0.0.1:18080/m.txt >/dev/null && { echo READY; break; }; sleep 0.25; done")).toContain("READY");

    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    // первый вызов: проект создастся сам, история пока пуста
    await send(page, tt([call("caido_history", {})]));
    await waitIdle(page);
    expect(await toolOuts(request, chat.id)).toContain("история пуста");

    // трафик через прокси изнутри контейнера
    expect(dexec(ids.task.id, `curl -s --max-time 15 -x http://${lan.hostname}:8181 http://127.0.0.1:18080/m.txt`)).toContain("WH-CAIDO-OK");
    await send(page, tt([call("caido_history", {})]));
    await waitIdle(page);
    const hist = await toolOuts(request, chat.id);
    expect(hist).toMatch(/#\d+ GET .*\/m\.txt.*→ 200/);
    const rid = /#(\d+) GET/.exec(hist)![1];

    await send(page, tt(
      [call("caido_request", { id: rid })],
      [call("caido_replay", { id: rid, raw: "GET /m2.txt HTTP/1.1\nHost: 127.0.0.1:18080\nConnection: close\n\n" })],
    ));
    await waitIdle(page);
    const all = await toolOuts(request, chat.id);
    expect(all).toContain("WH-CAIDO-OK"); // тело ответа в детали исходного запроса
    expect(all).toContain("caido_replay: повтор");
    expect(all).toContain("WH-SECOND"); // реплей с правкой пути дошёл до второго файла
  });
});
