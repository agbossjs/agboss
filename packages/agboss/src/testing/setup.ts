/**
 * `agboss/testing/setup` — registers the workflow matchers (`toFollowPath`, `toFinishWith`,
 * `toFailWith`, …) and the call matchers of `mockLlm` / `mockAction` (`toHaveBeenCalledWith`,
 * `toHaveBeenCalledTimes`, `toHaveReturned`): one line in vitest.config.ts,
 * `setupFiles: ["agboss/testing/setup"]`.
 */
import { expect } from "vitest";
import { installCallMatchers } from "./call-matchers.js";
import { workflowMatchers } from "./matchers.js";
import "./vitest-types.js";

expect.extend(workflowMatchers);
installCallMatchers();
