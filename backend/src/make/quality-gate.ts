// One instance per build job, discarded when that job ends. Never share it across artifacts.
// Integration point: ArtifactService.finish must call check() before saving; refusals are tool results.
import { checkHtml } from "./base.ts";
import { lintPage, type PageIssue, type PageLintOptions } from "./lint.ts";
import { log } from "../log.ts";

export const PAGE_LINT_ATTEMPTS = 3;
export type QualityCheck = { ok: true; warnings: PageIssue[]; attempt: number; degraded: boolean }
  | { ok: false; error: string; errors: PageIssue[]; warnings: PageIssue[]; attempt: number };

export class PageQualityGate {
  private attempts = 0;

  check(html: string, options: PageLintOptions): QualityCheck {
    const lint = lintPage(html, options);
    const basic = checkHtml(html);
    // Empty / non-HTML / external resources never become warnings, even after the lint budget.
    if (basic) {
      return { ok: false, error: [basic, ...lint.errors.map((i) => `${i.path}: ${i.message}`)].join("\n"), ...lint, attempt: this.attempts };
    }
    this.attempts++;
    if (!lint.errors.length) return { ok: true, warnings: lint.warnings, attempt: this.attempts, degraded: false };
    if (this.attempts >= PAGE_LINT_ATTEMPTS) {
      // No HTML, selector paths, content or metric values in logs.
      log.warn("Make page lint budget reached", { attempt: this.attempts, rules: [...new Set(lint.errors.map((i) => i.code))] });
      return { ok: true, warnings: [...lint.warnings, ...lint.errors], attempt: this.attempts, degraded: true };
    }
    return {
      ok: false, ...lint, attempt: this.attempts,
      error: ["finish_build did not save the page.", ...lint.errors.map((i) => `${i.path} [${i.code}]: ${i.message}`),
        "Fix all listed problems together, then call finish_build again. Keep this repair inside the build; do not describe lint or retry rounds to the user."].join("\n"),
    };
  }
}
