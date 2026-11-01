// Test doubles for push delivery: nothing here touches the network.
import type { Http2Request, Http2Transport } from "../../src/notify/providers/http2.ts";
import type { FetchLike, PushMessage, PushOutcome, PushProvider } from "../../src/notify/providers/types.ts";

export class FakeProvider implements PushProvider {
  readonly name = "ntfy" as const;
  readonly sent: PushMessage[] = [];
  closed = false;
  constructor(private readonly outcome: PushOutcome | Error = "sent") {}
  async send(message: PushMessage): Promise<PushOutcome> {
    this.sent.push(message);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** M21: a provider that can withdraw (like APNs); `hold` delays send() until released. */
export class WithdrawingProvider extends FakeProvider {
  readonly withdrawn: Array<{ userId: string; collapseId: string }> = [];
  hold: Promise<void> | null = null;
  override async send(message: PushMessage): Promise<PushOutcome> {
    if (this.hold) await this.hold;
    return super.send(message);
  }
  async withdraw(userId: string, collapseId: string): Promise<PushOutcome> {
    this.withdrawn.push({ userId, collapseId });
    return "sent";
  }
}

export interface FetchCall { url: string; method: string; headers: Record<string, string>; body: string }

/** A fetch that records calls and answers with the given statuses (Error = network failure), then 200. */
export function fakeFetch(statuses: Array<number | Error> = []): { calls: FetchCall[]; fetch: FetchLike } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const next = statuses.shift() ?? 200;
      if (next instanceof Error) throw next;
      return { status: next };
    },
  };
}

type Scripted = { status: number; body?: string } | Error;

/** An HTTP/2 transport that records requests and answers from a script (or per request), then 200. */
export function fakeTransport(script: Scripted[] | ((req: Http2Request) => Scripted) = []): { requests: Http2Request[]; transport: Http2Transport; closed: () => boolean } {
  const requests: Http2Request[] = [];
  let closed = false;
  return {
    requests,
    closed: () => closed,
    transport: {
      request: async (req) => {
        requests.push(req);
        const next = typeof script === "function" ? script(req) : (script.shift() ?? { status: 200 });
        if (next instanceof Error) throw next;
        return { status: next.status, body: next.body ?? "" };
      },
      close: async () => {
        closed = true;
      },
    },
  };
}

/** A P-256 private key in PKCS#8 PEM, like an Apple .p8, plus its public key for verifying. */
export async function testP8(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}
