import type { Class } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { EXECUTION_LEASE } from "../app/lease-fence.js";
import { CLOCK_SKEW, ENVELOPE_LIFETIME, SWEEP_GRANULARITY } from "./mesh-defaults.js";
import { meshOf, type MeshMeta } from "./mesh.decorator.js";

/**
 * `@Application({ mesh })` at assembly (#398 PR 2, #1320): the class is a `@Mesh`
 * (`[mesh.not-a-mesh]`), its limits are numbers the mesh can run with (`[limits.max-mesh-hops-invalid]`,
 * `[mesh.limit-invalid]`), each peer is listed once (`[mesh.duplicate-peer]`), has a key to verify with
 * (`[mesh.peer-without-keys]`) and `allowEndpoints` names only endpoints the application lists
 * (`[mesh.unknown-endpoint]`). A key's value is checked at start: it holds an Ed25519 key or the start fails.
 */
export function meshRuleViolations(
  application: string,
  mesh: Class | undefined,
  exposes: readonly Class[] = [],
): RuleViolation[] {
  if (mesh === undefined) return [];
  const meta = meshOf(mesh);
  if (meta === undefined) {
    const message = `@Application({ mesh }) is ${mesh.name || "a class"}, which is no @Mesh({ inboundMode, deduplicationTtl, maxHops })`;
    return [violation("mesh.not-a-mesh", message, [application])];
  }
  return [
    ...limitViolations(application, meta),
    ...replayViolations(application, meta),
    ...peerViolations(application, meta, exposes),
  ];
}

const isWhole = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isDuration = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** The mesh's numbers: hops from 1, a deduplication above the lease, positive durations. */
function limitViolations(application: string, mesh: MeshMeta): RuleViolation[] {
  const problems: RuleViolation[] = [];
  const limit = (text: string): void => {
    problems.push(violation("mesh.limit-invalid", `${mesh.name}: ${text}`, [application]));
  };
  if (!isWhole(mesh.maxHops)) {
    const message = `${mesh.name}'s maxHops is ${String(mesh.maxHops)}, not a whole number of applications from 1 — @Mesh({ maxHops: 6 }) refuses a call chain that already passed through 6 applications`;
    problems.push(violation("limits.max-mesh-hops-invalid", message, [application]));
  }
  if (!isDuration(mesh.deduplicationTtl) || mesh.deduplicationTtl <= EXECUTION_LEASE)
    limit(
      `deduplicationTtl is ${String(mesh.deduplicationTtl)} ms, not a duration above the lease's ${String(EXECUTION_LEASE)} ms`,
    );
  if (mesh.envelopeTtl !== undefined && !isDuration(mesh.envelopeTtl))
    limit(`envelopeTtl is ${String(mesh.envelopeTtl)} ms, not a positive duration`);
  const skew = mesh.maxClockSkew;
  if (skew !== undefined && !(typeof skew === "number" && Number.isFinite(skew) && skew >= 0))
    limit(`maxClockSkew is ${String(skew)} ms, not a duration from 0`);
  return problems;
}

/** Signatures are forgotten no sooner than they stop being valid. */
function replayViolations(application: string, mesh: MeshMeta): RuleViolation[] {
  const skew = mesh.maxClockSkew ?? CLOCK_SKEW;
  const window = (mesh.envelopeTtl ?? ENVELOPE_LIFETIME) + 2 * skew + SWEEP_GRANULARITY;
  if (!isDuration(mesh.deduplicationTtl) || mesh.deduplicationTtl >= window) return [];
  const message = `${mesh.name}: deduplicationTtl ${String(mesh.deduplicationTtl)} ms is shorter than envelopeTtl + 2 × maxClockSkew + the sweep's granularity (${String(window)} ms): a signed request could be replayed after it is forgotten`;
  return [violation("mesh.limit-invalid", message, [application])];
}

/** The peers: each once, each with a key, each endpoint it may call listed by the application. */
function peerViolations(
  application: string,
  mesh: MeshMeta,
  exposes: readonly Class[],
): RuleViolation[] {
  const problems: RuleViolation[] = [];
  const seen = new Set<string>();
  for (const peer of mesh.peers ?? []) {
    if (seen.has(peer.application)) {
      const message = `${mesh.name} lists peer ${peer.application} twice — one entry per peer, its keys in verifyKeys`;
      problems.push(violation("mesh.duplicate-peer", message, [application]));
    }
    seen.add(peer.application);
    if (peer.verifyKeys.length === 0) {
      const message = `${mesh.name}'s peer ${peer.application} lists no verifyKeys — a peer with no key verifies nothing`;
      problems.push(violation("mesh.peer-without-keys", message, [application]));
    }
    for (const endpoint of peer.allowEndpoints ?? [])
      if (!exposes.includes(endpoint)) {
        const message = `${mesh.name}'s peer ${peer.application} may call ${endpoint.name}, which @Application({ exposes }) does not list`;
        problems.push(violation("mesh.unknown-endpoint", message, [application]));
      }
  }
  return problems;
}
