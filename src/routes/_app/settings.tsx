import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { LogOutIcon, RocketIcon } from "lucide-react";
import { PageHeader, QueryError } from "@/components/common";
import { GoogleClientCard } from "@/components/settings/google-client-card";
import { PasswordCard } from "@/components/settings/password-card";
import { SettingsForm } from "@/components/settings/settings-form";
import { SystemCard } from "@/components/settings/system-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSignOut } from "@/hooks/use-sign-out";
import { queries } from "@/lib/queries";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const settings = useQuery(queries.settings());
  const system = useQuery(queries.system());
  const signOut = useSignOut();

  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <Button variant="outline" asChild>
            <Link to="/get-started">
              <RocketIcon /> Setup guide
            </Link>
          </Button>
        }
      />
      {settings.isPending ? (
        <div className="space-y-6">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : settings.isError ? (
        <QueryError error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <SettingsForm settings={settings.data} system={system.data} />
      )}

      <GoogleClientCard />

      <div className="grid gap-6 lg:grid-cols-2">
        <PasswordCard />
        <SystemCard />
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">Session</div>
            <p className="text-sm text-muted-foreground">Signs out this browser. Agents keep working.</p>
          </div>
          <Button variant="outline" onClick={signOut}>
            <LogOutIcon /> Sign out
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
