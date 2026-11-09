import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect, mockReset } from "./helpers";

// Смена IP машины (респаун HTB-инстанса / вернулся завтра и запустил новую): новый адрес сам
// разлетается по потребителям — БД, /etc/hosts живого контейнера, TASK.md и карточки профиля
// со старым IP в host; карточки с hostname не трогаются (hosts их и так ведёт на новый IP).
const DATA = path.resolve(process.env.E2E_DATA ?? "tests/.data");

function dexec(taskId: string, script: string) {
  const name = `whitehat-${taskId}`;
  const label = execFileSync("docker", ["inspect", "-f", '{{index .Config.Labels "whitehat.data"}}', name]).toString().trim();
  expect(label, "контейнер принадлежит этому тестовому прогону").toBe(DATA);
  return execFileSync("docker", ["exec", name, "bash", "-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function ensureViaJob(request: any, taskId: string, name: string) {
  const r = await request.post(`/api/tasks/${taskId}/jobs`, { data: { name, command: "sleep 600" } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).id as string;
}

test.describe("смена IP цели распространяется везде", () => {
  test("ручная правка target: hosts контейнера, TASK.md и профиль обновляются сразу", async ({ request }) => {
    test.setTimeout(180_000);
    const created = await (await request.post("/api/tasks", {
      data: { title: "Смена IP вручную", target: "10.10.10.10", hostname: "probe.htb", brief: "IP: 10.10.10.10" },
    })).json();
    const taskId = created.task?.id ?? created.id;
    const jobId = await ensureViaJob(request, taskId, "ensure-manual");
    try {
      await expect.poll(() => dexec(taskId, "getent hosts probe.htb || true"), { timeout: 20_000 }).toContain("10.10.10.10");
      const svc = await request.post(`/api/tasks/${taskId}/profile`, { data: { kind: "service", host: "10.10.10.10", port: 80, proto: "tcp", service: "http" } });
      expect(svc.ok(), await svc.text()).toBeTruthy();
      const byName = await request.post(`/api/tasks/${taskId}/profile`, { data: { kind: "service", host: "probe.htb", port: 443, proto: "tcp", service: "https" } });
      expect(byName.ok(), await byName.text()).toBeTruthy();

      const upd = await request.patch(`/api/tasks/${taskId}`, { data: { target: "10.10.10.99" } });
      expect(upd.ok(), await upd.text()).toBeTruthy();
      expect((await upd.json()).target).toBe("10.10.10.99");

      await expect.poll(() => dexec(taskId, "getent hosts probe.htb || true"), { timeout: 20_000 }).toContain("10.10.10.99");
      const taskMd = dexec(taskId, "cat /work/TASK.md");
      expect(taskMd).toContain("- TARGET: 10.10.10.99");
      const items = (await (await request.get(`/api/tasks/${taskId}/profile`)).json()).items as any[];
      expect(items.find((i) => i.port === 80)?.host).toBe("10.10.10.99"); // host=старый IP переписан
      expect(items.find((i) => i.port === 443)?.host).toBe("probe.htb"); // hostname-карточка не тронута
    } finally {
      await request.post(`/api/tasks/${taskId}/jobs/${jobId}/stop`).catch(() => {});
    }
  });

  test("HTB-респаун: новый IP активного инстанса сам обновляет задачу и hosts", async ({ request }) => {
    test.setTimeout(240_000);
    await mockReset(request);
    await request.delete("/api/htb/token").catch(() => {});
    const tok = await request.post("/api/htb/token", { data: { token: "test-htb-token-0123456789" } });
    expect(tok.ok(), await tok.text()).toBeTruthy();
    let taskId = "";
    let jobId = "";
    const readTask = async () => ((await (await request.get("/api/tasks")).json()) as any[]).find((x) => x.id === taskId);
    try {
      const imp = await (await request.post("/api/htb/import", { data: {} })).json();
      taskId = imp.task?.id ?? imp.id;
      // в общем прогоне задача MockBox могла остаться от спеки HTB с уже синкнутым другим IP:
      // статус-синк приводит target к текущему активному инстансу мока (.245.100 после reset)
      await request.get("/api/htb/status?refresh=1");
      expect((await readTask())?.target).toBe("10.129.245.100");
      jobId = await ensureViaJob(request, taskId, "ensure-htb");
      await expect.poll(() => dexec(taskId, "getent hosts mockbox.htb || true"), { timeout: 20_000 }).toContain("10.129.245.100");

      // респаун: тот же инстанс, новый IP у HTB
      await request.post("/api/htb/stop");
      const spawned = await (await request.post("/api/htb/spawn", { data: { machineId: 777 } })).json();
      expect(spawned.activeMachine?.ip).toBe("10.129.9.10");
      await request.get("/api/htb/status?refresh=1");

      expect((await readTask())?.target).toBe("10.129.9.10");
      await expect.poll(() => dexec(taskId, "getent hosts mockbox.htb || true"), { timeout: 20_000 }).toContain("10.129.9.10");
      expect(dexec(taskId, "cat /work/TASK.md")).toContain("- TARGET: 10.129.9.10");
    } finally {
      if (jobId) await request.post(`/api/tasks/${taskId}/jobs/${jobId}/stop`).catch(() => {});
      await request.post("/api/htb/stop").catch(() => {});
      await request.delete("/api/htb/token").catch(() => {});
    }
  });
});
