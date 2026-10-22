# Observability and tracing

An observer implements the hooks it needs:

```ts
import type { ExecutionEndEvent, OnExecutionEnd } from "agboss";

export class EndObserver implements OnExecutionEnd {
  onExecutionEnd(event: ExecutionEndEvent): void {
    void event.executionId;
  }
}
```
