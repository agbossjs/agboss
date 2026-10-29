import {
  Compaction,
  CompactionStrategy,
  type CompactionHandler,
  type CompactionInput,
} from "@agboss/core";
import { CaseNotesService } from "../../services/case-notes.service.js";

/**
 * The desk's memory past its window (#382, `CompactionStrategy.Custom`): no model — the case notes
 * service writes the summaries the agent reads from now on.
 */
@Compaction({
  name: "case-notes-compaction",
  description: "Keeps old turns as case notes",
  strategy: CompactionStrategy.Custom,
  turnsBetweenCompactions: 1,
  deps: [CaseNotesService],
})
export class CaseNotesCompaction implements CompactionHandler {
  constructor(private readonly caseNotesService: CaseNotesService) {}

  compact(input: CompactionInput): Promise<readonly string[]> {
    return this.caseNotesService.notesOf(input.previousSummaries, input.turnsToCompact);
  }
}
