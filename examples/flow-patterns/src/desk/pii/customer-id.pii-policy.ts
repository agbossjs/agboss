import { PiiAction, PiiPolicy, type PiiMatch, type PiiPolicyHandler } from "agboss";

const CUSTOMER_ID = /\bCUS-\d{4}\b/gu;

/**
 * The desk's own identifiers (#120): a project detector — `findMatches` gives the ranges, the
 * framework applies the action, so a model reads `<customer-id:…>` and a tool the id.
 */
@PiiPolicy({
  name: "customer-id-pii-policy",
  action: PiiAction.replaceWithToken(),
})
export class CustomerIdPiiPolicy implements PiiPolicyHandler {
  findMatches(text: string): readonly PiiMatch[] {
    return [...text.matchAll(CUSTOMER_ID)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
  }
}
