import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Lifecycle state of a recorded run. `running` rows have not finished yet. */
export type RunStatus = "running" | "success" | "failure" | "error";

/** One recorded CI run, past or still in flight. */
export interface RunRecord {
  id: number;
  /** Branch the run was for; undefined when unknown (e.g. not a git checkout). */
  branch?: string;
  /** Commit sha the run was for, when known. */
  commit?: string;
  status: RunStatus;
  startedAt: Date;
  /** Unset while the run is still in flight. */
  finishedAt?: Date;
  /** Whether a stored HTML report is available via {@link RunStore.report}. */
  hasReport: boolean;
}

/**
 * The customary per-user application data directory for whale-ci:
 * `~/Library/Application Support/whale-ci` on macOS and
 * `$XDG_DATA_HOME/whale-ci` (default `~/.local/share/whale-ci`) elsewhere.
 * The parameters default to the real platform/environment; injectable for tests.
 */
export function dataDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "whale-ci");
  }
  const xdg = env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.trim() !== "") {
    return join(xdg, "whale-ci");
  }
  return join(home, ".local", "share", "whale-ci");
}

/** Where the run-history database lives by default: `<dataDir>/runs.db`. */
export function defaultDatabasePath(): string {
  return join(dataDir(), "runs.db");
}

/**
 * The run-history operations the server and CLI need; satisfied by
 * {@link RunStore} and fakeable in tests.
 */
export interface RunHistory {
  start(run: { branch?: string; commit?: string }): number;
  finish(id: number, status: RunStatus, report?: string): void;
  recent(limit?: number): RunRecord[];
  report(id: number): string | undefined;
}

/**
 * Persistent history of CI runs, backed by an SQLite database (via node's
 * built-in `node:sqlite`). Every run — one-shot CLI runs and webhook-triggered
 * server runs alike — is recorded here, first as `running` when it starts and
 * then with its final status and HTML report when it finishes. Pass
 * `":memory:"` as the path for a throwaway in-memory store (used in tests).
 */
export class RunStore implements RunHistory {
  readonly #db: DatabaseSync;

  constructor(path: string = defaultDatabasePath()) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch TEXT,
        commit_sha TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        report TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at);
    `);
  }

  /** Record the start of a run, returning its id for the later finish call. */
  start(run: { branch?: string; commit?: string }): number {
    const result = this.#db
      .prepare(
        "INSERT INTO runs (branch, commit_sha, status, started_at) VALUES (?, ?, 'running', ?)",
      )
      .run(run.branch ?? null, run.commit ?? null, Date.now());
    return Number(result.lastInsertRowid);
  }

  /** Record a run's outcome and (when one was produced) its HTML report. */
  finish(id: number, status: RunStatus, report?: string): void {
    this.#db
      .prepare(
        "UPDATE runs SET status = ?, finished_at = ?, report = ? WHERE id = ?",
      )
      .run(status, Date.now(), report ?? null, id);
  }

  /** The most recent runs (running ones included), newest first. */
  recent(limit = 50): RunRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT id, branch, commit_sha, status, started_at, finished_at,
                report IS NOT NULL AS has_report
         FROM runs ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
        id: number;
        branch: string | null;
        commit_sha: string | null;
        status: string;
        started_at: number;
        finished_at: number | null;
        has_report: number;
      }>;
    return rows.map((row) => ({
      id: row.id,
      branch: row.branch ?? undefined,
      commit: row.commit_sha ?? undefined,
      status: row.status as RunStatus,
      startedAt: new Date(row.started_at),
      finishedAt: row.finished_at === null
        ? undefined
        : new Date(row.finished_at),
      hasReport: row.has_report !== 0,
    }));
  }

  /** The stored HTML report for a run, or undefined when there is none. */
  report(id: number): string | undefined {
    const row = this.#db
      .prepare("SELECT report FROM runs WHERE id = ?")
      .get(id) as { report: string | null } | undefined;
    return row?.report ?? undefined;
  }

  close(): void {
    this.#db.close();
  }
}
