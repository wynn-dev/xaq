import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printSecret } from "../server/listen/admin.ts";
import { forwardEvent } from "../server/listen/forward.ts";
import { runListener } from "../server/listen/listen.ts";
import { loadProfile, saveProfile } from "../server/listen/profile.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg, makeEvent, waitFor } from "./listen-client-fake.ts";

/**
 * Standard Webhooks verification written from the spec (https://www.standardwebhooks.com), independent
 * of server/listen/forward.ts: secret = "whsec_" + base64 key; signed content = "{id}.{ts}.{body}";
 * header = space-separated "v1,<base64>" entries.
 */
function verifyStandardWebhook(secret: string, headers: IncomingHttpHeaders, rawBody: string, toleranceS = 300): boolean {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sigHeader = headers["webhook-signature"];
  if (typeof id !== "string" || typeof ts !== "string" || typeof sigHeader !== "string") return false;
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > toleranceS) return false;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`, "utf8").digest();
  return sigHeader.split(" ").some((entry) => {
    const [version, b64] = entry.split(",", 2);
    if (version !== "v1" || !b64) return false;
    const got = Buffer.from(b64, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

async function receiver(status = 200) {
  const got: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(status).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  return { got, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let env: ReturnType<typeof isolateXdg>;
beforeEach(() => {
  env = isolateXdg();
});
afterEach(() => {
  vi.restoreAllMocks();
  env.restore();
});

describe("forward mode", () => {
  it("signs per Standard Webhooks (verified independently)", async () => {
    const rx = await receiver();
    try {
      const secret = "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
      const event = makeEvent(42, { message: { subject: 'quote " and unicode ✓  ' } });
      const r = await forwardEvent(rx.url, secret, event, { timeoutMs: 5000 });
      expect(r).toMatchObject({ ok: true, statusCode: 200 });
      const req = rx.got[0]!;
      expect(req.headers["webhook-id"]).toBe("evt_42");
      expect(req.headers["content-type"]).toBe("application/json");
      expect(verifyStandardWebhook(secret, req.headers, req.body)).toBe(true);
      expect(JSON.parse(req.body)).toEqual(event);
      // Tampering or the wrong secret fails.
      expect(verifyStandardWebhook(secret, req.headers, req.body.replace("evt_42", "evt_43"))).toBe(false);
      expect(verifyStandardWebhook("whsec_" + Buffer.from("other").toString("base64"), req.headers, req.body)).toBe(false);
    } finally {
      await rx.close();
    }
  });

  it("treats non-2xx and unreachable receivers as failures", async () => {
    const rx = await receiver(500);
    try {
      const r = await forwardEvent(rx.url, "whsec_AAAA", makeEvent(1), { timeoutMs: 5000 });
      expect(r).toMatchObject({ ok: false, statusCode: 500, error: "Receiver responded 500" });
    } finally {
      await rx.close();
    }
    const down = await forwardEvent(rx.url, "whsec_AAAA", makeEvent(1), { timeoutMs: 2000 });
    expect(down.ok).toBe(false);
    expect(down.error).toMatch(/refused/);
  });

  it("uses a per-listener secret that `listen secret` prints, end to end", async () => {
    const api = await new FakeAgentApi().start();
    const rx = await receiver();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let printed = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((printed += String(c)), true));
    try {
      saveProfile("default", { url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c" });
      const ac = new AbortController();
      const run = runListener({ flags: { forward: rx.url }, signal: ac.signal });
      await waitFor(() => api.live.size === 1, 5000, "stream");
      api.publish(makeEvent(5));
      await waitFor(() => api.acked === 5, 5000, "ack");
      ac.abort();
      await run;

      // Not saved as the forward target (no --save), but the secret persists.
      const profile = loadProfile();
      expect(profile.forward).toBeUndefined();
      expect(profile.forwardSecret).toMatch(/^whsec_/);
      printed = "";
      printSecret("default", {});
      const secret = printed.trim();
      expect(secret).toBe(profile.forwardSecret);
      expect(verifyStandardWebhook(secret, rx.got[0]!.headers, rx.got[0]!.body)).toBe(true);
    } finally {
      await rx.close();
      await api.stop();
    }
  });
});
