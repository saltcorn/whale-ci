import assert from "node:assert/strict";
import { test } from "node:test";
import { dumpEvaluatedConfig, type Shell } from "../lib/dump.ts";

/**
 * A fake host shell that returns canned `{ code, stdout }` results per command,
 * and records the commands it was asked to run. Unknown commands succeed with
 * empty output.
 */
function fakeShell(
  responses: Record<string, { code?: number; stdout?: string }>,
): Shell & { calls: string[] } {
  const calls: string[] = [];
  const shell = (async (command: string) => {
    calls.push(command);
    const r = responses[command] ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "" };
  }) as Shell & { calls: string[] };
  shell.calls = calls;
  return shell;
}

test("replaces a $(...) push tag with its evaluated output", async () => {
  const text = `build:
  dockerfile: ./Dockerfile
  push:
    image: myorg/app
    tag: $(git rev-parse --short HEAD)
`;
  const shell = fakeShell({
    "git rev-parse --short HEAD": { stdout: "1d9355e\n" },
  });
  const out = await dumpEvaluatedConfig(text, shell);
  assert.match(out, /tag: 1d9355e # was: \$\(git rev-parse --short HEAD\)/);
  assert.deepEqual(shell.calls, ["git rev-parse --short HEAD"]);
});

test("evaluates every tag in a list of push tags", async () => {
  const text = `build:
  dockerfile: ./Dockerfile
  push:
    image: myorg/app
    tag:
      - latest
      - $(git rev-parse --short HEAD)
`;
  const shell = fakeShell({
    "git rev-parse --short HEAD": { stdout: "abc1234" },
  });
  const out = await dumpEvaluatedConfig(text, shell);
  assert.match(out, /- latest\n/);
  assert.match(out, /- abc1234 # was: \$\(git rev-parse --short HEAD\)/);
});

test("notes a push tag command that fails, leaving the value in place", async () => {
  const text = `build:
  dockerfile: ./Dockerfile
  push:
    image: myorg/app
    tag: $(false)
`;
  const out = await dumpEvaluatedConfig(text, fakeShell({ false: { code: 1 } }));
  assert.match(out, /tag: \$\(false\) # \$\(false\) → command failed \(exit 1\)/);
});

test("notes a push tag command that produces no output", async () => {
  const text = `build:
  dockerfile: ./Dockerfile
  push:
    image: myorg/app
    tag: $(true)
`;
  const out = await dumpEvaluatedConfig(text, fakeShell({ true: { stdout: "  \n" } }));
  assert.match(out, /tag: \$\(true\) # \$\(true\) → command produced no output/);
});

test("annotates a passing step only-if", async () => {
  const text = `build:
  dockerfile: ./Dockerfile
  only-if: test 1 = 1
`;
  const out = await dumpEvaluatedConfig(text, fakeShell({ "test 1 = 1": { code: 0 } }));
  assert.match(out, /only-if: test 1 = 1 # evaluates true → step runs/);
});

test("annotates a failing step only-if with its exit code", async () => {
  const text = `build:
  dockerfile: ./Dockerfile
  only-if: test 1 = 2
`;
  const out = await dumpEvaluatedConfig(text, fakeShell({ "test 1 = 2": { code: 1 } }));
  assert.match(out, /only-if: test 1 = 2 # evaluates false \(exit 1\) → step skipped/);
});

test("annotates a push only-if", async () => {
  const text = `build:
  dockerfile: ./Dockerfile
  push:
    image: myorg/app
    only-if: test main = main
`;
  const out = await dumpEvaluatedConfig(
    text,
    fakeShell({ "test main = main": { code: 0 } }),
  );
  assert.match(out, /only-if: test main = main # evaluates true → image pushed/);
});

test("leaves disabled steps untouched and does not evaluate them", async () => {
  const text = `build:
  dockerfile: ./Dockerfile
  disable: true
  only-if: should-not-run
  push:
    image: myorg/app
    tag: $(should-not-run)
`;
  const shell = fakeShell({});
  const out = await dumpEvaluatedConfig(text, shell);
  assert.deepEqual(shell.calls, []);
  assert.match(out, /tag: \$\(should-not-run\)/);
});

test("preserves comments, key order and unrelated formatting", async () => {
  const text = `# a pipeline
build:
  # build it
  dockerfile: ./Dockerfile
  environment:
    FOO: bar
`;
  const out = await dumpEvaluatedConfig(text, fakeShell({}));
  assert.match(out, /# a pipeline/);
  assert.match(out, /# build it/);
  assert.match(out, /FOO: bar/);
});

test("leaves a bare $VAR reference unevaluated", async () => {
  const text = `build:
  dockerfile: ./Dockerfile
  push:
    image: myorg/app
    tag: $HOME
`;
  const shell = fakeShell({});
  const out = await dumpEvaluatedConfig(text, shell);
  assert.deepEqual(shell.calls, []);
  assert.match(out, /tag: \$HOME/);
});
