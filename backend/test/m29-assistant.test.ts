import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventBus } from "../src/events/bus.ts";
import { openDatabase, type Db } from "../src/db.ts";
import { loadMessage } from "../src/runs/serialize.ts";

const backendDir = join(import.meta.dir, "..");
const migrationsDir = join(backendDir, "prisma", "migrations");
const schemaPath = join(backendDir, "prisma", "schema.prisma");
const m29 = "20270216090000_m29_assistant";
const m28 = "20270209090000_m28_sessions";

function migrate(tempPrisma: string, url: string): void {
  const result = Bun.spawnSync(["bunx", "prisma", "migrate", "deploy", "--schema", join(tempPrisma, "schema.prisma")], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function prepare(): Promise<{ db: Db; url: string; root: string; tempPrisma: string }> {
  const root = mkdtempSync(join(tmpdir(), "duet-m29-migration-"));
  const tempPrisma = join(root, "prisma");
  mkdirSync(tempPrisma, { recursive: true });
  cpSync(schemaPath, join(tempPrisma, "schema.prisma"));
  const tempMigrations = join(tempPrisma, "migrations");
  mkdirSync(tempMigrations);
  for (const name of readdirSync(migrationsDir).filter((name) => name <= m28)) cpSync(join(migrationsDir, name), join(tempMigrations, name), { recursive: true });
  const url = `file:${join(root, "test.db")}`;
  migrate(tempPrisma, url);
  const db = await openDatabase(url);
  await db.user.create({ data: { id: "u_m29", name: "Alex", authEmail: "alex@m29.invalid", username: "alex_m29", firstName: "Alex" } });
  await db.channel.create({ data: { id: "ch_m29", userId: "u_m29", isMain: true } });
  await db.$executeRawUnsafe(`INSERT INTO "Message" ("id", "userId", "channelId", "role", "kind", "text", "payload", "status", "createdAt", "updatedAt") VALUES ('msg_m29', 'u_m29', 'ch_m29', 'claude', 'text', 'old reply', '{"replyTo":{"messageId":"old_user","role":"claude","excerpt":"old"}}', 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  await db.$executeRawUnsafe(`INSERT INTO "Memory" ("id", "userId", "kind", "text", "updatedAt") VALUES ('mem_m29', 'u_m29', 'fact', 'old fact', CURRENT_TIMESTAMP)`);
  await db.$executeRawUnsafe(`INSERT INTO "Artifact" ("id", "userId", "channelId", "type", "title", "startedBy", "createdAt", "updatedAt") VALUES ('art_m29', 'u_m29', 'ch_m29', 'docs', 'old artifact', 'claude', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  await db.$executeRawUnsafe(`INSERT INTO "ArtifactVersion" ("id", "artifactId", "html", "by", "reason") VALUES ('ver_m29', 'art_m29', '<p>old</p>', 'claude', 'create')`);
  await db.$executeRawUnsafe(`INSERT INTO "Reaction" ("id", "messageId", "emoji", "by") VALUES ('react_m29', 'msg_m29', '👍', 'claude')`);
  await db.$executeRawUnsafe(`INSERT INTO "ChannelFile" ("id", "userId", "channelId", "path", "name", "mime", "size", "source") VALUES ('file_m29', 'u_m29', 'ch_m29', 'file_m29', 'old.txt', 'text/plain', 3, 'claude')`);
  await db.$executeRawUnsafe(`INSERT INTO "AuditLog" ("id", "userId", "action", "actor", "outcome") VALUES ('audit_m29', 'u_m29', 'old_action', 'claude', 'ok')`);
  await db.$executeRawUnsafe(`INSERT INTO "Skill" ("id", "userId", "name", "instructions", "source", "createdAt", "updatedAt") VALUES ('skill_m29', 'u_m29', 'old-skill', 'old', 'claude', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  await db.event.create({ data: { userId: "u_m29", channelId: "ch_m29", type: "message", payload: JSON.stringify({ message: { id: "msg_event_m29", channelId: "ch_m29", taskId: null, role: "claude", kind: "text", text: "old event", status: "sent", clientId: null, reactions: [{ emoji: "👍", by: "claude" }], stopped: false, callId: null, payload: { skill: null, attachments: [], replyTo: { messageId: "old_user", role: "claude", excerpt: "old" }, taskResult: null, forwarded: null }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } }) } });
  return { db, url, root, tempPrisma };
}

describe("M29 assistant migration", () => {
  test("backfills scalar values, changes Memory default, and normalizes legacy JSON on read", async () => {
    const prepared = await prepare();
    try {
      await prepared.db.$disconnect();
      cpSync(join(migrationsDir, m29), join(prepared.tempPrisma, "migrations", m29), { recursive: true });
      migrate(prepared.tempPrisma, prepared.url);
      prepared.db = await openDatabase(prepared.url);
      const { db } = prepared;
      expect((await db.message.findUniqueOrThrow({ where: { id: "msg_m29" } })).role).toBe("assistant");
      expect((await db.memory.findUniqueOrThrow({ where: { id: "mem_m29" } })).source).toBe("assistant");
      expect((await db.artifact.findUniqueOrThrow({ where: { id: "art_m29" } })).startedBy).toBe("assistant");
      expect((await db.artifactVersion.findUniqueOrThrow({ where: { id: "ver_m29" } })).by).toBe("assistant");
      expect((await db.reaction.findUniqueOrThrow({ where: { id: "react_m29" } })).by).toBe("assistant");
      expect((await db.channelFile.findUniqueOrThrow({ where: { id: "file_m29" } })).source).toBe("assistant");
      expect((await db.auditLog.findUniqueOrThrow({ where: { id: "audit_m29" } })).actor).toBe("assistant");
      expect((await db.skill.findUniqueOrThrow({ where: { id: "skill_m29" } })).source).toBe("assistant");
      const memoryDefault = await db.$queryRaw<{ dflt_value: string }[]>`PRAGMA table_info("Memory")`;
      expect(memoryDefault.find((column) => column.dflt_value?.includes("assistant"))).toBeDefined();
      const message = await loadMessage(db, "msg_m29");
      expect(message?.role).toBe("assistant");
      expect(message && message.kind === "text" ? message.payload.replyTo?.role : undefined).toBe("assistant");
      const replay = await new EventBus(db).replay("u_m29", 0);
      expect(replay[0]?.type).toBe("message");
      if (replay[0]?.type === "message") {
        expect(replay[0].payload.message.role).toBe("assistant");
        expect(replay[0].payload.message.reactions[0]?.by).toBe("assistant");
        expect(replay[0].payload.message.kind === "text" ? replay[0].payload.message.payload.replyTo?.role : undefined).toBe("assistant");
      }
    } finally {
      await prepared.db.$disconnect();
      if (existsSync(prepared.root)) rmSync(prepared.root, { recursive: true, force: true });
    }
  });
});
