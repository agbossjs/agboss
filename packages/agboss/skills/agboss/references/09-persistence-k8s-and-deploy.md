# Persistence, Kubernetes and deploys

Durable stores are listed in the application's `providers`:

```ts
import { SqliteCheckpointSaver, SqliteExecutionRecordRepository } from "agboss";

export const durableStores = [SqliteCheckpointSaver, SqliteExecutionRecordRepository] as const;
```
