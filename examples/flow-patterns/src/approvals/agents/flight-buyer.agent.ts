import { Agent } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { FlightBookingDto } from "../dtos/flight-booking.dto.js";
import { PlacePurchaseTool } from "../tools/place-purchase.tool.js";

/** Books the offsite's flights — their purchase waits for the thread's owner, beside the venue's. */
@Agent({
  name: "flight-buyer-agent",
  description: "Books the flights",
  promptUrls: ["./flight-buyer.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    request: WorkflowStartTextDto,
  },
  output: FlightBookingDto,
  tools: [PlacePurchaseTool],
})
export class FlightBuyerAgent {}
