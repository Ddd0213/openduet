import { runUserCli } from "../auth/cli.ts";

if (import.meta.main) process.exitCode = await runUserCli("create");
