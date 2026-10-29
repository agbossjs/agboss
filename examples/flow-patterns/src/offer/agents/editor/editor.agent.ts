import { Agent } from "@agboss/core";
import { ChangesRequestedDto } from "../../dto/changes-requested.dto.js";
import { OfferDraftDto } from "../../dto/offer-draft.dto.js";

/** Rewrites the draft by the review notes — at most twice a run (`maxVisits`: it is on a cycle). */
@Agent({
  name: "editor-agent",
  description: "Rewrites the draft by the review notes",
  promptUrls: ["./editor.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    draft: OfferDraftDto,
    changes: ChangesRequestedDto,
  },
  output: OfferDraftDto,
  maxVisits: 2,
})
export class EditorAgent {}
