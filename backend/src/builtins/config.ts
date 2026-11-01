// M25: one definition of availability for tools, Features, Setup and the connector list.
import type { Config } from "../config.ts";
import { BuiltinConnectorId } from "../contract/m25.ts";

export type BuiltinConfig = Partial<Pick<Config, "SEARCH_PROVIDER" | "SEARCH_API_KEY" | "SEARXNG_URL" | "BUILTIN_CONNECTORS_OFF" | "OPEN_METEO_URL" | "OPEN_METEO_GEOCODING_URL" | "OPEN_METEO_API_KEY">>;
export const SEARCH_NAMES = { exa: "Exa", parallel: "Parallel", tavily: "Tavily", brave: "Brave", serper: "Serper", searxng: "SearXNG" } as const;
/** The switch disables only the default. An explicitly configured provider always runs. */
export function searchOffered(config: BuiltinConfig): boolean {
  return !!config.SEARCH_PROVIDER || !config.BUILTIN_CONNECTORS_OFF?.includes("web_search");
}
export function builtinOffered(id: BuiltinConnectorId, config: BuiltinConfig): boolean {
  return id === "web_search" ? searchOffered(config) : !config.BUILTIN_CONNECTORS_OFF?.includes(id);
}
export function searchProviders(config: BuiltinConfig): (keyof typeof SEARCH_NAMES)[] {
  return !searchOffered(config) ? [] : config.SEARCH_PROVIDER ? [config.SEARCH_PROVIDER] : ["exa", "parallel"];
}
export const isBuiltin = (name: string): name is BuiltinConnectorId => BuiltinConnectorId.safeParse(name).success;
