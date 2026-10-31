import type { Webhook, WebhookWithSecret } from "@shared/types";
import { useLabelNames } from "@/hooks/use-label-names";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, BotIcon, KeyRoundIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useCalendarNames } from "@/components/webhooks/calendar-list";
import { CopyField, QueryError, TimeAgo } from "@/components/common";
import { confirm } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { DeliveryLog } from "@/components/webhooks/delivery-log";
import { VerificationSnippets } from "@/components/webhooks/secret-reveal";
import { SecretDialog } from "@/components/webhooks/secret-dialog";
import { SendTest } from "@/components/webhooks/send-test";
import { WebhookStats } from "@/components/webhooks/webhook-bits";
import { WebhookSheet } from "@/components/webhooks/webhook-sheet";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { describeWebhook } from "@/lib/webhook-filter";

export const Route = createFileRoute("/_app/webhooks/$webhookId")({
  component: WebhookPage,
});

function WebhookPage() {
  const { webhookId } = Route.useParams();
  const webhooks = useQuery(queries.webhooks());
  const w = webhooks.data?.find((x) => x.id === webhookId);

  if (webhooks.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-80" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }
  if (webhooks.isError) return <QueryError error={webhooks.error} onRetry={() => void webhooks.refetch()} />;
  if (!w) {
    return (
      <Card>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Webhook not found</EmptyTitle>
            <EmptyDescription>It may have been deleted.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link to="/webhooks">All webhooks</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </Card>
    );
  }
  return <WebhookDetail webhook={w} />;
}

function WebhookDetail({ webhook: w }: { webhook: Webhook }) {
  const navigate = useNavigate();
  const agents = useQuery(queries.agents());
  const accounts = useQuery(queries.accounts());
  const labelName = useLabelNames(accounts.data ?? []);
  const calendarName = useCalendarNames(w.filter.calendarIds?.length ? (w.filter.accountIds ?? (accounts.data ?? []).map((a) => a.id)) : []);
  const [editing, setEditing] = useState(false);
  const [rotated, setRotated] = useState<string>();
  const agent = agents.data?.find((a) => a.id === w.agentId);
  const path = `/api/webhooks/${encodeURIComponent(w.id)}`;

  const toggle = useApiMutation({
    mutationFn: (enabled: boolean) => api<Webhook>(path, { method: "PATCH", body: { enabled } }),
    invalidate: [keys.webhooks],
    success: (_, on) => (on ? "Webhook enabled" : "Webhook paused"),
    errorTitle: "Couldn't update the webhook",
  });
  const rotate = useApiMutation({
    mutationFn: () => api<WebhookWithSecret>(`${path}/rotate-secret`, { method: "POST" }),
    invalidate: [keys.webhooks],
    errorTitle: false,
    onSuccess: (res) => setRotated(res.secret),
  });
  const remove = useApiMutation({
    mutationFn: () => api(path, { method: "DELETE" }),
    invalidate: [keys.webhooks],
    success: `Webhook "${w.name}" deleted`,
    errorTitle: false,
    onSuccess: () => void navigate({ to: "/webhooks" }),
  });

  const askRotate = () =>
    confirm({
      title: "Rotate the signing secret?",
      description: "A new secret is created and signatures made with the old one stop verifying. Update your receiver right after.",
      confirmLabel: "Rotate secret",
      onConfirm: () => rotate.mutateAsync(),
    });
  const askDelete = () =>
    confirm({
      title: `Delete ${w.name}?`,
      description: "Pending retries are cancelled and the delivery log is removed. This can't be undone.",
      confirmLabel: "Delete webhook",
      destructive: true,
      onConfirm: () => remove.mutateAsync(),
    });

  return (
    <>
      <div className="space-y-4">
        <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
          <Link to="/webhooks">
            <ArrowLeftIcon /> Webhooks
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{w.name}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {agent && (
                <Link to="/agents/$agentId" params={{ agentId: agent.id }} className="flex items-center gap-1 hover:text-foreground hover:underline">
                  <BotIcon className="size-3.5" /> {agent.name}
                </Link>
              )}
              <span className="flex items-center gap-1 font-mono">
                <KeyRoundIcon className="size-3.5" /> {w.secretPrefix}…
              </span>
              <span>
                Created <TimeAgo date={w.createdAt} />
              </span>
            </div>
            <WebhookStats webhook={w} className="pt-1" />
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch id="wh-enabled" checked={w.enabled} disabled={toggle.isPending} onCheckedChange={(on) => toggle.mutate(on)} />
              <Label htmlFor="wh-enabled">{w.enabled ? "Enabled" : "Paused"}</Label>
            </div>
            <Button variant="outline" onClick={() => setEditing(true)}>
              <PencilIcon /> Edit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Webhook actions">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={askRotate}>
                  <KeyRoundIcon /> Rotate secret…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={askDelete}>
                  <Trash2Icon /> Delete webhook…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>What it sends</CardTitle>
            <CardDescription>POSTs JSON to:</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <CopyField value={w.url} />
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {describeWebhook(w, accounts.data ?? [], labelName, calendarName).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Test it</CardTitle>
            <CardDescription>Check your endpoint is reachable and verifies the signature.</CardDescription>
          </CardHeader>
          <CardContent>
            <SendTest webhookId={w.id} />
          </CardContent>
        </Card>
      </div>

      <DeliveryLog webhookId={w.id} />

      <Card>
        <CardHeader>
          <CardTitle>Verifying signatures</CardTitle>
        </CardHeader>
        <CardContent>
          <VerificationSnippets />
        </CardContent>
      </Card>

      <WebhookSheet open={editing} onOpenChange={setEditing} webhook={w} />
      <SecretDialog
        secret={rotated}
        title="New signing secret"
        description="The old secret no longer verifies. Update your receiver with this one."
        onClose={() => setRotated(undefined)}
      />
    </>
  );
}
