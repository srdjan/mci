export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: string): Result<T> => ({ ok: false, error });
export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Exceptions are caught only at third-party and OS boundaries.
export const attempt = async <T>(effect: () => T | Promise<T>): Promise<Result<T>> => {
  try {
    return ok(await effect());
  } catch (error) {
    return err(message(error));
  }
};
