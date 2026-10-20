import { useState } from "react";
import type { IngestMode, Settings, SystemInfo } from "@shared/types";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { InfoIcon } from "lucide-react";
import { toast } from "sonner";
import { ChipsInput } from "@/components/chips-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { CalendarSetupSummary } from "@/components/google/calendar-setup";
import { RedirectNotice } from "@/components/google/redirect-notice";
import { UrlVerdict } from "@/components/setup/step-url";
import { api, toastError } from "@/lib/api";
import { addressLabel, analyzeUrl, isLoopbackOrigin, publicUrlError } from "@/lib/public-url";
import { keys } from "@/lib/queries";

interface FormValues {
  publicUrl: string;
  ingestMode: IngestMode;
  pollIntervalSeconds: string;
  calendarPollSeconds: string;
  maxBodyChars: string;
  retentionDays: string;
  approvalTtlHours: string;
  webhookAllowlist: string[];
  attachmentDirs: string[];
  pairingEnabled: boolean;
  brokerUpstreams: boolean;
  attachmentSaveDir: string;
}

const toForm = (s: Settings): FormValues => ({
  publicUrl: s.publicUrl,
  ingestMode: s.ingestMode,
  pollIntervalSeconds: String(s.pollIntervalSeconds),
  calendarPollSeconds: String(s.calendarPollSeconds),
  maxBodyChars: String(s.maxBodyChars),
  retentionDays: String(s.retentionDays),
  approvalTtlHours: String(s.approvalTtlHours),
  webhookAllowlist: s.webhookAllowlist,
  attachmentDirs: s.attachmentDirs ?? [],
  pairingEnabled: s.pairingEnabled,
  brokerUpstreams: s.brokerUpstreams,
  attachmentSaveDir: s.attachmentSaveDir,
});

// The patch below only carries changed fields.
const fromForm = (v: FormValues): Settings => ({
  publicUrl: v.publicUrl.trim().replace(/\/+$/, ""),
  ingestMode: v.ingestMode,
  pollIntervalSeconds: Number(v.pollIntervalSeconds),
  calendarPollSeconds: Number(v.calendarPollSeconds),
  maxBodyChars: Number(v.maxBodyChars),
  retentionDays: Number(v.retentionDays),
  approvalTtlHours: Number(v.approvalTtlHours),
  webhookAllowlist: v.webhookAllowlist,
  attachmentDirs: v.attachmentDirs,
  pairingEnabled: v.pairingEnabled,
  brokerUpstreams: v.brokerUpstreams,
  attachmentSaveDir: v.attachmentSaveDir.trim(),
});

const intError = (label: string, min: number, max: number) => (v: string) => {
  if (!/^\d+$/.test(v.trim())) return `${label} must be a whole number.`;
  const n = Number(v);
  if (n < min || n > max) return `${label} must be between ${min.toLocaleString()} and ${max.toLocaleString()}.`;
  return undefined;
};

const allowlistError = (v: string) => (v.length > 253 ? "too long" : /[/]/.test(v) && !/^[\d.:a-f]+\/\d{1,3}$/i.test(v) ? "use a hostname, IP or CIDR like 10.0.0.0/8" : null);

const dirError = (v: string) => (!v.startsWith("/") && !/^[a-z]:[\\/]/i.test(v) ? "use an absolute path, like /home/me/Documents" : v.length > 4096 ? "too long" : null);

export function SettingsForm({ settings, system }: { settings: Settings; system: SystemInfo | undefined }) {
  const qc = useQueryClient();
  const form = useForm({
    defaultValues: toForm(settings),
    onSubmit: async ({ value, formApi }) => {
      const next = fromForm(value);
      const patch = Object.fromEntries(
        Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(settings[k as keyof Settings])),
      ) as Partial<Settings>;
      try {
        const saved = await api<Settings>("/api/settings", { method: "PATCH", body: patch });
        qc.setQueryData(keys.settings, saved);
        for (const k of [keys.system, keys.googleClient, keys.setupState]) void qc.invalidateQueries({ queryKey: k });
        formApi.reset(toForm(saved));
        toast.success("Settings saved");
      } catch (err) {
        toastError(err, "Couldn't save settings");
      }
    },
  });

  const initial = JSON.stringify(toForm(settings));
  const [allowTyping, setAllowTyping] = useState(false);
  const [dirTyping, setDirTyping] = useState(false);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      noValidate
      className="space-y-6"
    >
      <Card>
        <CardHeader>
          <CardTitle>Public URL</CardTitle>
          <CardDescription>
            Where this instance is reachable. Used for the Google OAuth redirect and in the MCP URLs you give agents. Agents on other machines must be
            able to reach it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form.Field name="publicUrl" validators={{ onChange: ({ value }) => publicUrlError(value) }}>
            {(field) => (
              <Field data-invalid={!field.state.meta.isValid}>
                <FieldLabel htmlFor={field.name}>Public URL</FieldLabel>
                <Input
                  id={field.name}
                  className="font-mono"
                  inputMode="url"
                  spellCheck={false}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  aria-invalid={!field.state.meta.isValid}
                />
                {!field.state.meta.isValid ? (
                  <FieldError>{field.state.meta.errors.join(" ")}</FieldError>
                ) : (
                  <FieldDescription>MCP endpoint: {field.state.value.trim().replace(/\/+$/, "")}/mcp</FieldDescription>
                )}
                {system && system.addresses.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1" role="group" aria-label="Addresses this server is reachable at">
                    {[...new Set([window.location.origin, ...system.addresses])].map((a) => (
                      <Button
                        key={a}
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-auto flex-col items-start gap-0 py-1 text-left"
                        onClick={() => field.handleChange(a)}
                      >
                        <span className="text-[11px] font-normal text-muted-foreground">{addressLabel(a, window.location.origin)}</span>
                        <span className="font-mono text-xs">{a}</span>
                      </Button>
                    ))}
                  </div>
                )}
                {field.state.meta.isValid && analyzeUrl(field.state.value) && (
                  <UrlVerdict analysis={analyzeUrl(field.state.value)!} browserRemote={!isLoopbackOrigin(window.location.origin)} className="mt-1" />
                )}
                <RedirectNotice className="mt-2" />
              </Field>
            )}
          </form.Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mail sync</CardTitle>
          <CardDescription>How xaq learns about new mail.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <form.Field name="ingestMode">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Mode</FieldLabel>
                  <Select value={field.state.value} onValueChange={(v) => field.handleChange(v as IngestMode)}>
                    <SelectTrigger id={field.name} className="w-full sm:w-80">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pubsub">Real-time (Gmail push via Pub/Sub)</SelectItem>
                      <SelectItem value="poll">Polling</SelectItem>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {field.state.value === "pubsub"
                      ? "Needs Pub/Sub provisioned (see below). Gmail notifies within seconds."
                      : "Checks every account's history on an interval. No extra Google setup."}
                  </FieldDescription>
                </Field>
              )}
            </form.Field>
            <form.Field name="pollIntervalSeconds" validators={{ onChange: ({ value }) => intError("Poll interval", 5, 3600)(value) }}>
              {(field) => (
                <NumberField field={field} label="Poll interval" unit="seconds" description="How often polling checks each account. Real-time mode also polls at this interval while Pub/Sub isn't set up or is failing; otherwise it re-checks every 5 minutes." />
              )}
            </form.Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card id="calendar" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Google Calendar</CardTitle>
          <CardDescription>Lets agents read calendars, find free time, schedule events and answer invitations, per their access.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <CalendarSetupSummary />
            <form.Field name="calendarPollSeconds" validators={{ onChange: ({ value }) => intError("Calendar poll interval", 15, 3600)(value) }}>
              {(field) => (
                <NumberField
                  field={field}
                  label="Calendar poll interval"
                  unit="seconds"
                  description="How often synced calendars are checked for changes and new invitations. Calendars with a verified Google push channel are re-checked every 15 minutes instead."
                />
              )}
            </form.Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agents and retention</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="grid gap-6 sm:grid-cols-2">
            <form.Field name="maxBodyChars" validators={{ onChange: ({ value }) => intError("Max body characters", 0, 1_000_000)(value) }}>
              {(field) => (
                <NumberField
                  field={field}
                  label="Max body length"
                  unit="characters"
                  description="Per message returned to agents; longer bodies are truncated (and flagged). 0 = no limit."
                />
              )}
            </form.Field>
            <form.Field name="approvalTtlHours" validators={{ onChange: ({ value }) => intError("Approval expiry", 1, 720)(value) }}>
              {(field) => (
                <NumberField field={field} label="Approvals expire after" unit="hours" description="Unanswered requests are rejected and their drafts deleted." />
              )}
            </form.Field>
            <form.Field name="retentionDays" validators={{ onChange: ({ value }) => intError("Retention", 1, 3650)(value) }}>
              {(field) => (
                <NumberField field={field} label="Keep history for" unit="days" description="Events, webhook deliveries, audit entries and decided approvals older than this are deleted." />
              )}
            </form.Field>
            <form.Field
              name="attachmentSaveDir"
              validators={{ onChange: ({ value }) => (value.trim() && !value.trim().startsWith("/") ? "Use an absolute path, or leave it empty." : undefined) }}
            >
              {(field) => (
                <Field data-invalid={!field.state.meta.isValid} className="sm:col-span-2">
                  <FieldLabel htmlFor={field.name}>Attachment folder</FieldLabel>
                  <Input
                    id={field.name}
                    className="font-mono"
                    spellCheck={false}
                    placeholder="attachments/ in the data directory"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={!field.state.meta.isValid}
                  />
                  {!field.state.meta.isValid ? (
                    <FieldError>{field.state.meta.errors.join(" ")}</FieldError>
                  ) : (
                    <FieldDescription>
                      Where get_attachment saves files it can't show as text, on this server. Only files xaq saved there are ever deleted: after 7 days, or oldest first past 1 GB in total. It must be yours and not writable by everyone.
                    </FieldDescription>
                  )}
                </Field>
              )}
            </form.Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card id="pairing" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Agent pairing</CardTitle>
          <CardDescription>
            Lets an agent ask for access from its own terminal with <code className="font-mono text-xs">npx xaq-cli connect</code>, instead of you
            copying an API key.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form.Field name="pairingEnabled">
            {(field) => (
              <Field orientation="horizontal" className="items-start">
                <Switch id={field.name} checked={field.state.value} onCheckedChange={(v) => field.handleChange(v)} className="mt-0.5" />
                <div className="space-y-1">
                  <FieldLabel htmlFor={field.name}>Accept pairing requests</FieldLabel>
                  <FieldDescription>
                    {field.state.value
                      ? "Requests wait under Approvals → Agent access. Nothing gets access until you approve the matching code and choose its permissions; the key goes straight to the agent's terminal."
                      : "Off: connect is refused. You can still create agents under Agents and paste their key yourself."}
                  </FieldDescription>
                </div>
              </Field>
            )}
          </form.Field>
        </CardContent>
      </Card>

      <Card id="mcp-broker" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Connections (MCP broker)</CardTitle>
          <CardDescription>
            Lets your agents use other MCP servers and apps, like Notion, through xaq. xaq holds every sign-in and asks you before risky
            actions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form.Field name="brokerUpstreams">
            {(field) => (
              <Field orientation="horizontal" className="items-start">
                <Switch id={field.name} checked={field.state.value} onCheckedChange={(v) => field.handleChange(v)} className="mt-0.5" />
                <div className="space-y-1">
                  <FieldLabel htmlFor={field.name}>Use connections</FieldLabel>
                  <FieldDescription>
                    {field.state.value
                      ? "On: the Connections page is in the sidebar, and agents see the tools of the connections you give them."
                      : "Off: no connection's tools reach any agent and the Connections page is hidden. Your connections and their settings are kept."}
                  </FieldDescription>
                </div>
              </Field>
            )}
          </form.Field>
        </CardContent>
      </Card>

      <Card id="webhook-allowlist" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Webhook allowlist</CardTitle>
          <CardDescription>
            Webhooks may not target private, loopback or link-local addresses (this stops a webhook URL from probing your network), except hosts
            listed here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form.Field name="webhookAllowlist">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="allowlist">Allowed private hosts</FieldLabel>
                <ChipsInput id="allowlist" value={field.state.value} onChange={field.handleChange} placeholder="e.g. 10.0.0.0/8, n8n.internal" validate={allowlistError} onPendingChange={setAllowTyping} />
                <FieldDescription className="flex items-start gap-1.5">
                  <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Hostnames, IPs or CIDR ranges, e.g. <code className="font-mono">127.0.0.0/8</code>, <code className="font-mono">192.168.1.0/24</code>,{" "}
                    <code className="font-mono">n8n.internal</code>. Public hosts don't need to be listed.
                  </span>
                </FieldDescription>
              </Field>
            )}
          </form.Field>
        </CardContent>
      </Card>

      <Card id="attachment-dirs" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Attachments from files</CardTitle>
          <CardDescription>
            Directories on this machine whose files agents may attach to mail by path. Empty: agents can't attach files by path (they can still send
            bytes they have, another message's attachment or a Drive file).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form.Field name="attachmentDirs">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="attachment-dirs-input">Allowed directories</FieldLabel>
                <ChipsInput
                  id="attachment-dirs-input"
                  lines
                  value={field.state.value}
                  onChange={field.handleChange}
                  placeholder="e.g. /home/me/Documents/outgoing (Enter to add)"
                  validate={dirError}
                  onPendingChange={setDirTyping}
                />
                <FieldDescription className="flex items-start gap-1.5">
                  <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Absolute paths, one per entry; files in subdirectories count. Symlinks are followed only when they stay inside an allowed directory.
                    xaq's own data and configuration and files named like keys, databases or <code className="font-mono">.env</code> are always refused.
                    Also: <code className="font-mono">npx xaq-cli settings attachment-dirs add &lt;dir&gt;</code>.
                  </span>
                </FieldDescription>
              </Field>
            )}
          </form.Field>
        </CardContent>
      </Card>

      <form.Subscribe selector={(s) => [JSON.stringify(s.values) !== initial, s.canSubmit, s.isSubmitting] as const}>
        {([changed, canSubmit, submitting]) =>
          changed ? (
            <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur">
              <span className="text-sm">
                {allowTyping
                  ? "Add or clear the host you're typing in the allowlist first."
                  : dirTyping
                    ? "Add or clear the directory you're typing first."
                    : "You have unsaved changes."}
              </span>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => form.reset()}>
                  Discard
                </Button>
                <Button type="submit" disabled={!canSubmit || submitting || allowTyping || dirTyping}>
                  {submitting && <Spinner />} Save settings
                </Button>
              </div>
            </div>
          ) : null
        }
      </form.Subscribe>
    </form>
  );
}

interface NumberFieldApi {
  name: string;
  state: { value: string; meta: { isValid: boolean; errors: unknown[] } };
  handleBlur: () => void;
  handleChange: (v: string) => void;
}

function NumberField({ field, label, unit, description }: { field: NumberFieldApi; label: string; unit: string; description: string }) {
  return (
    <Field data-invalid={!field.state.meta.isValid}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <InputGroup className="w-full sm:w-56">
        <InputGroupInput
          id={field.name}
          inputMode="numeric"
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(e) => field.handleChange(e.target.value.replace(/[^\d]/g, ""))}
          aria-invalid={!field.state.meta.isValid}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>{unit}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      {!field.state.meta.isValid ? <FieldError>{field.state.meta.errors.join(" ")}</FieldError> : <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}
