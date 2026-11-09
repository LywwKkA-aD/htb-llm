import { nanoid } from "nanoid";
import { db, now } from "./db.ts";

// Профиль цели и хранилище кред: структурированные факты о машине отдельной сущностью, а не
// прозой в памяти. Ведёт модель инструментом profile_update, пользователь правит в панели «Цель».
// Сводка подклеивается в контекст каждого хода: модель не пересканирует порты и не теряет креды
// между чатами. Добавление сервиса/креды с тем же естественным ключом обновляет запись, а не плодит дубль.
export const PROFILE_KINDS = ["service", "cred", "access", "fact"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];
export type ProfileItem = {
  id: string;
  kind: ProfileKind;
  host: string;
  port: number | null;
  proto: string;
  service: string;
  version: string;
  username: string;
  secret: string;
  secret_type: string;
  source: string;
  text: string;
  sort: number;
};
export type ProfileFields = Partial<{
  host: unknown; port: unknown; proto: unknown; service: unknown; version: unknown;
  username: unknown; secret: unknown; secret_type: unknown; source: unknown; text: unknown; kind: unknown;
}>;

const COLS = "id, kind, host, port, proto, service, version, username, secret, secret_type, source, text, sort";
const s = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

export function listProfile(taskId: string): ProfileItem[] {
  return db.prepare(`select ${COLS} from profile_items where task_id=? order by sort, created_at`).all(taskId) as ProfileItem[];
}

function normKind(v: unknown): ProfileKind {
  const k = String(v ?? "").trim().toLowerCase();
  if ((PROFILE_KINDS as readonly string[]).includes(k)) return k as ProfileKind;
  throw new Error(`kind должен быть одним из: ${PROFILE_KINDS.join(", ")}`);
}
function normPort(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Math.trunc(Number(v));
  if (!(n >= 1 && n <= 65535)) throw new Error("порт должен быть 1..65535");
  return n;
}
function build(kind: ProfileKind, f: ProfileFields): Omit<ProfileItem, "id" | "sort"> {
  const it: Omit<ProfileItem, "id" | "sort"> = {
    kind,
    host: s(f.host, 120),
    port: normPort(f.port),
    proto: s(f.proto, 10).toLowerCase() === "udp" ? "udp" : "tcp",
    service: s(f.service, 120),
    version: s(f.version, 200),
    username: s(f.username, 200),
    secret: String(f.secret ?? "").slice(0, 2000),
    secret_type: s(f.secret_type, 40).toLowerCase() || "password",
    source: s(f.source, 300),
    text: s(f.text, 500),
  };
  validate(it);
  return it;
}
function validate(it: Omit<ProfileItem, "id" | "sort">) {
  if (it.kind === "service" && it.port === null) throw new Error("для записи сервиса нужен port");
  if (it.kind === "cred" && !it.secret) throw new Error("для кред нужен secret (пароль, хэш, ключ или токен)");
  if ((it.kind === "access" || it.kind === "fact") && !it.text) throw new Error(`для записи ${it.kind} нужен text`);
}

function save(taskId: string, it: ProfileItem) {
  db.prepare("update profile_items set kind=?, host=?, port=?, proto=?, service=?, version=?, username=?, secret=?, secret_type=?, source=?, text=?, updated_at=? where task_id=? and id=?")
    .run(it.kind, it.host, it.port, it.proto, it.service, it.version, it.username, it.secret, it.secret_type, it.source, it.text, now(), taskId, it.id);
}

// Повторное добавление того же host:port/proto (сервис) или service+username (креды) —
// обновление существующей записи непустыми полями, а не дубль: перескан с версией уточняет профиль.
export function addProfileItem(taskId: string, kindRaw: unknown, f: ProfileFields): ProfileItem {
  const kind = normKind(kindRaw);
  const built = build(kind, f);
  let dup: ProfileItem | undefined;
  if (kind === "service")
    dup = db.prepare(`select ${COLS} from profile_items where task_id=? and kind='service' and host=? and port=? and proto=?`)
      .get(taskId, built.host, built.port, built.proto) as ProfileItem | undefined;
  else if (kind === "cred")
    dup = db.prepare(`select ${COLS} from profile_items where task_id=? and kind='cred' and lower(service)=lower(?) and username=?`)
      .get(taskId, built.service, built.username) as ProfileItem | undefined;
  if (dup) {
    const merged: ProfileItem = { ...dup };
    for (const k of ["host", "service", "version", "username", "secret", "secret_type", "source", "text"] as const)
      if (built[k]) merged[k] = built[k];
    if (built.port !== null) merged.port = built.port;
    validate(merged);
    save(taskId, merged);
    return merged;
  }
  const count = (db.prepare("select count(*) as n from profile_items where task_id=?").get(taskId) as { n: number }).n;
  if (count >= 200) throw new Error("профиль задачи переполнен (200 записей): удали устаревшие через панель «Цель»");
  const maxSort = (db.prepare("select coalesce(max(sort), -1) as m from profile_items where task_id=?").get(taskId) as { m: number }).m;
  const item: ProfileItem = { ...built, id: nanoid(8), sort: maxSort + 1 };
  db.prepare("insert into profile_items(id, task_id, kind, host, port, proto, service, version, username, secret, secret_type, source, text, sort, created_at, updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(item.id, taskId, item.kind, item.host, item.port, item.proto, item.service, item.version, item.username, item.secret, item.secret_type, item.source, item.text, item.sort, now(), now());
  return item;
}

export function profileLabel(i: ProfileItem): string {
  if (i.kind === "service") return `${i.host || "*"}:${i.port ?? "?"}/${i.proto}${i.service ? ` ${i.service}` : ""}${i.version ? ` ${i.version}` : ""}`.trim();
  if (i.kind === "cred") return `${i.service || "?"} ${i.username || "(без логина)"}`.trim();
  return i.text;
}

export function updateProfileItem(taskId: string, id: string, patch: ProfileFields): ProfileItem {
  const cur = db.prepare(`select ${COLS} from profile_items where task_id=? and id=?`).get(taskId, id) as ProfileItem | undefined;
  if (!cur) {
    const all = listProfile(taskId);
    const list = all.length ? `существующие записи: ${all.map((i) => `${i.id} «${profileLabel(i)}»`).join(", ")}.` : "профиль пуст.";
    throw new Error(`нет такой записи профиля: ${id}; ${list}`);
  }
  const next: ProfileItem = { ...cur };
  if (patch.kind !== undefined) next.kind = normKind(patch.kind);
  if (patch.host !== undefined) next.host = s(patch.host, 120);
  if (patch.port !== undefined) next.port = normPort(patch.port);
  if (patch.proto !== undefined) next.proto = s(patch.proto, 10).toLowerCase() === "udp" ? "udp" : "tcp";
  if (patch.service !== undefined) next.service = s(patch.service, 120);
  if (patch.version !== undefined) next.version = s(patch.version, 200);
  if (patch.username !== undefined) next.username = s(patch.username, 200);
  if (patch.secret !== undefined) next.secret = String(patch.secret).slice(0, 2000);
  if (patch.secret_type !== undefined) next.secret_type = s(patch.secret_type, 40).toLowerCase() || "password";
  if (patch.source !== undefined) next.source = s(patch.source, 300);
  if (patch.text !== undefined) next.text = s(patch.text, 500);
  validate(next);
  save(taskId, next);
  return next;
}

export function removeProfileItem(taskId: string, id: string) {
  const r = db.prepare("delete from profile_items where task_id=? and id=?").run(taskId, id);
  if (!r.changes) throw new Error(`нет такой записи профиля: ${id}`);
}

// Компактный профиль для модели: сервисы по портам, креды целиком (они затем и хранятся), доступы, факты.
export function formatProfile(items: ProfileItem[]): string {
  if (!items.length) return "(профиль пуст)";
  const lines: string[] = [];
  const services = items.filter((i) => i.kind === "service").sort((a, b) => (a.port ?? 99999) - (b.port ?? 99999));
  if (services.length) {
    lines.push("Сервисы:");
    for (const i of services) lines.push(`- (${i.id}) ${profileLabel(i)}${i.source ? ` [${i.source}]` : ""}`);
  }
  const creds = items.filter((i) => i.kind === "cred");
  if (creds.length) {
    lines.push("Креды:");
    for (const i of creds)
      lines.push(`- (${i.id}) ${i.service || "?"}: ${i.username || "(без логина)"} / ${i.secret} (${i.secret_type}${i.source ? `; источник: ${i.source}` : ""})`);
  }
  const access = items.filter((i) => i.kind === "access");
  if (access.length) {
    lines.push("Доступы:");
    for (const i of access) lines.push(`- (${i.id}) ${i.text}${i.source ? ` [${i.source}]` : ""}`);
  }
  const facts = items.filter((i) => i.kind === "fact");
  if (facts.length) {
    lines.push("Факты:");
    for (const i of facts) lines.push(`- (${i.id}) ${i.text}${i.source ? ` [${i.source}]` : ""}`);
  }
  return lines.join("\n").slice(0, 2000);
}
