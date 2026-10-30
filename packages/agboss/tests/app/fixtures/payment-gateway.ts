import {
  Injectable,
  OutboundCallReconciliation,
  type OutboundCall,
  type OutboundCallLookup,
} from "../../../src/index.js";

/**
 * #505 — a payment provider outside the system, shared by a test's instances (one process): it
 * charges once per idempotency key, can be asked what happened to a key, and has levers — freeze
 * a charge before or after it is processed (the caller dies before the answer), fail the next
 * charges, or answer `reconcile` with a chosen verdict.
 */

/** What the provider is asked to charge. */
export interface ChargeRequest {
  readonly orderId: string;
  readonly amountUsd: number;
  readonly email?: string;
}

/** Its answer: the charge's id. */
export interface ChargeReceipt {
  readonly chargeId: string;
}

/** One call the provider received: its key and attempt. */
export interface ProviderCall {
  readonly idempotencyKey: string;
  readonly attempt: number;
}

/** How `reconcile` answers: from the provider's books, or as the lever says. */
export enum LookupMode {
  Books = "books",
  Unknown = "unknown",
  Throws = "throws",
  NoVerdict = "no-verdict",
}

/** The provider's books and levers (reset with `resetGateway`). */
export const gateway = {
  /** The charges it processed, by idempotency key: one per key, whatever the retries. */
  charges: new Map<string, ChargeReceipt>(),
  /** Every charge call, in order. */
  calls: [] as ProviderCall[],
  /** Every lookup, in order, and the stored request each one was given. */
  lookups: [] as ProviderCall[],
  storedRequests: [] as string[],
  /** How many coming charges fail before they are processed. */
  failNext: 0,
  /** How many characters pad the next receipts (a result above `maxPayloadSize`). */
  padding: 0,
  /** An e-mail address the next receipts carry (personal data in a result). */
  receiptEmail: "",
  lookup: LookupMode.Books,
  /** How many coming charges freeze before / after they are processed; the frozen gates. */
  gates: { before: 0, after: 0, frozen: [] as (() => void)[], ignoresAbort: false },
};

export function resetGateway(): void {
  gateway.charges.clear();
  gateway.calls.length = 0;
  gateway.lookups.length = 0;
  gateway.storedRequests.length = 0;
  gateway.failNext = 0;
  gateway.padding = 0;
  gateway.receiptEmail = "";
  gateway.lookup = LookupMode.Books;
  gateway.gates.before = 0;
  gateway.gates.after = 0;
  gateway.gates.frozen.length = 0;
  gateway.gates.ignoresAbort = false;
}

/** Lets every frozen charge go, in the order they froze. */
export function letChargesGo(): void {
  for (const letGo of gateway.gates.frozen.splice(0)) letGo();
}

/** Until `count` charges are frozen. */
export async function frozenCharges(count: number): Promise<void> {
  for (let tick = 0; tick < 2000 && gateway.gates.frozen.length < count; tick += 1)
    await new Promise((resolve) => setImmediate(resolve));
  if (gateway.gates.frozen.length < count) throw new Error(`${String(count)} charges never froze`);
}

/** Frozen when the lever says so, until let go — or until the call's signal aborts (a timeout). */
async function gate(side: "before" | "after", signal: AbortSignal): Promise<void> {
  if (gateway.gates[side] <= 0) return;
  gateway.gates[side] -= 1;
  await new Promise<void>((resolve, reject) => {
    gateway.gates.frozen.push(resolve);
    // a client that ignores its signal (#508 review): the call goes on after the step aborted
    if (gateway.gates.ignoresAbort) return;
    signal.addEventListener("abort", () => {
      reject(new Error("the call was aborted before the provider answered"));
    });
  });
}

/** A card the provider declined: the call answered with an error. */
export class PaymentDeclinedError extends Error {
  override name = "PaymentDeclinedError";
}

/** A plain object where a verdict belongs: a hook that breaks its contract (JavaScript). */
const notAVerdict = (): OutboundCallReconciliation<ChargeReceipt> =>
  JSON.parse('{"verdict":"completed"}') as OutboundCallReconciliation<ChargeReceipt>;

/** The verdict the lever asks for, or the provider's books. */
function verdictOf(lookup: OutboundCallLookup): OutboundCallReconciliation<ChargeReceipt> {
  const found = gateway.charges.get(lookup.idempotencyKey);
  if (gateway.lookup === LookupMode.Unknown)
    return OutboundCallReconciliation.unknown({ reason: "the bank has not settled it" });
  if (gateway.lookup === LookupMode.Throws) throw new Error("the provider's lookup is down");
  if (gateway.lookup === LookupMode.NoVerdict) return notAVerdict();
  return found === undefined
    ? OutboundCallReconciliation.notSent()
    : OutboundCallReconciliation.completed(found);
}

@Injectable()
export class PaymentGateway {
  /** Charges once per key: a repeat of a key gets the first receipt. */
  async charge(call: OutboundCall<ChargeRequest>): Promise<ChargeReceipt> {
    gateway.calls.push({ idempotencyKey: call.idempotencyKey, attempt: call.attempt });
    await gate("before", call.signal);
    if (gateway.failNext > 0) {
      gateway.failNext -= 1;
      throw new PaymentDeclinedError(`card declined for ${call.request.orderId}`);
    }
    const receipt = gateway.charges.get(call.idempotencyKey) ?? {
      chargeId: `ch-${call.request.orderId}-${String(gateway.charges.size + 1)}${"x".repeat(gateway.padding)}${gateway.receiptEmail === "" ? "" : ` ${gateway.receiptEmail}`}`,
    };
    gateway.charges.set(call.idempotencyKey, receipt);
    await gate("after", call.signal);
    return receipt;
  }

  /** What happened to a key: from the books, or as the lever says. */
  reconcile(lookup: OutboundCallLookup): OutboundCallReconciliation<ChargeReceipt> {
    gateway.lookups.push({ idempotencyKey: lookup.idempotencyKey, attempt: lookup.attempt });
    gateway.storedRequests.push(lookup.storedRequest);
    return verdictOf(lookup);
  }
}
