import { test, expect, box, right, createTask, expectInside, expectNoOverflowX, mockReset, openTask, send, waitIdle, type Ids } from "./helpers";

// Регрессии markdown-рендера ответа (web/src/components/Markdown.tsx, styles.css):
// chat-ui-1 — \( \) и \[ \] превращаются в формулы только в прозе, код (```, ~~~, отступ, `…`) не трогается, в том числе
//             пока блок кода ещё не закрыт (идёт поток); \[ \] в пункте списка и в цитате остаётся внутри них, а список
//             остаётся плотным; в заголовке и ячейке таблицы \[ \] — формула в строке; \(a\)\(b\) — две формулы;
// chat-ui-6 — $ в прозе по правилам pandoc: $HOME/$USER, ${A}${B}, $10-$20, $$, адреса и ячейки таблиц — текст,
//             настоящие формулы рядом — формулы; «$$ — PID» в начале строки и «echo $$ … kill $$» — текст;
//             $ в автоссылке <smb://…/C$> не экранируется;
// chat-ui-4 — длинная формула $$ в списке и цитате прокручивается сама, лента не шире экрана;
// chat-ui-5 — кнопка «копировать» видна при наведении и фокусе с клавиатуры (не после щелчка мышью) и копирует
//             исходник без искажений.
// Ответы модели — директивы плагина мока tests/mock-plugins/fix-markdown.mjs.

const R = String.raw;
const enc = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const say = (md: string) => `[[fixmd:say:${enc(md)}]] [[nomem]]`;
const hold = (a: string, b: string, ms: number) => `[[fixmd:hold:${enc(a)}:${enc(b)}:${ms}]] [[nomem]]`;
// исходник каждой формулы KaTeX (MathML-аннотация) — что именно стало формулой
const tex = "annotation[encoding='application/x-tex']";

test.describe("markdown: формулы и код", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Markdown: формулы и код", { brief: "Сети и Linux." }); });
  test.beforeEach(async ({ page, request }) => {
    await mockReset(request);
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
  });

  test("формулы в прозе: $…$, \\( \\) и \\[ \\] отрисованы; \\[ \\] в пункте списка и в цитате остаётся внутри них", async ({ page }) => {
    const md = [
      R`Сложность $O(n)$, хостов $2^{8}-2 = 254$, квадрат \( x^2 \) и \(n\)-й шаг.`,
      "",
      R`\[ 2^{32} - 2 \]`,
      "",
      "1. Маска сети:",
      R`   \[ 2^{8} \]`,
      "2. Дальше по списку",
      "",
      "> Цитата:",
      R`> \[`,
      "> a = b",
      R`> \]`,
      "> конец цитаты",
    ].join("\n");
    await send(page, say(md));
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai.locator(tex)).toHaveText(["O(n)", "2^{8}-2 = 254", "x^2", "n", "2^{32} - 2", "2^{8}", "a = b"]);
    await expect(ai.locator(".katex-display")).toHaveCount(3);
    await expect(ai.locator(".md > p").first()).toContainText("-й шаг.");
    // список не разорван формулой: один <ol>, два пункта, формула в первом
    await expect(ai.locator(".md ol")).toHaveCount(1);
    await expect(ai.locator(".md ol > li")).toHaveCount(2);
    await expect(ai.locator(".md ol > li").first().locator(".katex-display")).toHaveCount(1);
    await expect(ai.locator(".md ol > li").last()).toHaveText("Дальше по списку");
    // и остался плотным: перевод в блок $$ не добавил пустых строк, иначе каждый пункт обернулся бы в <p> с отступом
    await expect(ai.locator(".md li > p"), "плотный список без <p> в пунктах").toHaveCount(0);
    // цитата тоже цела: формула и текст после неё — внутри
    await expect(ai.locator(".md blockquote")).toHaveCount(1);
    await expect(ai.locator(".md blockquote .katex-display")).toHaveCount(1);
    await expect(ai.locator(".md blockquote")).toContainText("конец цитаты");
  });

  test("код не трогается: ~~~, отступ в 4 пробела, ``…``, код в пункте списка и после «$5»; «копировать» копирует исходник", async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__copied = [];
      Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (t: string) => { (window as any).__copied.push(t); } });
    });
    const grep = R`grep -E '\(ab\)\{2\}' log; echo "$1 $2"`;
    const sed = R`sed 's/\(a\)/\1/' f && echo $HOME $PATH`;
    const ps1 = R`PS1='\[\e[32m\]\u\[\e[0m\]\$ '`;
    const md = [
      "Цена $5, а команда `" + R`echo $HOME \(x\)` + "` — без формул.",
      "",
      "~~~bash",
      grep,
      "~~~",
      "",
      "Отступом:",
      "",
      `    ${sed}`,
      "",
      "1. Шаг:",
      "",
      "   ```bash",
      `   ${ps1}`,
      "   ```",
      "",
      "Код ``a ` " + R`\(b\)` + "`` и формула " + R`\(c\).`,
    ].join("\n");
    await send(page, say(md));
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai.locator(".md pre code")).toHaveText([grep, sed, ps1]);
    await expect(ai.locator(".md p code")).toHaveText([R`echo $HOME \(x\)`, R`a ` + "`" + R` \(b\)`]);
    await expect(ai.locator(".md > p").first()).toHaveText(R`Цена $5, а команда echo $HOME \(x\) — без формул.`);
    await expect(ai.locator(tex), "формула только одна — \\(c\\) в прозе").toHaveText(["c"]);

    const copied = () => page.evaluate(() => (window as any).__copied.at(-1) as string | undefined);
    const pre = ai.locator(".md pre").nth(2);
    await pre.hover();
    await ai.getByTestId("code-copy").nth(2).click();
    await expect.poll(async () => (await copied())?.trim()).toBe(ps1);
  });

  test("$ в прозе: переменные, диапазон цен, $$ (PID), адрес и ячейка таблицы — текст; формулы рядом — формулы", async ({ page }) => {
    const p1 = "Путь $HOME/$USER, подстановка ${A}${B}, диапазон $10-$20, PID текущего shell — $$, а $? — код возврата.";
    const md = [
      p1,
      "",
      "Ссылка http://example.com/$id/x и формула $a+b$ рядом.",
      "",
      "| переменная | пример |",
      "|---|---|",
      "| $HOME | /root |",
      "| формула | $x_1$ |",
    ].join("\n");
    await send(page, say(md));
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai.locator(".md > p").first()).toHaveText(p1);
    await expect(ai.locator(".md a").first()).toHaveAttribute("href", "http://example.com/$id/x");
    await expect(ai.locator(".md td").first()).toHaveText("$HOME");
    await expect(ai.locator(tex)).toHaveText(["a+b", "x_1"]);
  });

  test("незакрытый блок кода во время потока: \\( \\) и $HOME $PATH в нём не становятся формулами", async ({ page }) => {
    const a = ["Команды:", "", "```bash", R`sed 's/\(a\)/\1/' f`, "echo $HOME $PATH", ""].join("\n");
    const b = ["```", "", R`Итого \(k\) шагов.`].join("\n");
    await send(page, hold(a, b, 6000));
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai.locator(".md pre code")).toHaveText(`${R`sed 's/\(a\)/\1/' f`}\necho $HOME $PATH`);
    await expect(ai.locator(".katex")).toHaveCount(0);
    await expect(ai, "проверка шла, пока блок ещё открыт").not.toContainText("Итого");
    await waitIdle(page);
    await expect(ai.locator(".md pre code")).toHaveText(`${R`sed 's/\(a\)/\1/' f`}\necho $HOME $PATH`);
    await expect(ai.locator(tex)).toHaveText(["k"]);
  });

  test("длинная формула $$ в пункте списка и в цитате прокручивается сама; кнопка «копировать» видна при фокусе с клавиатуры", async ({ page }) => {
    const long = Array.from({ length: 70 }, (_, i) => `a_{${i}}`).join(" + ");
    const md = [
      "1. Сумма:",
      "",
      "   $$",
      `   ${long}`,
      "   $$",
      "",
      "> Цитата:",
      R`> \[ ${long} \]`,
      "",
      "```bash",
      "ip -br addr",
      "```",
    ].join("\n");
    await send(page, say(md));
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    const disp = ai.locator(".katex-display");
    await expect(disp).toHaveCount(2);
    await expect(ai.locator(".md ol > li .katex-display")).toHaveCount(1);
    await expect(ai.locator(".md blockquote .katex-display")).toHaveCount(1);
    await expectNoOverflowX(page.getByTestId("messages"), "лента с длинными формулами");
    const a = await box(ai);
    for (const d of await disp.all()) {
      const r = await d.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }));
      expect(r.ox, "формула прокручивается сама").toBe("auto");
      expect(r.sw, "формула шире своего блока — уходит в его прокрутку").toBeGreaterThan(r.cw + 100);
      expect(right(await box(d)), "формула не вылезает за ответ").toBeLessThanOrEqual(right(a) + 0.5);
    }

    // кнопка копирования: невидима без наведения, видна при наведении и при фокусе с клавиатуры, внутри блока кода;
    // после щелчка мышью фокус остаётся на кнопке, но, когда курсор ушёл, она гаснет
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async () => {} });
    });
    const copy = ai.getByTestId("code-copy");
    await page.mouse.move(1, 1);
    await expect(copy).toHaveCSS("opacity", "0");
    await copy.hover();
    await expect(copy).toHaveCSS("opacity", "1");
    await copy.click();
    await expect(copy).toBeFocused();
    await page.mouse.move(1, 1);
    await expect(copy, "щелчок мышью не оставляет кнопку видимой").toHaveCSS("opacity", "0");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(copy).toBeFocused();
    await expect(copy, "фокус с клавиатуры показывает кнопку").toHaveCSS("opacity", "1");
    await expectInside(copy, ai.locator(".md pre"), "кнопка копирования в блоке кода");
  });

  test("$$ в начале строки и два $$ в строке (PID) — текст, а код, формулы и \\( \\) дальше — как надо", async ({ page }) => {
    const md = [
      "Специальные переменные bash:",
      "",
      "- $$ — PID текущей оболочки",
      "- $! — PID последнего фонового процесса",
      "- kill $$ — завершить оболочку",
      "",
      "$$ — PID текущей оболочки.",
      "$? — код возврата.",
      "",
      "Дальше текст $HOME.",
      "",
      "$$ и $! — PID оболочки и фонового процесса.",
      "",
      R`Ещё абзац про $HOME и $PATH и \(x\).`,
      "",
      "echo $$ выводит PID, а kill $$ — завершит оболочку.",
      "",
      "$$ — PID, а пример:",
      "```bash",
      R`echo $HOME \(y\) $$`,
      "```",
      "",
      "Формулы: $$y^2$$ в строке, и отдельной строкой:",
      "",
      "$$ x^2 + z^2 $$",
      "",
      "$$ a +",
      "b $$",
      "",
      "$$w^2$$",
      "",
      "Конец $PATH.",
    ].join("\n");
    await send(page, say(md));
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai.locator(".md ul > li")).toHaveText(["$$ — PID текущей оболочки", "$! — PID последнего фонового процесса", "kill $$ — завершить оболочку"]);
    const p = ai.locator(".md > p");
    await expect(p.nth(1)).toHaveText("$$ — PID текущей оболочки. $? — код возврата.");
    await expect(p.nth(2)).toHaveText("Дальше текст $HOME.");
    await expect(p.nth(3)).toHaveText("$$ и $! — PID оболочки и фонового процесса.");
    await expect(p.nth(4)).toContainText("Ещё абзац про $HOME и $PATH и");
    await expect(p.nth(5)).toHaveText("echo $$ выводит PID, а kill $$ — завершит оболочку.");
    await expect(p.nth(6)).toHaveText("$$ — PID, а пример:");
    await expect(ai.locator(".md pre code")).toHaveText(R`echo $HOME \(y\) $$`);
    await expect(p.last()).toHaveText("Конец $PATH.");
    // формулы: \(x\), плотная $$y^2$$ в строке и три на своих строках — «$$ x^2 + z^2 $$», «$$ a +⏎b $$», «$$w^2$$» — блоками
    await expect(ai.locator(tex)).toHaveText(["x", "y^2", "x^2 + z^2", "a + b", "w^2"]);
    await expect(ai.locator(".katex-display")).toHaveCount(3);
    await expect(ai.locator(".md > p").filter({ has: page.locator(".katex") }), "$$y^2$$ — в строке абзаца").toHaveCount(2);
    await expect(ai.locator(".katex-error")).toHaveCount(0);
  });

  test("соседние формулы, \\[ \\] в заголовке и таблице, $ в автоссылке <smb://…>", async ({ page }) => {
    const md = [
      R`## Хосты \[2^{8}\] в заголовке`,
      "",
      R`Формулы \(a\)\(b\) рядом и $x$\(y\).`,
      "",
      "Ресурсы <smb://10.0.0.5/C$> и <ftp://host/$x>.",
      "",
      "| маска | хостов |",
      "|---|---|",
      R`| /24 | \[2^{8}-2\] |`,
    ].join("\n");
    await send(page, say(md));
    await waitIdle(page);
    const ai = page.getByTestId("msg-ai").last();
    await expect(ai.locator(tex)).toHaveText(["2^{8}", "a", "b", "x", "y", "2^{8}-2"]);
    await expect(ai.locator(".katex-error"), "\\(a\\)\\(b\\) — две формулы, а не одна «a$$b»").toHaveCount(0);
    await expect(ai.locator(".katex-display"), "в заголовке и ячейке — формулы в строке").toHaveCount(0);
    // заголовок и таблица целы
    await expect(ai.locator(".md h2")).toHaveCount(1);
    await expect(ai.locator(".md h2")).toContainText("в заголовке");
    await expect(ai.locator(".md h2 .katex")).toHaveCount(1);
    await expect(ai.locator(".md td")).toHaveCount(2);
    await expect(ai.locator(".md td").last().locator(".katex")).toHaveCount(1);
    // в автоссылке экраны не работают: \$ показался бы как есть
    await expect(ai.locator(".md a")).toHaveText(["smb://10.0.0.5/C$", "ftp://host/$x"]);
  });
});
