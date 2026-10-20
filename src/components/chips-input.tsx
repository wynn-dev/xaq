import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Free-form list input: type a value and press Enter, comma or space to add it; Backspace removes the last.
 * `validate` returns an error message for a bad value (shown inline, value not added).
 */
export function ChipsInput({
  id,
  value,
  onChange,
  placeholder,
  validate,
  className,
  onPendingChange,
  lines = false,
  "aria-describedby": describedBy,
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  validate?: (v: string) => string | null;
  className?: string;
  /** Told whether text is typed but not added yet (or invalid), so forms can refuse to save around it. */
  onPendingChange?: (pending: boolean) => void;
  /** One entry per line (Enter adds it), for values that may contain spaces or commas, such as paths. */
  lines?: boolean;
  "aria-describedby"?: string;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pending = !!draft.trim();
  const notify = useRef(onPendingChange);
  useEffect(() => {
    notify.current = onPendingChange;
  });
  useEffect(() => {
    notify.current?.(pending);
  }, [pending]);
  useEffect(() => () => notify.current?.(false), []);

  const commit = (raw: string) => {
    const parts = raw
      .split(lines ? /[\r\n]+/ : /[\s,;]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return true;
    for (const p of parts) {
      const err = validate?.(p) ?? null;
      if (err) {
        setError(`${p}: ${err}`);
        return false;
      }
    }
    onChange([...new Set([...value, ...parts])]);
    setDraft("");
    setError(null);
    return true;
  };

  return (
    <div className="space-y-1.5">
      <div
        className={cn(
          "flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring dark:bg-input/30",
          error && "border-destructive ring-3 ring-destructive/20",
          className,
        )}
        onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}
      >
        {value.map((v) => (
          <Badge key={v} variant="secondary" className="h-6 gap-1 pr-1 font-mono text-xs font-normal">
            {v}
            <button
              type="button"
              className="rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(value.filter((x) => x !== v))}
            >
              <XIcon className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          id={id}
          className="h-6 min-w-32 flex-1 bg-transparent px-1 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
          value={draft}
          placeholder={value.length ? "" : placeholder}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || (!lines && (e.key === "," || (e.key === " " && draft.trim())))) {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => draft.trim() && commit(draft)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if ((lines ? /[\r\n]/ : /[\s,;]/).test(text)) {
              e.preventDefault();
              commit(draft + text);
            }
          }}
        />
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        pending && <p className="text-xs text-warning">Press Enter to add “{draft.trim()}”, or clear it.</p>
      )}
    </div>
  );
}
