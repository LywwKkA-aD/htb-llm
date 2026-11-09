import type { Page } from "@playwright/test";
import { test, expect, box, right, createTask, expectInside, expectNoOverflowX, mockRequests, mockReset, openTask, send, textOf, waitIdle, PNG_1PX, type Ids } from "./helpers";

// Чат-интерфейс: безопасность рендера, вёрстка длинного содержимого, markdown/LaTeX, вложения,
// поток и прокрутка, две вкладки на одном чате, обрыв соединения.
// Ответы модели с заданным текстом — директивы плагина мока tests/mock-plugins/chat-ui.mjs ([[chatui:say|lines|think]]).

const say = (md: string) => `[[chatui:say:${Buffer.from(md, "utf8").toString("base64url")}]] [[nomem]]`;
const gapToBottom = (p: Page) => p.getByTestId("messages").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const lastUserText = (body: any) => textOf(body.messages.filter((m: any) => m.role === "user").at(-1).content);
const lastNum = async (p: Page, word: string) => {
  const all = (await p.getByTestId("msg-ai").last().innerText()).match(new RegExp(`${word} ?(\\d+)`, "g")) ?? [];
  return Number(all.at(-1)?.replace(/\D+/g, "") ?? 0);
};

// вторая вкладка: свой сторож нативных диалогов и JS-ошибок (авто-фикстура guard следит только за page)
function watch(p: Page) {
  const errs: string[] = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("dialog", async (d) => { errs.push(`${d.type()}: ${d.message()}`); await d.dismiss(); });
  return errs;
}

// Обрыв SSE на стороне браузера: тело ответа /send оборачивается, window.__cut() рвёт поток, как упавшая сеть
async function cutSendStream(page: Page) {
  await page.addInitScript(() => {
    const orig = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const r = await orig(...args);
      const url = String(args[0] instanceof Request ? args[0].url : args[0]);
      if (!/\/api\/chats\/[^/]+\/send$/.test(url) || !r.body) return r;
      const reader = r.body.getReader();
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      let cut = false;
      const s = new ReadableStream<Uint8Array>({
        start(c) { ctl = c; },
        async pull(c) {
          try {
            const { value, done } = await reader.read();
            if (cut) return;
            if (done) c.close(); else c.enqueue(value);
          } catch { /* поток уже оборван */ }
        },
        cancel(reason) { void reader.cancel(reason); },
      });
      (window as any).__cut = () => { cut = true; ctl.error(new TypeError("network error")); void reader.cancel(); };
      return new Response(s, { status: r.status, headers: r.headers });
    };
  });
}

test.describe("чат-интерфейс", () => {
  let ids: Ids;
  let chat: { id: string };
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Чат-UI: проверки", { brief: "Сети и Linux." }); });
  test.beforeEach(async ({ page, request }) => {
    await mockReset(request);
    chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
  });

  // ---------- безопасность рендера ----------

  test("HTML и скрипты от пользователя и от модели — только текст: лента, название чата, ссылки javascript:/data: обезврежены", async ({ page, request }) => {
    const userHtml = `<img src=x onerror="window.__xss=1;alert(1)"><script>window.__xss=2</script><b>жирный</b> &amp; <iframe src="javascript:alert(3)"></iframe>`;
    const md = [
      `Обычный текст <b>не жирный</b> и <img src=x onerror="window.__xss=3;alert(3)"> рядом.`,
      "",
      `<script>window.__xss=4;alert(4)</script>`,
      "",
      `<iframe src="https://example.com/frame"></iframe>`,
      "",
      `<details open><summary>сводка</summary>скрыто</details>`,
      "",
      `<style>body{display:none}</style>`,
      "",
      `[опасная](javascript:alert(5)) · [данные](data:text/html;base64,PHNjcmlwdD5hbGVydCg2KTwvc2NyaXB0Pg==) · [документация](https://example.com/docs?a=1&b=2)`,
      "",
      `<a href="javascript:alert(7)">сырой тег-ссылка</a>`,
    ].join("\n");
    const payload = `${userHtml} ${say(md)}`;
    await send(page, payload);
    await waitIdle(page);

    // сообщение пользователя
    const u = page.getByTestId("msg-user").last();
    await expect(u).toContainText(`<img src=x onerror="window.__xss=1;alert(1)">`);
    await expect(u).toContainText("<b>жирный</b> &amp;");
    await expect(u.locator("img, script, b, iframe")).toHaveCount(0);
    // название чата (шапка и сайдбар) — тоже текст
    await expect(page.getByTestId("chat-title")).toContainText("<img src=x");
    await expect(page.locator('[data-testid="chat-item"][aria-current="true"]')).toContainText("<img src=x");
    await expect(page.getByTestId("chat-header").locator("img")).toHaveCount(0);
    // модель получила текст байт в байт (никакой «чистки» на сервере)
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    expect(lastUserText(req.body)).toContain(payload);

    // ответ модели: сырой HTML виден как текст, элементы не создаются
    const mdBox = page.getByTestId("msg-ai").last().locator(".md");
    await expect(mdBox).toContainText("<script>window.__xss=4;alert(4)</script>");
    await expect(mdBox).toContainText(`<img src=x onerror=`);
    await expect(mdBox.locator("img, script, iframe, details, style, b")).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeVisible(); // <style> не применился
    const hrefs = await mdBox.locator("a").evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href") ?? "", target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: a.textContent })));
    for (const h of hrefs) expect(h.href, `ссылка «${h.text}»`).not.toMatch(/^\s*(javascript|data|vbscript):/i);
    const docs = hrefs.find((h) => h.text === "документация")!;
    expect(docs.href).toBe("https://example.com/docs?a=1&b=2");
    expect(docs.target).toBe("_blank");
    expect(docs.rel).toContain("noreferrer");

    // после перезагрузки (из журнала) — то же самое
    await page.reload();
    await expect(page.getByTestId("msg-user").last()).toContainText("<script>window.__xss=2</script>");
    await expect(page.getByTestId("msg-user").last().locator("img, script, iframe")).toHaveCount(0);
    await expect(page.getByTestId("msg-ai").last().locator(".md")).toContainText("<script>window.__xss=4");
    await expect(page.getByTestId("msg-ai").last().locator(".md").locator("img, script, iframe")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  });

  // ---------- длинное содержимое и вёрстка ----------

  test("20 000 символов от пользователя и богатый ответ (длинный код и URL, вложенные списки, широкая таблица, верный и НЕВЕРНЫЙ LaTeX): всё отрисовано, лента не шире экрана", async ({ page, request }) => {
    const longCmd = `curl -s 'http://10.0.0.1/api?token=${"A".repeat(600)}'`;
    const cols = Array.from({ length: 12 }, (_, i) => `колонка-${i + 1}`);
    const md = [
      "1. Первый уровень",
      "   - второй уровень",
      "     1. третий уровень А",
      "     2. третий уровень Б",
      "   - снова второй",
      "2. Снова первый",
      "",
      `| ${cols.join(" | ")} |`,
      `|${cols.map(() => "---").join("|")}|`,
      `| ${cols.map((c) => `значение-${c}-длинное`).join(" | ")} |`,
      "",
      "Инлайн: $\\sqrt{a^2+b^2}$ и в скобках \\(x_1+x_2\\).",
      "",
      "$$",
      "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
      "$$",
      "",
      "\\[ 2^{32} - 2 \\]",
      "",
      "Битые формулы: $\\frac{1}{$ и $\\left( x$ и $\\badmacro{x}$.",
      "",
      "$$",
      "\\begin{matrix} a & b \\\\ c",
      "$$",
      "",
      "Текст после формул на месте.",
      "",
      "Длинная команда:",
      "",
      "```bash",
      longCmd,
      "```",
      "",
      `Ссылка: https://example.com/${"очень-длинный-путь/".repeat(30)}конец`,
      "",
      `Слово без пробелов: ${"Ш".repeat(400)}`,
      "",
      `Инлайн-код: \`${"x".repeat(300)}\``,
    ].join("\n");
    const hex = "0123456789abcdef".repeat(320); // 5120 символов без пробелов (вывод hexdump)
    const text = `Вывод команды:\n${hex}\n${"пакет ".repeat(2500)}конец ${say(md)}`;
    expect(text.length).toBeGreaterThan(20_000);
    await send(page, text);
    await waitIdle(page);
    const msgs = page.getByTestId("messages");
    await expectNoOverflowX(msgs, "лента сообщений");
    await expectNoOverflowX(page.locator("html"), "страница");

    // пузырь пользователя переносит даже 5 КБ без пробелов
    const thread = await box(msgs.locator("> div"));
    const ub = await box(page.getByTestId("msg-user").last().locator("> div"));
    expect(ub.width / thread.width, "пузырь не шире 82% ленты").toBeLessThanOrEqual(0.83);
    expect(right(ub)).toBeLessThanOrEqual(right(thread) + 0.5);
    // модель получила сообщение целиком, название чата обрезано до 60 символов
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    expect(lastUserText(req.body)).toBe(text);
    const title = (await page.getByTestId("chat-title").innerText()).trim();
    expect(title.length, "название чата не длиннее 60 символов").toBeLessThanOrEqual(60);
    expect(title.startsWith("Вывод команды:")).toBe(true);

    // ответ: длинная строка кода не переносится, а прокручивается внутри блока
    const ai = page.getByTestId("msg-ai").last();
    const pre = ai.locator(".md pre");
    await expect(pre.locator("code")).toHaveText(longCmd);
    const pr = await pre.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }));
    expect(pr.ox, "блок кода прокручивается сам").toBe("auto");
    expect(pr.sw, "строка кода уходит в прокрутку блока").toBeGreaterThan(pr.cw + 200);
    const a = await box(ai);
    expect(right(await box(pre)), "блок кода не вылезает за ответ").toBeLessThanOrEqual(right(a) + 0.5);
    await pre.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    expect(await pre.evaluate((el) => el.scrollLeft), "команду можно дочитать прокруткой").toBeGreaterThan(200);
    // длинная ссылка кликабельна целиком и переносится в пределах ответа
    const link = ai.locator(".md a").first();
    expect(decodeURI((await link.getAttribute("href")) ?? "")).toBe(`https://example.com/${"очень-длинный-путь/".repeat(30)}конец`);
    expect(right(await box(link)), "длинная ссылка переносится в пределах ответа").toBeLessThanOrEqual(right(a) + 0.5);

    // структура: вложенные списки и широкая таблица (12 колонок) — без горизонтальной прокрутки ленты
    await expect(ai.locator(".md ol > li")).toHaveCount(4); // 2 верхних + 2 вложенных третьего уровня
    await expect(ai.locator(".md ol ul ol > li")).toHaveText(["третий уровень А", "третий уровень Б"]);
    await expect(ai.locator(".md ol ul > li")).toHaveCount(2);
    await expect(ai.locator(".md table th")).toHaveCount(12);
    await expect(ai.locator(".md table td").last()).toContainText("значение-колонка-12-длинное");
    // формулы: $…$, \(…\), $$…$$, \[…\] отрисованы; неверные — красный исходник с подсказкой, а не падение
    await expect(ai.locator(".katex-display")).toHaveCount(2);
    expect(await ai.locator(".katex").count(), "все корректные формулы отрисованы").toBeGreaterThanOrEqual(4);
    const bad = ai.locator(".katex-error");
    expect(await bad.count(), "битые формулы помечены").toBeGreaterThanOrEqual(3);
    await expect(bad.first()).toHaveAttribute("title", /ParseError|KaTeX/);
    await expect(ai.locator(".md")).toContainText("Текст после формул на месте.");
    await expect(ai.getByTestId("stats")).toBeVisible();

    // после перезагрузки огромное сообщение на месте целиком
    await page.reload();
    expect((await page.getByTestId("msg-user").last().innerText()).length).toBeGreaterThanOrEqual(text.length - 5);
  });

  test("длинная формула $$…$$ не раздвигает ленту по горизонтали", async ({ page }) => {
    const md = ["Сумма всех адресов:", "", "$$", `${Array.from({ length: 70 }, (_, i) => `a_{${i}}`).join(" + ")}`, "$$", "", "Готово."].join("\n");
    await send(page, say(md));
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai.locator(".katex-display")).toHaveCount(1);
    await expectNoOverflowX(page.getByTestId("messages"), "лента с длинной формулой");
  });

  test("код с \\( \\) и \\[ \\] (sed, grep, PS1) показывается и копируется без искажений", async ({ page }) => {
    const sed = String.raw`sed 's/\(foo\)-\(bar\)/\2-\1/' file.txt`;
    const ps1 = String.raw`PS1='\[\e[32m\]\u@\h\[\e[0m\]\$ '`;
    const grep = String.raw`grep -E '\(ab\)\{2\}' log`;
    const md = ["Команды:", "", "```bash", sed, ps1, "```", "", `И инлайн: \`${grep}\``].join("\n");
    await send(page, say(md));
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai.locator(".md pre code")).toHaveText(`${sed}\n${ps1}`);
    await expect(ai.locator(".md p code")).toHaveText(grep);
    await expect(ai.locator(".katex")).toHaveCount(0);
  });

  test("переменные shell ($HOME, $PATH, $1) в тексте ответа не превращаются в формулы", async ({ page }) => {
    const md = [
      "Переменная $HOME указывает на домашний каталог, а $PATH — на список каталогов с программами.",
      "",
      "В скрипте $1 и $2 — аргументы, а цена VPS — $5 в месяц.",
      "",
      "Хостов в /24: $2^{8}-2 = 254$.",
    ].join("\n");
    await send(page, say(md));
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai.locator(".md p").nth(0)).toHaveText("Переменная $HOME указывает на домашний каталог, а $PATH — на список каталогов с программами.");
    await expect(ai.locator(".md p").nth(1)).toHaveText("В скрипте $1 и $2 — аргументы, а цена VPS — $5 в месяц.");
    await expect(ai.locator(".katex"), "настоящая формула при этом остаётся формулой").toHaveCount(1);
  });

  test("кнопка «копировать» остаётся видна, когда длинный код прокручен вправо", async ({ page }) => {
    await send(page, say(["```bash", `echo ${"B".repeat(500)}`, "```"].join("\n")));
    await waitIdle(page);
    const pre = page.getByTestId("msg-ai").last().locator(".md pre");
    await pre.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await pre.hover();
    await expectInside(page.getByTestId("msg-ai").last().getByTestId("code-copy"), pre, "кнопка копирования в видимой части блока кода"); // кнопка — соседка <pre>, не ребёнок
  });

  // ---------- поле ввода и вложения ----------

  test("поле ввода: пробельное сообщение не уходит; вставка картинки (Ctrl+V) и перетаскивание — только картинки, максимум 4; отправка картинок без текста", async ({ page, request }) => {
    const input = page.getByTestId("composer-input");
    const composer = page.getByTestId("composer");
    const b64 = PNG_1PX.toString("base64");
    // пустое и пробельное сообщение не отправляется ни кнопкой, ни Enter; сервер тоже отказывает
    await expect(page.getByTestId("send")).toBeDisabled();
    await input.fill("   \n\t  \n");
    await expect(page.getByTestId("send")).toBeDisabled();
    await input.press("Enter");
    await expect(page.getByTestId("msg-user")).toHaveCount(0);
    const r = await request.post(`/api/chats/${chat.id}/send`, { data: { text: "  \n ", images: [] } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("пустое");
    await input.fill("");

    // вставка из буфера: файл-картинка перехватывается, обычный текст — нет
    const pasted = await input.evaluate((el, b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], "screen.png", { type: "image/png" }));
      const img = el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      const t = new DataTransfer();
      t.setData("text/plain", "просто текст");
      const txt = el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: t, bubbles: true, cancelable: true }));
      return { imgDefault: img, textDefault: txt };
    }, b64);
    expect(pasted.imgDefault, "вставка картинки перехвачена").toBe(false);
    expect(pasted.textDefault, "вставка текста не блокируется").toBe(true);
    await expect(page.getByTestId("thumb")).toHaveCount(1);

    // перетаскивание: зона подсвечивается, текстовый файл игнорируется, картинка прикладывается
    type F = { name: string; type: string; png: boolean };
    const drag = (files: F[], type: "dragover" | "drop" | "dragleave") =>
      composer.evaluate((el, [files, type, b64]) => {
        const bin = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        for (const f of files as F[]) dt.items.add(new File([f.png ? bin : "hello"], f.name, { type: f.type }));
        return el.dispatchEvent(new DragEvent(type as string, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }, [files, type, b64] as const);
    const mixed: F[] = [{ name: "a.png", type: "image/png", png: true }, { name: "notes.txt", type: "text/plain", png: false }];
    expect(await drag(mixed, "dragover"), "dragover отменён — браузер не откроет файл сам").toBe(false);
    await expect(composer).toHaveClass(/border-dashed/);
    await drag(mixed, "dragleave");
    await expect(composer).not.toHaveClass(/border-dashed/);
    await drag(mixed, "dragover");
    expect(await drag(mixed, "drop"), "drop отменён — страница не уходит на файл").toBe(false);
    await expect(composer).not.toHaveClass(/border-dashed/);
    await expect(page.getByTestId("thumb")).toHaveCount(2);
    await drag([{ name: "x.txt", type: "text/plain", png: false }], "drop");
    await expect(page.getByTestId("thumb")).toHaveCount(2);
    // ещё 5 картинок — остаётся предел 4
    await drag(Array.from({ length: 5 }, (_, i) => ({ name: `s${i}.png`, type: "image/png", png: true })), "drop");
    await expect(page.getByTestId("thumb")).toHaveCount(4);
    await page.waitForTimeout(300); // все FileReader отработали — больше 4 так и не стало
    await expect(page.getByTestId("thumb")).toHaveCount(4);
    expect(new URL(page.url()).pathname).toBe("/");

    // отправка только картинок (без текста): кнопка активна, пузырь с 4 картинками, модель получает 4 image_url
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("send")).toBeEnabled();
    await page.getByTestId("send").click();
    await expect(page.getByTestId("msg-user")).toHaveCount(1);
    await expect(page.getByTestId("msg-user").locator("img")).toHaveCount(4);
    await expect(page.getByTestId("thumb")).toHaveCount(0);
    await waitIdle(page);
    let req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const user = req.body.messages.filter((m: any) => m.role === "user").at(-1);
    expect(user.content.filter((p: any) => p.type === "image_url")).toHaveLength(4);
    // название чата не затёрто пустым текстом; задаётся первым текстовым сообщением
    await expect(page.getByTestId("chat-title")).toHaveText("новый чат");
    await send(page, "[[short]] что на скриншотах?");
    await waitIdle(page);
    await expect(page.getByTestId("chat-title")).toContainText("что на скриншотах?");
    // старые картинки в модель повторно не уходят — вместо них пометка
    req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const users = req.body.messages.filter((m: any) => m.role === "user");
    expect(JSON.stringify(users)).not.toContain("image_url");
    expect(textOf(users[0].content)).toContain("[изображение из прошлого хода]");
  });

  // ---------- поток и прокрутка ----------

  test("размышления: раскрыты, пока модель думает, сворачиваются с началом ответа; раскрытие во время ответа не сбрасывается", async ({ page }) => {
    await send(page, "[[chatui:think:30:120]] [[nomem]]");
    const ai = page.getByTestId("msg-ai").last();
    const r = ai.getByTestId("reasoning");
    await expect(r).toContainText("мысль3");
    await expect(r).toHaveAttribute("open", "");
    await expect(r.locator("summary")).toContainText("размышляю");
    await expect(ai).toHaveAttribute("data-live", "1");
    // пошёл ответ — размышления сворачиваются
    await expect(ai.locator(".md")).toContainText("ответ2");
    await expect(r).not.toHaveAttribute("open", "");
    await expect(r.locator("summary")).not.toContainText("размышляю");
    // пользователь сам раскрыл — новые токены не захлопывают панель
    await r.locator("summary").click();
    await expect(r).toHaveAttribute("open", "");
    await expect(ai.locator(".md")).toContainText("ответ15");
    await expect(r).toHaveAttribute("open", "");
    await expect(r).toContainText("мысль30");
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last().getByTestId("reasoning").locator("summary")).toContainText(/размышления · ~\d+ ток\./);
  });

  test("автопрокрутка во время потока; отмотка вверх (ползунок) не дёргает вниз; «вниз» возвращает слежение", async ({ page }) => {
    await send(page, "[[chatui:lines:160:60]] [[nomem]]");
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai).toContainText("Строка 25");
    await expect.poll(() => gapToBottom(page), { message: "лента следит за потоком" }).toBeLessThan(80);
    await expect(ai).toContainText("Строка 40");
    await expect.poll(() => gapToBottom(page)).toBeLessThan(80);
    // пользователь утаскивает ползунок вверх (один большой скачок) — лента не должна возвращать его вниз
    await page.getByTestId("messages").evaluate((el) => { el.style.scrollBehavior = "auto"; el.scrollTop = Math.max(0, el.scrollTop - 1200); el.dispatchEvent(new Event("scroll")); });
    await expect(page.getByTestId("to-bottom")).toBeVisible();
    const top = await page.getByTestId("messages").evaluate((el) => el.scrollTop);
    const n = await lastNum(page, "Строка");
    await expect(ai).toContainText(`Строка ${n + 25}`);
    const top2 = await page.getByTestId("messages").evaluate((el) => el.scrollTop);
    expect(Math.abs(top2 - top), "позиция прокрутки не изменилась").toBeLessThanOrEqual(2);
    expect(await gapToBottom(page)).toBeGreaterThan(300);
    // «вниз» — снова в конце и снова следим
    await page.getByTestId("to-bottom").click();
    await expect.poll(() => gapToBottom(page)).toBeLessThan(80);
    await expect(ai).toContainText(`Строка ${n + 50}`);
    await expect.poll(() => gapToBottom(page)).toBeLessThan(80);
    await expect(page.getByTestId("to-bottom")).toHaveCount(0);
    await waitIdle(page);
  });

  test("во время потока можно плавно отмотать вверх колесом/тачпадом (мелкими шагами)", async ({ page }) => {
    await send(page, "[[chatui:lines:200:50]] [[nomem]]");
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai).toContainText("Строка 40");
    await expect.poll(() => gapToBottom(page)).toBeLessThan(80);
    await page.getByTestId("messages").hover();
    // 20 шагов по 30px (как тачпад/колесо с плавной прокруткой) — всего 600px вверх
    for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, -30); await page.waitForTimeout(25); }
    await expect(page.getByTestId("to-bottom")).toBeVisible({ timeout: 3000 });
    expect(await gapToBottom(page), "пользователь остался там, куда отмотал").toBeGreaterThan(300);
  });

  // ---------- две вкладки и обрывы ----------

  test("две вкладки: Enter во время ответа не отправляет и не стирает набранное; отправка из второй — понятная ошибка; после перезагрузки вторая видит поток и её «стоп» останавливает ход в обеих", async ({ page, request }) => {
    const p2 = await page.context().newPage();
    const errs = watch(p2);
    await openTask(p2, { task: ids.task, chat });
    await send(page, "[[slow]] [[nomem]] две вкладки");
    await expect(page.getByTestId("msg-ai").last()).toContainText("слово3");
    // в первой вкладке следующий вопрос набирают, пока агент отвечает: Enter не отправляет и не стирает его
    const input = page.getByTestId("composer-input");
    await expect(input).toHaveAttribute("placeholder", /агент работает/);
    await input.fill("следующий вопрос [[short]]");
    await input.press("Enter");
    await expect(page.getByTestId("msg-user")).toHaveCount(1);
    await expect(input).toHaveValue("следующий вопрос [[short]]");
    await expect(page.getByTestId("send")).toHaveCount(0);
    // вторая вкладка открыта до начала хода и о нём не знает — отправка отклоняется понятной ошибкой
    await p2.getByTestId("composer-input").fill("вопрос из второй вкладки [[short]]");
    await p2.getByTestId("composer-input").press("Enter");
    const toast = p2.getByTestId("toast").filter({ hasText: "уже идёт ответ" });
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("data-kind", "error");
    // первая вкладка этого не заметила — поток идёт дальше
    const seen = await lastNum(page, "слово");
    await expect(page.getByTestId("msg-ai").last()).toContainText(`слово${seen + 10}`);
    // вторая вкладка после перезагрузки подхватывает идущий ответ
    await p2.reload();
    const ai2 = p2.getByTestId("msg-ai").last();
    await expect(p2.getByTestId("msg-user").last()).toContainText("две вкладки");
    await expect(ai2).toHaveAttribute("data-live", "1");
    await expect(p2.getByTestId("stop")).toBeVisible();
    const seen2 = await lastNum(p2, "слово");
    await expect(ai2).toContainText(`слово${seen2 + 10}`);
    // «стоп» из второй — остановлены обе
    await p2.getByTestId("stop").click();
    await waitIdle(p2);
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("(остановлено)");
    await expect(ai2).toContainText("(остановлено)");
    await expect(page.getByTestId("send")).toBeVisible();
    expect(await ai2.locator(".md").innerText(), "обе вкладки показывают одинаковый итог").toBe(await page.getByTestId("msg-ai").last().locator(".md").innerText());
    // набранный в первой вкладке вопрос дождался конца хода и уходит по Enter
    await expect(input).toHaveValue("следующий вопрос [[short]]");
    await input.press("Enter");
    await expect(page.getByTestId("msg-user")).toHaveCount(2);
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
    // и вторая дальше работает
    await send(p2, "[[short]] из второй");
    await waitIdle(p2);
    await expect(p2.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
    // отклонённое сообщение до модели не дошло
    const sent = (await mockRequests(request)).filter((r) => r.kind === "agent").map((r) => lastUserText(r.body));
    expect(sent.some((t) => t.includes("вопрос из второй вкладки"))).toBe(false);
    expect(sent.some((t) => t.includes("следующий вопрос"))).toBe(true);
    await p2.close();
    expect(errs).toEqual([]);
  });

  test("неудачная отправка (чат занят в другой вкладке) не теряет набранный текст и картинку", async ({ page }) => {
    const p2 = await page.context().newPage();
    const errs = watch(p2);
    await openTask(p2, { task: ids.task, chat });
    await send(page, "[[slow]] [[nomem]] первая вкладка");
    await expect(page.getByTestId("msg-ai").last()).toContainText("слово3");
    const typed = "длинный вопрос, который я набирал минуту [[short]]";
    await p2.getByTestId("attach-input").setInputFiles([{ name: "схема.png", mimeType: "image/png", buffer: PNG_1PX }]);
    await expect(p2.getByTestId("thumb")).toHaveCount(1);
    await p2.getByTestId("composer-input").fill(typed);
    await p2.getByTestId("composer-input").press("Enter");
    await expect(p2.getByTestId("toast").filter({ hasText: "уже идёт ответ" })).toBeVisible();
    await page.getByTestId("stop").click();
    await waitIdle(page);
    expect(errs).toEqual([]);
    // ожидание: набранное остаётся в поле, чтобы отправить его ещё раз
    await expect(p2.getByTestId("composer-input")).toHaveValue(typed, { timeout: 3000 });
    await expect(p2.getByTestId("thumb")).toHaveCount(1);
  });

  test("обрыв потока посреди ответа: ошибка видна, ход на сервере продолжается; уход в другой чат и возврат подхватывает ответ", async ({ page, request }) => {
    await cutSendStream(page);
    await openTask(page, { task: ids.task, chat });
    await send(page, "[[chatui:lines:150:100]] [[nomem]] обрыв");
    await expect(page.getByTestId("msg-ai").last()).toContainText("Строка 5");
    await page.evaluate(() => (window as any).__cut());
    await expect(page.getByTestId("toast").filter({ hasText: "network" })).toBeVisible();
    // сервер не бросил ход из-за ушедшего клиента
    expect((await (await request.get(`/api/chats/${chat.id}/log`)).json()).chat.busy).toBe(true);
    // новый чат, пока первый ещё отвечает: первый в сайдбаре помечен «занят», второй работает параллельно
    await page.getByTestId("new-chat").click();
    await expect(page.getByTestId("hero")).toBeVisible();
    await expect(page.locator(`[data-chat-id="${chat.id}"] .animate-spin`)).toBeVisible();
    await send(page, "[[short]] параллельный вопрос");
    await waitIdle(page);
    await expect(page.getByTestId("msg-ai").last()).toContainText("Коротко: да.");
    // возврат в первый чат — подключение к идущему ходу, ответ дописывается до конца
    await page.locator(`[data-chat-id="${chat.id}"]`).click();
    const ai = page.getByTestId("msg-ai").last();
    await expect(page.getByTestId("msg-user").last()).toContainText("обрыв");
    await expect(ai).toHaveAttribute("data-live", "1");
    await expect(page.getByTestId("stop")).toBeVisible();
    await expect(ai).toContainText("Строка 150", { timeout: 30_000 });
    await waitIdle(page, 30_000);
    await expect(page.getByTestId("msg-ai").last()).toHaveAttribute("data-live", "0");
    await expect(page.getByTestId("msg-ai").last()).not.toContainText("(остановлено)");
  });

  test("после переподключения к ходу (перезагрузка посреди ответа) индикатор «занят» в сайдбаре гаснет, когда ответ дописан", async ({ page }) => {
    await send(page, "[[chatui:lines:30:100]] [[nomem]] перезагрузка");
    await expect(page.getByTestId("msg-ai").last()).toContainText("Строка 3");
    await page.reload();
    const ai = page.getByTestId("msg-ai").last();
    const spinner = page.locator(`[data-chat-id="${chat.id}"] .animate-spin`);
    await expect(ai).toHaveAttribute("data-live", "1");
    await expect(spinner).toBeVisible();
    await waitIdle(page);
    await expect(ai).toContainText("Строка 30");
    await expect(spinner).toHaveCount(0);
  });

  test("обрыв потока посреди ответа: вкладка сама переподключается к идущему ходу и не теряет уже показанное", async ({ page }) => {
    await cutSendStream(page);
    await openTask(page, { task: ids.task, chat });
    await send(page, "[[chatui:lines:60:100]] [[nomem]] обрыв");
    await expect(page.getByTestId("msg-ai").last()).toContainText("Строка 5");
    await page.evaluate(() => (window as any).__cut());
    // сервер сообщает busy=true — ожидаем переподключение, как после перезагрузки страницы, без ручного F5
    await expect(page.getByTestId("msg-ai").last()).toContainText("Строка 60", { timeout: 20_000 });
  });
});
