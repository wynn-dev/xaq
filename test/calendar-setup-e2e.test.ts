// Setup and sync end to end through the real Calendar client and the fake Calendar API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../server/context.ts";
import { consent, FAKE_CLIENT, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { grantInput, testContext } from "./helpers.ts";

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
});
