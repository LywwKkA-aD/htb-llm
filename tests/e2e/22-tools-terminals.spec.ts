import { execFileSync } from "node:child_process";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, createTask, mockReset, mockRequests, openTask, send, termText, textOf, waitIdle, type Ids } from "./helpers";

// Крайние случаи инструментов агента и обоих терминалов против настоящего Kali-контейнера.
// Сценарии агента задаёт плагин мока tests/mock-plugins/tools-terminals.mjs: [[tt:<base64url JSON>]] —
// раунды вызовов с любыми аргументами (timeout_sec, `]`, переводы строк, read_rfc, несколько вызовов в раунде).

type Call = { name: string; args: Record<string, unknown> };
const sh = (command: string, extra: Record<string, unknown> = {}): Call => ({ name: "shell", args: { command, ...extra } });
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

// результаты инструментов ровно в том виде, в каком они ушли в модель (журнал чата = содержимое ToolMessage)
async function toolOutputs(request: APIRequestContext, chatId: string): Promise<string[]> {
  const r = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return r.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output));
}
// секунды из шапки «[exit 0, 0.3 с]»
const secsOf = (out: string) => Number(/^\[exit -?\d+, ([\d.]+) с\]/.exec(out)?.[1] ?? NaN);

// docker exec только в СВОЙ контейнер: метка whitehat.data = каталог данных этого прогона
function dexec(taskId: string, cmd: string): string {
  const name = `whitehat-${taskId}`;
  const label = execFileSync("docker", ["inspect", "-f", '{{index .Config.Labels "whitehat.data"}}', name]).toString().trim();
  expect(label, "контейнер принадлежит этому прогону").toBe(process.env.E2E_DATA);
  return execFileSync("docker", ["exec", name, "bash", "-c", cmd]).toString();
}

async function shellReady(page: Page) {
  await expect(page.getByTestId("term-shell")).toHaveAttribute("data-ws", "open", { timeout: 20_000 });
  await expect.poll(() => termText(page, "shell"), { timeout: 20_000 }).toMatch(/root@task-\w+/);
}
async function shellRun(page: Page, cmd: string) {
  await page.getByTestId("term-shell").locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
}
let sizeTag = 0;
async function sttySize(page: Page): Promise<[number, number]> {
  const tag = `SZ${++sizeTag}`;
  await shellRun(page, `echo ${tag}-$(stty size | tr ' ' x)-END`);
  const re = new RegExp(`${tag}-(\\d+)x(\\d+)-END`);
  let m = null as RegExpExecArray | null; // as — присваивание в колбэке TS не видит
  await expect.poll(async () => (m = re.exec(await termText(page, "shell"))) !== null, { timeout: 10_000 }).toBe(true);
  return [Number(m![1]), Number(m![2])];
}
// маркеры идут в терминале именно в этом порядке (по последнему вхождению — выше может быть вывод прошлых тестов)
const inOrder = (text: string, marks: string[]) => {
  const idx = marks.map((s) => text.lastIndexOf(s));
  return idx.every((x, i) => x >= 0 && (i === 0 || x > idx[i - 1])) ? "ok" : JSON.stringify(Object.fromEntries(marks.map((s, i) => [s, idx[i]])));
};

test.describe("инструменты и терминалы: крайние случаи (настоящий Kali)", () => {
  let ids: Ids;
  let chat: { id: string };
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Инструменты: крайние случаи"); });
  test.beforeEach(async ({ request }) => {
    await mockReset(request);
    chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
  });

  test("огромный вывод (seq 1 200000): в модель — голова+хвост, полный вывод файлом в /work/.whitehat, агент grep'ает его", async ({ page, request }) => {
    test.setTimeout(90_000);
    await openTask(page, { task: ids.task, chat });
    await send(page, tt([sh("seq 1 200000")], [sh("test -f {{saved}} && wc -l < {{saved}} && grep -x 123456 {{saved}} && tail -n 1 {{saved}}")]));
    await waitIdle(page, 60_000);
    const [big, check] = await toolOutputs(request, chat.id);
    expect(big.startsWith("[exit 0,"), big.slice(0, 80)).toBe(true);
    // 1..200000 с переводами строк — 1 288 895 символов; в контекст — 3600 головы + 2400 хвоста
    expect(big).toContain("\n1\n2\n3\n");
    expect(big).toMatch(/\n…\[обрезано 1282895 символов; полный вывод: \/work\/\.whitehat\/out-[\w-]+\.txt — можно grep\/sed\]…\n/);
    expect(big.trimEnd().endsWith("\n199999\n200000"), big.slice(-40)).toBe(true);
    expect(big.length).toBeLessThan(6300);
    // файл в контейнере: строка «$ команда» + все 200000 строк, grep по нему находит середину
    expect(check.split("\n").slice(1, 4), check).toEqual(["200001", "123456", "200000"]);
    // в модель ушло именно сокращённое
    const last = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    expect(last.body.messages.filter((m: any) => m.role === "tool").map((m: any) => textOf(m.content))[0]).toBe(big);
    // интерфейс: пометка об обрезке в блоке, в терминале агента — настоящий конец вывода
    const b = page.getByTestId("tool-block").first();
    await b.locator("summary").click();
    await expect(b.getByTestId("tool-output")).toContainText("обрезано 1282895 символов; полный вывод: /work/.whitehat/out-");
    await page.getByTestId("term-agent-max").click();
    await expect.poll(() => termText(page, "agent"), { timeout: 20_000 }).toContain("199999");
  });

  test("вывод больше 4 МБ (seq 1 1000000): хвост в контексте и файл «полного вывода» — настоящий конец", async ({ request }) => {
    test.setTimeout(90_000);
    // без открытой страницы: 7 МБ в xterm браузеру ни к чему — ход идёт напрямую через API
    const r = await request.post(`/api/chats/${chat.id}/send`, {
      data: { text: tt([sh("seq 1 1000000")], [sh("tail -n 1 {{saved}}; wc -l < {{saved}}")]), effort: "off" }, timeout: 80_000,
    });
    expect(r.ok()).toBe(true);
    expect(await r.text()).toContain('"type":"done"');
    const [big, check] = await toolOutputs(request, chat.id);
    expect(big.trimEnd().endsWith("\n999999\n1000000"), `хвост для модели: …${JSON.stringify(big.slice(-30))}`).toBe(true);
    expect(check.split("\n").slice(1, 3), `файл «полного вывода»: ${check}`).toEqual(["1000000", "1000001"]);
  });

  test("timeout_sec: долгая команда прерывается по своему таймауту, процесс убит, ход не висит", async ({ page, request }) => {
    await openTask(page, { task: ids.task, chat });
    const t0 = Date.now();
    await send(page, tt([sh("sleep 31; echo never-printed", { timeout_sec: 2 })], [sh("pgrep -fx 'sleep 31' >/dev/null && echo SLEEP-ALIVE || echo NO-SLEEP")]));
    await waitIdle(page);
    expect(Date.now() - t0, "ход закончился задолго до 31 с").toBeLessThan(25_000);
    const blocks = page.getByTestId("tool-block");
    await expect(blocks).toHaveCount(2);
    await expect(blocks.nth(0)).toHaveAttribute("data-status", "error");
    await expect(blocks.nth(0)).toContainText("таймаут 2 с");
    const [timed, check] = await toolOutputs(request, chat.id);
    expect(timed).toBe("[таймаут 2 с, процесс остановлен]\n[подсказка: заведомо долгие команды запускай с timeout_sec до 900, а листенеры и интерактивные сессии — через job_start]\n(пустой вывод)");
    expect(check).toContain("NO-SLEEP");
    await expect.poll(() => termText(page, "agent")).toContain("[таймаут 2 с]");
  });

  test("код возврата 124/137 самой команды (timeout 1 …, kill -9) — это exit, а не таймаут инструмента", async ({ page, request }) => {
    await openTask(page, { task: ids.task, chat });
    // так советует описание инструмента («tcpdump без -c/timeout» → timeout 5 tcpdump …); kill -9 — как OOM-killer
    await send(page, tt([sh("timeout 1 sleep 5"), sh("bash -c 'kill -9 $$'")]));
    await waitIdle(page);
    const outs = await toolOutputs(request, chat.id);
    expect(outs.map((o) => o.split("\n")[0].replace(/, [\d.]+ с\]$/, "]")), JSON.stringify(outs)).toEqual(["[exit 124]", "[exit 137]"]);
    await expect(page.getByTestId("tool-block").first()).toContainText("exit 124");
  });

  test("неинтерактивность: stdin закрыт (cat/read не ждут), фоновый процесс не держит ход, фоновый сервер доступен в следующем вызове", async ({ page, request }) => {
    await openTask(page, { task: ids.task, chat });
    await send(page, tt(
      [
        sh('cat; read -r x; echo "stdin-eof:[$x] read-rc=$?"'),
        sh("sleep 120 & echo bg-started"), // stdout фонового sleep остаётся открытым
        sh("python3 -m http.server 8765 --bind 127.0.0.1 >/tmp/http.log 2>&1 & echo server-started"),
      ],
      [sh("for i in $(seq 1 50); do c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/); [ \"$c\" = 200 ] && break; sleep 0.2; done; echo http=$c; pgrep -fx 'sleep 120' >/dev/null && echo bg-alive")],
      [sh("pkill -fx 'sleep 120'; pkill -f '[h]ttp.server 8765'; echo cleaned")],
    ));
    await waitIdle(page);
    const [stdin, bg, srv, probe, clean] = await toolOutputs(request, chat.id);
    expect(stdin).toContain("stdin-eof:[] read-rc=1");
    expect(secsOf(stdin), stdin).toBeLessThan(5);
    expect(bg).toMatch(/^\[exit 0,/);
    expect(bg).toContain("bg-started");
    expect(secsOf(bg), "фоновый процесс не держит команду до таймаута").toBeLessThan(10);
    expect(srv).toContain("server-started");
    expect(probe).toContain("http=200");
    expect(probe).toContain("bg-alive");
    expect(clean).toContain("cleaned");
    for (let i = 0; i < 5; i++) await expect(page.getByTestId("tool-block").nth(i)).toHaveAttribute("data-status", "ok");
  });

  test("вывод инструмента: ANSI-цвета и OSC вырезаны, бинарные байты не ломают ход, в терминале агента цвет остаётся", async ({ page, request }) => {
    await openTask(page, { task: ids.task, chat });
    await send(page, tt([
      sh("printf '\\033[1;31mRED-ALERT\\033[0m plain\\n'; printf '\\033]0;window-title\\007after-osc\\n'; ls --color=always -d /etc /usr"),
      sh("printf 'A\\xff\\xfeB\\x80C\\n'; head -c 4 /bin/ls | od -An -c"),
    ]));
    await waitIdle(page);
    const [ansi, bin] = await toolOutputs(request, chat.id);
    expect(ansi, JSON.stringify(ansi)).not.toMatch(/[\x1b\x07]/);
    expect(ansi).toContain("RED-ALERT plain");
    expect(ansi).toContain("after-osc");
    expect(ansi).not.toContain("window-title");
    expect(ansi).toMatch(/\/etc\n\/usr/);
    // невалидный UTF-8 → U+FFFD, а не обрыв/исключение
    expect(bin).toMatch(/^\[exit 0,/);
    expect(bin).toContain("A��B�C");
    expect(bin).toMatch(/177 +E +L +F/);
    const blocks = page.getByTestId("tool-block");
    await expect(blocks.nth(1)).toHaveAttribute("data-status", "ok");
    await blocks.nth(0).locator("summary").click();
    await expect(blocks.nth(0).getByTestId("tool-output")).toContainText("RED-ALERT plain");
    await expect(blocks.nth(0).getByTestId("tool-output")).not.toContainText("[1;31m");
    // а терминал агента — живой терминал: там цвет сохраняется
    const red = page.getByTestId("term-agent").locator(".xterm-rows span", { hasText: /^RED-ALERT$/ }).last();
    await expect(red).toBeVisible();
    expect(await red.evaluate((el) => getComputedStyle(el).color)).toMatch(/^rgb\((243|246), (94|111), (94|111)\)$/); // палитра xterm под HTB: red #f35e5e / brightRed #f66f6f
  });

  test("tput sgr0 (последовательность ESC ( B) не оставляет мусор в выводе для модели", async ({ page, request }) => {
    await openTask(page, { task: ids.task, chat });
    await send(page, tt([sh("tput setaf 2; echo green-text; tput sgr0; echo after-sgr0")]));
    await waitIdle(page);
    const [out] = await toolOutputs(request, chat.id);
    expect(out, JSON.stringify(out)).not.toContain("\x1b");
    const b = page.getByTestId("tool-block").first();
    await b.locator("summary").click();
    await expect(b.getByTestId("tool-output")).not.toContainText("(Bafter-sgr0");
  });

  test("кириллица в большом выводе не бьётся на границах кусков потока (инструмент агента и твой shell)", async ({ page, request }) => {
    test.setTimeout(90_000);
    let shellFrames = "";
    page.on("websocket", (ws) => {
      if (ws.url().includes("/ws/shell")) ws.on("framereceived", (f) => { if (typeof f.payload === "string") shellFrames += f.payload; });
    });
    await openTask(page, { task: ids.task, chat });
    await shellReady(page);
    await shellRun(page, "yes привет-мир | head -n 20000; echo FLOOD-$((5*5))");
    await expect.poll(() => shellFrames.includes("FLOOD-25"), { timeout: 30_000 }).toBe(true);
    // агент: 30000 строк по 20 байт → файл полного вывода; лишние строки — только «$ команда»
    await send(page, tt([sh("yes привет-мир | head -n 30000")], [sh("grep -vxc 'привет-мир' {{saved}}")]));
    await waitIdle(page, 60_000);
    const [, check] = await toolOutputs(request, chat.id);
    const broken = { shellReplacementChars: (shellFrames.match(/�/g) ?? []).length, savedFileForeignLines: check.split("\n")[1] };
    expect(broken).toEqual({ shellReplacementChars: 0, savedFileForeignLines: "1" });
  });

  test("терминал агента: heredoc с продолжением «> », несколько команд и коды возврата — и после перезагрузки в том же порядке", async ({ page, request }) => {
    await openTask(page, { task: ids.task, chat });
    await page.getByTestId("term-agent-max").click();
    await send(page, tt(
      [sh("echo replay-first-$((6*7))")],
      [sh("cat <<'EOF' > /work/replay.txt\nreplay-line-1 $HOME\nreplay-line-2\nEOF\nwc -l < /work/replay.txt; cat /work/replay.txt")],
      [sh("grep -q nothing-here /work/replay.txt")],
    ));
    await waitIdle(page);
    const [first, heredoc, miss] = await toolOutputs(request, chat.id);
    expect(first).toContain("replay-first-42");
    expect(heredoc).toContain("\n2\nreplay-line-1 $HOME\nreplay-line-2\n"); // 'EOF' в кавычках — без подстановки $HOME
    expect(miss).toMatch(/^\[exit 1,/);
    const blocks = page.getByTestId("tool-block");
    await expect(blocks).toHaveCount(3);
    await expect(blocks.nth(2)).toHaveAttribute("data-status", "error");
    await expect(blocks.nth(1)).toContainText("$ cat <<'EOF' > /work/replay.txt");
    const marks = [
      "$ echo replay-first-$((6*7))", "replay-first-42",
      "$ cat <<'EOF' > /work/replay.txt", "> replay-line-1 $HOME", "> replay-line-2", "> EOF", "> wc -l < /work/replay.txt",
      "$ grep -q nothing-here /work/replay.txt", "[exit 1]",
    ];
    await expect.poll(async () => inOrder(await termText(page, "agent"), marks)).toBe("ok");
    await page.reload();
    await expect(page.getByTestId("terminals")).toHaveAttribute("data-layout", "agent");
    await expect(page.getByTestId("term-agent")).toHaveAttribute("data-ws", "open");
    await expect.poll(async () => inOrder(await termText(page, "agent"), marks), { timeout: 15_000 }).toBe("ok");
  });

  test("subnet_calc: IPv6 /64 → /66, /31 и /32, VLSM не помещается, ошибки ввода", async ({ page, request }) => {
    await openTask(page, { task: ids.task, chat });
    await send(page, tt([
      call("subnet_calc", { address: "2001:db8:abcd:12::1/64", split_prefix: 66 }),
      call("subnet_calc", { address: "10.0.0.1/31" }),
      call("subnet_calc", { address: "192.168.5.77/32" }),
      call("subnet_calc", { address: "192.168.1.0/24", vlsm_hosts: [60, 100, 2, 60] }),
      call("subnet_calc", { address: "300.1.1.1/24" }),
      call("subnet_calc", { address: "10.0.0.0/33" }),
      call("subnet_calc", { address: "10.0.0.0 255.0.255.0" }),
    ]));
    await waitIdle(page);
    const blocks = page.getByTestId("tool-block");
    await expect(blocks).toHaveCount(7);
    await expect(blocks.nth(0)).toContainText("2001:db8:abcd:12::1/64 → /66");
    await expect(blocks.nth(3)).toContainText("VLSM [60,100,2,60]");
    const [v6, p31, p32, vlsm, bad1, bad2, bad3] = await toolOutputs(request, chat.id);
    expect(v6).toContain("сеть:      2001:db8:abcd:12::/64");
    expect(v6).toContain("адресов:   2^64 = 18446744073709551616");
    expect(v6).toContain("разбиение на /66: 4 подсетей");
    expect(v6.split("\n").filter((l) => l.startsWith("  #"))).toEqual([
      "  #1 2001:db8:abcd:12::/66", "  #2 2001:db8:abcd:12:4000::/66", "  #3 2001:db8:abcd:12:8000::/66", "  #4 2001:db8:abcd:12:c000::/66",
    ]);
    expect(p31).toContain("broadcast:    нет (/31, /32)");
    expect(p31).toContain("хосты:        10.0.0.0 – 10.0.0.1");
    expect(p31).toContain("адресов:      2, из них под хосты: 2 (point-to-point, RFC 3021)");
    expect(p32).toContain("хосты:        192.168.5.77 – 192.168.5.77");
    expect(p32).toContain("адресов:      1, из них под хосты: 1");
    expect(p32).not.toContain("нельзя"); // /32 — адрес хоста, а не «адрес сети»
    // VLSM: размещение от большего к меньшему, номера сетей — как у пользователя
    expect(vlsm).toContain("сеть #2: нужно 100 → 192.168.1.0/25");
    expect(vlsm).toContain("сеть #1: нужно 60 → 192.168.1.128/26");
    expect(vlsm).toContain("сеть #4: нужно 60 → 192.168.1.192/26");
    expect(vlsm).toContain("сеть #3 (2 хостов): НЕ ПОМЕЩАЕТСЯ — адреса блока закончились");
    expect(vlsm).not.toContain("свободно после распределения");
    expect(bad1).toBe("ошибка: не IPv4: 300.1.1.1");
    expect(bad2).toBe("ошибка: префикс IPv4 должен быть 0..32");
    expect(bad3).toBe("ошибка: маска не непрерывная: 255.0.255.0");
  });

  test("subnet_calc: некорректный IPv6 («::» при восьми и более группах) отклоняется понятной ошибкой", async ({ page, request }) => {
    await openTask(page, { task: ids.task, chat });
    await send(page, tt([call("subnet_calc", { address: "1:2:3:4:5:6:7::8/64" }), call("subnet_calc", { address: "1:2:3:4:5:6::7:8:9" })]));
    await waitIdle(page);
    const outs = await toolOutputs(request, chat.id);
    expect(outs.map((o) => /^ошибка: не IPv6/.test(o)), JSON.stringify(outs.map((o) => o.split("\n")[0]))).toEqual([true, true]);
  });

  test("read_rfc: раздел, поиск по тексту, нет раздела, нет такого RFC, оглавление (нужен интернет)", async ({ page, request }) => {
    const online = await fetch("https://www.rfc-editor.org/rfc/rfc791.txt", { method: "HEAD", signal: AbortSignal.timeout(8000) }).then((r) => r.ok).catch(() => false);
    test.skip(!online, "нет доступа к rfc-editor.org");
    await openTask(page, { task: ids.task, chat });
    await send(page, tt([
      call("read_rfc", { number: 791, section: "3.1" }),
      call("read_rfc", { number: 791, grep: "Time to Live" }),
      call("read_rfc", { number: 791, section: "9.9" }),
      call("read_rfc", { number: 99999 }),
      call("read_rfc", { number: 791 }),
    ]));
    await waitIdle(page, 60_000);
    const blocks = page.getByTestId("tool-block");
    await expect(blocks).toHaveCount(5);
    await expect(blocks.nth(0)).toHaveAttribute("data-tool", "read_rfc");
    await expect(blocks.nth(0)).toContainText("RFC 791 §3.1");
    await expect(blocks.nth(1)).toContainText("RFC 791 · «Time to Live»");
    const [sec, grep, nosec, nofile, toc] = await toolOutputs(request, chat.id);
    expect(sec.startsWith("3.1.  Internet Header Format"), sec.slice(0, 60)).toBe(true);
    expect(sec).toContain("|  Time to Live |    Protocol   |");
    expect(sec).not.toMatch(/^3\.2\.\s/m); // раздел кончается перед 3.2
    expect(grep).toMatch(/^\d+: /);
    expect(grep.match(/time to live/gi)!.length).toBeGreaterThan(3);
    expect(nosec).toBe("раздел 9.9 не найден; вызови без section, чтобы увидеть оглавление");
    expect(nofile).toBe("RFC 99999 не найден (404)");
    expect(toc).toMatch(/TABLE OF CONTENTS/i);
    expect(toc).toContain("INTERNET PROTOCOL");
  });

  test("твой shell: stty size совпадает с xterm (строки и ширина), после разворачивания размер обновляется", async ({ page }) => {
    await openTask(page, { task: ids.task, chat });
    await shellReady(page);
    const rows = () => page.getByTestId("term-shell").locator(".xterm-rows > div").count();
    const r1 = await rows();
    const [R1, C1] = await sttySize(page);
    expect(R1, "строк в pty = строк в xterm").toBe(r1);
    // ширина: $COLUMNS+1 символов переносятся ровно после $COLUMNS-го
    await shellRun(page, "printf 'Q%.0s' $(seq 0 $(tput cols)); echo");
    await expect.poll(async () => {
      const lines = (await termText(page, "shell")).split("\n").map((l) => l.trimEnd());
      const i = lines.lastIndexOf("Q".repeat(C1));
      return i >= 0 && lines[i + 1] === "Q";
    }, { message: `строка из ${C1} Q помещается ровно в одну строку xterm` }).toBe(true);
    // развернуть shell — xterm подгоняется, новый размер доходит до pty
    await page.getByTestId("term-shell-max").click();
    await expect.poll(rows).toBeGreaterThan(r1 + 5);
    const r2 = await rows();
    await expect.poll(async () => (await sttySize(page))[0], { timeout: 30_000 }).toBe(r2);
  });

  test("твой shell: Ctrl+C прерывает долгую команду, юникод вводится и выводится без искажений", async ({ page }) => {
    await openTask(page, { task: ids.task, chat });
    await shellReady(page);
    await shellRun(page, "sleep 297; echo AFTER-$((6*7))");
    await expect.poll(() => dexec(ids.task.id, "pgrep -fx 'sleep 297' || true").trim(), { timeout: 10_000 }).not.toBe("");
    await page.keyboard.press("Control+C");
    await expect.poll(() => dexec(ids.task.id, "pgrep -fx 'sleep 297' || true").trim(), { timeout: 10_000 }).toBe("");
    await shellRun(page, "echo ctrlc-ok-$((2*21))");
    await expect.poll(() => termText(page, "shell")).toContain("ctrlc-ok-42");
    const t = await termText(page, "shell");
    expect(t).toContain("^C");
    expect(t, "список после ^C не продолжился").not.toContain("AFTER-42");
    // юникод: ввод через xterm → UTF-8 в контейнере (wc -m считает символы) → вывод обратно
    await shellRun(page, "printf '%s' 'Привет✓日本' | wc -m; echo 'Юникод — ок ✓' | rev");
    await expect.poll(() => termText(page, "shell")).toContain("✓ ко — докинЮ");
    expect(await termText(page, "shell")).toMatch(/^9$/m);
  });

  test("жизненный цикл контейнера: стоп → shell закрыт → команда агента сама поднимает контейнер → переподключение → сброс при открытом shell", async ({ page, request }) => {
    test.setTimeout(150_000);
    const own = await createTask(request, "Жизненный цикл контейнера");
    await openTask(page, own);
    await shellReady(page);
    await shellRun(page, "echo keep-$((40+2)) > /work/life.txt; touch /root/sys-marker; echo prepared-$((1+1))");
    await expect.poll(() => termText(page, "shell")).toContain("prepared-2");

    // стоп: статус в шапке и строке состояния, shell закрывается с подсказкой
    await page.getByTestId("container-stop").click();
    await expect(page.getByTestId("toast").filter({ hasText: "контейнер остановлен" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("container-status")).toHaveAttribute("data-state", "stopped");
    await expect(page.getByTestId("status-container")).toContainText("остановлен");
    await expect(page.getByTestId("container-start")).toBeVisible();
    expect((await (await request.get(`/api/tasks/${own.task.id}/container`)).json()).status).toBe("stopped");
    await expect(page.getByTestId("term-shell")).toHaveAttribute("data-ws", "closed", { timeout: 15_000 });
    await expect.poll(() => termText(page, "shell")).toContain("сессия закрыта");

    // команда агента поднимает тот же контейнер (не новый: /root/sys-marker на месте)
    await send(page, tt([sh("cat /work/life.txt; test -e /root/sys-marker && echo same-container")]));
    await waitIdle(page);
    const [out] = await toolOutputs(request, own.chat.id);
    expect(out).toMatch(/^\[exit 0,/);
    expect(out).toContain("keep-42");
    expect(out).toContain("same-container");
    await expect(page.getByTestId("container-status")).toHaveAttribute("data-state", "running", { timeout: 15_000 });

    // переподключение shell
    await page.getByTestId("term-shell-reconnect").click();
    await shellReady(page);
    await shellRun(page, "echo back-$((3*3))");
    await expect.poll(() => termText(page, "shell")).toContain("back-9");

    // сброс при открытом shell: сессия закрывается, после переподключения — чистая система, /work и история на месте
    await page.getByTestId("container-reset").click();
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toast").filter({ hasText: "пересоздан" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("term-shell")).toHaveAttribute("data-ws", "closed", { timeout: 15_000 });
    await expect.poll(() => termText(page, "agent")).toContain("контейнер пересоздаётся");
    await page.getByTestId("term-shell-reconnect").click();
    await shellReady(page);
    await shellRun(page, "cat /work/life.txt; test -e /root/sys-marker && echo SYS-KEPT || echo SYS-GONE-$((2+2))");
    await expect.poll(() => termText(page, "shell")).toContain("SYS-GONE-4");
    expect(await termText(page, "shell")).toMatch(/^keep-42$/m);
    await expect.poll(async () => ((await (await request.get(`/api/tasks/${own.task.id}/history`)).json()) as { cmd: string }[]).map((h) => h.cmd))
      .toContain("echo back-$((3*3))");
  });
});
