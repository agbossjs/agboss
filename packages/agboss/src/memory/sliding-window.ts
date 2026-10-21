import { BaseMemoryStrategy, type MemoryContext, type MemoryView } from "./types.js";

/** A window size; unset fields use the agent's configured limits. */
export interface MemoryWindow {
  readonly turns?: number;
  readonly summaries?: number;
}

const lastOf = <T>(items: readonly T[], limit: number): readonly T[] =>
  limit > 0 ? items.slice(-limit) : [];

/**
 * The built-in strategy: the agent sees the last `turns` earlier turns and the last `summaries`
 * summaries. By default that is all the agent remembers — its `uncompactedTurns` (and the turns
 * its compaction has not summarised yet) and its compaction's summaries; a subclass may narrow it:
 * `super({ turns: 3 })`. A wider window sees no more than what the agent remembers.
 */
export class SlidingWindowStrategy extends BaseMemoryStrategy {
  constructor(private readonly window: MemoryWindow = {}) {
    super();
  }

  buildContext({ history, summaries, limits }: MemoryContext): MemoryView {
    return {
      history: lastOf(history, this.window.turns ?? limits.turns),
      summaries: lastOf(summaries, this.window.summaries ?? limits.summaries),
    };
  }
}
