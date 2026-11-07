import type { Class, Provider } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { A2ATaskRepository } from "../infrastructure/a2a-task.repository.js";
import {
  ExecutionLeaseRepository,
  LeaseCheck,
} from "../infrastructure/execution-lease.repository.js";
import { FencedEffectRepository } from "../infrastructure/fenced-effect.repository.js";
import { OutboundCallRepository } from "../infrastructure/outbound-call.repository.js";

/**
 * `[application.store-descriptor-invalid]` (#825): a listed store's `static store` that is no
 * `{ backend, leaseCheck? }` — a backend that is no text, a `leaseCheck` that is no `LeaseCheck`, or
 * one that throws when read — is refused at assembly, never read as undeclared: an unknown
 * `leaseCheck` would read as the atomic check, a backend of another type as none.
 */

/** The contracts whose stores declare their `static store`. */
const DESCRIBED: readonly Class[] = [
  ExecutionLeaseRepository,
  FencedEffectRepository,
  OutboundCallRepository,
  A2ATaskRepository,
];

const LEASE_CHECKS: readonly unknown[] = Object.values(LeaseCheck);

/** What is wrong with what `cls` declares as its `static store`; none when it is one, or absent. */
function problemOf(cls: Class): string | undefined {
  try {
    const declared: unknown = Reflect.get(cls, "store");
    if (declared === undefined) return undefined;
    if (typeof declared !== "object" || declared === null)
      return "is no { backend, leaseCheck? } object";
    const backend: unknown = Reflect.get(declared, "backend");
    if (backend !== undefined && typeof backend !== "string")
      return `names a backend that is no text (${typeof backend})`;
    const leaseCheck: unknown = Reflect.get(declared, "leaseCheck");
    if (leaseCheck !== undefined && !LEASE_CHECKS.includes(leaseCheck))
      return "names a leaseCheck that is no LeaseCheck";
    return undefined;
  } catch {
    return "throws when it is read";
  }
}

/** Each listed store whose `static store` is not one, named with what is wrong. */
export function storeDescriptorViolations(
  application: string,
  providers: readonly Provider[],
): RuleViolation[] {
  const stores = providers.filter(
    (provider): provider is Class =>
      typeof provider === "function" &&
      DESCRIBED.some((contract) => provider.prototype instanceof contract),
  );
  return [...new Set(stores)].flatMap((store) => {
    const problem = problemOf(store);
    return problem === undefined
      ? []
      : [
          violation(
            "application.store-descriptor-invalid",
            `${store.name}'s static store ${problem}: declare static store: StoreDescriptor = { backend: "postgres" } (leaseCheck: LeaseCheck.WithoutDoubleChargeProtection only to opt out)`,
            [application],
          ),
        ];
  });
}
