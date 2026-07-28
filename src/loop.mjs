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

function heartbeat(dir, phase, extra = {}) {
  writeJson(join(dir, "heartbeat.json"), {
    phase,
    at: new Date().toISOString(),
    ...extra,
  });
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

  heartbeat(dir, "round_started", { index, branch });
  git(["checkout", current.experiment_branch], { cwd: repoWorkspace });
  git(["pull", "--ff-only", "origin", current.experiment_branch], { cwd: repoWorkspace });

  const repoSnapshot = repoContext();
  const productState = productStateFor(current);
  writeJson(join(dir, "product_state.json"), productState);
  let proposal;
  try {
    heartbeat(dir, "product_started");
    proposal = await runClaudeAgent({
      kind: "product",
      promptFile: join(prompts, "product-manager.md"),
      workspace: repoWorkspace,
      artifactDir: dir,
      context: { round: index, repo: repoSnapshot, product_state: productState },
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
    heartbeat(dir, "pre_gate_started");
    preGate = await runClaudeAgent({
      kind: "pre_gate",
      promptFile: join(prompts, "rubric-pre.md"),
      workspace: repoWorkspace,
      artifactDir: dir,
      context: { proposal, repo: repoSnapshot, startup_policy: "prefer low-value low-entropy increments" },
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
    heartbeat(dir, "dev_started", { attempt: 0 });
    dev = await runClaudeAgent({
      kind: "dev",
      promptFile: join(prompts, "dev.md"),
      workspace: repoWorkspace,
      artifactDir: dir,
      context: { proposal, pre_gate: preGate, branch, base_branch: current.experiment_branch },
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
  heartbeat(dir, "pr_create_started", { branch });
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

  let gateResult = await evaluateAndRevise({ current, dir, record, proposal, preGate, dev, prUrl, branch });
  if (gateResult.status !== "pass") {
    if (!gateResult.keepOpen) closeFailedPr(prUrl);
    return finishRound(current, dir, gateResult.record);
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
    post_gate: gateResult.postGate,
    tester: gateResult.tester,
    revisions: gateResult.revisions,
    completed_at: new Date().toISOString(),
  });
}

function closeFailedPr(prUrl) {
  gh(["pr", "close", prUrl, "--repo", config.repo, "--delete-branch"], {
    cwd: repoWorkspace,
    timeout: 120000,
  });
}

async function evaluateAndRevise({ current, dir, record, proposal, preGate, dev, prUrl, branch }) {
  const revisions = [];
  let latestDev = dev;
  for (let attempt = 0; attempt <= config.reviseAttempts; attempt += 1) {
    const prDiff = gh(["pr", "diff", prUrl, "--repo", config.repo], {
      cwd: repoWorkspace,
      timeout: 120000,
    }).stdout;
    writeText(join(dir, attempt === 0 ? "pr.diff" : `pr.revision-${attempt}.diff`), prDiff);
    const deterministicChecks = runDeterministicChecks(dir, attempt);
    const objectiveEntropy = collectObjectiveEntropy(current.experiment_branch, branch);
    writeJson(
      join(dir, attempt === 0 ? "objective_entropy.json" : `objective_entropy.revision-${attempt}.json`),
      objectiveEntropy,
    );

    let postGate;
    try {
      heartbeat(dir, "post_gate_started", { attempt });
      postGate = await runClaudeAgent({
        kind: "post_gate",
        promptFile: join(prompts, "rubric-post.md"),
        workspace: repoWorkspace,
        artifactDir: dir,
        context: {
          proposal,
          pre_gate: preGate,
          pr_url: prUrl,
          pr_diff: prDiff.slice(0, 60000),
          deterministic_checks: deterministicChecks,
          objective_entropy: objectiveEntropy,
          revision_attempt: attempt,
          previous_revisions: revisions,
        },
      });
    } catch (error) {
      return {
        status: "post_gate_failed_to_evaluate",
        keepOpen: true,
        record: {
          ...record,
          status: "post_gate_failed_to_evaluate",
          proposal,
          pre_gate: preGate,
          dev: latestDev,
          pr_url: prUrl,
          revisions,
          error: agentError(error),
        },
      };
    }
    postGate = normalizeReward(postGate, objectiveEntropy);
    writeJson(join(dir, attempt === 0 ? "post_gate.json" : `post_gate.revision-${attempt}.json`), postGate);
    if (postGate.decision !== "pass") {
      if (attempt < config.reviseAttempts && postGate.decision === "revise") {
        gh(["pr", "comment", prUrl, "--repo", config.repo, "--body-file", join(dir, attempt === 0 ? "post_gate.json" : `post_gate.revision-${attempt}.json`)], {
          cwd: repoWorkspace,
        });
        const revision = await runRevision({
          dir,
          attempt: attempt + 1,
          proposal,
          preGate,
          prUrl,
          branch,
          feedbackKind: "post_gate",
          feedback: postGate,
        });
        latestDev = revision.dev;
        revisions.push(revision);
        continue;
      }
      return {
        status: "post_gate_failed",
        record: {
          ...record,
          status: "post_gate_failed",
          proposal,
          pre_gate: preGate,
          dev: latestDev,
          pr_url: prUrl,
          post_gate: postGate,
          revisions,
        },
      };
    }

    let tester;
    try {
      heartbeat(dir, "tester_started", { attempt });
      tester = await runClaudeAgent({
        kind: "tester",
        promptFile: join(prompts, "tester.md"),
        workspace: repoWorkspace,
        artifactDir: dir,
        context: {
          proposal,
          pre_gate: preGate,
          post_gate: postGate,
          pr_url: prUrl,
          pr_diff: prDiff.slice(0, 60000),
          deterministic_checks: deterministicChecks,
        },
      });
    } catch (error) {
      return {
        status: "tester_failed_to_evaluate",
        keepOpen: true,
        record: {
          ...record,
          status: "tester_failed_to_evaluate",
          proposal,
          pre_gate: preGate,
          dev: latestDev,
          pr_url: prUrl,
          post_gate: postGate,
          revisions,
          error: agentError(error),
        },
      };
    }
    writeJson(join(dir, attempt === 0 ? "tester_report.json" : `tester_report.revision-${attempt}.json`), tester);
    const testerGate = normalizeTesterGate(tester);
    writeJson(join(dir, attempt === 0 ? "tester_gate.json" : `tester_gate.revision-${attempt}.json`), testerGate);
    if (testerGate.decision === "pass") {
      return { status: "pass", postGate, tester, revisions };
    }
    const testerFeedback = { ...tester, decision: "fail", gate_consistency: testerGate };
    if (attempt < config.reviseAttempts) {
      gh(["pr", "comment", prUrl, "--repo", config.repo, "--body-file", join(dir, attempt === 0 ? "tester_report.json" : `tester_report.revision-${attempt}.json`)], {
        cwd: repoWorkspace,
      });
      const revision = await runRevision({
        dir,
        attempt: attempt + 1,
        proposal,
        preGate,
        prUrl,
        branch,
        feedbackKind: "tester",
        feedback: testerFeedback,
      });
      latestDev = revision.dev;
      revisions.push(revision);
      continue;
    }
    return {
      status: "tester_failed",
      record: {
        ...record,
        status: "tester_failed",
        proposal,
        pre_gate: preGate,
        dev: latestDev,
        pr_url: prUrl,
        post_gate: postGate,
        tester: testerFeedback,
        revisions,
      },
    };
  }
}

function normalizeTesterGate(tester) {
  const acceptanceResults = Array.isArray(tester?.acceptance_results) ? tester.acceptance_results : [];
  const checks = Array.isArray(tester?.checks) ? tester.checks : [];
  const issues = Array.isArray(tester?.issues) ? tester.issues.filter((issue) => String(issue || "").trim()) : [];
  const failedAcceptance = acceptanceResults.filter((item) => item?.status === "fail");
  const unclearAcceptance = acceptanceResults.filter((item) => item?.status === "unclear");
  const failedChecks = checks.filter((item) => item?.status === "fail");
  const pass =
    tester?.decision === "pass" &&
    failedAcceptance.length === 0 &&
    unclearAcceptance.length === 0 &&
    failedChecks.length === 0 &&
    issues.length === 0;
  return {
    decision: pass ? "pass" : "fail",
    original_decision: tester?.decision || "",
    failed_acceptance_count: failedAcceptance.length,
    unclear_acceptance_count: unclearAcceptance.length,
    failed_check_count: failedChecks.length,
    issue_count: issues.length,
    reason: pass
      ? "Tester result is internally consistent."
      : "Tester result is not passable: top-level decision, acceptance results, checks, and issues must agree.",
  };
}

function runDeterministicChecks(dir, attempt) {
  heartbeat(dir, "deterministic_checks_started", { attempt });
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
  for (const script of smokeScripts()) {
    checks.push(normalizeSmokeCheck(runNpm(["run", script]), script));
  }
  const report = {
    decision: checks.some((check) => check.status !== 0 && check.status !== "skipped") ? "fail" : "pass",
    checks,
  };
  writeJson(join(dir, attempt === 0 ? "deterministic_checks.json" : `deterministic_checks.revision-${attempt}.json`), report);
  return report;
}

function smokeScripts() {
  const pkgPath = join(repoWorkspace, "package.json");
  if (!existsSync(pkgPath)) return [];
  const pkg = readJson(pkgPath, {});
  return Object.keys(pkg.scripts || {})
    .filter((script) => script === "smoke" || script.startsWith("smoke:"))
    .sort();
}

function normalizeSmokeCheck(result, script) {
  const check = compactOutput(result);
  const output = `${check.stdout}\n${check.stderr}`;
  if ([1, 2].includes(check.status) && /missing|not configured|skip/i.test(output)) {
    return {
      ...check,
      status: "skipped",
      stdout: `${check.stdout}\nExplicitly skipped ${script}: missing local credentials or environment.`,
    };
  }
  return check;
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

function collectObjectiveEntropy(baseRef, headRef) {
  const numstat = gitMaybe(["diff", "--numstat", `${baseRef}..${headRef}`], { cwd: repoWorkspace });
  const rows = String(numstat.stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [addedRaw, deletedRaw, ...fileParts] = line.split(/\t/);
      const added = Number(addedRaw);
      const deleted = Number(deletedRaw);
      return {
        file: fileParts.join("\t"),
        added: Number.isFinite(added) ? added : 0,
        deleted: Number.isFinite(deleted) ? deleted : 0,
      };
    });
  const changedChurn = rows.reduce((sum, row) => sum + row.added + row.deleted, 0);
  const touchedFiles = rows.length;
  const maxFileChurn = rows.reduce((max, row) => Math.max(max, row.added + row.deleted), 0);
  const maxFileChurnRatio = changedChurn === 0 ? 0 : maxFileChurn / changedChurn;
  const hotspotPenalty = maxFileChurnRatio >= 0.65 ? 2 : maxFileChurnRatio >= 0.45 ? 1 : 0;
  const testFilesTouched = rows.filter((row) => isTestFile(row.file)).length;
  const prodChurn = rows
    .filter((row) => !isTestFile(row.file))
    .reduce((sum, row) => sum + row.added + row.deleted, 0);
  const testDebtPenalty = prodChurn > 0 && testFilesTouched === 0 ? 2 : 0;
  const stateSurface = collectStateSurfaceDelta(baseRef, headRef, rows.map((row) => row.file));
  const stateSurfaceDelta =
    Math.max(0, stateSurface.use_state_delta) * 0.75 +
    Math.max(0, stateSurface.use_effect_delta) * 0.75 +
    Math.max(0, stateSurface.handler_delta) * 0.25;
  const objectiveEntropyDelta =
    Math.log1p(changedChurn) + touchedFiles + hotspotPenalty + testDebtPenalty + stateSurfaceDelta;
  return {
    objective_entropy_delta: round2(objectiveEntropyDelta),
    changed_churn: changedChurn,
    touched_files: touchedFiles,
    max_file_churn_ratio: round2(maxFileChurnRatio),
    hotspot_penalty: hotspotPenalty,
    test_files_touched: testFilesTouched,
    test_debt_penalty: testDebtPenalty,
    state_surface_delta: round2(stateSurfaceDelta),
    state_surface: stateSurface,
    formula:
      "log(1+changed_churn)+touched_files+hotspot_penalty+test_debt_penalty+state_surface_delta",
  };
}

function collectStateSurfaceDelta(baseRef, headRef, files) {
  const totals = { use_state_delta: 0, use_effect_delta: 0, handler_delta: 0 };
  for (const file of files.filter((item) => /\.(jsx?|tsx?)$/.test(item))) {
    const base = gitMaybe(["show", `${baseRef}:${file}`], { cwd: repoWorkspace });
    const head = gitMaybe(["show", `${headRef}:${file}`], { cwd: repoWorkspace });
    const before = countStateSurface(base.status === 0 ? base.stdout : "");
    const after = countStateSurface(head.status === 0 ? head.stdout : "");
    totals.use_state_delta += after.use_state - before.use_state;
    totals.use_effect_delta += after.use_effect - before.use_effect;
    totals.handler_delta += after.handlers - before.handlers;
  }
  return totals;
}

function countStateSurface(text) {
  return {
    use_state: countMatches(text, /\buseState\s*\(/g),
    use_effect: countMatches(text, /\buse(?:Layout)?Effect\s*\(/g),
    handlers: countMatches(text, /\b(?:const\s+handle[A-Z]\w*|function\s+handle[A-Z]\w*|on[A-Z]\w*\s*=)/g),
  };
}

function countMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

function isTestFile(file) {
  return /(^|[/\\])(__tests__|test|tests)([/\\]|$)|\.(test|spec)\.[jt]sx?$/.test(file);
}

function normalizeReward(postGate, objectiveEntropy) {
  const verifiedValue = numberOr(postGate?.verified_value_delta, 0);
  const objective = numberOr(objectiveEntropy?.objective_entropy_delta, 0);
  const agentMultiplier = clamp(numberOr(postGate?.agent_entropy_multiplier, 1), 0.7, 2);
  const uncertaintyMultiplier = clamp(numberOr(postGate?.uncertainty_multiplier, 1), 1, 1.5);
  const fusedEntropy = objective * agentMultiplier * uncertaintyMultiplier;
  return {
    ...postGate,
    verified_value_delta: verifiedValue,
    objective_entropy_delta: round2(objective),
    agent_entropy_multiplier: round2(agentMultiplier),
    uncertainty_multiplier: round2(uncertaintyMultiplier),
    fused_entropy_delta: round2(fusedEntropy),
    running_reward: fusedEntropy === 0 ? null : round2(verifiedValue / fusedEntropy),
    legacy_entropy_delta: postGate?.entropy_delta,
    entropy_delta: round2(fusedEntropy),
  };
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

async function runRevision({ dir, attempt, proposal, preGate, prUrl, branch, feedbackKind, feedback }) {
  heartbeat(dir, "dev_revision_started", { attempt, feedback_kind: feedbackKind });
  git(["checkout", branch], { cwd: repoWorkspace });
  git(["pull", "--ff-only", "origin", branch], { cwd: repoWorkspace });
  const dev = await runClaudeAgent({
    kind: "dev",
    promptFile: join(prompts, "dev.md"),
    workspace: repoWorkspace,
    artifactDir: dir,
    context: {
      proposal,
      pre_gate: preGate,
      branch,
      pr_url: prUrl,
      revision_attempt: attempt,
      revision_feedback: { kind: feedbackKind, feedback },
    },
  });
  writeJson(join(dir, `dev.revision-${attempt}.json`), dev);
  const head = git(["rev-parse", "HEAD"], { cwd: repoWorkspace }).stdout.trim();
  git(["push", "origin", branch], { cwd: repoWorkspace, timeout: 120000 });
  return {
    attempt,
    feedback_kind: feedbackKind,
    feedback,
    dev,
    commit: head,
    completed_at: new Date().toISOString(),
  };
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
  writeReport(next);
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

function productStateFor(current) {
  const merged = current.rounds.filter((round) => round.status === "merged");
  const rejected = current.rounds.filter((round) =>
    ["pre_gate_rejected", "post_gate_failed", "tester_failed", "product_failed", "dev_failed", "dev_no_commit"].includes(
      round.status,
    ),
  );
  const infrastructure = current.rounds.filter((round) =>
    ["pre_gate_failed_to_evaluate", "post_gate_failed_to_evaluate", "tester_failed_to_evaluate"].includes(round.status),
  );
  const diffStat = gitMaybe(["diff", "--stat", `${current.base_branch}..${current.experiment_branch}`], {
    cwd: repoWorkspace,
  });
  const mergedLog = gitMaybe(["log", "--oneline", `${current.base_branch}..${current.experiment_branch}`], {
    cwd: repoWorkspace,
  });
  return {
    base_branch: current.base_branch,
    test_branch: current.experiment_branch,
    current_diff_stat: diffStat.stdout,
    merged_commits: mergedLog.stdout,
    merged_capabilities: merged.map((round) => ({
      round: round.index,
      title: round.proposal?.title || "",
      pr_url: round.pr_url || "",
      value_delta: round.post_gate?.verified_value_delta ?? round.pre_gate?.estimated_value_delta ?? "",
      entropy_delta: round.post_gate?.fused_entropy_delta ?? round.post_gate?.entropy_delta ?? round.pre_gate?.estimated_entropy_delta ?? "",
      running_reward: round.post_gate?.running_reward ?? "",
    })),
    failed_lessons: rejected.map((round) => ({
      round: round.index,
      status: round.status,
      title: round.proposal?.title || "",
      reason: round.post_gate?.reason || round.pre_gate?.reason || round.tester?.reason || round.error || "",
    })),
    infrastructure_issues: infrastructure.map((round) => ({
      round: round.index,
      status: round.status,
      title: round.proposal?.title || "",
      error: round.error || "",
    })),
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
    if (shouldPauseAfter(current.rounds.at(-1))) {
      console.log(`Pausing after ${current.rounds.at(-1).status}; evaluator did not produce a reliable gate result.`);
      break;
    }
    if (config.once) break;
  }
  writeReport(current);
}

function shouldPauseAfter(round) {
  return ["pre_gate_failed_to_evaluate", "post_gate_failed_to_evaluate", "tester_failed_to_evaluate"].includes(
    round?.status,
  );
}

function writeReport(current) {
  const report = [
    `# ${current.run_id} Report`,
    "",
    `Repo: ${current.repo}`,
    `Baseline: ${current.base_branch}`,
    `Experiment: ${current.experiment_branch}`,
    "",
    "| Round | Status | PR | Value | Entropy | Reward |",
    "| --- | --- | --- | --- | --- | --- |",
    ...current.rounds.map((round) => {
      const value = round.post_gate?.verified_value_delta ?? round.pre_gate?.estimated_value_delta ?? "";
      const entropy = round.post_gate?.fused_entropy_delta ?? round.post_gate?.entropy_delta ?? round.pre_gate?.estimated_entropy_delta ?? "";
      const reward = round.post_gate?.running_reward ?? "";
      return `| ${round.index} | ${round.status} | ${round.pr_url || ""} | ${value} | ${entropy} | ${reward} |`;
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
