# The flow DSL

A path reads left to right, one call per line:

```ts
import { Workflow, WorkflowFinish, WorkflowStart, start } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";

@WorkflowStart({
  name: "echo-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class EchoWorkflowStart {}

@WorkflowFinish({
  name: "echo-workflow-finish",
  description: "The message, as it came",
  output: WorkflowStartTextDto,
})
export class EchoWorkflowFinish {}

@Workflow({
  name: "echo-workflow",
  version: "1.0.0",
  flow: [
    start(EchoWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(EchoWorkflowFinish),
  ],
})
export class EchoWorkflow {}
```
