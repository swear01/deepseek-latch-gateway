import { loadConfig } from "./config";
import { checkLatest } from "./latest";

try {
  const report = await checkLatest(loadConfig(process.argv[2]));
  for (const line of report.ok) console.log(`ok   ${line}`);
  for (const problem of report.problems) console.error(`FAIL ${problem}`);
  process.exitCode = report.problems.length > 0 ? 1 : 0;
} catch (err) {
  console.error(`FAIL ${(err as Error).message}`);
  process.exitCode = 1;
}
