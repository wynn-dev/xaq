import { AlertTriangleIcon, RefreshCwIcon, TerminalIcon, MousePointerClickIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { CodeBlock } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cloudUrl, generateProjectId, projectCommand, projectIdProblem } from "@/lib/gcp-project";
import { STEP_META, updateDraft, useSetupProgress } from "./progress";
import type { StepProps } from "./step-url";
import { CloudLink, Disclosure, Expect, FormValues, GoogleTabNote, Guide, GuideStep, Path, StepCard, StepFooter } from "./wizard-shell";

export { cloudUrl, projectCommand, projectIdProblem } from "@/lib/gcp-project";

export function StepProject(props: StepProps) {
  const { state } = useSetupProgress();
  // Once the OAuth client is saved, the server owns the project ID: just show it.
  if (state?.gcpProjectId) return <ProjectSaved {...props} projectId={state.gcpProjectId} />;
  return <ProjectSetup {...props} />;
}

function ProjectSaved({ index, onBack, onNext, projectId }: StepProps & { projectId: string }) {
  return (
    <StepCard
      index={index}
      title={STEP_META.project.title}
      description="xaq signs in to Gmail through your own Google Cloud project."
      footer={<StepFooter onBack={onBack} onNext={onNext} />}
    >
      <p className="text-sm">
        xaq uses the project <code className="font-mono font-medium">{projectId}</code> (saved with the OAuth client in step 4).
      </p>
      <div className="flex flex-wrap gap-2">
        <CloudLink href={cloudUrl.dashboard(projectId)}>Open the project</CloudLink>
        <CloudLink href={cloudUrl.enableGmail(projectId)}>Check the Gmail API is enabled</CloudLink>
        <CloudLink href={cloudUrl.enableCalendar(projectId)}>Check the Calendar API is enabled</CloudLink>
      </div>
      <p className="text-xs text-muted-foreground">
        To move to another project, create an OAuth client there and import it in step 4; the project ID comes with it.
      </p>
    </StepCard>
  );
}

function ProjectSetup({ index, onBack, onNext }: StepProps) {
  const { state, draft } = useSetupProgress();
  const mode = draft.projectMode ?? "new";
  const method = draft.projectMethod ?? "shell";
  const inOrg = !!draft.projectInOrg;

  // A project ID ready to go, generated once and kept (the command must stay the same after a reload).
  useEffect(() => {
    if (!draft.newProjectId) updateDraft({ newProjectId: generateProjectId() });
  }, [draft.newProjectId]);
  const newId = draft.newProjectId ?? "";
  const [existingId, setExistingId] = useState(draft.existingProjectId ?? (mode === "existing" ? (state?.gcpProjectId ?? draft.projectId ?? "") : ""));
  const [touched, setTouched] = useState(false);

  const id = mode === "new" ? newId.trim() : existingId.trim();
  const problem = projectIdProblem(id);
  const valid = !problem;
  const command = projectCommand(id, inOrg);

  const next = () => {
    setTouched(true);
    if (!valid) return;
    updateDraft({ projectId: id, projectConfirmed: true, projectMode: mode });
    onNext();
  };

  return (
    <StepCard
      index={index}
      title={STEP_META.project.title}
      description="xaq signs in to Gmail through your own Google Cloud project, so your mail never passes through anyone else's. Free; no billing account needed."
      footer={
        <StepFooter
          onBack={onBack}
          onNext={next}
          nextDisabled={touched && !valid}
          nextLabel={mode === "new" ? "I've created it" : "Continue"}
          hint={touched && problem ? "Fix the project ID first" : undefined}
        />
      }
    >
      <GoogleTabNote />

      {mode === "new" ? (
        <>
          <Field data-invalid={!!problem} className="max-w-md">
            <FieldLabel htmlFor="new-project-id">Project ID</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="new-project-id"
                className="font-mono"
                spellCheck={false}
                autoComplete="off"
                value={newId}
                onChange={(e) => updateDraft({ newProjectId: e.target.value.trim() })}
                aria-invalid={!!problem}
                aria-describedby="new-project-id-hint"
              />
              <Button type="button" variant="outline" onClick={() => updateDraft({ newProjectId: generateProjectId() })}>
                <RefreshCwIcon /> New ID
              </Button>
            </div>
            <div id="new-project-id-hint">
              {problem ? (
                <FieldError>{problem}</FieldError>
              ) : (
                <FieldDescription>
                  Project IDs are unique across Google and permanent. If Google says this one is taken, click New ID and run the command again.
                  The project name (xaq) is just a label.
                </FieldDescription>
              )}
            </div>
          </Field>

          <ToggleGroup
            type="single"
            variant="outline"
            className="flex-wrap"
            value={method}
            onValueChange={(v) => v && updateDraft({ projectMethod: v as "shell" | "console" })}
            aria-label="How to create the project"
          >
            <ToggleGroupItem value="shell">
              <TerminalIcon /> One command (recommended)
            </ToggleGroupItem>
            <ToggleGroupItem value="console">
              <MousePointerClickIcon /> Click through the console
            </ToggleGroupItem>
          </ToggleGroup>

          {method === "shell" ? (
            <Guide>
              <GuideStep
                title="Open Cloud Shell"
                expect="Cloud Shell in a new tab, filled by a terminal. The first time it can take a minute to start, and Google may ask you to pick your country and accept the terms."
              >
                <p>A free terminal in your browser, already signed in to Google Cloud. Nothing to install.</p>
                <CloudLink href={cloudUrl.cloudShell}>Open Cloud Shell</CloudLink>
              </GuideStep>
              <GuideStep title="Paste this command and press Enter">
                <p>It creates the project and turns on the Gmail and Google Calendar APIs in it.</p>
                <div className="flex items-start gap-2">
                  <Checkbox id="project-in-org" checked={inOrg} onCheckedChange={(v) => updateDraft({ projectInOrg: v === true })} className="mt-0.5" />
                  <Label htmlFor="project-in-org" className="flex-1 text-sm leading-snug font-normal text-foreground">
                    I use Google Workspace and want only my organization's accounts to connect (creates the project inside your organization, so
                    “Internal” is available in the next step)
                  </Label>
                </div>
                {command ? <CodeBlock code={command} wrap copyLabel="Copy command" /> : <p className="text-critical">Fix the project ID above first.</p>}
                <Expect>
                  maybe an “Authorize Cloud Shell” prompt (click <strong className="text-foreground">Authorize</strong>), then after about a minute{" "}
                  <code className="font-mono text-foreground">xaq: project {id || "…"} is ready</code>.
                </Expect>
                <Disclosure summary="The command printed an error?">
                  <ul className="list-disc space-y-1.5 pl-5">
                    <li>
                      <strong className="text-foreground">“already in use” or “already exists”</strong>: someone has this ID. Click{" "}
                      <strong className="text-foreground">New ID</strong> above, copy the command again and run it.
                    </li>
                    <li>
                      <strong className="text-foreground">Terms of Service</strong> or <strong className="text-foreground">country</strong>: open{" "}
                      <a className="underline" href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">
                        console.cloud.google.com
                      </a>{" "}
                      once, accept, then run the command again.
                    </li>
                    <li>
                      <strong className="text-foreground">quota</strong> (too many projects): Google limits how many projects you can create, and
                      deleted projects still count for 30 days. Reuse a project you already have (
                      <strong className="text-foreground">Use an existing project instead (advanced)</strong> below), or{" "}
                      <a className="underline" href="https://support.google.com/code/contact/project_quota_increase" target="_blank" rel="noopener noreferrer">
                        request more quota
                      </a>
                      {inOrg && " or your organization's Quotas page"}.
                    </li>
                    <li>
                      <strong className="text-foreground">--organization</strong> errors: untick the Workspace box above, or ask your Workspace
                      admin for the “Project Creator” role.
                    </li>
                    <li>
                      The project was created but enabling failed: run only the second part again, or use the enable links for{" "}
                      <a className="underline" href={cloudUrl.enableGmail(id)} target="_blank" rel="noopener noreferrer">
                        Gmail
                      </a>{" "}
                      and{" "}
                      <a className="underline" href={cloudUrl.enableCalendar(id)} target="_blank" rel="noopener noreferrer">
                        Calendar
                      </a>
                      .
                    </li>
                  </ul>
                </Disclosure>
              </GuideStep>
            </Guide>
          ) : (
            <Guide>
              <GuideStep
                title="Create the project"
                expect={
                  <>
                    a notification “Create Project: xaq”, then <strong className="text-foreground">Select project</strong>.
                  </>
                }
              >
                <p>Open the form and fill it in like this:</p>
                <FormValues
                  rows={[
                    { label: "Project name", value: "xaq" },
                    {
                      label: "Project ID",
                      value: id,
                      note: "Click Edit under the name to change the suggested ID, and paste this one.",
                    },
                    {
                      label: "Location / Organization",
                      note: "Personal @gmail.com: “No organization” is fine. Google Workspace: keep your organization (needed for Internal).",
                    },
                  ]}
                />
                <p>
                  Click <strong className="text-foreground">Create</strong>. Ignore “Start free trial” or billing banners: billing isn't needed.
                </p>
                <CloudLink href={cloudUrl.createProject}>Open Create a project</CloudLink>
              </GuideStep>
              <EnableApis id={id} valid={valid} disabledReason="Fix the project ID above first" />
            </Guide>
          )}

          <Disclosure summary="Use an existing project instead (advanced)">
            <p>
              A dedicated project is safer: xaq shares a project's sign-in screen, limits and settings with every other app in it. Only
              reuse a project if you can't create one.
            </p>
            <Button variant="outline" size="sm" onClick={() => updateDraft({ projectMode: "existing" })}>
              Use an existing project
            </Button>
          </Disclosure>
        </>
      ) : (
        <>
          <ReuseRisks />
          <Guide>
            <GuideStep title="Enter the existing project's ID" done={valid}>
              <p>
                Find it in Google Cloud's project picker (the <strong className="text-foreground">ID</strong> column) or on the project's Dashboard
                under <Path items={["Project info", "Project ID"]} />. Not the name, not the number.
              </p>
              <Field data-invalid={touched && !!problem} className="max-w-sm">
                <FieldLabel htmlFor="gcp-project">Project ID</FieldLabel>
                <Input
                  id="gcp-project"
                  className="font-mono"
                  placeholder="my-project-123456"
                  spellCheck={false}
                  autoComplete="off"
                  value={existingId}
                  onChange={(e) => {
                    setExistingId(e.target.value);
                    updateDraft({ existingProjectId: e.target.value.trim() });
                  }}
                  onBlur={() => existingId.trim() && setTouched(true)}
                  onKeyDown={(e) => e.key === "Enter" && next()}
                  aria-invalid={touched && !!problem}
                  aria-describedby="gcp-project-hint"
                />
                <div id="gcp-project-hint">
                  {(touched || existingId.trim()) && problem ? (
                    <FieldError>{problem}</FieldError>
                  ) : (
                    <FieldDescription>The links in the next steps open in this project.</FieldDescription>
                  )}
                </div>
              </Field>
            </GuideStep>
            <EnableApis id={id} valid={valid} disabledReason="Enter the project ID first" existing />
          </Guide>
          <Button variant="link" className="h-auto px-0" onClick={() => updateDraft({ projectMode: "new" })}>
            Create a new project instead (recommended)
          </Button>
        </>
      )}
    </StepCard>
  );
}

/** The console path for step 2's APIs: one enable link each (Gmail is required, Calendar adds the calendar tools). */
function EnableApis({ id, valid, disabledReason, existing }: { id: string; valid: boolean; disabledReason: string; existing?: boolean }) {
  return (
    <GuideStep
      title="Turn on the Gmail and Google Calendar APIs"
      expect={existing ? "a confirmation that each API is enabled (or that it already was)." : "a confirmation that each API is enabled."}
    >
      <p>
        {existing ? "Each link opens in that project." : "Each link opens in your new project."} Confirm the project, then click{" "}
        <strong className="text-foreground">Next</strong> and <strong className="text-foreground">Enable</strong>. Do both.
      </p>
      <div className="flex flex-wrap gap-2">
        <CloudLink href={valid ? cloudUrl.enableGmail(id) : "#"} disabled={!valid}>
          Enable the Gmail API
        </CloudLink>
        <CloudLink href={valid ? cloudUrl.enableCalendar(id) : "#"} disabled={!valid} disabledReason={disabledReason}>
          Enable the Calendar API
        </CloudLink>
      </div>
    </GuideStep>
  );
}

function ReuseRisks() {
  return (
    <Alert variant="warning">
      <AlertTriangleIcon />
      <AlertTitle>Reusing a project: what xaq shares with the other apps in it</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          <li>One sign-in screen: its name, logo and support email, audience (Internal/External) and publishing status.</li>
          <li>Switching it back to Testing makes every app's sign-ins expire after 7 days.</li>
          <li>Unverified apps are capped at 100 users per project, shared by all its apps.</li>
          <li>Users see one entry for the project under their Google account's third-party access: removing it cuts off both apps.</li>
          <li>API quotas, and deleting or locking the project, affect both.</li>
        </ul>
        <p className="pt-1 font-medium text-foreground">If you reuse it:</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>Don't rename or rebrand the existing sign-in screen; leave it as it is.</li>
          <li>Create a separate OAuth client for xaq, and don't touch the other app's client.</li>
        </ul>
      </AlertDescription>
    </Alert>
  );
}
