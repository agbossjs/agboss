import type { ChannelHandler, ChannelOf } from "../../channels/channel-handler.js";
import type { Class } from "../../components/injection.js";

/**
 * A class a unit runner's container creates instead of another (#262 S62): wherever a component
 * depends on `token`, it gets the container's instance of `replacement` — created like any class,
 * its own `deps` resolved. Classes only: a value of a class stays `[di.instance-provider]` (#261).
 */
export interface Override {
  readonly token: Class;
  readonly replacement: Class;
}

/**
 * A channel role answered by another channel (#267 S104):
 * `override(RefundApprovalRole, AutoApproveChannel)` — the replacement need not extend the role,
 * but its `send` must take the role's `ChannelAsk` and give its `ChannelOutcome`.
 */
export function override<TRole extends ChannelOf<TRole>>(
  role: Class<TRole>,
  replacement: Class<ChannelHandler<TRole>>,
): Override;
/** `override(SearchClient, FakeSearchClient)`: the fake's instances must fit the token's type. */
export function override<T>(token: Class<T>, replacement: Class<T>): Override;
export function override(token: Class, replacement: Class): Override {
  return { token, replacement };
}

/** The overrides as the container takes them: each token's replacement class. */
export const replacementsOf = (overrides: readonly Override[] = []): ReadonlyMap<Class, Class> =>
  new Map(overrides.map(({ token, replacement }) => [token, replacement]));
