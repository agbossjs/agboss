import { EXECUTION_LEASE } from "../app/lease-fence.js";
import { shownLimit } from "../graph/count-limit.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { Ttl } from "../units/index.js";
import type { A2AEndpointMeta } from "./a2a-endpoint.decorator.js";

/** The longest an endpoint keeps a row: a century — longer, `now − ttl` leaves what a `Date` holds. */
const MAX_TTL = 100 * 365 * 24 * 60 * 60 * 1000;

const isPositiveDuration = (value: unknown): value is number =>
  typeof value === "number" && value > 0 && value <= MAX_TTL;

/**
 * `[a2a.ttl-invalid]` at assembly (#1320): an `@A2AEndpoint`'s `ttl.tasks` is a positive duration or
 * `Ttl.Forever`, its `ttl.messages` a duration above the execution lease (30 s) — a message's id must
 * outlive its attempt, or a resend runs the skill twice.
 */
export function ttlViolations(endpoint: A2AEndpointMeta, where: string): RuleViolation[] {
  const { ttl } = endpoint as { readonly ttl: Partial<A2AEndpointMeta["ttl"]> | undefined };
  const problems: string[] = [];
  if (ttl?.tasks !== Ttl.Forever && !isPositiveDuration(ttl?.tasks))
    problems.push(
      `ttl.tasks is ${shownLimit(ttl?.tasks)}, not a duration (days(30)) or Ttl.Forever`,
    );
  if (!isPositiveDuration(ttl?.messages) || ttl.messages <= EXECUTION_LEASE)
    problems.push(
      `ttl.messages is ${shownLimit(ttl?.messages)}, not a duration above the lease's ${String(EXECUTION_LEASE)} ms`,
    );
  return problems.map((problem) =>
    violation("a2a.ttl-invalid", `${endpoint.name}'s ${problem}`, [where]),
  );
}
