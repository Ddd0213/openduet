import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fakeIpPolicy, isPublicAddress } from "../network/address-policy.ts";
import { addressErrorOf, sharedPool } from "../network/pool.ts";
import { TextDecoder } from "node:util";
import { convert } from "html-to-text";
import { extractText } from "unpdf";
import { z } from "zod";
import { abortable, HttpStatusError, readBody, WebError, withDeadline, type HttpDeps } from "./http.ts";

export type Lookup = (hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>;
export interface WebFetchDeps extends HttpDeps { lookup?: Lookup }
/** M23: a PDF link returns its text (`format: "pdf"`, with its page count). */
export type WebFetchResult = { url: string; text: string; format?: "pdf"; pages?: number; isError?: false } | { isError: true; error: string };

/** M23: a PDF may be larger than a page (readBody's default is 2 MB). */
const PDF_MAX_BYTES = 10 * 1024 * 1024;
const isPdf = (bytes: Uint8Array) => bytes.length >= 5 && new TextDecoder("latin1").decode(bytes.subarray(0, 5)) === "%PDF-";

/** A PDF's text with unpdf (plan §7b), NFKC-normalised (some fonts map CJK to Kangxi radicals). */
async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  try {
    const { text, totalPages } = await extractText(bytes, { mergePages: true });
    return { text: text.normalize("NFKC"), pages: totalPages };
  } catch {
    throw new WebError("Could not read this PDF");
  }
}
const Url = z.string().max(8192).pipe(z.url({ protocol: /^https?$/ }));
const Addresses = z.array(z.object({ address: z.string(), family: z.union([z.literal(4), z.literal(6)]) })).min(1);

const PRIVATE = "Private or reserved addresses are not allowed";

/** `resolve`: check every DNS answer here (injected transports); the pool checks each new connection itself. */
async function checkUrl(raw: string, lookup: Lookup, signal: AbortSignal, resolve: boolean): Promise<URL> {
  await abortable(fakeIpPolicy.ensure(), signal);
  const parsed = Url.safeParse(raw);
  if (!parsed.success) throw new WebError("Only HTTP and HTTPS URLs are allowed");
  const url = new URL(parsed.data);
  if (url.username || url.password) throw new WebError("URL credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (!family && !resolve) return url;
  const addresses = Addresses.parse(family ? [{ address: host, family }] : await abortable(lookup(host, { all: true }), signal));
  for (const entry of addresses) {
    if (isIP(entry.address) !== entry.family || !isPublicAddress(entry.address)) throw new WebError(PRIVATE);
  }
  return url;
}

export function decodePage(bytes: Uint8Array, contentType: string): string {
  const header = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  let meta: string | undefined;
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const charset = /charset\s*=\s*["']?([^\s;"'/>]+)/i.exec(tag)?.[1];
    if (charset && (/\bcharset\s*=/i.test(tag) && (!/\bhttp-equiv\s*=/i.test(tag) || /http-equiv\s*=\s*["']?content-type/i.test(tag)))) { meta = charset; break; }
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8" : bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : undefined;
  const xml = /^\s*<\?xml\b[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1];
  const label = (header ?? meta ?? bom ?? xml ?? "utf-8").toLowerCase();
  const charset = label === "gb2312" ? "gbk" : label;
  try { return new TextDecoder(charset).decode(bytes); }
  catch { throw new WebError("Unsupported page charset"); }
}

/** The pool's refusal of a new connection, as checkUrl would have refused it. */
async function pooled(url: URL, init: RequestInit, lookup: Lookup | undefined): Promise<Response> {
  try {
    return await sharedPool(lookup).fetch(url, init);
  } catch (error) {
    const refused = addressErrorOf(error);
    if (refused?.kind === "blocked") throw new WebError(PRIVATE);
    throw error;
  }
}

/** Shared GET transport: every hop's address checked (here or per new pooled connection), redirects checked, no conversion or text cut. */
export async function fetchPublic(raw: string, deps: WebFetchDeps, signal: AbortSignal, pdf = false) {
  let target = raw;
  for (let redirects = 0; ; redirects++) {
    const url = await checkUrl(target, deps.lookup ?? dnsLookup, signal, !!deps.fetch);
    const headers = { "user-agent": "OpenDuet/1.0 (self-hosted assistant; web reader)", accept: pdf ? "text/html, text/plain;q=0.9, application/pdf;q=0.8, */*;q=0.1" : "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1" };
    const init = { method: "GET", redirect: "manual" as const, signal, headers };
    const request = deps.fetch ? deps.fetch(url, init) : pooled(url, init, deps.lookup);
    const response = await abortable(request, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      if (redirects >= 5) throw new WebError("Too many redirects (maximum 5)");
      const location = response.headers.get("location");
      if (!location) throw new WebError("Redirect has no destination");
      target = new URL(location, url).href;
      continue;
    }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new HttpStatusError(response.status); }
    const contentType = response.headers.get("content-type") ?? "";
    const bytes = await readBody(response, signal, pdf && /application\/pdf/i.test(contentType) ? PDF_MAX_BYTES : undefined);
    return { url: url.href, bytes, contentType };
  }
}

export async function webFetch(raw: string, deps: WebFetchDeps = {}): Promise<WebFetchResult> {
  try {
    return await withDeadline(deps.signal, async signal => {
      const { url, bytes, contentType } = await fetchPublic(raw, deps, signal, true);
      if (isPdf(bytes)) {
        const pdf = await pdfText(bytes);
        return { url, text: pdf.text.slice(0, 20_000), format: "pdf" as const, pages: pdf.pages };
      }
      const decoded = decodePage(bytes, contentType);
      const html = /html/i.test(contentType) || /<(!doctype\s+html|html|body)\b/i.test(decoded.slice(0, 4096));
      const text = html ? convert(decoded, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }, { selector: "script", format: "skip" }, { selector: "style", format: "skip" }] }) : decoded;
      return { url, text: text.slice(0, 20_000) };
    });
  } catch (error) { return { isError: true, error: error instanceof HttpStatusError ? `Page returned HTTP ${error.status}` : error instanceof WebError ? error.message : "Could not fetch page" }; }
}
