import { describe, expect, test } from "bun:test";
import { weather } from "../../src/builtins/weather.ts";
import { WMO, weatherWords } from "../../src/builtins/wmo.ts";
import { exchangeRate } from "../../src/builtins/rates.ts";
import { readFeed, parseFeed } from "../../src/builtins/feed.ts";
import { connectorList, UNREACHABLE } from "../../src/builtins/state.ts";
import type { Fetch } from "../../src/llm/index.ts";
import { FAHRENHEIT_REGIONS } from "../../src/contract/m25.ts";

const location = { name: "Tokyo", admin1: "Tokyo", country: "Japan", country_code: "JP", latitude: 35.68, longitude: 139.69, timezone: "Asia/Tokyo" };
const forecast = {
  current: { time: "2026-10-30T12:00", temperature_2m: 20, apparent_temperature: 19, weather_code: 2, wind_speed_10m: 10, precipitation: 0 },
  daily: { time: ["2026-10-30", "2026-10-31", "2026-11-01"], weather_code: [0, 61, 95], temperature_2m_max: [22, 23, 24], temperature_2m_min: [12, 13, 14], precipitation_probability_max: [0, 30, 50], precipitation_sum: [0, 1, 2] },
};
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const feedUrl = "https://example.com/rss";
const rss = (items = "") => `<rss version="2.0"><channel><title>News &amp; updates</title><link>https://example.com/</link>${items}</channel></rss>`;

describe("weather", () => {
  for (const region of [...FAHRENHEIT_REGIONS, "CN", "DE", "JP", "001", null]) {
    test(`units from region ${region}`, async () => {
      const urls: URL[] = [];
      const fetch: Fetch = async raw => { const url = new URL(String(raw)); urls.push(url); return Response.json(url.pathname === "/v1/search" ? { results: [location] } : forecast); };
      const result = await weather({ place: "Tokyo", days: 2 }, { region, language: "en" }, {}, { fetch });
      const unit = region && FAHRENHEIT_REGIONS.includes(region) ? "fahrenheit" : "celsius";
      expect(result).toMatchObject({ place: { name: "Tokyo", admin: "Tokyo", timezone: "Asia/Tokyo" }, unit, current: { weather: "Partly cloudy", windSpeed: 10, precipitation: 0 }, attribution: "Weather data by Open-Meteo.com" });
      if (!("daily" in result) || !result.daily) throw new Error("missing forecast");
      expect(result.daily).toHaveLength(2); expect(result.daily[1]).toEqual({ date: "2026-10-31", weather: "Slight rain", high: 23, low: 13, precipitationChance: 30, precipitation: 1 });
      expect(urls[1]!.searchParams.get("temperature_unit")).toBe(unit);
      expect(urls[1]!.searchParams.get("wind_speed_unit")).toBe(unit === "fahrenheit" ? "mph" : "kmh");
      expect(urls[1]!.searchParams.get("timezone")).toBe("Asia/Tokyo");
      expect(urls[0]!.searchParams.get("language")).toBe("en");
    });
  }
  test("explicit units, zh language and paid/self-run endpoints; no key leaked", async () => {
    const config = { OPEN_METEO_URL: "https://weather.example/v1/forecast", OPEN_METEO_GEOCODING_URL: "https://geo.example", OPEN_METEO_API_KEY: "test-secret" };
    const result = await weather({ place: "东京", unit: "celsius" }, { region: "US", language: "zh-Hans" }, config, { fetch: async raw => {
      const url = new URL(String(raw)); expect(url.searchParams.get("apikey")).toBe("test-secret");
      if (url.hostname === "geo.example") { expect(url.searchParams.get("language")).toBe("zh"); return Response.json({ results: [location] }); }
      expect(url.hostname).toBe("weather.example"); expect(url.searchParams.get("temperature_unit")).toBe("celsius"); return Response.json(forecast);
    } });
    expect(result).toMatchObject({ unit: "celsius", current: { weather: "局部多云" } });
    expect(JSON.stringify(result)).not.toContain("test-secret"); expect(connectorList(config).connectors[1]!.keyless).toBe(false);
  });
  test("same-name places require a question; region match first; no forecast request", async () => {
    let calls = 0;
    const result = await weather({ place: "Paris" }, { region: "FR", language: "en" }, {}, { fetch: async () => {
      calls++; return Response.json({ results: Array.from({ length: 5 }, (_, i) => ({ ...location, name: "Paris", latitude: i, country: i === 2 ? "France" : "Other", country_code: i === 2 ? "FR" : "US" })) });
    } });
    expect(calls).toBe(1); expect(result).toMatchObject({ ambiguous: true, places: [{ country: "France" }, {}, {}] });
  });
  // Open-Meteo's real populations (2026-10-29): 杭州 Zhejiang 11,936,010 / Sichuan none; London GB 8,961,989 / Ontario 422,324 / Ohio 10,060.
  const place = (name: string, admin1: string, country_code: string, population: number | null, latitude: number) => ({ ...location, name, admin1, country: country_code, country_code, population, latitude });
  const hangzhou = [place("杭州", "浙江", "CN", 11_936_010, 30.29), place("杭州", "四川", "CN", null, 30.07)];
  const london = [place("London", "England", "GB", 8_961_989, 51.5), place("London", "Ontario", "CA", 422_324, 42.98), place("London", "Ohio", "US", 10_060, 39.89)];
  const springfield = [place("Springfield", "Missouri", "US", 170_188, 37.2), place("Springfield", "Illinois", "US", 114_394, 39.8)];
  const chaoyang = [place("朝阳", "重庆市", "CN", 13_524, 29.5), place("朝阳", "山西", "CN", null, 37.4), place("朝阳", "吉林", "CN", null, 43.4)];
  for (const [label, results, region, expected] of [
    ["a city 10x larger than its namesakes is picked", hangzhou, "CN", "浙江"],
    ["…also from abroad, over a smaller one in the user's country", london, "US", "England"],
    ["no region", london, null, "England"],
    ["a city of that name in the user's own country asks", london, "CA", null],
    ["two cities of a similar size ask", springfield, "US", null],
    ["missing or small populations ask", chaoyang, "CN", null],
  ] as const) test(`same-name places: ${label}`, async () => {
    const urls: URL[] = [];
    const result = await weather({ place: results[0]!.name }, { region, language: "en" }, {}, { fetch: async raw => { const url = new URL(String(raw)); urls.push(url); return Response.json(url.pathname === "/v1/search" ? { results } : forecast); } });
    if (expected === null) { expect(result).toMatchObject({ ambiguous: true }); expect(urls).toHaveLength(1); return; }
    const chosen = results.find(p => p.admin1 === expected)!;
    expect(result).toMatchObject({ place: { admin: expected } }); expect(urls[1]!.searchParams.get("latitude")).toBe(String(chosen.latitude));
  });
  test("limits and empty place; every WMO code has en/zh, unknown doesn't guess", async () => {
    for (const raw of [{ place: "" }, { place: "x", days: 8 }, { place: "x", days: 0 }, { place: "x", unit: "kelvin" }]) {
      expect(await weather(raw, { region: null, language: "en" }, {}, { fetch: async () => { throw new Error("no network"); } })).toMatchObject({ isError: true, error: "Invalid weather arguments" });
    }
    expect(Object.keys(WMO)).toHaveLength(28);
    for (const code of Object.keys(WMO).map(Number)) { expect(weatherWords(code, "en")).toMatch(/[A-Za-z]/); expect(weatherWords(code, "zh-Hans")).toMatch(/[\u4e00-\u9fff]/); }
    expect(weatherWords(1000, "en")).toBe("Unknown weather conditions"); expect(weatherWords(null, "zh-Hans")).toBe("天气状况未知");
  });
});

describe("exchange rates", () => {
  test("ECB v1 rates, exact local multiplication, historical date, identity and limits", async () => {
    const urls: URL[] = [];
    const fetch: Fetch = async raw => { const url = new URL(String(raw)); urls.push(url); return Response.json(url.pathname.endsWith("currencies") ? { USD: "Dollar", EUR: "Euro" } : { base: "USD", date: "2026-10-28", rates: { EUR: 0.91234 } }); };
    expect(await exchangeRate({ base: "usd", quotes: ["EUR", "USD"], amount: 12.34, date: "2026-10-29" }, {}, { fetch })).toEqual({ base: "USD", date: "2026-10-28", amount: 12.34, rates: { EUR: 0.91234, USD: 1 }, converted: { EUR: 12.34 * 0.91234, USD: 12.34 }, source: "Frankfurter (European Central Bank reference rates)" });
    expect(urls[1]!.pathname).toBe("/v1/2026-10-29"); expect(urls[1]!.searchParams.get("symbols")).toBe("EUR"); expect(urls.every(u => !u.searchParams.has("amount"))).toBe(true);
    for (const raw of [{ base: "USD", quotes: [] }, { base: "USD", quotes: Array(11).fill("EUR") }, { base: "USD", quotes: ["EUR"], amount: 0 }, { base: "USD", quotes: ["EUR"], date: "2026-02-30" }]) expect(await exchangeRate(raw, {}, { fetch })).toMatchObject({ isError: true, error: "Invalid exchange rate arguments" });
  });
  test("unknown currency names the code, without treating it as an outage", async () => {
    const config = {}; expect(await exchangeRate({ base: "ZZZ", quotes: ["EUR"] }, config, { fetch: async () => Response.json({ EUR: "Euro" }) })).toMatchObject({ isError: true, error: "Unknown or unsupported currency: ZZZ" });
    expect(connectorList(config).connectors[2]!.state).toBe("on");
  });
});

describe("feeds", () => {
  test("RSS 2: parse all items before cutting, CDATA, entities, dates, newest first, summary cap", () => {
    const xml = rss(Array.from({ length: 25 }, (_, i) => `<item><title>Item &#${65 + i};</title><link>https://example.com/${i}?a=1&amp;b=2</link><pubDate>${new Date(Date.UTC(2026, 9, i + 1)).toUTCString()}</pubDate><description><![CDATA[<p>Hello &amp; ${"long ".repeat(500)}</p>]]></description></item>`).join(""));
    expect(xml.length).toBeGreaterThan(20_000);
    const result = parseFeed(xml, feedUrl, 20); expect(result.feed).toEqual({ title: "News & updates", link: "https://example.com/" }); expect(result.items).toHaveLength(20);
    expect(result.items[0]).toMatchObject({ title: "Item Y", published: "2026-10-25T00:00:00.000Z", link: "https://example.com/24?a=1&b=2" });
    for (const item of result.items) { expect(item.summary.length).toBeLessThanOrEqual(300); expect(item.summary).toStartWith("Hello & long"); }
  });
  test("RSS 1 RDF sibling items and dc:date", () => {
    const result = parseFeed('<rdf:RDF xmlns:rdf="urn:rdf" xmlns:dc="urn:dc"><channel><title>RDF</title><link>https://example.com</link></channel><item><title>One</title><link>/one</link><dc:date>2026-01-01T00:00:00Z</dc:date><description>Text</description></item></rdf:RDF>', feedUrl);
    expect(result.items[0]).toEqual({ title: "One", link: "https://example.com/one", published: "2026-01-01T00:00:00.000Z", summary: "Text" });
  });
  test("Atom alternate link, relative xml:base, HTML/XHTML, missing dates, dangerous links", () => {
    const result = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom" xml:base="/news/"><title>Atom</title><link rel="self" href="/feed"/><link rel="alternate" href="./"/><entry><title>Hello</title><link rel="enclosure" href="/audio"/><link href="one"/><updated>2026-02-01T00:00:00Z</updated><content type="xhtml"><div><p>Hello <b>world</b></p></div></content></entry><entry><title>Second</title><link href="javascript:alert(1)"/><summary type="html">&lt;p&gt;A &amp;amp; B&lt;/p&gt;</summary></entry></feed>', feedUrl);
    expect(result.feed.link).toBe("https://example.com/news/"); expect(result.items[0]).toMatchObject({ link: "https://example.com/news/one", summary: "Hello world" }); expect(result.items[1]).toMatchObject({ published: null, link: null, summary: "A & B" });
  });
  test("non-feed, DTD/XXE, malformed XML and deep nesting are refused", () => {
    for (const xml of ["<html><body>Page</body></html>", "<!DOCTYPE html><html>page</html>"]) expect(() => parseFeed(xml, feedUrl)).toThrow("web_fetch");
    for (const xml of ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + rss(), rss("<item></wrong>"), rss("&unknown;"), rss("<a>".repeat(70) + "</a>".repeat(70))]) expect(() => parseFeed(xml, feedUrl)).toThrow();
  });
  test("charset declaration, limit validation, size bound", async () => {
    const xml = '<?xml version="1.0" encoding="windows-1252"?>' + rss("<item><title>caf\xe9</title></item>");
    const result = await readFeed({ url: feedUrl }, {}, { lookup: publicLookup, fetch: async () => new Response(Buffer.from(xml, "latin1")) });
    expect(result).toMatchObject({ items: [{ title: "café" }] });
    expect(await readFeed({ url: feedUrl, limit: 21 }, {})).toMatchObject({ isError: true, error: "Invalid feed arguments" });
    expect(await readFeed({ url: feedUrl }, {}, { lookup: publicLookup, fetch: async () => new Response("x", { headers: { "content-length": String(3 * 1024 * 1024) } }) })).toMatchObject({ isError: true, error: "Response exceeds 2 MB" });
  });
  test("private DNS, literal, and redirect addresses are refused; 5 redirects maximum", async () => {
    let calls = 0;
    const fetch: Fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }); };
    expect(await readFeed({ url: feedUrl }, {}, { lookup: async () => [{ address: "10.0.0.1", family: 4 }], fetch })).toMatchObject({ isError: true, error: "Private or reserved addresses are not allowed" }); expect(calls).toBe(0);
    expect(await readFeed({ url: "http://[::1]/" }, {}, { fetch })).toMatchObject({ isError: true }); expect(calls).toBe(0);
    expect(await readFeed({ url: feedUrl }, {}, { lookup: publicLookup, fetch })).toMatchObject({ isError: true, error: "Private or reserved addresses are not allowed" }); expect(calls).toBe(1);
    expect(await readFeed({ url: feedUrl }, {}, { lookup: publicLookup, fetch: async () => new Response(null, { status: 302, headers: { location: feedUrl } }) })).toMatchObject({ isError: true, error: "Too many redirects (maximum 5)" });
  });
});

test("each tool reports unreachable and recovers; disabled tools make no request", async () => {
  for (const id of ["weather", "exchange_rate", "read_feed"] as const) {
    const config = {}; let failed = true, calls = 0;
    const fetch: Fetch = async raw => {
      calls++; if (failed) return new Response("secret", { status: 503 });
      const path = new URL(String(raw)).pathname;
      return id === "weather" ? Response.json(path.endsWith("search") ? { results: [location] } : forecast) : id === "exchange_rate" ? Response.json(path.endsWith("currencies") ? { USD: "Dollar", EUR: "Euro" } : { base: "USD", date: "2026-10-29", rates: { EUR: 0.9 } }) : new Response(rss());
    };
    const run = (cfg: Parameters<typeof weather>[2]) => id === "weather" ? weather({ place: "Tokyo" }, { region: null, language: "en" }, cfg, { fetch }) : id === "exchange_rate" ? exchangeRate({ base: "USD", quotes: ["EUR"] }, cfg, { fetch }) : readFeed({ url: feedUrl }, cfg, { fetch, lookup: publicLookup });
    expect(await run(config)).toEqual({ isError: true, error: UNREACHABLE }); expect(connectorList(config).connectors.find(c => c.id === id)!.state).toBe("unreachable");
    failed = false; await run(config); expect(connectorList(config).connectors.find(c => c.id === id)!.state).toBe("on");
    const before = calls; expect(await run({ BUILTIN_CONNECTORS_OFF: [id] })).toMatchObject({ isError: true }); expect(calls).toBe(before);
  }
});
