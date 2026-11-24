import { Agent, listOf } from "@agboss/core";
import { VendorCheckFailedDto } from "../../dto/vendor-check-failed.dto.js";
import { VendorRankingDto } from "../../dto/vendor-ranking.dto.js";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";

/** Ranks the checked vendors: every child's result, in the order of the finder's list. */
@Agent({
  name: "vendor-ranker-agent",
  description: "Ranks the checked vendors",
  prompt: "./vendor-ranker.prompt.md",
  model: "moonshotai/kimi-k2.6",
  input: {
    checks: listOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto),
  },
  output: VendorRankingDto,
})
export class VendorRankerAgent {}
