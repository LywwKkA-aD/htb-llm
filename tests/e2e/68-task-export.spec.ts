import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, createTask, mockReset, openTask, send, waitIdle, type Ids } from "./helpers";

// Экспорт задачи .tar.gz: /work без служебного .whitehat (VPN-креды наружу не едут),
// report.md с планом/профилем и chats.md. Архив проверяется настоящим tar.
type Call = { name: string; args: Record<string, unknown> };
const sh = (command: string): Call => ({ name: "shell", args: { command } });
const tt = (...rounds: Call[][]) => `[[tt:${Buffer.from(JSON.stringify({ rounds })).toString("base64url")}]] [[nomem]]`;

test.describe("экспорт задачи", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "Экспорт задачи"); });
  test.beforeEach(async ({ request }) => { await mockReset(request); });

  test("архив: work-файл внутри, .whitehat снаружи, отчёт с профилем; кнопка в панели файлов", async ({ page, request }) => {
    test.setTimeout(240_000);
    const prof = await request.post(`/api/tasks/${ids.task.id}/profile`, {
      data: { kind: "fact", text: "Экспорт-маркер профиля: веб на 80, WordPress" },
    });
    expect(prof.ok(), await prof.text()).toBeTruthy();
    await openTask(page, ids);
    await send(page, tt([sh("mkdir -p /work/loot && echo WH-EXPORT-MARK > /work/loot/flag-note.txt && echo vpn-secret > /work/.whitehat/should-not-export.txt && echo seeded")]));
    await waitIdle(page);

    const r = await request.get(`/api/tasks/${ids.task.id}/export`);
    expect(r.ok(), await r.text().catch(() => "")).toBeTruthy();
    expect(r.headers()["content-type"]).toContain("gzip");
    const file = path.join(os.tmpdir(), `wh-export-${ids.task.id}.tar.gz`);
    fs.writeFileSync(file, await r.body());
    const list = execFileSync("tar", ["-tzf", file], { encoding: "utf8" });
    expect(list).toContain("work/loot/flag-note.txt");
    expect(list).toContain("report.md");
    expect(list).toContain("chats.md");
    expect(list).not.toContain(".whitehat");
    const report = execFileSync("tar", ["-xzf", file, "-O", "report.md"], { encoding: "utf8" });
    expect(report).toContain("Экспорт задачи");
    expect(report).toContain("Экспорт-маркер профиля");

    await openTask(page, ids, { tab: "files" });
    await expect(page.getByTestId("task-export")).toBeVisible();
  });
});
