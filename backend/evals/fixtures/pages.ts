// Canned web pages for the fake web_fetch / web_search and the fake browser (computer_navigate):
// a plain article in each language, an almost empty JavaScript app shell, a page behind a login,
// and a real (Flate-compressed) PDF. Every host is under .example; nothing is fetched for real.
import { deflateSync } from "node:zlib";

export interface FakePage {
  url: string;
  contentType: string;
  body: Uint8Array;
  /** what OpenDuet's browser shows after rendering (computer_navigate / computer_read) */
  browser: { title: string; text: string; login?: boolean };
}

const html = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const bytes = (text: string) => new TextEncoder().encode(text);

/** A one-page PDF whose text is in a Flate-compressed content stream (like most real PDFs). */
export function pdfWith(lines: readonly string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = `BT /F1 12 Tf 72 740 Td 16 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const stream = deflateSync(Buffer.from(content, "latin1"));
  const head = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1");
  const objects: Buffer[] = [
    Buffer.from("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n", "latin1"),
    Buffer.from("2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n", "latin1"),
    Buffer.from("3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n", "latin1"),
    Buffer.concat([Buffer.from(`4 0 obj << /Length ${stream.length} /Filter /FlateDecode >> stream\n`, "latin1"), stream, Buffer.from("\nendstream endobj\n", "latin1")]),
    Buffer.from("5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n", "latin1"),
  ];
  const offsets: number[] = [];
  let at = head.length;
  for (const object of objects) { offsets.push(at); at += object.length; }
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  const trailer = `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  return new Uint8Array(Buffer.concat([head, ...objects, Buffer.from(xref + trailer, "latin1")]));
}

const REPORT = [
  "Greenfield Packaging Co. - Annual Report 2026",
  "Revenue grew 18% to 42.6 million dollars.",
  "Recycled board now makes up 61% of all boxes shipped.",
  "Two new plants opened, in Ningbo and in Monterrey.",
  "Outlook 2027: flat prices, a focus on compostable inks.",
];

export const PAGES: FakePage[] = [
  {
    url: "https://blog.fieldnotes.example/async-standups",
    contentType: "text/html; charset=utf-8",
    body: bytes(html("Why we stopped doing daily stand-ups", "<article><h1>Why we stopped doing daily stand-ups</h1><p>For two years our eight-person team met every morning at 9:30. In March we replaced the meeting with a written check-in posted by 10:00.</p><p>Three things changed. People with deep-work mornings stopped losing their first hour. Blockers surfaced earlier, because writing them down made them concrete. And the written log became a record new hires could read.</p><p>We kept one live meeting a week, on Mondays, for planning. The cost: some small talk is gone, so we added a 15-minute optional coffee call on Fridays.</p></article>")),
    browser: { title: "Why we stopped doing daily stand-ups", text: "Why we stopped doing daily stand-ups. Our team replaced the 9:30 meeting with a written check-in by 10:00; one live planning meeting on Mondays." },
  },
  {
    url: "https://www.designnotes.example/zh/remote-review",
    contentType: "text/html; charset=utf-8",
    body: bytes(html("远程设计评审的三个习惯", "<article><h1>远程设计评审的三个习惯</h1><p>我们工作室有一半同事在外地。远程评审一年下来，留下了三个习惯：</p><p>第一，评审前一天把稿子发出去，大家先写下意见，会上只讨论分歧。第二，每次只评一个问题，比如只看排版或者只看配色。第三，会后半小时内把结论写成一页纸，发给没参加的人。</p><p>结果是评审时间从一个半小时降到四十分钟，返工也少了。</p></article>")),
    browser: { title: "远程设计评审的三个习惯", text: "远程设计评审的三个习惯：提前发稿写意见；每次只评一个问题；会后半小时内写一页结论。" },
  },
  {
    url: "https://app.tallyboard.example/board/q4-launch",
    contentType: "text/html; charset=utf-8",
    body: bytes(html("Tallyboard", "<div id=\"root\"></div><noscript>You need to enable JavaScript to run this app.</noscript><script src=\"/static/js/main.4f2a1c.js\"></script>")),
    browser: { title: "Q4 launch · Tallyboard", text: "Q4 launch board. To do: final copy for the landing page (Mei), price sheet (Lin). In progress: product photos (Sam, due Thu). Done: logo files, domain setup." },
  },
  {
    url: "https://portal.ledgerline.example/statements/2026-10",
    contentType: "text/html; charset=utf-8",
    body: bytes(html("Sign in · Ledgerline", "<main><h1>Sign in to Ledgerline</h1><p>Sign in to view your statements.</p><form action=\"/login\" method=\"post\"><label>Email <input name=\"email\" type=\"email\"></label><label>Password <input name=\"password\" type=\"password\"></label><button>Sign in</button></form></main>")),
    browser: { title: "Sign in · Ledgerline", text: "Sign in to Ledgerline. Sign in to view your statements. Email. Password. Sign in.", login: true },
  },
  {
    url: "https://files.greenfield-pack.example/reports/annual-2026.pdf",
    contentType: "application/pdf",
    body: pdfWith(REPORT),
    browser: { title: "annual-2026.pdf", text: REPORT.join(" ") },
  },
];

/** Canned search hits (title, URL, snippet) for queries that mention a word in `when`. */
export const SEARCH_HITS: { when: RegExp; hits: { title: string; url: string; snippet: string }[] }[] = [
  {
    when: /weather|rain|天气|下雨/i,
    hits: [
      { title: "Shanghai weather tomorrow", url: "https://weather.example/shanghai", snippet: "Tomorrow: light rain in the afternoon, 14-19°C, wind NE 3." },
      { title: "上海天气预报", url: "https://tianqi.example/shanghai", snippet: "明天：下午小雨，14-19°C，东北风3级。" },
    ],
  },
  {
    when: /matte|gloss|哑光|亮光|finish|packaging|包装/i,
    hits: [
      { title: "Matte vs gloss packaging: what buyers prefer", url: "https://packagingdigest.example/matte-vs-gloss", snippet: "Matte reads premium and hides fingerprints; gloss makes colours pop on shelf." },
    ],
  },
];

export const GENERIC_HIT = (query: string) => [
  { title: `${query} - overview`, url: "https://encyclopedia.example/wiki/overview", snippet: `A general overview of ${query}.` },
];
