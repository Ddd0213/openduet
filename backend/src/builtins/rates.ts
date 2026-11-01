import { z } from "zod";
import { EXCHANGE_RATE_MAX_QUOTES } from "../contract/m25.ts";
import { serviceJson, WebError, withDeadline, type HttpDeps } from "../web/http.ts";
import type { BuiltinConfig } from "./config.ts";
import { runBuiltin } from "./state.ts";

const Currency = z.string().regex(/^[A-Za-z]{3}$/).transform(v => v.toUpperCase());
const DateOnly = z.iso.date();
export const ExchangeInput = z.object({ base: Currency, quotes: z.array(Currency).min(1).max(EXCHANGE_RATE_MAX_QUOTES), amount: z.number().positive().default(1), date: DateOnly.optional() }).strict();
const Currencies = z.record(z.string().regex(/^[A-Z]{3}$/), z.string());
const Rates = z.object({ base: Currency, date: DateOnly, rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()) });
export const RATE_SOURCE = "Frankfurter (European Central Bank reference rates)";

export async function exchangeRate(raw: unknown, config: BuiltinConfig, deps: HttpDeps = {}) {
  const input = ExchangeInput.safeParse(raw);
  if (!input.success) return { isError: true as const, error: "Invalid exchange rate arguments" };
  return runBuiltin("exchange_rate", config, () => withDeadline(deps.signal, async signal => {
    const { base, amount, date } = input.data, quotes = [...new Set(input.data.quotes)];
    // v1 is ECB-only, unlike v2's blended rates. Validate against that same currency universe.
    const currencies = Currencies.parse(await serviceJson(new URL("https://api.frankfurter.dev/v1/currencies"), deps, signal));
    const unknown = [base, ...quotes].filter(code => !Object.hasOwn(currencies, code));
    if (unknown.length) throw new WebError(`Unknown or unsupported currency: ${[...new Set(unknown)].join(", ")}`);
    const url = new URL(`https://api.frankfurter.dev/v1/${date ?? "latest"}`);
    url.searchParams.set("base", base);
    const different = quotes.filter(q => q !== base);
    if (different.length) url.searchParams.set("symbols", different.join(","));
    const data = Rates.parse(await serviceJson(url, deps, signal));
    if (data.base !== base) throw new Error("Wrong base currency");
    const rates: Record<string, number> = {}, converted: Record<string, number> = {};
    for (const quote of quotes) {
      const rate = quote === base ? 1 : data.rates[quote];
      if (rate === undefined) throw new WebError(`Unknown or unsupported currency: ${quote}`);
      rates[quote] = rate; converted[quote] = amount * rate;
      if (!Number.isFinite(converted[quote])) throw new WebError("Amount is too large to convert");
    }
    return { base, date: data.date, amount, rates, converted, source: RATE_SOURCE };
  }));
}
