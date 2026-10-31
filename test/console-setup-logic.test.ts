// The console's setup-wizard logic that must agree with the server: the address verdicts (Google
// callback mode, agent transport rule), project IDs and the Cloud Shell command, the SSH tunnel
// command, and where long commands may wrap.
import { describe, expect, it } from "vitest";
import { CALENDAR_API_SERVICE, enableCalendarApiUrl } from "../server/google/calendar.ts";
import { callbackMode } from "../server/google/client.ts";
import { CALENDAR_SCOPES, GMAIL_SCOPE } from "../server/google/scopes.ts";
import { checkTransport } from "../server/listen/transport.ts";
import { cloudUrl, generateProjectId, PROJECT_ID_RE, projectCommand, projectIdProblem, SCOPES } from "../src/lib/gcp-project.ts";
import { answerApplies, CHECK_NOTES, checkAgainStep, handsBack, listMatch, offersMailOnly, streamUpdateConcerns } from "../src/components/accounts/connect-attempt.ts";
import { analyzeUrl, localConsoleUrl, loopbackTwin, urlVerdict } from "../src/lib/public-url.ts";
import { tunnelCommand } from "../src/lib/tunnel.ts";
import { wrapParts } from "../src/lib/wrap.ts";

// What names resolve to on the agent's machine (only *.localhost and *.ts.net are resolved by the CLI).
const resolve = async (host: string) => (host.endsWith(".localhost") ? ["127.0.0.1"] : host.endsWith(".ts.net") ? ["100.101.102.103"] : []);

const serverCallback = (publicUrl: string) =>
  callbackMode({ settings: { publicUrl: () => publicUrl }, config: { port: 8425 } } as unknown as Parameters<typeof callbackMode>[0]).mode;

const serverTransport = async (url: string) => (await checkTransport(url, { insecure: true, resolve })).kind;

describe("address verdicts match the server", () => {
  // url, host kind, Google sign-in verdict, agent transport
  const table: [string, string, "direct" | "paste" | "rejected", string][] = [
    ["http://localhost:8425", "loopback", "direct", "loopback"],
    ["http://127.0.0.1:8425", "loopback", "direct", "loopback"],
    ["http://[::1]:8425", "loopback", "direct", "loopback"],
    ["http://127.0.0.2:8425", "loopback", "paste", "loopback"],
    ["http://inbox.localhost:8425", "loopback", "paste", "loopback"],
    ["https://localhost:8443", "loopback", "direct", "https"],
    ["https://127.0.0.1:8443", "loopback", "direct", "https"],
    ["https://inbox.localhost", "loopback", "rejected", "https"],
    ["http://100.101.102.103:8425", "tailscale", "paste", "tailscale"],
    ["https://100.101.102.103:8425", "tailscale", "rejected", "https"],
    ["http://box.tail1234.ts.net:8425", "public-name", "paste", "tailscale"],
    ["https://box.tail1234.ts.net", "public-name", "direct", "https"],
    ["http://192.168.1.20:8425", "ip", "paste", "insecure"],
    ["https://192.168.1.20:8443", "ip", "rejected", "https"],
    ["https://xaq.home.lan", "private-name", "rejected", "https"],
    ["https://nas.local", "private-name", "rejected", "https"],
    ["http://nas.local:8425", "private-name", "paste", "insecure"],
    ["https://mail.example.com", "public-name", "direct", "https"],
    ["http://mail.example.com", "public-name", "paste", "insecure"],
  ];

  it.each(table)("%s", async (url, host, google, transport) => {
    const a = analyzeUrl(url)!;
    expect(a.host).toBe(host);
    expect(a.google).toBe(google);
    expect(a.transport).toBe(transport);
    // Agents: the CLI's own rule.
    expect(await serverTransport(url)).toBe(transport);
    // Google: "paste" exactly when the server uses paste mode; https is direct on the server (Google itself refuses some).
    expect(serverCallback(url)).toBe(google === "paste" ? "paste" : "direct");
  });

  it("only warns about agents when the CLI would need --insecure", () => {
    for (const [url, , , transport] of table) {
      const [tone] = urlVerdict(analyzeUrl(url)!, false).agents;
      expect(tone === "warn", url).toBe(transport === "insecure");
    }
  });

  it("says Google sign-in won't work for localhost seen from another machine", () => {
    expect(urlVerdict(analyzeUrl("http://localhost:8425")!, true).google[0]).toBe("bad");
    expect(urlVerdict(analyzeUrl("http://localhost:8425")!, false).google[0]).toBe("good");
    expect(urlVerdict(analyzeUrl("https://mail.example.com")!, true).google[0]).toBe("good");
  });

  it("recommends the loopback origin the browser is on for \"All on this computer\", not another hostname", () => {
    // Opened from the CLI's link when bound to --host 127.0.0.1: stay there (the session cookie is 127.0.0.1's).
    expect(localConsoleUrl("http://127.0.0.1:8425", "8425")).toEqual({ url: "http://127.0.0.1:8425", fromBrowser: true });
    expect(localConsoleUrl("http://localhost:8425", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: true });
    expect(localConsoleUrl("http://[::1]:8425", "8425")).toEqual({ url: "http://[::1]:8425", fromBrowser: true });
    expect(localConsoleUrl("https://localhost:8443", "8443")).toEqual({ url: "https://localhost:8443", fromBrowser: true });
    // Each of those is a direct callback on the server too.
    for (const o of ["http://127.0.0.1:8425", "http://localhost:8425", "http://[::1]:8425"]) expect(serverCallback(localConsoleUrl(o, "8425").url)).toBe("direct");
    // A loopback origin on another port is an SSH tunnel's (or a proxy's) local port, not the server's.
    expect(localConsoleUrl("http://localhost:18425", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: false });
    expect(localConsoleUrl("http://127.0.0.1:9000", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: false });
    expect(localConsoleUrl("https://localhost:8443", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: false });
    // Loopback names the server doesn't call back to directly, and remote browsers: localhost on the server's port.
    expect(localConsoleUrl("http://127.0.0.2:8425", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: false });
    expect(localConsoleUrl("http://inbox.localhost:8425", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: false });
    expect(localConsoleUrl("http://192.168.1.20:8425", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: false });
    expect(localConsoleUrl("https://mail.example.com", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: false });
  });

  it("spots the console open under another loopback name than the saved address (localhost vs 127.0.0.1)", () => {
    expect(loopbackTwin("http://localhost:8425", "http://127.0.0.1:8425")).toBe("http://127.0.0.1:8425");
    expect(loopbackTwin("http://127.0.0.1:8425", "http://localhost:8425/")).toBe("http://localhost:8425");
    expect(loopbackTwin("http://[::1]:8425", "http://localhost:8425")).toBe("http://localhost:8425");
    // Same origin, another port (a tunnel), another scheme, or not this computer: nothing to say.
    expect(loopbackTwin("http://localhost:8425", "http://localhost:8425")).toBeNull();
    expect(loopbackTwin("http://localhost:18425", "http://127.0.0.1:8425")).toBeNull();
    expect(loopbackTwin("https://localhost:8425", "http://127.0.0.1:8425")).toBeNull();
    expect(loopbackTwin("http://localhost:8425", "https://mail.example.com")).toBeNull();
    expect(loopbackTwin("http://192.168.1.20:8425", "http://127.0.0.1:8425")).toBeNull();
  });

  it("rejects what isn't an http(s) URL", () => {
    expect(analyzeUrl("ftp://example.com")).toBeNull();
    expect(analyzeUrl("not a url")).toBeNull();
  });
});

describe("project IDs", () => {
  it.each([
    ["xaq-123456", null],
    ["my-project", null],
    ["", /Enter/],
    ["471203994812", /project number/],
    ["My Project", /project name/],
    ["Xaq", /project name/],
    ["abc", /6 to 30/],
    ["a".repeat(31), /6 to 30/],
    ["1xaq-mail", /lowercase letter/],
    ["xaq-mail-", /hyphen/],
    ["agent_inbox", /only lowercase/],
  ] as const)("%j", (id, problem) => {
    const p = projectIdProblem(id);
    if (problem === null) expect(p).toBeNull();
    else expect(p).toMatch(problem);
    expect(PROJECT_ID_RE.test(id)).toBe(problem === null);
  });

  it("suggests valid, distinct IDs", () => {
    const ids = new Set(Array.from({ length: 20 }, generateProjectId));
    for (const id of ids) expect(id).toMatch(/^xaq-\d{6}$/);
    expect(ids.size).toBeGreaterThan(15);
  });

  it("builds the Cloud Shell command only for a valid ID", () => {
    expect(projectCommand("xaq-123456", false)).toBe(
      "gcloud projects create xaq-123456 --name=xaq && " +
        "gcloud services enable gmail.googleapis.com calendar-json.googleapis.com --project=xaq-123456 && " +
        'echo "xaq: project xaq-123456 is ready"',
    );
    expect(projectCommand("xaq-123456", true)).toContain(
      `--organization="$(gcloud organizations list --format='value(name.basename())' --limit=1)"`,
    );
    for (const bad of ["", "x; rm -rf ~", "xaq-1 && curl evil", "$(id)", "My Project"]) expect(projectCommand(bad, false)).toBeNull();
  });

  it("links to enabling the Gmail API", () => {
    expect(cloudUrl.enableGmail("xaq-123456")).toBe("https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com&project=xaq-123456");
  });

  it("enables the Calendar API under its service name, matching the server's link and command", () => {
    expect(projectCommand("xaq-123456", false)).toContain(`${CALENDAR_API_SERVICE} --project=xaq-123456`);
    expect(cloudUrl.enableCalendar("xaq-123456")).toBe(enableCalendarApiUrl("xaq-123456"));
    expect(cloudUrl.enableCalendar("xaq-123456")).toBe(
      "https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com&project=xaq-123456",
    );
  });
});

describe("scopes listed in the wizard", () => {
  it("are the ones the server asks Google for", () => {
    expect(SCOPES.gmail).toBe(GMAIL_SCOPE);
    expect([...SCOPES.calendar]).toEqual([...CALENDAR_SCOPES]);
  });
});

describe("SSH tunnel command (mirrors server tunnelCommand's forward target)", () => {
  it.each([
    // bound to all interfaces: forward to localhost
    [["http://localhost:8425", "http://192.168.1.20:8425"], "192.168.1.20", "ssh -N -L 8425:localhost:8425 you@192.168.1.20"],
    // bound to loopback only
    [["http://127.0.0.1:8425"], "box.lan", "ssh -N -L 8425:localhost:8425 you@box.lan"],
    // bound to one specific address: forward to it
    [["http://10.0.0.5:8425"], "10.0.0.5", "ssh -N -L 8425:10.0.0.5:8425 you@10.0.0.5"],
    // IPv6: brackets stripped from the SSH host, kept (quoted) in the forward
    [["http://[fd00::5]:8425"], "[fd00::5]", "ssh -N -L '8425:[fd00::5]:8425' you@fd00::5"],
    // browsing on localhost (e.g. through a tunnel already): placeholder host
    [["http://localhost:8425"], "localhost", "ssh -N -L 8425:localhost:8425 you@your-server"],
    // odd characters are quoted for the shell
    [["http://localhost:8425"], "a b;c", "ssh -N -L 8425:localhost:8425 'you@a b;c'"],
  ] as const)("%j via %s", (addresses, browserHost, expected) => {
    expect(tunnelCommand({ port: "8425", addresses: [...addresses], browserHost })).toBe(expected);
  });
});

describe("soft wrap points", () => {
  const segs = (text: string) => wrapParts(text).map((p) => ("space" in p ? " " : p.segments.join("|")));

  it("never breaks inside flags, hyphenated IDs or after =", () => {
    expect(segs("gcloud projects create xaq-123456 --set-as-default --project=xaq-123456")).toEqual([
      "gcloud", " ", "projects", " ", "create", " ", "xaq-123456", " ", "--set-as-default", " ", "--project=xaq-123456",
    ]);
  });

  it("breaks URLs after / ? & , but not inside //", () => {
    expect(segs("https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,pubsub.googleapis.com&project=x")).toEqual([
      "https://|console.cloud.google.com/|flows/|enableapi?|apiid=gmail.googleapis.com,|pubsub.googleapis.com&|project=x",
    ]);
  });

  it("keeps whitespace runs and drops nothing", () => {
    const text = "a  b\nc https://x.y/z";
    const rebuilt = wrapParts(text)
      .map((p) => ("space" in p ? p.space : p.segments.join("")))
      .join("");
    expect(rebuilt).toBe(text);
  });
});

describe("connect dialog: what Add Google Calendar takes over", () => {
  it("hands back a cancel or unticked Calendar (mail is fine), and keeps real failures in the connect dialog", () => {
    expect(handsBack("oauth_calendar_not_granted")).toBe(true);
    expect(handsBack("oauth_access_denied")).toBe(true);
    for (const code of ["oauth_admin_policy_enforced", "oauth_redirect_uri_mismatch", "oauth_wrong_account", "gmail_api_disabled"]) expect(handsBack(code)).toBe(false);
  });

  it("offers Connect with mail only when an admin blocked a sign-in that asked for Calendar", () => {
    const admin = "oauth_admin_policy_enforced";
    expect(offersMailOnly(admin, {}, true)).toBe(true);
    expect(offersMailOnly(admin, { reauthAccountId: "acc_1" }, false)).toBe(true); // re-asks for Calendar it had
    expect(offersMailOnly(admin, {}, false)).toBe(false); // mail only already: the admin blocks the app
    expect(offersMailOnly(admin, { mailOnly: true }, true)).toBe(false);
    expect(offersMailOnly(admin, { reauthAccountId: "acc_1", scopes: ["calendar"] }, true)).toBe(false); // Add Calendar to X
    expect(offersMailOnly("oauth_access_denied", {}, true)).toBe(false);
  });
});

describe("connect dialog: one sign-in attempt", () => {
  const add = { scopes: false, reauth: false, reauthFromBroken: false };
  const reconnectWorking = { scopes: false, reauth: true, reauthFromBroken: false };
  const reconnectBroken = { scopes: false, reauth: true, reauthFromBroken: true };
  const calendar = { scopes: true, reauth: false, reauthFromBroken: false };
  const calendarReauth = { scopes: true, reauth: true, reauthFromBroken: false };

  it("stops once the server reported the outcome (the answer already moved the dialog on)", () => {
    for (const c of [add, reconnectWorking, reconnectBroken, calendar, calendarReauth]) {
      expect(checkAgainStep("connected", c)).toEqual({ kind: "stop" });
      expect(checkAgainStep("failed", c)).toEqual({ kind: "stop" });
    }
  });

  it("keeps waiting while the sign-in is pending, extra-access grants included", () => {
    expect(checkAgainStep("pending", add)).toEqual({ kind: "note", note: "pending" });
    expect(checkAgainStep("pending", calendar)).toEqual({ kind: "note", note: "pending" });
    expect(checkAgainStep("pending", reconnectWorking)).toEqual({ kind: "note", note: "pending-reauth" });
    expect(checkAgainStep("pending", reconnectBroken)).toEqual({ kind: "note", note: "pending-reauth" });
    expect(checkAgainStep("pending", calendarReauth)).toEqual({ kind: "note", note: "pending-reauth" });
  });

  it("says xaq is unreachable when the status request fails, whatever the flow", () => {
    for (const c of [add, reconnectWorking, reconnectBroken, calendar, calendarReauth]) expect(checkAgainStep(null, c)).toEqual({ kind: "note", note: "unreachable" });
  });

  it("falls back by flow when the server doesn't know the attempt", () => {
    // Extra access (Add Calendar): close unconfirmed.
    expect(checkAgainStep("unknown", calendar)).toEqual({ kind: "finish-unconfirmed" });
    expect(checkAgainStep("unknown", calendarReauth)).toEqual({ kind: "finish-unconfirmed" });
    // A working account: the list can't show a reconnect.
    expect(checkAgainStep("unknown", reconnectWorking)).toEqual({ kind: "note", note: "already-connected" });
    // A new account or a needs_reauth repair: the list can.
    expect(checkAgainStep("unknown", add)).toEqual({ kind: "check-list" });
    expect(checkAgainStep("unknown", reconnectBroken)).toEqual({ kind: "check-list" });
    expect(CHECK_NOTES.expired).toMatch(/expired/);
    expect(CHECK_NOTES["already-connected"]).toMatch(/already connected/);
  });

  it("finds what the attempt produced in the account list", () => {
    const known = new Set(["acc_old"]);
    const list = [
      { id: "acc_old", status: "active", email: "old@x.test" },
      { id: "acc_new", status: "active", email: "new@x.test" },
    ];
    expect(listMatch(list, { reauthFromBroken: false, known })?.id).toBe("acc_new");
    expect(listMatch(list.slice(0, 1), { reauthFromBroken: false, known })).toBeUndefined();
    expect(listMatch(list, { reauthAccountId: "acc_old", reauthFromBroken: true, known })?.id).toBe("acc_old");
    expect(listMatch([{ id: "acc_old", status: "needs_reauth" }], { reauthAccountId: "acc_old", reauthFromBroken: true, known })).toBeUndefined();
    // A working account being active proves nothing.
    expect(listMatch(list, { reauthAccountId: "acc_old", reauthFromBroken: false, known })).toBeUndefined();
  });

  it("asks the server only about the target account or new ones", () => {
    const known = new Set(["acc_a", "acc_b"]);
    expect(streamUpdateConcerns("acc_a", { reauthAccountId: "acc_a", known })).toBe(true);
    expect(streamUpdateConcerns("acc_b", { reauthAccountId: "acc_a", known })).toBe(false);
    expect(streamUpdateConcerns("acc_c", { reauthAccountId: "acc_a", known })).toBe(true);
    // Adding an account: signing in as an address that's already here reconnects it, so any update counts.
    expect(streamUpdateConcerns("acc_b", { known })).toBe(true);
  });

  it("ignores answers for an attempt the dialog has left", () => {
    const waiting = (state: string) => ({ kind: "waiting", res: { state } });
    expect(answerApplies(waiting("s1"), "s1")).toBe(true);
    expect(answerApplies(waiting("s2"), "s1")).toBe(false); // retried: a new state
    expect(answerApplies({ kind: "done" }, "s1")).toBe(false);
    expect(answerApplies({ kind: "starting" }, "s1")).toBe(false);
    expect(answerApplies(null, "s1")).toBe(false);
  });
});
