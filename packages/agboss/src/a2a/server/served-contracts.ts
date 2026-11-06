import type { AssembledApplication } from "../../application/assemble.js";
import type { ContractsSnapshot } from "../../describe/contracts-types.js";
import { lazyLoad } from "../../infrastructure/clock.js";

/**
 * The declared contracts an application instance serves (#808, internal): what `describe --json`
 * lists of it — each `@A2AExpose` start with its input and its finishes' outputs, and every DTO's
 * JSON Schema —, remembered for its app, so a listener built from the app writes its Agent Card
 * from the same declarations. Read on first use.
 */

const byApp = new WeakMap<object, () => Promise<ContractsSnapshot>>();

/** Remembers how an instance's app reads its contracts. */
export function rememberServedContracts(app: object, read: () => Promise<ContractsSnapshot>): void {
  byApp.set(app, read);
}

/** Remembers an instance's app as reading its assembly's contracts, the module loaded on first use. */
export function rememberAssembledContracts(app: object, assembled: AssembledApplication): void {
  rememberServedContracts(app, async () =>
    (await lazyLoad(import("../../describe/contracts.js"))).contractsOf(assembled),
  );
}

/** The contracts of an app an application instance made; `undefined` for a host's own app. */
export const servedContractsOf = (app: object): Promise<ContractsSnapshot> | undefined =>
  byApp.get(app)?.();

/** Remembers a test's app as reading the contracts of the instance it builds, once built. */
export function forwardServedContracts(
  testApp: { readonly ready: () => Promise<void> },
  built: () => object,
): void {
  rememberServedContracts(testApp, async () => {
    await testApp.ready();
    const contracts = servedContractsOf(built());
    // Stryker disable next-line StringLiteral: the invariant's text, never read while it holds
    if (contracts === undefined) throw new Error("the test's application has no contracts");
    return contracts;
  });
}
