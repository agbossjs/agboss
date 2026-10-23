import type { HistoryTurn } from "../flow/runtime/history.js";
import type { Tern } from "../terns/index.js";

/** Whether a record is a turn of its thread (S8): finished, or written by an eval case (#396 S6). */
export const isTurn = (tern: Tern): boolean =>
  (tern.status === "answered" || tern.status === "written") && tern.replyWith !== "";

/** The thread's turns (S8): its finished (or written) executions, each as its start and finish line. */
export const toTurns = (terns: readonly Tern[]): HistoryTurn[] =>
  terns.filter(isTurn).map(({ task, replyWith }) => ({ start: task, finish: replyWith }));
