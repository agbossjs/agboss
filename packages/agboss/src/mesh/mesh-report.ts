import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { serviceUsageOf } from "../components/spend-recorder.js";
import { currentFrame } from "../flow/context/frame.js";
import { usd } from "../units/index.js";
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

/**
 * Takes a remote call's report in the current frame (#398 PR 2): verified against the calling
 * application's peers, its spend recorded in the step's (`service` = `<transport>:<issuer>`) and
 * its execution kept on the tool call. Outside a frame, nothing.
 */
export function takeRunReport(transport: string, value: unknown, bodyHash: string): void {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed()) return;
  const settings = contextMeshSettingsOf(frame.execution.tenant.application);
  if (settings === undefined) return;
  const report = verifiedRunReportOf(value, settings.keys.peers, bodyHash);
  if (report === undefined) return;
  const cost = dollarsOf(report.spend.total);
  const service = `${transport}:${report.issuer}`;
  if (cost !== undefined && cost > 0)
    frame.services.reportUsage?.(serviceUsageOf({ service, cost: usd(cost) }));
  frame.services.meshCall?.recordRemote({
    application: report.issuer,
    executionId: report.executionId,
  });
}
