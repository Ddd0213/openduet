import { describe, expect, test } from "bun:test";
import { PAGE_SCRIPT, BASE_SCRIPT, stripInjected, withBase, checkHtml } from "../../src/make/base.ts";
import { SLIDE_CSS, SLIDE_SCRIPT, SLIDE_STYLE_VERSION } from "../../src/make/slides.ts";

function environment(contentHeight: number) {
  const props = new Map<string, string>();
  const attributes = new Set<string>();
  const childProps = new Map<string, string>();
  const child = { style: { setProperty: (name: string, value: string) => childProps.set(name, value) } };
  const scale = () => Number(props.get("--duet-slide-scale") ?? 1);
  const slide = {
    style: { setProperty: (name: string, value: string) => props.set(name, value) },
    setAttribute: (name: string) => attributes.add(name),
    removeAttribute: (name: string) => attributes.delete(name),
    querySelectorAll: () => [child],
    get scrollHeight() { return Math.max(Number.parseFloat(props.get("--duet-slide-height") ?? "0"), contentHeight * scale()); },
    getBoundingClientRect: () => ({ height: contentHeight * scale() }),
  };
  const listeners: Record<string, () => void> = {};
  let pending: (() => void) | undefined;
  const document = { body: {}, querySelectorAll: () => [slide], fonts: { ready: Promise.resolve() } };
  const window = {
    innerHeight: 700,
    getComputedStyle: (node: unknown) => ({ paddingTop: "10px", paddingBottom: "10px", fontSize: node === child ? "16px" : "17px" }),
    addEventListener: (name: string, callback: () => void) => { listeners[name] = callback; },
  };
  new Function("window", "document", "setTimeout", "clearTimeout", SLIDE_SCRIPT)(window, document, (fn: () => void) => { pending = fn; return 1; }, () => { pending = undefined; });
  return { props, attributes, childProps, window, listeners, flush: () => pending?.(), slide };
}

describe("versioned slide fitting", () => {
  test("fits an overflowing slide in bounded steps, using safe-area-adjusted viewport height", () => {
    const env = environment(730);
    expect(env.props.get("--duet-slide-height")).toBe("680px");
    expect(env.props.get("--duet-slide-scale")).toBe("0.9");
    expect(env.props.get("--duet-slide-font")).toBe("17px");
    expect(env.childProps.get("--duet-slide-font")).toBe("16px");
    expect(env.attributes.has("data-duet-fit")).toBe(true);
  });
  test("never shrinks below 0.8; excessive content grows instead of being cropped", () => {
    const env = environment(1200);
    expect(env.props.get("--duet-slide-scale")).toBe("0.8");
    expect(env.slide.scrollHeight).toBeGreaterThan(680);
    expect(SLIDE_CSS).toContain("max(13px,");
    expect(SLIDE_CSS).toContain("height:auto;max-height:none;overflow:visible");
    expect(SLIDE_SCRIPT).not.toContain("transform:");
  });
  test("resize and orientation recalculate from scale 1, rather than compounding small fonts", () => {
    const env = environment(730);
    env.window.innerHeight = 900;
    env.listeners.resize!(); env.flush();
    expect(env.props.get("--duet-slide-scale")).toBe("1");
    expect(env.childProps.get("--duet-slide-font")).toBe("16px");
    env.window.innerHeight = 500;
    env.listeners.orientationchange!(); env.flush();
    expect(env.props.get("--duet-slide-scale")).toBe("0.8");
    expect(env.listeners.load).toBeDefined();
  });
  test("non-slide pages do no fitting work and scripts remain offline", () => {
    expect(() => new Function("document", SLIDE_SCRIPT)({ querySelectorAll: () => [] })).not.toThrow();
    expect(() => new Function(PAGE_SCRIPT)).not.toThrow();
    expect(PAGE_SCRIPT).toContain(BASE_SCRIPT);
    expect(SLIDE_SCRIPT).not.toMatch(/fetch\(|https?:|XMLHttpRequest|<\/script/i);
    expect(SLIDE_CSS).toContain("@media screen"); // print keeps unscaled font sizes and page breaks
  });
  test("new geometry is versioned once and rebuild upgrades the saved version idempotently", () => {
    const legacy = '<!doctype html><style data-duet-base data-duet-base-version="1">.duet-slide{padding:40px}</style><html><head><title>Deck</title></head><body><section class="duet-slide"><h1>Title</h1></section></body></html>';
    const old = legacy;
    const next = withBase(legacy, { title: "Deck", lang: "en" });
    expect(legacy).toBe(old); // ordinary stored-page reads never inject or mutate a version
    expect(next).not.toContain('data-duet-base-version="1"');
    expect(next.match(/data-duet-base-version=/g)).toHaveLength(1);
    expect(next).toContain(`data-duet-base-version="${SLIDE_STYLE_VERSION}"`);
    expect(next).toContain(PAGE_SCRIPT);
    expect(withBase(next, { title: "Deck", lang: "en" })).toBe(next);
    expect(checkHtml(next)).toBeNull();
    expect(stripInjected(next)).not.toContain(SLIDE_CSS);
    expect(stripInjected(next.replaceAll(" data-duet-base", ""))).not.toContain(SLIDE_CSS);
  });
});
