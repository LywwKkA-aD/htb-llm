import type { APIRequestContext } from "@playwright/test";
import { test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle, type Ids } from "./helpers";

type Call = { name: string; args: Record<string, unknown> };
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

async function toolOutputs(request: APIRequestContext, chatId: string): Promise<string[]> {
  const r = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return r.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output));
}
async function planItems(request: APIRequestContext, taskId: string): Promise<any[]> {
  return (await (await request.get(`/api/tasks/${taskId}/plan`)).json()).items;
}
async function clearPlan(request: APIRequestContext, taskId: string) {
  for (const i of await planItems(request, taskId)) await request.delete(`/api/tasks/${taskId}/plan/${i.id}`);
}
async function seedPlan(request: APIRequestContext, taskId: string, phase: string, text: string, status = "todo", note = "") {
  const r = await request.post(`/api/tasks/${taskId}/plan`, { data: { phase, text, status } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const item = await r.json();
  if (note) await request.patch(`/api/tasks/${taskId}/plan/${item.id}`, { data: { note } });
  return item;
}

test.describe("план решения задачи", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "План: проверки"); });
  test.beforeEach(async ({ request }) => {
    await mockReset(request);
    await clearPlan(request, ids.task.id);
  });

  test("plan API: CRUD, нормализация фазы, подсказка при неверном id, счётчики в списке задач", async ({ request }) => {
    expect((await request.get("/api/tasks/nonetask/plan")).status()).toBe(404);

    const a = await seedPlan(request, ids.task.id, "recon", "nmap по всем портам");
    expect(a.phase).toBe("Recon");
    expect(a.status).toBe("todo");
    const b = await seedPlan(request, ids.task.id, "Foothold", "получить шелл", "doing");

    const empty = await request.post(`/api/tasks/${ids.task.id}/plan`, { data: { phase: "Recon", text: "  " } });
    expect(empty.status()).toBe(400);

    const patched = await (await request.patch(`/api/tasks/${ids.task.id}/plan/${a.id}`, { data: { status: "done", note: "открыты 22,80" } })).json();
    expect(patched).toMatchObject({ status: "done", note: "открыты 22,80" });

    const bad = await request.patch(`/api/tasks/${ids.task.id}/plan/nope99`, { data: { status: "done" } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toContain("существующие пункты");
    expect((await request.get(`/api/tasks/${ids.task.id}/plan`)).ok()).toBeTruthy();

    const list = await (await request.get(`/api/tasks/${ids.task.id}/plan`)).json();
    expect(list.items.map((i: any) => i.text)).toEqual(["nmap по всем портам", "получить шелл"]);
    expect(list.phases).toContain("PrivEsc");

    const tasks = await (await request.get("/api/tasks")).json();
    expect(tasks.find((t: any) => t.id === ids.task.id)).toMatchObject({ plan_total: 2, plan_done: 1 });

    await request.delete(`/api/tasks/${ids.task.id}/plan/${b.id}`);
    expect(await planItems(request, ids.task.id)).toHaveLength(1);
    expect((await request.delete(`/api/tasks/${ids.task.id}/plan/${b.id}`)).status()).toBe(400);
  });

  test("plan_update: модель строит план за один ход, двигает статусы, новый чат получает план в контекст", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });

    // 8 раундов добавлений > лимита guided на действия (6): plan_update — справочный и бюджет не ест
    const adds: [string, string][] = [
      ["Recon", "просканировать все порты"],
      ["Recon", "определить сервисы"],
      ["Enumeration", "перебрать веб"],
      ["Enumeration", "проверить SMB"],
      ["Foothold", "эксплойт веба"],
      ["User", "взять user.txt"],
      ["PrivEsc", "прогон linpeas"],
      ["Root", "взять root.txt"],
    ];
    await send(page, tt(...adds.map(([phase, text]) => [call("plan_update", { action: "add", phase, text })])));
    await waitIdle(page);
    const items = await planItems(request, ids.task.id);
    expect(items.map((i) => i.text)).toEqual(adds.map(([, t]) => t));
    const outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("План задачи обновлён");
    expect(outs.at(-1)).toContain("[TODO]");
    expect(outs.at(-1)).toContain("Foothold: эксплойт веба");

    // статусы и заметки; готовая часть в сводке сворачивается счётчиком
    const first = items[0];
    await send(page, tt(
      [call("plan_update", { action: "update", id: first.id, status: "doing", note: "nmap идёт" })],
      [call("plan_update", { action: "update", id: first.id, status: "done", note: "открыты 22,80" })],
      [call("plan_update", { action: "update", id: "nope99", status: "done" })],
    ));
    await waitIdle(page);
    const outs2 = await toolOutputs(request, chat.id);
    expect(outs2.at(-3)).toContain("[DOING]");
    expect(outs2.at(-3)).toContain("nmap идёт");
    expect(outs2.at(-2)).toContain("готово 1: просканировать все порты");
    expect(outs2.at(-1)).toContain("нет такого пункта плана");
    expect(outs2.at(-1)).toContain("эксплойт веба");
    expect((await planItems(request, ids.task.id)).find((i) => i.id === first.id)).toMatchObject({ status: "done", note: "открыты 22,80" });

    // новый чат той же задачи: истории нет, план в запросе к модели — только из контекста хода
    const chat2 = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: chat2 });
    await send(page, "[[short]] что дальше по плану?");
    await waitIdle(page);
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const allText = (req.body.messages as any[]).map((m) => textOf(m.content)).join("\n");
    expect(allText).toContain("План решения задачи");
    expect(allText).toContain("готово 1: просканировать все порты");
    expect(allText).toContain("[TODO]");
    expect(allText).toContain("эксплойт веба");
    // системный промпт учит вести план
    expect(textOf(req.body.messages[0].content)).toContain("План машины веди через plan_update");
  });

  test("панель «План»: фазы с прогрессом, бейджи, смена статуса, заметки, счётчик во вкладке", async ({ page, request }) => {
    test.setTimeout(120_000);
    const doneItem = await seedPlan(request, ids.task.id, "Recon", "nmap -p-", "done", "22,80");
    const todoItem = await seedPlan(request, ids.task.id, "Recon", "версионный скан");
    const doingItem = await seedPlan(request, ids.task.id, "Foothold", "веб-эксплойт", "doing", "WP 4.8 найден");

    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await page.getByTestId("tab-plan").click();
    await expect(page.getByTestId("plan-panel")).toBeVisible();
    await expect(page.getByTestId("tab-plan-progress")).toHaveText("1/3");

    await expect(page.getByTestId("plan-item")).toHaveCount(3);
    await expect(page.locator('[data-testid="plan-phase"][data-phase="Recon"]')).toContainText("— 1/2");
    await expect(page.locator('[data-testid="plan-phase"][data-phase="Foothold"]')).toContainText("— 0/1");
    const row = (id: string) => page.locator(`[data-testid="plan-item"][data-plan-id="${id}"]`);
    await expect(row(doneItem.id).getByTestId("plan-status-badge")).toHaveText("готово");
    await expect(row(doingItem.id).getByTestId("plan-status-badge")).toHaveText("в работе");
    await expect(row(todoItem.id).getByTestId("plan-status-badge")).toHaveText("в планах");
    await expect(row(doingItem.id).getByTestId("plan-note")).toHaveText("WP 4.8 найден");

    // клик по иконке: todo → doing → done, счётчик во вкладке обновляется без перезагрузки
    await row(todoItem.id).getByTestId("plan-status").click();
    await expect(row(todoItem.id)).toHaveAttribute("data-status", "doing");
    await row(todoItem.id).getByTestId("plan-status").click();
    await expect(row(todoItem.id)).toHaveAttribute("data-status", "done");
    await expect(row(todoItem.id).getByTestId("plan-status-badge")).toHaveText("готово");
    await expect(page.getByTestId("tab-plan-progress")).toHaveText("2/3");
    await expect(page.locator('[data-testid="plan-phase"][data-phase="Recon"]')).toContainText("— 2/2");

    // правка заметки: Enter сохраняет и уходит в API
    await row(doingItem.id).getByTestId("plan-note").click();
    await expect(row(doingItem.id).getByTestId("plan-note-input")).toHaveValue("WP 4.8 найден");
    await row(doingItem.id).getByTestId("plan-note-input").fill("моя пометка: смотреть плагины");
    await row(doingItem.id).getByTestId("plan-note-input").press("Enter");
    await expect(row(doingItem.id).getByTestId("plan-note")).toHaveText("моя пометка: смотреть плагины");
    expect((await planItems(request, ids.task.id)).find((i) => i.id === doingItem.id).note).toBe("моя пометка: смотреть плагины");

    // Esc отменяет правку
    await row(doingItem.id).getByTestId("plan-note").click();
    await row(doingItem.id).getByTestId("plan-note-input").fill("не сохранять");
    await row(doingItem.id).getByTestId("plan-note-input").press("Escape");
    await expect(row(doingItem.id).getByTestId("plan-note-input")).toHaveCount(0);
    await expect(row(doingItem.id).getByTestId("plan-note")).toHaveText("моя пометка: смотреть плагины");

    // заметка пункту без заметки — через «+ заметка» при наведении
    await row(todoItem.id).hover();
    await row(todoItem.id).getByTestId("plan-note-add").click();
    await row(todoItem.id).getByTestId("plan-note-input").fill("nmap -sV -sC");
    await row(todoItem.id).getByTestId("plan-note-input").press("Enter");
    await expect(row(todoItem.id).getByTestId("plan-note")).toHaveText("nmap -sV -sC");

    // добавление пункта пользователем и удаление
    await page.getByTestId("plan-new-phase").selectOption("PrivEsc");
    await page.getByTestId("plan-new-text").fill("проверить sudo -l");
    await page.getByTestId("plan-add").click();
    await expect(page.getByTestId("plan-item")).toHaveCount(4);
    await expect(page.locator('[data-testid="plan-phase"][data-phase="PrivEsc"]')).toContainText("— 0/1");
    await expect(page.getByTestId("tab-plan-progress")).toHaveText("2/4");
    const added = (await planItems(request, ids.task.id)).find((i) => i.text === "проверить sudo -l");
    await row(added.id).hover();
    await row(added.id).getByTestId("plan-delete").click();
    await expect(page.getByTestId("plan-item")).toHaveCount(3);
    await expect(page.getByTestId("tab-plan-progress")).toHaveText("2/3");

    // всё сохраняется после перезагрузки
    await page.reload();
    await expect(page.getByTestId("plan-panel")).toBeVisible();
    await expect(page.getByTestId("plan-item")).toHaveCount(3);
    await expect(row(doingItem.id).getByTestId("plan-note")).toHaveText("моя пометка: смотреть плагины");
  });

  test("панель «План»: пустое состояние одной подсказкой, без счётчика во вкладке", async ({ page, request }) => {
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await expect(page.getByTestId("tab-plan-progress")).toHaveCount(0);
    await page.getByTestId("tab-plan").click();
    await expect(page.getByTestId("plan-panel")).toContainText("План пока пуст");
    await expect(page.getByTestId("plan-panel")).toContainText("plan_update");
    await expect(page.getByTestId("plan-panel")).toContainText("Recon → Enumeration");
    await expect(page.getByTestId("plan-item")).toHaveCount(0);
    await expect(page.getByTestId("plan-phase")).toHaveCount(0);
  });

  test("шаблоны плана: API применяет с дедупом, плохой вид — ошибка", async ({ request }) => {
    const tpl = (kind: string) => request.post(`/api/tasks/${ids.task.id}/plan/template`, { data: { kind } });
    const r1 = await tpl("privesc");
    expect(r1.ok(), await r1.text()).toBeTruthy();
    const j1 = await r1.json();
    expect(j1.added).toBe(6);
    expect(j1.items.every((i: any) => i.phase === "PrivEsc")).toBeTruthy();
    expect(j1.items.map((i: any) => i.text).join(" ")).toContain("namei");
    expect((await (await tpl("privesc")).json()).added).toBe(0); // повтор не плодит дубли
    const jm = await (await tpl("machine")).json();
    expect(jm.added).toBe(5);
    expect(new Set(jm.items.map((i: any) => i.phase))).toContain("Recon");
    expect((await tpl("nope")).status()).toBe(400);
  });

  test("панель «План»: кнопка чеклиста PrivEsc добавляет подпункты", async ({ page, request }) => {
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await page.getByTestId("tab-plan").click();
    await expect(page.getByTestId("plan-panel")).toBeVisible();
    await page.getByTestId("plan-template-privesc").click();
    await expect(page.getByTestId("plan-panel")).toContainText("Цепочки исполнения root");
    await expect(page.getByTestId("plan-item")).toHaveCount(6);
    await expect.poll(async () => (await planItems(request, ids.task.id)).length).toBe(6);
  });
});
