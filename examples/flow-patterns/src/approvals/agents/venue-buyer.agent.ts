import { Agent } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { VenueBookingDto } from "../dtos/venue-booking.dto.js";
import { PlacePurchaseTool } from "../tools/place-purchase.tool.js";

/** Books the offsite's venue — its purchase waits for the thread's owner, beside the flights'. */
@Agent({
  name: "venue-buyer-agent",
  description: "Books the venue",
  promptUrls: ["./venue-buyer.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    request: WorkflowStartTextDto,
  },
  output: VenueBookingDto,
  tools: [PlacePurchaseTool],
})
export class VenueBuyerAgent {}
