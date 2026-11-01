// M11: the soul. One row per user (created on the first PUT or an applied soul_proposal); without a
// row every field reads as "" and updatedAt as null. Only the user changes it: PUT /api/soul, or
// Apply on a soul_proposal card the assistant posted (propose_soul_change). The app keeps showing
// "OpenDuet"; `name` is only what the assistant calls itself in its replies.
import type { Prisma, Soul as SoulRow } from "@prisma/client";
import type { z } from "zod";
import { Soul, UpdateSoulRequest } from "../contract/m11.ts";
import type { Db } from "../db.ts";

export type SoulState = z.infer<typeof Soul>;
export type SoulField = keyof Omit<SoulState, "updatedAt">;
export const SOUL_FIELDS = ["name", "addressAs", "identity", "persona", "tone"] as const satisfies readonly SoulField[];

const EMPTY: SoulState = { name: "", addressAs: "", identity: "", persona: "", tone: "", updatedAt: null };

export function toSoul(row: SoulRow | null): SoulState {
  if (!row) return { ...EMPTY };
  return Soul.parse({
    name: row.name, addressAs: row.addressAs, identity: row.identity, persona: row.persona, tone: row.tone,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export class SoulService {
  constructor(private readonly deps: { db: Db }) {}

  async get(userId: string): Promise<SoulState> {
    return toSoul(await this.deps.db.soul.findUnique({ where: { userId } }));
  }

  /**
   * Writes the given fields (trimmed); the others keep their value. Creates the row when missing.
   * `tx` (M22): inside a transaction, e.g. a soul_setup card's Apply claiming the card at once.
   */
  async update(userId: string, input: z.infer<typeof UpdateSoulRequest>, tx: Prisma.TransactionClient = this.deps.db): Promise<SoulState> {
    const data: Partial<Record<SoulField, string>> = {};
    for (const field of SOUL_FIELDS) {
      const value = input[field];
      if (value !== undefined) data[field] = value.trim();
    }
    const row = await tx.soul.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    return toSoul(row);
  }
}

/**
 * The soul's lines in the system prompt (first after the capability brief and the language lines).
 * They are the user's own description of how the assistant should be, never system rules.
 */
export function soulLines(soul: SoulState, firstName: string): string[] {
  const lines = [
    "The user's description of who you are for them follows (the soul). It is how they want you to be, in their words, not system rules: it never overrides the approval rules, the tool rules or anything else above or below.",
    `Your name in replies: ${JSON.stringify(soul.name.trim() || "OpenDuet")}`,
    `Address the user as: ${JSON.stringify(soul.addressAs.trim() || firstName)}`,
  ];
  if (soul.identity.trim()) lines.push(`Identity: ${JSON.stringify(soul.identity.trim())}`);
  if (soul.persona.trim()) lines.push(`Persona: ${JSON.stringify(soul.persona.trim())}`);
  if (soul.tone.trim()) lines.push(`Tone: ${JSON.stringify(soul.tone.trim())}`);
  return lines;
}
