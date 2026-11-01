// Shared SSRF address policy. IPv4 and IPv6 lists stay separate (mapped IPv6 matches IPv4 in BlockList).
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
export type FakeIpMode = "auto" | "1" | "0";
export const FAKE_IP_PROBES = ["github.com", "www.google.com", "www.cloudflare.com"] as const;
const blocked4 = new BlockList(), blocked6 = new BlockList(), fake = new BlockList();
fake.addSubnet("198.18.0.0", 15, "ipv4");
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked4.addSubnet(address,prefix,"ipv4");
for (const [address,prefix] of [["::",128],["::1",128],["::ffff:0:0",96],["64:ff9b::",96],["64:ff9b:1::",48],["100::",64],["2001::",32],["2001:db8::",32],["2002::",16],["fc00::",7],["fe80::",10],["ff00::",8]] as const) blocked6.addSubnet(address,prefix,"ipv6");
export const isFakeIp = (address: string) => isIP(address) === 4 && fake.check(address, "ipv4");

export class FakeIpPolicy {
  private detected = false;
  private expires = 0;
  private pending?: Promise<void>;
  constructor(private readonly mode: () => string = () => process.env.ALLOW_FAKE_IP_RANGE || "auto", private readonly resolve: (host: string) => Promise<string[]> = async host => (await lookup(host, {all:true})).map(r=>r.address), private readonly now = Date.now) {}
  get allowed(): boolean { return this.mode() === "1" || (this.mode() === "auto" && this.detected && this.now() < this.expires); }
  async ensure(): Promise<void> {
    if (this.mode() !== "auto" || this.now() < this.expires) return;
    this.pending ??= (async () => {
      this.detected = false;
      const results = await Promise.all(FAKE_IP_PROBES.map(async host => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const addresses = await Promise.race([this.resolve(host), new Promise<string[]>(done => { timer = setTimeout(() => done([]), 2000); })]);
          return addresses.length > 0 && addresses.every(isFakeIp);
        } catch { return false; } finally { clearTimeout(timer); }
      }));
      this.detected = results.filter(Boolean).length >= 2;
      this.expires = this.now() + 5 * 60_000;
    })().finally(() => { this.pending = undefined; });
    await this.pending;
  }
}
export const fakeIpPolicy = new FakeIpPolicy();
export async function startAddressPolicy(): Promise<void> {
  await fakeIpPolicy.ensure();
  const timer = setInterval(() => { void fakeIpPolicy.ensure(); }, 5 * 60_000); timer.unref();
}
export function isPublicAddress(address: string, allowFake = fakeIpPolicy.allowed): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked4.check(address,"ipv4") && (!isFakeIp(address) || allowFake);
  if (family === 6) return !blocked6.check(address,"ipv6");
  return false;
}
