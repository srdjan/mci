// @light-fp adapter
import { attempt, err, message, ok, type Result } from "../src/result.ts";
import { cliVersion } from "../src/runtime.ts";
import { hookScript } from "../src/hooks.ts";

export type PackageOptions = {
  readonly root: string;
  readonly appBundle?: string;
  readonly version: string;
  readonly architecture: "arm64" | "x86_64";
};

export type PackageResult = {
  readonly archive: string;
  readonly checksum: string;
  readonly formula: string;
};

export type PackageMetadata = {
  readonly root: string;
  readonly version: string;
  readonly architecture: "arm64" | "x86_64";
};

export type ArchivePublication = "created" | "exists";

export type PackagePublicationCapabilities = {
  readonly checksum: (path: string) => Promise<Result<string>>;
  readonly writeFormula: (path: string, text: string) => Promise<Result<void>>;
  readonly publishArchive: (
    preparedArchive: string,
    publishedArchive: string,
  ) => Promise<Result<ArchivePublication>>;
  readonly replaceFormula: (
    preparedFormula: string,
    formula: string,
  ) => Promise<Result<void>>;
  readonly cleanup: (path: string) => Promise<Result<void>>;
};

const bundleName = "mci Monitor.app";
const ownerValue = "mci";
const executableName = "MonitorApp";

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const plistEntries = (version: string): readonly (readonly [string, string])[] => [
  ["CFBundleIdentifier", `<string>dev.mci.monitor</string>`],
  ["CFBundleName", `<string>mci Monitor</string>`],
  ["CFBundleDisplayName", `<string>mci Monitor</string>`],
  ["CFBundleExecutable", `<string>${executableName}</string>`],
  ["CFBundlePackageType", `<string>APPL</string>`],
  ["CFBundleShortVersionString", `<string>${escapeXml(version)}</string>`],
  ["CFBundleVersion", `<string>${escapeXml(version)}</string>`],
  ["LSUIElement", `<true/>`],
  ["LSMinimumSystemVersion", `<string>14.0</string>`],
  ["NSHighResolutionCapable", `<true/>`],
  ["MCIInstaller", `<string>${ownerValue}</string>`],
];

export const infoPlist = (version: string): string =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ` +
    `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    ...plistEntries(version).flatMap(([key, value]) => [
      `  <key>${key}</key>`,
      `  ${value}`,
    ]),
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");

const rubyString = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

const fileUrl = (path: string): string =>
  `file://${path.split("/").map(encodeURIComponent).join("/")}`;

export const formulaText = (
  version: string,
  archiveUrl: string,
  checksum: string,
): string =>
  `class Mci < Formula
  desc "Local macOS CI with one daemon for multiple repositories"
  url "${rubyString(archiveUrl)}"
  version "${rubyString(version)}"
  sha256 "${rubyString(checksum)}"

  depends_on "deno"

  def install
    bin.install "bin/mci"
    libexec.install "libexec/${bundleName}"
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
`;

const run = async (
  executable: string,
  args: readonly string[],
): Promise<Result<string>> => {
  const result = await attempt(() =>
    new Deno.Command(executable, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
  );
  if (!result.ok) return result;
  const stdout = new TextDecoder().decode(result.value.stdout).trim();
  const stderr = new TextDecoder().decode(result.value.stderr).trim();
  return result.value.code === 0
    ? ok(stdout)
    : err(stderr || `${executable} exited with ${result.value.code}`);
};

const lstatDirectory = async (path: string): Promise<Result<void>> => {
  const info = await attempt(() => Deno.lstat(path));
  if (!info.ok) return err(`${path} is not available: ${info.error}`);
  return info.value.isDirectory && !info.value.isSymlink
    ? ok(undefined)
    : err(`${path} must be a real directory.`);
};

const verifyApp = async (path: string): Promise<Result<void>> => {
  const directory = await lstatDirectory(path);
  if (!directory.ok) return directory;
  const owner = await run("/usr/bin/plutil", [
    "-extract",
    "MCIInstaller",
    "raw",
    "-o",
    "-",
    `${path}/Contents/Info.plist`,
  ]);
  if (!owner.ok || owner.value !== ownerValue) {
    return err(`${path} is not owned by the mci installer.`);
  }
  const signature = await run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    path,
  ]);
  return signature.ok ? ok(undefined) : err(`Invalid app signature: ${signature.error}`);
};

const checksum = async (path: string): Promise<Result<string>> => {
  const info = await attempt(() => Deno.lstat(path));
  if (!info.ok) return err(`${path} is not available: ${info.error}`);
  if (!info.value.isFile || info.value.isSymlink) {
    return err(`${path} must be a real regular file.`);
  }
  const bytes = await attempt(() => Deno.readFile(path));
  if (!bytes.ok) return bytes;
  const digest = await attempt(() => crypto.subtle.digest("SHA-256", bytes.value));
  if (!digest.ok) return digest;
  return ok(
    [...new Uint8Array(digest.value)].map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );
};

export const nativePackagePublicationCapabilities: PackagePublicationCapabilities = {
  checksum,
  writeFormula: (path, text) =>
    attempt(() => Deno.writeTextFile(path, text, { createNew: true })),
  publishArchive: async (preparedArchive, publishedArchive) => {
    try {
      await Deno.link(preparedArchive, publishedArchive);
      return ok("created");
    } catch (error) {
      return error instanceof Deno.errors.AlreadyExists
        ? ok("exists")
        : err(message(error));
    }
  },
  replaceFormula: (preparedFormula, formula) =>
    attempt(() => Deno.rename(preparedFormula, formula)),
  cleanup: async (path) => {
    try {
      await Deno.remove(path);
      return ok(undefined);
    } catch (error) {
      return error instanceof Deno.errors.NotFound ? ok(undefined) : err(message(error));
    }
  },
};

const cleanupPrivate = async (
  paths: readonly string[],
  capabilities: PackagePublicationCapabilities,
): Promise<readonly string[]> => {
  const outcomes = await Promise.all(paths.map(async (path) => ({
    path,
    result: await capabilities.cleanup(path),
  })));
  return outcomes.flatMap(({ path, result }) =>
    result.ok ? [] : [`Private file remains at ${path}: cleanup failed: ${result.error}`]
  );
};

const failAfterCleanup = async <T>(
  detail: string,
  privatePaths: readonly string[],
  capabilities: PackagePublicationCapabilities,
): Promise<Result<T>> => {
  const cleanupFailures = await cleanupPrivate(privatePaths, capabilities);
  return err([detail, ...cleanupFailures].join("\n"));
};

export const publishPackageWith = async (
  preparedArchive: string,
  metadata: PackageMetadata,
  capabilities: PackagePublicationCapabilities,
): Promise<Result<PackageResult>> => {
  const dist = `${metadata.root}/dist`;
  const formula = `${dist}/tap/Formula/mci.rb`;
  const hash = await capabilities.checksum(preparedArchive);
  if (!hash.ok) {
    return failAfterCleanup(
      `Cannot checksum the prepared release archive: ${hash.error}`,
      [preparedArchive],
      capabilities,
    );
  }
  const stem = `mci-${metadata.version}-darwin-${metadata.architecture}`;
  const archive = `${dist}/${stem}-${hash.value}.tar.gz`;
  if (preparedArchive === archive) {
    return err(`The prepared archive must use a private path: ${preparedArchive}`);
  }
  const preparedFormula = `${formula}.${crypto.randomUUID()}.tmp`;
  const text = formulaText(
    metadata.version,
    fileUrl(archive),
    hash.value,
  );
  const written = await capabilities.writeFormula(preparedFormula, text);
  if (!written.ok) {
    return failAfterCleanup(
      `Cannot prepare ${formula}: ${written.error}`,
      [preparedFormula, preparedArchive],
      capabilities,
    );
  }
  const published = await capabilities.publishArchive(preparedArchive, archive);
  if (!published.ok) {
    return failAfterCleanup(
      `Cannot publish the release archive: ${published.error}`,
      [preparedFormula, preparedArchive],
      capabilities,
    );
  }
  if (published.value === "exists") {
    const existingHash = await capabilities.checksum(archive);
    if (!existingHash.ok) {
      return failAfterCleanup(
        `Cannot use the existing release archive: ${existingHash.error}`,
        [preparedFormula, preparedArchive],
        capabilities,
      );
    }
    if (existingHash.value !== hash.value) {
      return failAfterCleanup(
        `The existing release archive has checksum ${existingHash.value}, expected ${hash.value}.`,
        [preparedFormula, preparedArchive],
        capabilities,
      );
    }
  }
  const sourceCleanup = await capabilities.cleanup(preparedArchive);
  if (!sourceCleanup.ok) {
    return failAfterCleanup(
      `Private file remains at ${preparedArchive}: cleanup failed: ${sourceCleanup.error}`,
      [preparedFormula],
      capabilities,
    );
  }
  const replaced = await capabilities.replaceFormula(preparedFormula, formula);
  if (!replaced.ok) {
    return failAfterCleanup(
      `Cannot replace ${formula}: ${replaced.error}`,
      [preparedFormula],
      capabilities,
    );
  }
  return ok({ archive, checksum: hash.value, formula });
};

/** Build current release artifacts and package them for local Homebrew installation. */
export const packageRelease = async (
  options: PackageOptions,
): Promise<Result<PackageResult>> => {
  if (Deno.build.os !== "darwin") return err("Release packaging supports macOS only.");
  if (options.appBundle !== undefined) {
    const app = await verifyApp(options.appBundle);
    if (!app.ok) return app;
  }
  const dist = `${options.root}/dist`;
  const formulaDirectory = `${dist}/tap/Formula`;
  const stem = `mci-${options.version}-darwin-${options.architecture}`;
  const staging = `${dist}/.${stem}-${crypto.randomUUID()}`;
  const prepared = await attempt(async () => {
    await Deno.mkdir(`${staging}/bin`, { recursive: true });
    await Deno.mkdir(`${staging}/libexec/hooks`, { recursive: true });
    await Deno.writeTextFile(`${staging}/libexec/hooks/pre-commit`, hookScript, {
      mode: 0o755,
    });
    await Deno.chmod(`${staging}/libexec/hooks/pre-commit`, 0o755);
    await Deno.mkdir(formulaDirectory, { recursive: true });
  });
  if (!prepared.ok) return err(`Cannot prepare release staging: ${prepared.error}`);
  const cleanup = async () => {
    await attempt(() => Deno.remove(staging, { recursive: true }));
  };

  const compiled = await run(Deno.execPath(), [
    "compile",
    "--quiet",
    "--permission-set=mci",
    "--config",
    `${options.root}/deno.json`,
    "--output",
    `${staging}/bin/mci`,
    `${options.root}/src/main.ts`,
  ]);
  if (!compiled.ok) {
    await cleanup();
    return err(`Cannot compile mci: ${compiled.error}`);
  }
  const stagedBundle = `${staging}/libexec/${bundleName}`;
  if (options.appBundle !== undefined) {
    const copied = await run("/usr/bin/ditto", [options.appBundle, stagedBundle]);
    if (!copied.ok) {
      await cleanup();
      return err(`Cannot copy the monitor app: ${copied.error}`);
    }
  } else {
    const built = await run("swift", [
      "build",
      "-c",
      "release",
      "--package-path",
      `${options.root}/monitor`,
    ]);
    if (!built.ok) {
      await cleanup();
      return err(`Cannot build the monitor app: ${built.error}`);
    }
    const assembled = await attempt(async () => {
      const executableDirectory = `${stagedBundle}/Contents/MacOS`;
      const executable = `${executableDirectory}/${executableName}`;
      await Deno.mkdir(executableDirectory, { recursive: true });
      await Deno.copyFile(
        `${options.root}/monitor/.build/release/${executableName}`,
        executable,
      );
      await Deno.chmod(executable, 0o755);
      await Deno.writeTextFile(
        `${stagedBundle}/Contents/Info.plist`,
        infoPlist(options.version),
      );
    });
    if (!assembled.ok) {
      await cleanup();
      return err(`Cannot assemble the monitor app: ${assembled.error}`);
    }
    const signed = await run("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      stagedBundle,
    ]);
    if (!signed.ok) {
      await cleanup();
      return err(`Cannot sign the monitor app: ${signed.error}`);
    }
  }
  const stagedApp = await verifyApp(stagedBundle);
  if (!stagedApp.ok) {
    await cleanup();
    return stagedApp;
  }
  const preparedArchive = await attempt(() =>
    Deno.makeTempFile({
      dir: dist,
      prefix: `.${stem}-`,
      suffix: ".tar.gz",
    })
  );
  if (!preparedArchive.ok) {
    await cleanup();
    return err(`Cannot prepare the release archive: ${preparedArchive.error}`);
  }
  const archived = await run("/usr/bin/tar", [
    "-czf",
    preparedArchive.value,
    "-C",
    staging,
    ".",
  ]);
  await cleanup();
  if (!archived.ok) {
    return failAfterCleanup(
      `Cannot create the release archive: ${archived.error}`,
      [preparedArchive.value],
      nativePackagePublicationCapabilities,
    );
  }
  return publishPackageWith(
    preparedArchive.value,
    options,
    nativePackagePublicationCapabilities,
  );
};

const root = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(
  /\/$/,
  "",
);

export const main = async (args: readonly string[]): Promise<number> => {
  if (args.length > 2 || (args.length === 2 && args[0] !== "--app")) {
    console.error("usage: deno task package [--app /path/to/mci Monitor.app]");
    return 2;
  }
  const appBundle = args.length === 2 ? args[1]! : undefined;
  if (appBundle !== undefined && !appBundle.startsWith("/")) {
    console.error("package failed: --app must identify an absolute app path");
    return 2;
  }
  const architecture = Deno.build.arch === "aarch64" ? "arm64" : "x86_64";
  const packaged = await packageRelease({
    root,
    appBundle,
    version: cliVersion,
    architecture,
  });
  if (!packaged.ok) {
    console.error(`package failed: ${packaged.error}`);
    return 1;
  }
  console.log(`Archive: ${packaged.value.archive}`);
  console.log(`SHA-256: ${packaged.value.checksum}`);
  console.log(`Formula: ${packaged.value.formula}`);
  return 0;
};

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (error) {
    console.error(`package failed: ${message(error)}`);
    Deno.exit(1);
  }
}
