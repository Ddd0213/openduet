// A signed-in user for route tests: creates the account (with its main thread) and signs in.
import { createUser } from "../../src/auth/users.ts";
import { SignInResponse } from "../../src/contract/auth.ts";
import type { TestApp } from "./app.ts";

export const TEST_PASSWORD = "test-only correct horse battery staple";

export interface SignedIn { token: string; userId: string; mainChannelId: string; headers: Record<string, string> }

export async function signUp(fixture: TestApp, username: string, name = "Alex Kim"): Promise<SignedIn> {
  await createUser(fixture.db, fixture.auth, { username, name, password: TEST_PASSWORD, timezone: "UTC" });
  const response = await fixture.app.request("/api/session", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  if (response.status !== 200) throw new Error(`sign-in failed: ${response.status}`);
  const { token, user } = SignInResponse.parse(await response.json());
  return { token, userId: user.id, mainChannelId: user.mainChannelId, headers: { Authorization: `Bearer ${token}` } };
}
