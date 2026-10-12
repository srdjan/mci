# Concepts

## Commit gate

The commit gate is the CI job that the effective Git pre-commit hook submits before each
commit. A failed job blocks the commit.

## Packaged hook

The packaged hook is the pre-commit script that the Homebrew package installs. It calls
the repository's `mci:ci` task, which submits the selected workflow and job to the daemon.

## Service directory

The service directory holds the daemon socket, lock, registry, request journal, and
session receipts for one user. `MCI_HOME` selects another service directory, so a daemon
with another service directory is a separate daemon.

## Source daemon

A source daemon runs from a checkout instead of the Homebrew package. It keeps the code
that it loaded at start, but each worker that it starts loads the current checkout.

## Worker

A worker is the separate process that runs one accepted job for the daemon. A worker fault
cannot stop the daemon.

## Latest result

The latest result is the most recent completed job of a repository. A job that leaves the
queue before it starts never replaces it.

## Receipt

A receipt records one `mci ci` or `mci run` invocation inside an agent session. The Codex
adapter reads receipts to report unresolved CI failures to that session.
