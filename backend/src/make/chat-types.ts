// Shared make_artifact type contract for the artifact provider (which owns tool registration).
// Keep doc as the model-facing spelling for backward compatibility; storage calls it docs.
import { z } from "zod";
import type { ArtifactType } from "./prompts.ts";

export const MakeArtifactType = z.enum(["doc", "dashboard", "web_page", "slides", "design", "design_system"]);
export const MAKE_ARTIFACT_TYPE: Record<z.infer<typeof MakeArtifactType>, ArtifactType> = {
  doc: "docs", dashboard: "dashboard", web_page: "web_page", slides: "slides", design: "design", design_system: "design_system",
};
export const DESIGN_TOOL_GUIDANCE = "For a screen mockup, poster, logo or other visual design use make_artifact type design; for a reference of colours, typography, spacing and reusable components use type design_system. Keep the type the user asked for; do not turn a design into a web page or document.";
