// M12 startup: models.json / LLM_* is only the one-time import now (models/import.ts). Reading it is
// never fatal: no file and no LLM_* settings is the normal "set up in the app" start; a broken one is
// ignored with its problem fields (never values), including an unreadable file ("MODELS_FILE could
// not be read"). Only an error that isn't a ModelConfigError is thrown.
import { readFileSync } from "node:fs";
import { loadModelConfig, ModelConfigError, type ModelConfig, type ModelSettings } from "../llm/index.ts";

export type LegacyModels =
  | { status: "loaded"; models: ModelConfig }
  | { status: "absent"; models: null }
  | { status: "ignored"; models: null; problems: string[] };

export function loadLegacyModels(
  settings: ModelSettings,
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): LegacyModels {
  let file = true;
  try {
    const models = loadModelConfig(settings, env, (path) => {
      try {
        return readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") file = false;
        throw error;
      }
    });
    return { status: "loaded", models };
  } catch (err) {
    if (!(err instanceof ModelConfigError)) throw err;
    if (!file && !settings.LLM_BASE_URL && !settings.LLM_MODEL && !settings.LLM_PROTOCOL) return { status: "absent", models: null };
    return { status: "ignored", models: null, problems: err.problems };
  }
}
