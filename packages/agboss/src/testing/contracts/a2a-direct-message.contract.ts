import { A2A_DIRECT_MESSAGE_ATTEMPT_CASES } from "./a2a-direct-message-attempt.cases.js";
import {
  A2A_DIRECT_MESSAGE_CLAIM_CASES,
  A2A_DIRECT_MESSAGE_SAVE_CASES,
} from "./a2a-direct-message-save.cases.js";
import { A2A_DIRECT_MESSAGE_SWEEP_CASES } from "./a2a-direct-message-sweep.cases.js";
import type { A2ADirectMessageStores } from "./a2a-direct-message-data.js";
import { registerContract } from "./define.js";
import type { ContractTarget } from "./instance-context.js";

export type { A2ADirectMessageStores } from "./a2a-direct-message-data.js";

/**
 * `A2ADirectMessageRepository` (#860), on the store under test and the A2A task store beside it:
 * an accepted message is saved once, even on two instances; a resend finds its row; one id is one
 * message across both reply modes — a task's id refused, a direct one's claimed among the tasks'
 * messages, a race of the two kept once; a reply is kept once by its attempt; an expired attempt is
 * taken over by one instance; the sweep removes old messages a page at a time, freeing their ids.
 */
export function a2aDirectMessageContract(target: ContractTarget<A2ADirectMessageStores>): void {
  registerContract(
    "A2A direct message contract",
    target,
    [
      { title: "accepting", cases: A2A_DIRECT_MESSAGE_SAVE_CASES },
      { title: "one id across reply modes", cases: A2A_DIRECT_MESSAGE_CLAIM_CASES },
      { title: "attempts", cases: A2A_DIRECT_MESSAGE_ATTEMPT_CASES },
      { title: "retention", cases: A2A_DIRECT_MESSAGE_SWEEP_CASES },
    ],
    async ({ messages, tasks }) => {
      await Promise.all([messages.ping(), tasks.ping()]);
    },
  );
}
