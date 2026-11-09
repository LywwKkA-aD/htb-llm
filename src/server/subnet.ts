// Детерминированный калькулятор IP-адресации (IPv4 + IPv6). Модели часто ошибаются в масках —
// поэтому агент обязан считать здесь, а не «в уме».

// ---------- IPv4 ----------
const ip2int = (s: string) => {
  const p = s.trim().split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) throw new Error(`не IPv4: ${s}`);
  return p.reduce((a, x) => ((a << 8) | Number(x)) >>> 0, 0);
};
const int2ip = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
const maskOf = (p: number) => (p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
const prefixOfMask = (m: number) => {
  const p = 32 - Math.log2(((~m) >>> 0) + 1);
  if (!Number.isInteger(p) || maskOf(p) !== m) throw new Error(`маска не непрерывная: ${int2ip(m)}`);
  return p;
};
// двоичный вид с точками между октетами и «|» на границе сеть|хост (на границе октета «|» заменяет точку)
const bin = (n: number, p: number) => {
  const b = n.toString(2).padStart(32, "0");
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += b[i];
    const k = i + 1;
    if (k === p && k < 32) out += "|";
    else if (k % 8 === 0 && k < 32) out += ".";
  }
  return out;
};

function v4type(n: number) {
  const inR = (net: string, p: number) => ((n & maskOf(p)) >>> 0) === ip2int(net);
  if (n === 0xffffffff) return "limited broadcast";
  if (inR("0.0.0.0", 8)) return "«эта сеть» (0.0.0.0/8)";
  if (inR("127.0.0.0", 8)) return "loopback (127.0.0.0/8)";
  if (inR("10.0.0.0", 8) || inR("172.16.0.0", 12) || inR("192.168.0.0", 16)) return "частный (RFC 1918)";
  if (inR("100.64.0.0", 10)) return "CGNAT (100.64.0.0/10, RFC 6598)";
  if (inR("169.254.0.0", 16)) return "link-local / APIPA (169.254.0.0/16)";
  if (inR("192.0.2.0", 24) || inR("198.51.100.0", 24) || inR("203.0.113.0", 24)) return "документационный (RFC 5737)";
  if (inR("224.0.0.0", 4)) return "multicast (класс D)";
  if (inR("240.0.0.0", 4)) return "зарезервирован (класс E)";
  return "публичный";
}
const v4class = (n: number) => { const o = n >>> 24; return o < 128 ? "A" : o < 192 ? "B" : o < 224 ? "C" : o < 240 ? "D" : "E"; };

function v4block(net: number, p: number) {
  const m = maskOf(p);
  const bc = (net | ~m) >>> 0;
  const size = 2 ** (32 - p);
  const hosts = p <= 30 ? size - 2 : p === 31 ? 2 : 1;
  const first = p <= 30 ? net + 1 : net, last = p <= 30 ? bc - 1 : bc;
  return { net, bc, size, hosts, first, last, m };
}

function parseV4(input: string) {
  const s = input.trim().replace(/\s+/g, " ");
  let ip: string, p: number;
  let m = /^([\d.]+)\s*\/\s*(\d{1,2})$/.exec(s);
  if (m) { ip = m[1]; p = Number(m[2]); }
  else if ((m = /^([\d.]+)\s*(?:\/|\s|mask|маска)\s*([\d.]+)$/i.exec(s))) { ip = m[1]; p = prefixOfMask(ip2int(m[2])); }
  else if (/^[\d.]+$/.test(s)) { ip = s; p = 32; }
  else throw new Error(`не понял адрес: ${input}`);
  if (p < 0 || p > 32) throw new Error("префикс IPv4 должен быть 0..32");
  return { n: ip2int(ip), p };
}

function calcV4(input: string, split?: number, vlsm?: number[]) {
  const { n, p } = parseV4(input);
  const b = v4block((n & maskOf(p)) >>> 0, p);
  const L: string[] = [];
  L.push(`адрес:        ${int2ip(n)}/${p}  (класс ${v4class(n)}, ${v4type(n)})`);
  L.push(`маска:        ${int2ip(b.m)}   wildcard: ${int2ip((~b.m) >>> 0)}`);
  L.push(`сеть:         ${int2ip(b.net)}/${p}`);
  L.push(`broadcast:    ${p <= 30 ? int2ip(b.bc) : "нет (/31, /32)"}`);
  L.push(`хосты:        ${int2ip(b.first)} – ${int2ip(b.last)}`);
  L.push(`адресов:      ${b.size}, из них под хосты: ${b.hosts}${p === 31 ? " (point-to-point, RFC 3021)" : ""}`);
  L.push(`двоично адрес: ${bin(n, p)}`);
  L.push(`двоично маска: ${bin(b.m, p)}   («|» — граница сеть|хост)`);
  if (n !== b.net && n !== b.bc) L.push(`адрес ${int2ip(n)} — ${n - b.net}-й по счёту в своей подсети`);
  if (n === b.net && p < 31) L.push("это адрес СЕТИ, хосту его назначить нельзя");
  if (n === b.bc && p < 31) L.push("это BROADCAST-адрес, хосту его назначить нельзя");

  if (split !== undefined && split !== null) {
    if (split <= p || split > 32) L.push(`\nsplit_prefix=${split}: должен быть больше ${p} и не больше 32`);
    else {
      const cnt = 2 ** (split - p);
      const sb = v4block(b.net, split);
      L.push(`\nразбиение ${int2ip(b.net)}/${p} на /${split}: ${cnt} подсетей по ${sb.size} адресов (${sb.hosts} хостов), маска ${int2ip(maskOf(split))}`);
      const show = Math.min(cnt, 32);
      for (let i = 0; i < show; i++) {
        const x = v4block(b.net + i * sb.size, split);
        L.push(`  #${String(i + 1).padStart(2)} ${int2ip(x.net)}/${split}  хосты ${int2ip(x.first)} – ${int2ip(x.last)}  bc ${split <= 30 ? int2ip(x.bc) : "-"}`);
      }
      if (cnt > show) L.push(`  … и ещё ${cnt - show}; последняя: ${int2ip(b.net + (cnt - 1) * sb.size)}/${split}`);
    }
  }

  if (vlsm?.length) {
    const reqs = vlsm.map((h, i) => ({ h: Number(h), i })).sort((a, b) => b.h - a.h);
    let cur = b.net;
    L.push(`\nVLSM в ${int2ip(b.net)}/${p} (от большей потребности к меньшей):`);
    let ok = true;
    for (const r of reqs) {
      if (!(r.h > 0)) { L.push(`  сеть #${r.i + 1}: некорректное число хостов ${r.h}`); ok = false; continue; }
      let bits = 0;
      while (2 ** bits - 2 < r.h) bits++;
      const sp = 32 - bits;
      if (sp < p) { L.push(`  сеть #${r.i + 1} (${r.h} хостов): нужна /${sp}, больше всего блока /${p}`); ok = false; break; }
      const x = v4block(cur, sp);
      if (x.bc > b.bc || cur < b.net) { L.push(`  сеть #${r.i + 1} (${r.h} хостов): НЕ ПОМЕЩАЕТСЯ — адреса блока закончились`); ok = false; break; }
      L.push(`  сеть #${r.i + 1}: нужно ${r.h} → ${int2ip(x.net)}/${sp} (маска ${int2ip(x.m)}), хосты ${int2ip(x.first)} – ${int2ip(x.last)}, bc ${int2ip(x.bc)}, вмещает ${x.hosts}, запас ${x.hosts - r.h}`);
      cur = (x.bc + 1) >>> 0;
    }
    if (ok) L.push(`  свободно после распределения: ${cur <= b.bc ? `${int2ip(cur)} – ${int2ip(b.bc)} (${b.bc - cur + 1} адресов)` : "ничего"}`);
  }
  return L.join("\n");
}

// ---------- IPv6 ----------
function parseV6(s: string): bigint {
  let a = s.trim().toLowerCase();
  if (a.includes(".")) { // хвост IPv4 (::ffff:1.2.3.4)
    const i = a.lastIndexOf(":");
    let v4: number;
    try { v4 = ip2int(a.slice(i + 1)); } catch { throw new Error(`не IPv6: ${s} (хвост IPv4 некорректен)`); }
    a = `${a.slice(0, i)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const parts = a.split("::");
  if (parts.length > 2) throw new Error(`не IPv6: ${s}`);
  const L = parts[0] ? parts[0].split(":") : [];
  const R = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = parts.length === 2 ? 8 - L.length - R.length : 0;
  // «::» заменяет хотя бы одну нулевую группу: при 8 явных группах он лишний, при 9+ групп Array(-1) бросал
  // сырой «Invalid array length»
  if (parts.length === 2 && fill < 1) throw new Error(`не IPv6: ${s} («::» должен заменять хотя бы одну группу, а групп уже ${L.length + R.length})`);
  const groups = [...L, ...Array(fill).fill("0"), ...R];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) throw new Error(`не IPv6: ${s}`);
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}
function fmtV6(x: bigint) {
  const g = Array.from({ length: 8 }, (_, i) => Number((x >> BigInt(112 - 16 * i)) & 0xffffn));
  let best = -1, bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) { i++; continue; }
    let j = i; while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const h = g.map((v) => v.toString(16));
  if (best < 0) return h.join(":");
  return `${h.slice(0, best).join(":")}::${h.slice(best + bestLen).join(":")}`;
}
const full6 = (x: bigint) => Array.from({ length: 8 }, (_, i) => ((x >> BigInt(112 - 16 * i)) & 0xffffn).toString(16).padStart(4, "0")).join(":");
const mask6 = (p: number) => (p === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - p)) - 1n));
function v6type(x: bigint) {
  const inR = (net: string, p: number) => (x & mask6(p)) === parseV6(net);
  if (x === 1n) return "loopback (::1)";
  if (x === 0n) return "unspecified (::)";
  if (inR("::ffff:0:0", 96)) return "IPv4-mapped";
  if (inR("fe80::", 10)) return "link-local (fe80::/10)";
  if (inR("fc00::", 7)) return "unique local, ULA (fc00::/7)";
  if (inR("ff00::", 8)) return "multicast (ff00::/8)";
  if (inR("2001:db8::", 32)) return "документационный (2001:db8::/32)";
  if (inR("2000::", 3)) return "global unicast (2000::/3)";
  return "прочий/зарезервированный";
}
function calcV6(input: string, split?: number) {
  const m = /^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/.exec(input.trim());
  if (!m) throw new Error(`не понял адрес: ${input}`);
  const x = parseV6(m[1]);
  const p = m[2] ? Number(m[2]) : 128;
  if (p > 128) throw new Error("префикс IPv6 должен быть 0..128");
  const net = x & mask6(p);
  const last = net | (((1n << 128n) - 1n) ^ mask6(p));
  const L = [
    `адрес:     ${fmtV6(x)}/${p}  (${v6type(x)})`,
    `полностью: ${full6(x)}`,
    `сеть:      ${fmtV6(net)}/${p}`,
    `диапазон:  ${fmtV6(net)} – ${fmtV6(last)}`,
    `адресов:   2^${128 - p} = ${(1n << BigInt(128 - p)).toString()}`,
  ];
  if (split !== undefined && split !== null) {
    if (split <= p || split > 128) L.push(`split_prefix=${split}: должен быть больше ${p} и не больше 128`);
    else {
      const cnt = 1n << BigInt(split - p);
      const step = 1n << BigInt(128 - split);
      L.push(`\nразбиение на /${split}: ${cnt} подсетей`);
      const show = cnt < 16n ? Number(cnt) : 16;
      for (let i = 0; i < show; i++) L.push(`  #${i + 1} ${fmtV6(net + BigInt(i) * step)}/${split}`);
      if (cnt > BigInt(show)) L.push(`  … и ещё ${cnt - BigInt(show)}`);
    }
  }
  return L.join("\n");
}

export function subnetCalc(address: string, split?: number, vlsm?: number[]) {
  try {
    return address.includes(":") ? calcV6(address, split) : calcV4(address, split, vlsm);
  } catch (e: any) {
    return `ошибка: ${e.message}`;
  }
}
