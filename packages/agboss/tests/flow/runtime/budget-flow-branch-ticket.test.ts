/**
 * #1366 (budget-flow shard) — what a branch of a launch is handed, each rule on its own: the ticket it carries (a
 * malformed one is a framework error, never a branch that runs), the item of a per-item run it sees as the latest
 * value of its class, the config whose signal is its own and which keeps everything else of the run's, and the
 * launch in flight it belongs to.
 */
import { describe, expect, it } from "vitest";
import { newRunContext } from "../../../src/core/run-context.js";
import { listOf, oneOf } from "../../../src/flow/dto-wrappers.js";
import {
  branchConfigOf,
  branchLaunchOf,
  branchStateOf,
  branchTicketOf,
} from "../../../src/flow/runtime/launch/branch-view.js";

class CompanyDto {
  readonly company = true;
}

const ticket = { index: 2, node: "audit", nodeId: "audit#2" };
const MISSING_TICKET = "a launch branch ran without its ticket";

describe("#1366: the ticket a branch carries", () => {
  it("is the one the Send carried next to the state", () => {
    expect(branchTicketOf({ branch: ticket })).toBe(ticket);
  });

  it.each([
    ["no branch at all", {}],
    ["a branch that is null", { branch: null }],
    ["a branch that is a text", { branch: "audit" }],
    ["a branch that is a number", { branch: 3 }],
    ["an index that is not a number", { branch: { ...ticket, index: "2" } }],
    ["no index", { branch: { node: "audit", nodeId: "audit#2" } }],
    ["a node that is not a text", { branch: { ...ticket, node: 4 } }],
    ["no node", { branch: { index: 2, nodeId: "audit#2" } }],
    ["a node id that is not a text", { branch: { ...ticket, nodeId: 4 } }],
    ["no node id", { branch: { index: 2, node: "audit" } }],
  ])("%s is refused with the framework's TypeError", (_why, input) => {
    expect(() => branchTicketOf(input)).toThrow(new TypeError(MISSING_TICKET));
  });
});

describe("#1366: the item of a per-item run", () => {
  const list = {
    valueId: "list-1",
    slot: "list:CompanyDto",
    producer: "screening",
    value: ["Acme", "Globex"],
    builtFrom: ["root"],
  };
  const state = {
    scope: { "list:CompanyDto": list, other: { slot: "other" } },
    visits: {},
    usage: [],
  } as never;
  const launchOf = (items: object | undefined) => ({ launch: { items } }) as never;
  const perItem = launchOf(listOf(CompanyDto));
  const at = (itemIndex: number | undefined) =>
    ({ node: "audit", visitNumber: 1, stepsBefore: 1, itemIndex }) as never;
  const scopeOf = (launch: never, ticketOf: never, from = state) =>
    branchStateOf(from, launch, ticketOf, []).scope;

  it("is the latest single value of the list's class, with the list's value id: the run counts as reading the list", () => {
    const scope = scopeOf(perItem, at(1));

    expect(scope).toEqual({
      ...(state as { scope: object }).scope,
      CompanyDto: {
        valueId: "list-1",
        slot: "CompanyDto",
        producer: "screening",
        value: "Globex",
        builtFrom: ["root"],
      },
    });
  });

  it("a run that is no item of a list, or a launch with no list, sees the scope as it is", () => {
    const given = (state as { scope: object }).scope;

    expect(scopeOf(perItem, at(undefined))).toBe(given);
    expect(scopeOf(launchOf(undefined), at(1))).toBe(given);
  });

  it("a launch whose elements are several classes, though its list is in the scope, sees the scope as it is", () => {
    class OtherDto {
      readonly other = true;
    }
    const several = launchOf(listOf(oneOf(CompanyDto, OtherDto)));
    const withList = {
      ...(state as object),
      scope: {
        "list:oneOf(CompanyDto,OtherDto)": { ...list, slot: "list:oneOf(CompanyDto,OtherDto)" },
      },
    } as never;

    expect(scopeOf(several, at(1), withList)).toBe((withList as { scope: object }).scope);
  });

  it("a launch whose elements are not one class, a list not in the scope, or a value that is no list sees the scope as it is", () => {
    const given = (state as { scope: object }).scope;
    const many = launchOf({ kind: "list", element: { kind: "oneOf", variants: [CompanyDto] } });
    const without = { ...(state as object), scope: {} } as never;
    const notList = {
      ...(state as object),
      scope: { "list:CompanyDto": { ...list, value: "not a list" } },
    } as never;

    expect(branchStateOf(state, many, at(1), []).scope).toBe(given);
    expect(scopeOf(perItem, at(1), without)).toEqual({});
    expect(scopeOf(perItem, at(1), notList)).toEqual((notList as { scope: object }).scope);
  });
});

describe("#1366: the config of a branch", () => {
  const own = new AbortController().signal;
  const old = new AbortController();
  const run = { ...newRunContext({ runId: "run-1", signal: old.signal }), threadId: "thread-1" };
  const config = {
    tags: ["t"],
    configurable: { thread_id: "thread-1", run },
  } as never;

  it("has the branch's signal in place of the execution's, on the config and on the run context, and keeps the rest", () => {
    const out = branchConfigOf(config, own, "run-1");

    expect(out.signal).toBe(own);
    expect(out.tags).toEqual(["t"]);
    expect(out.configurable?.thread_id).toBe("thread-1");
    expect(out.configurable?.run).toMatchObject({
      runId: "run-1",
      threadId: "thread-1",
      signal: own,
    });
    expect(out.configurable?.run.signal).not.toBe(old.signal);
  });

  it("a branch run with no config of its own gets a run context of the run's id with the branch's signal", () => {
    const out = branchConfigOf(undefined, own, "run-9");

    expect(out.signal).toBe(own);
    expect(out.configurable?.run).toMatchObject({ runId: "run-9", signal: own });
  });
});

describe("#1366: the launch a branch belongs to", () => {
  const launch = { key: "launch-a" };
  const launching = { key: "launch-a", launchId: "l1" };

  it("is the state's ticket and the graph launch of its key", () => {
    const found = branchLaunchOf(
      { launch: launching } as never,
      [{ key: "other" }, launch] as never,
    );

    expect(found.ticket).toBe(launching);
    expect(found.launch).toBe(launch);
  });

  it.each([
    ["no launch in flight", null, [launch]],
    ["no launch of the ticket's key", launching, [{ key: "other" }]],
    ["no launch in flight, though a launch has no key either", null, [{ key: undefined }]],
  ])("%s is the framework's TypeError", (_why, inFlight, launches) => {
    expect(() => branchLaunchOf({ launch: inFlight } as never, launches as never)).toThrow(
      new TypeError("a launch branch ran without the launch in flight"),
    );
  });
});
