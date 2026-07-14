import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { dataDir, RunStore } from "../lib/history.ts";

test("dataDir picks the customary per-platform application data directory", () => {
  assert.equal(
    dataDir("darwin", {}, "/Users/me"),
    join("/Users/me", "Library", "Application Support", "whale-ci"),
  );
  assert.equal(
    dataDir("linux", {}, "/home/me"),
    join("/home/me", ".local", "share", "whale-ci"),
  );
  // XDG_DATA_HOME overrides the Linux default, but blank values are ignored.
  assert.equal(
    dataDir("linux", { XDG_DATA_HOME: "/data" }, "/home/me"),
    join("/data", "whale-ci"),
  );
  assert.equal(
    dataDir("linux", { XDG_DATA_HOME: "  " }, "/home/me"),
    join("/home/me", ".local", "share", "whale-ci"),
  );
});

test("a started run is listed as running, then finished with its report", () => {
  const store = new RunStore(":memory:");
  const id = store.start({ branch: "main", commit: "abc123" });

  let [run] = store.recent();
  assert.ok(run);
  assert.equal(run.id, id);
  assert.equal(run.branch, "main");
  assert.equal(run.commit, "abc123");
  assert.equal(run.status, "running");
  assert.equal(run.finishedAt, undefined);
  assert.equal(run.hasReport, false);
  assert.ok(run.startedAt instanceof Date);

  store.finish(id, "success", "<html>ok</html>");
  [run] = store.recent();
  assert.ok(run);
  assert.equal(run.status, "success");
  assert.ok(run.finishedAt instanceof Date);
  assert.equal(run.hasReport, true);
  assert.equal(store.report(id), "<html>ok</html>");
  store.close();
});

test("update overwrites a running run's report without changing its status", () => {
  const store = new RunStore(":memory:");
  const id = store.start({ branch: "main", commit: "abc123" });

  store.update(id, "<html>pending</html>");
  let [run] = store.recent();
  assert.ok(run);
  // The run is still running, but its interim report is now available.
  assert.equal(run.status, "running");
  assert.equal(run.finishedAt, undefined);
  assert.equal(run.hasReport, true);
  assert.equal(store.report(id), "<html>pending</html>");

  // A later update replaces the earlier report, still without finishing.
  store.update(id, "<html>step 1 done</html>");
  [run] = store.recent();
  assert.equal(run!.status, "running");
  assert.equal(store.report(id), "<html>step 1 done</html>");

  // Finishing then records the final report and outcome.
  store.finish(id, "success", "<html>final</html>");
  assert.equal(store.recent()[0]!.status, "success");
  assert.equal(store.report(id), "<html>final</html>");
  store.close();
});

test("a run without a branch or report is handled", () => {
  const store = new RunStore(":memory:");
  const id = store.start({});
  store.finish(id, "failure");
  const [run] = store.recent();
  assert.ok(run);
  assert.equal(run.branch, undefined);
  assert.equal(run.commit, undefined);
  assert.equal(run.status, "failure");
  assert.equal(run.hasReport, false);
  assert.equal(store.report(id), undefined);
  store.close();
});

test("failRunning marks only still-running runs as errored, leaving finished ones", () => {
  const store = new RunStore(":memory:");
  const running1 = store.start({ branch: "main" });
  const running2 = store.start({ branch: "dev" });
  const finished = store.start({ branch: "old" });
  store.finish(finished, "success", "<html>ok</html>");

  assert.equal(store.failRunning(), 2);

  const byId = new Map(store.recent().map((r) => [r.id, r]));
  assert.equal(byId.get(running1)!.status, "error");
  assert.ok(byId.get(running1)!.finishedAt instanceof Date);
  assert.equal(byId.get(running2)!.status, "error");
  // The already-finished run keeps its status and report.
  assert.equal(byId.get(finished)!.status, "success");
  assert.equal(store.report(finished), "<html>ok</html>");

  // With nothing left running a second call is a no-op.
  assert.equal(store.failRunning(), 0);
  store.close();
});

test("an unknown run has no report", () => {
  const store = new RunStore(":memory:");
  assert.equal(store.report(42), undefined);
  store.close();
});

test("recent returns newest first and honours the limit", () => {
  const store = new RunStore(":memory:");
  for (let i = 0; i < 5; i++) {
    store.start({ branch: `b${i}` });
  }
  const all = store.recent();
  assert.deepEqual(all.map((r) => r.branch), ["b4", "b3", "b2", "b1", "b0"]);
  const two = store.recent(2);
  assert.deepEqual(two.map((r) => r.branch), ["b4", "b3"]);
  store.close();
});

test("runs persist across reopening the database file", () => {
  // A nested path also proves the store creates its directory on demand.
  const path = join(mkdtempSync(tmpdir() + sep + "whaleci-"), "deep", "runs.db");
  const store = new RunStore(path);
  const id = store.start({ branch: "main" });
  store.finish(id, "success", "<html>persisted</html>");
  store.close();

  const reopened = new RunStore(path);
  const [run] = reopened.recent();
  assert.ok(run);
  assert.equal(run.branch, "main");
  assert.equal(run.status, "success");
  assert.equal(reopened.report(id), "<html>persisted</html>");
  reopened.close();
});
