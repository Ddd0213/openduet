// M20 (#4): which clicks in Claude's browser ask first (computer/consequential.ts). Pure.
import { describe, expect, test } from "bun:test";
import { activationOf, categoryOfName, consequenceOf, isCheckoutUrl, movesFocus, siteOf, spaceActivates } from "../../src/computer/consequential.ts";

describe("categoryOfName", () => {
  test("English: whole words, any case or width; the first category wins", () => {
    expect(categoryOfName("Buy now")).toBe("purchase");
    expect(categoryOfName("Place your order")).toBe("purchase");
    expect(categoryOfName("PAY")).toBe("purchase");
    expect(categoryOfName("Ｐａｙ ｎｏｗ")).toBe("purchase");
    expect(categoryOfName("Proceed to checkout")).toBe("purchase");
    expect(categoryOfName("Delete account")).toBe("account");
    expect(categoryOfName("Change password")).toBe("account");
    expect(categoryOfName("Delete")).toBe("delete");
    expect(categoryOfName("Move to trash")).toBe("delete");
    expect(categoryOfName("Send")).toBe("send");
    expect(categoryOfName("Reply all")).toBe("send");
    expect(categoryOfName("Post")).toBe("send");
    expect(categoryOfName("Submit")).toBe("submit");
    expect(categoryOfName("Sign up")).toBe("submit");
    expect(categoryOfName("Confirm order")).toBe("purchase");
  });

  test("English look-alikes don't match: PayPal, Display, Sender, Posted, Repay", () => {
    for (const name of ["PayPal", "Display settings", "Sender name", "Posted 2 days ago", "Repayment plan", "Sign in", "Search", "Next", "Learn more", "Booking.com reviews"]) {
      expect([name, categoryOfName(name)]).toEqual([name, null]);
    }
  });

  test("Chinese as written", () => {
    expect(categoryOfName("立即购买")).toBe("purchase");
    expect(categoryOfName("提交订单")).toBe("purchase");
    expect(categoryOfName("去结算")).toBe("purchase");
    expect(categoryOfName("注销账号")).toBe("account");
    expect(categoryOfName("删除")).toBe("delete");
    expect(categoryOfName("发送")).toBe("send");
    expect(categoryOfName("提交")).toBe("submit");
    expect(categoryOfName("登录")).toBeNull();
    expect(categoryOfName("搜索")).toBeNull();
  });

  test("a long name is page text, not a button", () => {
    expect(categoryOfName(`${"x ".repeat(150)} buy`)).toBeNull();
    expect(categoryOfName("")).toBeNull();
  });
});

describe("consequenceOf", () => {
  const plain = "https://shop.example.com/products/42";
  const checkout = "https://shop.example.com/checkout";

  test("a click on a named button asks; a click into a field doesn't", () => {
    expect(consequenceOf({ via: "click", target: { role: "button", name: "Place order" }, url: plain })).toEqual({ category: "purchase", checkoutPage: false });
    expect(consequenceOf({ via: "click", target: { role: "link", name: "Delete" }, url: plain })).toEqual({ category: "delete", checkoutPage: false });
    expect(consequenceOf({ via: "click", target: { role: "textbox", name: "Pay amount" }, url: plain })).toBeNull();
    expect(consequenceOf({ via: "click", target: { role: "button", name: "Next" }, url: plain })).toBeNull();
  });

  test("on a checkout page every button asks (purchase); links and fields don't", () => {
    expect(consequenceOf({ via: "click", target: { role: "button", name: "Continue" }, url: checkout })).toEqual({ category: "purchase", checkoutPage: true });
    expect(consequenceOf({ via: "click", target: { role: "link", name: "Back to cart" }, url: checkout })).toBeNull();
    expect(consequenceOf({ via: "click", target: { role: "textbox", name: "Card number" }, url: checkout })).toBeNull();
  });

  test("a submit or Enter in a field: password fields are account, message boxes send, search doesn't ask", () => {
    expect(consequenceOf({ via: "submit", target: { role: "textbox", name: "New password" }, url: plain })?.category).toBe("account");
    expect(consequenceOf({ via: "enter", target: { role: "textbox", name: "Write a message" }, url: plain })?.category).toBe("send");
    expect(consequenceOf({ via: "enter", target: { role: "textbox", name: "评论" }, url: plain })?.category).toBe("send");
    expect(consequenceOf({ via: "submit", target: { role: "searchbox", name: "Search" }, url: plain })).toBeNull();
    expect(consequenceOf({ via: "submit", target: { role: "textbox", name: "Email" }, url: plain })).toBeNull();
    expect(consequenceOf({ via: "submit", target: { role: "textbox", name: "Email" }, url: checkout })?.category).toBe("purchase");
  });

  test("Enter on a focused button acts like a click on it; nothing known: only the checkout rule", () => {
    expect(consequenceOf({ via: "enter", target: { role: "button", name: "Send" }, url: plain })?.category).toBe("send");
    expect(consequenceOf({ via: "enter", target: null, url: plain })).toBeNull();
    expect(consequenceOf({ via: "enter", target: null, url: checkout })).toEqual({ category: "purchase", checkoutPage: true });
    expect(consequenceOf({ via: "click", target: null, url: checkout })).toBeNull();
  });
});

describe("pages and keys", () => {
  test("checkout URLs", () => {
    for (const url of ["https://shop.example.com/checkout", "https://www.amazon.com/gp/buy/spc/handlers/display.html", "https://checkout.stripe.com/c/pay/cs_test", "https://pay.example.org/", "https://trade.jd.com/shopping/order/getOrderInfo.action", "https://example.com/cart/place-order"]) {
      expect([url, isCheckoutUrl(url)]).toEqual([url, true]);
    }
    for (const url of ["https://blog.example.com/how-to-pay-less-tax", "https://example.com/paypal-review", "about:blank", "not a url", null]) {
      expect([url, isCheckoutUrl(url)]).toEqual([url, false]);
    }
  });

  test("the registrable site", () => {
    expect(siteOf("https://smile.amazon.co.uk/gp/cart")).toBe("amazon.co.uk");
    expect(siteOf("https://www.github.com/settings")).toBe("github.com");
    expect(siteOf("https://item.taobao.com/x")).toBe("taobao.com");
    expect(siteOf("https://example.com/")).toBe("example.com");
    expect(siteOf("http://127.0.0.1:8080/")).toBe("127.0.0.1");
    expect(siteOf("about:blank")).toBeNull();
    expect(siteOf(null)).toBeNull();
  });

  test("keys that activate or move focus", () => {
    expect(activationOf("Enter")).toBe("enter");
    expect(activationOf("Control+Enter")).toBe("enter");
    expect(activationOf("Space")).toBe("space");
    expect(activationOf("Tab")).toBeNull();
    expect(movesFocus("Shift+Tab")).toBe(true);
    expect(movesFocus("ArrowDown")).toBe(true);
    expect(movesFocus("Enter")).toBe(false);
    expect(spaceActivates({ role: "button", name: "Send" })).toBe(true);
    expect(spaceActivates({ role: "textbox", name: "Message" })).toBe(false);
  });
});
