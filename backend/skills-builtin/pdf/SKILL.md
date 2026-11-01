---
name: pdf
description: Create a PDF from local HTML with Chromium, or read a PDF with unpdf. Use for PDF documents and exports, including Chinese text, on OpenDuet's computer.
---

# PDFs on OpenDuet's computer

Use computer_exec and the computer's existing Node packages. Do not run programs on the backend or install Python PDF libraries. Store work under /workspace; send the finished file with send_file only after checking it. Never claim a file exists before a tool creates it.

## Create: HTML → Chromium → PDF

Write a local UTF-8 HTML document with inline CSS, real content, and no external fonts, CDNs or remote images. Escape inserted text. Use `font-family: "WenQuanYi Zen Hei", sans-serif` for Chinese (the wqy font is installed); include `meta charset="utf-8"`, explicit margins and sensible print page breaks. Use local/data-URL images only.

Run Node through computer_exec; resolve the preinstalled packages from /app, not from the document directory. The shell intentionally does not inherit the computer service's environment and sets HOME to /workspace: set Playwright's installed browser directory before loading the package. This image installs full Chromium only (`--no-shell`), so select `channel: 'chromium'` rather than the default headless shell.

```js
process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright';
const { createRequire } = require('node:module');
const requireApp = createRequire('/app/package.json');
const { chromium } = requireApp('playwright');
const fs = require('node:fs/promises');
(async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    // Rendering a document must not make network requests.
    await page.route('**/*', route => route.abort());
    await page.setContent(await fs.readFile('/workspace/document.html', 'utf8'), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: '/workspace/document.pdf', format: 'A4', printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '16mm', right: '16mm' } });
    await page.screenshot({ path: '/workspace/document-preview.png', fullPage: true });
  } finally { await browser.close(); }
})();
```

Choose filenames appropriate to this work and adapt all paths consistently. Chromium is managed by Playwright; do not guess its versioned executable path. If a package or browser is unavailable, report the actual error rather than downloading a new runtime.

For Office documents, use officecli to inspect and obtain local HTML (`officecli help view` for exact syntax), then print HTML with Chromium. Linux OfficeCLI does not have a built-in PDF exporter; do not assume `view pdf` works or install an exporter automatically.

## Read and verify: unpdf + NFKC

```js
const { createRequire } = require('node:module');
const requireApp = createRequire('/app/package.json');
const fs = require('node:fs/promises');
(async () => {
  const { extractText } = await import(requireApp.resolve('unpdf'));
  const data = new Uint8Array(await fs.readFile('/workspace/document.pdf'));
  const { totalPages, text } = await extractText(data, { mergePages: true });
  console.log(JSON.stringify({ totalPages, text: text.normalize('NFKC') }));
})();
```

NFKC normalizes compatibility characters such as Kangxi radicals that some CJK PDF font mappings produce. Keep the original file unchanged. Compare extracted text with the intended content, numbers and headings. Empty extracted text may mean a scanned/image-only PDF: say so; unpdf is not OCR. Do not invent text from an unreadable document.

Text extraction does not verify layout. Inspect the preview using available image/browser tools for clipping, missing glyphs, table overflow, legibility and spacing. Check page count and page breaks; an HTML screenshot is not proof that every printed page looks right. If PDF visual inspection is unavailable, explicitly distinguish text verification from visual verification. Fix known defects before sending the PDF.
