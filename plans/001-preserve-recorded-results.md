# Plan 001: Preserve recorded CI results after projection failure

## Status and authority

This plan covers audit finding 1: projection failure can replace a recorded success with
failure. The user selected this plan on 2026-10-06. Implementation is complete in local
commit `ff618a8`. The [plan index](README.md) owns current status.

Priority is high. Effort and change risk are medium. Confidence is high. No other plan is
a prerequisite. The source baseline is local `main` at `7b74afa`.

The executor owns implementation, checks, and one local commit. The maintainer owns
backups. Work on local `main`; do not push or create a branch.

## Problem and evidence

`src/daemon-store.ts:610-622` writes the request terminal before three projections. A
projection is a copy of the result for another consumer. These projections are
`latest.json`, `latest.log`, and `status.json`.

`src/daemon.ts:451-458` treats recording and projection failures alike. It writes a
replacement failure under the same request identifier. That write can overwrite the
recorded worker result.

The replacement write at `src/daemon.ts:458` is the critical drift excerpt:

```ts
stored = await runtime.store.writeTerminal(repository.repository.path, result);
```

The audit called the public store API with a blocked `latest.json` path. The first write
failed, but its request record contained success. The replacement write changed that
record to failure. This probe reproduced the store sequence, rather than a complete daemon
request.

`docs/design.md:86-88` requires recorded results to preserve completed work after
projection failure. `tests/daemon_race_test.ts:108-134` covers direct store recovery but
omits the daemon's replacement write.

## Scope and boundaries

| File                        | Permitted change                                |
| --------------------------- | ----------------------------------------------- |
| `src/daemon-store.ts`       | Separate terminal recording from projection.    |
| `src/daemon.ts`             | Update completion and startup recovery callers. |
| `tests/daemon_race_test.ts` | Add public daemon and store regressions.        |
| `tests/daemon_test.ts`      | Update affected store fixtures and assertions.  |
| `docs/design.md`            | Describe the recording and projection contract. |
| `VERIFICATION.md`           | Record observed checks and evidence limits.     |
| `plans/README.md`           | Update this plan's status.                      |

Exclude protocol changes, monitor changes, workflow retries, and retention redesign.
Preserve the existing record shapes, log paths, FIFO queues, and ownership of
cancellation. Retain all three projections. Preserve completed results during shutdown.

Use `Result` for expected failures. Do not use `any`. Match the functions and in-memory
test doubles in the current daemon tests.

## Drift check and commands

Run the drift check first. Compare changed source against the evidence above before
editing.

```sh
git diff 7b74afa -- src/daemon-store.ts src/daemon.ts tests/daemon_race_test.ts tests/daemon_test.ts docs/design.md VERIFICATION.md
```

| Purpose         | Command                                                                         | Expected result              |
| --------------- | ------------------------------------------------------------------------------- | ---------------------------- |
| Type checks     | `deno task check`                                                               | Exit 0.                      |
| Focused checks  | `deno test --permission-set=mci tests/daemon_test.ts tests/daemon_race_test.ts` | All selected tests pass.     |
| Format          | `deno task fmt:check`                                                           | Exit 0.                      |
| Lint            | `deno task lint`                                                                | Exit 0.                      |
| Complete checks | `deno task verify`                                                              | Deno and native checks pass. |

No dependency installation is required. Git's existing pre-commit hook runs local CI. The
hook requires a registered checkout and a responding daemon. Do not bypass the hook.

## Ordered implementation

### Step 1: Add a daemon regression

Use `startDaemon` with its `openStore` seam in `tests/daemon_race_test.ts`. Inject a real
projection failure after the original terminal record succeeds. Submit a passing job
through the public socket. Count workflow executions with a fixture file.

Assert that the original request record remains success. Assert that the client receives
that original terminal. Assert that the repository reports the projection fault and
retains the pending journal entry.

The new test must fail against the baseline. Run the focused command after adding it.

### Step 2: Separate recording and projection

Keep `writeTerminal` for recording the request terminal only. Add `projectTerminal` to
`DaemonStore` for the three existing projections. Both operations return `Result<void>`.
Keep per-repository serialization for projection writes.

Make identical repeated recording idempotent. Refuse a conflicting payload for an existing
request identifier. Do not replace an existing terminal to report a storage fault.

Retain directory checks, log preparation, atomic replacement, and existing sync behavior.
Update every caller and fixture found by `rg -n 'writeTerminal' src tests`.

Verify that type checks pass. Confirm that request records and projections keep their
existing JSON shapes.

### Step 3: Preserve the worker result during completion

In `complete`, record the original result before projection. After recording succeeds,
keep the original result in memory and return it to its client.

If projection fails, block that repository with the storage diagnostic. Retain its journal
entry and recovery files. Settle queued work through the existing blocked-repository path.
Do not rerun the workflow or overwrite the original terminal.

If recording fails, return a storage failure and retain recovery evidence. Do not assume
that a failed sync means no file exists. Never overwrite an existing record during
fallback.

Run the focused command. Require the regression to pass and the execution count to remain
one.

### Step 4: Update recovery and record evidence

In `prepareRuntime`, project a recovered terminal without replacing its request record.
For an interrupted request, record its terminal before projection. Finish its journal
entry only after the required projection succeeds.

Preserve the existing ordering rule for multiple pending completions. Retain the existing
compatibility path for a completed result found only in `latest.json`.

Restore the projection target in the regression. Then restart the daemon. Assert success
recovery, an empty request journal, matching projections, and no repeated execution.

Run complete checks. Update documentation, verification evidence, and the index before the
local commit.

## Test cases and done criteria

Cover failure at each projection target after recording succeeds. Cover recording failure,
conflicting repeated recording, journal cleanup failure, and shutdown after worker
success. Use public store methods and daemon requests. Keep each new test below one
second.

Completion requires passing focused and complete checks. The original terminal must
survive projection faults and restart. No workflow may run twice. Only scoped files may
change. The index must record completion and the local commit.

## Stop conditions

Stop if the live recording order differs from the evidence. Stop if a fix requires a new
protocol version or removal of a documented projection. Stop if directory-sync ambiguity
requires a new durability claim. Stop if a verification command fails twice after local
correction. Report any required file outside the scope.

## Maintenance notes

Projection faults are storage faults, not changes to the workflow outcome. Reviewers must
check journal retention and pruning together. Power-loss durability remains unmeasured.
