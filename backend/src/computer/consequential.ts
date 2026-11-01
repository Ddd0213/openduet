// M20 (#4): which clicks in the assistant's browser need the user's OK first. Pure: the provider looks the
// target up by ref in the server's own latest snapshot (the real accessible name, never what the
// model says it is) and asks here. A hit becomes a browser approval card (approvals
// requestBrowserAction); this is a backstop on top of ToolPolicy, so it errs towards asking.
//
// Matching: the accessible name, width-folded and lowercased (masking.ts foldName); English words
// and phrases match as whole words (so "Pay" hits, "PayPal" or "Display" don't); Chinese as
// written. The first category in PRIORITY that matches wins ("Delete account" is account, not
// delete; "Confirm order" is purchase, not submit). A checkout page (by URL) turns any button press
// or form submit on it into an ask too.
import type { BrowserActionCategory } from "../contract/m20.ts";
import { foldName } from "./masking.ts";

export type Via = "click" | "submit" | "enter";

/** What the server knows about the element a call acts on (from its latest snapshot). */
export interface ActionTarget { role: string; name: string }

export interface Consequence {
  category: BrowserActionCategory;
  /** the page itself looks like a checkout */
  checkoutPage: boolean;
}

const WORDS: Record<BrowserActionCategory, { en: string[]; zh: string[] }> = {
  purchase: {
    en: [
      "buy", "buy now", "pay", "pay now", "purchase", "place order", "place your order", "submit order", "complete order",
      "confirm order", "confirm purchase", "confirm payment", "complete purchase", "complete payment", "make payment",
      "checkout", "check out", "proceed to checkout", "proceed to payment", "subscribe", "start subscription", "upgrade",
      "donate", "send money", "transfer", "transfer money", "top up", "recharge", "bid", "place bid", "book and pay",
    ],
    zh: [
      "购买", "立即购买", "马上购买", "下单", "提交订单", "确认订单", "确认下单", "结算", "去结算", "立即结算", "结账", "去结账",
      "支付", "付款", "立即支付", "立即付款", "确认支付", "确认付款", "去支付", "去付款", "订阅", "开通", "续费", "充值",
      "转账", "汇款", "打赏", "捐款", "捐赠", "出价",
    ],
  },
  account: {
    en: [
      "change password", "reset password", "update password", "set password", "new password", "delete account",
      "delete my account", "close account", "close my account", "deactivate", "deactivate account", "remove account",
      "two-factor", "2-step verification", "two-step verification", "2fa", "security settings", "change email",
      "change phone number", "sign out of all devices", "log out of all devices", "revoke",
    ],
    zh: [
      "修改密码", "重置密码", "更改密码", "设置密码", "注销账号", "注销账户", "注销帐号", "删除账号", "删除账户", "删除帐号",
      "关闭账户", "关闭账号", "停用账号", "安全设置", "两步验证", "二次验证", "双重验证", "更换手机", "更换邮箱", "解绑",
      "退出所有设备",
    ],
  },
  delete: {
    en: ["delete", "delete forever", "delete permanently", "remove", "erase", "trash", "move to trash", "empty trash", "discard", "wipe"],
    zh: ["删除", "永久删除", "彻底删除", "移除", "清空", "清除", "移到回收站", "丢弃"],
  },
  send: {
    en: ["send", "send now", "post", "publish", "reply", "reply all", "share", "tweet", "retweet", "repost", "forward", "comment", "rsvp"],
    zh: ["发送", "发布", "发表", "回复", "全部回复", "转发", "分享", "评论", "留言", "发帖", "发消息", "私信"],
  },
  submit: {
    en: [
      "submit", "confirm", "book", "book now", "reserve", "reserve now", "register", "sign up", "enroll", "apply now",
      "submit application", "sign and submit", "e-sign", "sign contract", "sign document", "accept offer",
    ],
    zh: ["提交", "确认", "确认提交", "预订", "预约", "报名", "注册", "申请", "立即申请", "签署", "签约", "确认收货"],
  },
};

const PRIORITY: readonly BrowserActionCategory[] = ["purchase", "account", "delete", "send", "submit"];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One phrase as a whole-word pattern: its spaces match spaces or hyphens. */
const phrase = (value: string) => escape(value).replace(/[\s-]+/g, "[\\s-]+");

const MATCHERS = PRIORITY.map((category) => ({
  category,
  en: new RegExp(`(?<![\\p{L}\\p{N}])(?:${WORDS[category].en.map(phrase).join("|")})(?![\\p{L}\\p{N}])`, "iu"),
  zh: new RegExp(WORDS[category].zh.map(escape).join("|"), "u"),
}));

/** A name longer than this is page text (a long link), not a button label: never matched. */
const NAME_MAX = 200;

/** The category a button's accessible name falls in, or null. */
export function categoryOfName(name: string): BrowserActionCategory | null {
  const folded = foldName(name);
  if (!folded || folded.length > NAME_MAX) return null;
  for (const m of MATCHERS) if (m.en.test(folded) || m.zh.test(folded)) return m.category;
  return null;
}

/** Roles that do something when pressed. */
const ACTIVATORS = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "checkbox", "radio", "switch", "treeitem", "gridcell"]);
/** Roles a click only focuses. */
const FIELDS = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

const SEARCH_FIELD = /(?<![\p{L}\p{N}])(?:search|find|filter|query)(?![\p{L}\p{N}])|搜索|搜一搜|查找|筛选/iu;
const MESSAGE_FIELD = /(?<![\p{L}\p{N}])(?:message|messages|comment|comments|reply|post|tweet|chat|write a|say something|what's happening|what's on your mind)(?![\p{L}\p{N}])|消息|评论|回复|留言|说点什么|发表|聊天|私信|弹幕/iu;
const PASSWORD_FIELD = /(?<![\p{L}\p{N}])(?:password|passcode|pin)(?![\p{L}\p{N}])|密码|口令/iu;

const CHECKOUT_SEGMENTS = new Set([
  "checkout", "checkouts", "check-out", "payment", "payments", "pay", "billing", "purchase", "buy", "cashier", "order-confirm",
  "confirm-order", "orderconfirm", "place-order", "placeorder", "subscribe", "subscription", "upgrade", "donate", "spc",
]);
const CHECKOUT_HOSTS = ["checkout.", "pay.", "payment.", "payments.", "cashier.", "buy."];
const CHECKOUT_SITES = new Set(["trade.jd.com", "buy.taobao.com", "buy.tmall.com", "order.jd.com", "cashier.95516.com"]);

/** Does this URL look like a checkout / payment page? */
export function isCheckoutUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (CHECKOUT_SITES.has(host) || CHECKOUT_HOSTS.some((prefix) => host.startsWith(prefix))) return true;
  let path = parsed.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep it encoded */ }
  return path.toLowerCase().split(/[/_.]+/).some((segment) => CHECKOUT_SEGMENTS.has(segment));
}

/** Public suffixes with two labels that matter here (so "shop.example.co.uk" is "example.co.uk"). */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.cn", "net.cn", "org.cn", "gov.cn", "com.hk", "com.tw", "co.jp", "ne.jp", "or.jp",
  "com.au", "net.au", "org.au", "co.nz", "co.kr", "com.br", "com.mx", "com.sg", "co.in", "com.tr", "co.za",
]);

/** The registrable site of a URL (eTLD+1, approximately): "smile.amazon.co.uk" -> "amazon.co.uk". */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!host) return null;
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  return labels.slice(TWO_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join(".");
}

/**
 * Does this action need the user's OK? `target` is the element the server's latest snapshot has
 * for the call's ref (or the element the last type / click focused, for a bare Enter); null = not
 * known (only the checkout rule applies).
 */
export function consequenceOf(input: { via: Via; target: ActionTarget | null; url: string | null }): Consequence | null {
  const checkoutPage = isCheckoutUrl(input.url);
  const target = input.target;
  const byName = target ? categoryOfName(target.name) : null;
  const done = (category: BrowserActionCategory | null): Consequence | null => (category ? { category, checkoutPage } : null);
  if (!target) return done(checkoutPage && input.via !== "click" ? "purchase" : null);
  const role = target.role.toLowerCase();
  if (input.via === "click") {
    if (FIELDS.has(role)) return null; // a click into a field only focuses it
    return done(byName ?? (checkoutPage && role === "button" ? "purchase" : null));
  }
  // submit (type + Enter) or Enter on the element: a field submits its form, an activator acts.
  if (!FIELDS.has(role)) return done(byName ?? (checkoutPage && ACTIVATORS.has(role) && role !== "link" ? "purchase" : null));
  const folded = foldName(target.name);
  if (PASSWORD_FIELD.test(folded)) return done("account");
  if (byName) return done(byName);
  if (SEARCH_FIELD.test(folded)) return done(checkoutPage ? "purchase" : null);
  if (MESSAGE_FIELD.test(folded)) return done("send");
  return done(checkoutPage ? "purchase" : null);
}

/** Keys that activate the focused element: Enter (any modifiers) and, on a button, Space. */
export function activationOf(key: string): "enter" | "space" | null {
  const parts = key.split("+").map((part) => part.trim().toLowerCase());
  const main = parts.at(-1) ?? "";
  if (main === "enter" || main === "numpadenter" || main === "return") return "enter";
  if (main === "space" || main === " " || main === "spacebar") return "space";
  return null;
}

/** Keys that move focus away from what the last type / click focused. */
export function movesFocus(key: string): boolean {
  const main = (key.split("+").at(-1) ?? "").trim().toLowerCase();
  return main === "tab" || main.startsWith("arrow") || main === "pageup" || main === "pagedown" || main === "home" || main === "end" || main === "escape";
}

/** May Space on this element activate it (a button-like element, not a text field)? */
export const spaceActivates = (target: ActionTarget) => !FIELDS.has(target.role.toLowerCase());
