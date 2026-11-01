// M20 (#5): inspectArguments finds credentials in a connector call's arguments (by field name, by
// value format, nested), not ordinary content (emails, phone numbers, page tokens), and its
// findings never carry the value.
import { describe, expect, test } from "bun:test";
import { credentialRefusal, describeFindings, inspectArguments, normalizedFieldName } from "../../src/agent/outbound-credentials.ts";

const findings = (args: unknown) => {
  const result = inspectArguments(args);
  return result.safe ? [] : result.findings;
};
const SECRET = "hunter2-correct-horse-battery";

describe("hits", () => {
  test("by field name, in every case / separator spelling", () => {
    for (const name of ["password", "Password", "PASSWD", "secret", "api_key", "apiKey", "API-KEY", "X-Api-Key", "x_api_key", "access_token", "accessToken", "refresh-token", "token", "private_key", "client_secret", "clientSecret", "Authorization", "credentials"]) {
      expect(findings({ [name]: SECRET })).toEqual([{ category: "credential_field", path: `$.${name}` }]);
    }
    expect(normalizedFieldName(" X-Api.Key ")).toBe("api_key");
  });

  test("by value format: Basic / Bearer, provider keys, PEM private keys, an Authorization line inside text", () => {
    const basic = `Basic ${Buffer.from("sam:hunter2").toString("base64")}`;
    const cases: [string, string][] = [
      [basic, "authorization_header"],
      ["Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123", "authorization_header"],
      ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345", "provider_token"],
      ["sk-proj-abcdefghijklmnopqrstuvwxyz", "provider_token"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "provider_token"],
      ["github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "provider_token"],
      ["AKIAIOSFODNN7EXAMPLE", "provider_token"],
      ["xoxb-1234567890-abcdefghij", "provider_token"],
      ["AIzaSyA-abcdefghijklmnopqrstuvwxyz12345", "provider_token"],
      ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----", "private_key"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----", "private_key"],
      ["curl -H 'Authorization: Bearer abcdef1234567890' https://api.example.com", "authorization_header"],
    ];
    for (const [value, category] of cases) expect(findings({ body: value })).toEqual([{ category, path: "$.body" }] as never);
  });

  test("nested paths: objects and arrays; a key that itself looks like a credential shows as [credential]", () => {
    const args = { message: { headers: [{ name: "x", value: "ok" }, { name: "auth", value: "Bearer abcdefghijklmnop0123" }] }, config: { db: { password: SECRET } }, "weird key!": "fine" };
    expect(findings(args)).toEqual([
      { category: "authorization_header", path: "$.message.headers[1].value" },
      { category: "credential_field", path: "$.config.db.password" },
    ]);
    expect(findings({ "ghp_abcdefghijklmnopqrstuvwxyz0123456789": 1 })).toEqual([{ category: "provider_token", path: "$.[credential]" }]);
  });

  test("too deep, too large or cyclic fails closed", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(inspectArguments(deep)).toEqual({ safe: false, reason: "inspection_limit", findings: [] });
    expect(inspectArguments({ list: Array.from({ length: 11_000 }, () => 1) })).toMatchObject({ safe: false, reason: "inspection_limit" });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(inspectArguments(cyclic)).toMatchObject({ safe: false, reason: "inspection_limit" });
  });
});

describe("no hits", () => {
  test("a normal email, phone numbers, ids, page tokens, empty / boolean credential fields", () => {
    const email = {
      recipient_email: "sam@example.com", cc: ["lee@example.org"], subject: "Q3 numbers", phone: "+1 415 555 0100",
      body: "Hi Sam,\n\nThe password reset went fine and the token of appreciation arrived. Bearer of good news: we hit the target.\nCall me at 415-555-0100.\n\nBest, Alex",
      thread_id: "18c2f0a9b7e4d3c1", page_token: "CAEQAhoTCJC1", next_page_token: "abc", max_results: 10,
      password: "", secret: false, token: null, has_api_key: true,
    };
    expect(inspectArguments(email)).toEqual({ safe: true });
    expect(inspectArguments({ query: "how do I rotate an api key", url: "https://example.com/docs/sk-guide" })).toEqual({ safe: true });
    expect(inspectArguments({ note: `Basic ${Buffer.from("hello world").toString("base64")}` })).toEqual({ safe: true });
    expect(inspectArguments({ note: "Bearer authentication is described in RFC 6750" })).toEqual({ safe: true });
  });
});

test("the refusal and the log text carry category and path, never the value", () => {
  const inspection = inspectArguments({ password: SECRET, nested: { key: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345" } });
  if (inspection.safe) throw new Error("expected a hit");
  const refusal = credentialRefusal(inspection);
  expect(refusal).toMatchObject({ status: "refused", findings: [{ category: "credential_field", path: "$.password" }, { category: "provider_token", path: "$.nested.key" }] });
  expect(refusal.error).toStartWith("Not sent:");
  const all = JSON.stringify(refusal) + describeFindings(inspection.findings);
  expect(all).not.toContain(SECRET);
  expect(all).not.toContain("sk-ant-api03");
  expect(describeFindings(inspection.findings)).toBe("credential_field at $.password, provider_token at $.nested.key");
});
