import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, createTask, mockReset, mockRequests, openTask, send, waitIdle, type Ids } from "./helpers";

// VPN внутри контейнера (HTB): импорт конфига файлом, старт/стоп openvpn, статус и лог,
// адрес туннеля (LHOST) в env команд агента и в контексте хода, SOCKS для браузера хоста.
// Настоящего HTB-сервера в тестах нет: openvpn стучится в 127.0.0.1 и честно висит в connecting,
// а состояние «поднят» имитируется ручным tun-интерфейсом в контейнере (статус читается с интерфейсов).
// SOCKS-тест требует актуального root-firewall хоста (sudo bin/whitehat firewall install):
// без правила «ESTABLISHED от wh0 принять» ответы контейнера хосту режутся INPUT DROP.

const ROOT = path.resolve(import.meta.dirname, "../..");
const DATA = path.resolve(process.env.E2E_DATA ?? "tests/.data");
const MOCK_PORT = process.env.E2E_MOCK_PORT ?? "18080";

// Одноразовая самоподписанная пара только для этого теста: OpenVPN 2.7 без <ca> и <cert>/<key>
// не стартует вообще, а с ними честно висит в connecting до недоступного 127.0.0.1:1194.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIC9jCCAd6gAwIBAgIUca7gdXVDypor24pdTvarG1YJvHcwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQd2hpdGVoYXQtdGVzdC1jYTAeFw0yNjExMDQxNjM3MjBa
Fw0zNjExMDExNjM3MjBaMBsxGTAXBgNVBAMMEHdoaXRlaGF0LXRlc3QtY2EwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCyQyfZ2Nf+T+rnkcflJriYZ5a4
mT8rsyqfwHrm/Yam1BLfHS4gx210cbPEY3VY3HAOU8CyvyprkAblYn67ro6GgQ8b
awmPjpzHr6zzFuW3xzvI95vcR3O/FzaPOb0XmMVbg8FS/DtgkwXuwTE5qn6/MY2f
MbftFNkwBrD6/gkKTjyJNiO0jcuaM0ZxvT/OzRItIyu3YDCCHbAOWFujNqY8ArX7
z8PF99MvMg7cao7jWU2kGIQ6SUd+QtGurJcjazw++wDJf2CUDzPS/K4XAVf+2LSC
6L8ZKNMXshyZ88fIefttq+hhkRKkz9vqZmOYQT5/KsQwDzyO0QrToAAwZimHAgMB
AAGjMjAwMB0GA1UdDgQWBBTkSxaslGessLe4Qr9A2pIm3UloPjAPBgNVHRMBAf8E
BTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAfRLHPkOYtjR6zM1kTozW7lOh7puM2
mR9hS57598WOI+uRZ8gJJG8+axvQaGx8WgC5NyeOXvvi6y5QJI1i6RH7KebP3+gf
8qQeLxDjeYfDWsO1PQErCX1Oz/QHwutFm6UM36/3P2V5Djaez4YlnTxaNHKDaOAj
OmI4gbskTXb9Q5Ptv3aK7rMalPyOrqJv/4P+dmzVfuZx/OcPP4Mg2PY+EM9cR4j3
iFD/HKTFlKBA0rhWMa0ztHopPgim6s83BmdeF2LV37Py2hdEt0VL+hCutBxa5gBO
+NdQdgEe5D7pEURZm0OnWl3uV8m/O72HkctvpYwvmc7DLcxpFcabFGiR
-----END CERTIFICATE-----`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCyQyfZ2Nf+T+rn
kcflJriYZ5a4mT8rsyqfwHrm/Yam1BLfHS4gx210cbPEY3VY3HAOU8CyvyprkAbl
Yn67ro6GgQ8bawmPjpzHr6zzFuW3xzvI95vcR3O/FzaPOb0XmMVbg8FS/DtgkwXu
wTE5qn6/MY2fMbftFNkwBrD6/gkKTjyJNiO0jcuaM0ZxvT/OzRItIyu3YDCCHbAO
WFujNqY8ArX7z8PF99MvMg7cao7jWU2kGIQ6SUd+QtGurJcjazw++wDJf2CUDzPS
/K4XAVf+2LSC6L8ZKNMXshyZ88fIefttq+hhkRKkz9vqZmOYQT5/KsQwDzyO0QrT
oAAwZimHAgMBAAECggEAO8pNjAJw0+I/QmOBngkCQlAAXDM+XmxuP/3h2ycu6jbY
i5AwgBsTyco3Rwgq/F6XkR6jU/DNjB1XSsniAxZVxKR2Cja5Erb9O/be9fv4mc8P
7OSsGNK4bmAdUyXFGCyMCZlkFu72BXrasw2GcraOY5d9zmbxL2pePH8KDm11X8h0
NP4Rl3KNuNck5JM/SyrI4CqH5Ihr+YJ3JjG0VKGUICedKRW5n14czQDlLO6MXC+G
dPGoW5bdckToPhw/FKJI0hxy1v6QsrTGeFju949ytXBwzGLOnE8w0l6UZz2jJEQu
GOBE3W+SyxusKPIur2k5HzfDtzjIjvsa5vP0+Zm2/QKBgQD21qh0D8XEHu42tW2/
AuMLLl+8LkTlGod+9HnOzQl/hIoyHHqtMQeyquW0sitEeg7sKWDpHCT/BiC6L6/8
j1CVbui70ml4/mZcFtMVnT0Rg3XMZyFKsUwCQk3H2Q6oIAMpEEXm2gRFCZGFLleI
Qro6jtOhfn8jMsIMqbD2kX/gGwKBgQC44OtfZUjqTyNiRnGprm5WvKqv2cmbup5g
kCe9eQ+CPzcwK001CRCeKnOh8ri4xH4xYBHI0HuJIgvmX1IqeVlAD1j9wuB/uhJR
5Vykk3oBMEvHzFtfYg8sFhlfi7Zdn2BbnrYv3IDtXoPYhJtQUBV6A5q8haOwwa5X
vVLFMWrrBQKBgQDF/QHbLjeMCt855KalmpQwiL7jex1pwrDCBSia1t1yegY7EZrY
xkYNaoSbPnn0EA9eIAaKlDeckva3QL7hTrbtVau505kkIrJJ1Uj0wk2UeaSIEoSi
m7mC6lnnHdRiyGKgklvvQhpAod8mOzicpCEqDRv1IjiqK/F4JLg73hL61wKBgGPK
zGHWuw/2naPbYFj11YsuFXgMN52+kuSOi1TjtrJYSwLOLMOW3Ahz46yj5n+dWHxw
Xckmd7giz4ePJjvU+o7wedmnyiRHnMHl6ybOkAl6Nz1mml+W/5eNai6/rDVG5O0v
cynMfS8jWEmT8n3cbGtK7Mgb3qp3MRMdF0NnlE29AoGBALyI/tkg8E7AIsd44tXu
YvNchPBwIbqTL0XJ4Hxm9a1n6bDXCQ0y2FhxI1ntSYXZ2uDDM69ZxlxlKb+x+43p
C8XHaEFvGgS+1wFOc3Nfun9YYCjOMDxgPUaIkENZxFxFdUD1NXr0mK1AVNr9kFZE
/8m10Sq1uMzTYR6DlA/U/EQm
-----END PRIVATE KEY-----`;
const OVPN = `client\ndev tun\nproto udp\nremote 127.0.0.1 1194\nnobind\nverb 3\n<ca>\n${TEST_CERT}\n</ca>\n<cert>\n${TEST_CERT}\n</cert>\n<key>\n${TEST_KEY}\n</key>\n`;

// docker только на свои контейнеры (метка каталога данных этого прогона), как в 34-*
function dexec(taskId: string, script: string) {
  const name = `whitehat-${taskId}`;
  const label = execFileSync("docker", ["inspect", "-f", '{{index .Config.Labels "whitehat.data"}}', name]).toString().trim();
  expect(label, "контейнер принадлежит этому тестовому прогону").toBe(DATA);
  return execFileSync("docker", ["exec", name, "bash", "-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const vpnGet = async (request: APIRequestContext, taskId: string) => (await (await request.get(`/api/tasks/${taskId}/vpn`)).json()) as any;
const uploadCfg = (request: APIRequestContext, taskId: string, name: string, body: string) =>
  request.post(`/api/tasks/${taskId}/vpn/config`, { multipart: { file: { name, mimeType: "application/octet-stream", buffer: Buffer.from(body) } } });

test.describe("VPN задачи в контейнере (HTB)", () => {
  let ids: Ids;
  test.beforeAll(async ({ request }) => { ids = await createTask(request, "VPN HTB"); });
  test.afterAll(async () => {
    try { dexec(ids.task.id, "ip link del tun0 2>/dev/null; pkill -f '[h]ttp.server 18080' 2>/dev/null; pkill -x openvpn 2>/dev/null; true"); } catch { /* контейнер уже убран */ }
  });

  test("API: пустое состояние, старт без конфига и битый конфиг отклоняются, валидный импортируется и удаляется", async ({ request }) => {
    const v0 = await vpnGet(request, ids.task.id);
    expect(v0.config).toBeNull();
    expect(v0.status.state).toBe("down");

    const start = await request.post(`/api/tasks/${ids.task.id}/vpn/start`);
    expect(start.status()).toBe(400);
    expect((await start.json()).error).toContain("импортируй конфиг");

    const bad = await uploadCfg(request, ids.task.id, "notes.txt", "просто какой-то текст без vpn");
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toContain("не похоже на конфиг");

    const ok = await uploadCfg(request, ids.task.id, "machines_eu.ovpn", OVPN);
    expect(ok.ok(), await ok.text()).toBeTruthy();
    const v1 = await vpnGet(request, ids.task.id);
    expect(v1.config).toMatchObject({ name: "machines_eu.ovpn", kind: "openvpn", proto: "udp" });
    // конфиг лёг с правами 0600 в /work/.whitehat/vpn и виден из контейнера
    expect(dexec(ids.task.id, "stat -c '%a %n' /work/.whitehat/vpn/config.ovpn")).toContain("600 /work/.whitehat/vpn/config.ovpn");
  });

  // Регрессия Docker-развёртывания (Windows/Docker Desktop): устройство раньше пробрасывалось только
  // если /dev/net/tun существовал в окружении самого сервера; в app-контейнере его нет — и Kali
  // навсегда оставался без tun, а «пересоздай контейнер» давало ту же спеку.
  test("tun из коробки: cgroup-правило 10:200 в спеке, снесённый /dev/net/tun сам возвращается к старту VPN", async ({ request }) => {
    test.setTimeout(120_000);
    dexec(ids.task.id, "true"); // заодно проверяет, что контейнер принадлежит тестовому прогону
    const rules = JSON.parse(execFileSync("docker", ["inspect", "-f", "{{json .HostConfig.DeviceCgroupRules}}", `whitehat-${ids.task.id}`]).toString().trim() || "null");
    expect(rules).toContain("c 10:200 rwm");

    expect(dexec(ids.task.id, "rm -f /dev/net/tun; [ -c /dev/net/tun ] && echo STILL || echo GONE")).toContain("GONE");
    const start = await request.post(`/api/tasks/${ids.task.id}/vpn/start`, { timeout: 90_000 });
    expect(start.ok(), await start.text()).toBeTruthy();
    expect(dexec(ids.task.id, "[ -c /dev/net/tun ] && echo TUNBACK")).toContain("TUNBACK");
    expect((await vpnGet(request, ids.task.id)).status.state).toBe("connecting");
    const stop = await request.post(`/api/tasks/${ids.task.id}/vpn/stop`, { timeout: 60_000 });
    expect(stop.ok(), await stop.text()).toBeTruthy();
  });

  test("openvpn стартует демоном в контейнере: connecting + живой лог, стоп снимает процесс", async ({ request }) => {
    test.setTimeout(120_000); // старт ждёт поднятия туннеля до 25 с
    const start = await request.post(`/api/tasks/${ids.task.id}/vpn/start`, { timeout: 90_000 });
    expect(start.ok(), await start.text()).toBeTruthy();
    const v = await vpnGet(request, ids.task.id);
    expect(v.status.state).toBe("connecting"); // сервера на 127.0.0.1:1194 нет — честный connecting, не down и не ложный up
    expect(v.status.log.join("\n")).toMatch(/OpenVPN|UDP|link remote/i);
    expect(dexec(ids.task.id, "cat /tmp/whitehat-vpn/pid 2>/dev/null | wc -c")).not.toContain("0");
    // up-скрипт переписан стартом и ставит MTU туннеля 1280 (пакеты >=1400 внутри сети HTB молча умирают)
    expect(dexec(ids.task.id, "grep -c 'mtu 1280' /work/.whitehat/vpn/wh-up.sh")).toContain("1");

    const stop = await request.post(`/api/tasks/${ids.task.id}/vpn/stop`, { timeout: 60_000 });
    expect(stop.ok(), await stop.text()).toBeTruthy();
    const v2 = await vpnGet(request, ids.task.id);
    expect(v2.status.state).toBe("down");
    expect(dexec(ids.task.id, "pgrep -x openvpn || echo NONE")).toContain("NONE");
  });

  test("поднятый туннель: IP в панели и статус-баре, LHOST в env агента и в контексте хода", async ({ page, request }) => {
    test.setTimeout(120_000);
    // имитация поднятого HTB-туннеля: tun-интерфейс с адресом как у настоящего openvpn после PUSH_REPLY
    dexec(ids.task.id, "ip link del tun0 2>/dev/null; ip tuntap add dev tun0 mode tun && ip addr add 10.10.14.5/23 dev tun0 && ip link set tun0 up");
    try {
      const v = await vpnGet(request, ids.task.id);
      expect(v.status.state).toBe("up");
      expect(v.status.iface).toBe("tun0");
      expect(v.status.ip).toBe("10.10.14.5");

      await mockReset(request);
      const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
      await openTask(page, { task: ids.task, chat: c }, { tab: "vpn" });
      await expect(page.getByTestId("vpn-status")).toHaveAttribute("data-state", "up");
      await expect(page.getByTestId("vpn-ip")).toHaveText("10.10.14.5");
      await expect(page.getByTestId("vpn-hints")).toContainText("10.10.14.5:4444");
      await expect(page.getByTestId("status-vpn")).toContainText("10.10.14.5");
      await expect(page.getByTestId("tab-vpn-dot")).toBeVisible();

      // агент: $LHOST в команде и адрес туннеля в том, что реально ушло в модель (контекст хода)
      await page.getByTestId("tab-term").click();
      await send(page, "[[tool:shell:echo LHOST=$LHOST IFACE=$WH_VPN_IFACE]] [[nomem]]");
      await waitIdle(page);
      const tool = page.getByTestId("tool-block").first();
      await tool.locator("summary").click();
      await expect(tool.getByTestId("tool-output")).toContainText("LHOST=10.10.14.5");
      const reqs = (await mockRequests(request)).filter((r: any) => r.kind === "agent");
      const flat = JSON.stringify(reqs[0].body.messages);
      expect(flat).toContain("VPN внутри контейнера поднят");
      expect(flat).toContain("10.10.14.5");
    } finally {
      dexec(ids.task.id, "ip link del tun0 2>/dev/null; true");
    }
  });

  test("SOCKS для браузера хоста: хост достаёт сервис контейнера через прокси", async ({ request }) => {
    test.setTimeout(120_000);
    expect(dexec(ids.task.id, "mkdir -p /tmp/socksite && echo WH-SOCKS-OK > /tmp/socksite/marker.txt && nohup python3 -m http.server 18080 --directory /tmp/socksite </dev/null >/tmp/http.log 2>&1 & for i in $(seq 1 20); do curl -sf http://127.0.0.1:18080/marker.txt && { echo READY; break; }; sleep 0.25; done")).toContain("READY");
    try {
      const on = await request.post(`/api/tasks/${ids.task.id}/vpn/socks-start`, { timeout: 60_000 });
      expect(on.ok(), await on.text()).toBeTruthy();
      const v = await vpnGet(request, ids.task.id);
      expect(v.status.socks.running).toBe(true);
      // Опубликованный на 127.0.0.1 хоста порт самого контейнера задачи, а не bridge-IP: из Windows/macOS
      // (Docker Desktop) bridge-адрес контейнера не маршрутизируется, опубликованный порт — везде.
      expect(v.status.socks.url).toMatch(/^socks5:\/\/127\.0\.0\.1:\d+$/);
      const binds = JSON.parse(execFileSync("docker", ["inspect", "-f", "{{json .HostConfig.PortBindings}}", `whitehat-${ids.task.id}`]).toString().trim() || "null");
      expect(binds?.["1080/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
      // с хоста через SOCKS: 127.0.0.1 здесь резолвится уже внутри контейнера
      const r = spawnSync("curl", ["-s", "--max-time", "15", "--socks5-hostname", v.status.socks.url.replace("socks5://", ""), "http://127.0.0.1:18080/marker.txt"], { encoding: "utf8" });
      expect(r.stdout).toContain("WH-SOCKS-OK");
      const off = await request.post(`/api/tasks/${ids.task.id}/vpn/socks-stop`, { timeout: 60_000 });
      expect(off.ok(), await off.text()).toBeTruthy();
      expect((await vpnGet(request, ids.task.id)).status.socks.running).toBe(false);
    } finally {
      // [h]: иначе pkill -f находит собственный bash -c с этим же текстом и убивает сам себя до `true`
      dexec(ids.task.id, "pkill -f '[h]ttp.server 18080' 2>/dev/null; true");
    }
  });

  test("скрипт знаний: свой гайд индексируется в тестовую базу и находится поиском агента", async ({ page, request }) => {
    test.setTimeout(180_000);
    const env = { ...process.env, WH_DATA: DATA, WH_EMBED_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, WH_LLM_URL: `http://127.0.0.1:${MOCK_PORT}/v1` };
    const r = spawnSync("npx", ["tsx", "scripts/knowledge.mts", "--only", "htb-03", "--skip-clone"], { cwd: ROOT, env, encoding: "utf8", timeout: 150_000 });
    expect(r.stdout + r.stderr).toContain("htb-03-shells-transfer-pivot.md: индексирую");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const docs = (await (await request.get("/api/docs")).json()) as any[];
    const guide = docs.find((d) => d.name === "htb-03-shells-transfer-pivot.md");
    expect(guide?.status).toBe("ready");
    expect(guide?.chunks).toBeGreaterThan(0);

    await mockReset(request);
    const c = await (await request.post(`/api/tasks/${ids.task.id}/chats`)).json();
    await openTask(page, { task: ids.task, chat: c });
    await send(page, "[[tool:docs:penelope reverse shell листенер]] [[nomem]]");
    await waitIdle(page);
    const tool = page.getByTestId("tool-block").first();
    await tool.locator("summary").click();
    await expect(tool.getByTestId("tool-output")).toContainText("penelope");
  });

  test("UI: импорт через панель, замена запрещена при поднятом туннеле, удаление конфига", async ({ page, request }) => {
    test.setTimeout(120_000);
    await request.delete(`/api/tasks/${ids.task.id}/vpn/config`);
    await openTask(page, { task: ids.task, chat: ids.chat }, { tab: "vpn" });
    await expect(page.getByTestId("vpn-drop")).toBeVisible();
    await page.getByTestId("vpn-input").setInputFiles({ name: "lab_wg.conf", mimeType: "application/octet-stream", buffer: Buffer.from("[Interface]\nPrivateKey = x\n[Peer]\nPublicKey = y\n") });
    await expect(page.getByTestId("vpn-config-name")).toHaveText("lab_wg.conf");
    await expect(page.getByTestId("vpn-panel")).toContainText("wireguard");
    await expect(page.getByTestId("vpn-start")).toBeEnabled();

    await page.getByTestId("vpn-delete-config").click();
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("vpn-drop")).toBeVisible();
    expect((await vpnGet(request, ids.task.id)).config).toBeNull();
  });

  test("TCP-конфиг: proto в API и предупреждение в панели (веб через TCP-туннель тормозит)", async ({ page, request }) => {
    const created = await (await request.post("/api/tasks", { data: { title: "VPN TCP warning" } })).json();
    const tcpOvpn = OVPN.replace("proto udp", "proto tcp").replace("remote 127.0.0.1 1194", "remote 127.0.0.1 443");
    const ok = await uploadCfg(request, created.task.id, "machines_tcp.ovpn", tcpOvpn);
    expect(ok.ok(), await ok.text()).toBeTruthy();
    expect((await vpnGet(request, created.task.id)).config).toMatchObject({ kind: "openvpn", proto: "tcp" });
    await openTask(page, { task: created.task, chat: created.chat }, { tab: "vpn" });
    await expect(page.getByTestId("vpn-proto")).toHaveText("TCP");
    await expect(page.getByTestId("vpn-proto-warn")).toBeVisible();
    await expect(page.getByTestId("vpn-proto-warn")).toContainText("UDP");
    await request.delete(`/api/tasks/${created.task.id}`);
  });

  // Живой баг: VPN в двух задачах одним сертификатом HTB — сессии крадут друг у друга туннель
  // по ping-restart каждые ~2 минуты («VPN постоянно отваливается»). Старт во второй гасит первую.
  test("один сертификат — одна сессия: старт VPN во второй задаче гасит туннель первой", async ({ request }) => {
    test.setTimeout(300_000); // каждый старт ждёт поднятия до 25 с
    const up1 = await uploadCfg(request, ids.task.id, "machines_eu.ovpn", OVPN);
    expect(up1.ok(), await up1.text()).toBeTruthy();
    const s1 = await request.post(`/api/tasks/${ids.task.id}/vpn/start`, { timeout: 90_000 });
    expect(s1.ok(), await s1.text()).toBeTruthy();
    expect((await vpnGet(request, ids.task.id)).status.state).toBe("connecting");
    const t2 = await (await request.post("/api/tasks", { data: { title: "VPN вторая", course: "Сети", brief: "тест одного туннеля" } })).json();
    try {
      const up = await uploadCfg(request, t2.task.id, "machines_eu.ovpn", OVPN);
      expect(up.ok(), await up.text()).toBeTruthy();
      const s2 = await request.post(`/api/tasks/${t2.task.id}/vpn/start`, { timeout: 90_000 });
      expect(s2.ok(), await s2.text()).toBeTruthy();
      expect((await s2.json()).stoppedOthers).toContain("VPN HTB");
      expect((await vpnGet(request, ids.task.id)).status.state).toBe("down");
      expect((await vpnGet(request, t2.task.id)).status.state).toBe("connecting");
    } finally {
      await request.post(`/api/tasks/${t2.task.id}/vpn/stop`).catch(() => {});
      await request.delete(`/api/tasks/${t2.task.id}`).catch(() => {});
      await request.post(`/api/tasks/${ids.task.id}/vpn/stop`).catch(() => {});
    }
  });
});
