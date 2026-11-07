import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { serviceUsageOf } from "../components/spend-recorder.js";
import type { UsageRecord } from "../finops/usage.js";
import { currentFrame } from "../flow/context/frame.js";
import { usd, type Usd } from "../units/index.js";
import { amountOf, dollarsOf } from "./mesh-durations.js";
import type { MeshRunReport } from "./mesh-envelope.js";
import { encodeJws, isSignedBy, readJws } from "./mesh-jws.js";
import { contextMeshSettingsOf } from "./mesh-settings.js";

/**
 * The run report (#398 PR 2, Q6 a): the receiver of a trusted request signs what its execution
 * spent, bound to the request's `bodyHash`; the caller verifies it with that peer's `verifyKey` and
 * records the spend as a service's (`a2a:<application>` / `mcp:<application>`) in the calling step
 * — its budgets count it — and the remote execution on the tool call. A report it cannot verify
 * (no key for its issuer, a bad signature, another request's hash) counts nothing.
 */

const TYP = "agboss-mesh-report";

const ReportSchema = z.object({
  schema: z.literal(1),
  issuer: z.string().min(1).max(500),
  executionId: z.string().min(1).max(500),
  spend: z.object({ total: z.string().max(40), currency: z.literal("USD") }),
  bodyHash: z.string().min(1).max(200),
  issuedAt: z.iso.datetime(),
});

/** What a receiver reports of one run. */
export interface RunReportFacts {
  readonly issuer: string;
  readonly executionId: string;
  readonly spentUsd: number;
  readonly bodyHash: string;
  readonly issuedAt: Date;
}

/** The signed report of a run (`A2AExecutionResponse.report`, `_meta["agboss.dev/report"]`). */
export function encodeRunReport(facts: RunReportFacts, signingKey: KeyObject): string {
  const report: MeshRunReport = {
    schema: 1,
    issuer: facts.issuer,
    executionId: facts.executionId,
    spend: { total: amountOf(facts.spentUsd), currency: "USD" },
    bodyHash: facts.bodyHash,
    issuedAt: facts.issuedAt.toISOString(),
  };
  return encodeJws(TYP, report, signingKey);
}

/** A report signed by one of `peers` for the request of `bodyHash`; `undefined` otherwise. */
export function verifiedRunReportOf(
  value: unknown,
  peers: ReadonlyMap<string, KeyObject>,
  bodyHash: string,
): MeshRunReport | undefined {
  const jws = readJws(value);
  if (jws?.signed === undefined) return undefined;
  const parsed = ReportSchema.safeParse(jws.payload);
  if (!parsed.success || parsed.data.bodyHash !== bodyHash) return undefined;
  const key = peers.get(parsed.data.issuer);
  return key !== undefined && isSignedBy(jws.signed, key) ? parsed.data : undefined;
}

/** A contract's price of one call (#398 PR 3, Q6 c), and the application it is paid to. */
export interface ContractPrice {
  readonly application: string;
  readonly price: Usd;
}

/**
 * Takes a remote call's report in the current frame (#398 PR 2): verified against the calling
 * application's peers, its spend recorded in the step's (`service` = `<transport>:<issuer>`) and
 * its execution kept on the tool call. With a contract price (PR 3, Q6 c) the step records the
 * larger of the price and the verified spend — the price alone without a verified report. Outside
 * a frame, nothing. Whether a verified report was taken (#844: a caller says when none was).
 */
export function takeRunReport(
  transport: string,
  value: unknown,
  bodyHash: string,
  contract?: ContractPrice,
  alreadyCharged = 0,
  identity?: RunReportIdentity,
): boolean {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed()) return false;
  const settings = contextMeshSettingsOf(frame.execution.tenant.application);
  const report = callReportOf(settings, value, bodyHash, identity);
  const charge = chargeOf(report, contract, alreadyCharged);
  if (charge !== undefined) {
    const service = `${transport}:${charge.application}`;
    const spent = serviceUsageOf({ service, cost: usd(charge.cost) });
    frame.services.reportUsage?.(withLedgerKey(spent, identity, report));
  }
  if (report === undefined) return false;
  frame.services.meshCall?.recordRemote({
    application: report.issuer,
    executionId: report.executionId,
  });
  return true;
}

/**
 * The call's verified report: signed by a known peer for this `bodyHash` — and, when the call
 * knows its remote execution (an A2A task, #810), naming it: another execution's report is not
 * this call's.
 */
function callReportOf(
  settings: ReturnType<typeof contextMeshSettingsOf>,
  value: unknown,
  bodyHash: string,
  identity: RunReportIdentity | undefined,
): MeshRunReport | undefined {
  if (settings === undefined) return undefined;
  const verified = verifiedRunReportOf(value, settings.keys.peers, bodyHash);
  const expected = identity?.executionId;
  return expected === undefined || verified?.executionId === expected ? verified : undefined;
}

/**
 * What makes a report's charge one across passes (#810): its ledger id, the execution the report
 * must name (the call's task), and the window its entry is dated in — never by the peer's word
 * alone: from the call's own accept (`notBefore`, as the caller stored it) to the caller's `now`.
 */
export interface RunReportIdentity {
  readonly id: string;
  readonly executionId?: string;
  /** When the caller's accept of the call was stored (ISO 8601): the entry's earliest date. */
  readonly notBefore: string;
  /** The caller's own time now, on its `Clock`: the entry's latest date. */
  readonly now: Date;
}

/**
 * The date of a report's charge (#810, security review): when its peer signed it, clamped into the
 * caller's own window `[notBefore, now]` — a peer that backdates it (to 1970, before the call was
 * accepted) cannot put the spend behind a budget's period or the ledger's pruning mark, one that
 * dates it ahead cannot keep it from them; an unreadable date is `now`. Inside the window it is the
 * same on every pass that charges it (the report is the task's one report).
 */
export function reportMadeAtOf(
  issuedAt: string | undefined,
  identity: Pick<RunReportIdentity, "notBefore" | "now">,
): string {
  const now = identity.now.getTime();
  const lower = Date.parse(identity.notBefore);
  // a lower bound that is no date, or past now, leaves only now: fail closed to the caller's time
  const floor = Number.isNaN(lower) || lower > now ? now : lower;
  const issued = issuedAt === undefined ? Number.NaN : Date.parse(issuedAt);
  const dated = Number.isNaN(issued) ? now : Math.min(now, Math.max(floor, issued));
  return new Date(dated).toISOString();
}

/** The charge under the call's own ledger identity, when it has one (#810). */
const withLedgerKey = (
  spent: UsageRecord,
  identity: RunReportIdentity | undefined,
  report: MeshRunReport | undefined,
): UsageRecord =>
  identity === undefined
    ? spent
    : {
        ...spent,
        ledgerKey: { id: identity.id, madeAt: reportMadeAtOf(report?.issuedAt, identity) },
      };

/**
 * What the calling step is charged (Q6 c): the larger of the verified spend and the price, less
 * what the call was charged already (#809: an A2A call charges its price when it is accepted).
 */
function chargeOf(
  report: MeshRunReport | undefined,
  contract: ContractPrice | undefined,
  alreadyCharged: number,
): { readonly application: string; readonly cost: number } | undefined {
  const reported = report === undefined ? 0 : (dollarsOf(report.spend.total) ?? 0);
  const cost = Math.max(reported, contract?.price ?? 0) - alreadyCharged;
  const application = report?.issuer ?? contract?.application;
  return application === undefined || cost <= 0 ? undefined : { application, cost };
}
