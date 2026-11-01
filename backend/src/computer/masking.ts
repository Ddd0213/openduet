// M20 (#1): the values of password, one-time-code and look-alike fields never reach the model.
// Playwright's aria snapshot reports a textbox's current value, and for <input type=password>
// that is the password in plain text, so a login typed through the sign-in card (or by the user
// during Take over) would show up in the assistant's next computer_snapshot. agent-computer da9a3ca masks
// those fields itself (secret-masking.ts, from the DOM: type=password, autocomplete one-time-code /
// current-password / new-password / cc-number / cc-csc, fields a secret was typed into). This is the
// server's own backstop on top of it, by the accessible name, for a page or an image that slips
// through: same placeholder, so the model reads one convention.

/** What a sensitive value is replaced with (the same text agent-computer uses). */
export const MASKED_VALUE = "[hidden: sensitive field]";

/** Roles whose `value` in a snapshot is text somebody typed. */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** Names that always mean a secret (English, whole words; Chinese, as written). */
const SECRET_NAME = new RegExp([
  String.raw`(?<![\p{L}\p{N}])(?:pass(?:word|code|phrase)?|pwd|pin|otp|totp|2fa|mfa|cvc|cvv|cvv2|csc)(?![\p{L}\p{N}])`,
  String.raw`one[\s-]?time|verification|card\s*number|credit\s*card|security\s*code`,
  "密码|口令|验证码|校验码|动态码|安全码|短信码|一次性|卡号|信用卡",
].join("|"), "iu");

/** "code" alone is a secret unless the name says it's a postal, country or promo code. */
const CODE_WORD = /(?<![\p{L}\p{N}])code(?![\p{L}\p{N}])/iu;
const PLAIN_CODE = /(?<![\p{L}\p{N}])(?:zip|postal|post|country|area|dial(?:ing)?|promo(?:tion(?:al)?)?|coupon|discount|gift|voucher|referral|invite|invitation|tracking|source|product|item|sku|language|currency)(?![\p{L}\p{N}])|邮编|邮政|国家|区号|优惠|折扣|礼品|兑换|邀请|推荐|追踪|快递/iu;

/** Lowercased, width-folded (NFKC: full-width letters and digits become ASCII), no zero-width marks. */
export function foldName(name: string): string {
  return name.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").toLowerCase().trim();
}

/** Does this field's accessible name say it holds a password, PIN, one-time code or card number? */
export function isSensitiveName(name: string): boolean {
  const folded = foldName(name);
  if (!folded) return false;
  if (SECRET_NAME.test(folded)) return true;
  return CODE_WORD.test(folded) && !PLAIN_CODE.test(folded);
}

/** A snapshot element as the computer sends it (other fields, e.g. dropdown `options`, kept as they are). */
export interface MaskableElement { ref: string; role: string; name: string; value?: unknown }

/** True when this element's value must not be shown. */
export function needsMask(element: MaskableElement): boolean {
  if (element.value === undefined || element.value === null || element.value === "") return false;
  if (element.value === MASKED_VALUE) return false;
  return VALUE_ROLES.has(element.role) && isSensitiveName(element.name);
}

/** The elements with every sensitive value replaced (pure; the rest of each element is untouched). */
export function maskElements<T extends MaskableElement>(elements: readonly T[]): T[] {
  return elements.map((element) => (needsMask(element) ? { ...element, value: MASKED_VALUE } : element));
}
