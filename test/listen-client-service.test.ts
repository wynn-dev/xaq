import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAUNCHD_LABEL, launchdListenPlist, systemdListenUnit, UNIT_NAME } from "../server/listen/service.ts";
import { FAKE_KEY, isolateXdg } from "./listen-client-fake.ts";

let env: ReturnType<typeof isolateXdg>;
beforeEach(() => {
  env = isolateXdg();
});
afterEach(() => env.restore());

describe("listener service units", () => {
  it("systemd: one unit, runs the stable install, keeps the key out, doesn't restart on revocation", () => {
    process.env.XAQ_TEST_SECRET_IN_ENV = FAKE_KEY;
    try {
      const unit = systemdListenUnit("/home/u/.local/share/xaq/listen-app/node_modules/xaq-cli/dist/cli.js", "/home/u/projects/100%");
      expect(UNIT_NAME).toBe("xaq-listen-default");
      expect(unit).toContain(`ExecStart="${process.execPath}" "/home/u/.local/share/xaq/listen-app/node_modules/xaq-cli/dist/cli.js" listen\n`);
      expect(unit).toContain("WorkingDirectory=/home/u/projects/100%%");
      expect(unit).toContain("Restart=on-failure");
      expect(unit).toContain("RestartPreventExitStatus=78");
      expect(unit).toContain('Environment="XAQ_SERVICE=1"');
      expect(unit).toMatch(/Environment="PATH=/);
      expect(unit).toContain(`Environment="XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME}"`);
      expect(unit).not.toContain(FAKE_KEY);
      expect(unit).not.toContain("_npx");
    } finally {
      delete process.env.XAQ_TEST_SECRET_IN_ENV;
    }
  });

  it("cleans npx and version-manager shims out of PATH", async () => {
    const { servicePath } = await import("../server/listen/service.ts");
    const p = servicePath("/repo/node_modules/.bin:/run/user/1000/fnm_multishells/1_2/bin:/home/u/.local/bin:/home/u/.npm/_npx/abc/node_modules/.bin:relative:/usr/bin:/home/u/.local/bin");
    expect(p.split(":")).toEqual([dirname(process.execPath), "/home/u/.local/bin", "/usr/bin"].filter((d, i, a) => a.indexOf(d) === i));
  });

  it("launchd: one label, restarts only on failure, escapes XML", () => {
    const plist = launchdListenPlist("/opt/a&b/cli.js", "/Users/u");
    expect(LAUNCHD_LABEL).toBe("sh.xaq.listen.default");
    expect(plist).toContain("<string>sh.xaq.listen.default</string>");
    expect(plist).toContain("<string>/opt/a&amp;b/cli.js</string>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
    expect(plist).toContain("<string>listen</string>\n  </array>");
  });
});
