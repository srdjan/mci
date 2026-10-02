import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  LineCounter,
  parseDocument,
  visit,
} from "yaml";
import { err, message, ok, type Result } from "./result.ts";

type MapValue = Readonly<Record<string, unknown>>;
export type Env = Readonly<Record<string, string>>;
export type Step = {
  readonly name: string;
  readonly script: string;
  readonly directory: string;
  readonly env: Env;
};
export type Plan = {
  readonly job: string;
  readonly name: string;
  readonly timeoutMs: number;
  readonly steps: readonly Step[];
  readonly otherJobs: readonly string[];
};

const mapping = (value: unknown): value is MapValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: MapValue, key: string) => Object.hasOwn(value, key);
const reserved = (key: string) =>
  /^(GITHUB_|RUNNER_)/.test(key) || ["CI", "MCI_LOCAL", "BASH_ENV", "ENV"].includes(key);

export const validDirectory = (path: string): boolean => {
  if (!path || path.startsWith("/") || path.includes("\0")) return false;
  let depth = 0;
  for (const part of path.split("/")) {
    if (part === "..") {
      if (--depth < 0) return false;
    } else if (part && part !== ".") depth++;
  }
  return true;
};

/** One document; duplicate keys, aliases, tags and non-string keys fail globally. */
const readYaml = (source: string): Result<unknown> => {
  try {
    const counter = new LineCounter();
    const doc = parseDocument(source, {
      version: "1.2",
      schema: "core",
      uniqueKeys: true,
      lineCounter: counter,
    });
    if (doc.errors.length) return err(doc.errors.map((e) => e.message).join("\n"));
    const errors: string[] = [];
    visit(doc, (_, node) => {
      if (!node || typeof node !== "object") return;
      const offset = isNode(node) ? node.range?.[0] ?? 0 : 0;
      const at = counter.linePos(offset);
      const fail = (reason: string) => errors.push(`${at.line}:${at.col}: ${reason}`);
      if (isAlias(node)) fail("YAML aliases are unsupported");
      if ("tag" in node && node.tag) fail("Explicit YAML tags are unsupported");
      if (isMap(node)) {
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
            fail("Mapping keys must be strings");
          } else if (pair.key.value === "<<") fail("YAML merge keys are unsupported");
        }
      }
    });
    if (errors.length) return err(errors.join("\n"));
    if (doc.warnings.length) return err(doc.warnings.map((w) => w.message).join("\n"));
    return ok(doc.toJS({ maxAliasCount: 0 }));
  } catch (error) {
    return err(message(error));
  }
};

/** Pure validation. No reads, process launches, expression evaluation or action fetching. */
export const planWorkflow = (source: string, jobId: string): Result<Plan> => {
  const parsed = readYaml(source);
  if (!parsed.ok) return parsed;
  const errors: string[] = [];
  const fail = (path: string, why: string) => errors.push(`${path}: ${why}`);
  const object = (value: unknown, path: string, optional = false): MapValue => {
    if (value === undefined && optional) return {};
    if (mapping(value)) return value;
    fail(path, "expected a mapping");
    return {};
  };
  const keys = (value: MapValue, allowed: readonly string[], path: string) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(`${path}.${key}`, "unsupported field");
    }
  };
  const string = (value: unknown, path: string, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && value.trim() && !value.includes("\0")) return value;
    fail(path, "expected a nonempty string without NUL bytes");
    return fallback;
  };
  const expressions = (value: unknown, path: string): void => {
    if (typeof value === "string" && value.includes("${{")) {
      fail(path, "GitHub expressions are unsupported");
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => expressions(item, `${path}[${i}]`));
    } else if (mapping(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key.includes("${{")) fail(path, "GitHub expressions in keys are unsupported");
        expressions(item, `${path}.${key}`);
      }
    }
  };
  const env = (value: unknown, path: string): Env => {
    const obj = object(value, path, true);
    for (const [key, item] of Object.entries(obj)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        fail(path, `invalid variable name ${key}`);
      }
      if (reserved(key)) fail(`${path}.${key}`, "reserved environment variable");
      if (typeof item !== "string" || item.includes("\0")) {
        fail(`${path}.${key}`, "expected a literal string; quote numbers and booleans");
      }
    }
    return obj as Env;
  };
  const defaults = (value: unknown, path: string): MapValue => {
    const obj = object(value, path, true);
    keys(obj, ["run"], path);
    const run = object(obj.run, `${path}.run`, true);
    keys(run, ["shell", "working-directory"], `${path}.run`);
    if (own(run, "shell") && run.shell !== "bash") {
      fail(path, "only shell: bash is supported");
    }
    if (
      own(run, "working-directory") &&
      (typeof run["working-directory"] !== "string" ||
        !validDirectory(run["working-directory"]))
    ) {
      fail(path, "working-directory must be a relative path inside the workspace");
    }
    return run;
  };
  const root = object(parsed.value, "workflow");
  keys(root, ["name", "on", "env", "defaults", "jobs"], "workflow");
  string(root.name, "workflow.name", "Local CI");
  for (const key of ["name", "env", "defaults"]) {
    expressions(root[key], `workflow.${key}`);
  }
  const sharedEnv = env(root.env, "env");
  const sharedDefaults = defaults(root.defaults, "defaults");
  const jobs = object(root.jobs, "jobs");
  if (!own(jobs, jobId)) return err(`jobs.${jobId}: job not found`);
  const path = `jobs.${jobId}`;
  const job = object(jobs[jobId], path);
  keys(job, ["name", "runs-on", "env", "defaults", "timeout-minutes", "steps"], path);
  expressions(job, path);
  if (job["runs-on"] !== "macos-latest") fail(`${path}.runs-on`, "must be macos-latest");
  const jobEnv = env(job.env, `${path}.env`);
  const jobDefaults = {
    ...sharedDefaults,
    ...defaults(job.defaults, `${path}.defaults`),
  };
  const name = string(job.name, `${path}.name`, jobId);
  const minutes = own(job, "timeout-minutes") ? job["timeout-minutes"] : 15;
  if (
    typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < 1 ||
    minutes > 35791
  ) {
    fail(`${path}.timeout-minutes`, "expected an integer from 1 to 35791");
  }
  if (!Array.isArray(job.steps) || !job.steps.length) {
    fail(`${path}.steps`, "expected a nonempty sequence");
  }
  const steps = (Array.isArray(job.steps) ? job.steps : []).map((value, i): Step => {
    const at = `${path}.steps[${i}]`;
    const step = object(value, at);
    keys(step, ["name", "run", "shell", "env", "working-directory"], at);
    const shell = own(step, "shell") ? step.shell : jobDefaults.shell;
    if (shell !== "bash") {
      fail(`${at}.shell`, "explicit shell: bash is required (defaults.run is supported)");
    }
    if (!own(step, "run")) {
      fail(`${at}.run`, "run is required; uses actions are unsupported");
    }
    const directory = string(
      own(step, "working-directory")
        ? step["working-directory"]
        : jobDefaults["working-directory"],
      `${at}.working-directory`,
      ".",
    );
    if (!validDirectory(directory)) {
      fail(`${at}.working-directory`, "must stay inside the workspace");
    }
    return {
      name: string(step.name, `${at}.name`, `Step ${i + 1}`),
      script: string(step.run, `${at}.run`, ""),
      directory,
      env: { ...sharedEnv, ...jobEnv, ...env(step.env, `${at}.env`) },
    };
  });
  return errors.length ? err(errors.join("\n")) : ok({
    job: jobId,
    name,
    timeoutMs: (minutes as number) * 60_000,
    steps,
    otherJobs: Object.keys(jobs).filter((key) => key !== jobId),
  });
};
