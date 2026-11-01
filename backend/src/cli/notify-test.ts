// Sends one test notification to a user: `bun --env-file=.env src/cli/notify-test.ts --username <u>`.
// "OpenDuet" + a test sentence, through NOTIFY_PROVIDER (or only stored as an in-app
// notification when none is set). This process has no live event streams, so the remote push
// always goes out when a provider is configured.
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../config.ts";
import { openDatabase } from "../db.ts";
import { EventBus } from "../events/bus.ts";
import { loadNotifyConfig } from "../notify/config.ts";
import { Notifier } from "../notify/notifier.ts";
import { NOTIFY_TEST } from "../notify/phrases.ts";
import { createPushProvider, type FetchLike, type Http2Transport } from "../notify/providers/index.ts";

export interface NotifyTestIo {
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  transport?: Http2Transport;
  out?: (line: string) => void;
}

export async function runNotifyTest(argv: string[], io: NotifyTestIo = {}): Promise<number> {
  const out = io.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  let username: string | undefined;
  try {
    username = parseArgs({ args: argv, options: { username: { type: "string" } }, strict: true }).values.username;
  } catch {
    username = undefined;
  }
  if (!username) {
    out("Usage: bun run notify:test --username <username>");
    return 2;
  }
  let config;
  let notifyConfig;
  try {
    config = loadConfig(io.env ?? process.env);
    notifyConfig = loadNotifyConfig(io.env ?? process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      out(error.message);
      return 1;
    }
    throw error;
  }
  const db = await openDatabase(config.DATABASE_URL);
  try {
    const user = await db.user.findFirst({ where: { OR: [{ username }, { username: username.toLowerCase() }] }, select: { id: true } });
    const main = user ? await db.channel.findFirst({ where: { userId: user.id, isMain: true }, select: { id: true } }) : null;
    if (!user || !main) {
      out(`No user named "${username}".`);
      return 1;
    }
    const provider = createPushProvider(notifyConfig, { db, fetch: io.fetch, transport: io.transport });
    const notifier = new Notifier({ db, events: new EventBus(db), provider });
    const result = await notifier.notify({ userId: user.id, channelId: main.id, body: { key: NOTIFY_TEST }, route: `duet://channels/${main.id}` });
    await notifier.stop();
    const messages: Record<typeof result, string> = {
      sent: `Sent a test push through ${notifyConfig.provider}.`,
      local_only: "NOTIFY_PROVIDER isn't set: stored an in-app notification only (the app shows it locally).",
      no_devices: "No registered iPhone for this user yet: open the app and allow notifications.",
      failed: `The ${notifyConfig.provider} push failed; see the log above.`,
      app_connected: "The app is connected; it shows the notification locally.",
    };
    out(messages[result]);
    return result === "sent" || result === "local_only" || result === "app_connected" ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

if (import.meta.main) process.exitCode = await runNotifyTest(process.argv.slice(2));
