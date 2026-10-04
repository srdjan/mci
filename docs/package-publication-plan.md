# Matching package artifacts

## Objective and accepted direction

This unit addresses H5 (preserve a matching archive and formula) in
`plans/hardening-pruning-list.md`. A failed package preparation or publication must leave
the previous formula and its referenced archive usable.

The selected design uses checksum-named archives. The stable formula path remains
`dist/tap/Formula/mci.rb`. The user confirmed Decision 1: checksum-named archives with one
formula replacement.

The worker owns `scripts/package.ts` and `tests/package_test.ts`. The main agent owns this
plan, documentation, verification, and the local commit. Other backlog items remain
separate. The change does not install a package, restart a service, or add a CI trigger.

## Evidence and compatibility

At the start of this unit, tar wrote directly to a stable archive. A tar failure could
replace that archive with partial output. Checksum and formula failures occurred after
that overwrite. The formula writer could also leave partial formula contents.

Repository instructions consume the stable formula path. No repository caller requires the
archive filename. `PackageResult` reports archive, checksum, and formula paths. The CLI
prints those fields. Their shape and labels remain unchanged.

The new archive path follows
`dist/mci-<version>-darwin-<architecture>-<full-sha256>.tar.gz`. The generated formula
uses that absolute file URL. Existing archives remain available, including older archives
that use the previous filename. A consumer must use the reported path or formula URL.

## Publication contract

The packager creates the archive under a unique private path. That path must remain
outside the payload directory that tar archives. The packager never writes tar output into
a previously published archive.

A small public publication function accepts a prepared archive and package metadata. Typed
capabilities expose the operations needed to inject publication failures. Native compile,
Swift, signing, and bundle checks retain their existing behavior.

The publisher requires a real regular prepared file and rejects a source symlink. The
publisher computes the prepared archive checksum before publication. The publisher
prepares complete formula text under a unique path beside the stable formula. Both
artifacts remain private while checksum calculation or formula preparation can fail.

The publisher creates the checksum-named archive without replacing an existing path. A
native hard link can publish a complete prepared file on the same filesystem. If the path
already exists, the publisher requires a real regular file with the expected checksum. The
publisher rejects a conflicting object without changing it.

After the archive exists, one same-directory rename replaces the stable formula. This
rename is the publication point. A failed formula switch leaves the old formula unchanged.
The publisher must not remove earlier archives or overwrite checksum-named archives.

The publisher cleans the private archive before the formula switch. A cleanup failure
preserves the old formula and reports the retained private path. A successful formula
switch returns success without another fallible operation.

An archive published before a failed formula switch can remain unreferenced. Retaining
that archive cannot invalidate an earlier formula. Automatic archive pruning remains
outside this unit because copied formulas can refer to earlier archives.

Concurrent publishers prepare separate files. Each complete formula refers to an already
published archive with the matching checksum. The last formula switch wins. The publisher
does not promise which concurrent invocation wins or that its formula remains current.

Publication errors retain the primary detail. Private-file cleanup failures identify the
retained path. A cleanup failure must not cause deletion of any published archive.

## Test and implementation order

The worker first creates the public test seam while retaining the current publication
behavior. The worker then records a failing public regression for a formula or checksum
failure after archive replacement. A missing export alone is not regression evidence.

Tests use small temporary archives and simple capability functions. Tests do not compile
Deno, build Swift, sign apps, or change the real `dist` artifacts. Tests call the same
publication function that `packageRelease` uses.

Checks cover checksum failure, partial formula preparation, archive publication failure,
formula switch failure, successful publication, duplicate content, and conflicting archive
objects. Failure checks start with a matching earlier pair and compare both prior files.
Success checks parse the formula URL and hash the referenced file.

File URLs encode literal spaces, `#`, `?`, and `%` in filesystem paths. Source symlink
checks confirm that publication rejects the source before it creates an archive.

A concurrency check controls both formula switches. Every observed published formula must
refer to complete matching archive bytes. Existing formula text checks remain in place.
Each test must finish in less than one second on this host.

The main agent reviews every changed line and runs focused and full checks. An independent
review examines overwrite prevention, the formula switch, failure cleanup, and concurrent
publication. The local Git hook runs verification before a commit on `main`.

## Limits and ownership

The design covers handled failures and cooperating concurrent publishers. It does not
claim power-loss durability or protection from external programs that alter archives.
Process interruption can leave private files or an unreferenced complete archive.

The repository maintainer owns archive retention, pushes, and selection of the next
backlog item. The installed binary and monitor remain unchanged by this implementation.

## Completion evidence

The initial regression confirmed archive replacement before formula preparation failed. A
later review found a cleanup failure after the formula switch. The worker moved that
cleanup before the switch and added a public regression. The final independent review
found no remaining defect.

The main agent passed all 16 package tests and the native tar publication check.
`deno task verify` passed 222 Deno tests and 309 native monitor checks. One test for the
opposite platform was ignored. `VERIFICATION.md` records the evidence and limits.

The advisor preflight could not identify the parent runtime. The advisor route was
unavailable. The main agent retained review and acceptance ownership.
