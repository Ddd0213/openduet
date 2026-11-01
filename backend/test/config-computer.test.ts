// M28 P2-8: reject invalid operator start pages at startup without echoing their values.
import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { testEnv } from "./helpers/db.ts";

const start = (value?: string) => loadConfig(testEnv({ COMPUTER_START_URL: value })).COMPUTER_START_URL;

describe("COMPUTER_START_URL", () => {
  test("unset or blank keeps the regional default", () => {
    for (const value of [undefined, "", "   "]) expect(start(value)).toBeUndefined();
  });

  test("accepts credential-free http(s), query/fragment and exactly 2000 characters", () => {
    for (const value of ["http://start.example/", "https://start.example/path?q=1#x", "https://例子.中国/", "http://localhost:8080/"]) {
      expect(start(value)).toBe(value);
    }
    const prefix = "https://start.example/";
    const boundary = prefix + "x".repeat(2000 - prefix.length);
    expect(boundary).toHaveLength(2000);
    expect(start(boundary)).toBe(boundary);
  });

  test("names the setting and the http(s) rule for malformed or non-web addresses", () => {
    for (const value of ["not a URL", "https://", "javascript:alert(1)", "file:///etc/passwd", "data:text/plain,x", "ftp://start.example/", "about:blank"]) {
      expect(() => start(value)).toThrow("COMPUTER_START_URL must be an http(s) web address");
    }
  });

  test("rejects user name, password and encoded/normalized userinfo without leaking the value", () => {
    for (const value of ["https://test-user:test-pass@start.example/", "https://test-user@start.example/", "https://:test-pass@start.example/", "HtTpS://u%40name:p%40ss@start.example/", "https:\\test-user:test-pass@start.example/"]) {
      try {
        start(value);
        throw new Error("expected configuration error");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).problems).toContain("COMPUTER_START_URL must not include a user name or password");
        expect((error as Error).message).not.toContain(value);
        expect((error as Error).message).not.toContain("test-pass");
      }
    }
  });

  test("rejects 2001 characters with the variable name and limit", () => {
    const prefix = "https://start.example/";
    expect(() => start(prefix + "x".repeat(2001 - prefix.length))).toThrow("COMPUTER_START_URL must be at most 2000 characters");
  });
});
