/**
 * #533: the interleaving explorer's budget in the contract fixtures — each fixture tests another
 * rule of `storeConformance` (a backend, an opt-out, a race), so its explorer suite looks only a few
 * steps deep and stays well inside the nested vitest's bound — at the floor a fencing set may be
 * explored at (#799), so no fixture's `store set` case fails for its budget. The explorer's own
 * bites run their fixture with a larger budget (explorer-sabotage.contract-fixture.ts).
 */
export const FIXTURE_INTERLEAVINGS = { depth: 4, walks: 20, walkDepth: 16 } as const;
