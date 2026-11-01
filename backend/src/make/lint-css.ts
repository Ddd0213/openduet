// Static, conservative CSS checks, not a layout engine. Ignore print/desktop-only rules,
// strings and comments; responsive max-width caps and base-wrapped tables are intentional.
export interface CssIssue { code: string; path: string; message: string }

function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of css.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    out.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).replace(/\s*!important\s*$/i, "").trim().toLowerCase());
  }
  return out;
}

// Preserve delimiters outside strings, so content:"width:900px" is never a declaration.
function scrub(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
}

export function lintDeclarations(css: string, path: string, intrinsicallyFluid = false, scrollingTable = false): CssIssue[] {
  const props = declarations(scrub(css));
  if (props.get("display") === "none") return [];
  const issues: CssIssue[] = [];
  const cap = props.get("max-width") ?? "";
  const responsive = /^(?:100|\d{1,2}(?:\.\d+)?)%$/.test(cap) || (/^\d+(?:\.\d+)?px$/.test(cap) && parseFloat(cap) <= 360);
  for (const key of ["width", "min-width"]) {
    const value = props.get(key) ?? "";
    if (/^\d+(?:\.\d+)?px$/.test(value) && parseFloat(value) > 360 && !scrollingTable && !(key === "width" && (responsive || intrinsicallyFluid))) {
      issues.push({ code: "layout.fixed_width", path: `${path}/${key}`, message: `${key}:${value} can overflow a phone; use a fluid width (or a responsive max-width for width).` });
    }
  }
  for (const [key, value] of props) {
    if (!key.startsWith("--") && /(^|[^\d.])100vw\b/.test(value)) {
      issues.push({ code: "layout.viewport_width", path: `${path}/${key}`, message: "100vw includes the viewport gutters; use 100% instead." });
    }
  }
  if (props.get("position") === "fixed") {
    for (const key of ["width", "min-width"]) {
      const value = props.get(key) ?? "";
      if (/^\d+(?:\.\d+)?%$/.test(value) && parseFloat(value) > 100 && !(key === "width" && responsive)) {
        issues.push({ code: "layout.fixed_overflow", path: `${path}/${key}`, message: `A fixed element with ${key}:${value} extends beyond the screen.` });
      }
    }
  }
  return issues;
}

function desktopOnly(media: string): boolean {
  // A comma means alternatives: skip only if EVERY alternative excludes a phone screen.
  return media.split(",").every((part) => {
    if (/\bprint\b/i.test(part) && !/\bnot\s+print\b/i.test(part)) return true;
    if (/\bnot\b/i.test(part)) return false;
    const min = /\(\s*min-width\s*:\s*([\d.]+)(px|em|rem)\s*\)/i.exec(part);
    return !!min && Number(min[1]) * (min[2]!.toLowerCase() === "px" ? 1 : 16) > 390;
  });
}

export function lintStylesheet(css: string, path: string): CssIssue[] {
  const text = scrub(css);
  const issues: CssIssue[] = [];
  let start = 0;
  while (start < text.length) {
    const open = text.indexOf("{", start);
    if (open < 0) break;
    let end = open + 1, depth = 1;
    for (; end < text.length && depth; end++) {
      if (text[end] === "{") depth++;
      else if (text[end] === "}") depth--;
    }
    const selector = text.slice(start, open).trim();
    const body = text.slice(open + 1, depth ? end : end - 1);
    start = end;
    if (/^@media\b/i.test(selector)) {
      if (!desktopOnly(selector)) issues.push(...lintStylesheet(body, `${path} ${selector}`));
    } else if (/^@(?:supports|layer|container)\b/i.test(selector)) {
      issues.push(...lintStylesheet(body, `${path} ${selector}`));
    } else if (!selector.startsWith("@")) {
      // Tables get their own scroll wrapper, even when min-width is intentionally large.
      const selectors = selector.split(",").map((s) => s.trim());
      const fluid = selectors.every((s) => /^(?:table|img|svg|canvas|video)(?:[.#][\w-]+)*$/i.test(s));
      const table = selectors.every((s) => /(?:^|[\s>+~])table(?:[.#][\w-]+)*$/i.test(s));
      issues.push(...lintDeclarations(body, `${path} ${selector}`, fluid, table));
    }
  }
  return issues;
}
