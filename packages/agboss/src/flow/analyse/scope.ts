import type { DtoClass } from "../../dto/types.js";
import type { Brand } from "../../types/brand.js";
import type { InputFieldShape } from "../decorators/declaration.js";
import { Wrapper, type ListWrapper, type ValueShape } from "../dto-wrappers.js";
import type { ComponentName } from "../registry.js";
import type { ValueWrite } from "./flow-graph.js";
import { dtoLabel, sortedVariants } from "./labels.js";

/**
 * The abstract path scope (#272 S10, #270 → path scope): one reachable state of an execution's
 * scope, slot by slot. A slot is keyed by shape (S5): `OfferDraftDto`, `list:CompanyScoreDto`,
 * `list:oneOf(ADto,BDto)` (the whole list; its typed slices `list:ADto`, `list:BDto` are filled with it, #1288b); `XDto` and `listOf(XDto)` never share a
 * slot, and a write replaces the slot's value. Scopes are never merged slot by slot, so the
 * correlation between fields survives (`{ fast }` or `{ expert }`, never neither).
 */

/**
 * A slot's state on one reachable scope: no value, a current one, or one outdated by a newer value
 * of a slot it was built from (#271, `outdating.ts`). An outdated value stays in the slot until the
 * slot is written again, and no field may read it (`[input.outdated-on-path]`).
 */
export enum SlotStatus {
  Absent = "absent",
  Current = "current",
  Outdated = "outdated",
  /**
   * A value the path may or may not hold (#945): a branch's output on a `.onError(…)` side path —
   * its branch may have answered or not. One state, never an enumeration of the present / absent
   * subsets. A field reads it only as `optional(XDto)`.
   */
  Maybe = "maybe",
}

/** A slot of the path scope (S5): `OfferDraftDto`, `list:CompanyScoreDto`. */
export type SlotKey = Brand<string, "SlotKey">;

export interface SlotState {
  readonly status: SlotStatus;
  /** Who wrote the value (component names, sorted); several only for several values at once. */
  readonly producers: readonly ComponentName[];
  /**
   * The slots the producer read when it built the value (#271): a renewal of one of them outdates
   * the value.
   */
  readonly builtFrom: readonly SlotKey[];
  /** How many values one step put in the slot (more than one: `[input.several-on-path]`). */
  readonly count: number;
}

/** One reachable state of the path scope: the slots that hold a value, by key. */
export type AbstractScope = ReadonlyMap<SlotKey, SlotState>;

export const EMPTY_SCOPE: AbstractScope = new Map();

const ABSENT: SlotState = {
  status: SlotStatus.Absent,
  producers: [],
  builtFrom: [],
  count: 0,
};

/** A slot's state; `Absent` when the scope holds no value there. */
export const slotOf = (scope: AbstractScope, key: SlotKey): SlotState => scope.get(key) ?? ABSENT;

/** A structural key: two scopes with the same slots and states are one abstract scope. */
export function scopeKey(scope: AbstractScope): string {
  return JSON.stringify([...scope].sort(([first], [second]) => first.localeCompare(second)));
}

const key = (text: string): SlotKey => text as SlotKey;

/** The slot of one DTO class: `OfferDraftDto`. */
export const slotOfDto = (dto: DtoClass): SlotKey => key(dtoLabel(dto));

/** How messages name a slot: `DraftDto`, `listOf(CritiqueDto)`. */
export function slotLabel(slot: SlotKey): string {
  return slot.startsWith("list:") ? `listOf(${slot.slice("list:".length)})` : slot;
}

/** The slot of a list, kept as a whole: `list:XDto`, `list:oneOf(ADto,BDto)` (#299 S53). */
const listSlot = (list: ListWrapper): SlotKey =>
  typeof list.element === "function"
    ? key(`list:${dtoLabel(list.element)}`)
    : key(`list:oneOf(${sortedVariants(list.element).map(dtoLabel).join(",")})`);

/**
 * The one slot a value fills: `XDto` → `XDto`; `listOf(XDto)` → `list:XDto`; `listOf(oneOf(A, B))`
 * → `list:oneOf(ADto,BDto)` — the polymorphic list as a whole; its slices are separate writes (`slices.ts`).
 */
export function slotOfValue(shape: DtoClass | ListWrapper): SlotKey {
  return typeof shape === "function" ? slotOfDto(shape) : listSlot(shape);
}

/** The slot an input field reads, and how. */
export interface FieldSlot {
  readonly slot: SlotKey;
  readonly isRequired: boolean;
  readonly isList: boolean;
  /** `historyOf(XDto, { maxPrevious })`: the current value and the earlier versions (#299 S56). */
  readonly history?: { readonly maxPrevious?: number };
}

export function slotOfField(shape: InputFieldShape): FieldSlot {
  if (typeof shape === "function")
    return { slot: slotOfDto(shape), isRequired: true, isList: false };
  switch (shape.kind) {
    case Wrapper.List:
      return { slot: listSlot(shape), isRequired: true, isList: true };
    case Wrapper.History: {
      const history = shape.maxPrevious === undefined ? {} : { maxPrevious: shape.maxPrevious };
      return { slot: slotOfDto(shape.dto), isRequired: true, isList: false, history };
    }
    case Wrapper.Optional:
      return { ...slotOfField(shape.inner), isRequired: false };
  }
}

/** The value inside a value shape, and whether a path may not bring it. */
export interface WrittenValue {
  readonly value: DtoClass | ListWrapper;
  readonly isOptional: boolean;
}

export const writtenValue = (shape: ValueShape): WrittenValue =>
  typeof shape !== "function" && shape.kind === Wrapper.Optional
    ? { value: shape.inner, isOptional: true }
    : { value: shape, isOptional: false };

/** The slot one write fills. */
export const slotOfWrite = (write: ValueWrite): SlotKey =>
  slotOfValue(writtenValue(write.shape).value);

/** What a producer's values carry besides the slots: who wrote them and what they were built from. */
export interface WriteOrigin {
  /** One step, or the branches of a launch that give one value of its join (#273). */
  readonly producers: readonly ComponentName[];
  readonly builtFrom: readonly SlotKey[];
}

/** Every subset of the optional writes is a separate reachable scope (path-sensitive). */
function presentCombinations(writes: readonly ValueWrite[]): readonly (readonly ValueWrite[])[] {
  return writes.reduce<readonly (readonly ValueWrite[])[]>(
    (combinations, write) =>
      writtenValue(write.shape).isOptional
        ? combinations.flatMap((present) => [present, [...present, write]])
        : combinations.map((present) => [...present, write]),
    [[]],
  );
}

/** A scope after a write, and the slots the write filled (the outdating step starts from them). */
export interface WrittenScope {
  readonly scope: AbstractScope;
  readonly written: ReadonlySet<SlotKey>;
}

/** The scopes after an edge writes its values (one per combination of optional values). */
export function afterWrites(
  scope: AbstractScope,
  writes: readonly ValueWrite[],
  origin: WriteOrigin,
): readonly WrittenScope[] {
  if (writes.length === 0) return [{ scope, written: new Set() }];
  return presentCombinations(writes).map((present): WrittenScope => {
    const counts = new Map<SlotKey, number>();
    for (const write of present) {
      const slot = slotOfWrite(write);
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    }
    const next = new Map(scope);
    for (const [slot, count] of counts) {
      next.set(slot, {
        status: SlotStatus.Current,
        producers: [...origin.producers].sort(),
        builtFrom: [...new Set(origin.builtFrom)].sort(),
        count,
      });
    }
    return { scope: next, written: new Set(counts.keys()) };
  });
}
