// Setup, sync and push end to end through the real Calendar client (A) and the fake Calendar API. The
// finer cases (forced scope errors, slow probes, watch failures) use test/calendar-setup-fakes.ts.
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.ts";
import { CALENDAR_PUSH_PATH, createCalendarPush } from "../server/calendar/push.ts";
import type { AppContext } from "../server/context.ts";
import { now } from "../server/db/index.ts";
import { getRow } from "../server/google/accounts.ts";
import { consent } from "./calendar-setup-fakes.ts";
import { FAKE_CLIENT, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";
import { grantInput } from "./mail-fakes.ts";

const OPS = "ops@example.com";
const WYNN = "wynn@example.com";
const ACTIVATION = "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456789";

let fake: FakeGoogle;
let ctx: AppContext;
let dispose: () => Promise<void>;

beforeEach(async () => {
  fake = await startFakeGoogle();
  const t = testContext({ events: recordingEvents().factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
  ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
});

afterEach(async () => {
  await dispose();
  await fake.close();
});

describe("through the real Calendar client", () => {
  it("the post-connect probe and a check see the API go off and on, with Google's activationUrl", async () => {
    const { account } = await consent(ctx, fake, OPS);
    expect(account!.calendar?.status).toBe("active");
    expect(ctx.calendar.setupState()).toMatchObject({ api: "enabled", step: "done" });

    fake.disableApi("calendar", true);
    const off = await ctx.calendar.check();
    expect(off).toMatchObject({ api: "disabled", step: "enable_api", enableApiUrl: ACTIVATION });
    expect(ctx.accounts.get(account!.id)!.calendar?.status).toBe("api_disabled");
    expect(ctx.google.setupWarnings().find((w) => w.code === "calendar_api_disabled")?.url).toBe(ACTIVATION);

    fake.disableApi("calendar", false);
    expect(await ctx.calendar.check()).toMatchObject({ api: "enabled", step: "done" });
    expect((await ctx.calendar.calendars(account!.id)).map((c) => [c.id, c.primary])).toEqual([[OPS, true]]);
  });

  it("a sync that works again clears api_disabled on every account (sync records through noteCalendarApi)", async () => {
    const a = (await consent(ctx, fake, OPS)).account!;
    const b = (await consent(ctx, fake, WYNN)).account!;
    ctx.policy.createAgent({ name: "Hermes", grants: [grantInput(a.id, { level: "read" })] });
    fake.disableApi("calendar", true);
    await expect(ctx.calendar.syncAccount(a.id)).rejects.toThrow(/has not been used/);
    await ctx.calendar.check();
    expect([a, b].map((x) => ctx.accounts.get(x.id)!.calendar?.status)).toEqual(["api_disabled", "api_disabled"]);
    expect(ctx.settings.getState("calendar.setup")!.api).toMatchObject({ state: "disabled", activationUrl: ACTIVATION });

    fake.disableApi("calendar", false);
    await ctx.calendar.syncAccount(a.id);
    expect([a, b].map((x) => ctx.accounts.get(x.id)!.calendar?.status)).toEqual(["active", "active"]);
    expect(ctx.calendar.setupState().api).toBe("enabled");
  });

  describe("push over HTTP", () => {
    let server: ServerType;
    let port: number;
    beforeEach(async () => {
      server = await new Promise<ServerType>((resolve) => {
        const s = serve({ fetch: createApp(ctx).fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
      });
      port = (server.address() as AddressInfo).port;
    });
    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("Google's sync verifies the channel and a change kicks that calendar", async () => {
      const { account } = await consent(ctx, fake, OPS);
      ctx.db.run("INSERT INTO calendar_sync (account_id, calendar_id, updated_at) VALUES (?, ?, ?)", account!.id, OPS, now());
      ctx.settings.update({ publicUrl: "https://inbox.example.com" });
      fake.calendar.pushTarget = (address) => address.replace("https://inbox.example.com", `http://127.0.0.1:${port}`);
      const kick = vi.spyOn(ctx.calendar, "kick");
      const push = createCalendarPush(ctx, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
      await push.reconcile();
      const [ch] = fake.calendar.channels();
      expect(ch).toMatchObject({ address: `https://inbox.example.com${CALENDAR_PUSH_PATH}`, calendarId: OPS });
      await vi.waitFor(() => expect(ctx.db.get<{ v: string | null }>("SELECT channel_verified_at AS v FROM calendar_sync")!.v).not.toBeNull());
      expect(kick).not.toHaveBeenCalled();

      fake.calendar.putEvent(OPS, OPS, { summary: "Standup", start: { dateTime: "2026-10-20T09:00:00Z" }, end: { dateTime: "2026-10-20T09:15:00Z" } });
      await vi.waitFor(() => expect(kick).toHaveBeenCalledWith(account!.id, OPS));

      // Removing the account stops the channel at Google before the token is revoked.
      await ctx.accounts.remove(account!.id);
      expect(fake.calendar.channels()).toEqual([]);
      expect(getRow(ctx, account!.id)).toBeUndefined();
      await push.stop?.();
    });
  });
});
