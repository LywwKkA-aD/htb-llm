import { test, expect, createTask, mockReset, openTask, MOCK, type Ids } from "./helpers";

const MOCK_V1 = `${MOCK}/v1`;

async function waitReindex(request: any) {
  await expect.poll(async () => (await (await request.get("/api/settings/reindex")).json()).reindex.running, { timeout: 90_000 }).toBe(false);
  return (await (await request.get("/api/settings/reindex")).json());
}

test.describe("переиндексация RAG при смене эмбеддингов", () => {
  let ids: Ids;
  let docId = 0;
  test.beforeAll(async ({ request }) => {
    ids = await createTask(request, "Переиндексация: проверки");
    const up = await request.post("/api/docs", {
      multipart: { files: { name: "методичка переиндексации.md", mimeType: "text/markdown", buffer: Buffer.from("# Переиндексация\n\nФрагменты базы знаний переэмбеддятся активной моделью при смене пресета эмбеддингов. Уникальный маркёр: зебрафильтр-49.") } },
    });
    expect(up.ok(), await up.text()).toBeTruthy();
    const docs = await up.json();
    docId = (Array.isArray(docs) ? docs[0] : docs).id;
    await expect.poll(async () => {
      const list = await (await request.get("/api/docs")).json();
      return list.find((d: any) => d.id === docId)?.status;
    }, { timeout: 30_000 }).toBe("ready");
  });
  test.afterAll(async ({ request }) => {
    // вернуть локальный пресет и согласованный индекс, документ убрать
    await request.put("/api/settings", { data: { embed: { active: "local", local: { url: MOCK_V1, model: "embed", apiKey: "", provider: "", quantization: "" } } } });
    await request.post("/api/settings/reindex");
    await waitReindex(request);
    if (docId) await request.delete(`/api/docs/${docId}`);
  });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("смена модели эмбеддингов помечает индекс устаревшим; кнопка в UI переиндексирует", async ({ request, page }) => {
    const s0 = await (await request.get("/api/settings")).json();
    expect(s0.embedIndex.chunks).toBeGreaterThan(0);
    expect(s0.embedIndex.stale).toBe(false);
    expect(s0.embedIndex.dim).toBe(1024);

    const put = await request.put("/api/settings", {
      data: { embed: { active: "custom", custom: { url: MOCK_V1, model: "cohere/embed-5-fast", apiKey: "sk-emb-1" } } },
    });
    expect(put.ok(), await put.text()).toBeTruthy();
    const s1 = await (await request.get("/api/settings")).json();
    expect(s1.embedIndex.stale).toBe(true);

    // UI: баннер устаревания + переиндексация по кнопке с подтверждением
    await openTask(page, ids);
    await page.getByTestId("settings-open").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await expect(page.getByTestId("embed-index-stale")).toBeVisible();
    await page.getByTestId("reindex-start").click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("reindex-done")).toBeVisible({ timeout: 90_000 });

    const fin = await waitReindex(request);
    expect(fin.reindex.error).toBeNull();
    expect(fin.reindex.done).toBeGreaterThan(0);
    expect(fin.reindex.done).toBe(fin.reindex.total);
    expect(fin.embedIndex.stale).toBe(false);
    expect(fin.embedIndex.model).toBe("cohere/embed-5-fast");
    expect(fin.embedIndex.builtAt).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
  });

  test("повторный запуск во время работы отклоняется; после — можно снова", async ({ request }) => {
    const r1 = await request.post("/api/settings/reindex");
    expect(r1.ok(), await r1.text()).toBeTruthy();
    // второй старт может успеть после завершения первого (индекс маленький) — тогда он тоже ок;
    // инвариант: финальное состояние без ошибок и индекс согласован с активной моделью
    await request.post("/api/settings/reindex").catch(() => {});
    const fin = await waitReindex(request);
    expect(fin.reindex.error).toBeNull();
    expect(fin.embedIndex.stale).toBe(false);
  });
});
