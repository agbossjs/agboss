import type { Class } from "../components/injection.js";
import type { ComponentOptions } from "../components/component-options.js";
import { a2aTaskExpiryOf } from "../infrastructure/a2a-task.repository.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { Expiry } from "../infrastructure/expiry.js";
import { Ttl } from "../units/index.js";
import { lazyLoad } from "../infrastructure/clock.js";

/** The sweep of the direct messages (#860), loaded on its first look. */
const directMessageExpiry = () =>
  lazyLoad(import("../infrastructure/a2a-direct-message-expiry.js"));

/**
 * What the recovery sweep removes of the A2A rows, endpoint by endpoint (#1320): the finished tasks
 * after the endpoint's `ttl.tasks` (#807) — none for `Ttl.Forever` —, the direct messages' replies
 * after its `ttl.messages` and their lost attempts' files (#860). Each endpoint's rows are its own:
 * two endpoints on one workflow sweep at their own times.
 */
export const a2aExpiriesOf = (
  infrastructure: Pick<Infrastructure, "a2aTasks" | "a2aFiles" | "a2aDirectMessages" | "clock">,
  endpoints: readonly Class[],
  options: ComponentOptions,
): readonly Expiry[] =>
  endpoints.flatMap((endpoint): readonly Expiry[] => {
    // the endpoint's ttl as the profiles leave it
    const meta = options.a2aEndpointMetaOf(endpoint);
    if (meta === undefined) return [];
    const { name, ttl } = meta;
    return [
      ...(ttl.tasks === Ttl.Forever
        ? []
        : [a2aTaskExpiryOf(infrastructure.a2aTasks, name, ttl.tasks)]),
      {
        what: `the direct A2A messages of ${name}`,
        remove: async (cutoff) => {
          const { a2aDirectMessageExpiryOf } = await directMessageExpiry();
          const sources = {
            messages: infrastructure.a2aDirectMessages,
            files: infrastructure.a2aFiles,
            clock: infrastructure.clock,
            endpoint: name,
            retention: ttl.messages,
          };
          await a2aDirectMessageExpiryOf(sources).remove?.(cutoff);
        },
        retention: ttl.messages,
      },
    ];
  });
