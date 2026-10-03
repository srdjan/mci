class Mci < Formula
  desc "Local macOS CI with one daemon for multiple repositories"
  url "file://__MCI_ARCHIVE__"
  version "__MCI_VERSION__"
  sha256 "__MCI_SHA256__"

  depends_on "deno"

  def install
    bin.install "bin/mci"
    libexec.install "libexec/mci Monitor.app"
    libexec.install "libexec/hooks"
  end

  service do
    run [opt_bin/"mci", "daemon"]
    keep_alive true
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/mci --version")
  end
end
