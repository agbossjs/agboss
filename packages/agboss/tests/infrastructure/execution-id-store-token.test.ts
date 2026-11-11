/**
 * #891 — the token a coordination lease store's ids come through is named in what the operator
 * reads: a store that injects it in an application that gives it nothing fails assembly naming
 * `EXECUTION_ID_STORE`, so the fix (`provide(EXECUTION_ID_STORE, <a durable lease store>)`) is
 * found by its name.
 */
import { describe, expect, it } from "vitest";
import { checkGraph } from "../../src/components/container/graph-check.js";
import { EXECUTION_ID_STORE, Injectable, type ExecutionIdStore } from "../../src/index.js";

@Injectable({ deps: [EXECUTION_ID_STORE] })
class IdsReader {
  constructor(readonly ids: ExecutionIdStore) {}
}

describe("#891: EXECUTION_ID_STORE", () => {
  it("#891 AC2: an application that gives the token nothing fails naming EXECUTION_ID_STORE", () => {
    expect(() => {
      checkGraph([IdsReader], [{ owner: "app", providers: [], declaredIn: "@Application" }], []);
    }).toThrow('IdsReader: "EXECUTION_ID_STORE" is not registered in @Workflow({ providers })');
  });
});
