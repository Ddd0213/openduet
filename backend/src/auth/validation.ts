import { z } from "zod";

// These are username()'s defaults in Better Auth 1.7.12 (the source also allows dots).
export const Username = z.string().min(3).max(30)
  .regex(/^[a-zA-Z0-9_.]+$/, "Use only letters, numbers, underscores and dots.")
  .transform((value) => value.toLowerCase());

export const Timezone = z.string().min(1).max(100).refine((value) => {
  // Intl accepts offset identifiers too; the app contract requires an IANA name.
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Use a valid IANA timezone.");
