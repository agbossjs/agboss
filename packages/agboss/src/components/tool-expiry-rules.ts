import { isExpiresIn } from "../channels/channel-rules.js";
import { tokenName } from "./injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { componentOf } from "./metadata.js";
import type { ToolClasses } from "./assemble-checks.js";

/**
 * The deadline a tool sets for its approval pause (#941): `@Tool({ channel, expiresIn })` —
 * `[tool.expires-in-without-channel]` when the tool has no channel, `[channel.expires-in-invalid]`
 * when it is no positive finite duration of at least `seconds(1)`.
 */
export function toolExpiryViolations(tools: ToolClasses): RuleViolation[] {
  return [...tools.local, ...tools.mcp].flatMap((cls) => {
    const component = componentOf(cls);
    if (component?.kind !== "tool" && component?.kind !== "mcp-tool") return [];
    const { name, channel, expiresIn } = component.meta;
    if (expiresIn === undefined) return [];
    const owner = tokenName(cls);
    if (channel === undefined) {
      const message = `${owner} (${name}): expiresIn is the deadline of its approval pause, but it names no channel — add channel, or drop expiresIn`;
      return [violation("tool.expires-in-without-channel", message, [name])];
    }
    if (isExpiresIn(expiresIn)) return [];
    const message = `${owner} (${name}): expiresIn is ${String(expiresIn)} — a deadline is a positive finite duration of at least seconds(1), like hours(4)`;
    return [violation("channel.expires-in-invalid", message, [name])];
  });
}
