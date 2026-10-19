import type { NodeRunner } from "../node-runner.js";

/**
 * A workflow start: the validated input is its value — written to the scope by its path's
 * `.returns(…)` (`start(S).returns(InputDto)`). Guardrails guard the models that read it (#120).
 */
export function startRunner(): NodeRunner {
  return (state) => Promise.resolve({ value: { value: state.startInput }, read: [] });
}
