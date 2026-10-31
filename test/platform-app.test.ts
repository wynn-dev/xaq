import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { upgradeCommand } from "../server/api/system.ts";
import { compareVersions } from "../server/util/semver.ts";
import { runMaintenance } from "../server/maintenance.ts";
import { bannerLines } from "../server/server.ts";
import { renderSkill, SKILL_URL_PLACEHOLDER, skillPath } from "../server/skill/index.ts";
import type { EventsService } from "../server/events/types.ts";
import type { MailService } from "../server/mail/types.ts";
import { CSRF, fakeIngest, harness, type Harness, json } from "./helpers.ts";
import { fakeGoogle } from "./fake-google.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const THEME_SCRIPT = "document.documentElement.classList.add('dark')";
let webDir: string;
beforeAll(() => {
  webDir = mkdtempSync(join(tmpdir(), "xaq-web-"));
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "index.html"), `<!doctype html><title>console</title><script>${THEME_SCRIPT}</script><script type="module" src="/assets/app-abc123.js"></script>`);
  writeFileSync(join(webDir, "assets", "app-abc123.js"), "console.log(1)");
});
afterAll(() => rmSync(webDir, { recursive: true, force: true }));

function addAccount(id: string, status: string) {
  h!.ctx.db.run(
    "INSERT INTO accounts (id, email, status, refresh_token_enc, created_at) VALUES (?, ?, ?, 'x', ?)",
    id,
    `${id}@example.com`,
    status,
    new Date().toISOString(),
  );
}

describe("health", () => {
  it("is public, with security headers and no secrets", async () => {
    h = harness();
    for (const path of ["/health", "/api/health", "/health/", "/api/health/"]) {
      const res = await h.request(path);
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ status: "ok", version: "0.0.0-test", setupComplete: false });
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("is 503 when an account needs re-auth or ingest is erroring", async () => {
    h = harness();
    addAccount("acc_1", "active");
    expect((await h.request("/health")).status).toBe(200);
    addAccount("acc_2", "needs_reauth");
    const res = await h.request("/health");
    expect(res.status).toBe(503);
    expect((await json(res)).status).toBe("degraded");
    await h.dispose();

    h = harness({ ingest: fakeIngest({ lastError: "pull failed" }) });
    addAccount("acc_1", "active");
    expect((await h.request("/api/health")).status).toBe(503);
  });
});

describe("setup state", () => {
  it("composes the checklist", async () => {
    h = harness({ google: fakeGoogle({ clientId: "cid", hasSecret: true, projectId: "proj-1" }) });
    const cookie = await h.claim();
    let state = await json(await h.request("/api/setup/state", { cookie }));
    expect(state).toEqual({
      claimed: true,
      googleClientConfigured: true,
      gcpProjectId: "proj-1",
      googleAppType: "external",
      accountsConnected: 0,
      agentsCreated: 0,
      verified: false,
      complete: false,
      warnings: [],
    });
    addAccount("acc_1", "active");
    state = await json(await h.request("/api/setup/state", { cookie }));
    expect(state.accountsConnected).toBe(1);
    expect(state.complete).toBe(true);
    expect((await json(await h.request("/health"))).setupComplete).toBe(true);
  });

  it("is verified by a successful MCP tool call or a listener that acked past where it started, and stays verified", async () => {
    h = harness();
    const cookie = await h.claim();
    const verified = async () => (await json(await h!.request("/api/setup/state", { cookie }))).verified;
    const { agent } = h.ctx.policy.createAgent({ name: "a" });
    const cursor = (consumer: string, startSeq: number | null, ackedSeq: number) =>
      h!.ctx.db.run(
        "INSERT INTO listener_cursors (agent_id, consumer, acked_seq, start_seq, updated_at) VALUES (?, ?, ?, ?, ?)",
        agent.id,
        consumer,
        ackedSeq,
        startSeq,
        new Date().toISOString(),
      );
    const audit = (action: string, outcome: "ok" | "denied" | "error") => h!.ctx.audit.record({ actorType: "agent", actorId: agent.id, action, outcome });
    // Key use alone (lastUsedAt), a bare /mcp connection (`claude mcp list`: initialize + tools/list, last_mcp_at),
    // a listener that only connected (its cursor starts at the head), failed calls and pairing aren't proof.
    h.ctx.db.run("UPDATE agents SET last_used_at = ? WHERE id = ?", new Date().toISOString(), agent.id);
    h.ctx.policy.markMcpUse(agent.id);
    cursor("fresh", 7, 7);
    audit("pairing.key_delivered", "ok");
    audit("get_message", "denied");
    audit("search_threads", "error");
    expect(await verified()).toBe(false);

    audit("list_accounts", "ok");
    // Unauthenticated health polls neither run the query nor write the remembered flag.
    await h.request("/health");
    expect(h.ctx.settings.getState("setup.verifiedAt")).toBeNull();
    expect(await verified()).toBe(true);
    expect(h.ctx.settings.getState("setup.verifiedAt")).not.toBeNull();
    // Remembered: pruning the audit log doesn't undo it.
    h.ctx.db.run("DELETE FROM audit_log");
    expect(await verified()).toBe(true);
  });

  it("is verified by a listener that acked past where it started", async () => {
    h = harness();
    const cookie = await h.claim();
    const verified = async () => (await json(await h!.request("/api/setup/state", { cookie }))).verified;
    const { agent } = h.ctx.policy.createAgent({ name: "a" });
    const cursor = (consumer: string, startSeq: number | null, ackedSeq: number) =>
      h!.ctx.db.run(
        "INSERT INTO listener_cursors (agent_id, consumer, acked_seq, start_seq, updated_at) VALUES (?, ?, ?, ?, ?)",
        agent.id,
        consumer,
        ackedSeq,
        startSeq,
        new Date().toISOString(),
      );
    cursor("fresh", 7, 7);
    expect(await verified()).toBe(false);
    cursor("acked", 7, 8);
    expect(await verified()).toBe(true);
  });

  it("falls back to stored state when the google service is unavailable", async () => {
    h = harness({ google: () => ({}) as never });
    const cookie = await h.claim();
    const state = await json(await h.request("/api/setup/state", { cookie }));
    expect(state.googleClientConfigured).toBe(false);
  });
});

describe("settings API", () => {
  it("validates and persists patches", async () => {
    h = harness();
    const cookie = await h.claim();
    const patch = (json: unknown) => h!.request("/api/settings", { method: "PATCH", headers: CSRF, cookie, json });

    expect((await patch({ publicUrl: "not a url" })).status).toBe(400);
    expect((await patch({ retentionDays: "7" })).status).toBe(400);
    expect((await patch({ bogus: true })).status).toBe(400);
    expect((await patch({ pollIntervalSeconds: 1 })).status).toBe(400);

    const res = await patch({ publicUrl: "https://mail.example.com/", retentionDays: 7 });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.publicUrl).toBe("https://mail.example.com");
    expect(body.retentionDays).toBe(7);
    expect((await json(await h.request("/api/settings", { cookie }))).retentionDays).toBe(7);
    const audit = h.ctx.audit.list({ action: "settings.update" }).items[0]!;
    expect(audit.detail).toEqual({ changed: ["publicUrl", "retentionDays"] });
  });
});

describe("system API", () => {
  it("describes the instance", async () => {
    h = harness();
    const cookie = await h.claim();
    const info = await json(await h.request("/api/system", { cookie }));
    expect(info.version).toBe("0.0.0-test");
    expect(info.dataDir).toBe(h.ctx.config.dataDir);
    expect(info.addresses).toEqual(["http://127.0.0.1:0"]);
    expect(info.ingest.running).toBe(true);
    // The banner's command: this run's non-default flags.
    expect(info.serviceCommand).toMatch(/ service install --data \S+ --host 127\.0\.0\.1 --port 0$/);
    expect(info.serviceCommand).toContain(h.ctx.config.dataDir);
    expect(bannerLines(h.ctx, { mcp: true }).join("\n")).toContain(info.serviceCommand);
  });

  it("builds the upgrade command and compares versions", () => {
    const base = { service: false, dataDir: join(process.env.HOME ?? "", ".xaq"), port: 8425, host: "0.0.0.0", trustProxy: false };
    expect(upgradeCommand(base)).toBe("npx -y xaq-cli");
    expect(upgradeCommand({ ...base, service: true, port: 9000, dataDir: "/srv/my data" })).toBe(
      "npx -y xaq-cli service install --data '/srv/my data' --port 9000",
    );
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0-nightly.1", "0.1.0")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("0.2.0-nightly.10", "0.2.0-nightly.9")).toBe(1);
    expect(compareVersions("0.2.0-nightly.2", "0.2.0-nightly.2")).toBe(0);
    expect(compareVersions("0.2.0-alpha", "0.2.0-alpha.1")).toBe(-1);
    expect(compareVersions("0.2.0-1", "0.2.0-alpha")).toBe(-1);
    expect(upgradeCommand({ ...base, trustProxy: true })).toBe("TRUST_PROXY=1 npx -y xaq-cli");
  });
});

describe("skill", () => {
  it("serves SKILL.md with the public URL filled in", async () => {
    h = harness();
    h.ctx.settings.update({ publicUrl: "https://mail.example.com" });
    const res = await h.request("/skill.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown/);
    const text = await res.text();
    expect(text).toMatch(/^---\nname: xaq\ndescription: /);
    expect(text).toContain("https://mail.example.com/mcp");
    expect(text).not.toContain(SKILL_URL_PLACEHOLDER);
  });

  it("renders and resolves install targets", () => {
    expect(renderSkill("http://x.test/")).toContain("http://x.test/mcp");
    expect(skillPath("/tmp/skills")).toBe("/tmp/skills/xaq/SKILL.md");
    expect(skillPath("codex")).toMatch(/skills\/xaq\/SKILL\.md$/);
  });
});

describe("console", () => {
  it("serves the SPA with index.html fallback, but never for server paths", async () => {
    h = harness({}, { webDir });
    const cookie = await h.claim();

    let res = await h.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>console</title>");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    // The inline theme script is allowed by hash; only registered static scripts (e.g. the OAuth
    // callback page) may be listed besides it, and never 'unsafe-inline'.
    const hash = createHash("sha256").update(THEME_SCRIPT).digest("base64");
    const scriptSrc = (res.headers.get("content-security-policy") ?? "").split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src ")) ?? "";
    expect(scriptSrc.startsWith("script-src 'self' ")).toBe(true);
    expect(scriptSrc).toContain(`'sha256-${hash}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");

    res = await h.request("/agents/agt_123?tab=grants");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("content-security-policy")).toContain(`'sha256-${hash}'`);
    // Client routes may contain dots.
    res = await h.request("/accounts/me@example.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect((await h.request("/favicon.ico")).status).toBe(404);

    res = await h.request("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await h.request("/assets/missing.js")).status).toBe(404);

    res = await h.request("/api/nope", { cookie });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("not_found");
    expect((await h.request("/api/nope")).status).toBe(401);
    for (const path of ["/oauth/whatever", "/mcp/x", "/skill.md/x"]) {
      res = await h.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toMatch(/text\/html/);
    }
  });

  it("explains how to build when the console is missing", async () => {
    h = harness({}, { webDir: join(webDir, "does-not-exist") });
    const res = await h.request("/");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("pnpm build");
    expect((await h.request("/health")).status).toBe(200);
  });
});

describe("errors", () => {
  it("turns invalid JSON into a 400 ApiError", async () => {
    h = harness();
    const res = await h.request("/api/auth/login", { method: "POST", headers: { ...CSRF, "content-type": "application/json" }, body: "{" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("bad_request");
  });
});

describe("maintenance", () => {
  it("prunes by retention and survives failing services", () => {
    const calls: string[] = [];
    h = harness({
      events: () => ({ prune: (before: string) => (calls.push(`events<${before.slice(0, 10)}`), 3) }) as unknown as EventsService,
      mail: () =>
        ({
          prune: () => {
            throw new Error("boom");
          },
        }) as unknown as MailService,
    });
    h.ctx.settings.update({ retentionDays: 10 });
    h.ctx.db.run(
      "INSERT INTO audit_log (ts, actor_type, action, outcome) VALUES (?, 'system', 'old', 'ok')",
      new Date(Date.now() - 11 * 86_400_000).toISOString(),
    );
    h.ctx.audit.record({ actorType: "system", action: "new", outcome: "ok" });
    const result = runMaintenance(h.ctx);
    expect(result).toEqual({ events: 3, audit: 1, sessions: 0 });
    expect(calls).toEqual([`events<${new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10)}`]);
    expect(h.ctx.audit.list().items.map((e) => e.action)).toEqual(["new"]);
  });
});
