// Vault values never leave the server: anything a connector's server sends back (tool results,
// error messages, API answers, redirect locations) has every stored secret of that connector
// replaced before it reaches the model, a card, a run record or a route's answer.
export const REDACTED = "[redacted]";
const MIN_SECRET = 4;

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= MIN_SECRET && out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out;
}

/** Deep: every string (keys too) in a JSON-like value. */
export function redactValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (depth > 20 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [redactText(k, secrets), redactValue(v, secrets, depth + 1)]));
}

/** A long value as text, cut at `max` characters. */
export function clipText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: `${text.slice(0, max)}…`, truncated: true };
}

/**
 * Redact first, then cut at `max` characters: cutting first would let a secret that crosses the
 * cut through as a prefix. `cut`: the text was already cut upstream (a capped read). Wherever the
 * text ends short of its real end, a tail that is the start of a secret (>= MIN_SECRET
 * characters of it) is dropped as well.
 */
export function redactClip(text: string, secrets: readonly string[], max: number, cut = false): { text: string; truncated: boolean } {
  const redacted = redactText(text, secrets);
  const over = redacted.length > max;
  if (!over && !cut) return { text: redacted, truncated: false };
  const kept = dropSecretStart(over ? redacted.slice(0, max) : redacted, secrets);
  return { text: over ? `${kept}…` : kept, truncated: true };
}

/** Drops a tail that is the first MIN_SECRET or more characters of a secret (until none is left). */
function dropSecretStart(text: string, secrets: readonly string[]): string {
  let out = text;
  for (let changed = true; changed;) {
    changed = false;
    for (const secret of secrets) {
      if (secret.length < MIN_SECRET) continue;
      for (let n = Math.min(secret.length - 1, out.length); n >= MIN_SECRET; n--) {
        if (out.charCodeAt(out.length - n) === secret.charCodeAt(0) && out.endsWith(secret.slice(0, n))) {
          out = out.slice(0, out.length - n);
          changed = true;
          break;
        }
      }
    }
  }
  return out;
}
