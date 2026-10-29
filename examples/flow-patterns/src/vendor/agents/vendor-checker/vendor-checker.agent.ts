import { Agent, oneOf } from "@agboss/core";
import { VendorDto } from "../../dto/vendor.dto.js";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";

/** Checks one vendor: a score, or why it is not a fit. */
@Agent({
  name: "vendor-checker-agent",
  description: "Checks one vendor",
  promptUrls: ["./vendor-checker.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    vendor: VendorDto, // the child's start input: all it sees of its parent
  },
  output: oneOf(VendorScoreDto, VendorRejectedDto),
})
export class VendorCheckerAgent {}
