import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, CheckIcon } from "lucide-react";
import { BROKER_STEP_IDS, BROKER_STEP_META } from "@/components/setup/first-run";
import { STEP_IDS, STEP_META, useSetupProgress } from "@/components/setup/progress";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/** Shown on the overview until setup is done; each item jumps into the wizard. */
export function SetupChecklist() {
  const { statuses, finished, total, firstTodo, allDone, state, view, broker, brokerTodo } = useSetupProgress();
  if (!state || allDone) return null;
  if (view !== "google") {
    // First run with Google optional: the question, or the short path's two steps.
    return (
      <Card className="border-chart-1/30 bg-chart-1/[0.03]">
        <CardHeader>
          <CardTitle>Finish setting up xaq</CardTitle>
          <CardDescription>
            {view === "choose" ? "Choose what to connect first: Notion, any MCP server, or Gmail & Calendar." : `${finished} of ${total} steps done.`}
          </CardDescription>
          <CardAction>
            <Button asChild>
              <Link to="/get-started" search={brokerTodo ? { path: brokerTodo } : {}}>
                Continue setup <ArrowRightIcon />
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
        {view === "broker" && (
          <CardContent>
            <ol className="flex flex-wrap gap-4 text-sm">
              {BROKER_STEP_IDS.map((id, i) => (
                <li key={id} className={cn("flex items-center gap-2", broker[id] === "done" && "text-muted-foreground line-through decoration-muted-foreground/40")}>
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full border text-[10px] tabular",
                      broker[id] === "done" && "border-success bg-success text-white",
                    )}
                  >
                    {broker[id] === "done" ? <CheckIcon className="size-3" /> : i + 1}
                  </span>
                  {BROKER_STEP_META[id].short}
                </li>
              ))}
            </ol>
          </CardContent>
        )}
      </Card>
    );
  }
  return (
    <Card className="border-chart-1/30 bg-chart-1/[0.03]">
      <CardHeader>
        <CardTitle>Finish setting up xaq</CardTitle>
        <CardDescription>
          {finished} of {total} steps done. Pick up where you left off.
        </CardDescription>
        <CardAction>
          <Button asChild>
            <Link to="/get-started" search={firstTodo ? { step: firstTodo } : {}}>
              Continue setup <ArrowRightIcon />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={(finished / total) * 100} aria-label="Setup progress" />
        <ol className="grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
          {STEP_IDS.map((id, i) => (
            <li key={id}>
              <Link
                to="/get-started"
                search={{ step: id }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular",
                    statuses[id] === "done" && "border-success bg-success text-white",
                    id === firstTodo && "border-primary",
                  )}
                  aria-hidden
                >
                  {statuses[id] === "done" ? <CheckIcon className="size-3" /> : i + 1}
                </span>
                <span className={cn(statuses[id] === "todo" ? "text-foreground" : "text-muted-foreground line-through decoration-muted-foreground/40")}>
                  {STEP_META[id].short}
                </span>
                <span className="sr-only">({statuses[id]})</span>
              </Link>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
