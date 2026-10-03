// @light-fp adapter
import { attempt, err, ok, type Result } from "../src/result.ts";

/** The real path of an existing directory. */
export const canonicalDirectory = async (path: string): Promise<Result<string>> => {
  if (!path.startsWith("/")) return err(`The repository path must be absolute: ${path}`);
  const real = await attempt(() => Deno.realPath(path));
  if (!real.ok) return err(`The repository path is not a folder: ${path}`);
  const info = await attempt(() => Deno.stat(real.value));
  if (!info.ok || !info.value.isDirectory) {
    return err(`The repository path is not a folder: ${path}`);
  }
  return ok(real.value);
};
