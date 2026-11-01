// A bounded XML tree for feeds. No DTD, external entities, network resolution or code execution.
// CDATA/text are decoded only once; names retain their namespace prefix for closing-tag checks.
import { WebError } from "../web/http.ts";
export interface XmlNode { name: string; attributes: Record<string, string>; children: (XmlNode | string)[] }
const invalid = () => new WebError("Invalid feed XML (DTDs and custom entities are not supported)");
const NAME = "[A-Za-z_][A-Za-z0-9_.:-]*";
const OPEN = new RegExp(`^(${NAME})`);
const ATTR = new RegExp(`^\\s+(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`);
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(text: string): string {
  return text.replace(/&([^;\s<]*);|&/g, (_, entity: string | undefined) => {
    if (entity && Object.hasOwn(entities, entity)) return entities[entity]!;
    if (entity && /^#(?:x[0-9a-fA-F]+|[0-9]+)$/.test(entity)) {
      const cp = entity[1] === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (cp === 9 || cp === 10 || cp === 13 || cp >= 32 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp);
    }
    throw invalid();
  });
}
export function parseXml(xml: string): XmlNode {
  const doc: XmlNode = { name: "", attributes: {}, children: [] }, stack = [doc];
  let pos = 0, nodes = 0;
  while (pos < xml.length) {
    const current = stack.at(-1)!;
    if (xml[pos] !== "<") {
      const next = xml.indexOf("<", pos), end = next < 0 ? xml.length : next;
      const text = decode(xml.slice(pos, end));
      if (stack.length === 1 && text.trim()) throw invalid();
      current.children.push(text); pos = end; continue;
    }
    if (xml.startsWith("<!--", pos) || xml.startsWith("<?", pos) || xml.startsWith("<![CDATA[", pos)) {
      const cdata = xml.startsWith("<![CDATA[", pos), pi = xml.startsWith("<?", pos);
      const start = pos + (cdata ? 9 : pi ? 2 : 4), marker = cdata ? "]]>" : pi ? "?>" : "-->";
      const end = xml.indexOf(marker, start);
      if (end < 0 || cdata && stack.length === 1) throw invalid();
      if (cdata) current.children.push(xml.slice(start, end));
      pos = end + marker.length; continue;
    }
    if (xml.startsWith("<!", pos)) throw invalid();
    // A '>' in a quoted attribute is not the end of the tag.
    let end = pos + 1, quote = "";
    for (; end < xml.length; end++) {
      const ch = xml[end]!;
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    if (end === xml.length) throw invalid();
    let tag = xml.slice(pos + 1, end); pos = end + 1;
    if (tag.startsWith("/")) {
      if (stack.length === 1 || tag.slice(1).trim() !== current.name) throw invalid();
      stack.pop(); continue;
    }
    const empty = tag.endsWith("/"); if (empty) tag = tag.slice(0, -1);
    const name = OPEN.exec(tag)?.[1]; if (!name) throw invalid();
    let rest = tag.slice(name.length);
    const node: XmlNode = { name, attributes: Object.create(null) as Record<string, string>, children: [] };
    while (rest.trim()) {
      const attr = ATTR.exec(rest); if (!attr || Object.hasOwn(node.attributes, attr[1]!)) throw invalid();
      node.attributes[attr[1]!] = decode(attr[2] ?? attr[3]!); rest = rest.slice(attr[0].length);
    }
    if (++nodes > 50_000 || stack.length > 64) throw new WebError("Feed XML is too complex");
    current.children.push(node); if (!empty) stack.push(node);
  }
  const roots = doc.children.filter((c): c is XmlNode => typeof c !== "string");
  if (stack.length !== 1 || roots.length !== 1) throw invalid();
  return roots[0]!;
}
export const localName = (node: XmlNode) => node.name.split(":").at(-1)!;
export const children = (node: XmlNode, name: string): XmlNode[] => node.children.filter((c): c is XmlNode => typeof c !== "string" && localName(c) === name);
export const child = (node: XmlNode, name: string) => children(node, name)[0];
export const xmlText = (node: XmlNode | undefined): string => node ? node.children.map(c => typeof c === "string" ? c : ` ${xmlText(c)} `).join("") : "";
