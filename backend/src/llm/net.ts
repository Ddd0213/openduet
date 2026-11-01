// Provider URL guard, used both when saving and immediately before model/list/ASR requests.
// Real requests to a public provider go through network/pool.ts (each new connection resolves and
// checks the hostname; a kept-alive one is reused); the explicit local / private exceptions keep
// Bun's fetch; injected test transports are checked here first (and pinned with `pin`).
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { netErrorOf, resolvePublic, type Lookup, NetError } from "../custom-connectors/net.ts";
import { addressErrorOf, sharedPool } from "../network/pool.ts";
import type { Fetch } from "./types.ts";
const hosts = (name: string) => (process.env[name] ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
const canonical = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
export interface ModelNetOptions { lookup?: Lookup; insecureHosts?: readonly string[]; privateHosts?: readonly string[]; fetch?: Fetch; pin?: boolean }
/** true: an explicit local / private exception (no address check); throws for a URL that's never allowed. */
function exempt(url: URL, options: ModelNetOptions): boolean {
  const host = canonical(url.hostname);
  const insecure = ["localhost", "127.0.0.1", "::1", ...(options.insecureHosts ?? hosts("LLM_ALLOW_INSECURE_HOSTS"))].map(canonical).includes(host);
  const privateAllowed = (options.privateHosts ?? hosts("LLM_ALLOW_PRIVATE_HOSTS")).map(canonical).includes(host);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && insecure))) throw new NetError("Only https model addresses are allowed (except explicitly insecure hosts).", "blocked");
  return insecure || privateAllowed;
}
// Injected transports may carry their resolver for deterministic, network-free tests.
export async function checkModelAddress(url: URL, options: ModelNetOptions = {}): Promise<string | null> {
  if (exempt(url, options)) return null;
  return resolvePublic(canonical(url.hostname), options.lookup);
}
const guardedTransports = new WeakSet<Fetch>();
export function createModelFetch(options: ModelNetOptions = {}): Fetch {
  if (options.fetch && guardedTransports.has(options.fetch)) return options.fetch;
  const lookup = options.lookup ?? options.fetch?.lookup;
  const guarded: Fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v,k) => headers.set(k,v));
    const base = { ...init, headers, redirect: "error" as const };
    if (!options.fetch) {
      if (exempt(url, options)) return globalThis.fetch(input, base);
      try {
        return await sharedPool(lookup).fetch(input, base);
      } catch (error) {
        const refused = addressErrorOf(error);
        throw refused ? netErrorOf(refused) : error;
      }
    }
    const address = await checkModelAddress(url, { ...options, lookup });
    const transport = options.fetch;
    if (!address || !options.pin) return transport(input, base);
    const pinned = new URL(url); pinned.hostname = address.includes(":") ? `[${address}]` : address;
    headers.set("host", url.host);
    const request = input instanceof Request ? new Request(pinned.href, input) : pinned;
    const host = canonical(url.hostname);
    return transport(request, { ...base, proxy: "", tls: { serverName: host, rejectUnauthorized: true, checkServerIdentity: (_h: string, cert: PeerCertificate) => checkServerIdentity(host, cert) } } as RequestInit);
  };
  guarded.lookup = lookup;
  guardedTransports.add(guarded);
  return guarded;
}
