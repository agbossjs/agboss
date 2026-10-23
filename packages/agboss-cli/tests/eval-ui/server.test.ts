/**
 * #397 PR 3 — `agboss eval ui`'s server for real: on 127.0.0.1, a free port with `--port 0`, a
 * fresh token per start, the Host checked on the wire; and the command's own refusals.
 */
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startEvalUi } from "../../src/eval/ui/ui-server.js";
import { REFUNDS_ARTIFACT } from "../eval-html/artifacts.js";
import { agboss, envelope } from "../cli/agboss.js";

const FOLDER = mkdtempSync(join(tmpdir(), "agboss-eval-ui-server-"));
writeFileSync(join(FOLDER, "run.json"), JSON.stringify(REFUNDS_ARTIFACT));

/** One GET with the Host header given, as a browser on another site could send it. */
function getWith(url: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { headers: { host } }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString()));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    sent.on("error", reject);
    sent.end();
  });
}

describe("#397 PR 3: the eval ui server", () => {
  it("serves the runs on 127.0.0.1 with its token, refuses another Host, stops on close", async () => {
    const ui = await startEvalUi({ folder: FOLDER, port: 0 });
    try {
      expect(ui.url).toMatch(
        new RegExp(`^http://127\\.0\\.0\\.1:${String(ui.port)}/\\?token=[0-9a-f]{32}$`, "u"),
      );
      const page = await fetch(ui.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<h1>Eval runs</h1>");
      expect((await getWith(ui.url, "rebound.example")).status).toBe(403);
    } finally {
      await ui.close();
    }
    await expect(fetch(ui.url)).rejects.toThrow();
  });

  it("each start has its own token", async () => {
    const first = await startEvalUi({ folder: FOLDER, port: 0 });
    const second = await startEvalUi({ folder: FOLDER, port: 0 });
    await Promise.all([first.close(), second.close()]);

    expect(new URL(first.url).searchParams.get("token")).not.toBe(
      new URL(second.url).searchParams.get("token"),
    );
  });
});

describe("#397 PR 3: agboss eval ui refuses before it serves", () => {
  it("a folder that does not exist: eval.no-runs, exit 2", async () => {
    const call = await agboss(["eval", "ui", "--dir", "nowhere", "--json"], FOLDER);

    expect(call.code).toBe(2);
    expect(envelope(call)).toMatchObject({ error: { code: "eval.no-runs" } });
  });

  it("a port outside 0–65535: usage.option-value", async () => {
    const call = await agboss(["eval", "ui", "--dir", ".", "--port", "70000", "--json"], FOLDER);

    expect(call.code).toBe(2);
    expect(envelope(call)).toMatchObject({ error: { code: "usage.option-value" } });
  });

  it("has its own help", async () => {
    const call = await agboss(["eval", "ui", "--help"], FOLDER);

    expect(call.stdout).toContain("agboss eval ui [--dir <folder>] [--port N]");
  });
});
