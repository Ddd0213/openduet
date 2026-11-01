// What routes outside the models module (auth/me's features, PATCH /api/channels/:id) need from it,
// keyed by the database client so separate test apps never mix (like channels/hooks.ts). Without
// hooks: Features.models answers its contract default (true) and webSearch only SEARCH_PROVIDER; a
// channel's modelId is checked straight against the rows.
import type { Db } from "../db.ts";

export interface ModelHooks {
  /** Features.models (a usable default chat model), the default's serverWebTools and (M13) Features.voice */
  features(userId: string): Promise<{ models: boolean; serverWebTools: boolean; voice?: boolean }>;
  /** the one-time import (before a channel's modelId is checked) */
  ready(userId: string): Promise<void>;
}

const hooks = new WeakMap<Db, ModelHooks>();

export function setModelHooks(db: Db, value: ModelHooks): void {
  hooks.set(db, value);
}

export function modelHooks(db: Db): ModelHooks | null {
  return hooks.get(db) ?? null;
}
