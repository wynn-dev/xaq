// The "echo" test code extension (test/extension-host.test.ts): an MCP server over stdio in plain JSON-RPC, no
// dependencies. It does the legitimate things (tools, prompts, resources, xaq/credentials/get, xaq/events/emit,
// xaq/log, its state directory) and, through the `escape` tool, tries everything it must not be able to do. Each
// attempt reports "denied: <code>" or "ALLOWED: <detail>"; the tests require every one to be denied.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import os, { setPriority as namedSetPriority } from "node:os";

const require = createRequire(import.meta.url);
const STATE = process.env.XAQ_EXT_STATE_DIR;
let exitOnStdinEnd = true;
/** Startup misbehaviour for the lifecycle tests: a `mode` file in the state dir (die-after-init, die-before-init, hang-init). */
let MODE = "";
try {
  MODE = fs.readFileSync(path.join(STATE, "mode"), "utf8").trim();
} catch {
  // Normal.
}

// ───────────── JSON-RPC over stdio ─────────────

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const pending = new Map();
let nextId = 1;

/** A request to the host (xaq). */
function request(method, params) {
  const id = `ext-${nextId++}`;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const notify = (method, params) => send({ method, params });

const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t) }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function attempt(fn) {
  try {
    const v = fn();
    return `ALLOWED: ${String(v).slice(0, 60)}`;
  } catch (e) {
    return `denied: ${e?.code ?? e?.message ?? e}`;
  }
}

async function attemptAsync(fn) {
  try {
    const v = await fn();
    return `ALLOWED: ${JSON.stringify(v).slice(0, 80)}`;
  } catch (e) {
    return `denied: ${e?.code ?? e?.message ?? e}`;
  }
}

const TOOLS = [
  { name: "echo", description: "Echoes its text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "whoami", description: "Asks xaq for this connection's credentials.", inputSchema: { type: "object", properties: {} } },
  { name: "emit", description: "Emits an event.", inputSchema: { type: "object", properties: { type: { type: "string" }, key: { type: "string" } } } },
  { name: "log", description: "Logs through xaq/log.", inputSchema: { type: "object", properties: { msg: { type: "string" }, n: { type: "number" } } } },
  { name: "state", description: "Writes and reads a file in the state directory.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "env", description: "Lists the environment's keys.", inputSchema: { type: "object", properties: {} } },
  { name: "fetch", description: "Fetches a URL (the network isn't sandboxed).", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  {
    name: "authfetch",
    description: "Gets this connection's access token from xaq and fetches each URL with it (a Google extension's API calls).",
    inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" } } }, required: ["urls"] },
  },
  { name: "argv", description: "Reports how it was started.", inputSchema: { type: "object", properties: {} } },
  { name: "escape", description: "Tries to escape the sandbox.", inputSchema: { type: "object", properties: { paths: { type: "object" } } } },
  { name: "slow", description: "Sleeps.", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
  { name: "big", description: "Answers with a large text.", inputSchema: { type: "object", properties: { bytes: { type: "number" } } } },
  { name: "crash", description: "Exits, after writing to stderr.", inputSchema: { type: "object", properties: { code: { type: "number" }, stderr: { type: "string" } } } },
  { name: "stubborn", description: "Ignores SIGTERM and stdin's end from now on.", inputSchema: { type: "object", properties: {} } },
];

async function callTool(name, args) {
  switch (name) {
    case "echo":
      return text(String(args.text ?? ""));
    case "whoami": {
      let c;
      try {
        c = await request("xaq/credentials/get", {});
      } catch (e) {
        return { ...text(`${e.code}: ${e.message}`), isError: true };
      }
      return text({ tokenSha256: createHash("sha256").update(String(c.accessToken)).digest("hex"), expiresAt: c.expiresAt, keys: Object.keys(c).sort() });
    }
    case "emit":
      notify("xaq/events/emit", { type: args.type ?? "echo.said", dedupeKey: args.key ?? "k1", data: { said: "hi" } });
      return text("sent");
    case "log":
      for (let i = 0; i < (args.n ?? 1); i++) notify("xaq/log", { level: "info", msg: args.msg ?? "hello", meta: { i } });
      return text("logged");
    case "state": {
      const f = path.join(STATE, "note.txt");
      fs.writeFileSync(f, String(args.text ?? ""));
      return text({ cwd: process.cwd(), read: fs.readFileSync(f, "utf8") });
    }
    case "env":
      return text(Object.keys(process.env).sort());
    case "fetch": {
      const res = await fetch(String(args.url));
      return text({ status: res.status, body: await res.text() });
    }
    case "authfetch": {
      let c;
      try {
        c = await request("xaq/credentials/get", {});
      } catch (e) {
        return { ...text(`${e.code}: ${e.message}`), isError: true };
      }
      const results = [];
      for (const url of args.urls ?? []) {
        const res = await fetch(String(url), { headers: { authorization: `Bearer ${c.accessToken}` } });
        results.push({ url: String(url), status: res.status, body: (await res.text()).slice(0, 2000) });
      }
      return text({ tokenSha256: createHash("sha256").update(String(c.accessToken)).digest("hex"), expiresAt: c.expiresAt, results });
    }
    case "argv":
      return text({ execArgv: process.execArgv, entry: process.argv[1], cwd: process.cwd(), env: process.env });
    case "escape":
      return text(await escape(args.paths ?? {}));
    case "slow":
      await sleep(args.ms ?? 1000);
      return text("slept");
    case "big":
      return text("x".repeat(args.bytes ?? 1000));
    case "crash":
      if (args.stderr) process.stderr.write(`${args.stderr}\n`);
      setTimeout(() => process.exit(args.code ?? 1), 20);
      return text("bye");
    case "stubborn":
      exitOnStdinEnd = false;
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000); // stays up once stdin is gone
      return text("ok");
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { rpc: -32602 });
  }
}

/** Every attempt must come back "denied". */
async function escape(p) {
  const out = {};
  out.readMasterKey = attempt(() => fs.readFileSync(p.masterKey, "utf8"));
  out.readDb = attempt(() => fs.readFileSync(p.db).length);
  out.listDataDir = attempt(() => fs.readdirSync(p.dataDir).join(","));
  out.readOtherState = attempt(() => fs.readFileSync(path.join(p.otherState, "secret.txt"), "utf8"));
  out.readOtherStateViaDotDot = attempt(() => fs.readFileSync(path.join(STATE, "..", path.basename(p.otherState), "secret.txt"), "utf8"));
  out.symlinkToMasterKey = attempt(() => {
    fs.symlinkSync(p.masterKey, path.join(STATE, "mk"));
    return fs.readFileSync(path.join(STATE, "mk"), "utf8");
  });
  out.hardlinkToMasterKey = attempt(() => fs.linkSync(p.masterKey, path.join(STATE, "mk2")));
  out.writeDataDir = attempt(() => fs.writeFileSync(path.join(p.dataDir, "planted.txt"), "x"));
  out.writeInstallDir = attempt(() => fs.writeFileSync(new URL("./planted.txt", import.meta.url), "x"));
  out.readParentEnviron = attempt(() => fs.readFileSync(`/proc/${process.ppid}/environ`, "utf8"));
  out.readEtcPasswd = attempt(() => fs.readFileSync("/etc/passwd", "utf8"));
  out.spawnSync = attempt(() => require("node:child_process").execFileSync(process.execPath, ["-e", "1"]));
  out.spawnShell = attempt(() => require("node:child_process").spawn("/bin/sh", ["-c", "true"]));
  out.worker = attempt(() => new (require("node:worker_threads").Worker)("1", { eval: true }));
  out.addon = attempt(() => process.dlopen({ exports: {} }, path.join(STATE, "x.node")));
  out.processBinding = attempt(() => process.binding("fs"));
  out.inspector = attempt(() => require("node:inspector").open(0));
  // node:sqlite ignores the permission model: it must not be loadable at all.
  out.sqliteImport = await attemptAsync(async () => typeof (await import("node:sqlite")).DatabaseSync);
  out.sqliteBuiltin = attempt(() => {
    const m = process.getBuiltinModule("node:sqlite");
    if (!m) throw Object.assign(new Error("undefined"), { code: "UNDEFINED" });
    return new m.DatabaseSync(p.db).prepare("select 1").get();
  });
  out.sqliteOpenDb = attempt(() => new (require("node:sqlite").DatabaseSync)(p.db).prepare("select count(*) from sqlite_master").get());
  out.sqliteAttach = attempt(() => new (require("node:sqlite").DatabaseSync)(":memory:").exec(`attach '${p.db}' as x`));
  out.sqliteCreateOutside = attempt(() => new (require("node:sqlite").DatabaseSync)(path.join(p.dataDir, "created.db")).exec("create table t(x)"));
  // Signals aren't in the permission model: the preload pins every route to a thrower.
  out.signalParentUsr1 = attempt(() => process.kill(process.ppid, "SIGUSR1"));
  out.killParent = attempt(() => process.kill(process.ppid, 0));
  out.underscoreKillParent = attempt(() => process._kill(process.ppid, 0));
  out.debugProcessParent = attempt(() => process._debugProcess(process.ppid));
  out.builtinProcessKill = attempt(() => process.getBuiltinModule("node:process").kill(process.ppid, 0));
  // Scheduling priority isn't in the permission model either. Each attempt sets the parent's current priority (a
  // no-op even if it got through), so a failure can't slow the test run down.
  out.setPriorityParent = attempt(() => os.setPriority(process.ppid, os.getPriority(process.ppid)));
  out.setPriorityNamed = attempt(() => namedSetPriority(process.ppid, os.getPriority(process.ppid)));
  out.setPriorityBuiltin = attempt(() => process.getBuiltinModule("os").setPriority(process.ppid, os.getPriority(process.ppid)));
  out.setPriorityRequire = attempt(() => require("node:os").setPriority(process.ppid, os.getPriority(process.ppid)));
  out.unpinKill = attempt(() => {
    Object.defineProperty(process, "kill", { value: () => "free" });
    return process.kill(process.ppid, 0);
  });
  out.envSecrets = attempt(() => {
    const leaked = Object.keys(process.env).filter((k) => !/^XAQ_EXT_(NAME|CONNECTION_ID|STATE_DIR|PROTOCOL)$/.test(k) && k !== "TZ" && k !== "LANG");
    if (leaked.length) return leaked.join(",");
    throw Object.assign(new Error("none"), { code: "NO_SECRETS" });
  });
  // The permission model doesn't check fd-based calls: any regular file xaq left open across the spawn (the DB,
  // master.key, the log) would be readable here. Only stdio may come through.
  out.inheritedFiles = attempt(() => {
    const files = [];
    for (let fd = 3; fd < 256; fd++) {
      try {
        const st = fs.fstatSync(fd);
        if (st.isFile()) files.push(`${fd}:${st.size}`);
      } catch {
        // Not open.
      }
    }
    if (files.length) return files.join(",");
    throw Object.assign(new Error("none"), { code: "NO_INHERITED_FILES" });
  });
  out.otherConnectionCredentials = await attemptAsync(() => request("xaq/credentials/get", { connectionId: p.otherConnectionId }));
  return out;
}

const PROMPTS = [{ name: "greet", title: "Greet", description: "Says hello.", arguments: [{ name: "who", description: "Whom to greet", required: true }] }];
const RESOURCES = [{ uri: "echo://notes/today", name: "today", title: "Today's note", mimeType: "text/plain" }];
const TEMPLATES = [{ uriTemplate: "echo://notes/{day}", name: "note", description: "A day's note" }];

async function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize":
      if (MODE === "die-before-init") process.exit(3);
      if (MODE === "hang-init") return new Promise(() => {});
      if (MODE === "die-after-init") {
        send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } } });
        process.exit(0);
      }
      return {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: "echo", version: "1.0.0" },
        instructions: "Echo test extension.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(params.name, params.arguments ?? {});
    case "prompts/list":
      return { prompts: PROMPTS };
    case "prompts/get":
      if (params.name !== "greet") throw Object.assign(new Error(`Unknown prompt: ${params.name}`), { rpc: -32602 });
      return { description: "A greeting", messages: [{ role: "user", content: { type: "text", text: `Hello, ${params.arguments?.who ?? "you"}!` } }] };
    case "resources/list":
      return { resources: RESOURCES };
    case "resources/templates/list":
      return { resourceTemplates: TEMPLATES };
    case "resources/read":
      return { contents: [{ uri: params.uri, mimeType: "text/plain", text: `note for ${params.uri}` }] };
    default:
      if (id === undefined) return undefined;
      throw Object.assign(new Error(`Method not found: ${method}`), { rpc: -32601 });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    // A response to one of our requests to the host.
    if (msg.method === undefined && msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: `rpc ${msg.error.code}` }));
      else p.resolve(msg.result);
      continue;
    }
    handle(msg).then(
      (result) => {
        if (msg.id !== undefined && result !== undefined) send({ id: msg.id, result });
      },
      (e) => {
        if (msg.id !== undefined) send({ id: msg.id, error: { code: e.rpc ?? -32603, message: e.message } });
      },
    );
  }
});
process.stdin.on("end", () => {
  if (exitOnStdinEnd) process.exit(0);
});
