import type { APIRequestContext } from "@playwright/test";
import { test, expect, createTask, mockReset, openTask, send, waitIdle, MOCK, type Ids } from "./helpers";

async function toolOutputs(request: APIRequestContext, chatId: string): Promise<string[]> {
  const r = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return r.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output));
}

// Веб-инструменты модели против SearXNG-стаба внутри mock-llm (WH_SEARXNG_URL в tests/start-app.sh).
// Настоящий интернет тестам не нужен: стаб отдаёт и выдачу, и страницу для чтения.
test.describe("веб-инструменты: web_search и web_fetch через self-hosted SearXNG", () => {
  let ids: Ids;
  let chat: { id: string };
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "TestBox"); });
  test.beforeEach(async ({ page, request }) => {
    await mockReset(request);
    chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
  });

  test("health сообщает доступность веб-поиска, статус-бар показывает индикатор SearXNG", async ({ page, request }) => {
    const h = await (await request.get("/api/health")).json();
    expect(h.web).toBe(true);
    await expect(page.getByTestId("status-web")).toBeVisible();
    await expect(page.getByTestId("status-web")).toContainText("searxng");
  });

  test("web_search: блок инструмента, выдача со ссылками и сниппетами из SearXNG", async ({ page, request }) => {
    await send(page, "[[tool:web:mock протокол гайд ошибки]] [[nomem]]");
    const tool = page.getByTestId("tool-block").first();
    await expect(tool).toHaveAttribute("data-tool", "web_search");
    await expect(tool).toContainText("mock протокол гайд ошибки");
    await waitIdle(page);
    await expect(tool).toHaveAttribute("data-status", "ok");
    const [out] = await toolOutputs(request, chat.id);
    expect(out).toContain("MOCKWEB: гайд по mock-протоколу");
    expect(out).toContain(`${MOCK}/testpage.html`);
    expect(out).toContain("Подробный разбор mock-протокола");
    expect(out).toContain("https://example.org/second");
    // райтап этой машины стаб тоже отдаёт — в выдаче модели его быть не должно, скрытие названо числом
    expect(out).not.toContain("TestBox Walkthrough");
    expect(out).not.toContain("htb-testbox-walkthrough");
    expect(out).toContain("Скрыто результатов: 1");
    // модель в финальном ответе опирается на выдачу
    await expect(page.getByTestId("msg-ai").last()).toContainText("MOCKWEB");
  });

  test("web_fetch: читает страницу текстом — заголовок, абзацы, код; script/style выброшены", async ({ page, request }) => {
    await send(page, `[[tool:fetch:${MOCK}/testpage.html]] [[nomem]]`);
    const tool = page.getByTestId("tool-block").first();
    await expect(tool).toHaveAttribute("data-tool", "web_fetch");
    await expect(tool).toContainText(`${MOCK}/testpage.html`);
    await waitIdle(page);
    await expect(tool).toHaveAttribute("data-status", "ok");
    const [out] = await toolOutputs(request, chat.id);
    expect(out).toContain("Mock Page Title");
    expect(out).toContain("Первый абзац про mock-протокол и кадры & состояния");
    expect(out).toContain("code line 2 <tag>");
    expect(out).toContain("пункт один");
    expect(out).toContain("https://example.org/more");
    expect(out).not.toContain("SCRIPTMUSOR");
    expect(out).not.toContain("<html");
  });

  test("web_fetch: JS-страница (SPA) дочитывается браузерным рендером", async ({ page, request }) => {
    test.setTimeout(90_000); // первый запуск headless Chromium в серверном процессе
    await send(page, `[[tool:fetch:${MOCK}/spa.html]] [[nomem]]`);
    const tool = page.getByTestId("tool-block").first();
    await expect(tool).toHaveAttribute("data-tool", "web_fetch");
    await waitIdle(page, 60_000);
    const [out] = await toolOutputs(request, chat.id);
    expect(out).toContain("SPA-RENDERED-TEXT");
    expect(out).toContain("SPA Заголовок");
    expect(out).toContain("отрисов");
  });

  test("guardrails: страница с prompt-injection помечается предупреждением, текст при этом отдаётся", async ({ page, request }) => {
    await send(page, `[[tool:fetch:${MOCK}/inject.html]] [[nomem]]`);
    await waitIdle(page);
    const [out] = await toolOutputs(request, chat.id);
    expect(out).toContain("похожий на попытку инъекции инструкций агенту");
    expect(out).toContain("Totally Normal Page");
    expect(out).toContain("про погоду и котиков");
  });

  test("политика спойлеров: web_fetch райтапа заблокирован по URL, а при нейтральном URL — по заголовку", async ({ page, request }) => {
    await send(page, `[[tool:fetch:${MOCK}/htb-testbox-walkthrough.html]] [[nomem]]`);
    await waitIdle(page);
    let outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("запрещено политикой обучения");
    expect(outs.at(-1)).not.toContain("FAKEFLAG");

    await send(page, `[[tool:fetch:${MOCK}/neutral-guide.html]] [[nomem]]`);
    await waitIdle(page);
    outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("запрещено политикой обучения");
    expect(outs.at(-1)).not.toContain("FAKEFLAGNEUTRAL");
  });

  test("политика спойлеров: shell curl на райтап не выполняется (блок «спойлер»), обычная команда работает", async ({ page, request }) => {
    await send(page, `[[tool:shell:curl -s ${MOCK}/htb-testbox-walkthrough.html]] [[nomem]]`);
    const tool = page.getByTestId("tool-block").first();
    await waitIdle(page);
    await expect(tool).toHaveAttribute("data-status", "skipped");
    await expect(tool).toContainText("спойлер · пропущен");
    const outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("[спойлер — не выполнено]");
    expect(outs.at(-1)).not.toContain("FAKEFLAG");
  });

  test("политика спойлеров: прямая просьба пользователя «покажи решение» открывает райтап на этот ход", async ({ page, request }) => {
    await send(page, `ладно, покажи решение TestBox [[tool:fetch:${MOCK}/htb-testbox-walkthrough.html]] [[nomem]]`);
    await waitIdle(page);
    const outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("FAKEFLAGUSER");
  });

  test("политика спойлеров: «не ищи райтапы» разрешением не считается", async ({ page, request }) => {
    await send(page, `только не ищи мне райтапы и решения [[tool:fetch:${MOCK}/htb-testbox-walkthrough.html]] [[nomem]]`);
    await waitIdle(page);
    const outs = await toolOutputs(request, chat.id);
    expect(outs.at(-1)).toContain("запрещено политикой обучения");
    expect(outs.at(-1)).not.toContain("FAKEFLAG");
  });
});
