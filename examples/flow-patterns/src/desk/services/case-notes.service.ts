import { Injectable, type CompactionTurn } from "agboss";

/**
 * Where `case-notes-compaction` keeps a thread's old turns (#382): one line per turn here; a real
 * one writes the facts to a CRM and returns what the desk's agent should remember.
 */
@Injectable()
export class CaseNotesService {
  notesOf(
    previous: readonly string[],
    turns: readonly CompactionTurn[],
  ): Promise<readonly string[]> {
    const lines = turns.map((turn) => `${turn.startName} → ${turn.finishName}`);
    return Promise.resolve([
      ...previous,
      `${String(turns.length)} earlier turn(s): ${lines.join("; ")}`,
    ]);
  }
}
