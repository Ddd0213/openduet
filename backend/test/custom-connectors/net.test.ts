import { describe, expect, test } from "bun:test";
import { isPublicAddress } from "../../src/custom-connectors/net.ts";

describe("isPublicAddress", () => {
  test("fake-ip addresses require an enabled policy", () => {
    for (const address of ["198.18.0.201", "198.18.0.1", "198.19.255.254"]) {
      expect(isPublicAddress(address, false)).toBe(false);
      expect(isPublicAddress(address, true)).toBe(true);
    }
  });
  test("private, loopback, link-local, CGNAT and reserved addresses stay blocked", () => {
    for (const address of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "192.0.0.1", "224.0.0.1", "240.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a00:1"]) expect(isPublicAddress(address)).toBe(false);
  });
  test("neighbours of the fake-ip range are public; ordinary public addresses pass", () => {
    for (const address of ["198.17.255.255", "198.20.0.0", "93.184.216.34", "2606:4700::1111"]) expect(isPublicAddress(address)).toBe(true);
  });
  test("special-purpose IPv4 and IPv6 embedding/tunneling ranges are shared and blocked", () => {
    for (const address of ["192.0.0.8", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "2002:a9fe:a9fe::1", "2001::1", "2001:db8::1", "192.0.2.1"]) expect(isPublicAddress(address, true)).toBe(false);
  });
});
