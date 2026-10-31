// Regenerates docs/screenshots/*.png. Starts its own demos (scripts/demo/seed.ts, fake Google) and stops them
// when done:
//
//   node scripts/demo/docs-shots.mjs [--out docs/screenshots] [--only name,name] [--keep]
//
//   seeded   --port 8531                                    overview, agents, events, settings, …
//   wizard   --port 8425 --fresh                            walks the setup wizard (/get-started) from step 1 to
//                                                           "Setup complete": imports a client JSON, connects Gmail
//                                                           through the popup, pairs an agent with
//                                                           the built CLI (`connect`, then `listen --exec`), calls
//                                                           MCP with its key and sends the test email
//
// Only the demos the selected shots need are started. Run `pnpm build` first (the demos serve dist/web and
// the wizard runs dist/cli.js). --keep leaves the demos running afterwards (Ctrl-C to stop them).
//
// Environment:
//   PLAYWRIGHT_CORE   path to the playwright-core module directory (default: resolve "playwright-core")
//   CHROMIUM          Chromium / chrome-headless-shell executable (default: Playwright's own)
//   LD_LIBRARY_PATH   if that Chromium needs extra shared libraries
//
// Viewport 1280 px wide at 1.5× (the phone shot: 390 px at 2×).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const { values: a } = parseArgs({
  options: {
    out: { type: "string", default: "docs/screenshots" },
    only: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
const only = a.only?.split(",").map((s) => s.trim());
const want = (name) => !only || only.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log("  \x1b[2m[shots]\x1b[0m", ...m);

const PORTS = { seeded: 8531, wizard: 8425 };
const PASSWORD = "acme-demo-passphrase";
const WIDTH = 1280;
const WIZARD = [
  "wizard-1-address",
  "wizard-2-project",
  "wizard-3-signin-screen",
  "wizard-4-oauth-client",
  "wizard-5-gmail",
  "wizard-6-agent",
  "wizard-7-verify",
];

// ───────────── Child processes (demos, CLI): each in its own process group, stopped on exit ─────────────

const children = [];
const work = mkdtempSync(join(tmpdir(), "xaq-shots-"));

function start(name, cmd, args, opts = {}) {
  const logFile = join(work, `${name}.log`);
  const fd = openSync(logFile, "a");
  const child = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], ...opts });
  child.logFile = logFile;
  child.exited = false;
  child.on("exit", () => (child.exited = true));
  children.push(child);
  return child;
}
function stop(child) {
  if (!child || child.exited) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}
async function stopAll() {
  for (const c of children) stop(c);
  const t0 = Date.now();
  while (children.some((c) => !c.exited) && Date.now() - t0 < 10_000) await sleep(100);
  for (const c of children.filter((c) => !c.exited)) {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}
process.on("SIGINT", () => void stopAll().then(() => process.exit(130)));

async function waitFor(what, check, timeoutMs = 30_000, everyMs = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Starts scripts/demo/seed.ts and waits for its state file (written once the demo is ready). */
async function demo(name, port, extra = []) {
  const stateFile = `/tmp/xaq-demo-${port}.json`;
  rmSync(stateFile, { force: true });
  const child = start(`demo-${name}`, join(ROOT, "node_modules/.bin/tsx"), ["scripts/demo/seed.ts", "--port", String(port), ...extra]);
  await waitFor(
    `the ${name} demo on port ${port} (log: ${child.logFile})`,
    () => {
      if (child.exited) throw new Error(`the ${name} demo exited:\n${readFileSync(child.logFile, "utf8").slice(-2000)}`);
      return existsSync(stateFile);
    },
    240_000,
    500,
  );
  log(`${name} demo ready on port ${port}`);
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

// ───────────── Browser ─────────────

// A module directory or a package name (createRequire resolves both).
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });

async function session(base, cookie, { theme = "light", width = WIDTH, height = 900, scale = 1.5 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: scale });
  if (cookie) {
    const [name, value] = cookie.split("=");
    await ctx.addCookies([{ name, value, url: base }]);
  }
  await ctx.addInitScript((t) => localStorage.setItem("xaq.theme", t), theme);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  const go = (path) => page.goto(base + path, { waitUntil: "networkidle" }).then(() => settle(page));
  return { page, ctx, go };
}

/** Waits until nothing is loading and no toast is showing; drops focus rings and hover states. */
async function settle(page, { spinners = true } = {}) {
  await page.mouse.move(0, 0);
  await page
    .waitForFunction(
      (spin) =>
        !document.querySelector("[data-slot=skeleton]") &&
        !document.querySelector("[data-sonner-toast]") &&
        (!spin || !document.querySelector("[data-slot=spinner]")),
      spinners,
      { timeout: 15_000 },
    )
    .catch(() => log("  (still loading or a toast is showing)"));
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.waitForTimeout(400);
}

async function shoot(page, name, { fullPage = false } = {}) {
  if (!want(name)) return;
  const file = join(a.out, `${name}.png`);
  if (fullPage) {
    // A scrolled page would put the sticky header and sidebar in the middle of the image.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: file, fullPage });
  console.log(file);
}

// Shots run one by one; a failure is reported and the rest continue.
let failed = false;
async function run(name, fn) {
  try {
    await fn();
  } catch (err) {
    failed = true;
    console.error(`${name}: ${err.message.split("\n").slice(0, 3).join("\n")}`);
  }
}

// ───────────── MCP over HTTP (stateless JSON-RPC), as an agent would call it ─────────────

async function mcpCall(base, apiKey, tool, args = {}) {
  const post = async (id, method, params) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP ${method} → ${res.status} ${text}`);
    if (!text) return undefined;
    const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(/^data: (.*)$/m.exec(text)[1]);
    if (json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
    return json.result;
  };
  await post(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } });
  await post(undefined, "notifications/initialized", {});
  const r = await post(2, "tools/call", { name: tool, arguments: args });
  if (r.isError) throw new Error(`MCP ${tool}: ${r.content?.map((c) => c.text).join(" ")}`);
  return r;
}

// ───────────── The setup wizard, step 1 to "Setup complete" ─────────────

async function wizardFlow() {
  const d = await demo("wizard", PORTS.wizard, ["--fresh"]);
  const base = d.url;
  // Claim it like the first-run link does, so the wizard starts at step 1.
  const token = new URL(d.setupUrl).searchParams.get("token");
  const claim = await fetch(`${base}/api/setup/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentinbox-csrf": "1" },
    body: JSON.stringify({ token, password: PASSWORD }),
  });
  if (!claim.ok) throw new Error(`claim → ${claim.status} ${await claim.text()}`);
  const cookie = claim.headers.get("set-cookie").split(";")[0];
  const api = async (path) => (await fetch(base + path, { headers: { cookie } })).json();

  const s = await session(base, cookie);
  const { page } = s;
  const continueBtn = () => page.getByRole("button", { name: /^Continue/ });
  const stepTitle = (text) => page.locator("#wizard-step-title", { hasText: text }).waitFor();

  // 1. Address
  await s.go("/get-started");
  await stepTitle("Choose the address");
  // Show the advice for the common case: everything on one computer.
  await page.getByText("Not sure which address to use?").click();
  await page.getByRole("radio", { name: /All on this computer/ }).click();
  await settle(page);
  await shoot(page, "wizard-1-address", { fullPage: true });
  await page.getByRole("button", { name: /^Looks right/ }).click();

  // 2. Google Cloud project (new project, Cloud Shell command)
  await stepTitle("Create a Google Cloud project");
  await settle(page);
  const projectId = await page.locator("#new-project-id").inputValue();
  await shoot(page, "wizard-2-project", { fullPage: true });
  await page.getByRole("button", { name: /^I've created it/ }).click();

  // 3. Sign-in screen: External, before publishing (the footer says what's left)
  await stepTitle("Set up the Google sign-in screen");
  await page.getByRole("radio", { name: /External/ }).click();
  await settle(page);
  await shoot(page, "wizard-3-signin-screen", { fullPage: true });
  await page.getByRole("checkbox", { name: /In production/ }).click();
  await continueBtn().click();

  // 4. OAuth client: import the downloaded JSON, then the client check
  await stepTitle("Create the OAuth client");
  await settle(page);
  const client = await api("/api/google/client");
  const DEMO_CLIENT = d.client;
  const json = join(work, `client_secret_${DEMO_CLIENT.clientId}.json`);
  writeFileSync(
    json,
    JSON.stringify({
      web: {
        client_id: DEMO_CLIENT.clientId,
        project_id: projectId,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_secret: DEMO_CLIENT.clientSecret,
        redirect_uris: [client.redirectUri],
      },
    }),
  );
  await page.locator("input[type=file]").setInputFiles(json);
  await page.getByText("Google knows this client").waitFor({ timeout: 20_000 });
  await settle(page);
  await shoot(page, "wizard-4-oauth-client", { fullPage: true });
  await continueBtn().click();

  // 5. Google accounts (Gmail and Calendar in one consent): the real popup, consented by the fake Google
  await stepTitle("Connect Google accounts");
  await settle(page);
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect a Google account" }).click();
  await (await popup).waitForEvent("close", { timeout: 20_000 }).catch(() => {});
  await page.getByText("ops@acme.dev").first().waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape"); // the connect dialog, if it's still open
  await settle(page);
  await shoot(page, "wizard-5-gmail", { fullPage: true });
  await continueBtn().click();

  // 6. First agent: a real `connect` from a terminal, approved inline
  await stepTitle("Connect your first agent");
  const home = join(work, "agent-home");
  mkdirSync(home, { recursive: true });
  // The CLI reports os.hostname() to the console; show "laptop" rather than this machine's name.
  const hostShim = join(work, "hostname-shim.mjs");
  writeFileSync(
    hostShim,
    'import os from "node:os"; import { syncBuiltinESMExports } from "node:module"; os.hostname = () => "laptop"; syncBuiltinESMExports();\n',
  );
  const cliEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${hostShim}`.trim(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
  const connect = start("cli-connect", process.execPath, ["dist/cli.js", "connect", base, "--name", "Claude Code on laptop", "--tool", "claude-code"], { env: cliEnv });
  const pairing = await waitFor("the pairing request", async () => (await api("/api/pairings?status=pending"))[0], 20_000, 500);
  await page.getByText("A request is waiting for you").waitFor({ timeout: 20_000 });
  await page.locator(`#pairing-code-${pairing.id}`).pressSequentially(pairing.userCode.replace("-", ""), { delay: 20 });
  await settle(page);
  await shoot(page, "wizard-6-agent", { fullPage: true });
  await page.getByRole("button", { name: /Approve and send key to terminal/ }).click();

  // 7. Check that it works: MCP call, listener, test email, the agent reading it
  await stepTitle("Check that it works");
  const profileFile = join(cliEnv.XDG_CONFIG_HOME, "xaq/profiles/default.json");
  await waitFor("connect to save the key", () => existsSync(profileFile), 30_000, 500);
  await waitFor("connect to exit", () => connect.exited, 10_000);
  const profile = JSON.parse(readFileSync(profileFile, "utf8"));
  await mcpCall(base, profile.apiKey, "list_events");
  const received = join(work, "event.json");
  start("cli-listen", process.execPath, ["dist/cli.js", "listen", "--exec", `cat > '${received}'`], { env: cliEnv });
  const send = page.getByRole("button", { name: "Send a test email" });
  await waitFor("the listener (Send a test email enabled)", () => send.isEnabled(), 30_000, 500);
  await send.click();
  await waitFor("the listener to handle the test email", () => existsSync(received) && readFileSync(received, "utf8").includes("xaq test"), 60_000, 500);
  await mcpCall(base, profile.apiKey, "search_threads", { query: 'subject:"xaq test"' }).catch(async (err) => {
    log(`search_threads: ${err.message}; reading with list_events instead`);
    await mcpCall(base, profile.apiKey, "list_events");
  });
  await page.getByText("Setup complete").first().waitFor({ timeout: 30_000 });
  await page.getByText(/read your mail/).first().waitFor({ timeout: 30_000 }).catch(() => log("  (the read check didn't turn green)"));
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  await shoot(page, "wizard-7-verify", { fullPage: true });
  await s.ctx.close();
}

// ───────────── The seeded console ─────────────

async function seededShots() {
  const demoState = await demo("seeded", PORTS.seeded);
  const APP = demoState.url;
  const api = (path) => fetch(APP + path, { headers: { cookie: demoState.cookie } }).then((r) => r.json());
  const agents = await api("/api/agents");
  const agentId = (prefix) => agents.find((x) => x.name.startsWith(prefix))?.id;
  const pending = (await api("/api/pairings?status=pending"))[0];

  const shots = {
    async overview() {
      const s = await session(APP, demoState.cookie);
      await s.go("/");
      return s;
    },
    async "overview-dark"() {
      const s = await session(APP, demoState.cookie, { theme: "dark" });
      await s.go("/");
      return s;
    },
    async "overview-mobile"() {
      const s = await session(APP, demoState.cookie, { width: 390, height: 844, scale: 2 });
      await s.go("/");
      return s;
    },
    async accounts() {
      const s = await session(APP, demoState.cookie, { height: 600 });
      await s.go("/accounts");
      return s;
    },
    async agents() {
      const s = await session(APP, demoState.cookie, { height: 840 });
      await s.go("/agents");
      return s;
    },
    async "connect-agent"() {
      const s = await session(APP, demoState.cookie, { height: 1000 });
      await s.go("/agents?connect=true");
      return s;
    },
    async "agent-grant-editor"() {
      const s = await session(APP, demoState.cookie, { height: 1300 });
      await s.go(`/agents/${agentId("Billing")}`);
      await s.page.getByRole("button", { name: /^Edit/ }).first().click();
      await settle(s.page);
      return s;
    },
    async "agent-listeners"() {
      const s = await session(APP, demoState.cookie, { height: 1150 });
      await s.go(`/agents/${agentId("Claude Code")}`);
      await s.page.evaluate(() => {
        // The card's top edge just below the sticky header (so the card above doesn't show through it).
        const title = [...document.querySelectorAll("[data-slot=card-title]")].find((e) => e.textContent?.includes("Give it the tools"));
        const card = title?.closest("[data-slot=card]") ?? title;
        const header = document.querySelector("header")?.getBoundingClientRect().height ?? 56;
        if (card) window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - header - 24);
      });
      await settle(s.page);
      return s;
    },
    async "pairing-request"() {
      const s = await session(APP, demoState.cookie, { height: 860 });
      await s.go(`/approvals?pairing=${pending.userCode}`);
      await s.page.evaluate(() => window.scrollTo(0, 0));
      await settle(s.page);
      return s;
    },
    async "pairing-approve"() {
      const s = await session(APP, demoState.cookie, { height: 1100 });
      await s.go(`/approvals?pairing=${pending.userCode}`);
      await s.page.getByRole("button", { name: "Review and approve" }).first().click();
      await s.page.waitForTimeout(400);
      await s.page.locator(`#pairing-code-${pending.id}`).pressSequentially(pending.userCode.replace("-", ""), { delay: 20 });
      await s.page.getByRole("radio", { name: /Read and draft/ }).first().click();
      await s.page.locator("[role=dialog]").evaluate((d) => (d.scrollTop = 0));
      await settle(s.page);
      return s;
    },
    async approvals() {
      const s = await session(APP, demoState.cookie, { height: 820 });
      await s.go("/approvals");
      return s;
    },
    async events() {
      const s = await session(APP, demoState.cookie);
      await s.go("/events");
      return s;
    },
    async audit() {
      const s = await session(APP, demoState.cookie);
      await s.go("/audit");
      await s.page.getByRole("row").nth(2).click();
      await settle(s.page);
      return s;
    },
    async "audit-dark"() {
      const s = await session(APP, demoState.cookie, { theme: "dark" });
      await s.go("/audit");
      return s;
    },
    async settings() {
      const s = await session(APP, demoState.cookie, { height: 1100 });
      await s.go("/settings");
      await s.page.evaluate(() => {
        // Agent pairing, attachment directories and the OAuth client, starting just below the sticky header.
        const el = document.getElementById("pairing");
        const card = el?.closest("[data-slot=card]") ?? el;
        const header = document.querySelector("header")?.getBoundingClientRect().height ?? 56;
        if (card) window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - header - 24);
      });
      await settle(s.page);
      return s;
    },
  };

  for (const [name, fn] of Object.entries(shots)) {
    if (!want(name)) continue;
    await run(name, async () => {
      const s = await fn();
      await shoot(s.page, name);
      await s.ctx.close();
    });
  }
}

// ───────────── Run ─────────────

mkdirSync(a.out, { recursive: true });
const SEEDED_NAMES = [
  "overview",
  "overview-dark",
  "overview-mobile",
  "accounts",
  "agents",
  "connect-agent",
  "agent-grant-editor",
  "agent-listeners",
  "pairing-request",
  "pairing-approve",
  "approvals",
  "events",
  "audit",
  "audit-dark",
  "settings",
];
const jobs = [];
if (WIZARD.some(want)) jobs.push(run("wizard", wizardFlow));
if (SEEDED_NAMES.some(want)) jobs.push(run("seeded", seededShots));
await Promise.all(jobs);

await browser.close();
if (a.keep) {
  log(`demos still running (logs in ${work}); Ctrl-C to stop them`);
  await new Promise(() => {});
}
await stopAll();
if (failed) {
  console.error(`demo and CLI logs: ${work}`);
  process.exitCode = 1;
} else rmSync(work, { recursive: true, force: true });
