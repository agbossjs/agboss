/**
 * #1366: when a per-item launch reports that it took fewer items than its list had — only when the list is longer
 * than `takeFirst`, never when it has exactly that many or fewer.
 */
import { describe, expect, it } from "vitest";
import { testFrame } from "../../helpers/frame.js";
import { reportTruncation } from "../../../src/flow/runtime/launch/launch-report.js";

function siteOf() {
  const events: unknown[] = [];
  const site = {
    frame: testFrame(),
    config: undefined,
    observer: {
      onLaunchItemsTruncated: (event: unknown) => {
        events.push(event);
        return Promise.resolve();
      },
    },
  };
  return { site: site as never, events };
}

const ticket = (items: number) => ({ launchId: "l-1", items }) as never;

describe("#1366: the report of a truncated launch", () => {
  it("is made when the list is longer than maxItems, with both numbers", async () => {
    const { site, events } = siteOf();

    await reportTruncation(site, ticket(5), 3);

    expect(events).toMatchObject([{ launch: "l-1", items: 5, takeFirst: 3 }]);
  });

  it("is not made for a list of exactly maxItems, a shorter one, or a launch without maxItems", async () => {
    const { site, events } = siteOf();

    await reportTruncation(site, ticket(3), 3);
    await reportTruncation(site, ticket(2), 3);
    await reportTruncation(site, ticket(9), undefined);

    expect(events).toEqual([]);
  });
});
