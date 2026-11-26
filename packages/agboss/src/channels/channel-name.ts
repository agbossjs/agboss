import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";

/**
 * The name a `@Channel` class is known by (`refund-channel`), read from what the decorator recorded
 * on the class — no application and no registry needed; `undefined` for any class that is no channel.
 */
export const channelNameOf = (cls: Class): string | undefined => {
  const component = componentOf(cls);
  return component?.kind === "channel" ? component.meta.name : undefined;
};
