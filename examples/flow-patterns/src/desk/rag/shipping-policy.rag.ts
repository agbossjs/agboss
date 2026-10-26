import { Rag, type RagConnector, type RagRetrieval } from "@agboss/core/rag";

const ARTICLES = [
  { text: "Orders ship within two working days.", source: "help/shipping.md" },
  { text: "A late order may be refunded in full.", source: "help/refunds.md" },
  { text: "Archived orders are older than a year.", source: "help/archive.md" },
];

/** The help center the desk searches (`search-shipping-policy-rag-tool`): in memory here. */
@Rag({ name: "shipping-policy-rag", description: "Shipping and refund articles", topK: 2 })
export class ShippingPolicyRag implements RagConnector {
  retrieve(query: string, options: { readonly topK: number }): Promise<RagRetrieval> {
    const words = query
      .toLowerCase()
      .split(/\W+/u)
      .filter((word) => word.length > 3);
    const scoreOf = (text: string): number =>
      words.filter((word) => text.toLowerCase().includes(word)).length;
    const results = ARTICLES.map((article) => ({ article, score: scoreOf(article.text) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .map(({ article }) => article);
    return Promise.resolve({ results: results.slice(0, options.topK) });
  }
}
