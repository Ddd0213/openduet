// OpenDuet's computer as the app sees it. The app never talks to the computer or sees its
// token: the backend proxies everything, authenticated by the app's own session.
import { z } from "zod";
import { Id, Phrase } from "./common.ts";
import { SignInOutcome, SignInStep } from "./m20.ts";
import { BrowserBar } from "./m27browser.ts";

/** GET /api/computer (and the "computer" event). */
export const ComputerState = z.object({
  available: z.boolean(),
  browser: z.enum(["off", "starting", "ready"]),
  /** who drives the browser: OpenDuet, or the user after Take over */
  controller: z.enum(["assistant", "user"]),
  url: z.string().nullable(),
  domain: z.string().nullable(),
  /** what blocks OpenDuet, e.g. a human check */
  blocked: z.enum(["human_check"]).nullable(),
});
export type ComputerState = z.infer<typeof ComputerState>;

/**
 * POST /api/computer/take and /release (Take over / Hand back to OpenDuet), and M20's
 * POST /api/computer/sleep (close the browser now instead of after the idle time; 409
 * computer_busy while OpenDuet is using it or the user is in control).
 */
export const ComputerControlResponse = z.object({ computer: ComputerState });

/**
 * POST /api/computer/sign-in/:requestId. The body is excluded from every log; the password
 * goes to the computer's /human/secret and is typed into the exact field, then forgotten.
 */
export const SignInCardRequest = z
  .object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1024) })
  .strict();
/**
 * Answer of every sign-in card action (submit, M20's /code, /take-over and /dismiss).
 * M20 (additive): after the password the site may ask for a verification code: state "sent" with
 * step "code" (the card goes on to the code field). `reason` says why it failed (wrong page, the
 * site moved to another sign-in page, the code was refused ...). `outcome` is set by
 * /take-over and /dismiss (state "expired"); /take-over also returns the computer, now in the
 * user's hands, so the app opens the full-screen view.
 */
export const SignInCardResponse = z.object({
  requestId: Id,
  state: z.enum(["sent", "failed", "expired"]),
  step: SignInStep.default("credentials"),
  reason: Phrase.nullable().default(null),
  outcome: SignInOutcome.nullable().default(null),
  computer: ComputerState.nullable().default(null),
});

/**
 * WebSocket /api/computer/stream (Authorization: Bearer). Server -> app: binary JPEG frames
 * and JSON text frames of ComputerServerMessage. App -> server: ComputerClientMessage while
 * the user is in control. Coordinates are 0...1 fractions of the frame.
 */
export const ComputerClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  z.object({
    type: z.literal("drag"),
    from: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
    to: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  }),
  z.object({ type: z.literal("scroll"), dx: z.number(), dy: z.number() }),
  z.object({ type: z.literal("text"), text: z.string().max(4000) }),
  z.object({ type: z.literal("key"), key: z.enum(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) }),
]);
export const ComputerServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), computer: ComputerState }),
  z.object({ type: z.literal("frame_meta"), width: z.number().int().positive(), height: z.number().int().positive() }),
  /** M27 browser: the app's own tab strip and address bar, when they changed (m27browser.ts). */
  z.object({ type: z.literal("browser_bar"), bar: BrowserBar }),
]);
