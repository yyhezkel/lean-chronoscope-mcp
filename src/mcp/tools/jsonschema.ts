import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

/**
 * Convert a Zod schema to JSON Schema draft 2020-12, which Anthropic's API
 * requires for tool input_schema. `zodToJsonSchema` defaults to draft-07 and
 * the `openApi3` target emits non-standard keywords (`nullable`, `discriminator`)
 * that fail validation.
 */
export function toJsonSchemaDraft2020(schema: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  delete json.$schema;
  delete (json as { definitions?: unknown }).definitions;
  return json;
}
