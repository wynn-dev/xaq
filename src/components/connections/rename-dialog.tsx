import { renameWarning, slugProblem } from "@shared/connection-rename";
import type { ConnectionView } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";

/** "Change short name": PATCH /api/connections/:id {slug}. Exposed tool names follow. */
export function RenameSlugDialog({ connection: c, open, onOpenChange }: { connection: ConnectionView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [slug, setSlug] = useState(c.slug);
  const all = useQuery(queries.connections());
  const next = slug.trim().toLowerCase();
  const problem = next === c.slug ? null : slugProblem(next, c, all.data ?? []);
  const save = useApiMutation({
    mutationFn: (s: string) => api<ConnectionView>(`/api/connections/${encodeURIComponent(c.id)}`, { method: "PATCH", body: { slug: s } }),
    invalidate: [keys.connections, ["agent-connections"]],
    success: (v) => `Its tools are now ${v.slug}__…`,
    errorTitle: "Couldn't change the short name",
    onSuccess: () => onOpenChange(false),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== c.slug && !problem) save.mutate(next);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setSlug(c.slug);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Change {c.name}'s short name</DialogTitle>
            <DialogDescription>
              Agents see its tools as <code className="font-mono">{c.slug}__…</code>.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!problem}>
            <FieldLabel htmlFor="rename-slug">Short name</FieldLabel>
            <Input id="rename-slug" className="font-mono" autoFocus autoComplete="off" value={slug} onChange={(e) => setSlug(e.target.value)} aria-invalid={!!problem} />
            {problem ? <FieldError>{problem}</FieldError> : <FieldDescription>1-24 lowercase letters, digits and dashes.</FieldDescription>}
          </Field>
          {next !== c.slug && !problem && (
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertDescription>{renameWarning(c.slug, next)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={next === c.slug || !!problem || save.isPending}>
              {save.isPending && <Spinner />} Change short name
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
