import { spawn, spawnSync } from "node:child_process";

export function run(command, args, options = {}) {
  const actualCommand = commandForPlatform(command);
  const result = spawnSync(actualCommand, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    shell: Boolean(options.shell),
    timeout: options.timeout,
    maxBuffer: options.maxBuffer || 1024 * 1024 * 80,
  });
  return {
    command,
    args,
    cwd: options.cwd,
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error) : null,
  };
}

function commandForPlatform(command) {
  if (process.platform !== "win32") return command;
  if (command === "npm" || command === "npx" || command === "pnpm") {
    return `${command}.cmd`;
  }
  return command;
}

export function runChecked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}\n${result.error || ""}`,
    );
  }
  return result;
}

export function runStreaming(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: Boolean(options.shell),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.onStdout) options.onStdout(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (options.onStderr) options.onStderr(chunk);
    });
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    child.on("error", (error) => resolve({ status: 1, stdout, stderr, error: String(error) }));
  });
}
