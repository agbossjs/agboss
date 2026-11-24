import type { AnyTool } from "./types.js";

/**
 * The channel a tool's calls wait on (#1307): `channel`, or — the new spelling — `approval`. Every
 * place that asks whether a call needs a decision reads it here, so a tool that names its approval
 * only by `approval` is never run unasked (fail closed).
 */
export const approvalChannelOf = (
  tool: Pick<AnyTool, "channel" | "approval">,
): string | undefined => tool.channel ?? tool.approval;

/** The channel a tool definition names: `channel` or `approval` — both only when they say one name. */
export function namedChannelOf(definition: {
  readonly name: string;
  readonly channel?: string;
  readonly approval?: string;
}): string | undefined {
  const { channel, approval } = definition;
  if (channel !== undefined && approval !== undefined && channel !== approval) {
    throw new TypeError(
      `tool ${definition.name}: channel and approval name different channels — approval is the new name of channel, give one`,
    );
  }
  return channel ?? approval;
}
