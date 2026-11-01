// Only explicitly trusted socket peers may supply a forwarding chain.
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { z } from "zod";
import { lookup } from "node:dns/promises";

const Ip = z.union([z.ipv4(), z.ipv6()]);
type Address = { value: bigint; bits: 32 | 128 };

function address(raw: string): Address | null {
  if (!Ip.safeParse(raw).success) return null;
  if (!raw.includes(":")) {
    return { value: raw.split(".").reduce((n, part) => (n << 8n) | BigInt(part), 0n), bits: 32 };
  }
  let expanded = raw.toLowerCase();
  if (expanded.includes(".")) {
    const colon = expanded.lastIndexOf(":");
    const v4 = address(expanded.slice(colon + 1))!;
    expanded = `${expanded.slice(0, colon)}:${(v4.value >> 16n).toString(16)}:${(v4.value & 65535n).toString(16)}`;
  }
  const halves = expanded.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  const value = groups.reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n);
  return { value, bits: 128 };
}

type Network = { address: Address; prefix: number };
function network(rule: string): Network {
  const [raw, suffix, extra] = rule.split("/");
  const parsed = raw ? address(raw) : null;
  if (!parsed || extra !== undefined || (suffix !== undefined && !/^\d+$/.test(suffix))) {
    throw new Error(`Invalid TRUSTED_PROXIES entry: ${rule}`);
  }
  const prefix = suffix === undefined ? parsed.bits : Number(suffix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) {
    throw new Error(`Invalid TRUSTED_PROXIES entry: ${rule}`);
  }
  return { address: parsed, prefix };
}

function matches(ip: Address, range: Network): boolean {
  // Treat IPv4 socket peers and their IPv4-mapped IPv6 representation identically.
  let comparable = ip;
  if (ip.bits === 128 && ip.value >> 32n === 65535n && range.address.bits === 32) {
    comparable = { value: ip.value & 0xffffffffn, bits: 32 };
  } else if (ip.bits === 32 && range.address.bits === 128) {
    comparable = { value: (65535n << 32n) | ip.value, bits: 128 };
  }
  if (comparable.bits !== range.address.bits) return false;
  const shift = BigInt(comparable.bits - range.prefix);
  return comparable.value >> shift === range.address.value >> shift;
}

export function ipMatches(ip: string, rule: string): boolean {
  const parsed = address(ip);
  return parsed !== null && matches(parsed, network(rule));
}

export function createClientIpResolver(trustedProxies: readonly string[]) {
  const ranges = trustedProxies.map(network);
  const trusted = (ip: Address) => ranges.some((range) => matches(ip, range));
  return (socketAddress: string | undefined, forwardedFor: string | undefined): string => {
    const socket = socketAddress ? address(socketAddress) : null;
    if (!socket) return "unknown";
    const canonical = (raw: string, parsed: Address) => parsed.bits === 32 || parsed.value >> 32n === 65535n
      ? [24n, 16n, 8n, 0n].map((shift) => Number((parsed.value >> shift) & 255n)).join(".")
      : new URL(`http://[${raw}]/`).hostname.slice(1, -1);
    const peer = canonical(socketAddress!, socket);
    if (!trusted(socket) || !forwardedFor) return peer;
    const header = z.string().max(4096).safeParse(forwardedFor);
    if (!header.success) return peer;
    const chain = header.data.split(",").map((part) => part.trim());
    if (chain.length > 64 || chain.some((part) => !address(part))) return peer;
    for (let i = chain.length - 1; i >= 0; i--) {
      const raw = chain[i]!;
      const parsed = address(raw)!;
      if (!trusted(parsed)) return canonical(raw, parsed);
    }
    return peer;
  };
}

/** Docker DNS service names resolve to exact peers, never to their bridge subnet. */
export function createDynamicClientIpResolver(
  trustedProxies: readonly string[],
  resolve: (host: string) => Promise<readonly string[]> = async (host) => (await lookup(host, { all: true })).map((r) => r.address),
  now: () => number = Date.now,
) {
  const names = trustedProxies.filter((rule) => !address(rule) && !rule.includes("/"));
  if (names.some((name) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(name))) throw new Error("Invalid TRUSTED_PROXIES service name");
  const literals = trustedProxies.filter((rule) => !names.includes(rule));
  const literalResolver = createClientIpResolver(literals);
  let expires = 0;
  let cached = literalResolver;
  let pending: Promise<void> | undefined;
  return async (peer: string | undefined, xff: string | undefined): Promise<string> => {
    if (names.length && now() >= expires) {
      pending ??= (async () => {
        const results = await Promise.all(names.map(async (name) => {
          try {
            return await Promise.race([resolve(name), new Promise<string[]>((done) => {
              const timer = setTimeout(() => done([]), 1000); timer.unref();
            })]);
          } catch { return []; }
        }));
        cached = createClientIpResolver([...literals, ...results.flat().filter((ip) => address(ip) !== null)]);
        expires = now() + 30_000;
      })().finally(() => { pending = undefined; });
      await pending;
    }
    return cached(peer, xff);
  };
}

/** Bun.serve passes its server as app.fetch's second argument (c.env). */
export function socketIp(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // app.request has no socket or Bun server.
    return undefined;
  }
}
