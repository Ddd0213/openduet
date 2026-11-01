// M20 (#1): the values of password, one-time-code and look-alike fields never reach the model
// (computer/masking.ts, the server's backstop on top of agent-computer's own masking). Pure.
import { describe, expect, test } from "bun:test";
import { isSensitiveName, maskElements, MASKED_VALUE, needsMask } from "../../src/computer/masking.ts";

describe("isSensitiveName", () => {
  test("passwords, PINs, one-time codes and card fields, in English and Chinese", () => {
    for (const name of ["Password", "Current password", "PIN", "Passcode", "One-time code", "Verification code", "Enter the code we sent", "Security code", "CVC", "CVV2", "Card number", "2FA code", "密码", "验证码", "短信验证码", "动态码", "卡号", "ＰＡＳＳＷＯＲＤ", "Pass\u200Bword"]) {
      expect([name, isSensitiveName(name)]).toEqual([name, true]);
    }
  });

  test("ordinary fields stay visible: zip / promo codes, passport, email, search", () => {
    for (const name of ["Email", "Username", "Search", "ZIP code", "Postal code", "Promo code", "Coupon code", "Country code", "Passport number", "Compass heading", "Spinning", "邮编", "优惠码", ""]) {
      expect([name, isSensitiveName(name)]).toEqual([name, false]);
    }
  });
});

describe("maskElements", () => {
  test("replaces only the value of a sensitive text field; everything else (options too) is kept", () => {
    const elements = [
      { ref: "e1", role: "textbox", name: "Email", value: "alex@example.com" },
      { ref: "e2", role: "textbox", name: "Password", value: "hunter2-secret" },
      { ref: "e3", role: "textbox", name: "验证码", value: "482913" },
      { ref: "e4", role: "combobox", name: "Country", value: "Norway", options: ["Norway", "Sweden"] },
      { ref: "e5", role: "button", name: "Password reset" },
      { ref: "e6", role: "textbox", name: "Password", value: "" },
    ];
    const masked: unknown[] = maskElements(elements);
    const [email, , , country, button, empty] = elements;
    expect(masked).toEqual([
      email,
      { ref: "e2", role: "textbox", name: "Password", value: MASKED_VALUE },
      { ref: "e3", role: "textbox", name: "验证码", value: MASKED_VALUE },
      country,
      button,
      empty,
    ]);
    expect(JSON.stringify(masked)).not.toContain("hunter2-secret");
    expect(JSON.stringify(masked)).not.toContain("482913");
    // The input isn't changed.
    expect(elements[1]?.value).toBe("hunter2-secret");
    expect(needsMask({ ref: "e7", role: "textbox", name: "PIN", value: MASKED_VALUE })).toBe(false);
  });
});
