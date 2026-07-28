# Min Entropy Dev Documentation

Min Entropy Dev treats repository evolution as the optimization problem and
pull requests as candidate changes subject to explicit selection gates.

## Concepts

- [Architecture](architecture.md): the agent loop, ownership boundaries,
  revision behavior, and failure semantics.
- [Value and entropy model](reward-model.md): how deterministic engineering
  signals and rubric judgment produce a running reward.
- [Experiment methodology](experiment-methodology.md): branch isolation,
  evidence capture, and final human evaluation.

## Current Scope

The current reference implementation integrates GitHub, Claude Code, and a
Node.js/React target repository. The long-term design is repository-agnostic,
with generic orchestration separated from language and framework adapters.

These documents describe stable public concepts and current behavior. Internal
release timing and unpublished experiment findings are intentionally kept out
of the public repository.
