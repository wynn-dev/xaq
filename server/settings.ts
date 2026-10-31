import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { GoogleAppType, GoogleClientCheck as ClientCheck, IngestMode, PubsubState, Settings } from "../shared/types.ts";
import { publicUrlProblem } from "../shared/public-url.ts";
import type { Bus } from "./bus.ts";
import type { Config } from "./config.ts";
import { type Db, json } from "./db/index.ts";
import { badRequest, HttpError } from "./util/errors.ts";
import { ownDirs, protectedPaths, within } from "./util/own-dirs.ts";

/**
 * Internal key/value state kept in the `settings` table next to the user-facing Settings.
 * Owners: google.* and pubsub → server/google, admin.* → server/auth, calendar.* → server/calendar.
 */
export interface InternalState {
  "google.client": {
    clientId: string;
    /** AES-GCM ciphertext (ctx.crypto). */
    clientSecretEnc: string | null;
    projectId: string;
    /** null: imported from a client JSON without choosing the app type yet. */
    appType: GoogleAppType | null;
    /** redirect_uris listed in the last imported client JSON (absent after manual entry). */
    importedRedirectUris?: string[];
    /**
     * Redirect URI in effect when the client was last saved or imported: presumably the one registered
     * on it. A later public URL change makes it differ (SetupWarning redirect_uri_changed).
     */
    savedRedirectUri?: string;
    /** Redirect URI of the last successful account connection: proves it is registered on the client. */
    verifiedRedirectUri?: string | null;
    /** Last 4 characters of the secret, for display (GoogleClientView.secretHint). */
    secretHint?: string;
    /** Result of the last client check (server/google/check.ts) for this exact client ID + secret; dropped on save. */
    check?: { clientId: ClientCheck["clientId"]; redirectUri: ClientCheck["redirectUri"]; secret: ClientCheck["secret"]; redirectUriTested: string; at: string };
  };
  /** Pub/Sub resources and health. `mode` is not stored here: it is Settings.ingestMode. */
  pubsub: Omit<PubsubState, "mode" | "principalAccountId" | "principalEmail" | "pendingPrincipalAccountId" | "pendingPrincipalEmail"> & {
    /** Account whose OAuth token pulls the subscription (it provisioned successfully; needs IAM on the project). */
    principalAccountId: string | null;
    /** Account chosen to provision with that hasn't succeeded yet (becomes principalAccountId on success). */
    pendingPrincipalAccountId?: string | null;
  };
  /**
   * Google Calendar for this install (CalendarSetupState). No row = enabled (fresh install); migration 7
   * writes {enabled:false} on installs that had accounts before the upgrade.
   */
  "calendar.setup": {
    enabled: boolean;
    /** When the operator hid the calendar_not_added notice. */
    dismissedAt?: string | null;
    /** Last observation of the Calendar API in the project (CalendarSetupState.api). */
    api?: {
      state: "enabled" | "disabled";
      at: string;
      error?: string | null;
      /** ErrorInfo metadata.activationUrl from Google's SERVICE_DISABLED answer (names the right project). */
      activationUrl?: string | null;
    };
  };
  /**
   * MCP broker policy limits (server/broker/policy). Missing fields take the defaults in
   * server/broker/policy/store.ts (BROKER_POLICY_DEFAULTS). null caps = no cap.
   */
  "broker.policy": {
    /** mcp.call approvals expire after this many hours. */
    approvalTtlHours?: number;
    /** Per agent, risky tool calls (run, queued or of unknown outcome) per rolling hour / 24 hours. */
    riskyPerHour?: number | null;
    riskyPerDay?: number | null;
  };
  "admin.passwordHash": string;
  /** When SetupState.verified first had evidence; kept so pruning the audit log doesn't undo it. */
  "setup.verifiedAt": string;
}

export type InternalKey = keyof InternalState;

const USER_KEY = "settings";

export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
    private readonly config: Config,
  ) {}

  defaults(): Settings {
    return {
      publicUrl: defaultPublicUrl(this.config.host, this.config.port),
      ingestMode: "poll",
      pollIntervalSeconds: 30,
      maxBodyChars: 20_000,
      retentionDays: 30,
      approvalTtlHours: 72,
      webhookAllowlist: ["localhost", "127.0.0.0/8", "::1"],
      pairingEnabled: true,
      calendarPollSeconds: 60,
      attachmentSaveDir: "",
      attachmentDirs: [],
    };
  }

  get(): Settings {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", USER_KEY);
    return { ...this.defaults(), ...json.parse<Partial<Settings>>(row?.value, {}) };
  }

  /** Validates, persists and broadcasts. Throws HttpError(400) on invalid input. */
  update(patch: Partial<Settings>): Settings {
    const before = this.get();
    const next = validate({ ...before, ...stripUndefined(patch) });
    // Directories added now must exist and be xaq's to share (ones saved earlier may be gone, e.g. an unmounted disk).
    for (const dir of next.attachmentDirs.filter((d) => !before.attachmentDirs.includes(d))) checkNewAttachmentDir(dir, this.config.dataDir);
    this.write(USER_KEY, next);
    this.bus.emit("settings", next);
    return next;
  }

  /** The OAuth redirect URI and MCP snippets are derived from this. Never has a trailing slash. */
  publicUrl(): string {
    return this.get().publicUrl;
  }

  getState<K extends InternalKey>(key: K): InternalState[K] | null {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return row ? json.parse<InternalState[K] | null>(row.value, null) : null;
  }

  setState<K extends InternalKey>(key: K, value: InternalState[K]): void {
    this.write(key, value);
  }

  deleteState(key: InternalKey): void {
    this.db.run("DELETE FROM settings WHERE key = ?", key);
  }

  private write(key: string, value: unknown): void {
    this.db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      json.str(value),
    );
  }
}

const INGEST_MODES: IngestMode[] = ["pubsub", "poll"];

function validate(s: Settings): Settings {
  const problem = publicUrlProblem(s.publicUrl);
  if (problem) throw badRequest(`Public URL: ${problem}`);
  const url = new URL(s.publicUrl.trim());
  const int = (v: number, name: string, min: number, max: number) => {
    if (!Number.isInteger(v) || v < min || v > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}`);
    return v;
  };
  if (!INGEST_MODES.includes(s.ingestMode)) throw badRequest("Ingest mode must be pubsub or poll");
  const allowlist = Array.isArray(s.webhookAllowlist) ? s.webhookAllowlist.map((h) => String(h).trim()).filter(Boolean) : null;
  if (!allowlist || allowlist.length > 100 || allowlist.some((h) => h.length > 253 || /\s/.test(h))) {
    throw badRequest("Webhook allowlist must be a list of hostnames, IPs or CIDRs");
  }
  const saveDir = typeof s.attachmentSaveDir === "string" ? s.attachmentSaveDir.trim() : "";
  if (saveDir && (!isAbsolute(saveDir) || saveDir.length > 1024 || saveDir.includes("\0"))) {
    throw badRequest("Attachment folder must be an absolute path", "For example /home/me/xaq-attachments; leave it empty for the default inside the data directory");
  }
  return {
    publicUrl: url.origin + url.pathname.replace(/\/+$/, ""),
    ingestMode: s.ingestMode,
    pollIntervalSeconds: int(s.pollIntervalSeconds, "Poll interval", 5, 3600),
    maxBodyChars: int(s.maxBodyChars, "Max body characters", 0, 1_000_000),
    retentionDays: int(s.retentionDays, "Retention", 1, 3650),
    approvalTtlHours: int(s.approvalTtlHours, "Approval expiry", 1, 24 * 30),
    webhookAllowlist: [...new Set(allowlist)],
    pairingEnabled: s.pairingEnabled !== false,
    calendarPollSeconds: int(s.calendarPollSeconds, "Calendar poll interval", 15, 3600),
    attachmentSaveDir: saveDir ? resolve(saveDir) : "",
    attachmentDirs: attachmentDirs(s.attachmentDirs),
  };
}

/** At most this many attachment directories. */
const MAX_ATTACHMENT_DIRS = 50;

/** Settings.attachmentDirs: absolute paths, normalised (no trailing slash, no ".."), without duplicates. */
function attachmentDirs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_DIRS) {
    throw badRequest(`Attachment directories must be a list of at most ${MAX_ATTACHMENT_DIRS} absolute paths`);
  }
  const out: string[] = [];
  for (const raw of value) {
    const dir = typeof raw === "string" ? raw.trim() : "";
    // oxlint-disable-next-line no-control-regex -- refusing control characters is the point here
    if (!dir || dir.length > 4096 || /[\u0000-\u001f\u007f]/.test(dir) || !isAbsolute(dir)) {
      throw badRequest(`"${String(raw).slice(0, 200)}" isn't an absolute directory path`, "Use a full path such as /home/me/Documents/outgoing.");
    }
    const norm = resolve(dir);
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

const NARROWER = "Pick a narrower folder, for example ~/Documents/xaq-outbox.";

/**
 * A directory being added to attachmentDirs: it exists and is a directory; it isn't, and doesn't contain, your home
 * directory or /; and it isn't, doesn't contain and isn't inside xaq's own directories or a place xaq writes secrets
 * into or that holds credentials (server/util/own-dirs.ts). Checked as given and as its real path.
 */
function checkNewAttachmentDir(dir: string, dataDir: string): void {
  let real: string;
  try {
    real = realpathSync(dir);
    if (!statSync(real).isDirectory()) throw badRequest(`${dir} isn't a directory`);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest(`${dir} doesn't exist (or xaq can't open it)`, "Create it first, as the user xaq runs as.");
  }
  const forms = [...new Set([resolve(dir), real])];
  const formsOf = (p: string) => {
    try {
      return [resolve(p), realpathSync(p)];
    } catch {
      return [resolve(p)];
    }
  };
  const contains = (target: string) => formsOf(target).some((t) => forms.some((f) => within(f, t)));
  const inside = (target: string) => formsOf(target).some((t) => forms.some((f) => within(t, f)));
  if (forms.includes("/") || contains(homedir())) {
    throw badRequest(`${dir} is too broad: it ${forms.includes("/") ? "is the root directory" : "is or contains your home directory"}, with xaq's keys and other credentials in it`, NARROWER);
  }
  const own = ownDirs(dataDir).find((d) => contains(d) || inside(d));
  if (own) throw badRequest(`${dir} is, contains or is inside xaq's own directory ${own}, which holds its keys, database and agent keys`, NARROWER);
  const p = protectedPaths(dataDir);
  const secret = p.dirs.find((d) => contains(d) || inside(d)) ?? p.files.find((f) => contains(f));
  if (secret) throw badRequest(`${dir} is, contains or is inside ${secret}, where credentials, service definitions or agent keys are kept`, NARROWER);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * localhost when bound to all interfaces or to 127.0.0.1/::1 (Google accepts http://localhost redirects);
 * otherwise the specific address or name the operator chose with --host.
 */
export function defaultPublicUrl(host: string, port: number): string {
  const h = host.trim().toLowerCase();
  const local = !h || h === "0.0.0.0" || h === "::" || h === "localhost" || h === "::1" || h === "127.0.0.1";
  if (local) return `http://localhost:${port}`;
  return `http://${h.includes(":") ? `[${h}]` : h}:${port}`;
}
