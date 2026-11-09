import { test, expect, MOCK } from "./helpers";

// Регрессия свежей установки под OpenRouter: пустая база, vec-таблица создана на дефолтных 1024
// (локальная Qwen), пользователь первым делом включает внешний эмбеддинг на 2048 и жмёт
// «скачать и построить базу». Сборка не должна падать на размерности: пустой индекс обязан
// сам пересоздаться под активную модель, а сервер — подхватить новую размерность без рестарта.
const V1 = `${MOCK}/v1`;

async function waitKnowledge(request: any) {
  await expect.poll(async () => (await (await request.get("/api/settings/knowledge")).json()).knowledge.running, { timeout: 180_000 }).toBe(false);
  return (await (await request.get("/api/settings/knowledge")).json());
}
async function waitReindex(request: any) {
  await expect.poll(async () => (await (await request.get("/api/settings/reindex")).json()).reindex.running, { timeout: 90_000 }).toBe(false);
}

test.describe("свежая установка: внешний эмбеддинг другой размерности + сборка базы", () => {
  let upDocId = 0;
  test.afterAll(async ({ request }) => {
    const list = await (await request.get("/api/docs")).json();
    for (const name of ["htb-00-methodology.md"]) {
      const doc = list.find((d: any) => d.name === name && d.task_id === null);
      if (doc) await request.delete(`/api/docs/${doc.id}`);
    }
    if (upDocId) await request.delete(`/api/docs/${upDocId}`);
    await request.put("/api/settings", { data: { embed: { active: "local", local: { url: V1, model: "embed", apiKey: "", provider: "", quantization: "" } } } });
    const r = await request.post("/api/settings/reindex").catch(() => null);
    if (r?.ok()) await waitReindex(request);
  });

  test("пустой индекс на 1024 + Cohere 2048: кнопка сборки доводит базу до готовности без переиндексации и рестарта", async ({ request }) => {
    test.setTimeout(240_000);
    const s0 = await (await request.get("/api/settings")).json();
    test.skip(s0.embedIndex.chunks > 0, "индекс уже не пуст — сценарий свежей установки в этом прогоне не воспроизвести");
    expect(s0.embedIndex.dim).toBe(1024);

    const put = await request.put("/api/settings", {
      data: { embed: { active: "custom", custom: { url: V1, model: "cohere/embed-5-fast", apiKey: "sk-emb-dim" } } },
    });
    expect(put.ok(), await put.text()).toBeTruthy();
    // пустой базе «устаревать» нечему: подсказка про переиндексацию не должна противоречить пустоте
    const s1 = await (await request.get("/api/settings")).json();
    expect(s1.embedIndex.stale).toBe(false);

    const r = await request.post("/api/settings/knowledge");
    expect(r.ok(), await r.text()).toBeTruthy();
    const fin = await waitKnowledge(request);
    expect(fin.knowledge.error).toBeNull();
    expect(fin.embedIndex.dim).toBe(2048);
    expect(fin.embedIndex.chunks).toBeGreaterThan(0);
    expect(fin.embedIndex.stale).toBe(false);
    expect(fin.embedIndex.model).toBe("cohere/embed-5-fast");
    const list = await (await request.get("/api/docs")).json();
    expect(list.find((d: any) => d.name === "htb-00-methodology.md" && d.task_id === null)?.status).toBe("ready");
  });

  test("серверный процесс после сборки эмбеддит сам (размерность подхвачена без рестарта)", async ({ request }) => {
    const s = await (await request.get("/api/settings")).json();
    test.skip(s.embedIndex.dim !== 2048, "предыдущий тест не довёл индекс до 2048");
    const up = await request.post("/api/docs", {
      multipart: { files: { name: "размерность-55.md", mimeType: "text/markdown", buffer: Buffer.from("# Размерность\n\nДокумент после сборки базы: сервер индексирует его активной моделью без перезапуска. Маркёр: вектор-55.") } },
    });
    expect(up.ok(), await up.text()).toBeTruthy();
    const docs = await up.json();
    upDocId = (Array.isArray(docs) ? docs[0] : docs).id;
    await expect.poll(async () => {
      const list = await (await request.get("/api/docs")).json();
      return list.find((d: any) => d.id === upDocId)?.status;
    }, { timeout: 30_000 }).toBe("ready");
  });
});
