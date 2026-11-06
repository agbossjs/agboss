// `agboss studio` of the packed CLI in check:packed's project (#791): the LangGraph dev server up on
// the project's workflows — started by the CLI on `@langchain/langgraph-api`, no
// `@langchain/langgraph-cli` — each one's graph served, and the server gone once the command stops.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** How long the server may take to answer: the first start compiles the project with tsx. */
const STARTUP_MS = 180_000;

/** A port nobody listens on now. */
async function freePort() {
  const server = createServer();
  await new Promise((done) => {
    server.listen(0, "localhost", done);
  });
  const { port } = server.address();
  await new Promise((done) => {
    server.close(done);
  });
  return port;
}

/** The JSON `url` answers (a POST of `body` when given), or undefined while nothing answers it. */
async function json(url, body) {
  const init =
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  try {
    const response = await globalThis.fetch(url, init);
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

/** The graph ids the server at `base` serves with at least one node, once it answers `/ok`. */
async function servedGraphs(base, hasExited) {
  const started = Date.now();
  while (!hasExited() && Date.now() - started < STARTUP_MS) {
    if ((await json(`${base}/ok`)) !== undefined) break;
    await sleep(500);
  }
  const graphs = [];
  for (const { assistant_id: id, graph_id: graph } of (await json(
    `${base}/assistants/search`,
    {},
  )) ?? []) {
    const drawn = await json(`${base}/assistants/${id}/graph`);
    if ((drawn?.nodes?.length ?? 0) > 0) graphs.push(graph);
  }
  return graphs;
}

/**
 * Runs `agboss studio` (`agboss`, the packed CLI's bin) in `project` until its graphs are served, then
 * stops it with SIGTERM: why it failed — with its output —, or undefined when it served at least one
 * graph, exited 0 and left no server behind.
 */
export async function studioProblem(agboss, project) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const child = spawn(agboss, ["studio", "--port", String(port)], {
    cwd: project,
    env: { ...process.env, CI: "1", BROWSER: "none", OPENROUTER_API_KEY: "sk-placeholder" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let code;
  const exited = new Promise((done) => {
    child.once("exit", (exitCode) => {
      code = exitCode;
      done();
    });
  });
  let graphs = [];
  try {
    graphs = await servedGraphs(base, () => code !== undefined);
  } finally {
    child.kill("SIGTERM");
  }
  await exited;
  if (graphs.length === 0) return `no graph served\n${output}`;
  if (code !== 0) return `exit ${code} once stopped\n${output}`;
  if ((await json(`${base}/ok`)) !== undefined) return "the server still answers once stopped";
  console.log(`check:packed › studio served ${graphs.join(", ")}`);
  return undefined;
}
