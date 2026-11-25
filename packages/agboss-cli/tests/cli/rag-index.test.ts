import { describe, expect, it } from "vitest";
import { agboss, envelope, fixture } from "./agboss.js";

/** #268 AC12: `agboss rag index` covers every knowledge base of the application. */

const NOTES = fixture("cli/rag.workflow.ts");
const TENANT_NOTES = fixture("cli/rag-tenants.application.ts");
const OWNER_NOTES = fixture("cli/rag-owner.application.ts");

describe("#268 AC12: agboss rag index over the application", () => {
  it("every knowledge base once, for the scope named: a shared one is built with none, one without an index says so", async () => {
    const call = await agboss(["rag", "index", "--application", NOTES, "--tenant", "default"]);

    expect(call).toMatchObject({ code: 0, stderr: "" });
    expect(call.stdout.trimEnd().split("\n")).toEqual([
      "notes-rag: 2 documents, 3 chunks, 1 unchanged · $0.000500",
      "handbook-rag: no index to build (the source has none)",
      "guides-rag: 4 documents, 5 chunks, 0 unchanged · $0.000000",
    ]);
  });

  it("--rag <full name>: only that one, as data with --json", async () => {
    const call = await agboss([
      ...["rag", "index", "--application", NOTES, "--rag", "notes-rag", "--tenant", "default"],
      "--json",
    ]);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        tenantId: "default",
        indexed: [
          {
            name: "notes-rag",
            tenantId: "default",
            scopeId: "default",
            documents: 2,
            chunks: 3,
            skipped: 1,
            costUsd: 0.0005,
          },
        ],
      },
    });
  });

  it("--tenant <id> indexes that tenant's knowledge bases only", async () => {
    const call = await agboss(["rag", "index", "--application", NOTES, "--tenant", "acme"]);

    expect(call.stdout.split("\n")[0]).toBe(
      "notes-rag: 7 documents, 3 chunks, 1 unchanged · $0.000500",
    );
  });

  it("a shared knowledge base needs no --scope, whatever the application: it is built for none, never for a tenant", async () => {
    const call = await agboss([
      ...["rag", "index", "--application", TENANT_NOTES, "--rag", "guides-rag", "--json"],
    ]);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: { indexed: [{ name: "guides-rag", documents: 4 }] },
    });
    expect(JSON.stringify(envelope(call))).not.toContain("scopeId");
  });

  it("a --tenant that is no key's text: exit 2 naming the rule, never the id; nothing is indexed", async () => {
    const scope = "acme\u200Bcorp";
    const call = await agboss(["rag", "index", "--application", NOTES, "--tenant", scope]);

    expect(call.code).toBe(2);
    expect(call.stdout).toBe("");
    expect(call.stderr).toContain("this one breaks format-character");
    expect(call.stderr).not.toContain(scope);
  });

  it("a knowledge base of a tenant's own, no --tenant: exit 2, rag.tenant-required; nothing is indexed — not the shared ones either", async () => {
    const call = await agboss(["rag", "index", "--application", TENANT_NOTES]);
    const json = await agboss(["rag", "index", "--application", TENANT_NOTES, "--json"]);

    expect(call.code).toBe(2);
    expect(call.stdout).toBe("");
    expect(call.stderr).toContain(
      'name the tenant to build for "notes-rag" with --tenant <id>: its scope is tenant, and every non-shared scope belongs to one tenant',
    );
    expect(envelope(json)).toMatchObject({ ok: false, error: { code: "rag.tenant-required" } });
  });

  it("--tenant <id> in an application with a tenant context: that tenant is built", async () => {
    const call = await agboss([
      ...["rag", "index", "--application", TENANT_NOTES, "--tenant", "acme", "--json"],
    ]);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        tenantId: "acme",
        indexed: [
          { name: "notes-rag", tenantId: "acme", scopeId: "acme" },
          { name: "guides-rag", documents: 4 },
        ],
      },
    });
  });

  it("an owner-scoped knowledge base needs the tenant too: an owner id is unique within a tenant only", async () => {
    const owner = await agboss(["rag", "index", "--application", OWNER_NOTES, "--scope", "alice"]);
    const tenant = await agboss(["rag", "index", "--application", OWNER_NOTES, "--tenant", "acme"]);

    expect(owner.code).toBe(2);
    expect(owner.stdout).toBe("");
    expect(owner.stderr).toContain("--tenant <id>");
    expect(tenant.code).toBe(2);
    expect(tenant.stderr).toContain("--scope <id>");
  });

  it("an owner of one tenant is built under that tenant's key: tenant and owner both reach the source", async () => {
    const call = await agboss([
      ...["rag", "index", "--application", OWNER_NOTES, "--tenant", "acme", "--scope", "alice"],
      "--json",
    ]);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        tenantId: "acme",
        scopeId: "alice",
        // 100 × the tenant's length + the owner's: both were handed over
        indexed: [{ name: "owner-notes-rag", tenantId: "acme", scopeId: "alice", documents: 405 }],
      },
    });
  });

  it("the help says when --tenant and --scope are required, and that a shared one needs neither", async () => {
    const call = await agboss(["help", "rag"]);
    const lines = call.stdout.split("\n");
    const tenant = lines.find((line) => line.trimStart().startsWith("--tenant"));
    const scope = lines.find((line) => line.trimStart().startsWith("--scope"));

    expect(call.code).toBe(0);
    expect(tenant).toContain("scope other than Shared");
    expect(scope).toContain("Owner or Custom");
    expect(scope).toContain("a Shared one has none");
  });

  it("an unknown --rag: exit 2, a hint and the list; nothing is indexed", async () => {
    const call = await agboss(["rag", "index", "--application", NOTES, "--rag", "notes"]);

    expect(call.code).toBe(2);
    expect(call.stdout).toBe("");
    expect(call.stderr).toContain(
      'Knowledge base "notes" not found. Did you mean "notes-rag"? The knowledge bases: notes-rag, handbook-rag, guides-rag',
    );
  });

  it("an application without knowledge bases says so", async () => {
    const call = await agboss([
      "rag",
      "index",
      "--application",
      fixture("test-workflow/test.workflow.ts"),
    ]);

    expect(call.code).toBe(0);
    expect(call.stdout).toBe('No knowledge bases in "test-application".\n');
  });

  it('"agboss rag" needs its subcommand: exit 2; the old rag:index is unknown', async () => {
    const bare = await agboss(["rag", "--application", NOTES]);
    const old = await agboss(["rag:index", "--application", NOTES]);

    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain('expected "agboss rag index …"');
    expect(old.code).toBe(2);
    expect(old.stderr).toContain('unknown command "rag:index"');
  });
});
