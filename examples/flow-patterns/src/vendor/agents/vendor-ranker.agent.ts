import { Agent, listOf, oneOf } from "agboss";
import { VendorCheckFailedDto } from "../dtos/vendor-check-failed.dto.js";
import { VendorRankingDto } from "../dtos/vendor-ranking.dto.js";
import { VendorRejectedDto } from "../dtos/vendor-rejected.dto.js";
import { VendorScoreDto } from "../dtos/vendor-score.dto.js";

/** Ranks the checked vendors: every child's result, in the order of the finder's list. */
@Agent({
  name: "vendor-ranker-agent",
  description: "Ranks the checked vendors",
  promptUrls: ["./vendor-ranker.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    checks: listOf(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto)),
  },
  output: VendorRankingDto,
})
export class VendorRankerAgent {}
