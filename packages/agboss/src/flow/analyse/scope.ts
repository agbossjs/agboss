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
 * `list:oneOf(ADto,BDto)` (only the whole list, #299 S53); `XDto` and `listOf(XDto)` never share a
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
}

/** A slot of the path scope (S5): `OfferDraftDto`, `list:CompanyScoreDto`. */
export type SlotKey = Brand<string, "SlotKey">;

export interface SlotState {
  readonly status: SlotStatus;
  /** Who wrote the value (component names, sorted); several only for several values at once. */
  readonly producers: readonly ComponentName[];
  /**
   * The slots the producer read when it built the value, `{ about }` respected (#271): a renewal of
   * one of them outdates the value.
   */
  readonly builtFrom: readonly SlotKey[];
  /** What the value is about (`{ about }` of its `.returns` or `caseOf`, #299): never outdated by it. */
  readonly about: readonly SlotKey[];
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
  about: [],
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
 * → `list:oneOf(ADto,BDto)` — only the polymorphic list, never a filtered one (#299 S53).
 */
export function slotOfValue(shape: DtoClass | ListWrapper): SlotKey {
  return typeof shape === "function" ? slotOfDto(shape) : listSlot(shape);
}

/** The slot an input field reads, and how. */
export interface FieldSlot {
  readonly slot: SlotKey;
  readonly isRequired: boolean;
  readonly isList: boolean;
  /** `historyOf(XDto, { limit })`: the current value and the earlier versions (#299 S56). */
  readonly history?: { readonly limit?: number };
}

export function slotOfField(shape: InputFieldShape): FieldSlot {
  if (typeof shape === "function")
    return { slot: slotOfDto(shape), isRequired: true, isList: false };
  switch (shape.kind) {
    case Wrapper.List:
      return { slot: listSlot(shape), isRequired: true, isList: true };
    case Wrapper.History: {
      const history = shape.limit === undefined ? {} : { limit: shape.limit };
      return { slot: slotOfDto(shape.dto), isRequired: true, isList: false, history };
    }
    case Wrapper.Optional:
      return { ...slotOfField(shape.inner), isRequired: false };
  }
}

/** The value inside a `.returns(…)` shape, and whether a path may not bring it. */
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

/**
 * What a producer's values carry besides the slots: who wrote them and what they were built from
 * (the `{ about }` targets of each write are added to it, #271 S40 b).
 */
export interface WriteOrigin {
  readonly producer: ComponentName;
  readonly builtFrom: readonly SlotKey[];
}

/** The slots a write is about (`{ about }`, #299): its targets, by slot. */
export const aboutOfWrite = (write: ValueWrite): readonly SlotKey[] =>
  [...new Set((write.about ?? []).map(slotOfDto))].sort();

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
    const abouts = new Map<SlotKey, readonly SlotKey[]>();
    for (const write of present) {
      const slot = slotOfWrite(write);
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
      abouts.set(slot, [...new Set([...(abouts.get(slot) ?? []), ...aboutOfWrite(write)])].sort());
    }
    const next = new Map(scope);
    for (const [slot, count] of counts) {
      const about = abouts.get(slot) ?? [];
      // a write's own `about` target is part of what it is built from (#271 S40 b)
      // … unless it is itself an answer about what this step writes (rule 5)
      const targets = about.filter((target) => {
        const state = slotOf(scope, target);
        return state.status === SlotStatus.Current && !state.about.some((x) => counts.has(x));
      });
      const builtFrom = [...new Set([...origin.builtFrom, ...targets])].sort();
      next.set(slot, {
        status: SlotStatus.Current,
        producers: [origin.producer],
        builtFrom,
        about,
        count,
      });
    }
    return { scope: next, written: new Set(counts.keys()) };
  });
}
