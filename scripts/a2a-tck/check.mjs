// #811: the checks of one A2A TCK run against tck-expected.json (scripts/a2a-tck.mjs runs it).
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A run's JUnit report: its counts, and the tests that failed (`<classname>::<name>`). */
function junitOf(dir) {
  const xml = readFileSync(join(dir, "junitreport.xml"), "utf8");
  const suiteTag = /<testsuite\b[^>]*>/.exec(xml)?.[0];
  if (suiteTag === undefined) throw new Error(`${dir}: the JUnit report has no <testsuite>`);
  const count = (attribute) => {
    const found = new RegExp(`\\b${attribute}="(\\d+)"`).exec(suiteTag)?.[1];
    if (found === undefined) throw new Error(`${dir}: the JUnit report gives no ${attribute}`);
    return Number(found);
  };
  const total = count("tests");
  const [failures, errors, skipped] = [count("failures"), count("errors"), count("skipped")];
  const failedTests = [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
    .filter(([, , body]) => body !== undefined && /<(failure|error)\b/.test(body))
    .map(([, attributes]) => {
      const attribute = (key) => new RegExp(`\\b${key}="([^"]*)"`).exec(attributes)?.[1] ?? "";
      return `${attribute("classname")}::${attribute("name")}`;
    })
    .sort();
  const passed = total - failures - errors - skipped;
  return { counts: { total, passed, failed: failures + errors, skipped }, failedTests };
}

/** The status a reason's text says (`SKIPPED: …`, `NOT TESTED: …`). */
const statusOfReason = (reason) => /^(SKIPPED|NOT TESTED):/.exec(reason)?.[1];

const sameList = (a, b) => a.length === b.length && a.every((item, at) => item === b[at]);

/** What a run as a whole must be: tests ran, exactly the tests expected failed, its counts. */
function runShapeProblems(expected, name, report, junit) {
  const { failedTests, jsonrpc } = expected.runs[name];
  const problems = [];
  if (junit.counts.total === 0) problems.push(`${name}: the TCK ran no test`);
  const wanted = [...failedTests].sort();
  if (!sameList(junit.failedTests, wanted))
    problems.push(
      `${name}: the failing tests are not those expected — got ${JSON.stringify(junit.failedTests)}, expected ${JSON.stringify(wanted)}`,
    );
  const transport = report.per_transport?.[expected.transport];
  if (JSON.stringify(transport) !== JSON.stringify(jsonrpc))
    problems.push(
      `${name}: ${expected.transport} ran ${JSON.stringify(transport)}, expected ${JSON.stringify(jsonrpc)}`,
    );
  return problems;
}

/** One requirement that passed: it is not listed to fail, and it passed on the transport too. */
function passedProblems(expected, name, id, entry) {
  const problems = [];
  if (id in expected.runs[name].fail)
    problems.push(`${id} passes now: remove it from runs.${name}.fail`);
  const viaTransport = entry.transports?.[expected.transport];
  if (viaTransport !== undefined && viaTransport !== "PASS")
    problems.push(`${id} passes, but on ${expected.transport} it is ${viaTransport}`);
  return problems;
}

/** One requirement that did not pass: listed with a reason that says its status. */
function notPassedProblems(expected, name, id, entry, used) {
  const { fail, notPassing } = expected.runs[name];
  if (entry.status === "FAIL") {
    const reason = fail[id];
    if (reason === undefined) return [`${id} (${entry.level}) fails: ${entry.errors.join("; ")}`];
    console.log(
      `  FAIL    ${entry.level.padEnd(6)} ${id}: ${reason} — ${expected.reasons[reason]}`,
    );
    return [];
  }
  if (id in fail) return [`${id} is listed to fail but is ${entry.status}`];
  const entries = Object.entries({ ...expected.notPassing, ...notPassing });
  // an exact id before a prefix: the more specific reason wins
  const found =
    entries.find(([key]) => key === id) ??
    entries.find(([prefix]) => prefix.endsWith("-") && id.startsWith(prefix));
  if (found === undefined)
    return [`${id} (${entry.level}) is ${entry.status} with no reason in notPassing`];
  const [key, reason] = found;
  used.add(key);
  if (statusOfReason(reason) !== entry.status)
    return [`${id} is ${entry.status}, but its reason (${key}) says ${reason}`];
  console.log(`  ${entry.status.padEnd(7)} ${entry.level.padEnd(6)} ${id}: ${reason}`);
  return [];
}

/** Listed entries that no longer apply: a listed failure the TCK has not, a reason never used. */
function staleProblems(expected, name, report, used) {
  const { fail, notPassing } = expected.runs[name];
  return [
    ...Object.keys(fail)
      .filter((id) => !(id in report.per_requirement))
      .map((id) => `${id} is listed but the TCK has no such requirement`),
    ...Object.keys(notPassing)
      .filter((key) => !used.has(key))
      .map((key) => `runs.${name}.notPassing.${key} names nothing that did not pass`),
  ];
}

/**
 * The problems of the run `name` (its reports in `dir`) against what is expected of it; prints
 * every requirement not passing with its reason. `used` collects the reasons it used.
 */
export function problemsOf(expected, name, dir, report, used) {
  const junit = junitOf(dir);
  const { counts } = junit;
  console.log(
    `\n== ${name}: tests ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped (of ${counts.total})`,
  );
  const problems = runShapeProblems(expected, name, report, junit);
  const requirements = Object.entries(report.per_requirement).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [id, entry] of requirements)
    problems.push(
      ...(entry.status === "PASS"
        ? passedProblems(expected, name, id, entry)
        : notPassedProblems(expected, name, id, entry, used)),
    );
  problems.push(...staleProblems(expected, name, report, used));
  const levels = requirements.reduce((sum, [, { level, status }]) => {
    const key = `${level} ${status}`;
    return { ...sum, [key]: (sum[key] ?? 0) + 1 };
  }, {});
  console.log(`  requirements: ${JSON.stringify(levels)}`);
  return problems;
}
