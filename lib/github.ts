import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The commit-status states GitHub accepts. `pending` is posted when a check
 * starts, then one of the others when it finishes.
 */
export type CommitState = "pending" | "success" | "failure" | "error";

/** A push that should trigger a CI run, extracted from a webhook payload. */
export interface PushEvent {
  /** `owner/repo`, used to address the GitHub API. */
  repo: string;
  /** The branch that was pushed (no `refs/heads/` prefix). */
  branch: string;
  /** The commit SHA at the tip of the push, which CI runs against. */
  sha: string;
}

/**
 * Posts commit statuses back to GitHub. Abstracted behind an interface so the
 * server can be tested without making real API calls.
 */
export interface StatusReporter {
  report(
    repo: string,
    sha: string,
    state: CommitState,
    description: string,
  ): Promise<void>;
}

/**
 * Verify a GitHub webhook's `X-Hub-Signature-256` header against the raw request
 * body using the shared secret. GitHub sends `sha256=<hex hmac>`; we recompute
 * the HMAC and compare in constant time. Returns false for a missing or
 * malformed header rather than throwing.
 */
export function verifySignature(
  secret: string,
  body: string,
  signature: string | undefined,
): boolean {
  if (signature === undefined || !signature.startsWith("sha256=")) {
    return false;
  }
  const expected = "sha256=" +
    createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; unequal length means no match.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Extract the CI-relevant fields from a parsed `push` webhook payload, or
 * `undefined` when the push should be ignored: a branch deletion, a tag (or any
 * non-branch ref), or a payload missing the fields we need.
 */
export function parsePushEvent(payload: unknown): PushEvent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const body = payload as Record<string, unknown>;

  // A branch deletion has nothing to build.
  if (body["deleted"] === true) return undefined;

  const ref = body["ref"];
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) {
    return undefined;
  }
  const branch = ref.slice("refs/heads/".length);

  const sha = body["after"];
  // The all-zero SHA is GitHub's sentinel for a deleted ref.
  if (typeof sha !== "string" || /^0+$/.test(sha)) return undefined;

  const repository = body["repository"];
  const repo = typeof repository === "object" && repository !== null
    ? (repository as Record<string, unknown>)["full_name"]
    : undefined;
  if (typeof repo !== "string" || repo.length === 0) return undefined;

  return { repo, branch, sha };
}

/** The GitHub API URL for setting a commit's status. */
export function statusUrl(repo: string, sha: string): string {
  return `https://api.github.com/repos/${repo}/statuses/${sha}`;
}

/** A StatusReporter that calls the GitHub commit-statuses API with a token. */
export class GitHubStatusReporter implements StatusReporter {
  readonly #token: string;
  readonly #context: string;

  constructor(token: string, context = "whale-ci") {
    this.#token = token;
    this.#context = context;
  }

  async report(
    repo: string,
    sha: string,
    state: CommitState,
    description: string,
  ): Promise<void> {
    const response = await fetch(statusUrl(repo, sha), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.#token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "whale-ci",
        "Content-Type": "application/json",
      },
      // GitHub truncates descriptions at 140 characters.
      body: JSON.stringify({
        state,
        description: description.slice(0, 140),
        context: this.#context,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `GitHub status update failed (${response.status}): ${text.trim()}`,
      );
    }
  }
}
