import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { FakeIpPolicy, isPublicAddress } from "../src/network/address-policy.ts";
import { resolvePublic } from "../src/custom-connectors/net.ts";
import { webFetch } from "../src/web/fetch.ts";

test("fake-IP auto starts closed, requires two probes and rechecks, including failure", async () => {
  let now = 0, answers = ["198.18.1.1"], calls = 0;
  const p = new FakeIpPolicy(() => "auto", async () => { calls++; return answers; }, () => now);
  expect(p.allowed).toBe(false); await p.ensure(); expect(p.allowed).toBe(true);
  await p.ensure(); expect(calls).toBe(3);
  now += 300_001; answers = ["8.8.8.8"]; expect(p.allowed).toBe(false);
  await p.ensure(); expect(p.allowed).toBe(false);
  const failed = new FakeIpPolicy(() => "auto", async () => { throw Error("DNS"); });
  await failed.ensure(); expect(failed.allowed).toBe(false);
  const one = new FakeIpPolicy(() => "auto", async h => h === "github.com" ? ["198.18.1.1"] : []);
  await one.ensure(); expect(one.allowed).toBe(false);
  for (const mode of ["1", "0"]) {
    const forced = new FakeIpPolicy(() => mode, async () => { throw Error("must not resolve"); });
    await forced.ensure(); expect(forced.allowed).toBe(mode === "1");
  }
});
test("egress uses the same forced/auto policy without executing the entrypoint", () => {
  const helper = resolve(import.meta.dir, "../../egress/fake-ip.sh");
  for (const [mode, answer, ok] of [["auto", "198.18.1.1", true], ["auto", "8.8.8.8", false], ["auto", "", false], ["1", "", true], ["0", "198.18.1.1", false]] as const) {
    const p = Bun.spawnSync(["sh", "-c", '. "$1"; resolve_probe() { printf "%s" "$ANSWER"; }; fake_ip_allowed', "test", helper], { env: { ...process.env, ALLOW_FAKE_IP_RANGE: mode, ANSWER: answer } });
    expect(p.exitCode === 0).toBe(ok);
  }
});
test("both outbound guards reject newly blocked embedding ranges", async () => {
  for (const ip of ["192.0.0.8", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "2002::1", "2001::1"]) {
    expect(isPublicAddress(ip, true)).toBe(false);
    const lookup = async () => [{ address: ip, family: ip.includes(":") ? 6 : 4 }];
    await expect(resolvePublic("example.com", lookup)).rejects.toThrow(/private or reserved/);
    const result = await webFetch("https://example.com", { lookup, fetch: async () => { throw Error("must not fetch"); } });
    expect(result).toMatchObject({ isError: true, error: "Private or reserved addresses are not allowed" });
  }
});
test("egress DNS parsing includes IPv6 and mixed probe answers fail closed", () => {
  const helper = resolve(import.meta.dir, "../../egress/fake-ip.sh");
  const p = Bun.spawnSync(["sh", "-c", `. "$1"; nslookup() { printf 'Server: resolver\\nAddress: 198.18.0.53\\nName: example\\nAddress 1: 198.18.0.1\\nAddress 2: 2606:4700::1111\\n'; }; resolve_probe example; fake_ip_allowed`, "test", helper], { env: { ...process.env, ALLOW_FAKE_IP_RANGE: "auto" } });
  expect(p.stdout.toString().trim()).toBe("198.18.0.1\n2606:4700::1111");
  expect(p.exitCode).toBe(1);
});
