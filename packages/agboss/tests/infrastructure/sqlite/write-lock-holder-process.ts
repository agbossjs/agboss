/**
 * #1317: a process that holds the write lock of a SQLite file (`BEGIN IMMEDIATE`), as a competing
 * instance does: `node --import tsx write-lock-holder-process.ts <path> [holdMs]`. It reports
 * `held`, then releases at the end of `holdMs` (when given) or when the parent sends `release`,
 * and reports `released`. The parent's startup blocks its own thread while it waits, so the holder
 * is the one that lets go.
 */
import { DatabaseSync } from "node:sqlite";
import { nextFromParent, report } from "../../helpers/child-channel.js";

const path = process.argv[2] ?? "";
const holdMs = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
const database = new DatabaseSync(path);
database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
await report("held");
if (holdMs === undefined) await nextFromParent();
else await new Promise((resolve) => setTimeout(resolve, holdMs));
database.exec("ROLLBACK");
database.close();
await report("released");
process.exit(0);
