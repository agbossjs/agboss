/**
 * `agboss/testing/setup` — registers the workflow matchers (`toFollowPath`, `toFinishWith`,
 * `toFailWith`, …) and the call matchers of `mockLlm` / `mockAction` (`toHaveBeenCalledWith`,
 * `toHaveBeenCalledTimes`, `toHaveReturned`) and the trajectory matchers (`toHaveCalledTools`,
 * `toHaveToolCallMatching`, #395): one line in vitest.config.ts,
 * `setupFiles: ["agboss/testing/setup"]`.
 */
import { expect } from "vitest";
import { installCallMatchers } from "./call-matchers.js";
import { workflowMatchers } from "./matchers.js";
import { childMatchers } from "./child-matchers.js";
import { compensationMatchers } from "./compensation-matchers.js";
import { toolCallMatchers } from "./tool-call-matchers.js";
import "./vitest-types.js";

expect.extend(workflowMatchers);
installCallMatchers();
expect.extend(childMatchers);
expect.extend(compensationMatchers);
expect.extend(toolCallMatchers);
