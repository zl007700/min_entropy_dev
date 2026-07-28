import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv } from "./config.mjs";
import { webSearch } from "./serper.mjs";

loadEnv();

const args = process.argv.slice(2);
const artifactIndex = args.indexOf("--artifact");
let artifactDir = "";
if (artifactIndex >= 0) {
  artifactDir = args[artifactIndex + 1] || "";
  args.splice(artifactIndex, 2);
}

const limitIndex = args.indexOf("--limit");
let limit = 5;
if (limitIndex >= 0) {
  limit = Number(args[limitIndex + 1] || "5");
  args.splice(limitIndex, 2);
}

const query = args.join(" ").trim();
if (!query) {
  console.error("Usage: node src/search-cli.mjs --artifact <dir> [--limit 5] \"query\"");
  process.exit(2);
}

const result = await webSearch(query, Number.isFinite(limit) ? limit : 5);
const payload = {
  at: new Date().toISOString(),
  tool: "web_search",
  ...result,
};

if (artifactDir) {
  mkdirSync(resolve(artifactDir), { recursive: true });
  appendFileSync(join(resolve(artifactDir), "web_search.agent.jsonl"), `${JSON.stringify(payload)}\n`);
}

console.log(JSON.stringify(payload, null, 2));
