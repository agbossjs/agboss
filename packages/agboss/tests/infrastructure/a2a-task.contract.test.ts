/**
 * #807: the A2A task contract on the core's in-memory and SQLite stores on their own — what the
 * `a2a-tasks` mutation shard runs (the stores run it inside `storeConformance` too).
 */
import { InMemoryA2ATaskRepository } from "../../src/infrastructure/in-memory-a2a-task.repository.js";
import { SqliteA2ATaskRepository } from "../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { a2aTaskContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";

a2aTaskContract(inMemoryTarget(({ database }) => new InMemoryA2ATaskRepository(database)));
a2aTaskContract(sqliteTarget(({ connection }) => new SqliteA2ATaskRepository(connection())));
