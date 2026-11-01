// M13 routes (contract "Routes"; session required, another user's ids 404). Every call route
// answers Cache-Control: no-store (StartCallResponse can carry the StepFun key).
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { CallLinesRequest, CallToolRequest, EndCallRequest, StartCallRequest, StartCallResponse, UpdateVoiceSettingsRequest, VoiceSettings, CallDetail, CallToolResponse, VoiceTool, LEGACY_VOICE_TOOL_NAMES } from "../contract/m13.ts";
import { MessageActionResponse } from "../contract/messages.ts";
import { TRANSCRIPTION_MAX_BYTES, TranscriptionResponse } from "../contract/m27voice.ts";
import { HttpError, readJson } from "../http.ts";
import type { CallService } from "./service.ts";
import type { ToolName } from "./tools.ts";
import type { Dictation } from "./dictation.ts";
import { clipTooLarge } from "./wav.ts";

const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
  c.res.headers.set("Cache-Control", "no-store");
};

const callId = (c: Context<AppEnv>): string => {
  const id = c.req.param("id");
  if (!id) throw new HttpError(404, "not_found", "Not found.");
  return id;
};

/** The tool body: an unknown tool name is an answer for the voice (not a 400); anything else must fit. */
async function readTool(c: Context<AppEnv>) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "validation_failed", "Request body must be JSON.");
  }
  const known = VoiceTool.shape.name.options as readonly string[];
  const name = raw && typeof raw === "object" ? (raw as { name?: unknown }).name : undefined;
  const canonical = typeof name === "string" ? LEGACY_VOICE_TOOL_NAMES[name as keyof typeof LEGACY_VOICE_TOOL_NAMES] ?? name : name;
  if (typeof canonical === "string" && canonical.length <= 200 && !known.includes(canonical)) {
    const parsed = CallToolRequest.safeParse({ ...(raw as object), name: "assistant_status" });
    if (parsed.success) return { name: null, rawName: String(name), arguments: parsed.data.arguments, lines: parsed.data.lines };
  }
  const parsed = CallToolRequest.safeParse(typeof canonical === "string" ? { ...(raw as object), name: canonical } : raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || undefined;
    throw new HttpError(400, "validation_failed", `${field ? `${field}: ` : ""}${issue?.message ?? "invalid"}`, field);
  }
  return { name: parsed.data.name as ToolName, rawName: typeof name === "string" ? name : parsed.data.name, arguments: parsed.data.arguments, lines: parsed.data.lines };
}

export function registerCallRoutes(service: CallService, dictation: Dictation): RegisterRoutes {
  return (app: Hono<AppEnv>) => {
    app.use("/api/calls", noStore);
    app.use("/api/calls/*", noStore);
    app.use("/api/voice-settings", noStore);
    app.use("/api/transcriptions", noStore);
    app.post("/api/transcriptions", bodyLimit({ maxSize: TRANSCRIPTION_MAX_BYTES + 64 * 1024, onError: () => { throw clipTooLarge(); } }), async (c) => {
      const badFile = () => new HttpError(400, "validation_failed", "file: send a multipart WAV recording", "file");
      if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) throw badFile();
      let form: FormData;
      try { form = await c.req.formData(); } catch { throw badFile(); }
      const file = form.get("file");
      return c.json(TranscriptionResponse.parse(await dictation.run(c.get("user").id, file instanceof File ? file : null, form.get("language"))));
    });

    app.get("/api/voice-settings", async (c) => c.json(VoiceSettings.parse(await service.settings(c.get("user").id))));
    app.put("/api/voice-settings", async (c) => {
      const input = await readJson(c, UpdateVoiceSettingsRequest);
      return c.json(VoiceSettings.parse(await service.updateSettings(c.get("user").id, input)));
    });

    app.post("/api/calls", async (c) => {
      const input = await readJson(c, StartCallRequest);
      return c.json(StartCallResponse.parse(await service.start(c.get("user"), input)));
    });
    app.get("/api/calls/:id", async (c) => c.json(CallDetail.parse(await service.detail(c.get("user").id, callId(c)))));
    app.post("/api/calls/:id/lines", async (c) => {
      const input = await readJson(c, CallLinesRequest);
      await service.addLines(c.get("user").id, callId(c), input.lines);
      return c.body(null, 204);
    });
    app.post("/api/calls/:id/tool", async (c) => {
      const input = await readTool(c);
      const result = await service.tool(c.get("user").id, callId(c), input.name, input.rawName, input.arguments, input.lines);
      return c.json(CallToolResponse.parse({ result }));
    });
    app.post("/api/calls/:id/end", async (c) => {
      const input = await readJson(c, EndCallRequest);
      const message = await service.end(c.get("user").id, callId(c), input);
      return c.json(MessageActionResponse.parse({ message }));
    });
  };
}
