import { main } from "./cli.ts";
import { message } from "./result.ts";

if (import.meta.main) {
  const code = await main(Deno.args).catch((error) => {
    console.error(`mci: ${message(error)}`);
    return 1;
  });
  Deno.exit(code);
}
