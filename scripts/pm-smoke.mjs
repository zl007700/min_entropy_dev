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
    product_state: {
      product_memory: {
        recent_merged_features: [
          {
            round: 1,
            title: "Render assistant messages as Markdown",
            growth_category: "usability",
            value_delta: 2,
            entropy_delta: 17.17,
            running_reward: 0.12,
          },
          {
            round: 2,
            title: "Add copy button on assistant messages",
            growth_category: "usability",
            value_delta: 1,
            entropy_delta: 15.36,
            running_reward: 0.07,
          },
        ],
        low_value_streak: 1,
        category_counts: { usability: 2 },
        dominant_category: "usability",
        roadmap_pressure: [
          "Recent merged work has 1 low-value round(s); raise the bar for the next proposal.",
          "Recent work is concentrated in usability; prefer a different growth category unless evidence is strong.",
        ],
      },
      merged_capabilities: [],
      failed_lessons: [],
      infrastructure_issues: [],
    },
    smoke_note: "Verify the Product Manager can choose and run the web search tool itself.",
  },
});

writeJson(join(artifactDir, "pm_smoke.result.json"), result);
console.log(JSON.stringify(result, null, 2));
