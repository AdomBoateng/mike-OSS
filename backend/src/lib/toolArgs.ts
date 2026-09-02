// Pre-flight validation of model-supplied tool arguments.
//
// Tool dispatch in chatTools.ts reads arguments with unchecked casts
// (`args.title as string`), which is safe only for arguments that are actually
// present. They are not always present: a model can emit a call with no
// arguments at all, and the adapters fall back to `{}` whenever the argument
// JSON fails to parse — which is exactly what happens when the connection to
// the endpoint drops mid-call and truncates the argument stream. The cast then
// hands `undefined` to the dispatch branch and the first property access on it
// throws a TypeError that kills the whole stream mid-answer.
//
// Every tool already declares its own JSON-Schema-lite `parameters`, so
// validation is driven off that rather than a hand-maintained table: a new tool
// (or an MCP connector's tools, which arrive at runtime) is covered the moment
// it declares `required`.

import type { OpenAIToolSchema } from "./llm";

type JsonSchemaProperty = { type?: unknown };

type JsonSchemaObject = {
  properties?: Record<string, JsonSchemaProperty>;
  required?: unknown;
};

/** Types worth checking at the top level; anything else is left alone. */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

function describeActual(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export type ToolArgValidation =
  { ok: true; args: Record<string, unknown> } | { ok: false; problem: string };

/**
 * Check one tool call's raw argument JSON against its own schema.
 *
 * Returns the parsed arguments on success, or a message written for the model
 * to read: the caller feeds it back as that call's tool result so the model can
 * correct itself and retry, instead of the stream dying.
 *
 * A tool with no schema in `tools` is passed through unvalidated — an unknown
 * name is the dispatcher's business, not this function's.
 */
export function validateToolCallArguments(
  name: string,
  rawArguments: string,
  tools: OpenAIToolSchema[],
): ToolArgValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments || "{}");
  } catch {
    return {
      ok: false,
      problem:
        `The arguments for '${name}' were not valid JSON. ` +
        `Call the tool again with a single well-formed JSON object.`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      problem:
        `The arguments for '${name}' must be a JSON object, got ` +
        `${describeActual(parsed)}.`,
    };
  }

  const args = parsed as Record<string, unknown>;
  const schema = tools.find((t) => t.function?.name === name)?.function
    ?.parameters as JsonSchemaObject | undefined;
  if (!schema) return { ok: true, args };

  const problems: string[] = [];

  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === "string")
    : [];
  const missing = required.filter(
    (key) => args[key] === undefined || args[key] === null,
  );
  if (missing.length) {
    problems.push(`missing required argument(s): ${missing.join(", ")}`);
  }

  const properties = schema.properties ?? {};
  for (const [key, property] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const type = property?.type;
    if (typeof type !== "string") continue;
    if (!matchesType(value, type)) {
      problems.push(`'${key}' must be a ${type}, got ${describeActual(value)}`);
    }
  }

  if (!problems.length) return { ok: true, args };
  return {
    ok: false,
    problem:
      `Invalid arguments for '${name}': ${problems.join("; ")}. ` +
      `Call the tool again with the arguments its schema requires.`,
  };
}
