import type { Result } from "../src/result.ts";

export function assert(value: unknown, detail = "assertion failed"): asserts value {
  if (!value) throw new Error(detail);
}
export const equal = (actual: unknown, expected: unknown) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
export const unwrap = <T>(value: Result<T>): T => {
  if (!value.ok) throw new Error(value.error);
  return value.value;
};
export const fixture = (steps: string) => `
name: Test
on: workflow_dispatch
defaults:
  run:
    shell: bash
jobs:
  check:
    runs-on: macos-latest
    steps:
${steps}
`;

export const inWorkspace = async (
  test: (path: string) => Promise<void>,
): Promise<void> => {
  const path = await Deno.makeTempDir({ prefix: "mci test space " });
  try {
    await test(await Deno.realPath(path));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
};

export const waitFor = async (test: () => Promise<boolean>, timeout = 4000) => {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached before test deadline");
};

export const exists = (path: string) => Deno.stat(path).then(() => true, () => false);
