import { Agent, listOf } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { VendorDto } from "../dtos/vendor.dto.js";

/** Lists the vendors to check: each one becomes a child execution of the check. */
@Agent({
  name: "vendor-finder-agent",
  description: "Finds the vendors to check",
  promptUrls: ["./vendor-finder.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    request: WorkflowStartTextDto,
  },
  output: listOf(VendorDto),
})
export class VendorFinderAgent {}
