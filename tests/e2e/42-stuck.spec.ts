import type { APIRequestContext } from "@playwright/test";
import { test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle, type Ids } from "./helpers";

type Call = { name: string; args: Record<string, unknown> };
const sh = (command: string): Call => ({ name: "shell", args: { command } });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

async function clearAll(request: APIRequestContext, taskId: string) {
  const plan = (await (await request.get(`/api/tasks/${taskId}/plan`)).json()).items as any[];
  for (const i of plan) await request.delete(`/api/tasks/${taskId}/plan/${i.id}`);
  const prof = (await (await request.get(`/api/tasks/${taskId}/profile`)).json()).items as any[];
  for (const i of prof) await request.delete(`/api/tasks/${taskId}/profile/${i.id}`);
}
async function agentReqs(request: APIRequestContext) {
  return (await mockRequests(request)).filter((r) => r.kind === "agent").map((r) => r.body as { messages: any[] });
}
const adviceIn = (body: { messages: any[] }) =>
  body.messages.some((m) => textOf(m.content).includes("[whitehat] Советник при застревании:"));

test.describe("советник при застревании", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Советник: проверки"); });
  test.beforeEach(async ({ request }) => {
    await mockReset(request);
    await clearAll(request, ids.task.id);
  });

  test("три раунда ошибок подряд — в следующий запрос вставлена сводка известного, в историю не пишется", async ({ page, request }) => {
    test.setTimeout(120_000);
    // известное заранее: пункт плана в работе, сервис и креды в профиле — сводка соберётся из них без модели
    const planItem = await (await request.post(`/api/tasks/${ids.task.id}/plan`, { data: { phase: "Enumeration", text: "проверить FTP" } })).json();
    await request.patch(`/api/tasks/${ids.task.id}/plan/${planItem.id}`, { data: { status: "doing" } });
    await request.post(`/api/tasks/${ids.task.id}/profile`, { data: { kind: "service", port: 22, service: "ssh", version: "OpenSSH 7.2" } });
    await request.post(`/api/tasks/${ids.task.id}/profile`, { data: { kind: "cred", service: "ssh", username: "notch", secret: "pass123", source: "bash_history" } });

    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await send(page, tt(
      [sh("ls /nonexistent-a")],
      [sh("ls /nonexistent-b")],
      [sh("cat /nonexistent-c")],
      [sh("echo FRESH-AFTER-ADVICE")],
    ));
    await waitIdle(page);

    const reqs = await agentReqs(request);
    // запросы: R1, R2, R3, R4 (советник уже вставлен), финал
    expect(reqs.length).toBeGreaterThanOrEqual(5);
    expect(adviceIn(reqs[0]), "до ошибок советника нет").toBe(false);
    expect(adviceIn(reqs[1])).toBe(false);
    expect(adviceIn(reqs[2])).toBe(false);
    const withAdvice = reqs[3];
    expect(adviceIn(withAdvice), "после трёх пустых раундов советник вставлен").toBe(true);
    const adviceMsg = withAdvice.messages.map((m) => textOf(m.content)).find((t) => t.includes("[whitehat] Советник"))!;
    expect(adviceMsg).toContain("не дали новых фактов");
    expect(adviceMsg).toContain("проверить FTP"); // план: в работе
    expect(adviceMsg).toContain("22/tcp"); // профиль: сервисы
    expect(adviceMsg).toContain("ssh/notch"); // профиль: креды без секрета
    expect(adviceMsg).not.toContain("pass123");
    expect(adviceMsg).toContain("спроси пользователя");
    // подсказка эфемерна: в финальном запросе её в истории нет
    expect(adviceIn(reqs.at(-1)!), "советник не сохраняется в историю хода").toBe(false);
    // промпт объясняет модели, что делать с такой вставкой
    expect(textOf(reqs[0].messages[0].content)).toContain("Советник при застревании");
  });

  test("прогресс между ошибками сбрасывает счётчик — советник молчит", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await send(page, tt(
      [sh("ls /nonexistent-a")], // ошибка
      [sh("ls /nonexistent-b")], // ошибка
      [sh("echo NEWFACT-42")], // новый содержательный вывод — счётчик сброшен
      [sh("ls /nonexistent-c")], // ошибка
      [sh("cat /nonexistent-d")], // ошибка: подряд только две
    ));
    await waitIdle(page);
    const reqs = await agentReqs(request);
    expect(reqs.length).toBeGreaterThanOrEqual(6);
    for (const [i, r] of reqs.entries()) expect(adviceIn(r), `запрос ${i}: советника быть не должно`).toBe(false);
  });
});
