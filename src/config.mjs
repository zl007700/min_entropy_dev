import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnv(path = ".env") {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) return;
  for (const rawLine of readFileSync(fullPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...rest] = line.split("=");
    if (!process.env[key]) {
      process.env[key] = rest.join("=");
    }
  }
}

export function configFromEnv(argv = process.argv.slice(2)) {
  const getArg = (name, fallback = "") => {
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1]) return argv[index + 1];
    const inline = argv.find((value) => value.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    return fallback;
  };

  const rounds = Number(getArg("rounds", process.env.ROUNDS || "10"));
  const reviseAttemptsArg = getArg("revise-attempts", process.env.REVISE_ATTEMPTS || "");
  const reviseAttempts = reviseAttemptsArg === "" ? null : Number(reviseAttemptsArg);
  const runMode = getArg("run-mode", process.env.RUN_MODE || "low_entropy");
  return {
    repo: process.env.VALUABLE_REPO || "zl007700/valuable_agent",
    repoUrl: process.env.VALUABLE_REPO_URL || "git@github.com:zl007700/valuable_agent.git",
    baseBranch: process.env.BASE_BRANCH || "main",
    rounds: Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : 10,
    reviseAttempts:
      reviseAttempts === null
        ? null
        : Number.isFinite(reviseAttempts) && reviseAttempts >= 0
          ? Math.floor(reviseAttempts)
          : null,
    runMode,
    runId:
      getArg("run-id", process.env.RUN_ID || "") ||
      `run-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}`,
    smoke: argv.includes("--smoke"),
    once: argv.includes("--once"),
  };
}
