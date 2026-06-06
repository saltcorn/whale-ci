import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { type GitClient, slugifyBranch } from "./git.ts";
import { parsePushEvent, type PushEvent, type StatusReporter, verifySignature } from "./github.ts";
import { runPipeline } from "./runner.ts";
import { ConfigError } from "./types.ts";

/** The configuration read from the environment when starting the server. */
export interface ServerEnv {
  /** Token used to post commit statuses back to GitHub. */
  githubToken: string;
  /** Shared secret used to verify webhook signatures. */
  webhookSecret: string;
  /** Directory under which per-run git worktrees are created. */
  worktreeRoot: string;
  /** TCP port the webhook server listens on. */
  listenPort: number;
}

/**
 * Read and validate the server's settings from environment variables
 * (`GITHUB_TOKEN`, `WEBHOOK_SECRET`, `WORKTREE_ROOT`, `LISTEN_PORT`). Throws a
 * {@link ConfigError} naming the first missing or invalid variable.
 */
export function serverConfigFromEnv(
  env: Record<string, string | undefined>,
): ServerEnv {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new ConfigError(`Missing required environment variable ${name}`);
    }
    return value;
  };

  const githubToken = required("GITHUB_TOKEN");
  const webhookSecret = required("WEBHOOK_SECRET");
  const worktreeRoot = required("WORKTREE_ROOT");

  const portText = required("LISTEN_PORT");
  const listenPort = Number(portText);
  if (
    !Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535
  ) {
    throw new ConfigError(
      `LISTEN_PORT must be a port number between 1 and 65535, got "${portText}"`,
    );
  }

  return { githubToken, webhookSecret, worktreeRoot, listenPort };
}

/**
 * Verify that `cwd` is the root of a git checkout that contains `configFile`,
 * returning the resolved checkout root. Throws a {@link ConfigError} when the
 * directory is not a checkout, is not the checkout's top level, or the config
 * file is missing — the preconditions for serving from this directory.
 */
export async function verifyCheckout(
  git: GitClient,
  cwd: string,
  configFile: string,
): Promise<string> {
  const root = await git.repoRoot(cwd);
  if (root === undefined) {
    throw new ConfigError(`Working directory is not a git checkout: ${cwd}`);
  }
  if (realpathSync(root) !== realpathSync(cwd)) {
    throw new ConfigError(
      `--serve must be run from the root of the git checkout (its root is ${root})`,
    );
  }
  if (!existsSync(resolve(cwd, configFile))) {
    throw new ConfigError(
      `Config file "${configFile}" not found in the checkout root`,
    );
  }
  return root;
}

/** How a checked-out worktree is built and run; injectable for tests. */
export type RunJob = (worktreeDir: string) => Promise<boolean>;

export interface CiServerOptions {
  /** Root of the git checkout to create worktrees from. */
  repoRoot: string;
  /** Config file name, resolved inside each worktree. */
  configFile: string;
  /** Shared secret for verifying webhook signatures. */
  secret: string;
  /** Directory under which per-run worktrees are created. */
  worktreeRoot: string;
  /** Git client; defaults to the real `git` CLI when constructed by the caller. */
  git: GitClient;
  /** Reporter for posting commit statuses back to GitHub. */
  status: StatusReporter;
  /**
   * Build and run the pipeline for a worktree, resolving true on success.
   * Defaults to loading `configFile` from the worktree and running it.
   */
  run?: RunJob;
  /** Sink for progress messages; defaults to console.error. */
  log?: (message: string) => void;
}

/**
 * An HTTP server that acts as the backend for a GitHub push webhook. Each
 * accepted push is checked out into its own git worktree and run as an
 * independent CI pipeline, so pushes to different branches are handled
 * concurrently without interfering with each other or the serving checkout.
 */
export class CiServer {
  readonly #repoRoot: string;
  readonly #configFile: string;
  readonly #secret: string;
  readonly #worktreeRoot: string;
  readonly #git: GitClient;
  readonly #status: StatusReporter;
  readonly #run: RunJob;
  readonly #log: (message: string) => void;
  readonly #server: Server;
  /** In-flight CI jobs, tracked so shutdown can wait for them to finish. */
  readonly #jobs = new Set<Promise<void>>();
  /** Monotonic counter making each worktree directory name unique. */
  #counter = 0;

  constructor(options: CiServerOptions) {
    this.#repoRoot = options.repoRoot;
    this.#configFile = options.configFile;
    this.#secret = options.secret;
    this.#worktreeRoot = options.worktreeRoot;
    this.#git = options.git;
    this.#status = options.status;
    this.#log = options.log ?? ((m) => console.error(m));
    this.#run = options.run ?? (async (dir) => {
      const config = await loadConfig(resolve(dir, this.#configFile));
      const result = await runPipeline(config);
      return result.ok;
    });
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  /** Start listening on `port`, resolving once the socket is bound. */
  listen(port: number): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, () => {
        this.#server.removeListener("error", reject);
        resolvePromise();
      });
    });
  }

  /** The bound port, useful for tests that listen on an ephemeral port. */
  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === "string") return 0;
    return address.port;
  }

  /** Wait for every in-flight CI job to finish. */
  async drain(): Promise<void> {
    await Promise.all([...this.#jobs]);
  }

  /** Stop accepting connections and wait for in-flight jobs to finish. */
  async close(): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      this.#server.close(() => resolvePromise());
    });
    await this.drain();
  }

  /** Handle one webhook request: authenticate, then dispatch a push to CI. */
  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      return reply(res, 405, "Method Not Allowed");
    }

    const body = await readBody(req);
    const signature = header(req, "x-hub-signature-256");
    if (!verifySignature(this.#secret, body, signature)) {
      this.#log("Rejected webhook with an invalid signature");
      return reply(res, 401, "Invalid signature");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return reply(res, 400, "Invalid JSON");
    }

    const event = header(req, "x-github-event");
    if (event === "ping") {
      return reply(res, 200, "pong");
    }
    if (event !== "push") {
      return reply(res, 204, "");
    }

    const push = parsePushEvent(payload);
    if (push === undefined) {
      return reply(res, 200, "Ignored (no buildable branch push)");
    }

    // Accept now and run CI in the background so the webhook returns promptly.
    this.#track(this.#runJob(push));
    return reply(res, 202, "Accepted");
  }

  /** Add a job to the in-flight set, removing it once it settles. */
  #track(job: Promise<void>): void {
    const tracked = job.finally(() => this.#jobs.delete(tracked));
    this.#jobs.add(tracked);
  }

  /**
   * Run one push through CI in its own worktree: report `pending`, fetch the
   * branch, check the exact commit out into a fresh worktree, run the pipeline,
   * then report the outcome and remove the worktree. Any failure of git or the
   * pipeline is reported to GitHub as `error`/`failure`; status-reporting
   * failures are logged but never abort cleanup.
   */
  async #runJob(push: PushEvent): Promise<void> {
    const { repo, branch, sha } = push;
    const short = sha.slice(0, 12);
    const worktreeDir = resolve(
      this.#worktreeRoot,
      `${slugifyBranch(branch)}-${short}-${this.#counter++}`,
    );
    this.#log(`CI start: ${repo} ${branch}@${short} -> ${worktreeDir}`);

    await this.#report(repo, sha, "pending", `Running CI for ${branch}`);

    let created = false;
    try {
      await this.#git.fetch(this.#repoRoot, branch);
      await this.#git.addWorktree(this.#repoRoot, worktreeDir, sha);
      created = true;

      const ok = await this.#run(worktreeDir);
      this.#log(`CI ${ok ? "passed" : "failed"}: ${repo} ${branch}@${short}`);
      await this.#report(
        repo,
        sha,
        ok ? "success" : "failure",
        ok ? "CI passed" : "CI failed",
      );
    } catch (err) {
      const message = (err as Error).message;
      this.#log(`CI error: ${repo} ${branch}@${short}: ${message}`);
      await this.#report(repo, sha, "error", message);
    } finally {
      if (created) {
        await this.#git.removeWorktree(this.#repoRoot, worktreeDir);
      }
    }
  }

  /** Post a commit status, logging (not throwing) if GitHub rejects it. */
  async #report(
    repo: string,
    sha: string,
    state: Parameters<StatusReporter["report"]>[2],
    description: string,
  ): Promise<void> {
    try {
      await this.#status.report(repo, sha, state, description);
    } catch (err) {
      this.#log(`Failed to report ${state} status: ${(err as Error).message}`);
    }
  }
}

/** Read the entire request body as a UTF-8 string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => resolvePromise(body));
    req.on("error", reject);
  });
}

/** A single request header value, or undefined when absent or repeated. */
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Send a plain-text response with the given status code. */
function reply(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, { "Content-Type": "text/plain" });
  res.end(text);
}
