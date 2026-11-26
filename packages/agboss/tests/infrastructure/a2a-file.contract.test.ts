/**
 * #859: the A2A file contract on the core's in-memory store and its local-disk one (a folder per
 * test, one store per instance on it).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { LocalDiskFileRepository } from "../../src/infrastructure/local-disk-file.repository.js";
import { fileContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget } from "./contracts/store-kinds.js";

fileContract(inMemoryTarget(({ database }) => new InMemoryFileRepository(database)));

const folders: string[] = [];
let folder = "";
afterAll(() => {
  for (const each of folders) rmSync(each, { recursive: true, force: true });
});

fileContract({
  name: "local disk",
  reset: () => {
    folder = mkdtempSync(join(tmpdir(), "agboss-a2a-files-"));
    folders.push(folder);
  },
  instance: () => new LocalDiskFileRepository({ kind: "local-disk", directory: folder }),
});
