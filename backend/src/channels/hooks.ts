// What the channel routes (routes/channels.ts) need from modules built later in index.ts: which
// toolkits the catalog knows (for `access` refs on create) and the apps the user has connected (for
// GET /api/channels/:id/access). Keyed by the database client, so separate test apps never mix.
// Without hooks every app ref is unknown and the access list shows no apps.
import type { Db } from "../db.ts";
import type { AppCheck } from "../access/service.ts";

export interface ConnectedApp { toolkit: string; name: string; description: string }

export interface ChannelHooks {
  /** a toolkit slug the catalog knows */
  appKnown: AppCheck | null;
  /** the user's apps with an active connected account */
  connectedApps: ((userId: string) => Promise<ConnectedApp[]>) | null;
}

const hooks = new WeakMap<Db, ChannelHooks>();

export function setChannelHooks(db: Db, value: ChannelHooks): void {
  hooks.set(db, value);
}

export function channelHooks(db: Db): ChannelHooks {
  return hooks.get(db) ?? { appKnown: null, connectedApps: null };
}
