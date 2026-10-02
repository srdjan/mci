import { attempt, err, ok, type Result } from "./result.ts";
import { normalizeStop, runProcess, type Stop } from "./process.ts";
import type { Env, Plan } from "./workflow.ts";
import { acquireWorkspace } from "./workspace.ts";

export type RunResult = {
  readonly kind: "success" | "failure" | "timeout" | "cancelled";
  readonly code: number;
  readonly completed: number;
  readonly total: number;
  readonly detail: string;
};

export const stepEnvironment = (
  inherited: Env,
  overlay: Env,
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(inherited).filter(([key]) =>
      !/^(GITHUB_|RUNNER_)/.test(key) && !["BASH_ENV", "ENV"].includes(key)
    ),
  ),
  ...overlay,
  CI: "true",
  MCI_LOCAL: "true",
});

export const resolveBash = async (
  workspace: string,
  path: string,
): Promise<Result<string>> => {
  for (const entry of path.split(":")) {
    const candidate = `${entry.startsWith("/") ? entry : `${workspace}/${entry}`}/bash`;
    const found = await attempt(async () => {
      const real = await Deno.realPath(candidate);
      const stat = await Deno.stat(real);
      return stat.isFile && stat.mode !== null && (stat.mode & 0o111) !== 0
        ? real
        : undefined;
    });
    if (found.ok && found.value) return ok(found.value);
  }
  return err("bash was not found on the invocation PATH");
};

export const runPlan = async (plan: Plan, options: {
  readonly workspace: string;
  readonly shell: string;
  readonly inherited: Env;
  readonly signal?: AbortSignal;
  readonly log?: (text: string) => void;
}): Promise<RunResult> => {
  const log = options.log ?? console.log;
  let completed = 0;
  const result = (kind: RunResult["kind"], code: number, detail: string): RunResult => ({
    kind,
    code,
    completed,
    total: plan.steps.length,
    detail,
  });
  const stopped = (reason: Stop) =>
    result(
      reason === "timeout" ? "timeout" : "cancelled",
      reason === "timeout" ? 124 : reason === "SIGINT" ? 130 : 143,
      reason,
    );
  const controller = new AbortController();
  const forward = () => controller.abort(normalizeStop(options.signal?.reason));
  options.signal?.addEventListener("abort", forward, { once: true });
  if (options.signal?.aborted) forward();
  if (controller.signal.aborted) {
    options.signal?.removeEventListener("abort", forward);
    return stopped(normalizeStop(controller.signal.reason));
  }
  const acquired = await acquireWorkspace(options.workspace);
  if (!acquired.ok) {
    options.signal?.removeEventListener("abort", forward);
    return result("failure", 1, acquired.error);
  }
  const lease = acquired.value;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = Infinity;
  const execute = async (): Promise<RunResult> => {
    for (const [index, step] of plan.steps.entries()) {
      if (controller.signal.aborted) return stopped(controller.signal.reason);
      const prepared = await lease.prepare(step, index);
      if (!prepared.ok) return result("failure", 1, `${step.name}: ${prepared.error}`);
      if (controller.signal.aborted) return stopped(controller.signal.reason);
      if (timer === undefined) {
        deadline = performance.now() + plan.timeoutMs;
        timer = setTimeout(() => controller.abort("timeout"), plan.timeoutMs);
      }
      if (performance.now() >= deadline) controller.abort("timeout");
      if (controller.signal.aborted) return stopped(controller.signal.reason);
      log(`[${index + 1}/${plan.steps.length}] ${step.name}`);
      const start = performance.now();
      const outcome = await runProcess({
        shell: options.shell,
        ...prepared.value,
        env: stepEnvironment(options.inherited, step.env),
        signal: controller.signal,
        onStart: lease.record,
        onFinish: () => lease.record(null),
      });
      if (!outcome.ok) return result("failure", 1, `${step.name}: ${outcome.error}`);
      log(
        `  ${
          outcome.value.kind === "exited"
            ? `exit ${outcome.value.code}`
            : outcome.value.reason
        } (${((performance.now() - start) / 1000).toFixed(2)}s)`,
      );
      if (outcome.value.kind === "stopped") return stopped(outcome.value.reason);
      completed++;
      if (outcome.value.code !== 0) {
        return result("failure", 1, `${step.name}: exit ${outcome.value.code}`);
      }
      if (controller.signal.aborted) return stopped(controller.signal.reason);
    }
    return result("success", 0, "all selected steps passed");
  };
  const executed = await attempt(execute);
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", forward);
  const primary = executed.ok ? executed.value : result("failure", 1, executed.error);
  const closed = await attempt(lease.close);
  const cleaned = closed.ok ? closed.value : closed;
  if (!cleaned.ok) {
    return result(
      "failure",
      1,
      `${primary.detail}; workspace cleanup failed: ${cleaned.error}`,
    );
  }
  return primary;
};
