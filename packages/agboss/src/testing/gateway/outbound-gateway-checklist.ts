import { errorRecordOf } from "../../core/error-record.js";
import { hours, type Milliseconds } from "../../units/index.js";

/**
 * The checklist a team runs against its payment gateway (#508; the Wiki's Payment-gateways page):
 * G1–G5 probed through the team's own adapter, each a result with its evidence — offline against
 * `FakeOutboundGateway`, by hand against the gateway's sandbox. G6 (late outcomes by webhook or a
 * status API) is not probed: it needs the gateway's own events.
 */

/** The requirements the checklist probes. */
export enum GatewayRequirement {
  /** A client idempotency key deduplicates a repeat. */
  IdempotencyKeys = "G1",
  /** A payment is found by the key it was made with: what `reconcile` needs. */
  LookupByKey = "G2",
  /** A key is kept at least as long as the longest recovery. */
  KeyRetention = "G3",
  /** A repeat gets the first response. */
  FirstResponseOnRepeat = "G4",
  /** The same key with other parameters is refused. */
  ConflictOnMismatch = "G5",
}

export enum GatewayCheckStatus {
  Passed = "passed",
  Failed = "failed",
  /** Not probed: what it needs was not given (a clock to move). */
  Skipped = "skipped",
}

/** One requirement's result: how it went and what showed it. */
export interface GatewayCheckResult {
  readonly requirement: GatewayRequirement;
  readonly status: GatewayCheckStatus;
  readonly evidence: string;
}

/** Every requirement's result, in order, and whether none failed. */
export interface GatewayChecklistReport {
  readonly results: readonly GatewayCheckResult[];
  readonly isPassed: boolean;
}

/** A probe charge: an amount under a client key. */
export interface GatewayProbeCharge {
  readonly amount: number;
  readonly idempotencyKey: string;
}

/** What the gateway answers a charge with: at least the payment's id. */
export interface GatewayProbeReceipt {
  readonly paymentId: string;
}

/** What moves the gateway's time: a test's `VirtualClock`. */
export interface GatewayChecklistClock {
  advance(delay: Milliseconds): Promise<unknown>;
}

/** The team's adapter and what the checklist may use. */
export interface OutboundGatewayChecklistOptions {
  /** Charges through the adapter, the key sent as the gateway's idempotency key. */
  readonly send: (charge: GatewayProbeCharge) => Promise<GatewayProbeReceipt>;
  /** Finds a payment by the key it was made with; none → G2 fails. */
  readonly lookup?: (idempotencyKey: string) => Promise<GatewayProbeReceipt | undefined>;
  /** Moves the gateway's time (a test's `VirtualClock`); none → G3 is skipped. */
  readonly clock?: GatewayChecklistClock;
  /** How long a key must be kept for G3 (default `hours(24)`). */
  readonly requiredRetention?: Milliseconds;
  /** The probe keys' prefix: unique per run against a sandbox (default `agboss-checklist`). */
  readonly keyPrefix?: string;
}

type Probe = (options: OutboundGatewayChecklistOptions, key: string) => Promise<GatewayCheckResult>;

const passed = (requirement: GatewayRequirement, evidence: string): GatewayCheckResult => ({
  requirement,
  status: GatewayCheckStatus.Passed,
  evidence,
});

const failed = (requirement: GatewayRequirement, evidence: string): GatewayCheckResult => ({
  requirement,
  status: GatewayCheckStatus.Failed,
  evidence,
});

const probeIdempotencyKeys: Probe = async ({ send }, key) => {
  const first = await send({ amount: 100, idempotencyKey: key });
  const repeat = await send({ amount: 100, idempotencyKey: key });
  return first.paymentId === repeat.paymentId
    ? passed(
        GatewayRequirement.IdempotencyKeys,
        `a repeat of key ${key} gave the same payment ${first.paymentId}`,
      )
    : failed(
        GatewayRequirement.IdempotencyKeys,
        `a repeat of key ${key} made a second payment (${first.paymentId}, then ${repeat.paymentId}): a crash after sending can charge twice`,
      );
};

const probeLookupByKey: Probe = async ({ send, lookup }, key) => {
  if (lookup === undefined)
    return failed(
      GatewayRequirement.LookupByKey,
      "no lookup by key: reconciliation cannot work — a call left pending stays unknown, a person decides",
    );
  const made = await send({ amount: 100, idempotencyKey: key });
  const found = await lookup(key);
  const unknown = await lookup(`${key}-never-sent`);
  if (found?.paymentId !== made.paymentId)
    return failed(
      GatewayRequirement.LookupByKey,
      `the lookup of key ${key} did not find payment ${made.paymentId}: reconciliation cannot work`,
    );
  return unknown === undefined
    ? passed(
        GatewayRequirement.LookupByKey,
        `key ${key} found payment ${made.paymentId}; an unknown key found none`,
      )
    : failed(GatewayRequirement.LookupByKey, `a key never sent found payment ${unknown.paymentId}`);
};

const probeKeyRetention: Probe = async ({ send, clock, requiredRetention }, key) => {
  const retention = requiredRetention ?? hours(24);
  if (clock === undefined)
    return {
      requirement: GatewayRequirement.KeyRetention,
      status: GatewayCheckStatus.Skipped,
      evidence:
        "no clock to move: compare the gateway's documented retention with the longest recovery",
    };
  const first = await send({ amount: 100, idempotencyKey: key });
  await clock.advance(retention);
  const late = await send({ amount: 100, idempotencyKey: key });
  const span = `${String(retention / hours(1))} h`;
  return first.paymentId === late.paymentId
    ? passed(
        GatewayRequirement.KeyRetention,
        `key ${key} still gave payment ${first.paymentId} after ${span}`,
      )
    : failed(
        GatewayRequirement.KeyRetention,
        `after ${span} key ${key} made a new payment ${late.paymentId}: a late replay is a new charge`,
      );
};

const probeFirstResponse: Probe = async ({ send }, key) => {
  const first = JSON.stringify(await send({ amount: 100, idempotencyKey: key }));
  const repeat = JSON.stringify(await send({ amount: 100, idempotencyKey: key }));
  return first === repeat
    ? passed(
        GatewayRequirement.FirstResponseOnRepeat,
        `a repeat of key ${key} answered ${first} again`,
      )
    : failed(
        GatewayRequirement.FirstResponseOnRepeat,
        `a repeat of key ${key} answered ${repeat}, the first ${first}: a repeat cannot be told from a new charge`,
      );
};

const probeConflict: Probe = async ({ send }, key) => {
  await send({ amount: 100, idempotencyKey: key });
  try {
    const other = await send({ amount: 200, idempotencyKey: key });
    return failed(
      GatewayRequirement.ConflictOnMismatch,
      `key ${key} with another amount was accepted (${other.paymentId}): only AGBoss's fingerprint catches a changed request`,
    );
  } catch (error) {
    return passed(
      GatewayRequirement.ConflictOnMismatch,
      `key ${key} with another amount was refused: ${errorRecordOf(error).message}`,
    );
  }
};

const PROBES: readonly (readonly [GatewayRequirement, Probe])[] = [
  [GatewayRequirement.IdempotencyKeys, probeIdempotencyKeys],
  [GatewayRequirement.LookupByKey, probeLookupByKey],
  [GatewayRequirement.KeyRetention, probeKeyRetention],
  [GatewayRequirement.FirstResponseOnRepeat, probeFirstResponse],
  [GatewayRequirement.ConflictOnMismatch, probeConflict],
];

/** Runs one probe; an error it did not expect fails its requirement, with the error as evidence. */
async function checked(
  [requirement, probe]: readonly [GatewayRequirement, Probe],
  options: OutboundGatewayChecklistOptions,
): Promise<GatewayCheckResult> {
  const key = `${options.keyPrefix ?? "agboss-checklist"}-${requirement.toLowerCase()}`;
  try {
    return await probe(options, key);
  } catch (error) {
    return failed(requirement, `the gateway failed the probe: ${errorRecordOf(error).message}`);
  }
}

/** Probes G1–G5 through the adapter, one after the other, each on keys of its own. */
export async function outboundGatewayChecklist(
  options: OutboundGatewayChecklistOptions,
): Promise<GatewayChecklistReport> {
  const results: GatewayCheckResult[] = [];
  for (const entry of PROBES) results.push(await checked(entry, options));
  return {
    results,
    isPassed: results.every((result) => result.status !== GatewayCheckStatus.Failed),
  };
}
