import type { APIRequestContext } from "@playwright/test";
import { test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle, type Ids } from "./helpers";

type Call = { name: string; args: Record<string, unknown> };
const sh = (command: string): Call => ({ name: "shell", args: { command } });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

const USER_FLAG = "0123456789abcdef0123456789abcdef";
const ROOT_FLAG = "fedcba9876543210fedcba9876543210";

async function memories(request: APIRequestContext, taskId: string): Promise<any[]> {
  return (await (await request.get(`/api/tasks/${taskId}/memories`)).json()) as any[];
}
async function clearAll(request: APIRequestContext, taskId: string) {
  for (const m of await memories(request, taskId)) await request.delete(`/api/memories/${m.id}`);
  const prof = (await (await request.get(`/api/tasks/${taskId}/profile`)).json()).items as any[];
  for (const i of prof) await request.delete(`/api/tasks/${taskId}/profile/${i.id}`);
}

test.describe("рецепт захода после флага", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Рецепт: проверки"); });
  test.beforeEach(async ({ request }) => {
    await mockReset(request);
    await clearAll(request, ids.task.id);
  });

  test("cat user.txt с флагом — сервер собирает карточку рецепта; повтор и голый хэш не шумят; root — отдельная", async ({ page, request }) => {
    test.setTimeout(120_000);
    // вектор для черновика: доступ и сервис уже в профиле
    await request.post(`/api/tasks/${ids.task.id}/profile`, { data: { kind: "service", port: 22, service: "ssh", version: "OpenSSH 7.2" } });
    await request.post(`/api/tasks/${ids.task.id}/profile`, { data: { kind: "access", text: "shell www-data через загрузку плагина" } });

    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });

    // подготовка файлов флага не показывает (вывод пуст по хэшу) — карточки ещё нет; cat показывает
    await send(page, tt(
      [sh(`mkdir -p /tmp/rt && printf '${USER_FLAG}\\n' > /tmp/rt/user.txt && printf '${ROOT_FLAG}\\n' > /tmp/rt/root.txt && echo READY-FILES`)],
      [sh("cat /tmp/rt/user.txt")],
    ));
    await waitIdle(page);

    let mems = await memories(request, ids.task.id);
    expect(mems).toHaveLength(1);
    expect(mems[0]).toMatchObject({ kind: "result", status: "pending", title: "Рецепт захода: user.txt" });
    expect(mems[0].content).toContain(USER_FLAG);
    expect(mems[0].content).toContain("cat /tmp/rt/user.txt"); // ключевые команды хода
    expect(mems[0].content).toContain("shell www-data через загрузку плагина"); // вектор из профиля
    expect(mems[0].content).toContain("22/tcp");
    expect(mems[0].content).toContain("поправь перед подтверждением");
    // карточка видна в чате как обычное предложение памяти
    await expect(page.getByText("Рецепт захода: user.txt")).toBeVisible();
    // промпт требует рецепт и в финальном ответе модели
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    expect(textOf(req.body.messages[0].content)).toContain("рецепт захода");

    // голый хэш без контекста файла и повторный cat вторую карточку не плодят; root.txt — отдельная
    await send(page, tt(
      [sh(`echo ${USER_FLAG}`)],
      [sh("cat /tmp/rt/user.txt")],
      [sh("cat /tmp/rt/root.txt")],
    ));
    await waitIdle(page);
    mems = await memories(request, ids.task.id);
    expect(mems).toHaveLength(2);
    expect(mems.map((m) => m.title).sort()).toEqual(["Рецепт захода: root.txt", "Рецепт захода: user.txt"]);
    expect(mems.find((m) => m.title.includes("root"))!.content).toContain(ROOT_FLAG);
  });
});
