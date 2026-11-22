/**
 * #1366 (fence-config shard) — which implementation of each infrastructure contract an application runs on: the one
 * class its providers list that extends the contract, else the built-in default; the line `describe` prints for it, and
 * which built-in implementations keep their data in memory (lost on restart, not shared by instances).
 */
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { provide } from "../../src/components/injection.js";
import {
  ImplementationReason,
  implementationLine,
  implementationsOf,
  isInMemory,
} from "../../src/application/implementations.js";
import {
  INFRASTRUCTURE_DEFAULTS,
  InMemoryCheckpointSaver,
} from "../../src/infrastructure/contracts.js";
import {
  CostLedgerRepository,
  InMemoryCostLedgerRepository,
} from "../../src/infrastructure/cost-ledger.repository.js";
import { ExecutionHistoryRepository } from "../../src/infrastructure/execution-history.repository.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { SqliteCostLedgerRepository } from "../../src/index.js";

class OwnLedger extends InMemoryCostLedgerRepository {}

describe("#1366: the implementations an application runs on", () => {
  it("each contract has the built-in default when nothing listed implements it, in the order of the defaults", () => {
    const choices = implementationsOf([]);

    expect(choices.map((choice) => choice.contract)).toEqual([...INFRASTRUCTURE_DEFAULTS.keys()]);
    expect(choices.every((choice) => choice.reason === ImplementationReason.Default)).toBe(true);
    expect(choices.find((choice) => choice.contract === CostLedgerRepository)?.implementation).toBe(
      InMemoryCostLedgerRepository,
    );
  });

  it("a listed class that extends a contract is its implementation; the others keep their default", () => {
    const choices = implementationsOf([OwnLedger]);
    const ledger = choices.find((choice) => choice.contract === CostLedgerRepository);

    expect(ledger).toEqual({
      contract: CostLedgerRepository,
      implementation: OwnLedger,
      reason: ImplementationReason.Listed,
    });
    expect(choices.filter((choice) => choice.reason === ImplementationReason.Listed)).toHaveLength(
      1,
    );
  });

  it("a value bound with provide(…) is no implementation", () => {
    const choices = implementationsOf([provide(CostLedgerRepository, new OwnLedger())] as never);

    expect(choices.find((choice) => choice.contract === CostLedgerRepository)).toMatchObject({
      implementation: InMemoryCostLedgerRepository,
      reason: ImplementationReason.Default,
    });
  });

  it("a value that only looks like a class (a prototype below the contract's) is no implementation either", () => {
    const looksLike = { prototype: Object.create(CostLedgerRepository.prototype) as object };

    const choices = implementationsOf([looksLike] as never);

    expect(choices.find((choice) => choice.contract === CostLedgerRepository)).toMatchObject({
      implementation: InMemoryCostLedgerRepository,
      reason: ImplementationReason.Default,
    });
  });

  it("is said in a line: the contract, its implementation and why", () => {
    const [listed] = implementationsOf([OwnLedger]).filter(
      (choice) => choice.contract === CostLedgerRepository,
    );
    const [builtIn] = implementationsOf([]).filter(
      (choice) => choice.contract === CostLedgerRepository,
    );

    expect(implementationLine(listed as never)).toBe(
      "CostLedgerRepository → OwnLedger (listed in @Application providers)",
    );
    expect(implementationLine(builtIn as never)).toBe(
      "CostLedgerRepository → InMemoryCostLedgerRepository (built-in default: none listed)",
    );
  });
});

describe("#1366: which implementations keep their data in memory", () => {
  it("the built-in in-memory ones do, and so does LangGraph's MemorySaver listed as it is", () => {
    const choices = implementationsOf([]);

    expect(isInMemory(choices, CostLedgerRepository)).toBe(true);
    expect(isInMemory(choices, PausedExecutionRepository)).toBe(true);
    expect(isInMemory(choices, ExecutionHistoryRepository)).toBe(true);
    const checkpointer = [...INFRASTRUCTURE_DEFAULTS.keys()].find(
      (contract) => INFRASTRUCTURE_DEFAULTS.get(contract) === InMemoryCheckpointSaver,
    );
    expect(isInMemory(choices, checkpointer as never)).toBe(true);
    expect(
      isInMemory(
        [{ contract: checkpointer, implementation: MemorySaver, reason: "listed" }] as never,
        checkpointer as never,
      ),
    ).toBe(true);
  });

  it("a store that is not in memory does not, and neither does a contract that is none of the choices", () => {
    const choices = implementationsOf([SqliteCostLedgerRepository]);

    expect(isInMemory(choices, CostLedgerRepository)).toBe(false);
    expect(
      isInMemory(
        choices,
        class Unknown {
          readonly unknown = true;
        },
      ),
    ).toBe(false);
    expect(isInMemory([], CostLedgerRepository)).toBe(false);
  });

  it("is read of the choice made for that contract, not of another's", () => {
    const choices = implementationsOf([OwnLedger]);

    expect(isInMemory(choices, CostLedgerRepository)).toBe(false);
    expect(isInMemory(choices, PausedExecutionRepository)).toBe(true);
  });
});
