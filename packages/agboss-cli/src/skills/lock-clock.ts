/**
 * The clocks of the skills sync lock (#1235). `wall` is the time of day (what file mtimes are
 * written with; it can be set back or forward); `mono` is a system-wide monotonic millisecond count
 * (it never steps, and every process of this host reads the same one); `sleep` blocks. A test
 * passes a fake one, so the real defaults (12 s wait, 10 min stale) are tested without waiting.
 */
export interface LockClock {
  readonly wall: () => number;
  readonly mono: () => number;
  readonly sleep: (ms: number) => void;
}

export const realClock: LockClock = {
  wall: () => Date.now(),
  // hrtime is the OS's monotonic clock, one for all processes of the host (performance.now is per process)
  mono: () => Number(process.hrtime.bigint() / 1_000_000n),
  sleep: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};
