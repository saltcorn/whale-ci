import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { parsePushEvent, statusUrl, verifySignature } from "../lib/github.ts";

/** Compute the header GitHub would send for `body` signed with `secret`. */
function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

test("verifySignature accepts a correct signature", () => {
  const body = '{"hello":"world"}';
  assert.equal(verifySignature("s3cret", body, sign("s3cret", body)), true);
});

test("verifySignature rejects wrong secret, body, or missing header", () => {
  const body = '{"hello":"world"}';
  assert.equal(verifySignature("s3cret", body, sign("other", body)), false);
  assert.equal(verifySignature("s3cret", "tampered", sign("s3cret", body)), false);
  assert.equal(verifySignature("s3cret", body, undefined), false);
  assert.equal(verifySignature("s3cret", body, "garbage"), false);
  // A sha1-style prefix is not accepted.
  assert.equal(verifySignature("s3cret", body, "sha1=deadbeef"), false);
});

test("parsePushEvent extracts repo, branch and sha", () => {
  const event = parsePushEvent({
    ref: "refs/heads/feature/x",
    after: "abc123",
    repository: { full_name: "owner/repo" },
  });
  assert.deepEqual(event, {
    repo: "owner/repo",
    branch: "feature/x",
    sha: "abc123",
  });
});

test("parsePushEvent ignores tags, deletions and malformed payloads", () => {
  // A tag push (not refs/heads/).
  assert.equal(
    parsePushEvent({
      ref: "refs/tags/v1",
      after: "abc",
      repository: { full_name: "o/r" },
    }),
    undefined,
  );
  // A branch deletion via the `deleted` flag.
  assert.equal(
    parsePushEvent({
      ref: "refs/heads/main",
      after: "abc",
      deleted: true,
      repository: { full_name: "o/r" },
    }),
    undefined,
  );
  // A branch deletion via the all-zero SHA sentinel.
  assert.equal(
    parsePushEvent({
      ref: "refs/heads/main",
      after: "0000000000000000000000000000000000000000",
      repository: { full_name: "o/r" },
    }),
    undefined,
  );
  // Missing repository full_name.
  assert.equal(
    parsePushEvent({ ref: "refs/heads/main", after: "abc" }),
    undefined,
  );
  assert.equal(parsePushEvent(null), undefined);
  assert.equal(parsePushEvent("nope"), undefined);
});

test("statusUrl addresses the commit-statuses API", () => {
  assert.equal(
    statusUrl("owner/repo", "abc123"),
    "https://api.github.com/repos/owner/repo/statuses/abc123",
  );
});
