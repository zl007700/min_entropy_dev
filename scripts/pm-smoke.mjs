import { join, resolve } from "node:path";
import { configFromEnv, loadEnv } from "../src/config.mjs";
import { ensureDir, readText, writeJson } from "../src/io.mjs";
import { runClaudeAgent } from "../src/claude.mjs";
import { run } from "../src/shell.mjs";

loadEnv();
const config = configFromEnv(["--run-id", "pm-smoke"]);
const root = resolve(".");
const artifactDir = join(root, "runs", "pm-smoke");
const workspace = resolve("../valuable_agent");
ensureDir(artifactDir);

const files = run("git", ["ls-files"], { cwd: workspace });
const recent = run("git", ["log", "--oneline", "-n", "5"], { cwd: workspace });
const pkg = readText(join(workspace, "package.json"));

const result = await runClaudeAgent({
  kind: "product",
  promptFile: join(root, "prompts", "product-manager.md"),
  workspace,
  artifactDir,
  context: {
    round: 1,
    repo: {
      files: files.stdout.split(/\r?\n/).filter(Boolean),
      recent_commits: recent.stdout,
      package_json: pkg,
    },
    previous_rounds: [],
    smoke_note: "Verify the Product Manager can choose and run the web search tool itself.",
  },
  maxTurns: 8,
});

writeJson(join(artifactDir, "pm_smoke.result.json"), result);
console.log(JSON.stringify(result, null, 2));
