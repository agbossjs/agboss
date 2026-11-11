/**
 * #860 AC4: the direct-message contract on the core's in-memory store and its SQLite one, each
 * beside the A2A task store of its backend (the same suites `storeConformance` runs).
 */
import { InMemoryA2ADirectMessageRepository } from "../../src/infrastructure/in-memory-a2a-direct-message.repository.js";
import { InMemoryA2ATaskRepository } from "../../src/infrastructure/in-memory-a2a-task.repository.js";
import { SqliteA2ADirectMessageRepository } from "../../src/infrastructure/sqlite/sqlite-a2a-direct-message.repository.js";
import { SqliteA2ATaskRepository } from "../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { a2aDirectMessageContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";

a2aDirectMessageContract(
  inMemoryTarget(({ database }) => ({
    messages: new InMemoryA2ADirectMessageRepository(database),
    tasks: new InMemoryA2ATaskRepository(database),
  })),
);

a2aDirectMessageContract(
  sqliteTarget(({ connection }) => ({
    messages: new SqliteA2ADirectMessageRepository(connection()),
    tasks: new SqliteA2ATaskRepository(connection()),
  })),
);
