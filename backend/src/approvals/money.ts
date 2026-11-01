// Money from request_payment: the model gives a decimal amount in major units ("16.49") and an
// ISO currency; the contract carries an integer in minor units (cents) that the app formats.

const ISO = /^[A-Z]{3}$/;
let supported: Set<string> | null = null;

/** Whether `code` is an ISO 4217 currency the runtime knows. */
export function isCurrency(code: string): boolean {
  if (!ISO.test(code)) return false;
  try {
    supported ??= new Set(Intl.supportedValuesOf("currency"));
    return supported.has(code);
  } catch {
    return true;
  }
}

/** Minor-unit digits of a currency from Intl (USD 2, JPY 0, KWD 3). */
export function minorDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** 16.49 USD -> 1649; 1200 JPY -> 1200. Throws on an unknown currency or a bad amount. */
export function toMinorUnits(amount: number, currency: string): number {
  const code = currency.toUpperCase();
  if (!isCurrency(code)) throw new RangeError("unknown currency");
  if (!Number.isFinite(amount) || amount <= 0) throw new RangeError("amount must be positive");
  const minor = Math.round(amount * 10 ** minorDigits(code));
  if (!Number.isSafeInteger(minor)) throw new RangeError("amount too large");
  return minor;
}
