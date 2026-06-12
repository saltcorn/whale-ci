import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CiServer, serverConfigFromEnv, verifyCheckout } from "../lib/server.ts";
import type { CommitState, StatusReporter } from "../lib/github.ts";
import type { GitClient } from "../lib/git.ts";
import { ConfigError } from "../lib/types.ts";

const SECRET = "topsecret";

/** Records the git operations a CI job performs, with optional injected faults. */
class FakeGit implements GitClient {
  readonly calls: string[] = [];
  fetchError: Error | undefined;
  /** Artificial duration of each git op, so concurrent ops would overlap. */
  opDelayMs = 0;
  /** Git ops running right now, and the high-water mark across the run. */
  inFlight = 0;
  maxInFlight = 0;
  #root: string | undefined;

  constructor(root: string | undefined) {
    this.#root = root;
  }

  async repoRoot(): Promise<string | undefined> {
    return this.#root;
  }
  async fetch(_dir: string, ref: string): Promise<void> {
    await this.#op(`fetch ${ref}`, this.fetchError);
  }
  async addWorktree(_dir: string, path: string, commit: string): Promise<void> {
    await this.#op(`add ${commit} ${path}`);
  }
  async removeWorktree(_dir: string, path: string): Promise<void> {
    await this.#op(`remove ${path}`);
  }

  /** Record a call and track concurrency, optionally pausing then faulting. */
  async #op(label: string, fault?: Error): Promise<void> {
    this.calls.push(label);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.opDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.opDelayMs));
      }
      if (fault) throw fault;
    } finally {
      this.inFlight--;
    }
  }
}

/** Records every commit status posted. */
class FakeStatus implements StatusReporter {
  readonly states: CommitState[] = [];
  readonly reports: Array<{ sha: string; state: CommitState; description: string }> = [];
  async report(
    _repo: string,
    sha: string,
    state: CommitState,
    description: string,
  ): Promise<void> {
    this.states.push(state);
    this.reports.push({ sha, state, description });
  }
}

interface Harness {
  server: CiServer;
  git: FakeGit;
  status: FakeStatus;
  runDirs: string[];
}

/** Start a CiServer on an ephemeral port with the given run outcome. */
async function startServer(
  run: (dir: string) => Promise<boolean>,
  git = new FakeGit("/repo"),
): Promise<Harness> {
  const status = new FakeStatus();
  const runDirs: string[] = [];
  const server = new CiServer({
    repoRoot: "/repo",
    configFile: "ci.yml",
    secret: SECRET,
    worktreeRoot: "/tmp/dockci-worktrees",
    git,
    status,
    run: (dir) => {
      runDirs.push(dir);
      return run(dir);
    },
    log: () => {},
  });
  await server.listen(0);
  return { server, git, status, runDirs };
}

/** POST a webhook to the running server with a (correct by default) signature. */
async function postWebhook(
  server: CiServer,
  event: string,
  payload: unknown,
  opts: { secret?: string; signature?: string } = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = opts.signature ??
    "sha256=" +
      createHmac("sha256", opts.secret ?? SECRET).update(body).digest("hex");
  return await fetch(`http://127.0.0.1:${server.port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
    body,
  });
}

const PUSH = {
  ref: "refs/heads/feature/x",
  after: "deadbeefcafe1234",
  repository: { full_name: "owner/repo" },
};

test("serverConfigFromEnv reads and validates the four env vars", () => {
  const env = serverConfigFromEnv({
    GITHUB_TOKEN: "tok",
    WEBHOOK_SECRET: "sec",
    WORKTREE_ROOT: "/wt",
    LISTEN_PORT: "8080",
  });
  assert.deepEqual(env, {
    githubToken: "tok",
    webhookSecret: "sec",
    worktreeRoot: "/wt",
    listenPort: 8080,
  });
});

test("serverConfigFromEnv rejects a missing variable", () => {
  assert.throws(
    () =>
      serverConfigFromEnv({
        WEBHOOK_SECRET: "sec",
        WORKTREE_ROOT: "/wt",
        LISTEN_PORT: "8080",
      }),
    /GITHUB_TOKEN/,
  );
});

test("serverConfigFromEnv rejects a non-numeric or out-of-range port", () => {
  const base = { GITHUB_TOKEN: "t", WEBHOOK_SECRET: "s", WORKTREE_ROOT: "/wt" };
  assert.throws(() => serverConfigFromEnv({ ...base, LISTEN_PORT: "abc" }), /LISTEN_PORT/);
  assert.throws(() => serverConfigFromEnv({ ...base, LISTEN_PORT: "0" }), /LISTEN_PORT/);
  assert.throws(() => serverConfigFromEnv({ ...base, LISTEN_PORT: "99999" }), /LISTEN_PORT/);
});

test("verifyCheckout requires a git checkout rooted at cwd with the config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dockci-"));
  writeFileSync(join(dir, "ci.yml"), "build:\n  image: alpine\n");

  // Not a git checkout at all.
  await assert.rejects(
    () => verifyCheckout(new FakeGit(undefined), dir, "ci.yml"),
    ConfigError,
  );
  // A checkout whose root is somewhere else.
  await assert.rejects(
    () => verifyCheckout(new FakeGit(tmpdir()), dir, "ci.yml"),
    /root of the git checkout/,
  );
  // The config file is missing from the checkout root.
  await assert.rejects(
    () => verifyCheckout(new FakeGit(dir), dir, "missing.yml"),
    /not found/,
  );
  // Happy path returns the resolved root.
  assert.equal(await verifyCheckout(new FakeGit(dir), dir, "ci.yml"), dir);
});

test("a non-POST request is rejected", async () => {
  const { server } = await startServer(async () => true);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/webhook`);
    assert.equal(res.status, 405);
  } finally {
    await server.close();
  }
});

test("a request outside /webhook is not found", async () => {
  const { server, git } = await startServer(async () => true);
  try {
    for (const path of ["/", "/other"]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: "POST",
      });
      assert.equal(res.status, 404);
    }
    // A query string does not change the route.
    const res = await fetch(
      `http://127.0.0.1:${server.port}/webhook?x=1`,
    );
    assert.equal(res.status, 405);
    await server.drain();
    assert.deepEqual(git.calls, []);
  } finally {
    await server.close();
  }
});

test("a ping is answered without starting a job", async () => {
  const { server, git } = await startServer(async () => true);
  try {
    const res = await postWebhook(server, "ping", { zen: "hi" });
    assert.equal(res.status, 200);
    await server.drain();
    assert.deepEqual(git.calls, []);
  } finally {
    await server.close();
  }
});

test("an invalid signature is rejected and starts no job", async () => {
  const { server, git, status } = await startServer(async () => true);
  try {
    const res = await postWebhook(server, "push", PUSH, { signature: "sha256=bad" });
    assert.equal(res.status, 401);
    await server.drain();
    assert.deepEqual(git.calls, []);
    assert.deepEqual(status.states, []);
  } finally {
    await server.close();
  }
});

test("a successful push runs CI in a worktree and reports success", async () => {
  const { server, git, status, runDirs } = await startServer(async () => true);
  try {
    const res = await postWebhook(server, "push", PUSH);
    assert.equal(res.status, 202);
    await server.drain();

    // Fetched the branch, added a worktree on the exact sha, ran it, removed it.
    assert.deepEqual(git.calls, [
      "fetch feature/x",
      `add deadbeefcafe1234 ${runDirs[0]}`,
      `remove ${runDirs[0]}`,
    ]);
    // The worktree directory carries a slug of the branch and the short sha.
    assert.match(runDirs[0]!, /feature-x-deadbeefcafe-0$/);
    assert.deepEqual(status.states, ["pending", "success"]);
  } finally {
    await server.close();
  }
});

test("a failing pipeline reports failure but still cleans up", async () => {
  const { server, git, status } = await startServer(async () => false);
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    assert.deepEqual(status.states, ["pending", "failure"]);
    assert.ok(git.calls.some((c) => c.startsWith("remove ")));
  } finally {
    await server.close();
  }
});

test("a git/pipeline error reports error and skips a never-made worktree", async () => {
  const git = new FakeGit("/repo");
  git.fetchError = new Error("network down");
  const { server, status } = await startServer(async () => true, git);
  try {
    await postWebhook(server, "push", PUSH);
    await server.drain();
    assert.deepEqual(status.states, ["pending", "error"]);
    // The worktree was never created, so it must not be removed.
    assert.ok(!git.calls.some((c) => c.startsWith("remove ")));
  } finally {
    await server.close();
  }
});

test("concurrent pushes get distinct worktrees", async () => {
  // A run that blocks until released, so both jobs are in flight at once.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { server, runDirs } = await startServer(async () => {
    await gate;
    return true;
  });
  try {
    await postWebhook(server, "push", PUSH);
    await postWebhook(server, "push", {
      ...PUSH,
      ref: "refs/heads/other",
      after: "f00df00df00d",
    });
    // Give both requests a tick to reach the run() stub before releasing.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(runDirs.length, 2);
    assert.notEqual(runDirs[0], runDirs[1]);
    release();
    await server.drain();
  } finally {
    await server.close();
  }
});

test("git operations on the shared checkout never overlap across concurrent pushes", async () => {
  const git = new FakeGit("/repo");
  // Stretch each git op so two unsynchronised jobs would overlap in time.
  git.opDelayMs = 20;
  // Hold both pipelines in flight at once so their git ops have the chance to.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { server } = await startServer(async () => {
    await gate;
    return true;
  }, git);
  try {
    await postWebhook(server, "push", PUSH);
    await postWebhook(server, "push", {
      ...PUSH,
      ref: "refs/heads/other",
      after: "f00df00df00d",
    });
    // Let both jobs work through fetch + add and park in the blocked run().
    await new Promise((r) => setTimeout(r, 100));
    release();
    await server.drain();
    // The lock kept fetch/add/remove strictly one-at-a-time across both jobs.
    assert.equal(git.maxInFlight, 1);
    // Both jobs still completed their full git sequence.
    assert.equal(git.calls.filter((c) => c.startsWith("fetch ")).length, 2);
    assert.equal(git.calls.filter((c) => c.startsWith("remove ")).length, 2);
  } finally {
    await server.close();
  }
});

test("an unhandled event type is ignored", async () => {
  const { server, git } = await startServer(async () => true);
  try {
    const res = await postWebhook(server, "issues", { action: "opened" });
    assert.equal(res.status, 204);
    await server.drain();
    assert.deepEqual(git.calls, []);
  } finally {
    await server.close();
  }
});
