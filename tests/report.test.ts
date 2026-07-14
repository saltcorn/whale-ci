import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, renderReport, type StepReport } from "../lib/report.ts";

const STEPS: StepReport[] = [
  {
    name: "build",
    service: false,
    status: "success",
    durationMs: 1234,
    output: "Step 1/2 building\n",
  },
  {
    name: "database",
    service: true,
    status: "success",
    durationMs: 4200,
    output: "postgres ready\n",
  },
  {
    name: "test",
    service: false,
    status: "failure",
    durationMs: 250,
    output: "assertion <failed> & \"quoted\"\n",
  },
];

test("renders one closed accordion per step", () => {
  const html = renderReport(STEPS, { ok: false });
  const accordions = html.match(/<details/g) ?? [];
  assert.equal(accordions.length, 3);
  // <details> without `open` means initially closed.
  assert.ok(!/<details[^>]*\bopen\b/.test(html));
});

test("each step shows its name, status and duration", () => {
  const html = renderReport(STEPS, { ok: false });
  for (const step of STEPS) {
    assert.ok(html.includes(`>${step.name}</span>`), `name ${step.name}`);
  }
  assert.ok(html.includes("passed"));
  assert.ok(html.includes("failed"));
  assert.ok(html.includes(formatDuration(1234)));
});

test("services are marked and included", () => {
  const html = renderReport(STEPS, { ok: false });
  assert.ok(html.includes(`>database</span>`));
  assert.ok(html.includes(`class="tag">service`));
});

test("escapes HTML in step output", () => {
  const html = renderReport(STEPS, { ok: false });
  assert.ok(html.includes("assertion &lt;failed&gt; &amp; &quot;quoted&quot;"));
  assert.ok(!html.includes("<failed>"));
});

test("overall pass/fail is reflected in the header", () => {
  assert.ok(renderReport(STEPS, { ok: true }).includes("Passed"));
  const failed = renderReport(STEPS, { ok: false });
  assert.ok(failed.includes("Failed"));
  assert.ok(failed.includes("1 of 3 steps failed"));
});

test("a report with pending steps shows a running header and pending badges", () => {
  const steps: StepReport[] = [
    { name: "build", service: false, status: "success", durationMs: 100, output: "" },
    { name: "test", service: false, status: "pending", durationMs: 0, output: "" },
  ];
  // Even rendered as not-ok, a pending step means the run is still in progress.
  const html = renderReport(steps, { ok: false });
  assert.ok(html.includes("Running · 1 of 2 steps done"));
  assert.ok(/<header class="running"/.test(html));
  assert.ok(html.includes(`class="badge pending">pending`));
  // A pending step shows an ellipsis rather than a (meaningless) duration.
  assert.ok(html.includes(`<span class="duration">…</span>`));
});

test("empty output renders a placeholder", () => {
  const html = renderReport(
    [{ name: "x", service: false, status: "success", durationMs: 0, output: "" }],
    { ok: true },
  );
  assert.ok(html.includes("(no output)"));
});

test("formatDuration is human readable", () => {
  assert.equal(formatDuration(0), "0 ms");
  assert.equal(formatDuration(840), "840 ms");
  assert.equal(formatDuration(2400), "2.40 s");
  assert.equal(formatDuration(15000), "15.0 s");
  assert.equal(formatDuration(65000), "1 m 05 s");
});
