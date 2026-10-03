import { readCiStatus } from "../src/ci.ts";
import { assert, inWorkspace } from "./helpers.ts";

type Fixture = {
  readonly text: string;
  readonly expected: { readonly ok: unknown } | { readonly error: string };
};

const directory = new URL("./fixtures/monitor/decode/", import.meta.url);

const categories: readonly (readonly [string, string])[] = [
  ["CI status must be a real file", "not-file"],
  ["invalid CI status JSON", "json"],
  ["invalid CI status shape", "shape"],
  ["invalid CI logger identity", "logger"],
  ["invalid CI status state", "state"],
  ["invalid CI status exit code", "exit-code"],
];

const category = (message: string): string =>
  categories.find(([prefix]) => message.startsWith(prefix))?.[1] ?? "read";

const canonical = (value: unknown): string =>
  JSON.stringify(
    value,
    (_key, item: unknown) =>
      typeof item === "object" && item !== null && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
        : item,
  );

const fixtures = async (): Promise<readonly (readonly [string, Fixture])[]> => {
  const found: (readonly [string, Fixture])[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, directory));
    found.push([entry.name, JSON.parse(text) as Fixture]);
  }
  return found.sort(([a], [b]) => (a < b ? -1 : 1));
};

Deno.test("monitor decode fixtures match readCiStatus", async () => {
  const all = await fixtures();
  assert(all.length > 0, "no decode fixtures found");
  for (const [name, fixture] of all) {
    await inWorkspace(async (workspace) => {
      await Deno.mkdir(`${workspace}/.mci/ci`, { recursive: true });
      await Deno.writeTextFile(`${workspace}/.mci/ci/status.json`, fixture.text);
      const result = await readCiStatus(workspace);
      const actual = result.ok ? { ok: result.value } : { error: category(result.error) };
      assert(
        canonical(actual) === canonical(fixture.expected),
        `${name}: expected ${canonical(fixture.expected)}, received ${canonical(actual)}`,
      );
    });
  }
});
