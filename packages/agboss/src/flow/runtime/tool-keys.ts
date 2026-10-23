import { inputJsonSchema, type JsonSchema } from "../../dto/schema.js";
import { versionOf } from "../../terns/index.js";
import type { AnyTool } from "../../tools/index.js";
import { ComponentKind, type ComponentRecord } from "./records.js";

/**
 * The join keys of a tool (#268 S93, #395): `promptHash` of what its model is told about it (its
 * description), `schemaHash` of its input and output JSON Schemas — the same as `agboss describe
 * --json`'s `schemas.tools.<name>`, so a tool call's record joins the declarative snapshot.
 */

/** A tool's JSON Schemas and their hashes. */
export interface ToolKeys {
  readonly record: ComponentRecord;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
}

const made = new WeakMap<AnyTool, ToolKeys>();

/** The tool's keys, made once per tool. */
export function toolKeysOf(tool: AnyTool): ToolKeys {
  const known = made.get(tool);
  if (known !== undefined) return known;
  const input = inputJsonSchema(tool.input);
  const output = inputJsonSchema(tool.output);
  const record: ComponentRecord = {
    name: tool.name,
    kind: ComponentKind.Tool,
    promptHash: versionOf(tool.description),
    schemaHash: versionOf({ input, output }),
  };
  const keys = { record, input, output };
  made.set(tool, keys);
  return keys;
}

/** The tool as a record names it: its name, kind and hashes. */
export const toolRecordOf = (tool: AnyTool): ComponentRecord => toolKeysOf(tool).record;
