/**
 * The v2 fixture workflows the repo's `check:types` step generates `.agboss/types.d.ts` for
 * (`scripts/check-types.mjs`, #272 S3): the compile-time tests (`*.test-d.ts`) and the fixtures'
 * handlers are typed by it. The generator's test checks the same set against its snapshot.
 */
export const FIXTURE_WORKFLOWS: readonly string[] = [
  "article.fixture.ts",
  "broken-children.fixture.ts",
  "broken-launch.fixture.ts",
  "broken.fixture.ts",
  "chat.fixture.ts",
  "children.fixture.ts",
  "clinic.fixture.ts",
  "credit.fixture.ts",
  "history.fixture.ts",
  "launch.fixture.ts",
  "markers.fixture.ts",
  "offer.fixture.ts",
  "order.fixture.ts",
  "quorum.fixture.ts",
  "quorum-runtime.fixture.ts",
  "recursion.fixture.ts",
  "refunds.fixture.ts",
  "review.fixture.ts",
  "starts.fixture.ts",
  "support.fixture.ts",
  "topics.fixture.ts",
].map((file) => new URL(`../fixtures/${file}`, import.meta.url).pathname);
