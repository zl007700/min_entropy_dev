import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJson, readText, tryParseJson, writeText } from "./io.mjs";
import { runStreaming } from "./shell.mjs";

function toolsFor(kind) {
  if (kind === "product") {
    return "Read,Glob,Grep,Bash";
  }
  if (kind === "dev") {
    return "Read,Glob,Grep,Edit,Write,Bash";
  }
  if (kind === "tester") {
    return "Read,Glob,Grep,Bash";
  }
  return "Read,Glob,Grep,Write";
}

function isNoToolAgent(kind) {
  return kind === "pre_gate" || kind === "post_gate";
}

export async function runClaudeAgent({
  kind,
  promptFile,
  workspace,
  artifactDir,
  context,
  expectJson = true,
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
    kind === "product"
      ? `Web search tool: when external evidence would improve the proposal, run node "${resolve("src/search-cli.mjs")}" --artifact "${artifactDir}" "your search query". Search only for focused product evidence.`
      : "",
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
        ? `Get-Content -LiteralPath '${promptPath.replace(/'/g, "''")}' -Raw | claude -p --output-format text --tools '' --disallowedTools '${disallowed}'`
        : `Get-Content -LiteralPath '${promptPath.replace(/'/g, "''")}' -Raw | claude -p --output-format stream-json --verbose --tools '${toolsFor(kind)}' --allowedTools '${toolsFor(kind)}'`
      : noTool
        ? `cat '${promptPath.replace(/'/g, "'\\''")}' | claude -p --output-format text --tools '' --disallowedTools '${disallowed}'`
        : `claude -p "$(cat '${promptPath.replace(/'/g, "'\\''")}')" --output-format stream-json --verbose --tools '${toolsFor(kind)}' --allowedTools '${toolsFor(kind)}'`;
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
    finishOnStdout: noTool ? null : hasResultEvent,
    killOnFinish: !noTool,
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
    return repairJson({ kind, text: finalText || stdout, artifactDir });
  }
}

function hasResultEvent(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      return JSON.parse(line).type === "result";
    } catch {
      return false;
    }
  }
  return false;
}

async function repairJson({ kind, text, artifactDir }) {
  const repairPromptPath = join(artifactDir, `${kind}.json-repair.prompt.txt`);
  const repairPrompt = [
    "Convert the following agent output into strict JSON only.",
    "Do not add new facts. Do not change the decision or meaning. Return only the corrected JSON object.",
    "",
    text,
  ].join("\n");
  writeText(repairPromptPath, repairPrompt);
  const command = process.platform === "win32" ? "powershell.exe" : "bash";
  const script =
    process.platform === "win32"
      ? `Get-Content -LiteralPath '${repairPromptPath.replace(/'/g, "''")}' -Raw | claude -p --output-format text --tools ''`
      : `cat '${repairPromptPath.replace(/'/g, "'\\''")}' | claude -p --output-format text --tools ''`;
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", script] : ["-lc", script];
  const result = await runStreaming(command, args, { cwd: artifactDir });
  writeText(join(artifactDir, `${kind}.json-repair.final.txt`), result.stdout || result.stderr || "");
  if (result.status !== 0) {
    throw new Error(`${kind} JSON repair failed: ${result.stderr || result.error || "unknown error"}`);
  }
  try {
    return tryParseJson(result.stdout);
  } catch (error) {
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
