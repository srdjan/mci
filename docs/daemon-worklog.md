# Shared daemon implementation

The accepted plan adds one user daemon, FIFO queues per repository, concurrent
repositories, and Homebrew installation. YAML jobs invoke Deno tasks. The native monitor
shows results and never starts CI. Caller disconnection cancels only its own request.
Restart interrupts unfinished requests without automatic retry. Completed evidence remains
visible during active runs. Retention keeps latest results and files needed by connected
clients.

## Ownership

The main agent owns protocol types, CLI integration, verification, documentation, and
local commits. The daemon worker owns execution, queues, persistence, and execution tests.
The monitor worker owns native integration and native checks. The installer worker owns
packaging, setup, hook installation, and installer checks.

## Baseline

The working tree was clean at b9b99d6. The native app and source installer already exist.
Recent changes confirm login registration survives reinstall and improve the panel
background. The daemon and Homebrew package do not exist at this baseline.

## Next action

The main agent will establish the protocol before parallel implementation.
