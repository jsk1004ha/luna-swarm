# Numeric contradiction tolerance

Research HQ checks explicitly comparable numeric claims before accepting an
evidence envelope. Exact citation replay proves which source bytes were used;
it does not resolve disagreement between two source-backed measurements.

## Failure mode

The previous relative-difference denominator was
`max(abs(left), abs(right), 1)`. For values below one, the default relative
tolerance of `0.001` therefore also acted as an undeclared absolute tolerance.
For example, `0.0001` and `0.0002` differed by 50% of the larger magnitude but
produced no contradiction. Rescaling both values could change the verdict.
Both the research service and collected-turn finalizer use this report as an
acceptance gate, so small conflicting measurements could leave Research HQ.

## Contract

- Compare only claims with the same comparison key, normalized unit, period,
  geography, and population. Unresolved claims remain excluded.
- Relative difference is `abs(left - right) / max(abs(left), abs(right))`.
  When both magnitudes are zero, it is zero.
- A pair is close if **either** its absolute difference is at most
  `absoluteTolerance` **or** its relative difference is at most
  `relativeTolerance`. Boundary equality is accepted.
- Defaults stay `absoluteTolerance = 0` and `relativeTolerance = 0.001`.
  To tolerate an absolute near-zero noise floor, choose an explicit absolute
  tolerance in the same unit as the claims. There is no universal nonzero floor.
- The detector does not convert units. `percent`, `percentage`, and `pct`
  normalize to `%`, without changing the numeric value. A ratio of `0.01`
  and a percentage of `1` are not compared automatically. Callers must provide
  consistent units and context rather than relying on inferred conversions.

This follows the symmetric magnitude-based comparison and explicit near-zero
absolute tolerance rationale in [PEP 485](https://peps.python.org/pep-0485/).
Its default tolerances are not adopted; Luna's existing defaults are retained.

## Verification and limits

Deterministic regression fixtures cover positive and negative subunit values,
zero, opposite signs, subnormal values, consistent rescaling, percentage
aliases, tolerance boundaries, and non-comparable contexts. Integration
fixtures use exact immutable source quotes to exercise the final acceptance
gates, including acceptance with an explicitly chosen absolute tolerance.

This fixes a numerical false-negative class. It does not establish semantic
entailment between a claim and its quote, infer statistical significance,
convert units, or demonstrate improved general model performance. Previously
accepted small-value disagreements may now require reconciliation or an
explicitly justified absolute tolerance; this is an intentional correction,
not a change to the documented tolerance defaults.
