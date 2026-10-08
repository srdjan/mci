// @light-fp adapter
import { attempt, err, ok, type Result } from "./result.ts";

const knownBrews = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] as const;

export const findBrewWith = async (
  inspect: (path: string) => Promise<Result<{ readonly isFile: boolean }>>,
): Promise<Result<string>> => {
  for (const path of knownBrews) {
    const info = await inspect(path);
    if (info.ok && info.value.isFile) return ok(path);
  }
  return err("Homebrew was not found at /opt/homebrew or /usr/local.");
};

export const findBrew = (): Promise<Result<string>> =>
  findBrewWith((path) => attempt(() => Deno.stat(path)));
