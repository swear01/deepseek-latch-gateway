import { loadConfig } from "./config";
import { checkLatest } from "./latest";

const problems = await checkLatest(loadConfig(process.argv[2]));
for (const problem of problems) console.error(`FAIL ${problem}`);
process.exit(problems.length > 0 ? 1 : 0);
