import { z } from "zod";
import type { GoogleClientCheck, GoogleClientImportResult, GoogleClientSaveResult } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

const ImportInput = z.object({
  json: z.string().min(1, "Paste the contents of the downloaded client JSON file").max(64_000, "That file is too large to be an OAuth client JSON"),
  appType: z.enum(["internal", "external"]).optional(),
});

const CalendarSetupInput = z.object({
  /** Turn Calendar on (start "Add Google Calendar") or off (connects ask for mail only again). */
  enabled: z.boolean().optional(),
  /** Hide (or show again) the calendar_not_added notice. */
  dismissed: z.boolean().optional(),
});

const ClientInput = z.object({
  clientId: z.string().trim().min(1, "Client ID is required"),
  clientSecret: z.string().optional(),
  projectId: z.string().trim().default(""),
  appType: z.enum(["internal", "external"]),
});

/**
 * GET/PUT /google/client, POST /google/client/import, GET/PATCH /google/calendar, POST /google/calendar/check.
 */
export function googleApi(ctx: AppContext) {
  const r = router();

  r.get("/google/client", (c) => c.json(ctx.google.clientView()));

  r.put("/google/client", async (c) => {
    const input = await readBody(c, ClientInput);
    const view = ctx.google.setClient(input);
    const check = await checkAfterSave();
    ctx.audit.record({
      ...ADMIN_ACTOR,
      action: "google.client.update",
      outcome: "ok",
      detail: {
        clientId: view.clientId,
        projectId: view.projectId,
        appType: view.appType,
        secretChanged: Boolean(input.clientSecret?.trim()),
        check: { clientId: check.clientId, redirectUri: check.redirectUri, secret: check.secret },
      },
    });
    return c.json<GoogleClientSaveResult>({ ...ctx.google.clientView(), warnings: check.warnings, check });
  });

  r.post("/google/client/check", async (c) => c.json<GoogleClientCheck>(await ctx.google.checkClient()));

  /** The check never blocks saving: anything unexpected degrades to "unknown". */
  const checkAfterSave = async (): Promise<GoogleClientCheck> => {
    try {
      return await ctx.google.checkClient();
    } catch (err) {
      ctx.log.child("google").warn("OAuth client check failed", { error: err instanceof Error ? err.message : String(err) });
      return { clientId: "unknown", redirectUri: "unknown", secret: "unknown", warnings: [] };
    }
  };

  r.post("/google/client/import", async (c) => {
    const input = await readBody(c, ImportInput);
    const imported = ctx.google.importClient(input);
    const check = await checkAfterSave();
    // The check's warnings include the JSON's redirect list as a fallback when Google's answer was unclear.
    const result: GoogleClientImportResult = { ...imported, ...ctx.google.clientView(), warnings: check.warnings, check };
    ctx.audit.record({
      ...ADMIN_ACTOR,
      action: "google.client.import",
      outcome: "ok",
      detail: {
        clientId: result.clientId,
        projectId: result.projectId,
        appType: result.appType,
        redirectUris: result.registeredRedirectUris,
        warnings: result.warnings.map((w) => w.code),
        check: { clientId: check.clientId, redirectUri: check.redirectUri, secret: check.secret },
      },
    });
    return c.json(result);
  });

  r.get("/google/calendar", (c) => c.json(ctx.calendar.setupState()));

  // Audited inside calendar.updateSetup.
  r.patch("/google/calendar", async (c) => c.json(ctx.calendar.updateSetup(await readBody(c, CalendarSetupInput))));

  r.post("/google/calendar/check", async (c) => c.json(await ctx.calendar.check()));

  return r;
}
