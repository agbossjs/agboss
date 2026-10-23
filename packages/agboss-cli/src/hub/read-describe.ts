import type {
  DescribedApplication,
  DescribedChannel,
  DescribedNode,
  DescribedTool,
  DescribedWorkflow,
} from "./hub-inputs.js";
import {
  FieldError,
  objectAt,
  objectsAt,
  optionalTextAt,
  textAt,
  type JsonObject,
} from "./json-fields.js";

/**
 * An application's `agboss describe --json` envelope as the Hub reads it (#401 PR 3): `schema: 1`,
 * `ok: true`, `result: { application, workflows }` — only what the Hub draws is read, the rest
 * left to the readers that need it (the federation check reads the contracts from the text).
 */

/** The describe envelope's schema this agboss reads. */
const DESCRIBE_SCHEMA = 1;

const toolOf = (tool: JsonObject, path: string): DescribedTool => {
  const server = optionalTextAt(tool, "server", path);
  const channel = optionalTextAt(tool, "channel", path);
  return {
    name: textAt(tool, "name", path),
    kind: textAt(tool, "kind", path),
    ...(server === undefined ? {} : { server }),
    ...(channel === undefined ? {} : { channel }),
  };
};

const nodeOf = (node: JsonObject, path: string): DescribedNode => ({
  name: textAt(node, "name", path),
  kind: textAt(node, "kind", path),
});

function workflowOf(workflow: JsonObject, path: string): DescribedWorkflow {
  return {
    name: textAt(workflow, "name", path),
    version: textAt(workflow, "version", path),
    configHash: textAt(workflow, "configHash", path),
    nodes: objectsAt(workflow, "nodes", path).map((node, index) =>
      nodeOf(node, `${path}.nodes[${String(index)}]`),
    ),
    tools: objectsAt(workflow, "tools", path).map((tool, index) =>
      toolOf(tool, `${path}.tools[${String(index)}]`),
    ),
  };
}

const channelOf = (channel: JsonObject, path: string): DescribedChannel => ({
  name: textAt(channel, "name", path),
  isRole: channel.isRole === true,
});

/** The application an envelope describes; a field that is not there is a `FieldError`. */
export function describedApplicationOf(
  envelope: JsonObject,
  text: string,
  file: string,
): DescribedApplication {
  if (typeof envelope.schema !== "number" || envelope.schema > DESCRIBE_SCHEMA)
    throw new FieldError(
      `describe envelope schema ${String(envelope.schema)} is not one this agboss reads (${String(DESCRIBE_SCHEMA)})`,
    );
  if (envelope.ok !== true)
    throw new FieldError("a describe envelope of a failed call (ok: false) — describe it again");
  const result = objectAt(envelope, "result", "envelope");
  const application = objectAt(result, "application", "result");
  return {
    name: textAt(application, "name", "result.application"),
    version: textAt(application, "version", "result.application"),
    file,
    workflows: objectsAt(result, "workflows", "result").map((workflow, index) =>
      workflowOf(workflow, `result.workflows[${String(index)}]`),
    ),
    channels: objectsAt(application, "channels", "result.application").map((channel, index) =>
      channelOf(channel, `result.application.channels[${String(index)}]`),
    ),
    text,
  };
}
