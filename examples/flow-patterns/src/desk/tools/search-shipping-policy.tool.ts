import { Tool } from "@agboss/core";
import { RagQueryDto, RagSearchResultsDto } from "@agboss/core/rag";
import { ShippingPolicyRag } from "../rag/shipping-policy.rag.js";

/** Searches the help center: the knowledge base, behind the standard search DTOs. */
@Tool({
  name: "search-shipping-policy-tool",
  description: "Searches the shipping and refund articles",
  input: RagQueryDto,
  output: RagSearchResultsDto,
  readOnly: true,
  deps: [ShippingPolicyRag],
})
export class SearchShippingPolicyTool {
  constructor(private readonly shippingPolicy: ShippingPolicyRag) {}

  execute({ query }: RagQueryDto): Promise<RagSearchResultsDto> {
    return this.shippingPolicy.search(query);
  }
}
