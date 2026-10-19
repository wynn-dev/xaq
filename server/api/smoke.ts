// Admin-only endpoints for `xaq smoke google-workspace` (server/smoke, contract in shared/smoke.ts). Same admin
// session and CSRF guard as the rest of /api. They exist because no agent tool may do these things:
// - create the run's temporary agent with exactly its grants (mail read + draft to itself, the Workspace connection
//   at "ask", nothing inherited, tools listed directly);
// - read and delete the run's draft (there is no draft-delete tool): only a draft the run's agent created (the audit
//   log says so), whose id is in the command's ledger and whose subject carries the run's marker;
// - report what a run left behind.

import { z } from "zod";
import type { AgentWithKey } from "../../shared/types.ts";
import { SMOKE_NAME_RE, type SmokeDraftView, type SmokeLeftovers, smokeSubjectPrefix } from "../../shared/smoke.ts";
import { setAgentSearchSettings } from "../broker/search/mode.ts";
import type { AppContext } from "../context.ts";
import { asHttpError } from "../google/http.ts";
import { GoogleApiError } from "../google/types.ts";
import { HttpError, badRequest, conflict, notFound } from "../util/errors.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

const id = z.string().min(1).max(200);
const AgentInput = z.object({ name: z.string().regex(SMOKE_NAME_RE, "must be xaq-smoke-<UTC timestamp>"), accountId: id, connectionId: id }).strict();
const DraftInput = z.object({ agentId: id, accountId: id, draftId: id, ledger: z.array(id).max(20) }).strict();
const LeftoversInput = z.object({ agentId: id, accountId: id, draftIds: z.array(id).max(20) }).strict();

const refused = (message: string) => new HttpError(403, "not_a_smoke_draft", message);
const addressOf = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();

export function smokeApi(ctx: AppContext) {
  const app = router();

  /** The run's agent: it must exist and be named like a smoke run. */
  const smokeAgent = (agentId: string) => {
    const agent = ctx.policy.getAgent(agentId);
    if (!agent) throw notFound("Agent");
    if (!SMOKE_NAME_RE.test(agent.name)) throw refused(`${agent.name} isn't a smoke run's agent.`);
    return agent;
  };

  /** The draft, after every check that makes it this run's draft. */
  const smokeDraft = async (input: z.infer<typeof DraftInput>) => {
    const agent = smokeAgent(input.agentId);
    const account = ctx.accounts.get(input.accountId);
    if (!account) throw notFound("Account");
    if (!input.ledger.includes(input.draftId)) throw refused("That draft isn't in this run's ledger.");
    const created = ctx.db.get(
      "SELECT 1 AS x FROM audit_log WHERE actor_type = 'agent' AND actor_id = ? AND action = 'create_draft' AND account_id = ? AND target = ? AND outcome = 'ok'",
      agent.id,
      account.id,
      input.draftId,
    );
    if (!created) throw refused(`${agent.name} didn't create that draft.`);
    let draft;
    try {
      draft = await ctx.google.gmail(account.id).getDraft(input.draftId);
    } catch (err) {
      throw asHttpError(err);
    }
    const parsed = ctx.google.mime.parse(draft.message);
    const subject = parsed.summary.subject ?? "";
    if (!subject.startsWith(smokeSubjectPrefix(agent.name))) throw refused(`The draft's subject doesn't carry ${agent.name}.`);
    const bcc = (parsed.headers.bcc ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const recipients = [...parsed.summary.to.map((a) => a.email), ...parsed.summary.cc.map((a) => a.email), ...bcc].map(addressOf);
    const view: SmokeDraftView = {
      draftId: input.draftId,
      subject,
      recipients,
      attachments: parsed.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size })),
    };
    return { agent, account, view };
  };

  app.post("/smoke/agents", async (c) => {
    const body = await readBody(c, AgentInput);
    const account = ctx.accounts.get(body.accountId);
    if (!account) throw notFound("Account");
    if (!ctx.db.get("SELECT 1 AS x FROM connections WHERE id = ?", body.connectionId)) throw notFound("Connection");
    if (ctx.policy.listAgents().some((a) => a.name === body.name)) throw conflict(`An agent named ${body.name} already exists.`);
    const created: AgentWithKey = ctx.policy.createAgent(
      {
        name: body.name,
        description: "Temporary agent for `xaq smoke google-workspace`. The run deletes it when it ends.",
        grants: [
          {
            accountId: account.id,
            // Draft-only: read mail, create drafts. No send, organize or trash.
            capabilities: ["read", "draft"],
            labelScope: null,
            sendMode: "draft_only",
            allowTo: [account.email.toLowerCase()],
            replyOnly: false,
            maxSendsPerHour: null,
            maxSendsPerDay: null,
          },
        ],
        connections: [{ connectionId: body.connectionId, level: "ask" }],
      },
      { inheritAllAgents: false },
    );
    // Every tool listed (tools/list is how the run checks the tools it needs); deleteAgent removes the setting.
    setAgentSearchSettings(ctx.db, created.agent.id, { mode: "direct" });
    ctx.audit.record({ ...ADMIN_ACTOR, action: "smoke.agent_create", accountId: account.id, target: created.agent.id, outcome: "ok", detail: { name: body.name, connectionId: body.connectionId } });
    return c.json(created, 201);
  });

  app.post("/smoke/drafts/inspect", async (c) => {
    const { view } = await smokeDraft(await readBody(c, DraftInput));
    return c.json(view);
  });

  app.post("/smoke/drafts/delete", async (c) => {
    const body = await readBody(c, DraftInput);
    const { agent, account, view } = await smokeDraft(body);
    const own = account.email.toLowerCase();
    if (!view.recipients.length || view.recipients.some((r) => r !== own)) throw refused("The draft is addressed to someone other than the account itself.");
    try {
      await ctx.google.gmail(account.id).deleteDraft(body.draftId);
    } catch (err) {
      throw asHttpError(err);
    }
    ctx.audit.record({ ...ADMIN_ACTOR, action: "smoke.draft_delete", accountId: account.id, target: body.draftId, outcome: "ok", detail: { agent: agent.name } });
    return c.json({ deleted: true });
  });

  app.post("/smoke/leftovers", async (c) => {
    const body = await readBody(c, LeftoversInput);
    if (!ctx.accounts.get(body.accountId)) throw notFound("Account");
    const drafts: string[] = [];
    for (const draftId of body.draftIds) {
      try {
        await ctx.google.gmail(body.accountId).getDraft(draftId);
        drafts.push(draftId);
      } catch (err) {
        if (!(err instanceof GoogleApiError && err.status === 404)) throw badRequest(`Couldn't check draft ${draftId}: ${(err as Error).message}`);
      }
    }
    const out: SmokeLeftovers = {
      agent: !!ctx.policy.getAgent(body.agentId),
      agentSettings: !!ctx.db.get("SELECT 1 AS x FROM settings WHERE key = ?", `broker.search:${body.agentId}`),
      drafts,
      otherSmokeAgents: ctx.policy
        .listAgents()
        .filter((a) => a.id !== body.agentId && SMOKE_NAME_RE.test(a.name))
        .map((a) => ({ id: a.id, name: a.name })),
    };
    return c.json(out);
  });

  return app;
}
