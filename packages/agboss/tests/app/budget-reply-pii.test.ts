/**
 * #1366 (budget-reply shard) — the policies a pause's reply is read through, each rule on its own over fakes: a
 * workflow that has no PII policies reads through an empty set and the tokens the tree already holds (none when
 * it holds none), and one that has them reads through its chain's policies keyed by the tree's own key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replyAnsweringPartsOf } from "../../src/app/reply-answer.js";
import { ownDepsOf } from "../../src/app/own-deps.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";

vi.mock("../../src/app/own-deps.js", () => ({ ownDepsOf: vi.fn() }));

const parts = replyAnsweringPartsOf({ config: { name: "bundle" } } as never);
const pause = { workflow: "child-workflow" } as never;

beforeEach(() => {
  vi.mocked(ownDepsOf).mockReset();
});

describe("#1366: the policies a reply is read through", () => {
  it("a workflow with no PII policies has an empty set and the tokens the tree holds", () => {
    vi.mocked(ownDepsOf).mockReturnValue({ pii: undefined } as never);
    const known = { "<tok>": "value" };

    const out = parts.piiOf({ piiTokens: known }, pause);

    expect(out.known).toBe(known);
    expect(out.policies).toEqual(new PiiPolicySet([], ""));
    expect(out.policies.policies).toEqual([]);
    expect(out.policies.fieldKey).toBe("");
    expect(ownDepsOf).toHaveBeenCalledWith({ config: { name: "bundle" } }, "child-workflow");
  });

  it("a tree that holds no tokens yet reads with none known", () => {
    vi.mocked(ownDepsOf).mockReturnValue({ pii: undefined } as never);

    expect(parts.piiOf({}, pause).known).toEqual({});
  });

  it("a workflow with policies reads through its chain's, with the sensitive values of the tree's contexts and the tree's key", () => {
    const keyed = { keyed: true };
    const withFieldKey = vi.fn(() => keyed);
    const withValues = vi.fn(() => ({ withFieldKey }));
    const contextValuesOf = vi.fn(() => ["sensitive"]);
    vi.mocked(ownDepsOf).mockReturnValue({
      pii: { contextValuesOf, workflowPolicies: { withValues } },
    } as never);
    const known = { a: "1" };

    const out = parts.piiOf({ piiTokens: known, piiKey: "tree-key", contexts: {} } as never, pause);

    expect(out).toEqual({ policies: keyed, known });
    expect(withValues).toHaveBeenCalledWith(["sensitive"]);
    expect(withFieldKey).toHaveBeenCalledWith("tree-key");
  });
});
