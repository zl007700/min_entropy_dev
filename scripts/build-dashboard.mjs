import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJson, writeText } from "../src/io.mjs";

const root = resolve(".");
const runId = process.argv[2] || process.env.RUN_ID;

if (!runId) {
  console.error("Usage: node scripts/build-dashboard.mjs <run_id>");
  process.exit(1);
}

const runDir = join(root, "runs", runId);
const statePath = join(runDir, "state.json");

if (!existsSync(statePath)) {
  console.error(`Missing state file: ${statePath}`);
  process.exit(1);
}

const state = readJson(statePath);
const baselineValue = numberOrNull(process.env.BASELINE_VALUE) ?? 0;
const baselineEntropy = numberOrNull(process.env.BASELINE_ENTROPY) ?? 0;
const rows = [...(state.rounds || [])]
  .sort((a, b) => Number(a.index) - Number(b.index))
  .reduce((acc, round) => {
    const value = numberOrNull(round.post_gate?.verified_value_delta ?? round.pre_gate?.estimated_value_delta);
    const entropyDelta = numberOrNull(round.post_gate?.entropy_delta ?? round.pre_gate?.estimated_entropy_delta);
    const previous = acc.at(-1);
    const cumulativeValue = (previous?.cumulativeValue ?? 0) + (value ?? 0);
    const cumulativeEntropy = (previous?.cumulativeEntropy ?? 0) + (entropyDelta ?? 0);
    const absoluteValue = baselineValue + cumulativeValue;
    const absoluteEntropy = baselineEntropy + cumulativeEntropy;
    const valueEntropyRatio = absoluteEntropy === 0 ? null : absoluteValue / absoluteEntropy;
    acc.push({
      round: Number(round.index),
      status: round.status || "",
      title: round.proposal?.title || "",
      prUrl: round.pr_url || "",
      value,
      entropyDelta,
      cumulativeValue,
      cumulativeEntropy,
      absoluteValue,
      absoluteEntropy,
      valueEntropyRatio,
      source: round.post_gate ? "verified" : round.pre_gate ? "estimated" : "missing",
    });
    return acc;
  }, []);

const dashboardPath = join(runDir, "dashboard.html");
writeText(dashboardPath, renderDashboard(state, rows));
console.log(`Wrote ${dashboardPath}`);

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function renderDashboard(state, rows) {
  const series = [
    { key: "absoluteValue", label: "Value", color: "#2563eb" },
    { key: "absoluteEntropy", label: "Entropy", color: "#dc2626" },
    { key: "valueEntropyRatio", label: "Value / Entropy", color: "#16a34a" },
  ];
  const totals = summarize(rows);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(state.run_id)} Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f8fafc;
      --panel: #ffffff;
      --text: #111827;
      --muted: #64748b;
      --line: #d7dde7;
      --soft: #eef2f7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 28px auto 48px;
    }
    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 28px;
      line-height: 1.1;
      letter-spacing: 0;
    }
    .meta, .muted { color: var(--muted); }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 18px 0;
    }
    .metric, .chart, .table-wrap {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .metric {
      padding: 14px 16px;
      min-height: 82px;
    }
    .metric .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .metric .value {
      margin-top: 8px;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .chart {
      padding: 18px;
    }
    .chart-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 10px;
    }
    .chart-title {
      font-size: 16px;
      font-weight: 700;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .swatch {
      width: 18px;
      height: 3px;
      border-radius: 999px;
      display: inline-block;
    }
    svg {
      width: 100%;
      height: auto;
      display: block;
    }
    .axis { stroke: #94a3b8; stroke-width: 1; }
    .grid { stroke: #e2e8f0; stroke-width: 1; }
    .tick { fill: #64748b; font-size: 12px; }
    .line { fill: none; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
    .point { stroke: #fff; stroke-width: 2; }
    .table-wrap {
      margin-top: 18px;
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 820px;
    }
    th, td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--soft);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .06em;
      background: #fbfdff;
    }
    td.num { font-variant-numeric: tabular-nums; }
    .status {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      background: #eef2ff;
      color: #3730a3;
      font-size: 12px;
      font-weight: 600;
    }
    .status.failed { background: #fee2e2; color: #991b1b; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (max-width: 760px) {
      header { display: block; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      main { width: min(100vw - 20px, 1180px); margin-top: 18px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${escapeHtml(state.run_id)} gate dashboard</h1>
        <div class="meta">Repo ${escapeHtml(state.repo)} | ${escapeHtml(state.base_branch)} -> ${escapeHtml(state.experiment_branch)}</div>
      </div>
      <div class="meta">Generated ${escapeHtml(new Date().toISOString())}</div>
    </header>

    <section class="summary">
      <div class="metric"><div class="label">Rounds</div><div class="value">${rows.length}</div></div>
      <div class="metric"><div class="label">Merged</div><div class="value">${totals.merged}</div></div>
      <div class="metric"><div class="label">Value</div><div class="value">${formatNumber(totals.value)}</div></div>
      <div class="metric"><div class="label">Entropy</div><div class="value">${formatNumber(totals.entropy)}</div></div>
    </section>

    <section class="chart">
      <div class="chart-head">
        <div>
          <div class="chart-title">Value / Entropy Track</div>
          <div class="muted">X axis is round_num. Value and entropy are absolute branch scores: baseline + accumulated round deltas.</div>
        </div>
        <div class="legend">
          ${series.map((item) => `<span class="legend-item"><span class="swatch" style="background:${item.color}"></span>${escapeHtml(item.label)}</span>`).join("")}
        </div>
      </div>
      ${renderChart(rows, series)}
    </section>

    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Round</th>
            <th>Status</th>
            <th>Title</th>
            <th>Value</th>
            <th>Entropy</th>
            <th>V/E</th>
            <th>Source</th>
            <th>PR</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(renderRow).join("")}
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>
`;
}

function summarize(rows) {
  const last = rows.at(-1);
  return {
    merged: rows.filter((row) => row.status === "merged").length,
    value: last?.absoluteValue ?? baselineValue,
    entropy: last?.absoluteEntropy ?? baselineEntropy,
  };
}

function renderChart(rows, series) {
  if (!rows.length) return `<div class="muted">No rounds yet.</div>`;

  const width = 1040;
  const height = 420;
  const margin = { top: 26, right: 28, bottom: 48, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const rounds = rows.map((row) => row.round);
  const minRound = Math.min(...rounds);
  const maxRound = Math.max(...rounds);
  const maxY = Math.max(
    1,
    ...rows.flatMap((row) => series.map((item) => row[item.key]).filter((value) => value != null)),
  );
  const yTop = Math.ceil(maxY + 0.25);
  const yTicks = Array.from({ length: yTop + 1 }, (_, index) => index);
  const xTicks = rounds;

  const x = (round) => {
    if (maxRound === minRound) return margin.left + plotWidth / 2;
    return margin.left + ((round - minRound) / (maxRound - minRound)) * plotWidth;
  };
  const y = (value) => margin.top + plotHeight - (value / yTop) * plotHeight;
  const linePath = (key) => rows
    .filter((row) => row[key] != null)
    .map((row, index) => `${index === 0 ? "M" : "L"} ${x(row.round).toFixed(2)} ${y(row[key]).toFixed(2)}`)
    .join(" ");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Rubric value entropy and ratio by round">
    ${yTicks.map((tick) => {
      const yy = y(tick);
      return `<line class="grid" x1="${margin.left}" y1="${yy}" x2="${width - margin.right}" y2="${yy}"></line><text class="tick" x="${margin.left - 12}" y="${yy + 4}" text-anchor="end">${tick}</text>`;
    }).join("")}
    ${xTicks.map((tick) => {
      const xx = x(tick);
      return `<line class="grid" x1="${xx}" y1="${margin.top}" x2="${xx}" y2="${height - margin.bottom}"></line><text class="tick" x="${xx}" y="${height - 18}" text-anchor="middle">${tick}</text>`;
    }).join("")}
    <line class="axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>
    <line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}"></line>
    ${series.map((item) => `<path class="line" d="${linePath(item.key)}" stroke="${item.color}"></path>`).join("")}
    ${series.flatMap((item) => rows
      .filter((row) => row[item.key] != null)
      .map((row) => `<circle class="point" cx="${x(row.round).toFixed(2)}" cy="${y(row[item.key]).toFixed(2)}" r="4.5" fill="${item.color}"><title>Round ${row.round} ${item.label}: ${formatNumber(row[item.key])}</title></circle>`))
      .join("")}
    <text class="tick" x="${margin.left + plotWidth / 2}" y="${height - 4}" text-anchor="middle">round_num</text>
  </svg>`;
}

function renderRow(row) {
  const failed = row.status !== "merged" ? " failed" : "";
  return `<tr>
    <td class="num">${row.round}</td>
    <td><span class="status${failed}">${escapeHtml(row.status)}</span></td>
    <td>${escapeHtml(row.title)}</td>
    <td class="num">${formatNumber(row.absoluteValue)}</td>
    <td class="num">${formatNumber(row.absoluteEntropy)}</td>
    <td class="num">${formatNumber(row.valueEntropyRatio)}</td>
    <td>${escapeHtml(row.source)}</td>
    <td>${row.prUrl ? `<a href="${escapeHtml(row.prUrl)}">PR</a>` : ""}</td>
  </tr>`;
}

function formatNumber(value) {
  if (value == null) return "";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
