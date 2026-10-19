// The console's Google extension setup, as pure decisions (src/components/connections/connection-flow.ts): the
// account step's choice, "Check again" in one line, and a connection's account and missing access in plain words.

import { describe, expect, it } from "vitest";
import { apiCheckSummary, draftProblems, emptyDraft, googleAccessView, inputProblems } from "../src/components/connections/connection-flow.ts";
import type { ConnectionGoogleView, GoogleApiCheckView, PresetView, SetupStepView } from "../shared/types.ts";

const G = "https://www.googleapis.com/auth/";

const accountStep = (choices: NonNullable<SetupStepView["input"]>["choices"]): SetupStepView => ({
  id: "google-account",
  title: "Pick the Google account",
  body: "…",
  input: { key: "google_account", label: "Google account", choices },
});

const check = (service: string, state: GoogleApiCheckView["state"], message: string | null = null): GoogleApiCheckView => ({
  service,
  label: `${service.split(".")[0]} API`,
  state,
  enableUrl: `https://console.cloud.google.com/apis/library/${service}`,
  message,
});

describe("the account step", () => {
  it("needs one of the offered accounts that can be picked", () => {
    const step = accountStep([
      { value: "me@example.com", label: "me@example.com" },
      { value: "old@example.com", label: "old@example.com", disabled: true, note: "needs reconnecting on the Accounts page first" },
    ]);
    expect(inputProblems([step], {})).toEqual({ google_account: "Pick the google account." });
    expect(inputProblems([step], { google_account: "me@example.com" })).toEqual({});
    expect(inputProblems([step], { google_account: "old@example.com" })).toEqual({ google_account: "Pick one of the offered google accounts." });
    expect(inputProblems([step], { google_account: "someone@else.com" })).toEqual({ google_account: "Pick one of the offered google accounts." });
    expect(inputProblems([accountStep([])], {})).toEqual({ google_account: "Add a google account to xaq first." });
  });

  it("blocks Continue until an account is picked", () => {
    const preset: PresetView = {
      id: "google-workspace",
      displayName: "Google Workspace",
      slug: "gws",
      kind: "native",
      url: null,
      authType: "oauth",
      setupSteps: [accountStep([{ value: "me@example.com", label: "me@example.com" }])],
      reconnectPolicy: null,
      official: true,
      userServer: null,
    };
    const d = emptyDraft(preset);
    expect(draftProblems(d, [])).toContain("Pick the google account.");
    expect(draftProblems({ ...d, inputs: { google_account: "me@example.com" } }, [])).toEqual([]);
  });
});

describe("Check again, in one line", () => {
  it("names what's still off, then what couldn't be checked, then all on", () => {
    expect(apiCheckSummary([check("docs.googleapis.com", "disabled"), check("drive.googleapis.com", "enabled")])).toEqual({
      tone: "bad",
      text: "Still off: docs API. Turn it on, wait a minute, then check again.",
    });
    expect(apiCheckSummary([check("docs.googleapis.com", "error", "Google answered HTTP 500: boom")])).toMatchObject({ tone: "warn", text: expect.stringContaining("boom") });
    expect(apiCheckSummary([check("docs.googleapis.com", "unchecked", "xaq can check this once you've allowed access (the next step).")])).toEqual({
      tone: "idle",
      text: "xaq can check this once you've allowed access (the next step).",
    });
    expect(apiCheckSummary([check("docs.googleapis.com", "enabled")])).toEqual({ tone: "good", text: "Every API is on." });
  });
});

describe("a connection's Google account and access", () => {
  const google = (over: Partial<ConnectionGoogleView>): ConnectionGoogleView => ({
    accountId: "acc_1",
    email: "me@example.com",
    scopes: [`${G}documents`, `${G}drive.readonly`],
    granted: [`${G}documents`, `${G}drive.readonly`],
    missing: [],
    ...over,
  });

  it("all granted, partly granted, nothing granted, no account; and nothing for other connections", () => {
    expect(googleAccessView({ name: "Docs", google: google({}) })).toEqual({ account: "me@example.com", note: null });
    expect(
      googleAccessView({
        name: "Docs",
        google: google({
          granted: [`${G}documents`],
          missing: [{ scope: `${G}drive.readonly`, grants: "see and download all your Google Drive files", without: "it can't search your Drive or open files it didn't create" }],
        }),
      })!.note,
    ).toBe("Not granted on Google's screen: see and download all your Google Drive files. So it can't search your Drive or open files it didn't create. Reconnect and tick every box to fix it.");
    expect(googleAccessView({ name: "Docs", google: google({ granted: [], missing: [] }) })!.note).toContain("has no access to me@example.com yet");
    expect(googleAccessView({ name: "Docs", google: google({ accountId: null, email: null }) })).toEqual({ account: "No Google account picked", note: "Reconnect Docs to pick one." });
    expect(googleAccessView({ name: "Notion" })).toBeNull();
  });
});
