// Bark (L78): encrypted push to ${BARK_URL}/${BARK_DEVICE_KEY}. The JSON {title, body, url} is
// AES-CBC (PKCS7) encrypted with BARK_ENCRYPTION_KEY / BARK_ENCRYPTION_IV, matching the Bark
// app's "Encryption" settings; only the title and the deep link leave the server.
import { createCipheriv } from "node:crypto";
import { postWithRetry } from "./retry.ts";
import type { FetchLike, PushMessage, PushOutcome, PushProvider } from "./types.ts";

export interface BarkOptions { url: string; deviceKey: string; encryptionKey: string; encryptionIv: string; fetch?: FetchLike; retryDelayMs?: number }

/** Base64 AES-CBC ciphertext; key length picks AES-128/192/256 (Node pads with PKCS7). */
export function barkEncrypt(plaintext: string, key: string, iv: string): string {
  const keyBytes = Buffer.from(key, "utf8");
  const cipher = createCipheriv(`aes-${keyBytes.length * 8}-cbc`, keyBytes, Buffer.from(iv, "utf8"));
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

export class BarkProvider implements PushProvider {
  readonly name = "bark" as const;
  private readonly fetchFn: FetchLike;

  constructor(private readonly options: BarkOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  /**
   * M21, best effort, all inside the ciphertext (nothing new in clear): `passive` (quiet hours) is
   * Bark's `level: "passive"`; `collapseId` goes as `id`, which newer Bark apps use to replace a
   * notification with the same id (older ones ignore it). Bark has no server-side withdraw.
   */
  async send(message: PushMessage): Promise<PushOutcome> {
    const { url, deviceKey, encryptionKey, encryptionIv } = this.options;
    const plain = {
      title: message.title, body: message.teaser, url: message.route,
      ...(message.passive ? { level: "passive" } : {}),
      ...(message.collapseId ? { id: message.collapseId } : {}),
    };
    const ciphertext = barkEncrypt(JSON.stringify(plain), encryptionKey, encryptionIv);
    const body = new URLSearchParams({ ciphertext, iv: encryptionIv }).toString();
    return postWithRetry(this.name, this.fetchFn, `${url}/${deviceKey}`, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, this.options.retryDelayMs ?? 1000);
  }

  async close(): Promise<void> {}
}
