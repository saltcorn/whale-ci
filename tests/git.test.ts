import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addWorktreeArgs,
  fetchArgs,
  removeWorktreeArgs,
  slugifyBranch,
} from "../lib/git.ts";

test("fetchArgs fetches a ref from origin", () => {
  assert.deepEqual(fetchArgs("main"), ["fetch", "origin", "main"]);
});

test("addWorktreeArgs creates a detached worktree at a commit", () => {
  assert.deepEqual(addWorktreeArgs("/wt/feature-abc", "abc123"), [
    "worktree",
    "add",
    "--detach",
    "/wt/feature-abc",
    "abc123",
  ]);
});

test("removeWorktreeArgs force-removes the worktree", () => {
  assert.deepEqual(removeWorktreeArgs("/wt/feature-abc"), [
    "worktree",
    "remove",
    "--force",
    "/wt/feature-abc",
  ]);
});

test("slugifyBranch makes a filesystem-safe, non-hidden slug", () => {
  assert.equal(slugifyBranch("main"), "main");
  assert.equal(slugifyBranch("feature/new-thing"), "feature-new-thing");
  assert.equal(slugifyBranch("release/v1.2.3"), "release-v1.2.3");
  // Leading dots/dashes are trimmed so the directory is neither hidden nor
  // option-like.
  assert.equal(slugifyBranch("../escape"), "escape");
  assert.equal(slugifyBranch("///"), "branch");
});
