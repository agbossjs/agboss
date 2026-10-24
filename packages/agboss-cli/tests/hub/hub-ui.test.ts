/**
 * #401 PR 6 (AC8) — `agboss hub ui <path…> [--port N]`: the Hub on `agboss eval ui`'s own server
 * and rules — loopback only, the printed token, the `Host` checked, no CORS, read-only — with the
 * page, a search of the kept executions a page at a time, and the JSON API; a bad `--port` is exit 2.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cspHashOf } from "../../src/eval/html/page-script.js";
import { startLocalUi } from "../../src/eval/ui/ui-server.js";
import { HUB_PAGE_STYLE } from "../../src/hub/html/hub-style.js";
import { respondToHub, type HubUiSettings } from "../../src/hub/ui/hub-routes.js";
import { agboss, envelope } from "../cli/agboss.js";
import { BILLING, hubFolder, SHOP } from "./hub-files.js";

let settings: HubUiSettings;
const TOKEN = "0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  const cwd = await hubFolder();
  settings = { cwd, paths: ["hub"], token: TOKEN, port: 4318 };
});

const get = (url: string, host = "127.0.0.1:4318") =>
  respondToHub({ method: "GET", url, host, body: "" }, settings);

const json = (url: string): unknown => JSON.parse(get(url).body);

describe("#401 PR 6: agboss hub ui's routes", () => {
  it("only its own Host, only with its token, only GET; never a CORS header", () => {
    expect(get(`/?token=${TOKEN}`, "rebound.example").status).toBe(403);
    expect(get("/").status).toBe(403);
    expect(get("/?token=wrong").status).toBe(403);
    const post = respondToHub(
      { method: "POST", url: `/?token=${TOKEN}`, host: "localhost:4318", body: "" },
      settings,
    );
    expect(post.status).toBe(405);
    expect(post.headers.Allow).toBe("GET, HEAD");
    const page = get(`/?token=${TOKEN}`);
    expect(page.status).toBe(200);
    expect(
      Object.keys(page.headers).some((name) => name.toLowerCase().startsWith("access-control")),
    ).toBe(false);
    expect(page.headers["Content-Security-Policy"]).toContain(
      `style-src ${cspHashOf(HUB_PAGE_STYLE)}`,
    );
    expect(page.body).toContain(`href="/records?token=${TOKEN}"`);
    expect(get(`/elsewhere?token=${TOKEN}`).status).toBe(404);
  });

  it("the API: the mesh, an application, a tree, the radar, records a page at a time", () => {
    expect(json(`/api/mesh?token=${TOKEN}`)).toMatchObject({
      edges: [{ from: SHOP, to: BILLING, calls: 1 }],
    });
    expect(json(`/api/applications/${BILLING}?token=${TOKEN}`)).toMatchObject({ name: BILLING });
    expect(get(`/api/applications/nobody?token=${TOKEN}`).status).toBe(404);
    expect(json(`/api/trees/s1?token=${TOKEN}`)).toMatchObject({
      applications: [SHOP, BILLING],
      executions: 2,
    });
    expect(get(`/api/trees/nope?token=${TOKEN}`).status).toBe(404);
    expect(json(`/api/radar?token=${TOKEN}`)).toEqual([]);
    expect(json(`/api/records?token=${TOKEN}&application=${SHOP}&limit=1`)).toMatchObject({
      total: 2,
      offset: 0,
      limit: 1,
      records: [{ application: SHOP, executionId: "s1" }],
    });
    expect(json(`/api/records?token=${TOKEN}&status=failed&q=S2`)).toMatchObject({
      total: 1,
      records: [{ executionId: "s2" }],
    });
    expect(json(`/api/records?token=${TOKEN}&from=2026-01-06&to=2026-01-07`)).toMatchObject({
      total: 1,
    });
    expect(get(`/api/nothing?token=${TOKEN}`).status).toBe(404);
  });

  it("the records page searches with a GET form to itself and links the next page", () => {
    const page = get(`/records?token=${TOKEN}&limit=1`);

    expect(page.status).toBe(200);
    expect(page.body).toContain('<form method="get" action="/records"');
    expect(page.body).toContain(`<input type="hidden" name="token" value="${TOKEN}">`);
    expect(page.body).toContain("1–1 of 3");
    expect(page.body).toContain("offset=1");
    expect(get(`/records?token=${TOKEN}&offset=1&limit=1`).body).toContain("← previous");
    expect(get(`/records?token=${TOKEN}&q=nothing-like-it`).body).toContain("none of 0");
  });

  it("a file that stops reading is a 422 naming it, at the next request", () => {
    writeFileSync(
      join(settings.cwd, "hub", "broken.json"),
      JSON.stringify({ kind: "agboss.nothing" }),
    );

    const answer = get(`/?token=${TOKEN}`);

    expect(answer.status).toBe(422);
    expect(answer.body).toContain("[hub.input-schema]");
  });
});

describe("#401 PR 6: agboss hub ui's server and command", () => {
  it("serves the routes on the shared local server, then stops", async () => {
    const cwd = await hubFolder();
    const ui = await startLocalUi({
      name: "agboss hub ui",
      port: 0,
      respond: (request, served) => respondToHub(request, { ...served, cwd, paths: ["hub"] }),
    });
    try {
      expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32}$/u);
      const page = await fetch(ui.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<h1>Agent mesh</h1>");
    } finally {
      await ui.close();
    }
    await expect(fetch(ui.url)).rejects.toThrow();
  });

  it("a bad --port or no path is exit 2, a bad file exit 3 — before it listens", async () => {
    const cwd = await hubFolder();
    writeFileSync(join(cwd, "bad.json"), "{}");

    const port = await agboss(["hub", "ui", "hub", "--port", "70000", "--json"], cwd);
    const none = await agboss(["hub", "ui", "--json"], cwd);
    const bad = await agboss(["hub", "ui", "bad.json", "--json"], cwd);

    expect([port.code, none.code, bad.code]).toEqual([2, 2, 3]);
    expect(envelope(port)).toMatchObject({ error: { code: "usage.option-value" } });
    expect(envelope(bad)).toMatchObject({ error: { code: "hub.input-schema" } });
  });
});
