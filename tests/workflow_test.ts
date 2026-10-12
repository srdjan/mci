import { planWorkflow } from "../src/workflow.ts";
import { assert, equal, fixture, unwrap } from "./helpers.ts";

Deno.test("literal YAML and env/default precedence produce a selected job plan", () => {
  const plan = unwrap(planWorkflow(
    `
name: Example
on:
  push:
    branches: [main]
env:
  VALUE: workflow
  BOOL: "true"
defaults:
  run:
    shell: bash
    working-directory: shared
jobs:
  hosted:
    uses: team/workflows/ci.yml@main
  check:
    runs-on: macos-latest
    timeout-minutes: 2
    env:
      VALUE: job
    defaults:
      run:
        working-directory: package
    steps:
      - run: echo "$VALUE"
        env:
          VALUE: step
      - name: Second
        run: echo done
        working-directory: .
`,
    "check",
  ));
  equal(plan.timeoutMs, 120000);
  equal(plan.otherJobs, ["hosted"]);
  equal(plan.steps.map((s) => [s.env.VALUE, s.env.BOOL, s.directory]), [
    ["step", "true", "package"],
    ["job", "true", "."],
  ]);
});

Deno.test("planner keeps unselected job names as display metadata", () => {
  const source = fixture("      - run: echo selected").replace(
    "  check:",
    '  "": null\n  "\\0job": null\n  check:',
  );
  const plan = unwrap(planWorkflow(source, "check"));
  equal(plan.otherJobs, ["", "\0job"]);
  equal(plan.steps.map((step) => step.script), ["echo selected"]);
});

Deno.test("unknown features and malformed values fail before execution", () => {
  const basic = fixture("      - run: echo first");
  const cases = [
    basic.replace("run: echo first", "uses: actions/checkout@v4"),
    basic.replace("run: echo first", "run: echo first\n        if: true"),
    basic.replace("run: echo first", "run: echo '${{ github.sha }}'"),
    basic.replace("run: echo first", "run: false"),
    basic.replace("run: echo first", "run: ''"),
    basic.replace("run: echo first", "run: echo x\n        working-directory: ../escape"),
    basic.replace("run: echo first", "run: echo x\n        env: {NUMBER: 1}"),
    basic.replace("run: echo first", "run: echo x\n        env: {CI: 'false'}"),
    basic.replace(
      "run: echo first",
      "run: echo x\n        env: {MCI_TASK_PARENT: 'true'}",
    ),
    basic.replace(
      "run: echo first",
      "run: echo x\n        env: {MCI_DAEMON_SOCKET: /tmp/other.sock}",
    ),
    basic.replace(
      "run: echo first",
      "run: echo x\n        env: {MCI_REPOSITORY_PATH: /tmp/other}",
    ),
    basic.replace("run: echo first", "run: echo x\n        env: {BASH_ENV: file}"),
    basic.replace("run: echo first", "run: echo x\n        env: {GITHUB_TOKEN: value}"),
    basic.replace("shell: bash", "shell: zsh"),
    basic.replace("    shell: bash", "    working-directory: ."),
    basic.replace("macos-latest", "ubuntu-latest"),
    basic.replace("    steps:", "    needs: other\n    steps:"),
    basic.replace("    steps:", "    timeout-minutes: 0\n    steps:"),
    basic.replace("    steps:", "    timeout-minutes: 1.5\n    steps:"),
    basic.replace("    steps:", "    timeout-minutes: null\n    steps:"),
    basic.replace(
      "    steps:",
      "    strategy: {matrix: {os: [macos-latest]}}\n    steps:",
    ),
    basic + "permissions: read-all\n",
  ];
  for (const source of cases) assert(!planWorkflow(source, "check").ok, source);
});

Deno.test("YAML ambiguities and aliases are rejected globally", () => {
  const basic = fixture("      - run: echo first");
  const cases = [
    basic + "name: Duplicate\n",
    basic + "---\nname: Second document\n",
    basic.replace("on: workflow_dispatch", "on: &events [push]\nextra: *events"),
    basic.replace("on: workflow_dispatch", "on: {<<: {push: null}}"),
    basic.replace("on: workflow_dispatch", "on: {3: null}"),
    basic.replace("run: echo first", "run: !!str echo first"),
    basic.replace("on: workflow_dispatch", "on: {push: null, push: null}"),
  ];
  for (const source of cases) assert(!planWorkflow(source, "check").ok, source);
  // Literal shell characters must not be mistaken for YAML nodes.
  assert(planWorkflow(fixture("      - run: |\n          echo '& * !! <<'"), "check").ok);
});

Deno.test("missing jobs, steps and non-string defaults have useful errors", () => {
  const missing = planWorkflow(fixture("      - run: true"), "missing");
  assert(!missing.ok && missing.error.includes("job not found"));
  const noSteps = planWorkflow(
    fixture("      - run: echo ok").replace("steps:\n      - run: echo ok", "steps: []"),
    "check",
  );
  assert(!noSteps.ok);
  const badDefault = planWorkflow(
    fixture("      - run: echo ok").replace(
      "shell: bash",
      "shell: bash\n    working-directory: 123",
    ),
    "check",
  );
  assert(!badDefault.ok);
});

Deno.test("job timeout uses the default, accepts the maximum, and rejects overflow", () => {
  const source = fixture("      - run: echo ok");
  equal(unwrap(planWorkflow(source, "check")).timeoutMs, 15 * 60_000);
  equal(
    unwrap(planWorkflow(
      source.replace("    steps:", "    timeout-minutes: 35791\n    steps:"),
      "check",
    )).timeoutMs,
    35791 * 60_000,
  );
  const overflow = planWorkflow(
    source.replace("    steps:", "    timeout-minutes: 35792\n    steps:"),
    "check",
  );
  assert(!overflow.ok && overflow.error.includes("jobs.check.timeout-minutes"));
});

Deno.test("global YAML errors keep locations when another job is selected", () => {
  const source = fixture("      - run: echo ok").replace(
    "  check:",
    "  broken:\n    runs-on: macos-latest\n    steps:\n      - run: echo one\n        run: echo two\n  check:",
  );
  const plan = planWorkflow(source, "check");
  assert(!plan.ok);
  assert(/line \d+, column \d+/.test(plan.error), plan.error);
});
