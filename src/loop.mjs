import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { configFromEnv, loadEnv } from "./config.mjs";
import { ensureDir, readJson, readText, writeJson, writeText } from "./io.mjs";
import { runClaudeAgent } from "./claude.mjs";
import { webSearch } from "./serper.mjs";
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
    experiment_branch: `exp/${config.runId}`,
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

  const search = await webSearch("small high leverage improvements for simple AI chat app UX");
  writeJson(join(dir, "web_search.json"), search);

  const repoSnapshot = repoContext();
  const proposal = await runClaudeAgent({
    kind: "product",
    promptFile: join(prompts, "product-manager.md"),
    workspace: repoWorkspace,
    artifactDir: dir,
    context: { round: index, search, repo: repoSnapshot, previous_rounds: current.rounds.slice(-5) },
    maxTurns: 8,
  });
  writeJson(join(dir, "proposal.json"), proposal);

  const preGate = await runClaudeAgent({
    kind: "pre_gate",
    promptFile: join(prompts, "rubric-pre.md"),
    workspace: repoWorkspace,
    artifactDir: dir,
    context: { proposal, repo: repoSnapshot, startup_policy: "prefer low-value low-entropy increments" },
    maxTurns: 8,
  });
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
      dev = recoverDevChanges(error, proposal, dir, current.experiment_branch);
  }
  writeJson(join(dir, "dev.json"), dev);

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
  const postGate = await runClaudeAgent({
    kind: "post_gate",
    promptFile: join(prompts, "rubric-post.md"),
    workspace: repoWorkspace,
    artifactDir: dir,
    context: { proposal, pre_gate: preGate, pr_url: prUrl, pr_diff: prDiff.slice(0, 60000) },
    maxTurns: 10,
  });
  writeJson(join(dir, "post_gate.json"), postGate);
  if (postGate.decision !== "pass") {
    gh(["pr", "comment", prUrl, "--repo", config.repo, "--body-file", join(dir, "post_gate.json")], {
      cwd: repoWorkspace,
    });
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

  const tester = runDeterministicTester(proposal, postGate);
  writeJson(join(dir, "tester_report.json"), tester);
  if (tester.decision !== "pass") {
    gh(["pr", "comment", prUrl, "--repo", config.repo, "--body-file", join(dir, "tester_report.json")], {
      cwd: repoWorkspace,
    });
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

function runDeterministicTester(proposal, postGate) {
  const checks = [];
  const install = existsSync(join(repoWorkspace, "node_modules"))
    ? { command: "npm ci", status: "skipped", stdout: "node_modules already present", stderr: "" }
    : runNpm(["ci"]);
  checks.push(compactOutput(install));
  for (const args of [
    ["run", "build"],
    ["run", "lint"],
  ]) {
    checks.push(compactOutput(runNpm(args)));
  }
  const failed = checks.find((item) => item.status !== 0 && item.status !== "skipped");
  const acceptance = (proposal.acceptance_criteria || []).map((criterion) => ({
    criterion,
    status: postGate.decision === "pass" ? "pass" : "unclear",
    evidence: "Post-PR rubric evaluated PR diff against this criterion; deterministic tester verified build/lint.",
  }));
  return {
    decision: failed ? "fail" : "pass",
    checks,
    acceptance_results: acceptance,
    issues: failed ? ["Build or lint failed; see checks."] : [],
    reason: failed
      ? "Deterministic build/lint tester failed."
      : "Deterministic tester passed build/lint and reused post-gate acceptance evidence.",
  };
}

function recoverDevChanges(error, proposal, dir, experimentBranch) {
  const status = gitMaybe(["status", "--short"], { cwd: repoWorkspace });
  const head = gitMaybe(["rev-parse", "HEAD"], { cwd: repoWorkspace });
  const base = gitMaybe(["rev-parse", experimentBranch], { cwd: repoWorkspace });
  if (
    !status.stdout.trim() &&
    head.status === 0 &&
    base.status === 0 &&
    head.stdout.trim() !== base.stdout.trim()
  ) {
    return {
      summary: "Recovered a committed dev change after the Claude dev session hit a runner limit.",
      tests: ["See dev trace for commands run before commit."],
      files_changed: [],
      risk_notes: [`dev agent ended with: ${String(error.message || error).slice(0, 300)}`],
      recovered_by_orchestrator: true,
    };
  }
  if (!status.stdout.trim()) {
    throw error;
  }
  const checks = [];
  const install = existsSync(join(repoWorkspace, "node_modules"))
    ? { command: "npm ci", status: "skipped", stdout: "node_modules already present", stderr: "" }
    : runNpm(["ci"]);
  checks.push(compactOutput(install));
  for (const args of [
    ["run", "build"],
    ["run", "lint"],
  ]) {
    checks.push(compactOutput(runNpm(args)));
  }
  const failed = checks.find((item) => item.status !== 0 && item.status !== "skipped");
  if (failed) {
    writeJson(join(dir, "dev_recovery_failed.json"), { error: String(error), checks });
    throw error;
  }
  git(["add", "."], { cwd: repoWorkspace });
  git(["commit", "-m", `feat: ${String(proposal.title || "valuable agent iteration").slice(0, 72)}`], {
    cwd: repoWorkspace,
    timeout: 120000,
  });
  return {
    summary: "Recovered a valid dev diff after the Claude dev session hit a runner limit.",
    tests: checks.map((item) => `${item.command}: ${item.status}`),
    files_changed: status.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().slice(3))
      .filter(Boolean),
    risk_notes: [`dev agent ended with: ${String(error.message || error).slice(0, 300)}`],
    recovered_by_orchestrator: true,
  };
}

function runNpm(args) {
  if (process.platform === "win32") {
    return run("powershell.exe", ["-NoProfile", "-Command", `npm ${args.join(" ")}`], {
      cwd: repoWorkspace,
      timeout: 120000,
    });
  }
  return run("npm", args, { cwd: repoWorkspace, timeout: 120000 });
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
