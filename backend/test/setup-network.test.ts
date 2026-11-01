import { expect, test } from "bun:test";
import { resolve } from "node:path";
const helper = resolve(import.meta.dir, "../../scripts/setup-network.sh");
function check(command: string, input = "") {
  return Bun.spawnSync(["bash", "-c", `source "$1"; ${command}`, "test", helper], { stdin: Buffer.from(input) });
}
test("non-interactive setup requires an explicit mode", () => {
  expect(check('require_explicit_mode 0 ""').exitCode).toBe(1);
  expect(check('require_explicit_mode 0 caddy').exitCode).toBe(0);
  expect(check('require_explicit_mode 1 ""').exitCode).toBe(0);
});
test("local ranges and dual-stack public default routes", () => {
  for (const ip of ["10.0.0.1", "172.31.0.1", "192.168.1.1", "100.64.0.1", "169.254.1.1", "fd00::1", "fe80::1"]) {
    expect(check(`is_local_address '${ip}'`).exitCode).toBe(0);
  }
  expect(check("route_exposure '192.168.1.2 2001:4860::1'").stdout.toString()).toBe("public");
  expect(check("route_exposure ''").stdout.toString()).toBe("unknown");
});
test("LAN public/unknown addresses fail closed unless explicitly bound or confirmed", () => {
  expect(check('check_lan_binding 0.0.0.0 "" public 1').exitCode).toBe(1);
  expect(check('check_lan_binding 0.0.0.0 "" unknown 0').exitCode).toBe(1);
  expect(check('check_lan_binding 0.0.0.0 0.0.0.0 public 0').exitCode).toBe(0);
  expect(check('check_lan_binding 0.0.0.0 "" local 0').exitCode).toBe(0);
  expect(check('check_lan_binding 0.0.0.0 "" unknown 1', "no\n").exitCode).toBe(1);
  expect(check('check_lan_binding 0.0.0.0 "" unknown 1', "yes\n").exitCode).toBe(0);
});
test("fresh LAN defaults are checked as 0.0.0.0; existing and explicit binds are kept", () => {
  expect(check('select_lan_bind "" 127.0.0.1 1').stdout.toString()).toBe("0.0.0.0");
  expect(check('select_lan_bind "" 127.0.0.1 0').stdout.toString()).toBe("127.0.0.1");
  expect(check('select_lan_bind 192.168.1.2 127.0.0.1 1').stdout.toString()).toBe("192.168.1.2");
});
test("Linux default-route probes inspect both families and macOS uses the routed interfaces", () => {
  const linux = check(`ip() { if [ "$1" = -4 ]; then printf '1.1.1.1 dev eth0 src 192.168.1.2\\n'; else printf '2606:4700::1111 dev eth0 src 2001:4860::2\\n'; fi; }; route_exposure "$(default_route_addresses)"`);
  expect(linux.stdout.toString()).toBe("public");
  const mac = check(`command() { if [ "$1" = -v ] && [ "$2" = ip ]; then return 1; fi; builtin command "$@"; }; route() { case "$*" in *-inet6*) printf 'interface: en6\\n' ;; *) printf 'interface: en9\\n' ;; esac; }; ipconfig() { [ "$2" = en9 ] && printf '192.168.1.2\\n'; }; ifconfig() { [ "$1" = en6 ] && printf 'inet6 fd00::2 prefixlen 64\\n'; }; default_route_addresses`);
  expect(mac.stdout.toString().trim()).toBe("192.168.1.2\nfd00::2");
});
