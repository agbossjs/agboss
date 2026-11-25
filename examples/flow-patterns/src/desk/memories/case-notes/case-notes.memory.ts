import { Memory, Ttl, type CompactionInput } from "@agboss/core";
import { CaseNotesService } from "../../services/case-notes.service.js";

/**
 * The desk's memory (#382, #1303): its last two turns in full, and past that no model — the case
 * notes service writes the summaries the agent reads from now on.
 */
@Memory({
  name: "case-notes-memory",
  description: "Keeps old turns as case notes",
  ttl: Ttl.Forever,
  uncompactedTurns: 2,
  turnsBetweenCompactions: 1,
  deps: [CaseNotesService],
})
export class CaseNotesMemory {
  constructor(private readonly caseNotesService: CaseNotesService) {}

  compact(input: CompactionInput): Promise<readonly string[]> {
    return this.caseNotesService.notesOf(input.previousSummaries, input.turnsToCompact);
  }
}
