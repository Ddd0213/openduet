import { convert } from "html-to-text";
import { z } from "zod";
import { READ_FEED_MAX_ITEMS, READ_FEED_SUMMARY_MAX_CHARS } from "../contract/m25.ts";
import { decodePage, fetchPublic, type WebFetchDeps } from "../web/fetch.ts";
import { WebError, withDeadline } from "../web/http.ts";
import type { BuiltinConfig } from "./config.ts";
import { runBuiltin } from "./state.ts";
import { child, children, localName, parseXml, xmlText, type XmlNode } from "./xml.ts";

export const FeedInput = z.object({ url: z.string().max(8192).pipe(z.url({ protocol: /^https?$/ })), limit: z.number().int().min(1).max(READ_FEED_MAX_ITEMS).default(10) }).strict();
const plain = (text: string) => convert(text, { wordwrap: false, selectors: [{ selector: "a", options: { ignoreHref: true } }, { selector: "img", format: "skip" }, { selector: "script", format: "skip" }, { selector: "style", format: "skip" }] }).replace(/\s+/g, " ").trim();
const cut = (s: string, max: number) => Array.from(s).slice(0, max).join("");
const field = (node: XmlNode, name: string) => xmlText(child(node, name));
function link(node: XmlNode, base: string, atom: boolean): string | null {
  const links = children(node, "link");
  const selected = atom ? links.find(l => !l.attributes.rel || l.attributes.rel === "alternate") : links.find(l => !l.attributes.href);
  const value = selected && (atom ? selected.attributes.href : xmlText(selected));
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function baseFor(node: XmlNode, parent: string): string {
  try { return new URL(node.attributes["xml:base"] ?? parent, parent).href; } catch { return parent; }
}

export function parseFeed(xml: string, url: string, limit = 10) {
  if (/^\s*(?:<\?xml[^>]*>\s*)?<(?:!doctype\s+html|html|body)\b/i.test(xml)) throw new WebError("This page isn't an RSS or Atom feed. Read it with web_fetch instead.");
  const root = parseXml(xml), name = localName(root), atom = name === "feed";
  const channel = atom ? root : child(root, "channel");
  if (!channel || !["rss", "RDF", "feed"].includes(name)) throw new WebError("This page isn't an RSS or Atom feed. Read it with web_fetch instead.");
  const base = atom ? baseFor(root, url) : baseFor(channel, baseFor(root, url));
  const entries = atom ? children(root, "entry") : children(name === "RDF" ? root : channel, "item");
  const items = entries.map(entry => {
    const published = field(entry, atom ? "published" : "pubDate") || field(entry, atom ? "updated" : "date");
    const time = Date.parse(published);
    return {
      title: cut(plain(field(entry, "title")), 500), link: link(entry, baseFor(entry, base), atom),
      published: Number.isFinite(time) ? new Date(time).toISOString() : null,
      summary: cut(plain(field(entry, atom ? "summary" : "description") || field(entry, atom ? "content" : "encoded")), READ_FEED_SUMMARY_MAX_CHARS),
    };
  }).sort((a, b) => (b.published ? Date.parse(b.published) : -Infinity) - (a.published ? Date.parse(a.published) : -Infinity));
  return { feed: { title: cut(plain(field(channel, "title")), 500), link: link(channel, base, atom) }, items: items.slice(0, Math.max(1, Math.min(READ_FEED_MAX_ITEMS, limit))) };
}

export async function readFeed(raw: unknown, config: BuiltinConfig, deps: WebFetchDeps = {}) {
  const input = FeedInput.safeParse(raw);
  if (!input.success) return { isError: true as const, error: "Invalid feed arguments" };
  return runBuiltin("read_feed", config, () => withDeadline(deps.signal, async signal => {
    const { url, bytes, contentType } = await fetchPublic(input.data.url, deps, signal);
    return parseFeed(decodePage(bytes, contentType), url, input.data.limit);
  }));
}
