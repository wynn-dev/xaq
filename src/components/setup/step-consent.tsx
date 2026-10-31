import type { GoogleAppType, GoogleClientView } from "@shared/types";
import { CALENDAR_SCOPES, GMAIL_SCOPE } from "@shared/google-scopes";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, BuildingIcon, GlobeIcon, InfoIcon } from "lucide-react";
import { ChoiceCards } from "@/components/choice-cards";
import { CodeBlock } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { STEP_META, updateDraft, useSetupProgress } from "./progress";
import { cloudUrl } from "./step-project";
import type { StepProps } from "./step-url";
import { CloudLink, Disclosure, FormValues, GoogleTabNote, Guide, GuideStep, Path, StepCard, StepFooter } from "./wizard-shell";

export const UNVERIFIED_PATH = ["Google hasn't verified this app", "Advanced", "Go to xaq (unsafe)"];

export function StepConsent({ index, onBack, onNext }: StepProps) {
  const { state, draft } = useSetupProgress();
  const client = useQuery(queries.googleClient());
  const project = state?.gcpProjectId ?? draft.projectId ?? "";
  const appType: GoogleAppType | undefined = state?.googleAppType ?? draft.appType ?? undefined;
  const production =
    draft.productionConfirmed ?? (state?.googleAppType === "external" && !state.warnings?.some((w) => w.code === "testing_mode"));
  const reusing = draft.projectMode === "existing";
  const blocked = !appType || (appType === "external" && !production);

  // Once the client is saved the server owns the app type: change it there right away.
  const saveType = useApiMutation({
    mutationFn: (v: { client: GoogleClientView; appType: GoogleAppType }) =>
      api<GoogleClientView>("/api/google/client", {
        method: "PUT",
        body: { clientId: v.client.clientId, projectId: v.client.projectId ?? "", appType: v.appType },
      }),
    invalidate: [keys.googleClient, keys.setupState],
    errorTitle: "Couldn't change the audience",
  });

  // Saved as soon as it's picked, so a trip to Google Cloud and back (or a reload) keeps it.
  const choose = (t: GoogleAppType) => {
    updateDraft({ appType: t });
    if (client.data?.clientId && client.data.appType !== t) saveType.mutate({ client: client.data, appType: t });
  };

  return (
    <StepCard
      index={index}
      title={STEP_META.consent.title}
      description="Google shows this screen when you connect a Google account to xaq. You set it up once: who may connect, and the name they see."
      footer={
        <StepFooter
          onBack={onBack}
          onNext={onNext}
          nextDisabled={blocked}
          hint={!appType ? "Choose who can connect" : appType === "external" && !production ? "Publish the app, then tick the box" : undefined}
        />
      }
    >
      <GoogleTabNote />
      {reusing && (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>Reused project: don't change its existing sign-in screen</AlertTitle>
          <AlertDescription>
            If Google Auth Platform opens on an <strong>Overview</strong> page (not “Get started”), the screen already exists for the other app.
            Leave its name, logo and support email alone, skip step 2 below, and just check its Audience page: pick the option here that matches
            it.
          </AlertDescription>
        </Alert>
      )}
      <Guide>
        <GuideStep title="Choose who can connect" done={!!appType}>
          <p>You'll pick the same option in Google Cloud. Saved as soon as you choose.</p>
          <ChoiceCards
            aria-label="Who can connect"
            value={appType}
            onChange={choose}
            columns={2}
            choices={[
              {
                value: "external",
                icon: GlobeIcon,
                title: "External",
                badge: <Badge variant="secondary">@gmail.com</Badge>,
                description:
                  "Any Google account, including personal @gmail.com. You publish the app once (below), or sign-ins expire after 7 days. Google shows an “unverified app” notice when you connect: expected for your own app.",
              },
              {
                value: "internal",
                icon: BuildingIcon,
                title: "Internal",
                badge: <Badge variant="secondary">Workspace</Badge>,
                description:
                  "Only accounts in your Google Workspace organization. Nothing to publish, no unverified-app notice. Sign-ins still end on a password change, after 6 months unused, or by admin policy (reconnect then).",
              },
            ]}
          />
          {appType === "internal" && (
            <p className="flex items-start gap-1.5 text-xs">
              <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                Internal is only offered when the project belongs to your organization. Greyed out in Google Cloud? The project was created
                under “No organization”: choose External instead.
              </span>
            </p>
          )}
        </GuideStep>

        <GuideStep
          title="Open Google Auth Platform and click Get started"
          expect={
            <>
              the Overview page with a <strong className="text-foreground">Create OAuth client</strong> button.
            </>
          }
        >
          <CloudLink href={cloudUrl.authOverview(project)} disabled={!project} disabledReason="Enter the project ID in step 2 first">
            Open Google Auth Platform
          </CloudLink>
          <p>Google asks four things, one page each:</p>
          <FormValues
            rows={[
              { label: "1. App information", value: "xaq", copyLabel: "Copy app name", note: "Paste as the App name. User support email: your own address. Then Next." },
              {
                label: "2. Audience",
                note: (
                  <>
                    Choose <strong className="text-foreground">{appType === "internal" ? "Internal" : appType === "external" ? "External" : "the option you picked above"}</strong>, then Next.
                  </>
                ),
              },
              { label: "3. Contact information", note: "Your email address, then Next." },
              {
                label: "4. Finish",
                note: (
                  <>
                    Tick “I agree to the Google API Services: User Data Policy”, then <Path items={["Continue", "Create"]} />.
                  </>
                ),
              },
            ]}
          />
        </GuideStep>

        {appType === "external" && (
          <GuideStep
            title="Publish the app"
            done={production}
            expect={
              <>
                “Publishing status: <strong className="text-foreground">In production</strong>” and a “Back to testing” button.
              </>
            }
          >
            <p>
              New apps start in Testing, where Google ends every sign-in after 7 days. Publishing fixes that; you don't submit anything to Google.
            </p>
            <p>
              On the Audience page: <Path items={["Publish app", "Push to production?", "Confirm"]} />. If the dialog mentions verification, ignore
              it: that's for apps used by the public, not your own.
            </p>
            <CloudLink href={cloudUrl.authAudience(project)} disabled={!project} disabledReason="Enter the project ID in step 2 first">
              Open Audience
            </CloudLink>
            {reusing && <p className="text-xs">Already “In production”? Nothing to change.</p>}
            <div className="flex items-start gap-2 pt-1">
              <Checkbox
                id="in-production"
                checked={production}
                onCheckedChange={(v) => updateDraft({ productionConfirmed: v === true })}
                className="mt-0.5"
              />
              <Label htmlFor="in-production" className="flex-1 text-sm leading-snug font-normal text-foreground">
                The Audience page says “Publishing status: In production”
              </Label>
            </div>
          </GuideStep>
        )}
      </Guide>

      <DataAccess project={project} appType={appType} />
    </StepCard>
  );
}

const DATA_ACCESS_SCOPES = [GMAIL_SCOPE, ...CALENDAR_SCOPES].join("\n");

/**
 * The Data access page: optional, since xaq asks for each scope when an account connects. Listing
 * them there is what Google's own overview shows; for External apps it also names them on the consent screen.
 */
function DataAccess({ project, appType }: { project: string; appType: GoogleAppType | undefined }) {
  return (
    <Disclosure
      summary="List Gmail and Google Calendar on the Data access page"
      badge={<Badge variant="outline">{appType === "external" ? "Recommended" : "Optional"}</Badge>}
    >
      <p>
        xaq asks for this access when you connect an account and works the same either way. Listing it here makes Google Cloud show
        what the app uses{appType === "external" ? ", and the sign-in screen name it" : ""}. Google calls Gmail a “restricted” scope and the
        Calendar ones “sensitive”; for your own app that just means the unverified-app notice.
      </p>
      <p>
        <Path items={["Data access", "Add or remove scopes"]} />, paste these under “Manually add scopes”, then{" "}
        <Path items={["Add to table", "Update", "Save"]} />. The first is Gmail; the other three are Calendar's events, calendar list and
        free/busy.
      </p>
      <CodeBlock code={DATA_ACCESS_SCOPES} wrap copyLabel="Copy scopes" />
      <CloudLink href={cloudUrl.authScopes(project)} disabled={!project}>
        Open Data access
      </CloudLink>
    </Disclosure>
  );
}

