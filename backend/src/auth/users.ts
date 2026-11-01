// Administrative account operations. No password or credential is ever logged.
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { Language } from "../contract/common.ts";
import type { Db } from "../db.ts";
import type { Auth } from "./auth.ts";
import { Timezone, Username } from "./validation.ts";
import { isCommonPassword } from "./passwords.ts";

const CreateUserInput = z.object({
  username: Username,
  name: z.string().trim().min(1).max(200),
  firstName: z.string().trim().min(1).max(64).optional(),
  language: Language.default("en"),
  password: z.string(),
  timezone: Timezone.optional(),
});

export type CreateUserOptions = {
  username: string;
  name: string;
  firstName?: string;
  language?: string;
  password: string;
  timezone?: string;
  random?: () => number;
};

export async function validatePassword(auth: Auth, value: unknown): Promise<string> {
  const { config } = (await auth.$context).password;
  return z.string()
    .min(config.minPasswordLength, `Password must be at least ${config.minPasswordLength} characters.`)
    .max(config.maxPasswordLength, `Password must be at most ${config.maxPasswordLength} characters.`)
    .refine(value => !isCommonPassword(value), "Choose a password that isn't a common password.")
    .parse(value);
}

export async function createUser(db: Db, auth: Auth, options: CreateUserOptions) {
  const input = CreateUserInput.parse(options);
  const password = await validatePassword(auth, input.password);
  const timezone = Timezone.parse(input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const firstName = input.firstName ?? input.name.split(/\s+/)[0]!;
  const random = options.random ?? Math.random;
  const sample = (size: number) => Math.floor(z.number().min(0).lt(1).parse(random()) * size);
  const hour = 7 + sample(2);
  const minute = 1 + 2 * sample(30);
  const checkinMinute = sample(60);
  const hash = await (await auth.$context).password.hash(password);
  try {
    return await db.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { username: input.username } })) {
        throw new Error(`Username "${input.username}" already exists.`);
      }
      const user = await tx.user.create({ data: {
        id: randomUUID(),
        username: input.username,
        displayUsername: options.username,
        authEmail: `${input.username}@users.invalid`,
        name: input.name,
        firstName,
        language: input.language,
        timezone,
        briefTime: `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`,
        checkinMinute,
      } });
      // Same credential shape used by Better Auth's sign-up/internalAdapter.linkAccount.
      await tx.account.create({ data: {
        id: randomUUID(), userId: user.id, accountId: user.id,
        providerId: "credential", password: hash,
      } });
      await tx.channel.create({ data: {
        userId: user.id, isMain: true, name: "", icon: "checkbox", colorHex: "#E69F4E",
      } });
      return user;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new Error(`Username "${input.username}" already exists.`);
    }
    throw error;
  }
}

export async function setPassword(db: Db, auth: Auth, username: string, newPassword: string): Promise<void> {
  const normalized = Username.parse(username);
  const password = await validatePassword(auth, newPassword);
  const hash = await (await auth.$context).password.hash(password);
  await db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { username: normalized } });
    if (!user) throw new Error(`Username "${normalized}" does not exist.`);
    const where = { userId: user.id, providerId: "credential" };
    const updated = await tx.account.updateMany({ where, data: { password: hash } });
    if (!updated.count) {
      await tx.account.create({ data: {
        id: randomUUID(), ...where, accountId: user.id, password: hash,
      } });
    }
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.deviceToken.deleteMany({ where: { userId: user.id } });
  });
}
