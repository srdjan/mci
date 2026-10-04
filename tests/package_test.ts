import {
  formulaText,
  nativePackagePublicationCapabilities,
  type PackageMetadata,
  publishPackageWith,
} from "../scripts/package.ts";
import { err, type Result } from "../src/result.ts";
import { assert, equal, exists, inWorkspace } from "./helpers.ts";

type PackageScene = {
  readonly root: string;
  readonly dist: string;
  readonly formula: string;
  readonly previousArchive: string;
  readonly previousArchiveBytes: Uint8Array;
  readonly previousFormula: string;
  readonly preparedArchive: string;
};

const packageMetadata = (root: string): PackageMetadata => ({
  root,
  version: "1.2.3",
  architecture: "arm64",
});

const fileUrl = (path: string): string =>
  `file://${path.split("/").map(encodeURIComponent).join("/")}`;

const withPackageScene = (
  test: (scene: PackageScene) => Promise<void>,
): Promise<void> =>
  inWorkspace(async (root) => {
    const dist = `${root}/dist`;
    const formulaDirectory = `${dist}/tap/Formula`;
    const formula = `${formulaDirectory}/mci.rb`;
    const previousArchive = `${dist}/mci-1.2.2-darwin-arm64-legacy.tar.gz`;
    const previousArchiveBytes = new TextEncoder().encode("previous archive");
    const preparedArchive = `${dist}/.candidate.tar.gz`;
    await Deno.mkdir(formulaDirectory, { recursive: true });
    await Deno.writeFile(previousArchive, previousArchiveBytes);
    const previousHash = await nativePackagePublicationCapabilities.checksum(
      previousArchive,
    );
    assert(previousHash.ok);
    const previousFormula = formulaText(
      "1.2.2",
      fileUrl(previousArchive),
      previousHash.value,
    );
    await Deno.writeTextFile(formula, previousFormula);
    await Deno.writeTextFile(preparedArchive, "new archive");
    await test({
      root,
      dist,
      formula,
      previousArchive,
      previousArchiveBytes,
      previousFormula,
      preparedArchive,
    });
  });

const assertPreviousPair = async (scene: PackageScene): Promise<void> => {
  equal(await Deno.readFile(scene.previousArchive), scene.previousArchiveBytes);
  equal(await Deno.readTextFile(scene.formula), scene.previousFormula);
};

const expectedArchive = async (scene: PackageScene): Promise<{
  readonly archive: string;
  readonly checksum: string;
}> => {
  const hash = await nativePackagePublicationCapabilities.checksum(scene.preparedArchive);
  assert(hash.ok);
  return {
    archive: `${scene.dist}/mci-1.2.3-darwin-arm64-${hash.value}.tar.gz`,
    checksum: hash.value,
  };
};

const formulaReference = (text: string): {
  readonly archive: string;
  readonly checksum: string;
} => {
  const url = /^[ ]{2}url "([^"]+)"$/m.exec(text)?.[1];
  const checksum = /^[ ]{2}sha256 "([^"]+)"$/m.exec(text)?.[1];
  assert(url !== undefined, "formula URL is absent");
  assert(checksum !== undefined, "formula checksum is absent");
  return {
    archive: decodeURIComponent(new URL(url).pathname),
    checksum,
  };
};

const assertFormulaMatchesArchive = async (formula: string): Promise<void> => {
  const reference = formulaReference(await Deno.readTextFile(formula));
  const actual = await nativePackagePublicationCapabilities.checksum(reference.archive);
  assert(actual.ok);
  equal(actual.value, reference.checksum);
};

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

Deno.test("a checksum failure preserves the previous matching pair", () =>
  withPackageScene(async (scene) => {
    const result = await publishPackageWith(
      scene.preparedArchive,
      packageMetadata(scene.root),
      {
        ...nativePackagePublicationCapabilities,
        checksum: (path): Promise<Result<string>> =>
          path === scene.preparedArchive
            ? Promise.resolve(err("checksum refused"))
            : nativePackagePublicationCapabilities.checksum(path),
      },
    );

    assert(!result.ok);
    assert(result.error.includes("checksum refused"));
    await assertPreviousPair(scene);
    assert(!await exists(scene.preparedArchive));
  }));

Deno.test("a prepared symlink is rejected without publishing it", () =>
  withPackageScene(async (scene) => {
    const target = `${scene.dist}/candidate-target.tar.gz`;
    await Deno.writeTextFile(target, "symlink archive");
    await Deno.remove(scene.preparedArchive);
    await Deno.symlink(target, scene.preparedArchive);

    const result = await publishPackageWith(
      scene.preparedArchive,
      packageMetadata(scene.root),
      nativePackagePublicationCapabilities,
    );

    assert(!result.ok);
    assert(result.error.includes("must be a real regular file"));
    await assertPreviousPair(scene);
    assert(!await exists(scene.preparedArchive));
    equal(await Deno.readTextFile(target), "symlink archive");
  }));

Deno.test("a partial formula preparation preserves the previous matching pair", () =>
  withPackageScene(async (scene) => {
    let preparedFormula = "";
    const result = await publishPackageWith(
      scene.preparedArchive,
      packageMetadata(scene.root),
      {
        ...nativePackagePublicationCapabilities,
        writeFormula: async (path) => {
          preparedFormula = path;
          await Deno.writeTextFile(path, "partial formula");
          return err("formula write refused");
        },
      },
    );

    assert(!result.ok);
    assert(result.error.includes("formula write refused"));
    await assertPreviousPair(scene);
    assert(!await exists(preparedFormula));
    assert(!await exists(scene.preparedArchive));
  }));

Deno.test("an archive publication failure preserves the previous matching pair", () =>
  withPackageScene(async (scene) => {
    const result = await publishPackageWith(
      scene.preparedArchive,
      packageMetadata(scene.root),
      {
        ...nativePackagePublicationCapabilities,
        publishArchive: () => Promise.resolve(err("archive link refused")),
      },
    );

    assert(!result.ok);
    assert(result.error.includes("archive link refused"));
    await assertPreviousPair(scene);
    assert(!await exists(scene.preparedArchive));
  }));

Deno.test("a formula switch failure retains the new complete archive", () =>
  withPackageScene(async (scene) => {
    const expected = await expectedArchive(scene);
    const candidateBytes = await Deno.readFile(scene.preparedArchive);
    const result = await publishPackageWith(
      scene.preparedArchive,
      packageMetadata(scene.root),
      {
        ...nativePackagePublicationCapabilities,
        replaceFormula: () => Promise.resolve(err("formula switch refused")),
      },
    );

    assert(!result.ok);
    assert(result.error.includes("formula switch refused"));
    await assertPreviousPair(scene);
    equal(await Deno.readFile(expected.archive), candidateBytes);
    assert(!await exists(scene.preparedArchive));
  }));

Deno.test("successful publication creates a matching checksum archive and formula", () =>
  withPackageScene(async (scene) => {
    const candidateBytes = await Deno.readFile(scene.preparedArchive);
    const result = await publishPackageWith(
      scene.preparedArchive,
      packageMetadata(scene.root),
      nativePackagePublicationCapabilities,
    );

    assert(result.ok);
    const reference = formulaReference(await Deno.readTextFile(result.value.formula));
    equal(reference.archive, result.value.archive);
    equal(reference.checksum, result.value.checksum);
    equal(await Deno.readFile(reference.archive), candidateBytes);
    await assertFormulaMatchesArchive(result.value.formula);
    equal(await Deno.readFile(scene.previousArchive), scene.previousArchiveBytes);
    assert(!await exists(scene.preparedArchive));
  }));

Deno.test("formula URLs preserve special path characters", () =>
  inWorkspace(async (workspace) => {
    const root = `${workspace}/release #?% space`;
    const dist = `${root}/dist`;
    const formulaDirectory = `${dist}/tap/Formula`;
    const preparedArchive = `${dist}/.candidate.tar.gz`;
    await Deno.mkdir(formulaDirectory, { recursive: true });
    await Deno.writeTextFile(preparedArchive, "special path archive");

    const result = await publishPackageWith(
      preparedArchive,
      packageMetadata(root),
      nativePackagePublicationCapabilities,
    );

    assert(result.ok);
    const reference = formulaReference(await Deno.readTextFile(result.value.formula));
    equal(reference.archive, result.value.archive);
    equal(reference.checksum, result.value.checksum);
    await assertFormulaMatchesArchive(result.value.formula);
  }));

Deno.test("duplicate content reuses an existing archive without replacing it", () =>
  withPackageScene(async (scene) => {
    const expected = await expectedArchive(scene);
    const candidateBytes = await Deno.readFile(scene.preparedArchive);
    await Deno.writeFile(expected.archive, candidateBytes);
    const before = await Deno.lstat(expected.archive);
    const result = await publishPackageWith(
      scene.preparedArchive,
      packageMetadata(scene.root),
      nativePackagePublicationCapabilities,
    );
    const after = await Deno.lstat(expected.archive);

    assert(result.ok);
    equal(after.ino, before.ino);
    equal(await Deno.readFile(expected.archive), candidateBytes);
    await assertFormulaMatchesArchive(scene.formula);
  }));

type ArchiveConflict = "symlink" | "directory" | "wrong bytes";
const archiveConflicts: readonly ArchiveConflict[] = [
  "symlink",
  "directory",
  "wrong bytes",
];

for (const conflict of archiveConflicts) {
  Deno.test(`a conflicting ${conflict} archive remains unchanged`, () =>
    withPackageScene(async (scene) => {
      const expected = await expectedArchive(scene);
      const target = `${scene.dist}/symlink-target.tar.gz`;
      if (conflict === "symlink") {
        await Deno.writeTextFile(target, "symlink target");
        await Deno.symlink(target, expected.archive);
      } else if (conflict === "directory") {
        await Deno.mkdir(expected.archive);
      } else {
        await Deno.writeTextFile(expected.archive, "wrong bytes");
      }

      const result = await publishPackageWith(
        scene.preparedArchive,
        packageMetadata(scene.root),
        nativePackagePublicationCapabilities,
      );

      assert(!result.ok);
      await assertPreviousPair(scene);
      const info = await Deno.lstat(expected.archive);
      if (conflict === "symlink") {
        assert(info.isSymlink);
        equal(await Deno.readLink(expected.archive), target);
        equal(await Deno.readTextFile(target), "symlink target");
      } else if (conflict === "directory") {
        assert(info.isDirectory && !info.isSymlink);
      } else {
        assert(info.isFile && !info.isSymlink);
        equal(await Deno.readTextFile(expected.archive), "wrong bytes");
      }
    }));
}

Deno.test("concurrent formula switches always expose a complete matching archive", () =>
  withPackageScene(async (scene) => {
    const firstCandidate = scene.preparedArchive;
    const secondCandidate = `${scene.dist}/.second-candidate.tar.gz`;
    await Deno.writeTextFile(secondCandidate, "second archive");
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    let switchCount = 0;
    const capabilities = {
      ...nativePackagePublicationCapabilities,
      replaceFormula: async (from: string, to: string) => {
        switchCount += 1;
        if (switchCount === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        } else {
          secondEntered.resolve();
          await releaseSecond.promise;
        }
        return nativePackagePublicationCapabilities.replaceFormula(from, to);
      },
    };

    const first = publishPackageWith(
      firstCandidate,
      packageMetadata(scene.root),
      capabilities,
    );
    await firstEntered.promise;
    const second = publishPackageWith(
      secondCandidate,
      packageMetadata(scene.root),
      capabilities,
    );
    await secondEntered.promise;
    releaseFirst.resolve();
    const firstResult = await first;
    assert(firstResult.ok);
    await assertFormulaMatchesArchive(scene.formula);
    releaseSecond.resolve();
    const secondResult = await second;
    assert(secondResult.ok);
    await assertFormulaMatchesArchive(scene.formula);
  }));

Deno.test("formula cleanup failure keeps the switch detail and every archive", () =>
  withPackageScene(async (scene) => {
    const expected = await expectedArchive(scene);
    const cleanupPaths: string[] = [];
    let preparedFormula = "";
    const result = await publishPackageWith(
      scene.preparedArchive,
      packageMetadata(scene.root),
      {
        ...nativePackagePublicationCapabilities,
        writeFormula: (path, text) => {
          preparedFormula = path;
          return nativePackagePublicationCapabilities.writeFormula(path, text);
        },
        replaceFormula: () => Promise.resolve(err("formula switch refused")),
        cleanup: (path) => {
          cleanupPaths.push(path);
          return path === preparedFormula
            ? Promise.resolve(err("cleanup refused"))
            : nativePackagePublicationCapabilities.cleanup(path);
        },
      },
    );

    assert(!result.ok);
    assert(result.error.startsWith(`Cannot replace ${scene.formula}`));
    assert(result.error.includes("formula switch refused"));
    assert(result.error.includes(preparedFormula));
    assert(result.error.includes("cleanup refused"));
    assert(!cleanupPaths.includes(expected.archive));
    assert(!await exists(scene.preparedArchive));
    assert(await exists(preparedFormula));
    assert(await exists(expected.archive));
    await assertPreviousPair(scene);
  }));

Deno.test("source cleanup failure preserves the previous formula", () =>
  withPackageScene(async (scene) => {
    const expected = await expectedArchive(scene);
    let preparedFormula = "";
    const result = await publishPackageWith(
      scene.preparedArchive,
      packageMetadata(scene.root),
      {
        ...nativePackagePublicationCapabilities,
        writeFormula: (path, text) => {
          preparedFormula = path;
          return nativePackagePublicationCapabilities.writeFormula(path, text);
        },
        cleanup: (path) =>
          path === scene.preparedArchive
            ? Promise.resolve(err("source cleanup refused"))
            : nativePackagePublicationCapabilities.cleanup(path),
      },
    );

    assert(!result.ok);
    assert(result.error.includes(scene.preparedArchive));
    assert(result.error.includes("source cleanup refused"));
    assert(await exists(scene.preparedArchive));
    assert(await exists(expected.archive));
    assert(!await exists(preparedFormula));
    await assertPreviousPair(scene);
  }));
