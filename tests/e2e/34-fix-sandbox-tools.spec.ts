import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, createTask, mockReset, mockRequests, openTask, send, termText, waitIdle, type Ids } from "./helpers";

// Регрессии починок песочницы и инструментов (sandbox.ts, tools.ts, subnet.ts, bin/whitehat) против настоящего Kali:
// изоляция сети задач (B2), уборка вложенных timeout при «стоп»/таймауте (B1), OOM и пропавший контейнер,
// симлинк на месте файла полного вывода, \r-прогресс, полноэкранные программы в user_history, k у search_docs,
// read_rfc с разделами, понятные ошибки Docker и проверка id задачи в sandbox.
// Сценарии агента — директива [[tt:…]] плагина tests/mock-plugins/tools-terminals.mjs.

const ROOT = path.resolve(import.meta.dirname, "../..");
const DATA = path.resolve(process.env.E2E_DATA ?? "tests/.data");
type Call = { name: string; args: Record<string, unknown> };
const sh = (command: string, extra: Record<string, unknown> = {}): Call => ({ name: "shell", args: { command, ...extra } });
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

async function newChat(request: APIRequestContext, taskId: string) {
  return (await (await request.post(`/api/tasks/${taskId}/chats`)).json()) as { id: string };
}
async function toolOutputs(request: APIRequestContext, chatId: string): Promise<string[]> {
  const r = await (await request.get(`/api/chats/${chatId}/log`)).json();
  return r.log.filter((x: any) => x.kind === "tool_result").map((x: any) => String(x.data.output));
}
// ход через API: ответ — SSE до done
async function turn(request: APIRequestContext, chatId: string, text: string, timeout = 90_000) {
  const r = await request.post(`/api/chats/${chatId}/send`, { data: { text, effort: "off" }, timeout });
  expect(r.ok(), await r.text()).toBe(true);
  expect(await r.text()).toContain('"type":"done"');
  return toolOutputs(request, chatId);
}
const firstLine = (o: string) => o.split("\n")[0].replace(/, [\d.]+ с\]$/, "]");

// docker только на СВОИ контейнеры: метка whitehat.data = каталог данных этого прогона
function own(taskId: string) {
  const name = `whitehat-${taskId}`;
  const label = execFileSync("docker", ["inspect", "-f", '{{index .Config.Labels "whitehat.data"}}', name]).toString().trim();
  expect(label, "контейнер принадлежит этому прогону").toBe(DATA);
  return name;
}
const dexec = (taskId: string, cmd: string) => execFileSync("docker", ["exec", own(taskId), "bash", "-c", cmd]).toString();
const inspect = (name: string, fmt: string) => execFileSync("docker", ["inspect", "-f", fmt, name]).toString().trim();

async function shellReady(page: Page) {
  await expect(page.getByTestId("term-shell")).toHaveAttribute("data-ws", "open", { timeout: 20_000 });
  await expect.poll(() => termText(page, "shell"), { timeout: 20_000 }).toMatch(/root@task-\w+/);
}
async function shellRun(page: Page, cmd: string) {
  await page.getByTestId("term-shell").locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
}

test.describe("песочница и инструменты: регрессии починок", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Песочница: регрессии"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  // ---------- B1: вложенный timeout (своя группа процессов) не переживает таймаут и «стоп» ----------
  test("B1: таймаут инструмента добивает вложенный `timeout 60 sleep 61; echo x`", async ({ request }) => {
    const chat = await newChat(request, ids.task.id);
    const t0 = Date.now();
    const [timed, check] = await turn(request, chat.id, tt(
      [sh("timeout 60 sleep 61; echo x", { timeout_sec: 2 })],
      [sh("pgrep -fx 'sleep 61' >/dev/null && echo SLEEP-ORPHAN || echo NO-SLEEP; pgrep -fx 'timeout 60 sleep 61' >/dev/null && echo TIMEOUT-ORPHAN || echo NO-TIMEOUT")],
    ));
    expect(Date.now() - t0, "ход не ждёт 60 с вложенного timeout").toBeLessThan(30_000);
    expect(timed).toBe("[таймаут 2 с, процесс остановлен]\n[подсказка: заведомо долгие команды запускай с timeout_sec до 900, а листенеры и интерактивные сессии — через job_start]\n(пустой вывод)");
    expect(check).toContain("NO-SLEEP");
    expect(check).toContain("NO-TIMEOUT");
  });

  for (const [what, cmd, needle] of [
    ["конвейер `timeout 60 sleep 62 | cat` и фон `timeout 60 sleep 64 &`", "timeout 60 sleep 64 & timeout 60 sleep 62 | cat; echo never", "sleep 6[24]"],
    ["простая команда `timeout 60 sleep 63` (регрессия)", "timeout 60 sleep 63", "sleep 63"],
  ] as const) {
    test(`B1: «стоп» добивает ${what}`, async ({ request }) => {
      const chat = await newChat(request, ids.task.id);
      const live = request.post(`/api/chats/${chat.id}/send`, { data: { text: tt([sh(cmd)]), effort: "off" }, timeout: 60_000 });
      await expect.poll(() => dexec(ids.task.id, `pgrep -f '^(timeout 60 )?${needle}$' || true`).trim(), { timeout: 20_000 }).not.toBe("");
      await new Promise((r) => setTimeout(r, 500));
      const t0 = Date.now();
      expect((await request.post(`/api/chats/${chat.id}/stop`)).ok()).toBe(true);
      expect((await live).ok()).toBe(true);
      expect(Date.now() - t0, "ход остановился быстро").toBeLessThan(10_000);
      // сразу после конца хода в контейнере ничего не осталось (ни sleep, ни вложенного timeout)
      expect(dexec(ids.task.id, `pgrep -af '${needle}' | grep -v pgrep || echo NONE`).trim()).toBe("NONE");
      const [out] = await toolOutputs(request, chat.id);
      expect(out, out).toMatch(/^\[exit \d+, [\d.]+ с\]\n\[остановлено пользователем/);
    });
  }

  // ---------- TT-2 / gap 5: OOM и пропавший контейнер — отдельно от таймаута ----------
  test("exit 137 от OOM помечается как нехватка памяти, kill -9 — просто exit 137", async ({ request }) => {
    test.setTimeout(120_000);
    const t = await createTask(request, "OOM");
    try {
      // лимит памяти только СВОЕГО контейнера: 128 МБ без свопа — питон с 400 МБ убивает ядро
      execFileSync("docker", ["update", "--memory", "128m", "--memory-swap", "128m", own(t.task.id)], { stdio: "ignore" });
      const [oom, kill9, after] = await turn(request, t.chat.id, tt(
        [sh(`python3 -c "x = 'a' * (400 << 20); print('allocated')"`)],
        [sh("bash -c 'kill -9 $$'")],
        [sh("echo alive-$((6*7))")],
      ));
      expect(firstLine(oom), oom).toBe("[exit 137]");
      expect(oom).toMatch(/OOM: ядро убило процесс — не хватило памяти контейнера \(лимит 128 МБ\)/);
      expect(oom).not.toContain("таймаут");
      expect(oom).not.toContain("allocated");
      expect(firstLine(kill9)).toBe("[exit 137]");
      expect(kill9).not.toContain("OOM");
      expect(after).toContain("alive-42");
    } finally {
      await request.delete(`/api/tasks/${t.task.id}`);
    }
  });

  test("контейнер удалён во время команды: понятная пометка, следующая команда поднимает новый", async ({ request }) => {
    test.setTimeout(120_000);
    const t = await createTask(request, "Контейнер пропал");
    try {
      const name = own(t.task.id);
      const live = request.post(`/api/chats/${t.chat.id}/send`, {
        data: { text: tt([sh("sleep 25; echo never-printed")], [sh("echo back-$((2+3)); hostname")]), effort: "off" }, timeout: 90_000,
      });
      await expect.poll(() => dexec(t.task.id, "pgrep -fx 'sleep 25' || true").trim(), { timeout: 20_000 }).not.toBe("");
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      expect((await live).ok()).toBe(true);
      const [gone, back] = await toolOutputs(request, t.chat.id);
      expect(gone, gone).toMatch(/контейнер (удалён|остановлен или удалён) во время команды/);
      expect(gone).not.toContain("таймаут");
      expect(gone).not.toContain("never-printed");
      expect(back).toMatch(/^\[exit 0,/);
      expect(back).toContain("back-5");
    } finally {
      await request.delete(`/api/tasks/${t.task.id}`);
    }
  });

  // ---------- gap 1: симлинк на месте будущего файла полного вывода ----------
  test("симлинки с именами будущих out-файлов (из контейнера) не дают серверу писать на хост", async ({ request }) => {
    test.setTimeout(90_000);
    const canary = path.join(DATA, `canary-out-${Date.now()}.txt`);
    // root контейнера раскладывает симлинки на хостовый файл под все имена out-<время>.txt на ближайшие 40 с
    // (старая схема имён угадывалась по времени, а writeFileSync шёл по симлинку)
    const plant = `python3 - <<'PY'
import os, time, datetime
d = '/work/.whitehat'; os.makedirs(d, exist_ok=True)
now = int(time.time() * 1000)
for ms in range(now - 1000, now + 40000):
    t = datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc)
    n = t.strftime('%Y-%m-%dT%H-%M-%S-') + '%03dZ' % (ms % 1000)
    try: os.symlink(${JSON.stringify(canary)}, f'{d}/out-{n}.txt')
    except FileExistsError: pass
print('planted', len([x for x in os.listdir(d) if x.endswith('Z.txt')]))
PY`;
    expect(dexec(ids.task.id, plant)).toMatch(/planted \d{5}/);
    try {
      const chat = await newChat(request, ids.task.id);
      const [big, check] = await turn(request, chat.id, tt(
        [sh("seq 1 20000")],
        [sh("f={{saved}}; test -f \"$f\" && ! test -L \"$f\" && echo REGULAR-FILE; tail -n 1 \"$f\"")],
      ));
      expect(big).toMatch(/полный вывод: \/work\/\.whitehat\/out-[\w-]+\.txt/);
      expect(fs.existsSync(canary), "сервер не записал ничего по симлинку на хост").toBe(false);
      expect(check).toContain("REGULAR-FILE");
      expect(check.trimEnd().endsWith("\n20000"), check).toBe(true);
    } finally {
      dexec(ids.task.id, "find /work/.whitehat -maxdepth 1 -type l -delete");
      fs.rmSync(canary, { force: true });
    }
  });

  test("висячий симлинк вместо /work/.whitehat не ломает запуск контейнера и команды", async ({ request }) => {
    dexec(ids.task.id, "rm -rf /work/.whitehat && ln -s /nonexistent-wh/deep /work/.whitehat");
    try {
      expect((await request.post(`/api/tasks/${ids.task.id}/container/start`)).ok(), "ensure не падает на .whitehat").toBe(true);
      const chat = await newChat(request, ids.task.id);
      const [big] = await turn(request, chat.id, tt([sh("seq 1 5000")]));
      expect(big).toMatch(/^\[exit 0,/);
      expect(big).toContain("полный вывод не сохранён");
      expect(big.trimEnd().endsWith("\n4999\n5000")).toBe(true);
      expect(fs.existsSync("/nonexistent-wh")).toBe(false);
    } finally {
      dexec(ids.task.id, "rm -f /work/.whitehat; mkdir -p /work/.whitehat");
    }
  });

  // ---------- gap 9: \r-прогресс (curl/wget/apt) не раздувает вывод ----------
  test("прогресс через \\r схлопывается до итоговой строки, ESC[K и ESC ( B не попадают к модели", async ({ request }) => {
    const chat = await newChat(request, ids.task.id);
    const [out] = await turn(request, chat.id, tt([sh(
      "for i in $(seq 1 3000); do printf '\\rprogress %d%%' $i; done; echo; " +
      "printf 'dl  0%%\\rdl 50%%\\rdl 100%%\\n' >&2; printf '0%% [Working]\\033[K\\r\\033[Kdone-%d\\n' $((2+3)); tput sgr0; echo tail-ok",
    )]));
    expect(out).toMatch(/^\[exit 0, [\d.]+ с\]\n/);
    // stdout и stderr — разные потоки (порядок между ними не гарантирован), но каждая строка — итоговая
    expect(out.split("\n").slice(1).filter(Boolean).sort(), JSON.stringify(out)).toEqual(["dl 100%", "done-5", "progress 3000%", "tail-ok"]);
    expect(out).toContain("progress 3000%\n");
    expect(out).not.toMatch(/[\r\x1b]/);
  });

  // ---------- gap 10: полноэкранные программы в user_history ----------
  test("user_history: экран less/vim не превращается в кашу, видно команду и пометку", async ({ page, request }) => {
    const chat = await newChat(request, ids.task.id);
    await openTask(page, { task: ids.task, chat });
    await shellReady(page);
    await shellRun(page, "less /etc/services");
    await expect.poll(() => termText(page, "shell"), { timeout: 15_000 }).toContain("tcpmux");
    await page.keyboard.press("q");
    await shellRun(page, "echo AFTER-LESS-$((3*3))");
    await expect.poll(() => termText(page, "shell")).toContain("AFTER-LESS-9");
    await shellRun(page, "vim -u NONE /etc/hostname");
    await expect.poll(() => termText(page, "shell"), { timeout: 15_000 }).toMatch(/~\s*\n/);
    try {
      await send(page, tt([call("user_history", {})]));
      await waitIdle(page);
      const [out] = await toolOutputs(request, chat.id);
      const screen = out.slice(out.indexOf("ЭКРАН ТЕРМИНАЛА"));
      expect(screen).toContain("less /etc/services");
      expect(screen).toContain("[полноэкранная программа (vim/less/htop/man…) — её экран не записывается]");
      expect(screen).toContain("AFTER-LESS-9");
      expect(screen, "содержимое /etc/services с экрана less не попало к модели").not.toContain("tcpmux");
      expect(screen).toContain("vim -u NONE /etc/hostname");
      expect(screen.trimEnd().endsWith("[сейчас открыта полноэкранная программа (vim/less/htop/man…) — её экран не записывается]"), screen.slice(-300)).toBe(true);
      expect(screen).not.toMatch(/[\x1b\r]/);
    } finally {
      await page.getByTestId("term-shell").locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Escape");
      await page.keyboard.type(":q!");
      await page.keyboard.press("Enter");
    }
  });

  // ---------- gap 13: k у search_docs ----------
  test("search_docs: k отрицательный, огромный, строкой — 5/10/3 фрагментов, а не весь индекс", async ({ request }) => {
    const word = `kclamp${Date.now().toString(36)}`;
    const md = Array.from({ length: 30 }, (_, i) => `## Раздел ${i + 1}\n\nФрагмент ${i + 1}: ${word} — проверка числа фрагментов в ответе.\n`).join("\n");
    const fd = new FormData();
    fd.append("files", new File([md], `k-clamp ${word}.md`, { type: "text/markdown" }));
    fd.append("task", ids.task.id);
    const up = await request.post("/api/docs", { multipart: fd });
    expect(up.ok(), await up.text()).toBe(true);
    const [doc] = (await up.json()) as { id: number }[];
    try {
      await expect.poll(async () => ((await (await request.get(`/api/docs?task=${ids.task.id}`)).json()) as any[]).find((d) => d.id === doc.id)?.status, { timeout: 30_000 }).toBe("ready");
      const chat = await newChat(request, ids.task.id);
      const outs = await turn(request, chat.id, tt([
        call("search_docs", { query: word, scope: "task", k: -5 }),
        call("search_docs", { query: word, scope: "task", k: 100000 }),
        call("search_docs", { query: word, scope: "task", k: 3 }),
        call("search_docs", { query: word, scope: "task", k: "много" }),
      ]));
      expect(outs.map((o) => o.split("\n\n---\n\n").length)).toEqual([5, 10, 3, 5]);
    } finally {
      await request.delete(`/api/docs/${doc.id}`);
    }
  });

  // ---------- model quality #8: read_rfc grep с разделом и целым абзацем ----------
  test("read_rfc grep: номер и название раздела, абзац целиком, колонтитулы страниц вырезаны", async ({ request }) => {
    // RFC в кэше (DATA/rfc) — без интернета; разметка как у старых постраничных RFC (RFC 791)
    const pad = (s: string) => s.padStart(72);
    const rfc = [
      "Network Working Group", "Request for Comments: 99001", "", "                    TEST PROTOCOL", "",
      "Table of Contents", "", "   1.  Introduction ........................................ 1", "", "",
      "1.  INTRODUCTION", "", "  The test protocol exists to check section attribution.", "", "",
      pad("[Page 1]"), "\f", pad("September 1981"), "Test Protocol", "Introduction", "", "",
      "2.  SPECIFICATION", "", "2.1.  Timers", "",
      "  The linger state lasts for twice the maximum segment lifetime so",
      "  that delayed duplicates of the old connection die out before the",
      "  needle phrase is reused by a new connection.  Implementations MUST",
      "  respect this rule.", "", "  Another paragraph without the word.", "", "",
      pad("[Page 2]"), "\f", pad("September 1981"), "Test Protocol", "Specification", "", "",
      "2.2.  Counters", "",
      "  Counters wrap around; the needle phrase appears here as well,", "  in a different section.", "",
    ].join("\n");
    fs.writeFileSync(path.join(DATA, "rfc", "rfc99001.txt"), rfc);
    const chat = await newChat(request, ids.task.id);
    const [out] = await turn(request, chat.id, tt([call("read_rfc", { number: 99001, grep: "needle phrase" })]));
    const [first, second] = out.split("\n\n");
    expect(first).toMatch(/^\d+: раздел 2\.1 «Timers»\n/);
    // абзац целиком: от начала предложения до его конца, а не ±2 строки
    expect(first).toContain("  The linger state lasts for twice the maximum segment lifetime so");
    expect(first).toContain("  respect this rule.");
    expect(first).not.toContain("Another paragraph");
    expect(second).toMatch(/^\d+: раздел 2\.2 «Counters»\n  Counters wrap around; the needle phrase appears here as well,\n  in a different section\.$/);
    expect(out).not.toContain("September 1981");
    expect(out).not.toContain("[Page");
    // описание инструмента учит цитировать целыми предложениями и брать номер раздела из вывода
    const req = (await mockRequests(request)).filter((r) => r.kind === "agent").at(-1)!;
    const desc = req.body.tools.find((t: any) => t.function.name === "read_rfc").function.description as string;
    expect(desc).toContain("предложения целиком");
    expect(desc).toContain("номер раздела бери из вывода инструмента");
  });

  // ---------- B2: изоляция сети задач ----------
  test("B2: контейнеры задач в сети whitehat-sbx без связи друг с другом, интернет работает", async ({ request }) => {
    test.setTimeout(120_000);
    const b = await createTask(request, "Сосед по сети");
    try {
      const A = own(ids.task.id), B = own(b.task.id);
      for (const n of [A, B]) expect(Object.keys(JSON.parse(inspect(n, "{{json .NetworkSettings.Networks}}"))), n).toEqual(["whitehat-sbx"]);
      const net = JSON.parse(execFileSync("docker", ["network", "inspect", "whitehat-sbx", "-f", "{{json .Options}}"]).toString());
      expect(net).toMatchObject({ "com.docker.network.bridge.name": "wh0", "com.docker.network.bridge.enable_icc": "false" });
      const ipB = inspect(B, '{{(index .NetworkSettings.Networks "whitehat-sbx").IPAddress}}');
      expect(ipB).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      dexec(b.task.id, "nohup python3 -m http.server 8099 --bind 0.0.0.0 >/dev/null 2>&1 & sleep 0.1; echo started");
      // сам B свой сервер видит
      await expect.poll(() => dexec(b.task.id, "curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/ || true"), { timeout: 15_000 }).toBe("200");
      const online = await fetch("https://example.org", { method: "HEAD", signal: AbortSignal.timeout(8000) }).then((r) => r.ok).catch(() => false);
      const chat = await newChat(request, ids.task.id);
      const [probe] = await turn(request, chat.id, tt([sh(
        `ping -c1 -W1 ${ipB} >/dev/null 2>&1; echo ping=$?; ` +
        `echo "tcp=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://${ipB}:8099/)"; ` +
        (online ? "echo \"inet=$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://example.org)\"" : "echo inet=skipped"),
      )]));
      expect(probe).toContain("ping=1");
      expect(probe).toContain("tcp=000");
      if (online) expect(probe, "интернет из песочницы работает").toContain("inet=200");
    } finally {
      await request.delete(`/api/tasks/${b.task.id}`);
    }
  });

  test("B2: старый контейнер на docker0 переводится в whitehat-sbx без пересоздания", async ({ request }) => {
    const t = await createTask(request, "Миграция сети");
    try {
      const n = own(t.task.id);
      dexec(t.task.id, "echo migrate-marker > /root/marker");
      execFileSync("docker", ["network", "connect", "bridge", n]);
      execFileSync("docker", ["network", "disconnect", "whitehat-sbx", n]);
      expect(Object.keys(JSON.parse(inspect(n, "{{json .NetworkSettings.Networks}}")))).toEqual(["bridge"]);
      expect((await request.post(`/api/tasks/${t.task.id}/container/start`)).ok()).toBe(true);
      expect(Object.keys(JSON.parse(inspect(n, "{{json .NetworkSettings.Networks}}")))).toEqual(["whitehat-sbx"]);
      expect(dexec(t.task.id, "cat /root/marker").trim(), "система контейнера сохранилась").toBe("migrate-marker");
    } finally {
      await request.delete(`/api/tasks/${t.task.id}`);
    }
  });

  test("B2: сервисы хоста (0.0.0.0) недоступны из песочницы — если установлен `whitehat firewall`", async ({ request }) => {
    const fw = spawnSync("bash", [path.join(ROOT, "bin/whitehat"), "firewall", "status"], { encoding: "utf8" });
    test.skip(fw.status !== 0, "правила не установлены (sudo bin/whitehat firewall install) — проверка хоста пропущена");
    const srv = http.createServer((_q, s) => s.end("host-service"));
    await new Promise<void>((r) => srv.listen(0, "0.0.0.0", () => r()));
    const port = (srv.address() as any).port as number;
    try {
      const gw = execFileSync("docker", ["network", "inspect", "whitehat-sbx", "-f", "{{(index .IPAM.Config 0).Gateway}}"]).toString().trim();
      expect(gw).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      const chat = await newChat(request, ids.task.id);
      const [probe] = await turn(request, chat.id, tt([sh(`echo "host=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://${gw}:${port}/)"`)]));
      expect(probe).toContain("host=000");
    } finally {
      srv.close();
    }
  });

  // ---------- gap 5 + SEC-3: понятные ошибки Docker и проверка id в sandbox (отдельный процесс) ----------
  test("нет Docker / нет образа — понятные сообщения; «../x» как id задачи отвергается в sandbox", async () => {
    test.setTimeout(90_000);
    const dir = path.join(DATA, `child-${Date.now().toString(36)}`);
    // canary — то, куда указывает data/tasks/../canary
    fs.mkdirSync(path.join(dir, "data", "canary"), { recursive: true });
    const script = path.join(dir, "probe.mts");
    const id = `zz${Date.now().toString(36).slice(-8).padStart(8, "0")}`.slice(0, 10);
    fs.writeFileSync(script, `
import * as sandbox from ${JSON.stringify(path.join(ROOT, "src/server/sandbox.ts"))};
import { runTool } from ${JSON.stringify(path.join(ROOT, "src/server/tools.ts"))};
const out: Record<string, string> = {};
const ctx = { taskId: ${JSON.stringify(id)}, emit: () => {} };
out.shell = await runTool("shell", JSON.stringify({ command: "echo hi" }), ctx);
try { await sandbox.ensure(${JSON.stringify(id)}); out.ensure = "ok"; } catch (e) { out.ensure = (e as Error).message; }
for (const bad of ["../canary", "..", "a/b", "ABCDEFGHIJ"]) {
  try { await sandbox.destroy(bad); out["destroy " + bad] = "ok"; } catch (e) { out["destroy " + bad] = (e as Error).message; }
  try { await sandbox.ensure(bad); out["ensure " + bad] = "ok"; } catch (e) { out["ensure " + bad] = (e as Error).message; }
  out["status " + bad] = await sandbox.status(bad);
}
console.log(JSON.stringify(out));
process.exit(0);
`);
    const run = (env: Record<string, string>) => {
      const r = spawnSync("node", ["--import", "tsx", script], {
        cwd: ROOT, encoding: "utf8", timeout: 60_000,
        env: { ...process.env, WH_DATA: path.join(dir, "data"), WH_LLM_URL: "http://127.0.0.1:9/v1", WH_EMBED_URL: "http://127.0.0.1:9/v1", ...env },
      });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Record<string, string>;
    };
    try {
      const down = run({ WH_DOCKER_SOCKET: `/tmp/wh-e2e-no-docker-${process.pid}.sock` }); // короткий путь: у unix-сокета лимит 108 байт
      expect(down.shell).toMatch(/^ошибка инструмента shell: Docker недоступен \(\/tmp\/wh-e2e-no-docker-\d+\.sock: ENOENT\) — запусти службу: sudo systemctl start docker$/);
      expect(down.ensure).toMatch(/^Docker недоступен/);

      const noimg = run({ WH_IMAGE: "whitehat-kali:missing-e2e" });
      expect(noimg.shell).toBe("ошибка инструмента shell: нет образа песочницы whitehat-kali:missing-e2e — собери его: docker build -t whitehat-kali:missing-e2e docker/kali (bin/htb-llm start делает это сам)");
      expect(execFileSync("docker", ["ps", "-aq", "--filter", `name=^whitehat-${id}$`]).toString().trim(), "контейнер-полуфабрикат не остался").toBe("");

      for (const bad of ["../canary", "..", "a/b", "ABCDEFGHIJ"]) {
        expect(noimg[`destroy ${bad}`], bad).toMatch(/^недопустимый id задачи/);
        expect(noimg[`ensure ${bad}`], bad).toMatch(/^недопустимый id задачи/);
        expect(noimg[`status ${bad}`], bad).toBe("missing");
      }
      expect(fs.existsSync(path.join(dir, "data", "canary")), "destroy('../canary') ничего не удалил").toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
