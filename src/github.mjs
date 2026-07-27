import { run, runChecked } from "./shell.mjs";

export function ghJson(args, options = {}) {
  const result = runChecked("gh", [...args, "--json", options.fields || "number,url,state,headRefName,baseRefName"], {
    cwd: options.cwd,
    timeout: options.timeout || 60000,
  });
  return JSON.parse(result.stdout);
}

export function gh(args, options = {}) {
  return runChecked("gh", args, { cwd: options.cwd, timeout: options.timeout || 60000 });
}

export function git(args, options = {}) {
  return runChecked("git", args, { cwd: options.cwd, timeout: options.timeout || 60000 });
}

export function gitMaybe(args, options = {}) {
  return run("git", args, { cwd: options.cwd, timeout: options.timeout || 60000 });
}
