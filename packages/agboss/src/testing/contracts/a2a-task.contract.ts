import type { A2ATaskRepository } from "../../infrastructure/a2a-task.repository.js";
import { A2A_TASK_ACCEPT_CASES } from "./a2a-task-accept.cases.js";
import { A2A_TASK_LIST_CASES, A2A_TASK_SWEEP_CASES } from "./a2a-task-list.cases.js";
import { A2A_TASK_STATUS_CASES } from "./a2a-task-status.cases.js";
import { pingOf, registerContract } from "./define.js";
import type { ContractTarget } from "./instance-context.js";

/**
 * `A2ATaskRepository` (#807): an accepted message saves one task, once, even on two instances; a
 * resend finds that task; a status moves by compare-and-set, a terminal one never again; a caller
 * lists its tasks newest first, page by page; the sweep removes only finished tasks.
 */
export function a2aTaskContract(target: ContractTarget<A2ATaskRepository>): void {
  registerContract(
    "A2A task contract",
    target,
    [
      { title: "accepting", cases: A2A_TASK_ACCEPT_CASES },
      { title: "status", cases: A2A_TASK_STATUS_CASES },
      { title: "listing", cases: A2A_TASK_LIST_CASES },
      { title: "retention", cases: A2A_TASK_SWEEP_CASES },
    ],
    pingOf,
  );
}
