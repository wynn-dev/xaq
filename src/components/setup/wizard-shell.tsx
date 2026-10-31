import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, ChevronRightIcon, ExternalLinkIcon, EyeIcon } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { CopyButton, Wrapped } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { STEP_IDS, STEP_META, type StepId, type StepStatus } from "./progress";

function StepMarker({ index, status, current }: { index: number; status: StepStatus; current: boolean }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular transition-colors",
        status === "done" && "border-success bg-success text-white",
        status === "todo" && current && "border-primary bg-primary text-primary-foreground",
        status === "todo" && !current && "bg-background text-muted-foreground",
      )}
      aria-hidden
    >
      {status === "done" ? <CheckIcon className="size-3.5" /> : index + 1}
    </span>
  );
}

const STATUS_TEXT: Record<StepStatus, string> = { done: "done", todo: "to do" };

/** Vertical stepper on large screens; a compact progress bar + step picker on small ones. */
export function WizardNav({ current, statuses, onSelect }: { current: StepId; statuses: Record<StepId, StepStatus>; onSelect: (id: StepId) => void }) {
  const done = STEP_IDS.filter((id) => statuses[id] !== "todo").length;
  const index = STEP_IDS.indexOf(current);
  return (
    <>
      <div className="space-y-3 lg:hidden">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Step {index + 1} of {STEP_IDS.length}
          </span>
          <span>{done} done</span>
        </div>
        <Progress value={(done / STEP_IDS.length) * 100} aria-label="Setup progress" />
        <Select value={current} onValueChange={(v) => onSelect(v as StepId)}>
          <SelectTrigger className="w-full" aria-label="Jump to step">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STEP_IDS.map((id, i) => (
              <SelectItem key={id} value={id}>
                {i + 1}. {STEP_META[id].short}
                {statuses[id] === "done" ? " ✓" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <nav aria-label="Setup steps" className="hidden lg:block">
        <ol className="space-y-1">
          {STEP_IDS.map((id, i) => {
            const active = id === current;
            return (
              <li key={id} className="relative">
                {i < STEP_IDS.length - 1 && (
                  <span
                    aria-hidden
                    className={cn("absolute top-9 left-[1.4rem] h-[calc(100%-1.75rem)] w-px", statuses[id] === "done" ? "bg-success/50" : "bg-border")}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onSelect(id)}
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "relative flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                    active && "bg-muted",
                  )}
                >
                  <StepMarker index={i} status={statuses[id]} current={active} />
                  <span className="min-w-0">
                    <span className={cn("block truncate", active ? "font-medium" : "text-muted-foreground")}>{STEP_META[id].short}</span>
                  </span>
                  <span className="sr-only">({STATUS_TEXT[statuses[id]]})</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}

// The step the wizard showed last: when a different one mounts, the user moved between steps and
// focus goes to its heading (so keyboard and screen reader users start at the top of the new step).
let lastStepShown: number | null = null;

export function StepCard({
  index,
  title,
  description,
  children,
  footer,
  total,
}: {
  index: number;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
  footer: React.ReactNode;
  /** Steps on this path (the short broker path has 2); default the Google wizard's. */
  total?: number;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (lastStepShown !== null && lastStepShown !== index) heading.current?.focus({ preventScroll: true });
    lastStepShown = index;
  }, [index]);
  return (
    <Card className="gap-0 py-0" aria-labelledby="wizard-step-title">
      <div className="space-y-1.5 border-b p-5 sm:p-6">
        <div className="text-xs font-medium text-muted-foreground">
          Step {index + 1} of {total ?? STEP_IDS.length}
        </div>
        <h2 id="wizard-step-title" ref={heading} tabIndex={-1} className="rounded-sm text-xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {title}
        </h2>
        <div className="max-w-2xl text-sm text-muted-foreground">{description}</div>
      </div>
      <CardContent className="space-y-6 p-5 sm:p-6">{children}</CardContent>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 p-4 sm:px-6">{footer}</div>
    </Card>
  );
}

export function StepFooter({
  onBack,
  onNext,
  nextLabel = "Continue",
  nextDisabled,
  nextVariant = "default",
  pending,
  extra,
  hint,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: React.ReactNode;
  nextDisabled?: boolean;
  /** "outline" when the step's own primary action is in its body (one primary button per screen). */
  nextVariant?: "default" | "outline";
  pending?: boolean;
  extra?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <>
      <div>
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeftIcon /> Back
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {hint && (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {hint}
          </span>
        )}
        {extra}
        <Button onClick={onNext} disabled={nextDisabled || pending} variant={nextVariant}>
          {pending && <Spinner />}
          {nextLabel} {!pending && <ArrowRightIcon />}
        </Button>
      </div>
    </>
  );
}

/** Numbered instructions for things done outside xaq (in Google Cloud). */
export function Guide({ children }: { children: React.ReactNode }) {
  return <ol className="space-y-6 [counter-reset:guide]">{children}</ol>;
}

export function GuideStep({
  title,
  children,
  done,
  expect,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  done?: boolean;
  /** What the user should see in Google Cloud once this is done. */
  expect?: React.ReactNode;
}) {
  return (
    <li className="relative flex gap-3 [counter-increment:guide]">
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted text-xs font-medium tabular before:content-[counter(guide)]",
          done && "border-success bg-success text-white before:content-['✓']",
        )}
      />
      <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
        <div className="text-sm font-medium">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </div>
        {children && <div className="space-y-2.5 text-sm text-muted-foreground">{children}</div>}
        {expect && <Expect>{expect}</Expect>}
      </div>
    </li>
  );
}

/** "You should see …": how the user knows a step in Google Cloud worked. */
export function Expect({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">
      <EyeIcon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        <span className="font-medium text-foreground">You should see: </span>
        {children}
      </span>
    </p>
  );
}

/** Click path in Google's UI, e.g. <Path items={["Audience", "Publish app"]} />. */
export function Path({ items }: { items: string[] }) {
  return (
    <span className="text-foreground">
      {items.map((it, i) => (
        <Fragment key={it}>
          {i > 0 && <span aria-hidden className="px-1 text-muted-foreground">→</span>}
          {i > 0 && <span className="sr-only">, then </span>}
          <strong className="font-medium">{it}</strong>
        </Fragment>
      ))}
    </span>
  );
}

/** Label → exact value to type in a Google form, with copy buttons. */
export function FormValues({ rows }: { rows: { label: string; value?: string; note?: React.ReactNode; copyLabel?: string }[] }) {
  return (
    <dl className="divide-y rounded-lg border text-sm">
      {rows.map((r) => (
        <div key={r.label} className="grid gap-1 px-3 py-2 sm:grid-cols-[11rem_1fr] sm:items-center sm:gap-3">
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className="min-w-0 space-y-1 text-foreground">
            {r.value !== undefined && (
              <div className="flex min-w-0 items-center gap-1">
                <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[13px] whitespace-pre-wrap select-all">
                  <Wrapped text={r.value} />
                </code>
                <CopyButton value={r.value} label={r.copyLabel ?? `Copy ${r.label.toLowerCase()}`} />
              </div>
            )}
            {r.note && <div className="text-xs text-muted-foreground">{r.note}</div>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A collapsed section (native <details>): optional extras, troubleshooting, advanced paths. */
export function Disclosure({
  summary,
  children,
  defaultOpen,
  className,
  badge,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  badge?: React.ReactNode;
}) {
  return (
    <details className={cn("group rounded-lg border", className)} open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground outline-none select-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
        <span className="min-w-0 flex-1">{summary}</span>
        {badge}
      </summary>
      <div className="space-y-3 border-t px-3 py-3 text-sm text-muted-foreground">{children}</div>
    </details>
  );
}

/** Said once per Google step: where the links go and which account to use. */
export function GoogleTabNote() {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <ExternalLinkIcon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        Links open Google Cloud in a new tab; come back to this tab when you're done. Sign in with the Google account that will own the project
        (check the avatar at the top right).
      </span>
    </p>
  );
}

/** A deep link into Google Cloud Console, styled as a button. */
export function CloudLink({
  href,
  children,
  disabled,
  disabledReason,
  variant = "outline",
}: {
  href: string;
  children: React.ReactNode;
  disabled?: boolean;
  /** Shown next to a disabled link, so it's clear what unlocks it. */
  disabledReason?: string;
  variant?: "outline" | "default";
}) {
  if (disabled) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Button variant={variant} size="sm" disabled>
          {children}
          <ExternalLinkIcon />
        </Button>
        {disabledReason && <span className="text-xs text-muted-foreground">{disabledReason}</span>}
      </span>
    );
  }
  return (
    <Button variant={variant} size="sm" asChild>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
        <ExternalLinkIcon />
        <span className="sr-only">(opens Google Cloud in a new tab)</span>
      </a>
    </Button>
  );
}
