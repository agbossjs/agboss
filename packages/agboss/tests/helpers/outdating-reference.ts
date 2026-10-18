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
  /** What the value is about (`{ about }` of its write in the flow, #299). */
  readonly about?: SlotKey;
  /** Sources the value's own write outdated (the new value is never outdated by its cascade). */
  readonly exempt: readonly number[];
  /** Sources still current after the write: the only ones a later renewal can outdate it through. */
  readonly live: readonly number[];
}

export class Run {
  private readonly values = new Map<number, RunValue>();
  private readonly current = new Map<SlotKey, number>();
  private readonly latest = new Map<SlotKey, number>();
  readonly aboutBroken: string[] = [];

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

  /** A step's write: the values of `slots`, built from `read`, about `about` when it is given. */
  write(
    producer: ComponentName,
    slots: readonly SlotKey[],
    read: readonly SlotKey[],
    about?: SlotKey,
  ): void {
    const counted = [...read, ...(about === undefined ? [] : [about])]
      .flatMap((slot) => this.current.get(slot) ?? [])
      .filter((id) => {
        const answersAbout = this.values.get(id)?.about;
        return answersAbout === undefined || !slots.includes(answersAbout);
      });
    const builtFrom = [...new Set(counted)].sort((first, second) => first - second);
    const outdatedNow = this.cascade(slots);
    const exempt = builtFrom.filter((source) => outdatedNow.has(source));
    const live = builtFrom.filter((source) => [...this.current.values()].includes(source));
    for (const slot of slots) {
      const id = this.values.size + 1;
      const value: RunValue = { id, slot, producer, builtFrom, exempt, live };
      this.values.set(id, about === undefined ? value : { ...value, about });
      this.current.set(slot, id);
      this.latest.set(slot, id);
    }
  }

  /** The about edge is never followed (S10): no value is outdated directly by an answer about it. */
  private checkAbout(outdated: RunValue, cause: number): void {
    const answer = this.values.get(cause);
    if (answer !== undefined && answer.about === outdated.slot)
      this.aboutBroken.push(
        `${answer.producer}'s answer outdated the ${outdated.slot} it is about`,
      );
  }

  private cascade(slots: readonly SlotKey[]): ReadonlySet<number> {
    const queue = slots.flatMap((slot) => this.current.get(slot) ?? []);
    const outdated = new Set(queue);
    for (const slot of slots) this.current.delete(slot);
    for (let cause = queue.shift(); cause !== undefined; cause = queue.shift()) {
      for (const [slot, id] of [...this.current]) {
        const value = this.values.get(id);
        if (!value?.builtFrom.includes(cause)) continue;
        this.checkAbout(value, cause);
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
        about: value.about === undefined ? [] : [value.about],
        count: 1,
      });
    }
    return scope;
  }
}
