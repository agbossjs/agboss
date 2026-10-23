/**
 * #397 PR 3 — what `agboss eval ui` answers, read-only: the folder's runs and each run's report
 * page, only to a loopback Host of its port with the printed token, nothing but GET / HEAD, and no
 * file outside the folder's listing.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { respondTo, type EvalUiRequest } from "../../src/eval/ui/ui-routes.js";
import { REFUNDS_ARTIFACT } from "../eval-html/artifacts.js";
import { TRACED_ARTIFACT } from "../eval-html/traced-artifacts.js";

const FOLDER = mkdtempSync(join(tmpdir(), "agboss-eval-ui-"));
writeFileSync(join(FOLDER, "old.json"), JSON.stringify(REFUNDS_ARTIFACT));
writeFileSync(
  join(FOLDER, "new.json"),
  JSON.stringify({ ...TRACED_ARTIFACT, startedAt: "2026-01-06T09:00:00.000Z" }),
);
writeFileSync(join(FOLDER, "notes.json"), '{"kind":"something-else"}');
writeFileSync(join(FOLDER, "readme.txt"), "not json");

const TOKEN = "0123456789abcdef0123456789abcdef";
const SETTINGS = { folder: FOLDER, token: TOKEN, port: 4317 };

const get = (url: string, request: Partial<EvalUiRequest> = {}) =>
  respondTo({ method: "GET", url, host: "127.0.0.1:4317", ...request }, SETTINGS);

describe("#397 PR 3: eval ui answers only its own page, with its token", () => {
  it("a Host other than 127.0.0.1 / localhost on its port: 403", () => {
    expect(get(`/?token=${TOKEN}`, { host: "evil.example:4317" }).status).toBe(403);
    expect(get(`/?token=${TOKEN}`, { host: "127.0.0.1:80" }).status).toBe(403);
    expect(get(`/?token=${TOKEN}`, { host: undefined }).status).toBe(403);
    expect(get(`/?token=${TOKEN}`, { host: "localhost:4317" }).status).toBe(200);
  });

  it("no token or another one: 403", () => {
    expect(get("/").status).toBe(403);
    expect(get("/?token=nope").body).toContain("needs the token it printed");
    expect(get(`/?token=${TOKEN.replace("0", "1")}`).status).toBe(403);
  });

  it("read-only: anything but GET and HEAD is 405", () => {
    const answer = get(`/?token=${TOKEN}`, { method: "POST" });

    expect(answer.status).toBe(405);
    expect(answer.headers.Allow).toBe("GET, HEAD");
  });
});

describe("#397 PR 3: the folder's runs", () => {
  const index = get(`/?token=${TOKEN}`);

  it("newest first, each with its pass rates and a dot per attempt linked to its page", () => {
    expect(index.status).toBe(200);
    expect(index.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(index.headers["Referrer-Policy"]).toBe("no-referrer");
    const suites = [...index.body.matchAll(/<h3><a href="([^"]+)">([^<]+)<\/a><\/h3>/gu)];
    expect(suites.map(([, href]) => href)).toEqual([
      `/runs/new.json?token=${TOKEN}`,
      `/runs/old.json?token=${TOKEN}`,
    ]);
    expect(index.body).toContain(`href="/runs/new.json?token=${TOKEN}#case-2-run-2"`);
    expect(index.body).toContain("<dt>Regressed</dt><dd>looks-the-order-up</dd>");
  });

  it("a .json that is no run artifact is named with why; other files are not listed", () => {
    expect(index.body).toContain(
      "<code>notes.json</code> — kind is &quot;something-else&quot;, not &quot;agboss.eval-run&quot;",
    );
    expect(index.body).not.toContain("readme.txt");
  });
});

describe("#397 PR 3: a run's page", () => {
  it("the same report --html writes, with a link back to the runs", () => {
    const page = get(`/runs/new.json?token=${TOKEN}`);

    expect(page.status).toBe(200);
    expect(page.body).toContain('<nav aria-label="Runs"><a href="/?token=');
    expect(page.body).toContain('<div class="timeline">');
  });

  it("only the folder's files: an unknown name, a path out of it, an invalid file", () => {
    expect(get(`/runs/missing.json?token=${TOKEN}`).status).toBe(404);
    expect(get(`/runs/..%2F..%2Fetc%2Fpasswd?token=${TOKEN}`).status).toBe(404);
    expect(get(`/runs/notes.json?token=${TOKEN}`).status).toBe(422);
    expect(get(`/elsewhere?token=${TOKEN}`).status).toBe(404);
  });
});
