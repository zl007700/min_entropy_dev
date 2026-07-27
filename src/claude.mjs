import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, readText, tryParseJson, writeText } from "./io.mjs";
import { runStreaming } from "./shell.mjs";

function toolsFor(kind) {
  if (kind === "dev" || kind === "tester") {
    return "Read,Glob,Grep,Edit,Write,Bash";
  }
  return "Read,Glob,Grep,Write";
}

function isNoToolAgent(kind) {
  return kind === "product" || kind === "pre_gate" || kind === "post_gate";
}

export async function runClaudeAgent({
  kind,
  promptFile,
  workspace,
  artifactDir,
  context,
  expectJson = true,
  maxTurns = 12,
}) {
  const system = readText(promptFile);
  const task = [
    system,
    "",
    "Context JSON:",
    JSON.stringify(context, null, 2),
    "",
    `Workspace path: ${workspace}`,
    `Artifact path: ${artifactDir}`,
    "Use repository evidence. Write useful artifacts only inside the artifact path unless you are the Dev Agent implementing code.",
  ].join("\n");
  const stdoutPath = join(artifactDir, `${kind}.stdout.jsonl`);
  const stderrPath = join(artifactDir, `${kind}.stderr.log`);
  const promptPath = join(artifactDir, `${kind}.prompt.txt`);
  writeText(promptPath, task);
  let stdout = "";
  let stderr = "";
  const command = process.platform === "win32" ? "powershell.exe" : "bash";
  const noTool = isNoToolAgent(kind);
  const disallowed =
    "Skill,Bash,Task,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Workflow,TaskCreate,TaskUpdate,TaskGet,TaskList,TaskOutput,TaskStop,EnterPlanMode,ExitPlanMode,CronCreate,CronDelete,CronList,AskUserQuestion,NotebookEdit";
  const script =
    process.platform === "win32"
      ? noTool
        ? `Get-Content -LiteralPath '${promptPath.replace(/'/g, "''")}' -Raw | claude -p --output-format text --max-turns ${maxTurns} --disallowedTools '${disallowed}'`
        : `Get-Content -LiteralPath '${promptPath.replace(/'/g, "''")}' -Raw | claude -p --output-format stream-json --verbose --max-turns ${maxTurns} --allowedTools '${toolsFor(kind)}'`
      : noTool
        ? `cat '${promptPath.replace(/'/g, "'\\''")}' | claude -p --output-format text --max-turns ${maxTurns} --disallowedTools '${disallowed}'`
        : `claude -p "$(cat '${promptPath.replace(/'/g, "'\\''")}')" --output-format stream-json --verbose --max-turns ${maxTurns} --allowedTools '${toolsFor(kind)}'`;
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", script] : ["-lc", script];
  const result = await runStreaming(command, args, {
    cwd: workspace,
    onStdout: (chunk) => {
      stdout += chunk;
      writeText(stdoutPath, stdout);
    },
    onStderr: (chunk) => {
      stderr += chunk;
      writeText(stderrPath, stderr);
    },
  });
  const finalText = noTool ? stdout.trim() : extractFinalText(stdout);
  writeText(join(artifactDir, `${kind}.final.txt`), finalText || stdout);
  if (result.status !== 0) {
    throw new Error(`${kind} agent failed: ${stderr || finalText || result.error || "unknown error"}`);
  }
  if (!expectJson) return { text: finalText };
  try {
    return tryParseJson(finalText);
  } catch (error) {
    const fallback = fallbackJsonPath(kind, artifactDir);
    if (fallback && existsSync(fallback)) {
      return readJson(fallback);
    }
    const synthetic = syntheticJson(kind, finalText || stdout);
    if (synthetic) return synthetic;
    throw error;
  }
}

function fallbackJsonPath(kind, artifactDir) {
  const names = {
    product: "product.proposal.json",
    pre_gate: "pre_gate.result.json",
    post_gate: "post_gate.result.json",
    tester: "tester.report.json",
    dev: "dev.summary.json",
  };
  return names[kind] ? join(artifactDir, names[kind]) : null;
}

function syntheticJson(kind, text) {
  if (kind !== "post_gate") return null;
  const lower = String(text || "").toLowerCase();
  if (lower.includes("decision: **pass**") || lower.includes("decision: pass")) {
    return {
      decision: "pass",
      verified_value_delta: Number(lower.match(/value_delta\s*=\s*(\d+)/)?.[1] || 1),
      entropy_delta: Number(lower.match(/entropy_delta\s*=\s*(\d+)/)?.[1] || 1),
      value_evidence: ["Synthetic fallback parsed an explicit pass verdict from post-gate text."],
      entropy_evidence: ["Synthetic fallback parsed entropy/value deltas from post-gate text."],
      blocking_reasons: [],
      follow_up_issues: [String(text || "").slice(0, 500)],
      reason: "Post-gate returned natural language instead of JSON; explicit pass verdict was normalized.",
      normalized_from_text: true,
    };
  }
  return {
    decision: "revise",
    verified_value_delta: 0,
    entropy_delta: 2,
    value_evidence: [],
    entropy_evidence: ["Post-gate failed to return parseable JSON."],
    blocking_reasons: ["Post-gate output was not parseable JSON."],
    follow_up_issues: [String(text || "").slice(0, 500)],
    reason: "Post-gate output was not parseable; conservative revise fallback.",
    normalized_from_text: true,
  };
}

function extractFinalText(stdout) {
  let text = "";
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            text = block.text;
          }
        }
      }
      if (event.type === "result" && event.result) {
        text = event.result;
      }
    } catch {
      // Keep parsing best-effort; raw trace is persisted.
    }
  }
  return text.trim();
}
