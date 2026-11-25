import { Memory, Ttl } from "../../src/index.js";

/**
 * Test memories (#1303): the thread kept for ever, a window of N turns in full, no summaries.
 * `@Workflow({ memory: Window2Memory })` is what `uncompactedTurns: 2` was.
 */
const windowMemory = (name: string, turns: number | "all") =>
  Memory({
    name,
    description: `Remembers ${String(turns)} turns of the thread in full`,
    ttl: Ttl.Forever,
    uncompactedTurns: turns as number,
  });

@windowMemory("window-0-memory", 0)
export class Window0Memory {}
@windowMemory("window-1-memory", 1)
export class Window1Memory {}
@windowMemory("window-2-memory", 2)
export class Window2Memory {}
@windowMemory("window-3-memory", 3)
export class Window3Memory {}
@windowMemory("window-4-memory", 4)
export class Window4Memory {}
@windowMemory("window-5-memory", 5)
export class Window5Memory {}
@windowMemory("window-7-memory", 7)
export class Window7Memory {}
