import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SKILL_URL_PLACEHOLDER = "{{XAQ_URL}}";
export const SKILL_NAME = "xaq";

/** Agent skill directories `skill install --target` knows by name. */
export const SKILL_TARGETS = {
  claude: () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills"),
  codex: () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills"),
  agents: () => join(homedir(), ".agents", "skills"),
} as const;

let template: string | undefined;

/**
 * The SKILL.md template. Source runs read server/skill/SKILL.md next to this module; the bundle
 * (dist/cli.js) reads the copy tsdown places in dist/skill/.
 */
export function skillTemplate(): string {
  if (template !== undefined) return template;
  const candidates = [join(import.meta.dirname, "SKILL.md"), join(import.meta.dirname, "skill", "SKILL.md")];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error(`SKILL.md not found (looked in ${candidates.join(", ")})`);
  template = readFileSync(file, "utf8");
  return template;
}

/** SKILL.md with the instance URL filled in (no trailing slash). */
export function renderSkill(url: string): string {
  return skillTemplate().replaceAll(SKILL_URL_PLACEHOLDER, url.replace(/\/+$/, ""));
}

/** The skills directory `--target` names (a known agent name or a path). */
const skillsDir = (target: string) => {
  const known = SKILL_TARGETS[target as keyof typeof SKILL_TARGETS];
  return known ? known() : resolve(target);
};

/** Resolves `--target` (a known agent name or a skills directory) to the SKILL.md path to write. */
export function skillPath(target: string): string {
  return join(skillsDir(target), SKILL_NAME, "SKILL.md");
}

/** The line in our SKILL.md that marks it as written by xaq-cli. */
export const SKILL_MARKER = "<!-- xaq-cli skill: written by `xaq skill install`, which may replace it. -->";

/** Whether a SKILL.md is ours: `name: xaq` in its frontmatter, plus our marker line. */
export function isOurSkill(text: string): boolean {
  const front = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  return /^name:\s*xaq\s*$/m.test(front) && text.includes(SKILL_MARKER);
}

/**
 * Writes SKILL.md, but never over a `xaq` skill that isn't ours: another program called xaq may have one.
 * Throws instead, saying what to do.
 */
export function writeSkill(path: string, content: string): void {
  let existing: string | null = null;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    // Nothing there yet.
  }
  if (existing !== null && !isOurSkill(existing)) {
    throw new Error(
      `${path} already exists and isn't the xaq-cli skill (another program called xaq may have put it there), so it was left alone. ` +
        "Install into another skills directory with --target <dir>, or move that file away first.",
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
