// Server configuration from backend/.env (compose loads the same file). Validated once at
// startup: the backend refuses to start and names the setting when a required one is
// missing or malformed. Model settings are validated by src/llm/ (models.json / LLM_*).
import { z } from "zod";
import { BuiltinConnectorId } from "./contract/m25.ts";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const list = (v: unknown) =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v === undefined ? [] : v;

const str = () => z.preprocess(blank, z.string().optional());

export const EnvSchema = z
  .object({
    // server
    PUBLIC_URL: z.preprocess(blank, z.url()),
    PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(3000)),
    SERVER_NAME: z.preprocess(blank, z.string().default("OpenDuet")),
    DATABASE_URL: z.preprocess(blank, z.string().startsWith("file:")),
    FILES_DIR: z.preprocess(blank, z.string().default("./data/files")),
    TRUSTED_PROXIES: z.preprocess(list, z.array(z.string())),
    LOG_LEVEL: z.preprocess(blank, z.enum(["debug", "info", "warn", "error"]).default("info")),
    ALLOW_FAKE_IP_RANGE: z.preprocess(blank, z.enum(["auto", "1", "0"]).default("auto")),
    // auth
    BETTER_AUTH_SECRET: z.preprocess(blank, z.string().min(32, "must be at least 32 characters")),
    // models (validated in src/llm/)
    MODELS_FILE: z.preprocess(blank, z.string().default("./models.json")),
    LLM_PROTOCOL: str(),
    LLM_BASE_URL: str(),
    LLM_API_KEY: str(),
    LLM_MODEL: str(),
    // Shortcut mode only (models.json sets these per provider / model).
    LLM_AUTH_HEADER: z.preprocess(blank, z.enum(["x-api-key", "bearer"]).optional()),
    LLM_CAPABILITIES: z.preprocess(
      list,
      z.array(z.enum(["tools", "vision", "thinking", "serverWebTools", "promptCaching"])),
    ),
    MODEL_CHAT: str(),
    MODEL_TASK: str(),
    MODEL_PROACTIVE: str(),
    MODEL_UTILITY: str(),
    LLM_TIMEOUT_SECONDS: z.preprocess(blank, z.coerce.number().int().positive().default(120)),
    LLM_ALLOW_INSECURE_HOSTS: z.preprocess(list, z.array(z.string())),
    LLM_ALLOW_PRIVATE_HOSTS: z.preprocess(list, z.array(z.string())),
    // M9: 0 = no limit (the default); set either to turn that limit on.
    SESSION_TOKEN_LIMIT: z.preprocess(blank, z.coerce.number().int().nonnegative().default(0)),
    WEEKLY_TOKEN_LIMIT: z.preprocess(blank, z.coerce.number().int().nonnegative().default(0)),
    // M9: the built-in morning brief and check-ins. M14b: on unless PROACTIVE_BUILTINS=0 (or false); each
    // user's proactivity level, quiet hours and daily cap gate them (proactive/gate.ts).
    PROACTIVE_BUILTINS: z.preprocess(blank, z.enum(["0", "1", "true", "false"]).default("1").transform((v) => v === "1" || v === "true")),
    // optional services
    COMPOSIO_API_KEY: str(),
    SEARCH_PROVIDER: z.preprocess(blank, z.enum(["tavily", "brave", "serper", "searxng", "exa", "parallel"]).optional()),
    SEARCH_API_KEY: str(),
    SEARXNG_URL: z.preprocess(blank, z.url().optional()),
    BUILTIN_CONNECTORS_OFF: z.preprocess(list, z.array(BuiltinConnectorId)),
    OPEN_METEO_URL: z.preprocess(blank, z.url({ protocol: /^https?$/ }).optional()),
    OPEN_METEO_GEOCODING_URL: z.preprocess(blank, z.url({ protocol: /^https?$/ }).optional()),
    OPEN_METEO_API_KEY: str(),
    NOTIFY_PROVIDER: z.preprocess(blank, z.enum(["apns", "ntfy", "bark"]).optional()),
    COMPUTER_URL: z.preprocess(blank, z.url().optional()),
    COMPUTER_TOKEN: z.preprocess(blank, z.string().min(24, "must be at least 24 characters").optional()),
    // The computer (OpenBot agent-computer) refuses to start with any other shape.
    COMPUTER_BOT_ID: z.preprocess(blank, z.string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "must be 1-64 letters, digits, hyphens or underscores, starting with a letter or digit")
      .default("duet")),
    // One owner per deployment: the account OpenDuet's computer belongs to (default: the first account).
    COMPUTER_OWNER: z.preprocess(blank, z.string().trim().toLowerCase().optional()),
    // M20: what compose hands the computer (same .env), told to the app in Features: the browser's
    // mode and how long it may sit idle before it closes (0 = never; the computer's own default 30 min).
    COMPUTER_BROWSER_MODE: z.preprocess(blank, z.enum(["headless", "headed"]).default("headless")),
    COMPUTER_BROWSER_IDLE_MS: z.preprocess(blank, z.coerce.number().int().nonnegative().default(30 * 60_000)),
    // M20: the page a woken browser with nothing open shows (default https://www.bing.com/).
    COMPUTER_START_URL: z.preprocess(blank, z.url({ protocol: /^https?$/, error: "must be an http(s) web address" })
      .max(2000, "must be at most 2000 characters")
      .refine((value) => {
        try {
          const url = new URL(value);
          return !url.username && !url.password;
        } catch {
          return true; // z.url supplies the invalid-address error.
        }
      }, "must not include a user name or password")
      .optional()),
  })
  .superRefine((env, ctx) => {
    const need = (when: boolean, key: string, why: string) => {
      if (when) ctx.addIssue({ code: "custom", path: [key], message: `is required ${why}` });
    };
    need(!!env.COMPUTER_URL && !env.COMPUTER_TOKEN, "COMPUTER_TOKEN", "when COMPUTER_URL is set");
    need(env.SEARCH_PROVIDER === "searxng" && !env.SEARXNG_URL, "SEARXNG_URL", "when SEARCH_PROVIDER=searxng");
    need(
      !!env.SEARCH_PROVIDER && ["tavily", "brave", "serper"].includes(env.SEARCH_PROVIDER) && !env.SEARCH_API_KEY,
      "SEARCH_API_KEY",
      `when SEARCH_PROVIDER=${env.SEARCH_PROVIDER}`,
    );
  });

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration in backend/.env:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Parses the environment; throws ConfigError naming every bad or missing setting. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = EnvSchema.safeParse(env);
  if (r.success) return r.data;
  const problems = r.error.issues.map((issue) => {
    const key = String(issue.path[0] ?? "");
    const value = env[key];
    if (key === "BUILTIN_CONNECTORS_OFF") {
      const unknown = (value ?? "").split(",").map(v => v.trim()).filter(v => v && !BuiltinConnectorId.safeParse(v).success);
      return `BUILTIN_CONNECTORS_OFF unknown id: ${unknown.join(", ")}`;
    }
    const missing = value === undefined || value.trim() === "";
    return missing && issue.code !== "custom" ? `${key} is required` : `${key} ${issue.message}`;
  });
  throw new ConfigError([...new Set(problems)]);
}
