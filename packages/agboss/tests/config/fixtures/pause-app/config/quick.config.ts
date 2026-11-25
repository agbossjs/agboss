import { defineConfig } from "../../../../../src/index.js";
import { hours, minutes } from "../../../../../src/units/index.js";

/** Shorter waits: the approval one hour with a reminder, the external task two. */
export default defineConfig({
  toolApprovals: { "refund-tool-approval": { timeout: hours(1), remindBefore: minutes(10) } },
  externalTasks: { "spending-limit-external-task": { timeout: hours(2) } },
});
