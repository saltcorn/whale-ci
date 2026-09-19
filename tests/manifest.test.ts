import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CONFIG_FILE,
  DEFAULT_MAX_CONCURRENCY,
  loadManifest,
  parseManifest,
  repoFullName,
} from "../lib/manifest.ts";
import { ConfigError } from "../lib/types.ts";

/** A manifest with the two required globals and one minimal repository. */
const MINIMAL = `
port: 8080
worktree-root: /var/tmp/whale-ci
repositories:
  - name: whale-ci
    path: /srv/git/whale-ci
    url: https://github.com/tom/whale-ci
`;

/** Parse manifest text with a fixed base directory. */
function parse(text: string) {
  return parseManifest(text, "/etc/whale-ci");
}

/** The ConfigError message raised by parsing `text`. */
function parseError(text: string): string {
  try {
    parse(text);
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${err}`);
    return err.message;
  }
  assert.fail("expected parsing to fail");
}

test("parses the global settings and one repository", () => {
  const manifest = parse(MINIMAL);
  assert.equal(manifest.port, 8080);
  assert.equal(manifest.worktreeRoot, "/var/tmp/whale-ci");
  assert.equal(manifest.publicUrl, undefined);
  assert.equal(manifest.repositories.length, 1);

  const repo = manifest.repositories[0]!;
  assert.equal(repo.name, "whale-ci");
  assert.equal(repo.path, "/srv/git/whale-ci");
  assert.equal(repo.url, "https://github.com/tom/whale-ci");
  assert.equal(repo.fullName, "tom/whale-ci");
  assert.equal(repo.configFile, DEFAULT_CONFIG_FILE);
  assert.equal(repo.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
  assert.equal(repo.jobTimeoutMinutes, 30);
  assert.deepEqual([...repo.ignoredBranches], []);
  assert.deepEqual([...repo.trustedPrOwners], []);
});

test("global settings become the default for every repository", () => {
  const manifest = parse(`
port: 80
worktree-root: /w
max-concurrency: 2
job-timeout-minutes: 90
config: pipeline.yml
ignore-branch: [gh-pages, wip]
trusted-owners: Alice
repositories:
  - name: one
    path: /a
    url: https://github.com/tom/one
  - name: two
    path: /b
    url: https://github.com/tom/two
`);
  for (const repo of manifest.repositories) {
    assert.equal(repo.configFile, "pipeline.yml");
    assert.equal(repo.maxConcurrency, 2);
    assert.equal(repo.jobTimeoutMinutes, 90);
    assert.deepEqual([...repo.ignoredBranches], ["gh-pages", "wip"]);
    // Logins are compared case-insensitively, so they are folded on the way in.
    assert.deepEqual([...repo.trustedPrOwners], ["alice"]);
  }
});

test("a repository's own settings replace the global ones", () => {
  const manifest = parse(`
port: 80
worktree-root: /w
max-concurrency: 2
ignore-branch: [gh-pages]
trusted-owners: [alice]
repositories:
  - name: one
    path: /a
    url: https://github.com/tom/one
  - name: two
    path: /b
    url: https://github.com/tom/two
    config: other.yml
    max-concurrency: 8
    job-timeout-minutes: 5
    ignore-branch: wip
    trusted-owners: []
`);
  const [one, two] = manifest.repositories;
  assert.deepEqual([...one!.ignoredBranches], ["gh-pages"]);
  assert.deepEqual([...one!.trustedPrOwners], ["alice"]);

  assert.equal(two!.configFile, "other.yml");
  assert.equal(two!.maxConcurrency, 8);
  assert.equal(two!.jobTimeoutMinutes, 5);
  // Replaced, not merged: what is written next to the repository is the list.
  assert.deepEqual([...two!.ignoredBranches], ["wip"]);
  assert.deepEqual([...two!.trustedPrOwners], []);
});

test("lists are accepted as YAML lists or comma-separated strings", () => {
  const manifest = parse(`
port: 80
worktree-root: /w
repositories:
  - name: one
    path: /a
    url: https://github.com/tom/one
    ignore-branch: "gh-pages, wip ,"
    trusted-owners: "alice,BOB"
`);
  const repo = manifest.repositories[0]!;
  assert.deepEqual([...repo.ignoredBranches], ["gh-pages", "wip"]);
  assert.deepEqual([...repo.trustedPrOwners], ["alice", "bob"]);
});

test("relative paths resolve against the manifest's directory", () => {
  const manifest = parseManifest(
    `
port: 80
worktree-root: worktrees
repositories:
  - name: one
    path: repos/one
    url: https://github.com/tom/one
  - name: two
    path: /absolute/two
    url: https://github.com/tom/two
`,
    "/etc/whale-ci",
  );
  assert.equal(manifest.worktreeRoot, "/etc/whale-ci/worktrees");
  assert.equal(manifest.repositories[0]!.path, "/etc/whale-ci/repos/one");
  assert.equal(manifest.repositories[1]!.path, "/absolute/two");
});

test("a trailing slash is trimmed from the public URL", () => {
  const manifest = parse(`
port: 80
worktree-root: /w
public-url: https://ci.example.com/
repositories:
  - name: one
    path: /a
    url: https://github.com/tom/one
`);
  assert.equal(manifest.publicUrl, "https://ci.example.com");
});

test("repoFullName understands the URL forms GitHub offers", () => {
  const expected = "tom/whale-ci";
  assert.equal(repoFullName("https://github.com/tom/whale-ci"), expected);
  assert.equal(repoFullName("https://github.com/tom/whale-ci.git"), expected);
  assert.equal(repoFullName("https://github.com/tom/whale-ci/"), expected);
  assert.equal(repoFullName("git@github.com:tom/whale-ci.git"), expected);
  assert.equal(repoFullName("ssh://git@github.com/tom/whale-ci.git"), expected);
  assert.equal(repoFullName("tom/whale-ci"), expected);
});

test("repoFullName rejects what is not a repository URL", () => {
  assert.equal(repoFullName("https://github.com/tom"), undefined);
  assert.equal(repoFullName("https://github.com/tom/whale-ci/tree/main"), undefined);
  assert.equal(repoFullName(""), undefined);
});

test("the required global settings are checked", () => {
  assert.match(
    parseError(`worktree-root: /w\nrepositories: [{name: a, path: /a, url: tom/a}]`),
    /missing required setting "port"/,
  );
  assert.match(
    parseError(`port: 80\nrepositories: [{name: a, path: /a, url: tom/a}]`),
    /missing required setting "worktree-root"/,
  );
  assert.match(
    parseError(`port: 99999\nworktree-root: /w\nrepositories: [{name: a, path: /a, url: tom/a}]`),
    /port number between 1 and 65535/,
  );
});

test("a manifest must list at least one repository", () => {
  assert.match(
    parseError(`port: 80\nworktree-root: /w`),
    /at least one repository/,
  );
  assert.match(
    parseError(`port: 80\nworktree-root: /w\nrepositories: []`),
    /at least one repository/,
  );
});

test("a repository must have a name, a path and a usable URL", () => {
  const head = `port: 80\nworktree-root: /w\nrepositories:\n`;
  assert.match(
    parseError(`${head}  - path: /a\n    url: tom/a`),
    /repositories\[0\]\.name/,
  );
  assert.match(
    parseError(`${head}  - name: a\n    url: tom/a`),
    /repositories\[0\]\.path/,
  );
  assert.match(
    parseError(`${head}  - name: a\n    path: /a`),
    /repositories\[0\]\.url/,
  );
  assert.match(
    parseError(`${head}  - name: a\n    path: /a\n    url: https://example.com/`),
    /not a recognisable GitHub repository URL/,
  );
});

test("duplicate names and duplicate URLs are rejected", () => {
  const head = `port: 80\nworktree-root: /w\nrepositories:\n`;
  assert.match(
    parseError(
      `${head}  - {name: a, path: /a, url: tom/one}\n  - {name: a, path: /b, url: tom/two}`,
    ),
    /Duplicate repository name "a"/,
  );
  // Two entries for one GitHub repository would make webhook routing ambiguous.
  assert.match(
    parseError(
      `${head}  - {name: a, path: /a, url: https://github.com/tom/one}\n` +
        `  - {name: b, path: /b, url: git@github.com:Tom/One.git}`,
    ),
    /both have the URL of/,
  );
});

test("unknown keys are rejected, at both levels", () => {
  assert.match(
    parseError(`port: 80\nworktree-root: /w\nmaxconcurrency: 2\nrepositories: [{name: a, path: /a, url: tom/a}]`),
    /Unknown key "maxconcurrency" in server manifest/,
  );
  assert.match(
    parseError(`port: 80\nworktree-root: /w\nrepositories: [{name: a, path: /a, url: tom/a, branch: main}]`),
    /Unknown key "branch" in repositories\[0\]/,
  );
});

test("malformed settings are rejected with the setting named", () => {
  const head = `port: 80\nworktree-root: /w\nrepositories:\n`;
  assert.match(
    parseError(`${head}  - {name: a, path: /a, url: tom/a, max-concurrency: 0}`),
    /max-concurrency" in the server manifest must be a positive integer/,
  );
  assert.match(
    parseError(`${head}  - {name: a, path: /a, url: tom/a, job-timeout-minutes: half}`),
    /job-timeout-minutes" in the server manifest must be a positive integer/,
  );
  assert.match(
    parseError(`${head}  - "just a string"`),
    /repositories\[0\] must be a mapping/,
  );
  assert.match(
    parseError(`port: 80\nworktree-root: /w\nignore-branch: 7`),
    /must be a list or a comma-separated string/,
  );
});

test("an empty or non-mapping manifest is rejected", () => {
  assert.match(parseError(""), /empty/);
  assert.match(parseError("- one\n- two"), /must be a mapping/);
  assert.match(parseError("port: [80\nworktree-root: /w"), /Invalid YAML/);
});

test("loadManifest reads a file and reports one that cannot be read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whale-manifest-"));
  const file = join(dir, "servers.yml");
  writeFileSync(file, MINIMAL);
  const manifest = await loadManifest(file);
  assert.equal(manifest.repositories[0]!.fullName, "tom/whale-ci");

  await assert.rejects(
    loadManifest(join(dir, "missing.yml")),
    (err: unknown) =>
      err instanceof ConfigError &&
      /Cannot read server manifest/.test(err.message),
  );
});
