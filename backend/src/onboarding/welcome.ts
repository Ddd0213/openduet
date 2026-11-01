// The start of the first-day scan (L76, L77), run inside the scan turn so every event carries its
// runId: typing on -> ~1.0 s the assistant's welcome (first name) -> ~1.6 s "I'm going to check your
// apps ... Be right back!" with typing still on. Then, without apps, the turn ends here without the
// model: Composio not configured on this server -> agent.scan_not_set_up; configured but nothing
// connected -> agent.scan_no_apps plus a connect card for Gmail and one for Google Calendar.
// With an app connected the model takes over (memory -> Gmail -> Calendar / Drive -> profile).
import { phrase } from "../agent/phrase.ts";
import type { TurnInput, TurnResult } from "../agent/types.ts";
import type { ConnectorCatalog } from "../connectors/catalog.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import type { RunHost } from "../runs/host.ts";
import type { UsageMeter } from "../usage/meter.ts";

/** PART A's pacing: the welcome ~1.0 s after typing starts, the scan line ~1.6 s after that. */
export const WELCOME_DELAYS_MS = [1000, 1600] as const;
/** The connect cards offered when no app is connected (L76: "offers to connect Gmail and Calendar"). */
export const FIRST_APPS = ["gmail", "googlecalendar"] as const;

export interface WelcomeDeps {
  db: Db;
  runs: RunHost;
  usage: UsageMeter;
  /** null = Composio isn't configured on this server */
  catalog: ConnectorCatalog | null;
  /** [before the welcome, before the scan line]; tests pass [0, 0] */
  delaysMs?: readonly [number, number];
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const DONE: TurnResult = { status: "completed", error: null, usage: { inputTokens: 0, outputTokens: 0, estimated: false }, model: null };

/** Runs the welcome, then either answers the turn itself (no apps) or hands it to the model. */
export async function firstDayTurn(deps: WelcomeDeps, input: TurnInput, next: (input: TurnInput) => Promise<TurnResult>): Promise<TurnResult> {
  const { db } = deps;
  const [first, second] = deps.delaysMs ?? WELCOME_DELAYS_MS;
  const sink = input.sink;
  const user = await db.user.findUniqueOrThrow({ where: { id: input.userId }, select: { firstName: true, name: true, language: true } });
  const lang = user.language;
  const name = user.firstName.trim() || user.name.trim().split(/\s+/)[0] || "";
  const say = (text: string) => sink.upsertMessage({ role: "assistant", kind: "text", text });

  await sink.typing(true);
  await sleep(first);
  await say(phrase("agent.welcome", lang).replaceAll("{name}", name));
  await sleep(second);
  await say(phrase("agent.welcome_scan", lang));

  if (!deps.catalog) {
    await say(phrase("agent.scan_not_set_up", lang));
    await sink.typing(false);
    return DONE;
  }
  let connected = true;
  try {
    connected = (await deps.catalog.accounts(input.userId)).some((a) => a.status === "active");
  } catch (error) {
    // Composio unreachable: let the model try, its tools report the failure honestly.
    log.warn("first-day scan: accounts unavailable", { error: { name: (error as Error).name } });
  }
  if (!connected) {
    await say(phrase("agent.scan_no_apps", lang));
    for (const slug of FIRST_APPS) {
      const app = await deps.catalog.name(slug);
      await sink.upsertMessage({
        role: "assistant", kind: "alert",
        payload: {
          title: { text: app },
          body: { key: "connectors.connect_body", params: { app: { type: "text", value: app } } },
          action: { label: { key: "agent.connect_app", params: { app: { type: "text", value: app } } }, type: "open_connector", url: null, toolkit: slug },
        },
      });
    }
    await sink.typing(false);
    return DONE;
  }
  // Over the usage limit there is no scan: the thread's usage-limit line says when it resumes.
  if ((await deps.usage.state(input.userId)).limited) {
    await deps.runs.usageLimit(input.userId, input.channelId, null);
    await sink.typing(false);
    return DONE;
  }
  return next(input);
}
