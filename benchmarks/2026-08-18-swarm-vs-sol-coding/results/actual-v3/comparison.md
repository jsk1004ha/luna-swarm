# Actual Luna Swarm vs single Sol — coding result

Comparison: `actual-v3`

Quality verdict: **inconclusive** — Neither arm passed every gate and scores are tied.

| Arm | Deterministic score | All gates | Model calls | Exact total tokens | Wall time |
| --- | ---: | :---: | ---: | ---: | ---: |
| luna (gpt-5.6-luna) | 40/100 | FAIL | 13 | 596745 | 896.9 s |
| sol (gpt-5.6-sol) | 40/100 | FAIL | 1 | 228051 | 200.4 s |

## Gate details

### luna

- hidden: FAIL (0/60)
- public: PASS (15/15)
- syntax: PASS (10/10)
- scopeAndRepository: PASS (10/10)
- completeness: PASS (5/5)

### sol

- hidden: FAIL (0/60)
- public: PASS (15/15)
- syntax: PASS (10/10)
- scopeAndRepository: PASS (10/10)
- completeness: PASS (5/5)

## Interpretation

- Quality is determined only by the declared deterministic gates. Efficiency never compensates for a failed gate.
- Token totals are shown only when both runtimes emitted complete exact usage components; missing usage is not estimated. Sol omitted total_tokens, so its exact total is input_tokens + output_tokens.
- This is a one-task diagnostic and is not promotion-grade: the intended hidden-suite digest could not be reproduced from retained bytes, so the actual evaluator was materialized only after both candidates were frozen. It remained blind to both candidates but is not a preregistered authority.
- The local hidden suite is not a remote protected authority and the Windows Sol arm used a disposable-clone post-validation boundary.
- See analysis.md for causal Luna integration evidence, phase-level token analysis, and the non-scoring supplemental stress result.

