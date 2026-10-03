import { formulaText } from "../scripts/package.ts";
import { assert, equal } from "./helpers.ts";

Deno.test("the local formula installs the binary, app, Deno, and daemon service", () => {
  const formula = formulaText(
    "1.2.3",
    "file:///tmp/mci-1.2.3-darwin-arm64.tar.gz",
    "a".repeat(64),
  );
  for (
    const text of [
      'url "file:///tmp/mci-1.2.3-darwin-arm64.tar.gz"',
      'version "1.2.3"',
      `sha256 "${"a".repeat(64)}"`,
      'depends_on "deno"',
      'bin.install "bin/mci"',
      'libexec.install "libexec/mci Monitor.app"',
      'libexec.install "libexec/hooks"',
      'run [opt_bin/"mci", "daemon"]',
      "keep_alive true",
    ]
  ) assert(formula.includes(text), text);
  assert(!formula.includes("homepage"));
  assert(!formula.includes("swift"));
  assert(!formula.includes("git clone"));
});

Deno.test("the tracked formula matches generated installation steps", async () => {
  const tracked = await Deno.readTextFile(
    new URL("../Formula/mci.rb", import.meta.url),
  );
  equal(
    tracked
      .replace("__MCI_ARCHIVE__", "/tmp/mci.tar.gz")
      .replace("__MCI_VERSION__", "1.2.3")
      .replace("__MCI_SHA256__", "a".repeat(64)),
    formulaText("1.2.3", "file:///tmp/mci.tar.gz", "a".repeat(64)),
  );
});
