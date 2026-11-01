// M12 rows -> contract shapes, and what makes a model usable. A provider's key is only ever
// answered as SecretInfo { set, last4 } (from the vault row's last4 column; nothing is decrypted).
import type { ModelEntry as EntryRow, ModelProvider as ProviderRow } from "@prisma/client";
import { ModelEntry, ModelProvider, THINKING_LEVELS, type ThinkingLevel } from "../contract/m12.ts";
import type { Db } from "../db.ts";
import { ladder } from "../llm/index.ts";
import type { SecretInfo } from "../vault/index.ts";

export const KEY_NAME = "key";
export const OWNER_KIND = "provider" as const;

export type Header = { name: string; value: string };

const json = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export function headersOf(row: Pick<ProviderRow, "headers">): Header[] {
  const value = json(row.headers);
  if (!Array.isArray(value)) return [];
  return value.flatMap((h) => (h && typeof h === "object" && typeof (h as Header).name === "string" && typeof (h as Header).value === "string" ? [{ name: (h as Header).name, value: (h as Header).value }] : []));
}

export function levelsOf(row: Pick<EntryRow, "thinkingLevels">): ThinkingLevel[] {
  const value = json(row.thinkingLevels);
  return Array.isArray(value) ? ladder(value.filter((v): v is ThinkingLevel => (THINKING_LEVELS as readonly unknown[]).includes(v))) : [];
}

export function editedOf(row: Pick<EntryRow, "edited">): string[] {
  const value = json(row.edited);
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string"))] : [];
}

export const formatOf = (row: Pick<EntryRow, "thinkingFormat" | "thinkingLevels">): "effort" | "budget" | "none" => {
  if (!levelsOf(row).length) return "none";
  return row.thinkingFormat === "effort" || row.thinkingFormat === "budget" ? row.thinkingFormat : "none";
};

export const levelOrNull = (value: string | null | undefined): ThinkingLevel | null =>
  value && (THINKING_LEVELS as readonly string[]).includes(value) ? (value as ThinkingLevel) : null;

export function toProvider(row: ProviderRow, key: SecretInfo, modelCount: number): ModelProvider {
  return ModelProvider.parse({
    id: row.id, kind: row.kind, protocol: row.protocol, name: row.name, baseUrl: row.baseUrl,
    auth: row.protocol === "anthropic" ? (row.auth === "bearer" ? "bearer" : "x-api-key") : null,
    key, headers: headersOf(row), status: row.status === "failed" ? "failed" : "active", error: row.error,
    imported: row.importKey !== null, modelCount, createdAt: row.createdAt.toISOString(),
    // M27: the stored site (an unknown value reads null)
    region: row.region === "cn" || row.region === "intl" ? row.region : null,
  });
}

export function toEntry(row: EntryRow): ModelEntry {
  return ModelEntry.parse({
    id: row.id, providerId: row.providerId, purpose: row.purpose === "realtime" ? "realtime" : "chat", modelId: row.modelId,
    label: row.label, contextWindow: row.contextWindow, maxOutputTokens: row.maxOutputTokens,
    thinkingLevels: levelsOf(row), thinkingFormat: formatOf(row), defaultThinking: levelOrNull(row.defaultThinking),
    tools: row.tools, vision: row.vision, serverWebTools: row.serverWebTools, promptCaching: row.promptCaching,
    source: ["models.dev", "default", "imported", "manual"].includes(row.source) ? row.source : "manual",
    edited: editedOf(row), createdAt: row.createdAt.toISOString(),
  });
}

/** The ids of the user's providers that have a key in the vault. */
export async function keyedProviders(db: Pick<Db, "vaultSecret">, userId: string): Promise<Set<string>> {
  const rows = await db.vaultSecret.findMany({ where: { userId, ownerKind: OWNER_KIND, name: KEY_NAME }, select: { ownerId: true } });
  return new Set(rows.map((r) => r.ownerId));
}

/** A usable chat model (contract §3): purpose chat, tools on, its provider has a key. */
export const usableChat = (row: Pick<EntryRow, "purpose" | "tools" | "providerId">, keyed: ReadonlySet<string>): boolean =>
  row.purpose === "chat" && row.tools && keyed.has(row.providerId);

/** The user's ModelEntry `id`, when it's a usable chat model; else null. */
export async function usableChatEntry(db: Pick<Db, "modelEntry" | "vaultSecret">, userId: string, id: string): Promise<EntryRow | null> {
  const row = await db.modelEntry.findFirst({ where: { id, userId } });
  if (!row) return null;
  return usableChat(row, await keyedProviders(db, userId)) ? row : null;
}

/** `configured` / Features.models: the user's default model is a usable chat model. */
export async function isConfigured(db: Pick<Db, "user" | "modelEntry" | "vaultSecret">, userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { defaultModelId: true } });
  return !!user?.defaultModelId && !!(await usableChatEntry(db, userId, user.defaultModelId));
}
