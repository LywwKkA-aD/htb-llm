import { test, expect, createTask, mockRequests, mockReset, openTask, send, textOf, waitIdle, type Ids } from "./helpers";

const NOTES = `# ARP

ARP (Address Resolution Protocol) сопоставляет IPv4-адрес с MAC-адресом. Запрос рассылается широковещательно, ответ приходит unicast.

## Команды

Посмотреть таблицу соседей: ip neigh show. Очистить: ip neigh flush all.

# DHCP

DHCP выдаёт адреса по схеме DORA: Discover, Offer, Request, Acknowledge.
`;

test.describe.serial("библиотека (RAG) и управление контекстом", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Библиотека"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("загрузка md в общую библиотеку и в задачу, индексация, неподдерживаемый файл", async ({ page }) => {
    await openTask(page, ids, { tab: "lib" });
    const panel = page.getByTestId("library-panel");
    await panel.getByTestId("lib-input").setInputFiles({ name: "конспект сети.md", mimeType: "text/markdown", buffer: Buffer.from(NOTES) });
    const doc = panel.getByTestId("doc-item").filter({ hasText: "конспект сети.md" });
    await expect(doc).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    await expect(doc).toContainText("фрагм.");
    await expect(panel.getByTestId("lib-global-title")).toContainText("общая библиотека · 1");

    await page.getByTestId("lib-scope-task").click();
    await panel.getByTestId("lib-input").setInputFiles({ name: "условие лабы.txt", mimeType: "text/plain", buffer: Buffer.from("Вариант 7: сеть 10.7.0.0/22, шлюз 10.7.0.1") });
    await expect(panel.getByTestId("doc-item").filter({ hasText: "условие лабы.txt" })).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    await expect(panel.getByTestId("lib-task-title")).toContainText("вложения задачи · 1");

    await panel.getByTestId("lib-input").setInputFiles({ name: "virus.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await expect(page.getByTestId("toast").filter({ hasText: "неподдерживаемый тип" })).toBeVisible();
  });

  test("ответ опирается на материалы: источники под ответом и фрагмент в контексте хода", async ({ page, request }) => {
    await openTask(page, ids);
    await send(page, "Как посмотреть таблицу соседей ARP? [[nomem]]");
    await waitIdle(page);
    await expect(page.getByTestId("recall-sources")).toContainText("конспект сети.md");
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const user = textOf(req.body.messages.filter((m: any) => m.role === "user").at(-1).content);
    expect(user).toContain("<контекст_хода>");
    expect(user).toContain("ip neigh show");
    // системный промпт стабилен — фрагменты не в нём (кэш промпта llama-server)
    expect(textOf(req.body.messages[0].content)).not.toContain("ip neigh show");
  });

  test("контекст хода стабилен для кэша: старые сообщения уходят побайтно теми же, фрагменты не повторяются", async ({ page, request }) => {
    // Раньше фрагменты исчезали из старых сообщений → промпт менялся в середине → llama-server пересчитывал всё
    // (на настоящей Qwen: 4.5K токенов и 5.7 с до первого токена на каждом ходе).
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
    const users = async () => (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!.body.messages
      .filter((m: any) => m.role === "user").map((m: any) => textOf(m.content)) as string[];
    await send(page, "Как посмотреть таблицу соседей ARP? [[nomem]]");
    await waitIdle(page);
    const [u1] = await users();
    expect(u1).toContain("<контекст_хода>");
    expect(u1).toContain("ip neigh show");
    await send(page, "А теперь про DHCP [[nomem]]");
    await waitIdle(page);
    const r2 = await users();
    expect(r2[0], "первое сообщение — побайтно то же, что на прошлом ходе").toBe(u1);
    await send(page, "Как посмотреть таблицу соседей ARP? [[nomem]]"); // тот же вопрос ещё раз
    await waitIdle(page);
    const r3 = await users();
    expect(r3[0]).toBe(u1);
    expect(r3[1]).toBe(r2[1]);
    // фрагмент про ip neigh уже есть в истории чата — второй раз его не подклеивают
    expect(r3.join("\n").split("ip neigh show").length - 1).toBe(u1.split("ip neigh show").length - 1);
    // после перезагрузки страницы (состояние из чекпоинта) — то же самое
    await page.reload();
    await expect(page.getByTestId("msg-user")).toHaveCount(3); // история загрузилась
    await send(page, "[[short]] ещё вопрос");
    await waitIdle(page);
    const r4 = await users();
    expect(r4.slice(0, 3)).toEqual(r3);
  });

  test("search_docs: фрагмент со ссылкой на источник; удаление документа через подтверждение", async ({ page }) => {
    await openTask(page, ids);
    await send(page, "[[tool:docs:DORA DHCP]]");
    await waitIdle(page);
    const tool = page.getByTestId("tool-block").first();
    await tool.locator("summary").click();
    await expect(tool.getByTestId("tool-output")).toContainText("[конспект сети.md — DHCP]");

    await page.getByTestId("tab-lib").click();
    const doc = page.getByTestId("doc-item").filter({ hasText: "конспект сети.md" });
    await doc.hover();
    await doc.getByTestId("doc-delete").click();
    await page.getByTestId("confirm-ok").click();
    await expect(doc).toHaveCount(0);
  });

  test("сворачивание контекста: резюме, маркер в ленте, полная история видна, шкала уменьшилась", async ({ page, request }) => {
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[short]] первый ход про ARP");
    await waitIdle(page);
    await send(page, "[[short]] второй ход");
    await waitIdle(page);
    await send(page, "[[big]] третий ход, контекст большой [[nomem]]");
    await waitIdle(page);

    await expect(page.getByTestId("marker-compacted")).toContainText("контекст свёрнут");
    const tokens = Number(await page.getByTestId("ctx-meter").getAttribute("data-tokens"));
    expect(tokens, "после сворачивания контекст меньше порога").toBeLessThan(12000);
    // пользователь видит всю историю, включая свёрнутые ходы
    await expect(page.getByTestId("msg-user").first()).toContainText("первый ход про ARP");
    const sumReq = (await mockRequests(request)).find((r) => r.kind === "summary");
    expect(sumReq).toBeTruthy();
    // резюме опирается на условие задачи и не должно ничего додумывать (настоящая Qwen однажды выдумала «Cisco Packet Tracer»)
    expect(textOf(sumReq!.body.messages[0].content)).toContain("Ничего не додумывай");
    expect(textOf(sumReq!.body.messages[1].content)).toContain(`Условие задачи (для контекста): ${ids.task.title}`);

    // следующий ход: старые сообщения убраны из модели, резюме — в системном промпте
    await mockReset(request);
    await send(page, "[[short]] четвёртый ход");
    await waitIdle(page);
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const sys = textOf(req.body.messages[0].content);
    expect(sys).toContain("РАНЕЕ В ЭТОМ ЧАТЕ");
    expect(sys).toContain("цель: разобраться с ARP");
    const users = req.body.messages.filter((m: any) => m.role === "user").map((m: any) => textOf(m.content));
    expect(users.some((u: string) => u.includes("первый ход"))).toBe(false);
    expect(users.at(-1)).toContain("четвёртый ход");
    // после перезагрузки маркер и история на месте
    await page.reload();
    await expect(page.getByTestId("marker-compacted")).toBeVisible();
    await expect(page.getByTestId("msg-user")).toHaveCount(4);
  });
});
