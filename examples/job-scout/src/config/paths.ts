import { InjectionToken } from "agboss";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The only folder the filesystem MCP server may touch (`JOB_SCOUT_DIR` overrides it, e.g. in tests). */
export const SHORTLIST_DIR = process.env.JOB_SCOUT_DIR ?? join(homedir(), "job-scout");
export const SHORTLIST_FILE = join(SHORTLIST_DIR, "shortlist.md");

/** The shortlist file, injected into the MCP tools that read and write it. */
export const SHORTLIST = new InjectionToken<string>("SHORTLIST");
// the server refuses a folder that does not exist
mkdirSync(SHORTLIST_DIR, { recursive: true });

/** The official filesystem MCP server (a dependency of this example), run with the current Node. */
export const FILESYSTEM_SERVER = join(
  dirname(
    createRequire(import.meta.url).resolve("@modelcontextprotocol/server-filesystem/package.json"),
  ),
  "dist",
  "index.js",
);

/** The user's notes about companies (the company-notes-rag knowledge base). */
export const NOTES_DIR = join(HERE, "..", "..", "notes", "companies");
export const NOTES_DB = join(
  homedir(),
  ".langgraph-agents",
  "rag",
  "job-scout-company-notes.sqlite",
);
