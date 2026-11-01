// APNs provider token: an ES256 JWT {iss: team id, iat} signed with the .p8 key and sent as
// "authorization: bearer <jwt>". Apple wants it refreshed between 20 and 60 minutes; we keep 50.
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export const APNS_JWT_TTL_MS = 50 * 60 * 1000;

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

export async function signApnsJwt(pem: string, keyId: string, teamId: string, issuedAt: Date): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: keyId })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: teamId, iat: Math.floor(issuedAt.getTime() / 1000) })));
  // WebCrypto's ECDSA signature is already the raw r||s form JWS expects.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(new Uint8Array(signature))}`;
}

/** Caches the token for APNS_JWT_TTL_MS; reset() after Apple rejects it (ExpiredProviderToken). */
export class ApnsTokenCache {
  private cached: { token: string; at: number } | null = null;

  constructor(
    private readonly pem: string,
    private readonly keyId: string,
    private readonly teamId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async token(): Promise<string> {
    const now = this.now();
    if (this.cached && now.getTime() - this.cached.at < APNS_JWT_TTL_MS) return this.cached.token;
    const token = await signApnsJwt(this.pem, this.keyId, this.teamId, now);
    this.cached = { token, at: now.getTime() };
    return token;
  }

  reset(): void {
    this.cached = null;
  }
}
