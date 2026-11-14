/**
 * #940 AC6: `withdraw` is gone — a channel hears every close of a pause through `onPauseClosed`
 * (and `onPauseAnswerNotTaken`), at least once. No entry of the package names `ChannelWithdrawal`,
 * `ChannelSenderWithdrawal`, `WithdrawnPause`, `PauseWithdrawn` or `WithdrawalTree`, and no
 * channel contract has a `withdraw` member; the log code `channel.withdraw-failed` is no more.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as internal from "../../src/internal.js";
import * as root from "../../src/index.js";
import { ChannelOf } from "../../src/channels/channel-handler.js";

const API = join(import.meta.dirname, "../../api");
const SRC = join(import.meta.dirname, "../../src");
const reports = readdirSync(API)
  .filter((file) => file.endsWith(".api.md"))
  .map((file) => [file, readFileSync(join(API, file), "utf8")] as const);

const REMOVED = [
  "ChannelWithdrawal",
  "ChannelSenderWithdrawal",
  "WithdrawnPause",
  "PauseWithdrawn",
  "WithdrawalTree",
];

describe("#940 AC6: no withdraw / ChannelWithdrawal in any entry", () => {
  it.each(REMOVED)("%s is named by no entry's API report", (name) => {
    for (const [file, report] of reports) expect(report, file).not.toContain(name);
  });

  it("no entry's report declares a `withdraw` member", () => {
    for (const [file, report] of reports) expect(report, file).not.toMatch(/\bwithdraw\??[(:]/u);
  });

  it("the entries export none of the removed names", () => {
    for (const name of REMOVED) {
      expect(root).not.toHaveProperty(name);
      expect(internal).not.toHaveProperty(name);
    }
  });

  it("a channel role's base class has onPauseClosed and no withdraw", () => {
    expect(ChannelOf.prototype).toHaveProperty("onPauseClosed");
    expect(ChannelOf.prototype).toHaveProperty("onPauseAnswerNotTaken");
    expect(ChannelOf.prototype).not.toHaveProperty("withdraw");
  });

  it("channel.withdraw-failed is logged nowhere", () => {
    const sources = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(join(SRC, file), "utf8"));
    expect(sources.some((text) => text.includes("channel.withdraw-failed"))).toBe(false);
  });
});
