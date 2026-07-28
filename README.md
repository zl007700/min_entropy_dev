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
```

Artifacts are written to `runs/<run_id>/`.
