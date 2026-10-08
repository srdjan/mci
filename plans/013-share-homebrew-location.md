# Plan 013: Share absolute Homebrew location

## Authority and baseline

The user authorized all numbered items. This unit covers H7, absolute Homebrew location,
and the remaining Homebrew part of P3, shared native primitives. The baseline is `81b3368`
on local `main`.

Source service control invokes bare `brew`. Hook and packaged installation repeat
supported absolute location checks. Restricted `PATH` therefore prevents source service
shutdown.

## Contract and design

Share a narrow locator for `/opt/homebrew/bin/brew` and `/usr/local/bin/brew`. Preserve
existing order, regular-file selection through `stat`, absence errors, command budgets,
and installation transactions. The locator must not depend on `PATH`.

Expose a small service stop capability for controlled command checks. Its native caller
uses the shared locator and existing bounded command runner. The selected absolute command
receives `services stop mci`. An absent executable starts no command. Do not stop the
user's service during tests.

## Scope and ownership

The main agent owns `src/homebrew.ts`, `src/install.ts`, `src/hooks.ts`,
`scripts/service.ts`, documentation, review, checks, and commit. The worker owns
`tests/homebrew_test.ts` and additions to `tests/service_test.ts` only. Other agents share
the checkout. Preserve their edits. Work directly on local `main`; never push.

## Ordered execution and validation

1. Extract supported location checks and retain existing locator behavior.
2. Expose the existing bare-command service path through a controlled capability.
3. Add a public regression where bare `brew` fails under restricted `PATH`.
4. Observe the failure, then resolve the supported absolute command before service stop.
5. Check both supported paths, precedence, absent locations, command failures, and no
   launch after absence. Confirm native location with restricted `PATH` through read-only
   probes.
6. Review every changed line. Run focused checks and the complete local gate.

Each new test must finish below one second. Native probes inspect files only and must not
invoke Homebrew service mutation. Preserve installer and service checks. Add no
dependency, remote workflow, generic service framework, or installation redesign.

## Completion and limits

All three callers share the locator. Source stop uses an absolute supported command.
Location and compatibility checks pass. Record H7 and P3 completion and create one local
commit. Request a decision before a script exceeds two minutes. Report scope expansion
before editing another module.
