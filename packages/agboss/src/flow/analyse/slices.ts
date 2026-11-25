import type { ListWrapper } from "../dto-wrappers.js";
import { Wrapper } from "../dto-wrappers.js";
import type { ValueWrite } from "./flow-graph.js";
import { valueWrite } from "./flow-graph.js";
import { writtenValue, type SlotKey } from "./scope.js";

/**
 * Typed slices of a polymorphic list (#1288b): a step that gives `listOf(A, B, C)` also gives
 * `listOf(A)`, `listOf(B)` and `listOf(C)` — each the items of that class in their order, `[]` when
 * none — so a node below reads `passed: listOf(ScoreDto)` without a type ladder. A slice and the
 * list are twins: a newer value of one outdates the other.
 */

const LIST = "list:";
const ONE_OF = "list:oneOf(";

/** A polymorphic list: `listOf(A, B, …)` with at least two classes. */
export const isPolymorphicList = (shape: unknown): shape is ListWrapper =>
  typeof shape === "object" &&
  shape !== null &&
  "kind" in shape &&
  shape.kind === Wrapper.List &&
  "variants" in shape &&
  (shape as ListWrapper).variants.length > 1;

/** The writes with, after each polymorphic list, one slice per class it holds. */
export function withSlices(writes: readonly ValueWrite[]): readonly ValueWrite[] {
  return writes.flatMap((write) => {
    const { value } = writtenValue(write.shape);
    if (write.isCase || !isPolymorphicList(value)) return [write];
    const slices = value.variants.map((dto) => ({
      ...valueWrite(listSlice(dto), false),
      sliceOf: value,
    }));
    return [write, ...slices];
  });
}

/** The slice of one class. */
function listSlice(dto: ListWrapper["variants"][number]): ListWrapper {
  // a list of one class is its own slice: `listOf(V)`
  return { kind: Wrapper.List, element: dto, variants: [dto] };
}

/** The class names of a polymorphic list's slot (`list:oneOf(ADto,BDto)`); none for another slot. */
export function variantNamesOfSlot(slot: SlotKey): readonly string[] | undefined {
  return slot.startsWith(ONE_OF) ? slot.slice(ONE_OF.length, -1).split(",") : undefined;
}

/** The class a slice slot (`list:ADto`) holds; none for another slot. */
export function sliceClassOfSlot(slot: SlotKey): string | undefined {
  return slot.startsWith(LIST) && !slot.startsWith(ONE_OF) ? slot.slice(LIST.length) : undefined;
}

/** The slots of `among` that are twins of `slot`: the slices of a polymorphic list, or the lists a slice belongs to. */
export function twinSlotsOf(slot: SlotKey, among: Iterable<SlotKey>): readonly SlotKey[] {
  const names = variantNamesOfSlot(slot);
  const slice = sliceClassOfSlot(slot);
  return [...among].filter((other) => {
    if (names !== undefined)
      return sliceClassOfSlot(other) !== undefined && names.includes(sliceClassOfSlot(other) ?? "");
    if (slice === undefined) return false;
    return variantNamesOfSlot(other)?.includes(slice) === true;
  });
}
