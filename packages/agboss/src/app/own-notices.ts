import type { PauseNotices } from "../pause/index.js";
import type { PauseNoticeHub } from "../application/pause-notice-hub.js";
import type { AppDeps } from "./app-deps.js";

/**
 * One workflow's pause notices (#940): the instance's hub makes them from the workflow's own deps —
 * its channels and masks — which exist only after the seam they are part of: `made` gives the deps
 * once built (before any pause changes) and returns them.
 */
export function ownNoticesOf(hub: PauseNoticeHub | undefined): {
  readonly notices: PauseNotices | undefined;
  readonly made: (deps: AppDeps) => AppDeps;
} {
  const built: { deps?: AppDeps } = {};
  const notices = hub?.noticesFor(() => {
    if (built.deps === undefined) throw new TypeError("the workflow's deps are not made yet");
    return built.deps;
  });
  return {
    notices,
    made: (deps) => {
      built.deps = deps;
      return deps;
    },
  };
}
