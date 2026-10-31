import type { Address, Approval, AttachmentSource } from "@shared/types";
import { ChevronDownIcon, PaperclipIcon } from "lucide-react";
import { useState } from "react";
import { ToneBadge } from "@/components/common";
import { Visible } from "@/components/hidden-chars";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";
import { fmtAddress, fmtBytes, fmtDuration } from "@/lib/format";
import { approvalStatusInfo } from "@/lib/labels";
import { cn } from "@/lib/utils";

export function ApprovalStatusBadge({ status, kind }: { status: Approval["status"]; kind: Approval["kind"] }) {
  const s = approvalStatusInfo(status, kind);
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

/** Live "expires in 2h 13m", turning amber in the last hour. */
export function ExpiryCountdown({ expiresAt }: { expiresAt: string }) {
  const now = useNow(1000);
  const left = new Date(expiresAt).getTime() - now;
  if (left <= 0) return <span className="text-critical">Expired</span>;
  return (
    <span className={cn("tabular", left < 3600_000 && "font-medium text-warning")} title={new Date(expiresAt).toLocaleString()}>
      Expires in {fmtDuration(left)}
    </span>
  );
}

export function Recipients({ approval: a }: { approval: Approval }) {
  const rows: [string, Address[]][] = [
    ["To", a.to],
    ["Cc", a.cc],
    ["Bcc", a.bcc],
  ];
  return (
    <dl className="grid grid-cols-[2.5rem_1fr] gap-y-1 text-sm">
      {rows
        .filter(([, list]) => list.length > 0)
        .map(([k, list]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words">
              <Visible text={list.map(fmtAddress).join(", ")} />
            </dd>
          </div>
        ))}
    </dl>
  );
}

/**
 * The message body exactly as the agent wrote it, shown as plain text (never as HTML), so nothing
 * hidden or rendered differently can slip past review. Long bodies collapse.
 */
export function BodyPreview({ body, className }: { body: string; className?: string }) {
  const long = body.length > 1200 || body.split("\n").length > 24;
  const [expanded, setExpanded] = useState(!long);
  return (
    <div className={cn("relative rounded-lg border bg-muted/30", className)}>
      <pre className={cn("overflow-x-auto p-3 font-sans text-sm leading-relaxed whitespace-pre-wrap break-words", !expanded && "max-h-80 overflow-hidden")}>
        {body ? <Visible text={body} /> : <span className="text-muted-foreground italic">(empty body)</span>}
      </pre>
      {long && (
        <div className={cn("flex justify-center p-2", !expanded && "absolute inset-x-0 bottom-0 rounded-b-lg bg-gradient-to-t from-card via-card/90 to-transparent pt-10")}>
          <Button variant="outline" size="sm" onClick={() => setExpanded(!expanded)}>
            <ChevronDownIcon className={cn("transition-transform", expanded && "rotate-180")} />
            {expanded ? "Collapse" : "Show full message"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Where an attached file came from, in words. */
export function attachmentSourceText(source: AttachmentSource | undefined): string | null {
  switch (source?.kind) {
    case "message":
      return `from message ${source.messageId} (its attachment ${source.filename})`;
    case "forward":
      return `original file of message ${source.messageId}`;
    case "upload":
      return "sent by the agent in the call";
    default:
      return null;
  }
}

export function Attachments({ items }: { items: Approval["attachments"] }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((f, i) => {
        const source = attachmentSourceText(f.source);
        return (
          <li key={i} className="flex max-w-full flex-col gap-0.5 rounded-md border px-2 py-1 text-xs">
            <span className="flex items-center gap-1.5">
              <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="max-w-48 truncate">
                <Visible text={f.filename} />
              </span>
              {f.mimeType && (
                <span className="max-w-40 truncate text-muted-foreground">
                  <Visible text={f.mimeType} />
                </span>
              )}
              <span className="text-muted-foreground">{fmtBytes(f.size)}</span>
            </span>
            {source && (
              <span className="break-all text-muted-foreground">
                <Visible text={source} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
