// Admin-only endpoints for `xaq smoke google-workspace` (server/smoke, contract in shared/smoke.ts). Same admin
// session and CSRF guard as the rest of /api. They exist because no agent tool may do these things:
// - create the run's temporary agent with exactly its grants (mail read + draft to itself, the Workspace connection
//   at "ask", nothing inherited, tools listed directly);
// - read and delete the run's draft (there is no draft-delete tool): only a draft the run's agent created (the audit
//   log says so), whose id is in the command's ledger and whose subject carries the run's marker;
// - report what a run left behind, and at the start of a run sweep what earlier runs left (their agents deleted,
//   their temp dirs out of attachmentDirs, their drafts reported).

import { z } from "zod";
import type { AgentWithKey } from "../../shared/types.ts";
import { isSmokeDir, SMOKE_NAME_RE, type SmokeDraftView, type SmokeLeftovers, type SmokeSweep, smokeSubjectPrefix } from "../../shared/smoke.ts";
import { setAgentSearchSettings } from "../broker/search/mode.ts";
import type { AppContext } from "../context.ts";
import { asHttpError } from "../google/http.ts";
import { GoogleApiError } from "../google/types.ts";
import { HttpError, badRequest, conflict, notFound } from "../util/errors.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

const id = z.string().min(1).max(200);
const AgentInput = z.object({ name: z.string().regex(SMOKE_NAME_RE, "must be xaq-smoke-<UTC timestamp>"), accountId: id, connectionId: id }).strict();
const DraftInput = z.object({ agentId: id, accountId: id, draftId: id, ledger: z.array(id).max(20) }).strict();
const LeftoversInput = z.object({ agentId: id.nullable(), accountId: id, draftIds: z.array(id).max(20) }).strict();

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

  /** Whether a draft still exists in Gmail (404 = gone). */
  const draftExists = async (accountId: string, draftId: string): Promise<boolean> => {
    try {
      await ctx.google.gmail(accountId).getDraft(draftId);
      return true;
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) return false;
      throw badRequest(`Couldn't check draft ${draftId}: ${(err as Error).message}`);
    }
  };

  /** The drafts `agentId` created according to the audit log, with their accounts, minus those a smoke run deleted. */
  const auditedDrafts = (agentId: string): { draftId: string; accountId: string }[] =>
    ctx.db.all<{ draftId: string; accountId: string }>(
      `SELECT DISTINCT target AS draftId, account_id AS accountId FROM audit_log
        WHERE actor_type = 'agent' AND actor_id = ? AND action = 'create_draft' AND outcome = 'ok' AND target IS NOT NULL AND account_id IS NOT NULL
          AND target NOT IN (SELECT target FROM audit_log WHERE action = 'smoke.draft_delete' AND target IS NOT NULL)`,
      agentId,
    );

  /**
   * Existing agents a smoke run created: their id is the target of a `smoke.agent_create` audit row (POST
   * /api/smoke/agents) and the name still matches. An owner's own agent that happens to be named xaq-smoke-… isn't one.
   */
  const smokeAgents = () => {
    const created = new Set(
      ctx.db.all<{ id: string }>("SELECT DISTINCT target AS id FROM audit_log WHERE action = 'smoke.agent_create' AND target IS NOT NULL").map((r) => r.id),
    );
    return ctx.policy.listAgents().filter((a) => created.has(a.id) && SMOKE_NAME_RE.test(a.name));
  };

  app.post("/smoke/leftovers", async (c) => {
    const body = await readBody(c, LeftoversInput);
    if (!ctx.accounts.get(body.accountId)) throw notFound("Account");
    // The ledger's drafts, and any the agent created that the command never recorded (a lost answer).
    const candidates = new Map<string, string>(body.draftIds.map((d) => [d, body.accountId]));
    if (body.agentId) for (const d of auditedDrafts(body.agentId)) candidates.set(d.draftId, d.accountId);
    const drafts: string[] = [];
    for (const [draftId, accountId] of candidates) if (ctx.accounts.get(accountId) && (await draftExists(accountId, draftId))) drafts.push(draftId);
    const out: SmokeLeftovers = {
      agent: !!body.agentId && !!ctx.policy.getAgent(body.agentId),
      agentSettings: !!body.agentId && !!ctx.db.get("SELECT 1 AS x FROM settings WHERE key = ?", `broker.search:${body.agentId}`),
      drafts,
      otherSmokeAgents: smokeAgents()
        .filter((a) => a.id !== body.agentId)
        .map((a) => ({ id: a.id, name: a.name })),
    };
    return c.json(out);
  });

  // Earlier runs' leftovers, at the start of a run (before its own agent exists): their agents are deleted, their temp
  // dirs taken out of attachmentDirs, and their drafts that still exist reported (never deleted here).
  app.post("/smoke/sweep", async (c) => {
    await readBody(c, z.object({}).strict());
    const deletedAgents: SmokeSweep["deletedAgents"] = [];
    // Only agents a smoke run created (the audit log says so), never one that merely has a lookalike name.
    for (const a of smokeAgents()) {
      ctx.policy.deleteAgent(a.id);
      deletedAgents.push({ id: a.id, name: a.name });
    }
    const before = ctx.settings.get().attachmentDirs;
    const removedDirs = before.filter(isSmokeDir);
    if (removedDirs.length) ctx.settings.update({ attachmentDirs: before.filter((d) => !isSmokeDir(d)) });
    // Every smoke agent there ever was (the audit log keeps their ids), most recent first, bounded.
    const runs = ctx.db.all<{ agentId: string; detail: string | null }>(
      "SELECT target AS agentId, detail FROM audit_log WHERE action = 'smoke.agent_create' AND target IS NOT NULL ORDER BY id DESC LIMIT 20",
    );
    const drafts: SmokeSweep["drafts"] = [];
    for (const run of runs) {
      let name = run.agentId;
      try {
        name = (JSON.parse(run.detail ?? "{}") as { name?: string }).name ?? name;
      } catch {
        // The id will do.
      }
      for (const d of auditedDrafts(run.agentId)) {
        const account = ctx.accounts.get(d.accountId);
        if (account && (await draftExists(account.id, d.draftId))) drafts.push({ draftId: d.draftId, account: account.email, agent: name });
      }
    }
    const out: SmokeSweep = { deletedAgents, removedDirs, drafts };
    if (deletedAgents.length || removedDirs.length) {
      ctx.audit.record({ ...ADMIN_ACTOR, action: "smoke.sweep", outcome: "ok", detail: { agents: deletedAgents.map((a) => a.name), dirs: removedDirs.length } });
    }
    return c.json(out);
  });

  return app;
}
