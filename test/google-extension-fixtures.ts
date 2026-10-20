// Fixtures for the Google extension tests: the google-workspace manifest shape the lead settled (what W1/W2 build
// against), and the echo test extension (test/fixtures/extensions/echo) dressed as a google extension.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const G = "https://www.googleapis.com/auth/";

export const WORKSPACE_APIS = [
  { service: "docs.googleapis.com", label: "Google Docs API" },
  { service: "sheets.googleapis.com", label: "Google Sheets API" },
  { service: "slides.googleapis.com", label: "Google Slides API" },
  { service: "drive.googleapis.com", label: "Google Drive API" },
];

export const googleManifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  name: "google-workspace",
  displayName: "Google Workspace",
  version: "1.0.0",
  description: "Google Docs, Sheets and Slides, and the Drive files to find them.",
  kind: "code",
  slug: "gws",
  code: {
    entry: "dist/server.mjs",
    node: ">=22.13",
    auth: {
      type: "google",
      scopes: [`${G}documents`, `${G}spreadsheets`, `${G}presentations`, `${G}drive.file`, `${G}drive.readonly`],
      apis: WORKSPACE_APIS,
    },
    network: ["docs.googleapis.com", "sheets.googleapis.com", "slides.googleapis.com", "www.googleapis.com"],
  },
  risk: { tools: { echo: { class: "read" }, whoami: { class: "read" }, authfetch: { class: "read" } } },
  ...over,
});

export const ECHO_FIXTURE = resolve(import.meta.dirname, "fixtures/extensions/echo");

/** The echo extension's code with the google-workspace manifest, written under `dir`. Returns `dir`. */
export function googleEcho(dir: string): string {
  mkdirSync(join(dir, "dist"), { recursive: true });
  copyFileSync(join(ECHO_FIXTURE, "dist", "server.mjs"), join(dir, "dist", "server.mjs"));
  writeFileSync(join(dir, "xaq-extension.json"), JSON.stringify(googleManifest(), null, 2));
  return dir;
}
