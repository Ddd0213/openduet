// What a remote push provider gets and returns. Text is already rendered in User.language.
export interface PushMessage {
  userId: string;
  title: string;
  /** full text (APNs alert body) */
  body: string;
  /** what ntfy / Bark carry instead of the body: the text stays on the server (L78) */
  teaser: string;
  /** duet://... deep link (M21: may carry ?message=<id>, the card or line to scroll to) */
  route: string;
  channelId: string | null;
  /**
   * M21: one id per thing (task-<id>, approval-<id>, message-<id>): a newer push for the same
   * thing replaces the older one (APNs apns-collapse-id) and withdraw() can take it back.
   */
  collapseId?: string;
  /** M21: inside the user's quiet hours: deliver without sound or waking the screen */
  passive?: boolean;
  /** M29: the app icon's badge, needsYou()'s count (only for providers with `badges`) */
  badge?: number;
}

export type PushOutcome = "sent" | "failed" | "no_devices";

export interface PushProvider {
  readonly name: "apns" | "ntfy" | "bark";
  /** M29: the provider shows PushMessage.badge (APNs aps.badge); the Notifier counts it only then */
  readonly badges?: boolean;
  send(message: PushMessage): Promise<PushOutcome>;
  /**
   * M21: takes back a delivered push (an approval decided elsewhere). Only providers that can do
   * it implement this: APNs (a silent background push the app turns into
   * removeDeliveredNotifications). ntfy and Bark can't withdraw from the server side.
   */
  withdraw?(userId: string, collapseId: string): Promise<PushOutcome>;
  close(): Promise<void>;
}

/** The subset of fetch the providers use; tests inject a fake (no network). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;
