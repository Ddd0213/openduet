// M17: installing a registry template as a normal mcp CustomConnector (registryName stored). The
// template is looked up on the server by name (the app never sends a URL); the user's values fill
// the URL's `{variables}` (one URL-safe segment each, no "/", "?", "#", "@", spaces or braces) and
// the headers (secret ones go to the vault). Then create() probes: a server that asks for OAuth
// sign-in is saved waiting for it, anything else is verified (initialize + tools/list) as usual.
// Installing a template that's installed already returns that connector when no values are sent
// (409 with values: change them on the connector instead).
import type { z } from "zod";
import type { CustomConnector } from "../contract/m11.ts";
import { HttpError } from "../http.ts";
import type { ConnectorService } from "../custom-connectors/service.ts";
import type { TemplateCatalog } from "./catalog.ts";
import { inputsOf, RegistryError, type Template } from "./registry.ts";

type Shape = z.infer<typeof CustomConnector>;

const VALUE_IN_URL = /^[A-Za-z0-9._~%:+=,;!*'()$-]{1,200}$/;
const ONE_LINE = /^[^\r\n\0]*$/;
const PLACEHOLDER = /\{([^{}]{1,64})\}/g;

const invalid = (field: string, message: string) => new HttpError(400, "validation_failed", `${field}: ${message}`, field);

/** The URL and headers a template + the user's values make (400 names the field that's wrong). */
export function fill(template: Template, raw: Record<string, string>): { url: string; headers: { name: string; value: string; secret: boolean }[] } {
  const inputs = inputsOf(template);
  const known = new Set(inputs.map((i) => i.name));
  const unknown = Object.keys(raw).find((k) => !known.has(k));
  if (unknown) throw invalid(`inputs.${unknown}`, "not an input of this template");
  const given = new Map(Object.entries(raw).map(([k, v]) => [k, v.trim()] as const).filter(([, v]) => v !== ""));
  const missing = inputs.filter((i) => i.required && !given.has(i.name)).map((i) => i.name);
  if (missing.length) throw invalid(`inputs.${missing[0]}`, `required (missing: ${missing.join(", ")})`);

  let url = template.remote.url;
  for (const variable of template.variables) {
    const value = given.get(variable.name) ?? variable.default;
    if (value === null || value === undefined) throw invalid(`inputs.${variable.name}`, "required");
    if (!VALUE_IN_URL.test(value)) throw invalid(`inputs.${variable.name}`, "use letters, digits and - . _ ~ only (no / ? # @ or spaces)");
    url = url.split(`{${variable.name}}`).join(value);
  }
  if (/[{}]/.test(url)) throw invalid("name", "this server's URL has parts the registry doesn't describe; add it as a custom connector");

  const headers: { name: string; value: string; secret: boolean }[] = [];
  for (const header of template.headers) {
    if (header.fixed !== null) {
      headers.push({ name: header.name, value: header.fixed, secret: header.secret });
      continue;
    }
    const value = given.get(header.name) ?? header.default;
    if (value === null || value === undefined) continue;
    if (!ONE_LINE.test(value)) throw invalid(`inputs.${header.name}`, "must be one line");
    // A function replacement: `$` in the user's value is taken literally.
    headers.push({ name: header.name, value: header.template ? header.template.replace(PLACEHOLDER, () => value) : value, secret: header.secret });
  }
  return { url, headers };
}

export async function installTemplate(service: ConnectorService, catalog: TemplateCatalog, userId: string, input: { name: string; inputs: Record<string, string> }): Promise<{ connector: Shape; needsSignIn: boolean }> {
  let template: Template | null;
  try {
    template = await catalog.find(input.name);
  } catch (error) {
    if (error instanceof RegistryError) throw new HttpError(502, "internal", "The MCP Registry couldn't be reached. Try again in a moment.");
    throw error;
  }
  if (!template) throw new HttpError(404, "not_found", "That connector isn't in the MCP Registry (or has no hosted version).", "name");
  const existing = (await service.installed(userId)).get(template.name);
  if (existing) {
    if (Object.values(input.inputs).some((v) => v.trim())) throw new HttpError(409, "conflict", `${template.title} is installed already; change its settings on the connector.`, "name");
    const connector = await service.get(userId, existing);
    return { connector, needsSignIn: connector.oauth?.needsSignIn ?? false };
  }
  const { url, headers } = fill(template, input.inputs);
  const connector = await service.create(userId, {
    kind: "mcp", name: template.title, description: template.description, url, headers,
  }, { registryName: template.name, allowSignIn: true });
  const needsSignIn = connector.oauth?.needsSignIn ?? false;
  if (!inputsOf(template).length) catalog.rememberSignIn(template.name, needsSignIn);
  return { connector, needsSignIn };
}
