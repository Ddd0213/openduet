// M25: in-memory outcomes, shared by the runtime and Setup through the startup config object.
import { BuiltinConnectorId, type BuiltinConnectorList } from "../contract/m25.ts";
import { HttpStatusError, ServiceUnavailable, WebError } from "../web/http.ts";
import { builtinOffered, SEARCH_NAMES, searchProviders, type BuiltinConfig } from "./config.ts";

type Outcome = { checkedAt: string; unreachable: boolean };
const states = new WeakMap<BuiltinConfig, Map<BuiltinConnectorId, Outcome>>();
export type ToolError = { isError: true; error: string };
export const UNREACHABLE = "The service can't be reached right now. Tell the user it is temporarily unavailable; do not guess or invent a result.";

export function connectorList(config: BuiltinConfig): BuiltinConnectorList {
  return { connectors: BuiltinConnectorId.options.map(id => {
    const offered = builtinOffered(id, config), outcome = states.get(config)?.get(id);
    return {
      id, state: !offered ? "off" : outcome?.unreachable ? "unreachable" : "on",
      providers: !offered ? [] : id === "web_search" ? searchProviders(config).map(p => SEARCH_NAMES[p]) : id === "weather" ? ["Open-Meteo"] : id === "exchange_rate" ? ["Frankfurter"] : [],
      keyless: id === "web_search" ? !config.SEARCH_PROVIDER || ["exa", "parallel", "searxng"].includes(config.SEARCH_PROVIDER) : id !== "weather" || !config.OPEN_METEO_API_KEY,
      checkedAt: outcome?.checkedAt ?? null,
    };
  }) };
}

/** Bad arguments/non-feeds are not outages and never erase the last reachability outcome. */
export async function runBuiltin<T>(id: BuiltinConnectorId, config: BuiltinConfig, run: () => Promise<T>, now: () => Date = () => new Date()): Promise<T | ToolError> {
  if (!builtinOffered(id, config)) return { isError: true, error: "This built-in connector is turned off" };
  const record = (unreachable: boolean) => {
    const state = states.get(config) ?? new Map<BuiltinConnectorId, Outcome>();
    state.set(id, { checkedAt: now().toISOString(), unreachable }); states.set(config, state);
  };
  try { const result = await run(); record(false); return result; }
  catch (error) {
    const unreachable = error instanceof ServiceUnavailable || !(error instanceof WebError) || error instanceof HttpStatusError && (error.status === 408 || error.status === 429 || error.status >= 500);
    if (unreachable) { record(true); return { isError: true, error: UNREACHABLE }; }
    return { isError: true, error: error.message };
  }
}
