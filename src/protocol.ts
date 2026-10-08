import { err, ok, type Result } from "./result.ts";
import type { Env } from "./workflow.ts";

export type TerminalKind =
  | "success"
  | "failure"
  | "timeout"
  | "cancelled"
  | "interrupted";
export type Terminal = {
  readonly id: string;
  readonly repositoryId: string;
  readonly workflow: string;
  readonly job: string;
  readonly started: string;
  readonly finished: string;
  readonly kind: TerminalKind;
  readonly code: number;
  readonly completed: number;
  readonly total: number;
  readonly detail: string;
  readonly log: string;
};
export type Active = {
  readonly id: string;
  readonly workflow: string;
  readonly job: string;
  readonly started: string;
  readonly step: string | null;
  readonly log: string;
};
export type Repository = { readonly id: string; readonly path: string };
export type RepositoryState = Repository & {
  readonly queued: number;
  readonly active: Active | null;
  readonly latest: Terminal | null;
  readonly blocked: string | null;
};
export type Snapshot = {
  readonly version: 1;
  readonly instance: string;
  readonly pid: number;
  readonly updated: string;
  readonly repositories: readonly RepositoryState[];
};
export type Request =
  | { readonly version: 1; readonly op: "ping" | "status" }
  | { readonly version: 1; readonly op: "register"; readonly path: string }
  | { readonly version: 1; readonly op: "unregister"; readonly repository: string }
  | {
    readonly version: 1;
    readonly op: "submit";
    readonly path: string;
    readonly workflow: string;
    readonly job: string;
    readonly source: string;
    readonly env: Env;
  }
  | { readonly version: 1; readonly op: "cancel"; readonly reason: "SIGINT" | "SIGTERM" };
export type ErrorTag = "invalid" | "unavailable" | "unregistered" | "busy" | "storage";
export type Response =
  | { readonly version: 1; readonly type: "ok"; readonly snapshot: Snapshot }
  | {
    readonly version: 1;
    readonly type: "accepted";
    readonly id: string;
    readonly log: string;
  }
  | { readonly version: 1; readonly type: "result"; readonly result: Terminal }
  | {
    readonly version: 1;
    readonly type: "error";
    readonly tag: ErrorTag;
    readonly detail: string;
  };

const object = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (
  v: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean =>
  Object.keys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k));
const string = (v: unknown): v is string => typeof v === "string" && !v.includes("\0");
const nonempty = (v: unknown): v is string => string(v) && v.length > 0;
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && typeof v === "number" && v >= 0;
const timestamp = (v: unknown): v is string =>
  string(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const environment = (v: unknown): v is Env =>
  object(v) &&
  Object.entries(v).every(([k, value]) =>
    nonempty(k) && !k.includes("=") && string(value)
  );

export const decodeRequest = (v: unknown): Result<Request> => {
  if (!object(v) || v.version !== 1) {
    return err("Unknown protocol version or request format");
  }
  const base = ["version", "op"];
  if ((v.op === "ping" || v.op === "status") && keys(v, base)) {
    return ok({ version: 1, op: v.op });
  }
  if (
    v.op === "register" && keys(v, [...base, "path"]) && nonempty(v.path) &&
    v.path.startsWith("/")
  ) {
    return ok({ version: 1, op: "register", path: v.path });
  }
  if (
    v.op === "unregister" && keys(v, [...base, "repository"]) && nonempty(v.repository)
  ) {
    return ok({ version: 1, op: "unregister", repository: v.repository });
  }
  if (
    v.op === "cancel" && keys(v, [...base, "reason"]) &&
    (v.reason === "SIGINT" || v.reason === "SIGTERM")
  ) {
    return ok({ version: 1, op: "cancel", reason: v.reason });
  }
  if (
    v.op === "submit" && keys(v, [...base, "path", "workflow", "job", "source", "env"]) &&
    nonempty(v.path) && v.path.startsWith("/") && nonempty(v.workflow) &&
    nonempty(v.job) &&
    string(v.source) && environment(v.env)
  ) {
    return ok({
      version: 1,
      op: "submit",
      path: v.path,
      workflow: v.workflow,
      job: v.job,
      source: v.source,
      env: v.env,
    });
  }
  return err("Invalid request fields or operation");
};

/** A terminal finish time. A clock that moved back never ends a record before it starts. */
export const finishTime = (started: string, now: string): string =>
  Date.parse(now) < Date.parse(started) ? started : now;

export const decodeTerminal = (v: unknown): Result<Terminal> => {
  if (
    !object(v) ||
    !keys(v, [
      "id",
      "repositoryId",
      "workflow",
      "job",
      "started",
      "finished",
      "kind",
      "code",
      "completed",
      "total",
      "detail",
      "log",
    ])
  ) {
    return err("Invalid terminal record format");
  }
  const kind = v.kind;
  if (
    nonempty(v.id) && nonempty(v.repositoryId) && nonempty(v.workflow) &&
    nonempty(v.job) &&
    timestamp(v.started) && timestamp(v.finished) &&
    Date.parse(v.finished) >= Date.parse(v.started) &&
    (kind === "success" || kind === "failure" || kind === "timeout" ||
      kind === "cancelled" || kind === "interrupted") &&
    integer(v.code) && integer(v.completed) && integer(v.total) &&
    v.completed <= v.total &&
    string(v.detail) && nonempty(v.log) && v.log.startsWith("/") &&
    (kind === "success" ? v.code === 0 : v.code !== 0)
  ) {
    return ok({
      id: v.id,
      repositoryId: v.repositoryId,
      workflow: v.workflow,
      job: v.job,
      started: v.started,
      finished: v.finished,
      kind,
      code: v.code,
      completed: v.completed,
      total: v.total,
      detail: v.detail,
      log: v.log,
    });
  }
  return err("Invalid terminal record fields");
};

const decodeActive = (v: unknown): Result<Active> => {
  if (
    object(v) && keys(v, ["id", "workflow", "job", "started", "step", "log"]) &&
    nonempty(v.id) && nonempty(v.workflow) && nonempty(v.job) && timestamp(v.started) &&
    (v.step === null || string(v.step)) && nonempty(v.log) && v.log.startsWith("/")
  ) {
    return ok({
      id: v.id,
      workflow: v.workflow,
      job: v.job,
      started: v.started,
      step: v.step,
      log: v.log,
    });
  }
  return err("Invalid active record");
};
export const decodeSnapshot = (v: unknown): Result<Snapshot> => {
  if (
    !object(v) || !keys(v, ["version", "instance", "pid", "updated", "repositories"]) ||
    v.version !== 1 || !nonempty(v.instance) || !integer(v.pid) || v.pid < 1 ||
    !timestamp(v.updated) || !Array.isArray(v.repositories)
  ) return err("Invalid daemon snapshot");
  const repositories: RepositoryState[] = [];
  for (const r of v.repositories) {
    if (
      !object(r) || !keys(r, ["id", "path", "queued", "active", "latest", "blocked"]) ||
      !nonempty(r.id) || !nonempty(r.path) || !r.path.startsWith("/") ||
      !integer(r.queued) ||
      !(r.blocked === null || string(r.blocked))
    ) return err("Invalid repository snapshot");
    const active = r.active === null ? ok(null) : decodeActive(r.active);
    const latest = r.latest === null ? ok(null) : decodeTerminal(r.latest);
    if (!active.ok) return active;
    if (!latest.ok) return latest;
    if (latest.value !== null && latest.value.repositoryId !== r.id) {
      return err("Result belongs to another repository");
    }
    if (repositories.some((prior) => prior.id === r.id || prior.path === r.path)) {
      return err("Duplicate repository");
    }
    repositories.push({
      id: r.id,
      path: r.path,
      queued: r.queued,
      active: active.value,
      latest: latest.value,
      blocked: r.blocked,
    });
  }
  return ok({
    version: 1,
    instance: v.instance,
    pid: v.pid,
    updated: v.updated,
    repositories,
  });
};
export const decodeResponse = (v: unknown): Result<Response> => {
  if (!object(v) || v.version !== 1) {
    return err("Unknown protocol version or response format");
  }
  if (v.type === "ok" && keys(v, ["version", "type", "snapshot"])) {
    const snapshot = decodeSnapshot(v.snapshot);
    return snapshot.ok
      ? ok({ version: 1, type: "ok", snapshot: snapshot.value })
      : snapshot;
  }
  if (v.type === "result" && keys(v, ["version", "type", "result"])) {
    const result = decodeTerminal(v.result);
    return result.ok ? ok({ version: 1, type: "result", result: result.value }) : result;
  }
  if (
    v.type === "accepted" && keys(v, ["version", "type", "id", "log"]) &&
    nonempty(v.id) && nonempty(v.log) && v.log.startsWith("/")
  ) {
    return ok({ version: 1, type: "accepted", id: v.id, log: v.log });
  }
  if (
    v.type === "error" && keys(v, ["version", "type", "tag", "detail"]) &&
    string(v.detail) &&
    (v.tag === "invalid" || v.tag === "unavailable" || v.tag === "unregistered" ||
      v.tag === "busy" || v.tag === "storage")
  ) {
    return ok({ version: 1, type: "error", tag: v.tag, detail: v.detail });
  }
  return err("Invalid response fields");
};
