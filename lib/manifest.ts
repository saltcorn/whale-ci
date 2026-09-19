import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigError } from "./types.ts";

/**
 * The default name of the pipeline config file looked for inside each
 * repository, used when neither the manifest's global `config` nor a
 * repository's own `config` names one.
 */
export const DEFAULT_CONFIG_FILE = "ci.yml";

/** Default maximum number of test containers a repository's pipeline runs at once. */
export const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * One repository a server manifest tells the CI server to serve. Every optional
 * setting has been resolved by {@link parseManifest}: the values here are the
 * ones the server uses, with the manifest's globals already folded in.
 */
export interface ManifestRepo {
  /** Display name for the repository, unique within the manifest. */
  name: string;
  /** Absolute path of the git checkout on disk worktrees are created from. */
  path: string;
  /** The repository's remote URL, as written in the manifest. */
  url: string;
  /**
   * `owner/repo` derived from {@link url}. This is what an arriving webhook's
   * `repository.full_name` is matched against to decide which repository —
   * if any — the commit belongs to.
   */
  fullName: string;
  /** Pipeline config file, resolved inside each worktree of this repository. */
  configFile: string;
  /** Branches whose webhooks are dropped without being built or recorded. */
  ignoredBranches: ReadonlySet<string>;
  /** GitHub logins whose fork pull requests are built for this repository. */
  trustedPrOwners: ReadonlySet<string>;
  /** Test containers this repository's pipeline may run in parallel. */
  maxConcurrency: number;
  /** Minutes one commit of this repository may build before it is aborted. */
  jobTimeoutMinutes: number;
}

/** A parsed and validated server manifest: the global settings and the repositories. */
export interface ServerManifest {
  /** TCP port the webhook server and dashboard listen on. */
  port: number;
  /** Directory under which per-run git worktrees are created. */
  worktreeRoot: string;
  /**
   * Externally-reachable base URL of the dashboard, used to link commit
   * statuses to their run reports. Undefined when the manifest sets none.
   */
  publicUrl?: string;
  /** The repositories this server builds, in manifest order. */
  repositories: ManifestRepo[];
}

/** Keys accepted at the top level of a manifest. Anything else is an error. */
const KNOWN_KEYS = new Set([
  "port",
  "worktree-root",
  "public-url",
  "max-concurrency",
  "job-timeout-minutes",
  "config",
  "ignore-branch",
  "trusted-owners",
  "repositories",
]);

/** Keys accepted inside one entry of `repositories`. */
const KNOWN_REPO_KEYS = new Set([
  "name",
  "path",
  "url",
  "config",
  "ignore-branch",
  "trusted-owners",
  "max-concurrency",
  "job-timeout-minutes",
]);

/**
 * Read, parse and validate a server manifest file. Relative repository paths
 * and the worktree root resolve against the manifest's own directory, so a
 * manifest can be moved around with the checkouts it names.
 */
export async function loadManifest(file: string): Promise<ServerManifest> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new ConfigError(`Cannot read server manifest: ${file}`);
  }
  return parseManifest(text, dirname(resolve(file)));
}

/**
 * Parse and validate server manifest text. `baseDir` is the directory the
 * manifest lives in, which relative paths in it resolve against.
 *
 * The manifest's global settings (`max-concurrency`, `job-timeout-minutes`,
 * `config`, `ignore-branch`, `trusted-owners`) are defaults for every
 * repository; a repository that sets one of them *replaces* the global value
 * rather than adding to it, so a repository's `trusted-owners` is always
 * exactly the list written next to it.
 */
export function parseManifest(text: string, baseDir: string): ServerManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`Invalid YAML in server manifest: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) {
    throw new ConfigError("Server manifest is empty");
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("Server manifest must be a mapping of settings");
  }
  const body = parsed as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new ConfigError(
        `Unknown key "${key}" in server manifest (known keys: ${
          [...KNOWN_KEYS].join(", ")
        })`,
      );
    }
  }

  const port = requiredPort(body["port"]);
  const worktreeRoot = resolvePath(
    requiredString(body["worktree-root"], "worktree-root"),
    baseDir,
  );
  const publicUrl = optionalString(body["public-url"], "public-url")
    ?.replace(/\/+$/, "");

  // The global defaults every repository inherits unless it says otherwise.
  const defaults = {
    configFile: optionalString(body["config"], "config") ?? DEFAULT_CONFIG_FILE,
    ignoredBranches: nameList(body["ignore-branch"], "ignore-branch"),
    trustedPrOwners: ownerList(body["trusted-owners"], "trusted-owners"),
    maxConcurrency: positiveInteger(body["max-concurrency"], "max-concurrency") ??
      DEFAULT_MAX_CONCURRENCY,
    jobTimeoutMinutes:
      positiveInteger(body["job-timeout-minutes"], "job-timeout-minutes") ?? 30,
  };

  const listed = body["repositories"];
  if (!Array.isArray(listed) || listed.length === 0) {
    throw new ConfigError(
      "Server manifest must list at least one repository under \"repositories\"",
    );
  }

  const repositories: ManifestRepo[] = [];
  const names = new Set<string>();
  const fullNames = new Map<string, string>();
  for (const [index, entry] of listed.entries()) {
    const repo = parseRepo(entry, index, baseDir, defaults);
    if (names.has(repo.name)) {
      throw new ConfigError(`Duplicate repository name "${repo.name}" in server manifest`);
    }
    names.add(repo.name);
    // Two entries for the same GitHub repository would make webhook routing
    // ambiguous: the second could never be reached.
    const key = repo.fullName.toLowerCase();
    const clash = fullNames.get(key);
    if (clash !== undefined) {
      throw new ConfigError(
        `Repositories "${clash}" and "${repo.name}" both have the URL of ${repo.fullName}; ` +
          "webhooks could not be routed between them",
      );
    }
    fullNames.set(key, repo.name);
    repositories.push(repo);
  }

  return { port, worktreeRoot, publicUrl, repositories };
}

/** Defaults a repository entry inherits from the manifest's global settings. */
interface RepoDefaults {
  configFile: string;
  ignoredBranches: Set<string>;
  trustedPrOwners: Set<string>;
  maxConcurrency: number;
  jobTimeoutMinutes: number;
}

/** Parse and validate one entry of the manifest's `repositories` list. */
function parseRepo(
  entry: unknown,
  index: number,
  baseDir: string,
  defaults: RepoDefaults,
): ManifestRepo {
  const where = `repositories[${index}]`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new ConfigError(`${where} must be a mapping with name, path and url`);
  }
  const body = entry as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!KNOWN_REPO_KEYS.has(key)) {
      throw new ConfigError(
        `Unknown key "${key}" in ${where} (known keys: ${
          [...KNOWN_REPO_KEYS].join(", ")
        })`,
      );
    }
  }

  const name = requiredString(body["name"], `${where}.name`);
  const path = resolvePath(requiredString(body["path"], `${where}.path`), baseDir);
  const url = requiredString(body["url"], `${where}.url`);
  const fullName = repoFullName(url);
  if (fullName === undefined) {
    throw new ConfigError(
      `${where}.url is not a recognisable GitHub repository URL: "${url}"`,
    );
  }

  return {
    name,
    path,
    url,
    fullName,
    configFile: optionalString(body["config"], `${where}.config`) ??
      defaults.configFile,
    ignoredBranches: body["ignore-branch"] === undefined
      ? defaults.ignoredBranches
      : nameList(body["ignore-branch"], `${where}.ignore-branch`),
    trustedPrOwners: body["trusted-owners"] === undefined
      ? defaults.trustedPrOwners
      : ownerList(body["trusted-owners"], `${where}.trusted-owners`),
    maxConcurrency:
      positiveInteger(body["max-concurrency"], `${where}.max-concurrency`) ??
        defaults.maxConcurrency,
    jobTimeoutMinutes:
      positiveInteger(body["job-timeout-minutes"], `${where}.job-timeout-minutes`) ??
        defaults.jobTimeoutMinutes,
  };
}

/**
 * The `owner/repo` a repository URL names, or undefined when the URL is not a
 * repository URL at all. Handles the forms GitHub offers for cloning —
 * `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git` and
 * `ssh://git@github.com/owner/repo.git` — since that is what an operator will
 * paste into the manifest, and it is matched against the `repository.full_name`
 * of arriving webhooks.
 */
export function repoFullName(url: string): string | undefined {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  // scp-style: [user@]host:owner/repo
  const scp = trimmed.match(/^[^/]*@[^/:]+:(.+)$/);
  const path = scp !== null
    ? scp[1]!
    // Anything with a scheme (https://, ssh://, git://): take the URL path.
    : trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//) !== null
    ? trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+\//, "")
    : trimmed;
  const parts = path.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  if (owner === undefined || repo === undefined) return undefined;
  if (owner === "" || repo === "") return undefined;
  return `${owner}/${repo}`;
}

/** Resolve a manifest path against the manifest's own directory. */
function resolvePath(path: string, baseDir: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

/** A required non-empty string setting. */
function requiredString(value: unknown, name: string): string {
  const text = optionalString(value, name);
  if (text === undefined) {
    throw new ConfigError(`Server manifest is missing required setting "${name}"`);
  }
  return text;
}

/** An optional non-empty string setting; a blank value counts as unset. */
function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`"${name}" in the server manifest must be a string`);
  }
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** An optional positive-integer setting. */
function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(
      `"${name}" in the server manifest must be a positive integer`,
    );
  }
  return value;
}

/** The required `port` setting, validated as a TCP port number. */
function requiredPort(value: unknown): number {
  if (value === undefined || value === null) {
    throw new ConfigError("Server manifest is missing required setting \"port\"");
  }
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 1 ||
    value > 65535
  ) {
    throw new ConfigError(
      `"port" in the server manifest must be a port number between 1 and 65535`,
    );
  }
  return value;
}

/**
 * A list-valued setting, accepted either as a YAML list or as one
 * comma-separated string (`[gh-pages, wip]` or `"gh-pages,wip"`). Blank entries
 * are dropped; an unset value yields an empty set.
 */
function stringList(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  const items = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(items)) {
    throw new ConfigError(
      `"${name}" in the server manifest must be a list or a comma-separated string`,
    );
  }
  return items.map((item) => {
    if (typeof item !== "string") {
      throw new ConfigError(`"${name}" in the server manifest must contain only strings`);
    }
    return item.trim();
  }).filter((item) => item !== "");
}

/** Branch names, kept as written: git branch names are case-sensitive. */
function nameList(value: unknown, name: string): Set<string> {
  return new Set(stringList(value, name));
}

/** GitHub logins, folded to lower case: logins are compared case-insensitively. */
function ownerList(value: unknown, name: string): Set<string> {
  return new Set(stringList(value, name).map((owner) => owner.toLowerCase()));
}
