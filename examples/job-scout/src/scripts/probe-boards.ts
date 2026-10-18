import { parseArgs } from "node:util";
import { GreenhouseBoards } from "../services/greenhouse-boards.service.js";
import { jobSearchConfig } from "../config/search.config.js";
import type { AppEnvironment } from "../environments/app.environment.js";

// npm run job-scout:probe -- --place <place> <board token> …
// Which Greenhouse boards have live jobs in a place; prints lines to paste into search.config.ts.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { place: { type: "string" } },
});
const place = (values.place ?? "").trim().toLowerCase();
if (place === "" || positionals.length === 0) {
  process.stderr.write("usage: npm run job-scout:probe -- --place <place> <board token> …\n");
  process.exit(1);
}
// the public board API, as in dev.environment.ts (the probe runs outside the app)
const environment: AppEnvironment = {
  greenhouseApiUrl: "https://boards-api.greenhouse.io",
  sqlitePath: ":memory:",
};
const boards = new GreenhouseBoards(jobSearchConfig, environment);
const words = jobSearchConfig.places[place] ?? [place];
const results = await Promise.all(
  positionals.map((board) => boards.probe(board.toLowerCase(), words)),
);
const found = results
  .flatMap((r) => ("error" in r ? [] : [r]))
  .sort((a, b) => b.inPlace - a.inPlace);

for (const r of found)
  process.stdout.write(
    `${r.board}\t${String(r.jobs)} jobs\t${String(r.inPlace)} in ${place}\t${r.company}\n`,
  );
for (const r of results) if ("error" in r) process.stdout.write(`${r.board}\tfailed: ${r.error}\n`);
process.stdout.write(`\nboards with jobs in ${place} — paste into search.config.ts:\n`);
for (const r of found.filter((x) => x.inPlace > 0))
  process.stdout.write(`    ${r.board}: ${JSON.stringify(r.company)},\n`);
