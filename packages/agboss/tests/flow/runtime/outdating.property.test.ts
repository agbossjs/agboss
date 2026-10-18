import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DtoClass } from "../../../src/dto/types.js";
import type { SlotKey } from "../../../src/flow/analyse/scope.js";
import type { ComponentName } from "../../../src/flow/registry.js";
import { writeAndOutdate } from "../../../src/flow/runtime/outdating.js";
import {
  builtFromOf,
  writtenProvenanceOf,
  type RuntimeProvenance,
} from "../../../src/flow/runtime/provenance.js";
import type {
  OutdatedValueRecord,
  ScopeRecords,
  ScopeValueRecord,
} from "../../../src/flow/runtime/records.js";
import { Run } from "../../helpers/outdating-reference.js";
import { ArticleRequestDto } from "../fixtures/dtos.js";
import { CritiqueDto, DraftDto, PlanDto, ResearchDto } from "../fixtures/review-dtos.js";

/**
 * #271 S40 — the runtime agrees with the reference model the analyser is checked against: random
 * producers (fields, a `{ about }` target on the flow's write of their value — #299 S54 — or
 * reading everything) and random sequences of their visits;
 * after every write the scope holds exactly the reference's current values, each with the same live
 * sources (what it read, minus what its own write outdated), and `outdatedValues` exactly the
 * rest — every one naming a value of the write that outdated it as its root trigger.
 */

const POOL: readonly DtoClass[] = [ArticleRequestDto, ResearchDto, DraftDto, PlanDto, CritiqueDto];
const dtoAt = (index: number): DtoClass => POOL[index % POOL.length] ?? ArticleRequestDto;

interface ProducerSpec {
  readonly reads: readonly number[];
  readonly output: number;
  readonly about: number | undefined;
  readonly readsEverything: boolean;
}

const producerArbitrary: fc.Arbitrary<ProducerSpec> = fc.record({
  reads: fc.subarray([0, 1, 2, 3, 4], { maxLength: 3 }),
  output: fc.integer({ min: 0, max: 4 }),
  about: fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined, freq: 2 }),
  readsEverything: fc.integer({ min: 0, max: 5 }).map((roll) => roll === 0),
});

const nameOf = (index: number): string => `p${String(index)}-agent`;
const slotOf = (index: number): string => dtoAt(index).name;

function provenanceOf(producers: readonly ProducerSpec[]): RuntimeProvenance {
  const readsEverything = new Set<string>();
  producers.forEach((spec, index) => {
    if (spec.readsEverything) readsEverything.add(nameOf(index));
  });
  return { readsEverything };
}

/** The flow's write of a producer's value: its class, `{ about }` when the spec has one. */
const writeOf = (spec: ProducerSpec) =>
  spec.about === undefined
    ? { shape: dtoAt(spec.output), isCase: false }
    : { shape: dtoAt(spec.output), about: [dtoAt(spec.about)], isCase: false };

/** The runtime's side of one execution. */
interface RuntimeRun {
  scope: ScopeRecords;
  readonly outdated: OutdatedValueRecord[];
  readonly visits: Map<string, number>;
  /** The reference's value id → the runtime's `valueId`, in the order they were written. */
  readonly ids: string[];
  readonly problems: string[];
}

function runtimeWrite(
  run: RuntimeRun,
  spec: ProducerSpec,
  index: number,
  provenance: RuntimeProvenance,
): void {
  const producer = nameOf(index);
  const slot = slotOf(spec.output);
  const read = spec.reads.flatMap((dto) => run.scope[slotOf(dto)]?.valueId ?? []);
  const write = writeOf(spec);
  const sources = builtFromOf({ producer, read, writes: [write] }, run.scope, provenance);
  const { builtFrom, about } = writtenProvenanceOf(sources, write, run.scope);
  const visit = (run.visits.get(producer) ?? 0) + 1;
  run.visits.set(producer, visit);
  const written: ScopeValueRecord = {
    valueId: `${producer}:${String(visit)}/${slot}`,
    slot,
    producer,
    value: {},
    builtFrom,
    ...(about.length === 0 ? {} : { about }),
  };
  const outcome = writeAndOutdate(run.scope, { [slot]: written });
  for (const value of outcome.outdated)
    if (value.outdated.byValueId !== written.valueId)
      run.problems.push(`${value.valueId} has another root`);
  run.scope = outcome.scope;
  run.outdated.push(...outcome.outdated);
  run.ids.push(written.valueId);
}

/** The reference's current values as the runtime names them, each with its live sources (S40 c). */
function referenceScope(reference: Run, ids: readonly string[]): Record<string, readonly string[]> {
  const idOf = (id: number): string => ids[id - 1] ?? `?${String(id)}`;
  return Object.fromEntries(
    reference.currentSlots().flatMap((slot) => {
      const value = reference.valueIn(slot);
      return value === undefined ? [] : [[idOf(value.id), value.live.map(idOf).sort()]];
    }),
  );
}

const runtimeScope = (run: RuntimeRun): Record<string, readonly string[]> =>
  Object.fromEntries(
    Object.values(run.scope).map((value) => [value.valueId, [...value.builtFrom]]),
  );

describe("#271 S40: the runtime against the reference model", () => {
  it("every write leaves the same current values with the same live sources; the rest is outdated", () => {
    fc.assert(
      fc.property(
        fc.array(producerArbitrary, { minLength: 1, maxLength: 5 }),
        fc.array(fc.nat({ max: 9 }), { minLength: 1, maxLength: 40 }),
        (producers, visits) => {
          const provenance = provenanceOf(producers);
          const reference = new Run();
          const run: RuntimeRun = {
            scope: {},
            outdated: [],
            visits: new Map(),
            ids: [],
            problems: [],
          };
          for (const choice of visits) {
            const index = choice % producers.length;
            const spec = producers[index];
            if (spec === undefined) continue;
            const reads = spec.readsEverything
              ? reference.currentSlots()
              : spec.reads.map((dto) => slotOf(dto) as SlotKey);
            const about = spec.about === undefined ? undefined : (slotOf(spec.about) as SlotKey);
            reference.write(
              nameOf(index) as ComponentName,
              [slotOf(spec.output) as SlotKey],
              reads,
              about,
            );
            runtimeWrite(run, spec, index, provenance);
            expect(runtimeScope(run)).toEqual(referenceScope(reference, run.ids));
          }
          const current = new Set(Object.values(run.scope).map((value) => value.valueId));
          expect(run.outdated.map((value) => value.valueId).sort()).toEqual(
            run.ids.filter((id) => !current.has(id)).sort(),
          );
          expect(run.problems).toEqual([]);
          expect(reference.aboutBroken).toEqual([]);
        },
      ),
      { numRuns: 500, seed: 2712 },
    );
  });
});
