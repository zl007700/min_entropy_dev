import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { configFromEnv, loadEnv } from "./config.mjs";
import { ensureDir, readJson, readText, writeJson, writeText } from "./io.mjs";
import { runClaudeAgent } from "./claude.mjs";
import { gh, git, gitMaybe } from "./github.mjs";
import { run } from "./shell.mjs";

const root = resolve(".");
const prompts = resolve("prompts");

loadEnv();
const config = configFromEnv();
const runDir = join(root, "runs", config.runId);
const workspaceRoot = join(root, "workspaces", config.runId);
const repoWorkspace = join(workspaceRoot, "valuable_agent");
const statePath = join(runDir, "state.json");

function state() {
  return readJson(statePath, {
    run_id: config.runId,
    repo: config.repo,
    base_branch: config.baseBranch,
    experiment_branch: `test_${config.runId}`,
    target_rounds: config.smoke ? 1 : config.rounds,
    rounds: [],
  });
}

function saveState(next) {
  writeJson(statePath, next);
}

function roundDir(index) {
  return join(runDir, "iterations", String(index).padStart(3, "0"));
}

function compactOutput(result) {
  return {
    command: `${result.command} ${result.args?.join(" ") || ""}`.trim(),
    status: result.status,
    stdout: String(result.stdout || "").slice(-4000),
    stderr: String(result.stderr || "").slice(-4000),
  };
}

function ensureRepo() {
  ensureDir(runDir);
  ensureDir(workspaceRoot);
  if (!existsSync(repoWorkspace)) {
    git(["clone", config.repoUrl, repoWorkspace], { cwd: workspaceRoot, timeout: 120000 });
  }
  git(["fetch", "origin"], { cwd: repoWorkspace, timeout: 120000 });
}

function ensureExperimentBranch(current) {
  ensureRepo();
  const remoteCheck = gitMaybe(["ls-remote", "--heads", "origin", current.experiment_branch], {
    cwd: repoWorkspace,
    timeout: 60000,
  });
  if (remoteCheck.status === 0 && remoteCheck.stdout.trim()) {
    git(["checkout", current.experiment_branch], { cwd: repoWorkspace });
    git(["pull", "--ff-only", "origin", current.experiment_branch], { cwd: repoWorkspace });
    return;
  }
  git(["checkout", config.baseBranch], { cwd: repoWorkspace });
  git(["pull", "--ff-only", "origin", config.baseBranch], { cwd: repoWorkspace });
  git(["checkout", "-b", current.experiment_branch], { cwd: repoWorkspace });
  git(["push", "-u", "origin", current.experiment_branch], { cwd: repoWorkspace, timeout: 120000 });
}

async function runRound(index, current) {
  const dir = roundDir(index);
  ensureDir(dir);
  const branch = `iter/${config.runId}-${String(index).padStart(3, "0")}`;
  const record = {
    index,
    branch,
    status: "started",
    started_at: new Date().toISOString(),
  };
  writeJson(join(dir, "record.json"), record);

  git(["checkout", current.experiment_branch], { cwd: repoWorkspace });
  git(["pull", "--ff-only", "origin", current.experiment_branch], { cwd: repoWorkspace });

  const repoSnapshot = repoContext();
  let proposal;
  try {
    proposal = await runClaudeAgent({
      kind: "product",
      promptFile: join(prompts, "product-manager.md"),
      workspace: repoWorkspace,
      artifactDir: dir,
      context: { round: index, repo: repoSnapshot, previous_rounds: current.rounds.slice(-5) },
      maxTurns: 12,
    });
  } catch (error) {
    return finishRound(current, dir, {
      ...record,
      status: "product_failed",
      error: agentError(error),
    });
  }
  writeJson(join(dir, "proposal.json"), proposal);

  let preGate;
  try {
    preGate = await runClaudeAgent({
      kind: "pre_gate",
      promptFile: join(prompts, "rubric-pre.md"),
      workspace: repoWorkspace,
      artifactDir: dir,
      context: { proposal, repo: repoSnapshot, startup_policy: "prefer low-value low-entropy increments" },
      maxTurns: 8,
    });
  } catch (error) {
    return finishRound(current, dir, {
      ...record,
      status: "pre_gate_failed_to_evaluate",
      proposal,
      error: agentError(error),
    });
  }
  writeJson(join(dir, "pre_gate.json"), preGate);
  if (preGate.decision !== "pass") {
    return finishRound(current, dir, { ...record, status: "pre_gate_rejected", proposal, pre_gate: preGate });
  }

  gitMaybe(["branch", "-D", branch], { cwd: repoWorkspace });
  git(["checkout", "-b", branch], { cwd: repoWorkspace });

  let dev;
  try {
    dev = await runClaudeAgent({
      kind: "dev",
      promptFile: join(prompts, "dev.md"),
      workspace: repoWorkspace,
      artifactDir: dir,
      context: { proposal, pre_gate: preGate, branch, base_branch: current.experiment_branch },
      maxTurns: 30,
    });
  } catch (error) {
    return finishRound(current, dir, {
      ...record,
      status: "dev_failed",
      proposal,
      pre_gate: preGate,
      error: agentError(error),
    });
  }
  writeJson(join(dir, "dev.json"), dev);

  const branchHead = gitMaybe(["rev-parse", "HEAD"], { cwd: repoWorkspace });
  const baseHead = gitMaybe(["rev-parse", current.experiment_branch], { cwd: repoWorkspace });
  if (
    branchHead.status !== 0 ||
    baseHead.status !== 0 ||
    branchHead.stdout.trim() === baseHead.stdout.trim()
  ) {
    return finishRound(current, dir, {
      ...record,
      status: "dev_no_commit",
      proposal,
      pre_gate: preGate,
      dev,
      error: "Dev Agent completed without producing a commit on the iteration branch.",
    });
  }

  const diff = gitMaybe(["diff", "--stat", "HEAD~1..HEAD"], { cwd: repoWorkspace });
  writeJson(join(dir, "dev_diff_stat.json"), compactOutput(diff));
  git(["push", "-u", "origin", branch], { cwd: repoWorkspace, timeout: 120000 });
  const prBody = [
    `Iteration ${index} for ${config.runId}.`,
    "",
    "Proposal:",
    JSON.stringify(proposal, null, 2),
    "",
    "Pre gate:",
    JSON.stringify(preGate, null, 2),
  ].join("\n");
  writeText(join(dir, "pr_body.md"), prBody);
  const prCreate = gh(
    [
      "pr",
      "create",
      "--repo",
      config.repo,
      "--base",
      current.experiment_branch,
      "--head",
      branch,
      "--title",
      `it-${String(index).padStart(3, "0")}: ${proposal.title || "valuable agent iteration"}`,
      "--body-file",
      join(dir, "pr_body.md"),
    ],
    { cwd: repoWorkspace, timeout: 120000 },
  );
  const prUrl = prCreate.stdout.trim();
  writeText(join(dir, "pr_url.txt"), `${prUrl}\n`);

  const prDiff = gh(["pr", "diff", prUrl, "--repo", config.repo], {
    cwd: repoWorkspace,
    timeout: 120000,
  }).stdout;
  writeText(join(dir, "pr.diff"), prDiff);
  let postGate;
  try {
    postGate = await runClaudeAgent({
      kind: "post_gate",
      promptFile: join(prompts, "rubric-post.md"),
      workspace: repoWorkspace,
      artifactDir: dir,
      context: { proposal, pre_gate: preGate, pr_url: prUrl, pr_diff: prDiff.slice(0, 60000) },
      maxTurns: 10,
    });
  } catch (error) {
    closeFailedPr(prUrl);
    return finishRound(current, dir, {
      ...record,
      status: "post_gate_failed_to_evaluate",
      proposal,
      pre_gate: preGate,
      dev,
      pr_url: prUrl,
      error: agentError(error),
    });
  }
  writeJson(join(dir, "post_gate.json"), postGate);
  if (postGate.decision !== "pass") {
    gh(["pr", "comment", prUrl, "--repo", config.repo, "--body-file", join(dir, "post_gate.json")], {
      cwd: repoWorkspace,
    });
    closeFailedPr(prUrl);
    return finishRound(current, dir, {
      ...record,
      status: "post_gate_failed",
      proposal,
      pre_gate: preGate,
      dev,
      pr_url: prUrl,
      post_gate: postGate,
    });
  }

  let tester;
  try {
    tester = await runClaudeAgent({
      kind: "tester",
      promptFile: join(prompts, "tester.md"),
      workspace: repoWorkspace,
      artifactDir: dir,
      context: { proposal, pre_gate: preGate, post_gate: postGate, pr_url: prUrl, pr_diff: prDiff.slice(0, 60000) },
      maxTurns: 16,
    });
  } catch (error) {
    closeFailedPr(prUrl);
    return finishRound(current, dir, {
      ...record,
      status: "tester_failed_to_evaluate",
      proposal,
      pre_gate: preGate,
      dev,
      pr_url: prUrl,
      post_gate: postGate,
      error: agentError(error),
    });
  }
  writeJson(join(dir, "tester_report.json"), tester);
  if (tester.decision !== "pass") {
    gh(["pr", "comment", prUrl, "--repo", config.repo, "--body-file", join(dir, "tester_report.json")], {
      cwd: repoWorkspace,
    });
    closeFailedPr(prUrl);
    return finishRound(current, dir, {
      ...record,
      status: "tester_failed",
      proposal,
      pre_gate: preGate,
      dev,
      pr_url: prUrl,
      post_gate: postGate,
      tester,
    });
  }

  gh(["pr", "merge", prUrl, "--repo", config.repo, "--squash", "--delete-branch"], {
    cwd: repoWorkspace,
    timeout: 120000,
  });
  git(["checkout", current.experiment_branch], { cwd: repoWorkspace });
  git(["pull", "--ff-only", "origin", current.experiment_branch], { cwd: repoWorkspace });
  return finishRound(current, dir, {
    ...record,
    status: "merged",
    proposal,
    pre_gate: preGate,
    dev,
    pr_url: prUrl,
    post_gate: postGate,
    tester,
    completed_at: new Date().toISOString(),
  });
}

function closeFailedPr(prUrl) {
  gh(["pr", "close", prUrl, "--repo", config.repo, "--delete-branch"], {
    cwd: repoWorkspace,
    timeout: 120000,
  });
}

function agentError(error) {
  return String(error?.message || error).slice(0, 2000);
}

function finishRound(current, dir, record) {
  writeJson(join(dir, "record.json"), record);
  const next = {
    ...current,
    rounds: [...current.rounds.filter((item) => item.index !== record.index), record],
    updated_at: new Date().toISOString(),
  };
  saveState(next);
  return next;
}

function repoContext() {
  const files = run("git", ["ls-files"], { cwd: repoWorkspace });
  const recent = run("git", ["log", "--oneline", "-n", "10"], { cwd: repoWorkspace });
  const pkg = existsSync(join(repoWorkspace, "package.json"))
    ? readText(join(repoWorkspace, "package.json"))
    : "";
  return {
    files: files.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200),
    recent_commits: recent.stdout,
    package_json: pkg,
  };
}

async function main() {
  let current = state();
  ensureExperimentBranch(current);
  saveState(current);
  for (let i = current.rounds.length + 1; i <= current.target_rounds; i += 1) {
    console.log(`Starting round ${i}/${current.target_rounds}`);
    current = await runRound(i, current);
    console.log(`Round ${i} status: ${current.rounds.at(-1).status}`);
  }
  writeReport(current);
}

function writeReport(current) {
  const report = [
    `# ${current.run_id} Report`,
    "",
    `Repo: ${current.repo}`,
    `Baseline: ${current.base_branch}`,
    `Experiment: ${current.experiment_branch}`,
    "",
    "| Round | Status | PR | Value | Entropy |",
    "| --- | --- | --- | --- | --- |",
    ...current.rounds.map((round) => {
      const value = round.post_gate?.verified_value_delta ?? round.pre_gate?.estimated_value_delta ?? "";
      const entropy = round.post_gate?.entropy_delta ?? round.pre_gate?.estimated_entropy_delta ?? "";
      return `| ${round.index} | ${round.status} | ${round.pr_url || ""} | ${value} | ${entropy} |`;
    }),
    "",
    "Human eval target:",
    "",
    `Compare ${current.base_branch} against ${current.experiment_branch}.`,
  ].join("\n");
  writeText(join(runDir, "report.md"), `${report}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
