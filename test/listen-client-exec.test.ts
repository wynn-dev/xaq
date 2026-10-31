import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UNTRUSTED_NOTICE } from "../server/listen/event.ts";
import { runCommand } from "../server/listen/exec.ts";
import { makeEvent } from "./listen-client-fake.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xaq-exec-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("command mode", () => {
  it("never executes event data: shell metacharacters arrive intact on stdin", async () => {
    const marker = join(dir, "pwned");
    const tricks = [
      `$(touch ${marker})`,
      `\`touch ${marker}\``,
      `"; touch ${marker}; "`,
      `'; touch ${marker}; '`,
      `x\ntouch ${marker}\n`,
      `a;$IFS touch$IFS${marker}`,
      `\${IFS}touch\${IFS}${marker}`,
      `| touch ${marker} &`,
      `$((1+1)) %s %n \\ \u0000 ‮`,
    ].join(" ");
    const event = makeEvent(7, {
      message: { subject: tricks, from: { name: tricks, email: `$(touch ${marker})@evil.example` }, snippet: tricks },
      content: { body: tricks, truncated: false, attachments: [], signals: { hiddenContentRemoved: false, suspiciousInstructions: [], auth: null, external: true } },
    });
    const out = join(dir, "stdin.json");
    const envOut = join(dir, "env.txt");
    // A deliberately careless command: it interpolates every variable it was given.
    const cmd = `cat > ${out}; env > ${envOut}; echo "$XAQ_EVENT_ID $XAQ_ACCOUNT $XAQ_THREAD_ID $XAQ_MESSAGE_ID" >/dev/null; eval "echo $XAQ_EVENT_TYPE" >/dev/null`;
    const r = await runCommand(cmd, event, { timeoutMs: 10_000 });
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);

    const got = JSON.parse(readFileSync(out, "utf8")) as { notice: string; event: typeof event };
    expect(got.notice).toBe(UNTRUSTED_NOTICE);
    // Header text arrives intact apart from invisible characters (and our delimiter tag, absent here).
    const cleaned = tricks.replace("\u202e", "");
    expect(got.event.data.message!.subject).toBe(cleaned);
    expect(got.event.data.message!.snippet).toBe(cleaned);
    expect(got.event.data.message!.from!.name).toBe(cleaned);
    // The body is wrapped in the untrusted delimiter; its text is intact apart from invisible characters.
    const body = got.event.data.content!.body;
    expect(body.startsWith('<email_content from="$(touch')).toBe(true);
    expect(body).toContain(" untrusted>\n");
    expect(body).toContain(tricks.replace("‮", ""));
    expect(body.endsWith("\n</email_content>")).toBe(true);

    // The environment carries only validated ids; free text never reaches it.
    const env = readFileSync(envOut, "utf8");
    const ours = env
      .split("\n")
      .filter((l) => l.startsWith("XAQ_"))
      .map((l) => l.split("=")[0])
      .sort();
    expect(ours).toEqual(["XAQ_ACCOUNT", "XAQ_EVENT_FILE", "XAQ_EVENT_ID", "XAQ_EVENT_SEQ", "XAQ_EVENT_TYPE", "XAQ_MESSAGE_ID", "XAQ_THREAD_ID"]);
    expect(env).not.toContain("touch");
    expect(env).not.toContain("Hello");
    expect(env).toContain("XAQ_EVENT_ID=evt_7\n");
    expect(env).toContain("XAQ_EVENT_SEQ=7\n");
    expect(env).toContain("XAQ_ACCOUNT=me@example.com\n");
    expect(existsSync(marker)).toBe(false);
  });

  it("drops ids that aren't plain tokens and strips inherited XAQ_* variables", async () => {
    process.env.XAQ_MASTER_KEY = "should-not-leak";
    try {
      const event = makeEvent(8, { message: { threadId: "abc$(id)", id: "m 1" } });
      const envOut = join(dir, "env.txt");
      const r = await runCommand(`env > ${envOut}`, event, { timeoutMs: 10_000 });
      expect(r.ok).toBe(true);
      const env = readFileSync(envOut, "utf8");
      expect(env).not.toContain("XAQ_THREAD_ID");
      expect(env).not.toContain("XAQ_MESSAGE_ID");
      expect(env).not.toContain("should-not-leak");
    } finally {
      delete process.env.XAQ_MASTER_KEY;
    }
  });

  it("provides a 0600 event file and deletes it afterwards", async () => {
    const out = join(dir, "file-info.txt");
    const copy = join(dir, "file-copy.json");
    const stdin = join(dir, "stdin-copy.json");
    const cmd = `stat -c '%a' "$XAQ_EVENT_FILE" 2>/dev/null > ${out} || stat -f '%Lp' "$XAQ_EVENT_FILE" > ${out}; echo "$XAQ_EVENT_FILE" >> ${out}; cp "$XAQ_EVENT_FILE" ${copy}; cat > ${stdin}`;
    const r = await runCommand(cmd, makeEvent(9), { timeoutMs: 10_000 });
    expect(r.error).toBeNull();
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(stdin, "utf8"));
    const [mode, path] = readFileSync(out, "utf8").trim().split("\n");
    expect(mode).toBe("600");
    expect(existsSync(path!)).toBe(false);
  });

  it("kills the whole process group on timeout", async () => {
    const pidFile = join(dir, "bg.pid");
    const started = Date.now();
    const r = await runCommand(`sleep 60 & echo $! > ${pidFile}; sleep 60`, makeEvent(10), { timeoutMs: 500 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/Timed out after/);
    const bg = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(bg)).toBe(false);
  });

  it("reports failures with output tails", async () => {
    const r = await runCommand(`echo working; echo "boom" >&2; exit 3`, makeEvent(11), { timeoutMs: 10_000 });
    expect(r).toMatchObject({ ok: false, exitCode: 3, error: "Exited with code 3" });
    expect(r.stdoutTail).toBe("working\n");
    expect(r.stderrTail).toBe("boom\n");
  });

  it("doesn't wait for background processes holding the pipes", async () => {
    const pidFile = join(dir, "bg.pid");
    const started = Date.now();
    const r = await runCommand(`sleep 30 & echo $! > ${pidFile}; exit 0`, makeEvent(12), { timeoutMs: 20_000 });
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
  });
});
