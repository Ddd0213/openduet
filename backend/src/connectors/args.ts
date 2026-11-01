// A light check of tool arguments against the tool's JSON schema (required fields, unknown
// top-level fields when the schema forbids them, primitive types). Composio validates fully on
// execution; this catches the model's mistakes before a card is shown or an edit is stored.

const TYPE_OF: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => !!v && typeof v === "object" && !Array.isArray(v),
  null: (v) => v === null,
};

/** Problems with `args` for `schema` (empty = fine). Unknown schema shapes are accepted. */
export function checkArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const properties = schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, Record<string, unknown>>) : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
  for (const key of required) if (args[key] === undefined || args[key] === null) issues.push(`${key}: required`);
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property) {
      if (schema.additionalProperties === false) issues.push(`${key}: not a field of this tool`);
      continue;
    }
    if (value === null || value === undefined) continue;
    const types = (Array.isArray(property.type) ? property.type : [property.type]).filter((t): t is string => typeof t === "string" && t in TYPE_OF);
    if (types.length && !types.some((t) => TYPE_OF[t]!(value))) issues.push(`${key}: expected ${types.join(" or ")}`);
    if (Array.isArray(property.enum) && !property.enum.some((e) => e === value)) issues.push(`${key}: not one of the allowed values`);
  }
  return issues.slice(0, 10);
}
