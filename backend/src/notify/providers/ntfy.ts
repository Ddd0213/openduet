// ntfy (L78): POST ${NTFY_URL}/${NTFY_TOPIC}; the push carries only the title and the deep link
// (Click), the text stays on the server. One deployment-wide topic, not per DeviceToken.
import { postWithRetry } from "./retry.ts";
import type { FetchLike, PushMessage, PushOutcome, PushProvider } from "./types.ts";

export interface NtfyOptions { url: string; topic: string; token: string | null; fetch?: FetchLike; retryDelayMs?: number }

/** HTTP headers are Latin-1; non-ASCII titles go as RFC 2047 encoded-words (ntfy decodes them). */
const headerText = (text: string) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`);

export class NtfyProvider implements PushProvider {
  readonly name = "ntfy" as const;
  private readonly fetchFn: FetchLike;

  constructor(private readonly options: NtfyOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  /**
   * M21: `passive` (quiet hours) sends Priority 2 ("low": no sound or vibration in the ntfy app).
   * ntfy has no collapse id and no server-side withdraw, so `collapseId` is not sent and a decided
   * approval's push stays on the phone until the app is opened.
   */
  async send(message: PushMessage): Promise<PushOutcome> {
    const headers: Record<string, string> = { Title: headerText(message.title), Click: message.route, "Content-Type": "text/plain; charset=utf-8" };
    if (message.passive) headers.Priority = "2";
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    return postWithRetry(this.name, this.fetchFn, `${this.options.url}/${this.options.topic}`, { headers, body: message.teaser }, this.options.retryDelayMs ?? 1000);
  }

  async close(): Promise<void> {}
}
