/**
 * #614 — what an application's container gives for its ids (#578): `app.resolve(IdGenerator)` is the
 * framework's check around the listed generator — the one every part of the framework mints
 * through — and `app.resolve(<the listed class>)` the listed instance itself, unchecked, the same
 * object the check wraps. A component mints through `IdGenerator`, never through its own class.
 */
import { beforeEach, describe, expect } from "vitest";
import { InvalidMintedIdError, KeyTextRule } from "../../src/errors.js";
import { CheckedIdGenerator, IdGenerator } from "../../src/infrastructure/clock.js";
import { testWith } from "../../src/testing/index.js";
import {
  minting,
  PlannedIdGenerator,
  PlannedIdsApplication,
  resetMinting,
} from "./fixtures/minted-ids.application.js";

const test = testWith(PlannedIdsApplication);

beforeEach(resetMinting);

describe("#614: the IdGenerator an application resolves", () => {
  test("app.resolve(IdGenerator) is the check around the listed class: it refuses an id that is no key", async ({
    app,
  }) => {
    await app.ready();
    const checked = app.resolve(IdGenerator);
    minting.executions = ["x\uD800"];

    expect(checked).toBeInstanceOf(CheckedIdGenerator);
    expect((checked as CheckedIdGenerator).minting).toBeInstanceOf(PlannedIdGenerator);
    expect(() => checked.newExecutionId()).toThrow(InvalidMintedIdError);
    expect(() => {
      minting.threads = ["x\uD800"];
      checked.newThreadId();
    }).toThrow(expect.objectContaining({ rule: KeyTextRule.LoneSurrogate }) as Error);
  });

  test("app.resolve(<the listed class>) is the listed instance itself — the one the check wraps, unchecked", async ({
    app,
  }) => {
    await app.ready();
    const listed = app.resolve(PlannedIdGenerator);
    minting.executions = ["x\uD800"];

    expect(listed).toBe((app.resolve(IdGenerator) as CheckedIdGenerator).minting);
    expect(listed).not.toBeInstanceOf(CheckedIdGenerator);
    expect(listed.newExecutionId()).toBe("x\uD800");
  });
});
