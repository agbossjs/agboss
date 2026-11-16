/** #1140: `TaskWatch` keeps a notice that reached nobody waiting, and says so once. */
import { describe, expect, it } from "vitest";
import { taskChanged, TaskWatch, waitedTaskCount } from "../../../src/a2a/tasks/task-changes.js";

const KEY = { tenantId: "acme", taskId: "task-watch-1" };
const OTHER = { tenantId: "acme", taskId: "task-watch-2" };
const ANOTHER_TENANT = { tenantId: "globex", taskId: "task-watch-1" };

describe("TaskWatch", () => {
  it("the first take says the task may have changed since the reader read it; the next says nothing", () => {
    const watch = new TaskWatch(KEY);

    expect(watch.takeChanged()).toBe(true);
    expect(watch.takeChanged()).toBe(false);
    watch.close();
  });

  it("a notice is kept until it is taken, once", () => {
    const watch = new TaskWatch(KEY);
    watch.takeChanged();

    taskChanged(KEY);
    taskChanged(KEY);

    expect(watch.takeChanged()).toBe(true);
    expect(watch.takeChanged()).toBe(false);
    watch.close();
  });

  it("only its own task's notices count", () => {
    const watch = new TaskWatch(KEY);
    watch.takeChanged();

    taskChanged(OTHER);
    taskChanged(ANOTHER_TENANT);

    expect(watch.takeChanged()).toBe(false);
    watch.close();
  });

  it("closed, it listens no more and leaves nothing subscribed", () => {
    const before = waitedTaskCount();
    const watch = new TaskWatch(KEY);
    expect(waitedTaskCount()).toBe(before + 1);
    watch.takeChanged();

    watch.close();
    taskChanged(KEY);

    expect(waitedTaskCount()).toBe(before);
    expect(watch.takeChanged()).toBe(false);
  });
});
