# Value and Entropy Model

Min Entropy Dev uses a running reward to guide iteration while preserving a
separate final human evaluation. The running score is an operating signal, not
a universal definition of software value.

## Running Reward

For an evaluated pull request:

```text
entropy_delta = objective_entropy_delta
                * agent_risk_multiplier
                * uncertainty_multiplier

running_reward = verified_value_delta / entropy_delta
```

Only accepted changes should contribute to the state of the experiment branch.

## Value

Before implementation, the proposal rubric estimates the value delta. After
implementation, the post-PR rubric verifies value against the acceptance
criteria, diff, deterministic checks, and repository evidence.

Value may include shipped capability or useful learning, but unsupported claims
must not receive credit. At the end of a long experiment, a human score sheet
compares the baseline and experiment branches. Human evaluation remains the
final authority for product value.

## Objective Entropy

The current objective entropy component includes:

- Code churn.
- Number of touched files.
- Concentration of churn in a hotspot file.
- Growth of state and handler surface in supported frontend files.
- Production changes without corresponding test changes.

These metrics are intentionally observable and reproducible, but they are
proxies. They cannot determine architectural quality by themselves.

## Agent Risk Multiplier

The post-PR rubric independently evaluates structural risks that simple metrics
may miss, such as duplicated concepts, unclear ownership, new coordination
cost, unnecessary state, fragile coupling, or operational complexity.

The current rubric constrains the multiplier to a bounded range. A value below
one indicates that the change reduces future maintenance cost despite its
churn; a value above one increases the entropy cost of the PR.

## Uncertainty Multiplier

Weak verification is itself a cost. The uncertainty multiplier increases when
important value or entropy claims remain assumptions, tests do not exercise the
real path, or repository evidence is incomplete.

## Absolute Branch Scores

The intended branch-level view is:

```text
branch_value = baseline_value + sum(accepted_value_delta)
branch_entropy = baseline_entropy + sum(accepted_entropy_delta)
```

The current dashboard remains experimental. Baseline measurement and
accepted-only accounting must be validated before absolute scores are used as
public evidence.

## Limitations

- Value estimates depend on a stable rubric and adequate product context.
- Engineering metrics vary across languages and frameworks.
- Agent judgment may be biased or inconsistent across model versions.
- A scalar reward cannot preserve every important product or engineering
  constraint.
- Optimizing the running metric directly may produce Goodhart effects.

For these reasons, raw artifacts, PR evidence, and final human scoring remain
part of the evaluation protocol.
