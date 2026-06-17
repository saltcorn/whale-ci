import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Scalar,
  type YAMLMap,
} from "yaml";
import { runShell, type ShellResult } from "./proc.ts";

/** Runs a host shell command and returns its exit code and stdout. */
export type Shell = (command: string) => Promise<ShellResult>;

/** A value that is exactly one `$(...)` shell substitution (matching the runner). */
const SHELL_SUBST = /^\$\((.*)\)$/s;

/**
 * Re-render a config file with every value the runner evaluates on the host
 * shown in its evaluated form, to help debug a pipeline definition. The build
 * does not run: only the host-side evaluations are performed.
 *
 * The original document — its key order, formatting and comments — is preserved
 * (it is mutated in place rather than re-serialised from the parsed config), and
 * only the evaluated parts change:
 *
 * * a `push.tag` of the form `$(command)` is replaced by the command's trimmed
 *   stdout (exactly what the push would use), with the original kept as a
 *   trailing comment;
 * * a step `only-if` and a `push.only-if` are run and annotated with whether
 *   they pass, since that decides whether the step runs / the image is pushed.
 *
 * Disabled steps are left untouched: they never run, so nothing is evaluated
 * for them. Bare `$VAR` references elsewhere are also left as-is because the
 * runner never expands them — only `$(...)` push tags and the `only-if` shell
 * commands reach the host shell.
 */
export async function dumpEvaluatedConfig(
  text: string,
  shell: Shell = runShell,
): Promise<string> {
  const doc = parseDocument(text);
  if (isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      const step = pair.value;
      if (isMap(step) && !isDisabled(step)) {
        await evaluateStep(step, shell);
      }
    }
  }
  return doc.toString();
}

/** A step is disabled when it sets `disable: true`; such steps never run. */
function isDisabled(step: YAMLMap): boolean {
  const disable: unknown = step.get("disable", true);
  return isScalar(disable) && disable.value === true;
}

/** Evaluate and annotate the host-evaluated parts of a single step's map. */
async function evaluateStep(step: YAMLMap, shell: Shell): Promise<void> {
  await annotateCondition(
    step.get("only-if", true),
    shell,
    " evaluates true → step runs",
    (code) => ` evaluates false (exit ${code}) → step skipped`,
  );

  const push: unknown = step.get("push", true);
  if (!isMap(push)) return;

  const tag: unknown = push.get("tag", true);
  if (isScalar(tag)) {
    await substituteTag(tag, shell);
  } else if (isSeq(tag)) {
    for (const item of tag.items) {
      if (isScalar(item)) await substituteTag(item, shell);
    }
  }

  await annotateCondition(
    push.get("only-if", true),
    shell,
    " evaluates true → image pushed",
    (code) => ` evaluates false (exit ${code}) → push skipped`,
  );
}

/**
 * Run a string `only-if` scalar as a host shell command and attach a trailing
 * comment describing whether it passed (the command itself is left unchanged,
 * since it is a condition rather than a substituted value).
 */
async function annotateCondition(
  node: unknown,
  shell: Shell,
  passed: string,
  failed: (code: number) => string,
): Promise<void> {
  if (!isScalar(node) || typeof node.value !== "string") return;
  const { code } = await shell(node.value);
  node.comment = code === 0 ? passed : failed(code);
}

/**
 * Replace a single `$(command)` push-tag scalar with the command's trimmed
 * stdout, keeping the original as a trailing comment. A command that fails or
 * prints nothing — which would fail the real push — is left in place and the
 * comment notes why, so the problem is visible in the dump.
 */
async function substituteTag(node: Scalar, shell: Shell): Promise<void> {
  if (typeof node.value !== "string") return;
  const command = SHELL_SUBST.exec(node.value)?.[1];
  if (command === undefined) return;

  const original = node.value;
  const { code, stdout } = await shell(command);
  const tag = stdout.trim();
  if (code !== 0) {
    node.comment = ` ${original} → command failed (exit ${code})`;
  } else if (tag === "") {
    node.comment = ` ${original} → command produced no output`;
  } else {
    node.value = tag;
    node.comment = ` was: ${original}`;
  }
}
