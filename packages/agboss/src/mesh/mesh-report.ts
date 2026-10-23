import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { serviceUsageOf } from "../components/spend-recorder.js";
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
 * a frame, nothing.
 */
export function takeRunReport(
  transport: string,
  value: unknown,
  bodyHash: string,
  contract?: ContractPrice,
): void {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed()) return;
  const settings = contextMeshSettingsOf(frame.execution.tenant.application);
  const report =
    settings === undefined ? undefined : verifiedRunReportOf(value, settings.keys.peers, bodyHash);
  const charge = chargeOf(report, contract);
  if (charge !== undefined) {
    const service = `${transport}:${charge.application}`;
    frame.services.reportUsage?.(serviceUsageOf({ service, cost: usd(charge.cost) }));
  }
  if (report === undefined) return;
  frame.services.meshCall?.recordRemote({
    application: report.issuer,
    executionId: report.executionId,
  });
}

/** What the calling step is charged (Q6 c): the larger of the verified spend and the price. */
function chargeOf(
  report: MeshRunReport | undefined,
  contract: ContractPrice | undefined,
): { readonly application: string; readonly cost: number } | undefined {
  const reported = report === undefined ? 0 : (dollarsOf(report.spend.total) ?? 0);
  const cost = Math.max(reported, contract?.price ?? 0);
  const application = report?.issuer ?? contract?.application;
  return application === undefined || cost <= 0 ? undefined : { application, cost };
}
