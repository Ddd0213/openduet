// Push notifications (L78): see notifier.ts. index.ts wiring: loadNotifyConfig() at startup,
// createPushProvider(config, { db }), new Notifier({ db, events, provider }).start(),
// new ReminderService({ db, events, notifier }).start(); stop both before the database closes.
// M21: Notifier.start() also starts the per-channel unread feed and the "still waiting" follow-ups.
export { loadNotifyConfig, type NotifyConfig } from "./config.ts";
export { FOLLOW_UP_INTERVAL_MS, FOLLOW_UP_MS, FollowUps, type FollowUpOptions } from "./follow-ups.ts";
export { Notifier, type NotifierDeps, type NotifyInput, type NotifyResult, type NotifySink } from "./notifier.ts";
export { createPushProvider, type ProviderDeps } from "./providers/index.ts";
export { ReminderService, REMINDER_INTERVAL_MS, type ReminderDeps } from "./reminders.ts";
export type { RunNotices, RunRef } from "./run-end.ts";
