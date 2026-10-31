// The agentinbox → xaq rename: what an install from before the rename keeps (environment variables, data
// directory, XDG dirs, agent-side names) and how its services move to the new names without losing mail:
// the old service is stopped (and gone) before the new one starts, put back exactly as it was on failure,
// and a second run is a plain reinstall. launchd and systemd are fakes that know which job is which.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envVar } from "../server/brand.ts";
import { dataFiles, defaultDataDir, loadConfig, resolveDataDir } from "../server/config.ts";
import { Crypto } from "../server/crypto.ts";
import { type InstanceInfo, lockPath } from "../server/instance.ts";
import {
  installService,
  legacyDaemonUnit,
  mergeServiceEnv,
  parseEnvFile,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceInstallInput,
  type ServiceOps,
  serviceStatus,
  uninstallService,
  unitDataDir,
} from "../server/service.ts";
import { isOurSkill, removeLegacySkill, renderSkill, SKILL_MARKER, skillPath, writeSkill } from "../server/skill/index.ts";
import { testConfig } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
  vi.restoreAllMocks();
});
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** Sets environment variables for one test. */
const setEnv = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
const withEnv = (vars: Record<string, string | undefined>) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) setEnv(k, v);
  cleanup.push(() => {
    for (const [k, v] of Object.entries(saved)) setEnv(k, v);
  });
};
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

// ───────────── Environment variables ─────────────

describe("environment: XAQ_* first, then AGENTINBOX_*", () => {
  it("reads the new name, falls back to the old one, and a set (even empty) new one wins", () => {
    expect(envVar("DATA", { AGENTINBOX_DATA: "/old" })).toBe("/old");
    expect(envVar("DATA", { XAQ_DATA: "/new", AGENTINBOX_DATA: "/old" })).toBe("/new");
    expect(envVar("LOG_LEVEL", { XAQ_LOG_LEVEL: "", AGENTINBOX_LOG_LEVEL: "debug" })).toBe("");
    expect(envVar("DATA", {})).toBeUndefined();
  });

  it("config: data directory, service flag and Google API bases from either name", () => {
    const old = tmp("xaq-env-old-");
    const next = tmp("xaq-env-new-");
    withEnv({ XAQ_DATA: undefined, AGENTINBOX_DATA: old, AGENTINBOX_SERVICE: "1", XAQ_SERVICE: undefined, AGENTINBOX_GOOGLE_GMAIL_BASE: "http://127.0.0.1:1", XAQ_GOOGLE_GMAIL_BASE: undefined });
    let c = loadConfig({});
    expect(c.dataDir).toBe(old);
    expect(c.service).toBe(true);
    expect(c.google.gmailBase).toBe("http://127.0.0.1:1");
    withEnv({ XAQ_DATA: next, XAQ_GOOGLE_GMAIL_BASE: "http://127.0.0.1:2" });
    c = loadConfig({});
    expect(c.dataDir).toBe(next);
    expect(c.google.gmailBase).toBe("http://127.0.0.1:2");
  });

  it("the master key from AGENTINBOX_MASTER_KEY still decrypts", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const sealed = new Crypto(Buffer.from(key, "base64")).encrypt("refresh-token");
    withEnv({ XAQ_MASTER_KEY: undefined, AGENTINBOX_MASTER_KEY: key });
    expect(Crypto.load(join(tmp("xaq-key-"), "master.key")).decrypt(sealed)).toBe("refresh-token");
  });

  it("service.env: an old install's AGENTINBOX_MASTER_KEY / LOG_LEVEL carry over under the new names", () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    expect(mergeServiceEnv({ AGENTINBOX_MASTER_KEY: key, AGENTINBOX_LOG_LEVEL: "debug", TRUST_PROXY: "1" }, {})).toEqual({ XAQ_MASTER_KEY: key, XAQ_LOG_LEVEL: "debug", TRUST_PROXY: "1" });
    // The shell wins, under either name; an empty new name removes it.
    expect(mergeServiceEnv({ AGENTINBOX_LOG_LEVEL: "debug" }, { AGENTINBOX_LOG_LEVEL: "warn" })).toEqual({ XAQ_LOG_LEVEL: "warn" });
    expect(mergeServiceEnv({ XAQ_LOG_LEVEL: "debug" }, { XAQ_LOG_LEVEL: "error", AGENTINBOX_LOG_LEVEL: "warn" })).toEqual({ XAQ_LOG_LEVEL: "error" });
    expect(mergeServiceEnv({ AGENTINBOX_LOG_LEVEL: "debug" }, { XAQ_LOG_LEVEL: "" })).toEqual({});
  });

  it("units are written with the new names, and both are read back", () => {
    const spec = { execPath: "/n", entry: "/e", dataDir: "/d", port: 8425, host: "0.0.0.0", extraEnv: {} };
    expect(renderSystemdUnit(spec)).toContain('Environment="XAQ_DATA=/d"');
    expect(renderSystemdUnit(spec)).toContain('Environment="XAQ_SERVICE=1"');
    expect(renderLaunchdPlist(spec)).toContain("<key>XAQ_SERVICE</key><string>1</string>");
    expect(unitDataDir('Environment="AGENTINBOX_DATA=/home/me/.agentinbox"\n')).toBe("/home/me/.agentinbox");
    expect(unitDataDir("<key>AGENTINBOX_DATA</key><string>/Users/me/.agentinbox</string>")).toBe("/Users/me/.agentinbox");
    expect(unitDataDir('Environment="XAQ_DATA=/home/me/.xaq"\n')).toBe("/home/me/.xaq");
  });

});

// ───────────── Data directory ─────────────

/** Every path under `dir` with its bytes (directories as "dir"), to show a foreign tree wasn't touched. */
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        out[p] = `dir ${st.mode} ${st.mtimeMs}`;
        walk(p);
      } else out[p] = `${st.mode} ${st.mtimeMs} ${readFileSync(p, "base64")}`;
    }
  };
  walk(dir);
  return out;
};
/** What the other program called xaq keeps in `dir` (its config: credentials, settings, history, threads). */
const foreignXaq = (dir: string) => {
  mkdirSync(join(dir, "threads"), { recursive: true });
  writeFileSync(join(dir, "auth.json"), '{"provider":"x","token":"not-ours"}\n', { mode: 0o600 });
  writeFileSync(join(dir, "settings.json"), '{"theme":"dark"}\n');
  writeFileSync(join(dir, "state.json"), "{}\n");
  writeFileSync(join(dir, "history.jsonl"), '{"q":"hi"}\n');
  writeFileSync(join(dir, "threads", "t1.json"), "{}\n");
};

describe("data directory: ~/.xaq when ours, an existing ~/.agentinbox, else ~/.xaq", () => {
  const home = () => {
    const h = tmp("xaq-home-");
    withEnv({ HOME: h, XAQ_DATA: undefined, AGENTINBOX_DATA: undefined });
    return h;
  };

  it("a new install uses ~/.xaq", () => {
    const h = home();
    expect(defaultDataDir()).toBe(join(h, ".xaq"));
    expect(loadConfig({}).dataDir).toBe(join(h, ".xaq"));
    expect(dataFiles(join(h, ".xaq")).db).toBe(join(h, ".xaq", "xaq.db"));
  });

  it("an existing ~/.agentinbox stays in use (said once), with its files and master.key where they are", () => {
    const h = home();
    const old = join(h, ".agentinbox");
    mkdirSync(old, { mode: 0o700 });
    writeFileSync(join(old, "agentinbox.db"), "");
    writeFileSync(join(old, "master.key"), "k\n", { mode: 0o600 });
    const said = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const c = loadConfig({});
    expect(c.dataDir).toBe(old);
    expect(c.dbPath).toBe(join(old, "agentinbox.db"));
    expect(c.masterKeyPath).toBe(join(old, "master.key"));
    expect(lockPath(old)).toBe(join(old, "agentinbox.lock"));
    expect(dataFiles(old).log).toBe(join(old, "agentinbox.log"));
    loadConfig({});
    resolveDataDir();
    const notes = said.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("existing data directory"));
    expect(notes).toHaveLength(1); // once per process
    expect(existsSync(join(h, ".xaq"))).toBe(false);
    expect(readFileSync(join(old, "master.key"), "utf8")).toBe("k\n");
  });

  it("a foreign ~/.xaq (another program called xaq) with ~/.agentinbox: agentinbox, and ~/.xaq stays byte-identical", () => {
    const h = home();
    foreignXaq(join(h, ".xaq"));
    const before = snapshot(join(h, ".xaq"));
    mkdirSync(join(h, ".agentinbox"));
    writeFileSync(join(h, ".agentinbox", "agentinbox.db"), "");
    expect(loadConfig({}).dataDir).toBe(join(h, ".agentinbox"));
    expect(snapshot(join(h, ".xaq"))).toEqual(before);
  });

  it("a foreign ~/.xaq alone: our files go in beside its own, which stay untouched (not even its mode)", async () => {
    const h = home();
    foreignXaq(join(h, ".xaq"));
    chmodSync(join(h, ".xaq"), 0o755);
    const before = snapshot(join(h, ".xaq"));
    const c = loadConfig({});
    expect(c.dataDir).toBe(join(h, ".xaq"));
    expect(statSync(join(h, ".xaq")).mode & 0o777).toBe(0o755);
    // Every foreign path is still there, unchanged; whatever is new is ours.
    const after = snapshot(join(h, ".xaq"));
    for (const [p, v] of Object.entries(before)) if (p !== join(h, ".xaq")) expect(after[p]).toBe(v);
    // A foreign service.env or setup-token is never replaced.
    writeFileSync(join(h, ".xaq", "setup-token"), "not a token: the other program's\n");
    const { ensureSetupToken } = await import("../server/auth/setup-token.ts");
    expect(() => ensureSetupToken(c.dataDir)).toThrow(/isn't xaq's setup token, so it was left alone/);
    expect(readFileSync(join(h, ".xaq", "setup-token"), "utf8")).toBe("not a token: the other program's\n");
  });

  it("a ~/.xaq with our files (nightly.71/72) is ours, even next to ~/.agentinbox", () => {
    for (const marker of ["xaq.db", "agentinbox.db", "master.key", "xaq.lock"]) {
      const h = home();
      mkdirSync(join(h, ".agentinbox"));
      mkdirSync(join(h, ".xaq"));
      writeFileSync(join(h, ".xaq", marker), "");
      expect(defaultDataDir()).toBe(join(h, ".xaq"));
    }
  });

  it("--data and the variables always win", () => {
    home();
    expect(resolveDataDir("/srv/x")).toBe("/srv/x");
    withEnv({ AGENTINBOX_DATA: "/srv/old" });
    expect(resolveDataDir()).toBe("/srv/old");
  });
});

describe("skill install never overwrites a xaq skill that isn't ours", () => {
  it("refuses a foreign xaq/SKILL.md and leaves it as it was; replaces our own (marker, or nightly.71/72's description)", () => {
    const dir = tmp("xaq-skills-");
    mkdirSync(join(dir, "xaq"));
    const foreign = "---\nname: xaq\ndescription: The other xaq's own skill.\n---\n# xaq\n";
    writeFileSync(join(dir, "xaq", "SKILL.md"), foreign);
    expect(() => writeSkill(skillPath(dir), renderSkill("http://localhost:8425"))).toThrow(/isn't the xaq-cli skill .*left alone.*--target/);
    expect(readFileSync(join(dir, "xaq", "SKILL.md"), "utf8")).toBe(foreign);
    // Ours: written by this version (marker) or by nightly.71/72 (the description says "formerly agentinbox").
    writeFileSync(join(dir, "xaq", "SKILL.md"), "---\nname: xaq\ndescription: Gmail through a xaq server (formerly agentinbox).\n---\n");
    writeSkill(skillPath(dir), renderSkill("http://localhost:8425"));
    const ours = readFileSync(join(dir, "xaq", "SKILL.md"), "utf8");
    expect(isOurSkill(ours)).toBe(true);
    expect(ours).toContain(SKILL_MARKER);
    writeSkill(skillPath(dir), renderSkill("https://mail.example.com"));
    expect(readFileSync(join(dir, "xaq", "SKILL.md"), "utf8")).toContain("https://mail.example.com/mcp");
  });
});

describe("skill install replaces the agentinbox skill", () => {
  it("removes our old SKILL.md (and its directory), never someone else's", () => {
    const dir = tmp("xaq-skills-");
    writeSkill(skillPath(dir), "---\nname: xaq\n---\n");
    mkdirSync(join(dir, "agentinbox"));
    writeFileSync(join(dir, "agentinbox", "SKILL.md"), "---\nname: agentinbox\ndescription: old\n---\n# agentinbox\n");
    expect(removeLegacySkill(dir)).toBe(join(dir, "agentinbox", "SKILL.md"));
    expect(existsSync(join(dir, "agentinbox"))).toBe(false);
    expect(existsSync(join(dir, "xaq", "SKILL.md"))).toBe(true);
    expect(removeLegacySkill(dir)).toBeNull();
    mkdirSync(join(dir, "agentinbox"));
    writeFileSync(join(dir, "agentinbox", "SKILL.md"), "---\nname: something-else\n---\n");
    expect(removeLegacySkill(dir)).toBeNull();
    expect(existsSync(join(dir, "agentinbox", "SKILL.md"))).toBe(true);
  });
});

// ───────────── Fake service managers ─────────────

const LEGACY_PID = 1111;
const NEW_PID = 4242;

type Fake = ServiceOps & {
  calls: string[];
  /** Times a job started while another one of ours was still loaded / active. */
  overlaps: string[];
  owner: InstanceInfo | null;
};

/** When each job last started (a restarted service is a new lock holder). */
const started = new Map<string, string>();
let starts = 0;

/** Which pid a running job has: anything with "agentinbox" in its name is the old one. */
const pidOf = (name: string) => (name.includes("agentinbox") ? LEGACY_PID : NEW_PID);

/**
 * launchd that knows each label. `bootout` returns at once and the job stays loaded for `lingers` more
 * `print`s; `bootstrap` fails with error 5 while that label is loaded, and for the new labels while
 * `failNew` is set. A loaded daemon job holds the data directory's lock (`owner`).
 */
function fakeLaunchd(unitDir: string, opts: { loaded?: string[]; lingers?: number; failNew?: boolean } = {}): Fake {
  const loaded = new Map<string, number>((opts.loaded ?? []).map((l) => [l, 0]));
  const fail = (stderr: string) => Object.assign(new Error("Command failed: launchctl"), { stderr });
  const syncOwner = () => {
    const daemon = [...loaded.keys()].find((l) => !l.includes(".listen."));
    ops.owner = daemon ? { pid: pidOf(daemon), host: "127.0.0.1", port: 0, startedAt: started.get(daemon) ?? "before", service: true } : null;
  };
  const ops: Fake = {
    platform: "darwin",
    root: false,
    uid: 501,
    user: "me",
    calls: [],
    overlaps: [],
    owner: null,
    unitDir: () => unitDir,
    stage: () => {
      throw new Error("tests pass their own stage");
    },
    waitReady: async () => true,
    instance: () => ops.owner,
    portInUse: async () => false,
    exec(cmd, args) {
      ops.calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "launchctl" && args[0] === "bootout") {
        const label = args[1]!.split("/").pop()!;
        if (!loaded.has(label)) throw fail("Boot-out failed: 3: No such process");
        if (opts.lingers) loaded.set(label, opts.lingers);
        else loaded.delete(label);
        syncOwner();
      }
    },
    capture(cmd, args) {
      ops.calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd !== "launchctl") return "";
      if (args[0] === "print") {
        const label = args[1]!.split("/").pop()!;
        const left = loaded.get(label);
        if (left === undefined) throw fail(`Could not find service "${label}"`);
        if (left > 0) {
          if (left === 1) loaded.delete(label);
          else loaded.set(label, left - 1);
          return "state = stopping\n";
        }
        return `state = running\n\tpid = ${pidOf(label)}\n`;
      }
      if (args[0] === "bootstrap") {
        const label = basename(args[2]!, ".plist");
        if (loaded.has(label)) throw fail("Bootstrap failed: 5: Input/output error");
        if (opts.failNew && !label.includes("agentinbox")) throw fail("Bootstrap failed: 5: Input/output error");
        const kind = label.includes(".listen.") ? label.split(".listen.")[1] : "daemon";
        const others = [...loaded.keys()].filter((l) => (l.includes(".listen.") ? l.split(".listen.")[1] : "daemon") === kind);
        if (others.length) ops.overlaps.push(`${label} started while ${others.join(", ")} was loaded`);
        loaded.set(label, 0);
        started.set(label, `start-${++starts}`);
        syncOwner();
      }
      return "";
    },
  };
  syncOwner();
  return ops;
}

/** systemd that knows each unit: enabled / active, started and stopped by the usual verbs. */
function fakeSystemd(unitDir: string, opts: { active?: string[]; enabled?: string[]; failNew?: boolean } = {}): Fake & { active: Set<string>; enabled: Set<string> } {
  const active = new Set(opts.active ?? []);
  const enabled = new Set(opts.enabled ?? []);
  const syncOwner = () => {
    const daemon = [...active].find((u) => !u.includes("-listen-"));
    ops.owner = daemon ? { pid: pidOf(daemon), host: "127.0.0.1", port: 0, startedAt: started.get(daemon) ?? "before", service: true } : null;
  };
  const start = (unit: string) => {
    if (opts.failNew && !unit.includes("agentinbox")) throw new Error(`Job for ${unit}.service failed`);
    const kind = (u: string) => (u.includes("-listen-") ? u.split("-listen-")[1] : "daemon");
    const others = [...active].filter((u) => u !== unit && kind(u) === kind(unit));
    if (others.length) ops.overlaps.push(`${unit} started while ${others.join(", ")} was active`);
    active.add(unit);
    started.set(unit, `start-${++starts}`);
    syncOwner();
  };
  const word = (stdout: string) => Object.assign(new Error("Command failed: systemctl"), { stdout: `${stdout}\n` });
  const ops: Fake & { active: Set<string>; enabled: Set<string> } = {
    platform: "linux",
    root: false,
    uid: 1000,
    user: "me",
    calls: [],
    overlaps: [],
    owner: null,
    active,
    enabled,
    unitDir: () => unitDir,
    stage: () => {
      throw new Error("tests pass their own stage");
    },
    waitReady: async () => true,
    instance: () => ops.owner,
    portInUse: async () => false,
    exec(cmd, args) {
      ops.calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd !== "systemctl") return;
      const a = args.filter((x) => x !== "--user");
      const unit = a[a.length - 1]!;
      switch (a[0]) {
        case "enable":
          enabled.add(unit);
          if (a.includes("--now")) start(unit);
          break;
        case "disable":
          enabled.delete(unit);
          if (a.includes("--now")) active.delete(unit);
          syncOwner();
          break;
        case "start":
        case "restart":
          active.delete(unit);
          start(unit);
          break;
        case "try-restart":
          if (active.has(unit)) {
            active.delete(unit);
            start(unit);
          }
          break;
      }
    },
    capture(cmd, args) {
      ops.calls.push(`${cmd} ${args.join(" ")}`);
      const a = args.filter((x) => x !== "--user");
      const unit = a[a.length - 1]!;
      if (a[0] === "show") return `${active.has(unit) ? pidOf(unit) : 0}\n`;
      if (a[0] === "is-active") {
        if (!active.has(unit)) throw word("inactive");
        return "active\n";
      }
      if (a[0] === "is-enabled") {
        if (!enabled.has(unit)) throw word("disabled");
        return "enabled\n";
      }
      return "";
    },
  };
  syncOwner();
  return ops;
}

/** Fake npm install of xaq-cli into the staging dir. */
const stageXaq = (staging: string) => {
  mkdirSync(join(staging, "node_modules/xaq-cli/dist"), { recursive: true });
  writeFileSync(join(staging, "node_modules/xaq-cli/dist/cli.js"), "// xaq\n");
  return staging;
};
/** What an agentinbox service install left in `<dir>/app`. */
const oldApp = (app: string) => {
  mkdirSync(join(app, "node_modules/agentinbox-cli/dist"), { recursive: true });
  writeFileSync(join(app, "node_modules/agentinbox-cli/dist/cli.js"), "// agentinbox\n");
};

// ───────────── Daemon service migration ─────────────

const OLD_PLIST = "com.unlaboredlabs.agentinbox.plist";
const NEW_PLIST = "sh.xaq.daemon.plist";

describe("service install: an agentinbox service moves to xaq", () => {
  const setup = (platform: "darwin" | "linux") => {
    quiet();
    const config = testConfig();
    cleanup.push(() => rmSync(config.dataDir, { recursive: true, force: true }));
    const units = join(config.dataDir, "units");
    mkdirSync(units);
    const oldFile = join(units, platform === "darwin" ? OLD_PLIST : "agentinbox.service");
    const oldText =
      platform === "darwin"
        ? `<plist><dict><key>Label</key><string>com.unlaboredlabs.agentinbox</string><key>AGENTINBOX_DATA</key><string>${config.dataDir}</string><key>PORT</key><string>9425</string><key>HOST</key><string>127.0.0.1</string></dict></plist>\n`
        : `[Service]\nExecStart="/n" "${config.dataDir}/app/node_modules/agentinbox-cli/dist/cli.js" start --no-open\nEnvironment="AGENTINBOX_DATA=${config.dataDir}"\nEnvironment="PORT=9425"\nEnvironment="HOST=127.0.0.1"\n`;
    writeFileSync(oldFile, oldText, { mode: platform === "darwin" ? 0o600 : 0o644 });
    oldApp(join(config.dataDir, "app"));
    writeFileSync(join(config.dataDir, "service.env"), `AGENTINBOX_MASTER_KEY=${Buffer.alloc(32, 3).toString("base64")}\n`, { mode: 0o600 });
    return { config, units, oldFile, oldText };
  };
  const stageInto = (ops: Fake) => {
    ops.stage = (dataDir) => stageXaq(join(dataDir, "app.new"));
  };

  it("launchd: the old job is booted out and gone before the new one is bootstrapped; its plist is removed; data and key carry over", async () => {
    const { config, units, oldFile } = setup("darwin");
    const ops = fakeLaunchd(units, { loaded: ["com.unlaboredlabs.agentinbox"], lingers: 3 });
    stageInto(ops);
    expect(legacyDaemonUnit(ops)?.dataDir).toBe(config.dataDir);
    await installService(config, ops, { launchdPollMs: 1 });
    expect(ops.overlaps).toEqual([]);
    const bootout = ops.calls.indexOf("launchctl bootout gui/501/com.unlaboredlabs.agentinbox");
    const bootstrap = ops.calls.findIndex((c) => c.startsWith("launchctl bootstrap"));
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeGreaterThan(bootout);
    // Polled until launchd no longer listed the old job.
    expect(ops.calls.slice(bootout, bootstrap).filter((c) => c === "launchctl print gui/501/com.unlaboredlabs.agentinbox").length).toBeGreaterThanOrEqual(3);
    expect(existsSync(oldFile)).toBe(false);
    const plist = readFileSync(join(units, NEW_PLIST), "utf8");
    expect(plist).toContain("<string>sh.xaq.daemon</string>");
    expect(plist).toContain(`<key>XAQ_DATA</key><string>${config.dataDir}</string>`);
    expect(plist).toContain(`<key>XAQ_MASTER_KEY</key>`);
    expect(readFileSync(join(config.dataDir, "service.env"), "utf8")).toMatch(/^XAQ_MASTER_KEY=/);
    expect(existsSync(join(config.dataDir, "app/node_modules/xaq-cli/dist/cli.js"))).toBe(true);
    expect(existsSync(join(config.dataDir, "app.old"))).toBe(false);
    expect(ops.owner?.pid).toBe(NEW_PID);
  });

  it("launchd: when the new service fails, the old one comes back exactly as it was (plist, app, service.env, running)", async () => {
    const { config, units, oldFile, oldText } = setup("darwin");
    const env = readFileSync(join(config.dataDir, "service.env"), "utf8");
    const ops = fakeLaunchd(units, { loaded: ["com.unlaboredlabs.agentinbox"], failNew: true });
    stageInto(ops);
    await expect(installService(config, ops, { launchdPollMs: 1 })).rejects.toThrow(/Rolled back to the agentinbox service as it was/);
    expect(readFileSync(oldFile, "utf8")).toBe(oldText);
    expect(existsSync(join(units, NEW_PLIST))).toBe(false);
    expect(readFileSync(join(config.dataDir, "app/node_modules/agentinbox-cli/dist/cli.js"), "utf8")).toBe("// agentinbox\n");
    expect(readFileSync(join(config.dataDir, "service.env"), "utf8")).toBe(env);
    expect(ops.owner?.pid).toBe(LEGACY_PID);
    expect(ops.overlaps).toEqual([]);
  });

  it("launchd: a new job that never answers is unloaded completely before the old one is bootstrapped again", async () => {
    const { config, units, oldFile, oldText } = setup("darwin");
    const ops = fakeLaunchd(units, { loaded: ["com.unlaboredlabs.agentinbox"], lingers: 2 });
    stageInto(ops);
    ops.waitReady = async () => false;
    await expect(installService(config, ops, { launchdPollMs: 1 })).rejects.toThrow(/did not answer on port .*Rolled back to the agentinbox service as it was/s);
    expect(ops.overlaps).toEqual([]);
    expect(readFileSync(oldFile, "utf8")).toBe(oldText);
    expect(existsSync(join(units, NEW_PLIST))).toBe(false);
    expect(ops.owner?.pid).toBe(LEGACY_PID);
  });

  it("launchd: a second run is a plain reinstall (nothing of agentinbox left to touch)", async () => {
    const { config, units, oldFile } = setup("darwin");
    const ops = fakeLaunchd(units, { loaded: ["com.unlaboredlabs.agentinbox"] });
    stageInto(ops);
    await installService(config, ops, { launchdPollMs: 1 });
    const first = readFileSync(join(units, NEW_PLIST), "utf8");
    ops.calls.length = 0;
    await installService(config, ops, { launchdPollMs: 1 });
    expect(ops.calls.some((c) => c.includes("com.unlaboredlabs.agentinbox") && !c.startsWith("launchctl print"))).toBe(false);
    expect(readFileSync(join(units, NEW_PLIST), "utf8")).toBe(first);
    expect(existsSync(oldFile)).toBe(false);
    expect(ops.owner?.pid).toBe(NEW_PID);
    expect(ops.overlaps).toEqual([]);
  });

  it("systemd: the old unit is stopped and disabled before the new one starts, and its file removed", async () => {
    const { config, units, oldFile } = setup("linux");
    const ops = fakeSystemd(units, { active: ["agentinbox"], enabled: ["agentinbox"] });
    stageInto(ops);
    await installService(config, ops);
    expect(ops.overlaps).toEqual([]);
    expect(ops.calls.indexOf("systemctl --user disable --now agentinbox")).toBeLessThan(ops.calls.indexOf("systemctl --user enable --now xaq"));
    expect(existsSync(oldFile)).toBe(false);
    expect(readFileSync(join(units, "xaq.service"), "utf8")).toContain(`Environment="XAQ_DATA=${config.dataDir}"`);
    expect([...ops.active]).toEqual(["xaq"]);
    expect([...ops.enabled]).toEqual(["xaq"]);
  });

  it("systemd: on failure the old unit is restored, enabled and running again, and the new one removed", async () => {
    const { config, units, oldFile, oldText } = setup("linux");
    const ops = fakeSystemd(units, { active: ["agentinbox"], enabled: ["agentinbox"], failNew: true });
    stageInto(ops);
    await expect(installService(config, ops)).rejects.toThrow(/Rolled back to the agentinbox service as it was/);
    expect(readFileSync(oldFile, "utf8")).toBe(oldText);
    expect(existsSync(join(units, "xaq.service"))).toBe(false);
    expect([...ops.active]).toEqual(["agentinbox"]);
    expect([...ops.enabled]).toEqual(["agentinbox"]);
    expect(readFileSync(join(config.dataDir, "app/node_modules/agentinbox-cli/dist/cli.js"), "utf8")).toBe("// agentinbox\n");
  });

  it("systemd: an old unit that was stopped and disabled is put back stopped and disabled", async () => {
    const { config, units, oldFile, oldText } = setup("linux");
    const ops = fakeSystemd(units, { failNew: true });
    stageInto(ops);
    await expect(installService(config, ops)).rejects.toThrow(/Rolled back to the agentinbox service as it was/);
    expect(readFileSync(oldFile, "utf8")).toBe(oldText);
    expect(ops.active.size).toBe(0);
    expect(ops.enabled.size).toBe(0);
  });

  it("keeps the old service's data directory, port and host unless the command line or environment says otherwise", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { config, units } = setup(platform);
      const ops = platform === "darwin" ? fakeLaunchd(units) : fakeSystemd(units);
      expect(serviceInstallInput({}, ops, {})).toEqual({ dataDir: config.dataDir, port: 9425, host: "127.0.0.1" });
      expect(serviceInstallInput({ port: 8000, host: "0.0.0.0", dataDir: "/srv/x" }, ops, {})).toEqual({ dataDir: "/srv/x", port: 8000, host: "0.0.0.0" });
      // PORT / HOST / XAQ_DATA in the environment count as given (loadConfig reads them).
      expect(serviceInstallInput({}, ops, { HOST: "::1", PORT: "7000", XAQ_DATA: "/srv/y" })).toEqual({ dataDir: "/srv/y", port: undefined, host: undefined });
    }
  });

  it("the new unit binds where the old one did: a 127.0.0.1 service doesn't widen to 0.0.0.0 on upgrade", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { config, units } = setup(platform);
      const ops = platform === "darwin" ? fakeLaunchd(units, { loaded: ["com.unlaboredlabs.agentinbox"] }) : fakeSystemd(units, { active: ["agentinbox"], enabled: ["agentinbox"] });
      stageInto(ops);
      const input = serviceInstallInput({}, ops, {});
      await installService({ ...config, port: input.port!, host: input.host! }, ops, { launchdPollMs: 1 });
      const text = readFileSync(join(units, platform === "darwin" ? NEW_PLIST : "xaq.service"), "utf8");
      if (platform === "darwin") {
        expect(text).toContain("<key>HOST</key><string>127.0.0.1</string>");
        expect(text).toContain("<key>PORT</key><string>9425</string>");
      } else {
        expect(text).toContain('Environment="HOST=127.0.0.1"');
        expect(text).toContain('Environment="PORT=9425"');
      }
    }
  });

  it("service.env keeps the key under both names, so going back to agentinbox-cli by hand still starts", async () => {
    const { config, units } = setup("darwin");
    const key = Buffer.alloc(32, 3).toString("base64");
    const ops = fakeLaunchd(units, { loaded: ["com.unlaboredlabs.agentinbox"] });
    stageInto(ops);
    await installService(config, ops, { launchdPollMs: 1 });
    const env = parseEnvFile(readFileSync(join(config.dataDir, "service.env"), "utf8"));
    expect(env).toEqual({ XAQ_MASTER_KEY: key, AGENTINBOX_MASTER_KEY: key });
    // A reinstall reads it back without piling up or diverging.
    await installService(config, ops, { launchdPollMs: 1 });
    expect(readFileSync(join(config.dataDir, "service.env"), "utf8")).toBe(`XAQ_MASTER_KEY=${key}\nAGENTINBOX_MASTER_KEY=${key}\n`);
  });

  it("systemd: a second run is a plain reinstall", async () => {
    const { config, units } = setup("linux");
    const ops = fakeSystemd(units, { active: ["agentinbox"], enabled: ["agentinbox"] });
    stageInto(ops);
    await installService(config, ops);
    ops.calls.length = 0;
    await installService(config, ops);
    expect(ops.calls.filter((c) => c.includes("agentinbox"))).toEqual([]);
    expect([...ops.active]).toEqual(["xaq"]);
    expect(ops.overlaps).toEqual([]);
  });

  it("status and uninstall find a service still under the old name", async () => {
    const { config, units, oldFile } = setup("linux");
    const ops = fakeSystemd(units, { active: ["agentinbox"], enabled: ["agentinbox"] });
    serviceStatus(ops);
    expect(ops.calls).toContain("systemctl --user status agentinbox --no-pager");
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toMatch(/from before the rename to xaq \(agentinbox\)/);
    process.exitCode = 0;
    uninstallService({ dataDir: "/wrong" }, ops);
    expect(existsSync(oldFile)).toBe(false);
    expect(ops.active.size).toBe(0);
    // Its own install goes too; the data stays.
    expect(existsSync(join(config.dataDir, "app"))).toBe(false);
    expect(existsSync(join(config.dataDir, "service.env"))).toBe(true);
  });
});

// ───────────── The old package and old entry points ─────────────

describe("agentinbox-cli shim and the old entry point", () => {
  /** A node_modules with a stub xaq-cli whose CLI prints its arguments and the flag the shim sets. */
  const stubXaq = (root: string) => {
    mkdirSync(join(root, "node_modules/xaq-cli/dist"), { recursive: true });
    writeFileSync(join(root, "node_modules/xaq-cli/package.json"), JSON.stringify({ name: "xaq-cli", version: "0.1.0-nightly.99", type: "module" }));
    writeFileSync(
      join(root, "node_modules/xaq-cli/dist/cli.js"),
      "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), shim: !!globalThis.__xaqShimNotice, pid: process.pid }));\n",
    );
  };

  it("says agentinbox is now xaq, then runs xaq-cli in the same process with the same arguments", () => {
    const root = tmp("xaq-shim-");
    stubXaq(root);
    cpSync(join(ROOT, "shim/agentinbox-cli"), join(root, "node_modules/agentinbox-cli"), { recursive: true });
    const shim = join(root, "node_modules/agentinbox-cli/dist/cli.js");
    const r = spawnSync(process.execPath, [shim, "listen", "--profile", "work"], { encoding: "utf8", env: { ...process.env, XAQ_SERVICE: "", AGENTINBOX_SERVICE: "" } });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ args: ["listen", "--profile", "work"], shim: true });
    // The notice goes to stderr, never into stdout (which may be a piped secret).
    expect(r.stderr).toContain("agentinbox is now xaq: use `npx xaq-cli …`");
    // Under a service (an old unit running the shim) it stays quiet.
    const svc = spawnSync(process.execPath, [shim, "start"], { encoding: "utf8", env: { ...process.env, XAQ_SERVICE: "", AGENTINBOX_SERVICE: "1" } });
    expect(svc.stderr).toBe("");
    const pkg = JSON.parse(readFileSync(join(ROOT, "shim/agentinbox-cli/package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "agentinbox-cli", bin: { agentinbox: "dist/cli.js" }, dependencies: { "xaq-cli": expect.any(String) } });
  });

  it("xaq-cli has only the xaq bin: the agentinbox bin belongs to the shim (no EEXIST next to a global agentinbox-cli)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.name).toBe("xaq-cli");
    expect(pkg.bin).toEqual({ xaq: "dist/cli.js" });
  });
});
