import type { APIRequestContext } from "@playwright/test";
import { test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle, type Ids } from "./helpers";

type Call = { name: string; args: Record<string, unknown> };
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

async function toolOutputs(request: APIRequestContext, chatId: string): Promise<string[]> {
  const r = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return r.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output));
}
async function profileItems(request: APIRequestContext, taskId: string): Promise<any[]> {
  return (await (await request.get(`/api/tasks/${taskId}/profile`)).json()).items;
}
async function clearProfile(request: APIRequestContext, taskId: string) {
  for (const i of await profileItems(request, taskId)) await request.delete(`/api/tasks/${taskId}/profile/${i.id}`);
}
async function seedProfile(request: APIRequestContext, taskId: string, data: Record<string, unknown>) {
  const r = await request.post(`/api/tasks/${taskId}/profile`, { data });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}

test.describe("профиль цели и креды", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Профиль: проверки"); });
  test.beforeEach(async ({ request }) => {
    await mockReset(request);
    await clearProfile(request, ids.task.id);
  });

  test("profile API: CRUD, upsert по естественным ключам, валидация, счётчик в списке задач", async ({ request }) => {
    expect((await request.get("/api/tasks/nonetask/profile")).status()).toBe(404);

    const svc = await seedProfile(request, ids.task.id, { kind: "service", host: "10.0.0.5", port: 80, service: "http" });
    expect(svc).toMatchObject({ proto: "tcp", port: 80, service: "http" });
    // тот же host:port/proto с версией — обновление той же записи, а не дубль
    const svc2 = await seedProfile(request, ids.task.id, { kind: "service", host: "10.0.0.5", port: 80, version: "Apache 2.4.18", source: "nmap -sV" });
    expect(svc2.id).toBe(svc.id);
    expect(svc2).toMatchObject({ service: "http", version: "Apache 2.4.18" });
    expect(await profileItems(request, ids.task.id)).toHaveLength(1);

    expect((await request.post(`/api/tasks/${ids.task.id}/profile`, { data: { kind: "service", service: "http" } })).status()).toBe(400);
    expect((await request.post(`/api/tasks/${ids.task.id}/profile`, { data: { kind: "service", port: 99999 } })).status()).toBe(400);
    expect((await request.post(`/api/tasks/${ids.task.id}/profile`, { data: { kind: "bogus", text: "x" } })).status()).toBe(400);
    expect((await request.post(`/api/tasks/${ids.task.id}/profile`, { data: { kind: "cred", service: "ssh", username: "notch" } })).status()).toBe(400);

    const cred = await seedProfile(request, ids.task.id, { kind: "cred", service: "ssh", username: "notch", secret: "pass123", source: "/home/notch/.bash_history" });
    expect(cred.secret_type).toBe("password");
    // тот же сервис+логин (сервис в другом регистре) — ротация секрета в той же записи, источник сохранён
    const cred2 = await seedProfile(request, ids.task.id, { kind: "cred", service: "SSH", username: "notch", secret: "pass456" });
    expect(cred2.id).toBe(cred.id);
    expect(cred2).toMatchObject({ secret: "pass456", source: "/home/notch/.bash_history" });

    const acc = await seedProfile(request, ids.task.id, { kind: "access", text: "shell www-data через загрузку плагина WP" });
    const fact = await seedProfile(request, ids.task.id, { kind: "fact", text: "Ubuntu 16.04" });
    const patched = await (await request.patch(`/api/tasks/${ids.task.id}/profile/${fact.id}`, { data: { text: "Ubuntu 16.04.3 LTS" } })).json();
    expect(patched.text).toBe("Ubuntu 16.04.3 LTS");
    // очистка обязательного поля валидацией не пропускается
    expect((await request.patch(`/api/tasks/${ids.task.id}/profile/${acc.id}`, { data: { text: "" } })).status()).toBe(400);

    const bad = await request.patch(`/api/tasks/${ids.task.id}/profile/nope99`, { data: { text: "x" } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toContain("существующие записи");
    expect((await request.get(`/api/tasks/${ids.task.id}/profile`)).ok()).toBeTruthy();
    const list = await (await request.get(`/api/tasks/${ids.task.id}/profile`)).json();
    expect(list.kinds).toContain("cred");
    expect(list.items).toHaveLength(4);

    const tasks = await (await request.get("/api/tasks")).json();
    expect(tasks.find((t: any) => t.id === ids.task.id)).toMatchObject({ profile_total: 4 });

    await request.delete(`/api/tasks/${ids.task.id}/profile/${fact.id}`);
    expect(await profileItems(request, ids.task.id)).toHaveLength(3);
    expect((await request.delete(`/api/tasks/${ids.task.id}/profile/${fact.id}`)).status()).toBe(400);
  });

  test("profile_update: модель записывает находки, upsert уточняет, новый чат получает профиль с кредами", async ({ page, request }) => {
    test.setTimeout(120_000);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });

    await send(page, tt(
      [call("profile_update", { action: "add", kind: "service", port: 22, service: "ssh", version: "OpenSSH 7.2p2 Ubuntu", source: "nmap -sV" })],
      [call("profile_update", { action: "add", kind: "service", port: 80, service: "http" })],
      [call("profile_update", { action: "add", kind: "cred", service: "wordpress", username: "notch", secret: "secret-wp-42", source: "wp-config.php" })],
      [call("profile_update", { action: "add", kind: "access", text: "shell www-data через загрузку плагина" })],
      [call("profile_update", { action: "add", kind: "fact", text: "Ubuntu 16.04" })],
    ));
    await waitIdle(page);
    expect(await profileItems(request, ids.task.id)).toHaveLength(5);
    const outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("Профиль цели обновлён");
    expect(outs.at(-1)).toContain("22/tcp ssh OpenSSH 7.2p2 Ubuntu");
    expect(outs.at(-1)).toContain("notch / secret-wp-42");
    expect(outs.at(-1)).toContain("источник: wp-config.php");
    expect(outs.at(-1)).toContain("Доступы:");

    // повторный add того же порта уточняет версию без дубля; неверный id подсказывает настоящие записи
    await send(page, tt(
      [call("profile_update", { action: "add", kind: "service", port: 80, version: "Apache 2.4.18 (Ubuntu)" })],
      [call("profile_update", { action: "update", id: "nope99", text: "x" })],
    ));
    await waitIdle(page);
    const items = await profileItems(request, ids.task.id);
    expect(items).toHaveLength(5);
    expect(items.find((i) => i.port === 80)).toMatchObject({ service: "http", version: "Apache 2.4.18 (Ubuntu)" });
    const outs2 = await toolOutputs(request, chat.id);
    expect(outs2.at(-2)).toContain("Apache 2.4.18 (Ubuntu)");
    expect(outs2.at(-1)).toContain("нет такой записи профиля");
    expect(outs2.at(-1)).toContain("80/tcp");

    // новый чат той же задачи: истории нет, профиль с кредами — только из контекста хода
    const chat2 = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: chat2 });
    await send(page, "[[short]] что мы уже знаем о цели?");
    await waitIdle(page);
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const allText = (req.body.messages as any[]).map((m) => textOf(m.content)).join("\n");
    expect(allText).toContain("Профиль цели");
    expect(allText).toContain("secret-wp-42");
    expect(allText).toContain("Apache 2.4.18 (Ubuntu)");
    expect(allText).toContain("shell www-data");
    expect(textOf(req.body.messages[0].content)).toContain("Профиль цели веди через profile_update");
  });

  test("панель «Цель»: группы, маскировка и копирование секрета, добавление и upsert через форму, счётчик", async ({ page, request }) => {
    test.setTimeout(120_000);
    await seedProfile(request, ids.task.id, { kind: "service", host: "10.0.0.5", port: 80, service: "http", version: "Apache 2.4.18", source: "nmap -sV" });
    await seedProfile(request, ids.task.id, { kind: "service", host: "10.0.0.5", port: 22, service: "ssh", version: "OpenSSH 7.2" });
    const cred = await seedProfile(request, ids.task.id, { kind: "cred", service: "ssh", username: "notch", secret: "pass123", source: ".bash_history" });
    await seedProfile(request, ids.task.id, { kind: "access", text: "shell www-data через upload" });
    const fact = await seedProfile(request, ids.task.id, { kind: "fact", text: "Ubuntu 16.04" });

    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await page.getByTestId("tab-target").click();
    await expect(page.getByTestId("profile-panel")).toBeVisible();
    await expect(page.getByTestId("tab-profile-count")).toHaveText("5");
    await expect(page.getByTestId("profile-item")).toHaveCount(5);
    await expect(page.locator('[data-testid="profile-group"][data-kind="service"]')).toContainText("· 2");
    await expect(page.locator('[data-testid="profile-group"][data-kind="cred"]')).toContainText("· 1");
    // сервисы отсортированы по порту
    const services = page.locator('[data-testid="profile-item"][data-kind="service"]');
    await expect(services.first()).toContainText("22/tcp");
    await expect(services.nth(1)).toContainText("80/tcp");
    await expect(services.nth(1)).toContainText("Apache 2.4.18");

    // секрет замаскирован, но копируется настоящий; показ — явным переключателем
    await page.evaluate(() => {
      (window as any).__copied = [];
      Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (t: string) => { (window as any).__copied.push(t); } });
    });
    const copied = () => page.evaluate(() => (window as any).__copied.at(-1) as string | undefined);
    const row = (id: string) => page.locator(`[data-testid="profile-item"][data-profile-id="${id}"]`);
    await expect(row(cred.id).getByTestId("profile-secret")).toHaveText("••••••");
    await expect(row(cred.id)).not.toContainText("pass123");
    await expect(row(cred.id).getByTestId("profile-source")).toHaveText(".bash_history");
    await row(cred.id).getByTestId("profile-copy").click();
    await expect.poll(copied).toBe("pass123");
    await expect(row(cred.id).getByTestId("profile-copy")).toContainText("скопировано");
    await page.getByTestId("profile-toggle-secrets").click();
    await expect(row(cred.id).getByTestId("profile-secret")).toHaveText("pass123");
    await page.getByTestId("profile-toggle-secrets").click();
    await expect(row(cred.id).getByTestId("profile-secret")).toHaveText("••••••");

    // добавление кред через форму (вид по умолчанию — креды)
    await page.getByTestId("profile-new-service").fill("mysql");
    await page.getByTestId("profile-new-username").fill("root");
    await page.getByTestId("profile-new-secret").fill("toor42");
    await page.getByTestId("profile-new-source").fill("my.cnf");
    await page.getByTestId("profile-add").click();
    await expect(page.getByTestId("profile-item")).toHaveCount(6);
    await expect(page.getByTestId("tab-profile-count")).toHaveText("6");
    await expect(page.locator('[data-testid="profile-group"][data-kind="cred"]')).toContainText("· 2");

    // добавление сервиса через форму
    await page.getByTestId("profile-new-kind").selectOption("service");
    await page.getByTestId("profile-new-port").fill("445");
    await page.getByTestId("profile-new-service").fill("smb");
    await page.getByTestId("profile-new-version").fill("Samba 4.3.11");
    await page.getByTestId("profile-add").click();
    await expect(page.getByTestId("profile-item")).toHaveCount(7);
    await expect(page.getByTestId("tab-profile-count")).toHaveText("7");

    // повторное добавление тех же кред с новым секретом — upsert, счётчик не вырос
    await page.getByTestId("profile-new-kind").selectOption("cred");
    await page.getByTestId("profile-new-service").fill("ssh");
    await page.getByTestId("profile-new-username").fill("notch");
    await page.getByTestId("profile-new-secret").fill("pass999");
    await page.getByTestId("profile-add").click();
    await expect(page.getByTestId("profile-item")).toHaveCount(7);
    await page.getByTestId("profile-toggle-secrets").click();
    await expect(row(cred.id).getByTestId("profile-secret")).toHaveText("pass999");

    // удаление и сохранение после перезагрузки
    await row(fact.id).hover();
    await row(fact.id).getByTestId("profile-delete").click();
    await expect(page.getByTestId("profile-item")).toHaveCount(6);
    await expect(page.getByTestId("tab-profile-count")).toHaveText("6");
    await page.reload();
    await expect(page.getByTestId("profile-panel")).toBeVisible();
    await expect(page.getByTestId("profile-item")).toHaveCount(6);
    await expect(row(cred.id).getByTestId("profile-source")).toHaveText(".bash_history");
  });

  test("панель «Цель»: пустое состояние одной подсказкой, без счётчика во вкладке", async ({ page, request }) => {
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await expect(page.getByTestId("tab-profile-count")).toHaveCount(0);
    await page.getByTestId("tab-target").click();
    await expect(page.getByTestId("profile-panel")).toContainText("Профиль цели пока пуст");
    await expect(page.getByTestId("profile-panel")).toContainText("profile_update");
    await expect(page.getByTestId("profile-item")).toHaveCount(0);
    await expect(page.getByTestId("profile-group")).toHaveCount(0);
  });
});
