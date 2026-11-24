/**
 * #859: the A2A file contract on the core's in-memory store and its local-disk one (a folder per
 * test, one store per instance on it).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { InMemoryA2AFileRepository } from "../../src/infrastructure/in-memory-a2a-file.repository.js";
import { LocalDiskA2AFileRepository } from "../../src/infrastructure/local-disk-a2a-file.repository.js";
import { a2aFileContract } from "../../src/testing/contracts/index.js";
import { resolveEnvironment } from "../../src/environments/resolve.js";
import {
  applicationContextOf,
  type ApplicationContext,
} from "../../src/flow/context/application-context.js";
import { inMemoryTarget } from "./contracts/store-kinds.js";

a2aFileContract(inMemoryTarget(({ database }) => new InMemoryA2AFileRepository(database)));

/** An application context of this environment, as an instance makes one. */
const contextOf = (
  values: Record<string, unknown>,
  processEnv: NodeJS.ProcessEnv = {},
): ApplicationContext =>
  applicationContextOf({
    name: "files-application",
    version: "1.0.0",
    instanceId: "instance-1",
    startedAt: new Date("2026-01-05T09:00:00.000Z"),
    environmentName: "test",
    environment: resolveEnvironment(
      { name: "test", contract: "FilesEnvironment", values },
      processEnv,
    ),
  });

const folders: string[] = [];
let folder = "";
afterAll(() => {
  for (const each of folders) rmSync(each, { recursive: true, force: true });
});

a2aFileContract({
  name: "local disk",
  reset: () => {
    folder = mkdtempSync(join(tmpdir(), "agboss-a2a-files-"));
    folders.push(folder);
  },
  instance: () => new LocalDiskA2AFileRepository(contextOf({ a2aFilesPath: folder })),
});
