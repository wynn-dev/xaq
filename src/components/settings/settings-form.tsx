import type { Settings, SystemInfo } from "@shared/types";
import { publicUrlProblem } from "@shared/public-url";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { CalendarSetupSummary } from "@/components/google/calendar-setup";
import { RedirectNotice } from "@/components/google/redirect-notice";
import { UrlVerdict } from "@/components/setup/step-url";
import { api, toastError } from "@/lib/api";
import { addressLabel, analyzeUrl, isLoopbackOrigin } from "@/lib/public-url";
import { keys } from "@/lib/queries";

interface FormValues {
  publicUrl: string;
  pollIntervalSeconds: string;
  calendarPollSeconds: string;
  maxBodyChars: string;
  retentionDays: string;
  approvalTtlHours: string;
  pairingEnabled: boolean;
}

const toForm = (s: Settings): FormValues => ({
  publicUrl: s.publicUrl,
  pollIntervalSeconds: String(s.pollIntervalSeconds),
  calendarPollSeconds: String(s.calendarPollSeconds),
  maxBodyChars: String(s.maxBodyChars),
  retentionDays: String(s.retentionDays),
  approvalTtlHours: String(s.approvalTtlHours),
  pairingEnabled: s.pairingEnabled,
});

// The patch below only carries changed fields.
const fromForm = (v: FormValues): Settings => ({
  publicUrl: v.publicUrl.trim().replace(/\/+$/, ""),
  pollIntervalSeconds: Number(v.pollIntervalSeconds),
  calendarPollSeconds: Number(v.calendarPollSeconds),
  maxBodyChars: Number(v.maxBodyChars),
  retentionDays: Number(v.retentionDays),
  approvalTtlHours: Number(v.approvalTtlHours),
  pairingEnabled: v.pairingEnabled,
});

const intError = (label: string, min: number, max: number) => (v: string) => {
  if (!/^\d+$/.test(v.trim())) return `${label} must be a whole number.`;
  const n = Number(v);
  if (n < min || n > max) return `${label} must be between ${min.toLocaleString()} and ${max.toLocaleString()}.`;
  return undefined;
};


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
          <form.Field name="publicUrl" validators={{ onChange: ({ value }) => publicUrlProblem(value) }}>
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
          <CardDescription>How often xaq checks every account for new mail.</CardDescription>
        </CardHeader>
        <CardContent>
          <form.Field name="pollIntervalSeconds" validators={{ onChange: ({ value }) => intError("Poll interval", 5, 3600)(value) }}>
            {(field) => <NumberField field={field} label="Poll interval" unit="seconds" description="How often each account's mail history is checked." />}
          </form.Field>
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
                  description="How often synced calendars are checked for changes and new invitations."
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
                <NumberField field={field} label="Keep history for" unit="days" description="Events, audit entries and decided approvals older than this are deleted." />
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

      <form.Subscribe selector={(s) => [JSON.stringify(s.values) !== initial, s.canSubmit, s.isSubmitting] as const}>
        {([changed, canSubmit, submitting]) =>
          changed ? (
            <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur">
              <span className="text-sm">
                You have unsaved changes.
              </span>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => form.reset()}>
                  Discard
                </Button>
                <Button type="submit" disabled={!canSubmit || submitting}>
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
