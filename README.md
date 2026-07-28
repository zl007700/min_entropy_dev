# Min Entropy Dev

Orchestrates a low-entropy development experiment against
`git@github.com:zl007700/valuable_agent.git`.

The target repository's `main` branch is treated as a frozen baseline. Each run
creates a `test_<run_id>` branch from `main`, then merges iteration PRs into
that test branch only. After the configured number of rounds, a human compares
`main` with the test branch.

## Local Run

```powershell
cp ..\.env .env
npm install
npm run smoke
npm run loop -- --rounds 10
npm run loop -- --run-id sdk-10r-002 --rounds 10 --once
```

Artifacts are written to `runs/<run_id>/`.

Use `--once` for checkpointed experiments. It runs only the next missing round,
writes artifacts and the report, then stops so a human can inspect the round
before continuing.

Use `--revise-attempts <n>` to control how many times a PR can return to the Dev
Agent after a post-gate or tester `revise` result. The default is 2.

## Orchestrator Boundary

The orchestrator coordinates the loop, creates branches and PRs, records
artifacts, and enforces gate outcomes. It must not substitute for an agent:

- Product proposals must come from the Product Manager Agent.
- Code changes and commits must come from the Dev Agent.
- Rubric decisions must come from the Rubric Agent.
- Test decisions must come from the Tester Agent.

If an agent fails to produce a valid result, the round is recorded as failed
rather than repaired by orchestration fallback logic.

Evaluator infrastructure failures (`*_failed_to_evaluate`) pause the loop and
leave the PR open for inspection instead of silently continuing.
