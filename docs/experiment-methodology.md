# Experiment Methodology

Min Entropy Dev evaluates a sequence of repository changes rather than a single
coding task. The experiment isolates autonomous development from the baseline
branch and preserves evidence for every attempted round.

## Branch Model

1. Treat the target repository's configured base branch, normally `main`, as
   the baseline.
2. Create one `test_<run_id>` experiment branch from that baseline.
3. Create a separate iteration branch and pull request for each candidate
   change.
4. Target iteration PRs only at the experiment branch.
5. Merge only after the post-PR rubric and tester both pass.
6. Compare the final experiment branch with the baseline after the run.

This preserves Git history and makes the experiment reversible and auditable.

## Checkpointed Execution

The recommended `--once` mode runs one missing round, writes its artifacts and
state, then exits. Repeating the same command advances the same run. This makes
long experiments observable and allows infrastructure failures to be inspected
before execution continues.

## Round Evidence

Depending on the outcome, a round may preserve:

- Product state and proposal revisions.
- Pre-implementation rubric decisions.
- Dev Agent output and commit evidence.
- Pull request body, URL, and diff.
- Deterministic build, lint, smoke, and repository-specific checks.
- Objective entropy metrics.
- Post-PR rubric and Tester reports.
- Revision feedback and subsequent commits.
- Heartbeat, failure, and resumption records.

Artifacts are written under `runs/<run_id>/iterations/<round>/`. Target
checkouts are isolated under `workspaces/<run_id>/`.

## Final Evaluation

Agent-estimated value supports decisions during the loop. After the experiment,
a human evaluator compares the baseline and experiment branches using a fixed
score sheet. The final review should consider:

- User-visible capability and workflow value.
- Reliability and regression behavior.
- Architecture, state surface, testability, and operational burden.
- Whether the accumulated repository is easier or harder to evolve further.
- Differences between running reward and final human judgment.

## Reporting

Public experiment reports should distinguish:

- Direct evidence from commits, PRs, tests, and artifacts.
- Agent estimates produced during the run.
- Human scores produced after the run.
- Inferences and hypotheses that remain unverified.

Credentials, private operational timing, raw provider configuration, and
unredacted sensitive traces must not be published.

## Reference Experiment

The first public reference target is Valuable Agent, a deliberately small React
agent whose experiment branch evolves through this workflow. Its source,
baseline, score sheet, and redacted run artifacts will be published only after
the active experiment and privacy review are complete.
