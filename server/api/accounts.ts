import { z } from "zod";
import { type Account, EXTRA_SCOPE_NAMES } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { asHttpError } from "../google/http.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

const ConnectInput = z.object({
  reauthAccountId: z.string().min(1).optional(),
  /**
   * Incremental consent: ["calendar"] for Google Calendar (with reauthAccountId: "Add Calendar to <email>").
   */
  scopes: z.array(z.enum(EXTRA_SCOPE_NAMES)).optional(),
  /** Leave Google Calendar out of this consent (a Workspace admin blocks it). */
  mailOnly: z.boolean().optional(),
});
const AttemptInput = z.object({ state: z.string().min(1).max(200) });
const CompleteInput = z.object({ url: z.string().trim().min(1, "Paste the URL you landed on after approving access") });

const google = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    throw asHttpError(err);
  }
};

/** /accounts: list, connect (direct + paste), resync, pause/resume, remove, labels, calendars, test email. */
export function accountsApi(ctx: AppContext) {
  const r = router();
  const audited = (action: string, a: Account) =>
    ctx.audit.record({ ...ADMIN_ACTOR, action, accountId: a.id, outcome: "ok", detail: { email: a.email } });

  r.get("/accounts", (c) => c.json(ctx.accounts.list()));

  r.post("/accounts/connect", async (c) => {
    const { reauthAccountId, scopes, mailOnly } = await readBody(c, ConnectInput);
    return c.json(ctx.google.startConnect({ reauthAccountId, scopes, mailOnly }));
  });

  r.post("/accounts/connect/complete", async (c) => {
    const { url } = await readBody(c, CompleteInput);
    return c.json(await google(() => ctx.google.completeConnectFromUrl(url)));
  });

  // POST so the state (a secret of this sign-in) stays out of URLs and access logs.
  r.post("/accounts/connect/status", async (c) => {
    const { state } = await readBody(c, AttemptInput);
    return c.json(ctx.google.connectAttempt(state));
  });

  r.post("/accounts/:id/resync", async (c) => {
    const account = await google(() => ctx.ingest.resync(c.req.param("id")));
    audited("account.resync", account);
    return c.json(account);
  });

  r.post("/accounts/:id/pause", async (c) => {
    const account = await google(() => ctx.ingest.pause(c.req.param("id")));
    audited("account.pause", account);
    return c.json(account);
  });

  r.post("/accounts/:id/resume", async (c) => {
    const account = await google(() => ctx.ingest.resume(c.req.param("id")));
    audited("account.resume", account);
    return c.json(account);
  });

  // Audited inside accounts.remove.
  r.delete("/accounts/:id", async (c) => {
    await ctx.accounts.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  r.get("/accounts/:id/labels", async (c) => {
    const id = ctx.accounts.require(c.req.param("id")).id;
    return c.json(await google(() => ctx.google.labels(id)));
  });

  r.get("/accounts/:id/calendars", async (c) => {
    const id = ctx.accounts.require(c.req.param("id")).id;
    return c.json(await google(() => ctx.calendar.calendars(id)));
  });

  // Audited inside google.sendTestEmail (ok and error).
  r.post("/accounts/:id/test-email", async (c) => c.json(await google(() => ctx.google.sendTestEmail(c.req.param("id")))));

  return r;
}
