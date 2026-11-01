import { describe, expect, test } from "bun:test";
import { TextDecoder } from "node:util";
import { decodePage, webFetch, type Lookup } from "../../src/web/fetch.ts";
import type { Fetch } from "../../src/llm/index.ts";
const publicLookup: Lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const never: Fetch = async () => { throw new Error("must not fetch"); };
const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);
const encoded = (head: string, tail = "</body></html>") => new Uint8Array([...new TextEncoder().encode(head), ...gbk, ...new TextEncoder().encode(tail)]);

describe("web fetch", () => {
  test("GET with UA, manual redirects and GBK Chinese HTML conversion", async () => {
    let calls = 0;
    const result = await webFetch("https://public.example", { lookup: publicLookup, fetch: async (_, init) => {
      calls++; expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("user-agent")).toContain("OpenDuet");
      return new Response(encoded("<html><body><script>hidden</script><p>", "</p></body></html>"), { headers: { "content-type": "text/html; charset=gbk" } });
    } });
    expect(result).toMatchObject({ text: "中文" }); expect(calls).toBe(1);
  });

  test("charset priority: header, meta charset/http-equiv, BOM then UTF-8", () => {
    for (const head of ["<html><meta charset='gbk'><body>", '<html><meta content="text/html; charset=gb2312" http-equiv="Content-Type"><body>']) expect(decodePage(encoded(head), "text/html")).toContain("中文");
    expect(decodePage(encoded("<html><meta charset='utf-8'><body>"), "text/html; charset=gb2312")).toContain("中文");
    expect(decodePage(new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]), "")).toBe("中文");
    expect(decodePage(new TextEncoder().encode("默认中文"), "")).toBe("默认中文");
    expect(decodePage(gbk, "text/plain; charset=gb18030")).toBe("中文");
    expect(decodePage(Uint8Array.from([0xa4, 0xa4, 0xa4, 0xe5]), "text/plain; charset=big5")).toBe("中文");
    expect(() => decodePage(gbk, "text/plain; charset=invalid-charset")).toThrow();
    expect(new TextDecoder("gbk").decode(gbk)).toBe("中文");
  });

  for (const address of ["10.20.30.40", "127.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.1.2.3", "100.64.0.1", "224.0.0.1", "::1", "fe80::1", "fc00::1", "ff02::1", "::ffff:93.184.216.34"]) {
    test(`blocks DNS address ${address}`, async () => {
      let fetched = false;
      const result = await webFetch("https://private.example", { lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }], fetch: async () => { fetched = true; return new Response("unsafe"); } });
      expect(result).toMatchObject({ isError: true }); expect(fetched).toBe(false);
    });
  }

  test("checks every DNS answer, not only the first", async () => {
    expect(await webFetch("https://mixed.example", { fetch: never, lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }] })).toMatchObject({ isError: true, error: "Private or reserved addresses are not allowed" });
  });

  test("public first hop redirect to loopback is refused", async () => {
    let calls = 0;
    const result = await webFetch("https://public.example", { lookup: publicLookup, fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }); } });
    expect(result).toMatchObject({ isError: true }); expect(calls).toBe(1);
  });

  test("redirect host DNS is checked again", async () => {
    const hosts: string[] = []; let calls = 0;
    const result = await webFetch("https://public.example", { lookup: async host => { hosts.push(host); return [{ address: host === "public.example" ? "93.184.216.34" : "127.0.0.1", family: 4 }]; }, fetch: async () => { calls++; return new Response(null, { status: 301, headers: { location: "https://redirect.example" } }); } });
    expect(result).toMatchObject({ isError: true }); expect(hosts).toEqual(["public.example", "redirect.example"]); expect(calls).toBe(1);
  });

  test("allows five redirects but refuses the sixth", async () => {
    for (const count of [5, 6]) {
      let calls = 0;
      const result = await webFetch("https://public.example/0", { lookup: publicLookup, fetch: async () => ++calls <= count ? new Response(null, { status: 302, headers: { location: `/${calls}` } }) : new Response("done") });
      expect(result.isError ?? false).toBe(count === 6); expect(calls).toBe(6);
    }
  });

  for (const url of ["file:///etc/passwd", "ftp://public.example", "javascript:alert(1)", "http://127.1", "http://[::ffff:127.0.0.1]", "https://user:pass@public.example"]) test(`refuses ${url}`, async () => { expect(await webFetch(url, { lookup: publicLookup, fetch: never })).toMatchObject({ isError: true }); });

  test("2 MB body/header cap, text truncation, safe HTTP and transport errors", async () => {
    expect(await webFetch("https://public.example", { lookup: publicLookup, fetch: async () => new Response("x", { headers: { "content-length": "2097153" } }) })).toMatchObject({ isError: true, error: "Response exceeds 2 MB" });
    expect(await webFetch("https://public.example", { lookup: publicLookup, fetch: async () => new Response("x".repeat(2097153)) })).toMatchObject({ isError: true, error: "Response exceeds 2 MB" });
    const result = await webFetch("https://public.example", { lookup: publicLookup, fetch: async () => new Response("x".repeat(30000)) });
    expect("text" in result ? result.text.length : 0).toBe(20000);
    expect(await webFetch("https://public.example", { lookup: publicLookup, fetch: async () => new Response("secret", { status: 403 }) })).toMatchObject({ isError: true, error: "Page returned HTTP 403" });
    expect(await webFetch("https://public.example", { lookup: publicLookup, fetch: async () => { throw new Error("secret"); } })).toMatchObject({ isError: true, error: "Could not fetch page" });
  });

  test("external cancellation interrupts a non-cooperative fetch", async () => {
    const controller = new AbortController();
    const promise = webFetch("https://public.example", { lookup: publicLookup, signal: controller.signal, fetch: async () => { controller.abort(); return new Promise<Response>(() => {}); } });
    expect(await promise).toMatchObject({ isError: true, error: "Request timed out or cancelled" });
  });
});
