import type { ComponentName } from "../../src/flow/registry.js";
import {
  SlotStatus,
  type AbstractScope,
  type SlotKey,
  type SlotState,
} from "../../src/flow/analyse/scope.js";

/**
 * The #271 reference model: one execution simulated value by value — every value with an id and the
 * ids it was built from — written apart from the analyser and the runtime. The analysis property
 * test checks the abstract engine against it; the runtime property test checks `writeAndOutdate`.
 */

export interface RunValue {
  readonly id: number;
  readonly slot: SlotKey;
  readonly producer: ComponentName;
  readonly builtFrom: readonly number[];
  /** Sources the value's own write outdated (the new value is never outdated by its cascade). */
  readonly exempt: readonly number[];
  /** Sources still current after the write: the only ones a later renewal can outdate it through. */
  readonly live: readonly number[];
}

export class Run {
  private readonly values = new Map<number, RunValue>();
  private readonly current = new Map<SlotKey, number>();
  private readonly latest = new Map<SlotKey, number>();

  status(slot: SlotKey): SlotStatus {
    if (this.current.has(slot)) return SlotStatus.Current;
    return this.latest.has(slot) ? SlotStatus.Outdated : SlotStatus.Absent;
  }

  currentSlots(): readonly SlotKey[] {
    return [...this.current.keys()];
  }

  valueIn(slot: SlotKey): RunValue | undefined {
    const id = this.current.get(slot);
    return id === undefined ? undefined : this.values.get(id);
  }

  isLatest(id: number): boolean {
    const value = this.values.get(id);
    return value !== undefined && this.latest.get(value.slot) === id;
  }

  /** A step's write: the values of `slots`, built from `read`. */
  write(producer: ComponentName, slots: readonly SlotKey[], read: readonly SlotKey[]): void {
    const counted = read.flatMap((slot) => this.current.get(slot) ?? []);
    const builtFrom = [...new Set(counted)].sort((first, second) => first - second);
    const outdatedNow = this.cascade(slots);
    const exempt = builtFrom.filter((source) => outdatedNow.has(source));
    const live = builtFrom.filter((source) => [...this.current.values()].includes(source));
    for (const slot of slots) {
      const id = this.values.size + 1;
      const value: RunValue = { id, slot, producer, builtFrom, exempt, live };
      this.values.set(id, value);
      this.current.set(slot, id);
      this.latest.set(slot, id);
    }
  }

  private cascade(slots: readonly SlotKey[]): ReadonlySet<number> {
    const queue = slots.flatMap((slot) => this.current.get(slot) ?? []);
    const outdated = new Set(queue);
    for (const slot of slots) this.current.delete(slot);
    for (let cause = queue.shift(); cause !== undefined; cause = queue.shift()) {
      for (const [slot, id] of [...this.current]) {
        const value = this.values.get(id);
        if (!value?.builtFrom.includes(cause)) continue;
        this.current.delete(slot);
        outdated.add(id);
        queue.push(id);
      }
    }
    return outdated;
  }

  /** The abstract scope this state stands for (#272 S10). */
  abstract(): AbstractScope {
    const scope = new Map<SlotKey, SlotState>();
    for (const [slot, id] of this.latest) {
      const value = this.values.get(id);
      if (value === undefined) continue;
      const builtFrom = [
        ...new Set(value.live.map((source) => this.values.get(source)?.slot ?? slot)),
      ].sort();
      scope.set(slot, {
        status: this.status(slot),
        producers: [value.producer],
        builtFrom,
        count: 1,
      });
    }
    return scope;
  }
}
