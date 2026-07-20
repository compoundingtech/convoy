# 0007 — One canonical object behind three formats

Status: accepted

## Context

The agent spec is defined in KDL, TOML, and JSON with "identical semantics". The
claim is easy to state and easy to violate: three parsers, each applying field
rules, will drift, and the drift will be in edge cases nobody writes tests for —
whether a bare node means `true`, whether a repeated block is a list, whether a
missing field is absent or empty.

There is a second problem specific to KDL. TOML and JSON are key/value languages
and map to a plain object with no design work. KDL is a node/argument/property
language, and the published spec gives its examples only in TOML. So the KDL
mapping — in particular, how `[pty.agent]` is spelled — is not written down
anywhere. It has to be designed, and designed such that the three formats
actually converge.

## Options

**Three parsers producing the typed object.** The straightforward reading of
"three formats", and the one that makes identical semantics a promise three
implementations have to keep rather than a structural fact.

**Convert KDL and JSON to TOML text, then parse.** Avoids a second semantics
path at the cost of a lossy round trip through a text format, with quoting and
type-coercion failures at every boundary.

**Decode to a common object, then apply semantics once.**

## Decision

Each format decodes to the same canonical plain object, and exactly one function
applies field rules and validation. Format selects the decoder and nothing else;
there is no per-format field handling above the decoding layer. Identical
semantics is therefore structural — a format that decodes correctly is fully
supported by definition.

The KDL mapping is defined explicitly, its load-bearing rule being that a node
with one unnamed argument **and** children treats that argument as a name
segment: `pty "agent" { … }` means `[pty.agent]`. Without that rule the spec's
central construct has no KDL spelling.

Repeated sibling nodes collapse to a list, which is how `[[render.file]]` spells
in KDL; repeated *named* nodes merge into one table, so a table of tables can be
written either way.

## Consequences

- Adding a fourth format is a decoder, not a semantics review.
- The equivalence is testable directly, and is tested by decoding the same
  document in all three formats and asserting the results are equal — rather
  than by three parallel parser test suites that can each be individually right
  and collectively inconsistent.
- KDL requires a parser dependency. `@bgotink/kdl` was chosen for having no
  transitive dependencies, in a package that otherwise has one runtime
  dependency; the alternative pulled in a parser generator.
- The canonical object is untyped, so a typo in a field name is not caught by
  the decoder. It is caught, or ignored, by the single semantics path — which is
  the right place for that decision to be made once.
- The KDL mapping is convoy's design, not the spec's. Until the spec adopts it,
  a different implementation could map KDL differently and still claim
  conformance. This is a gap in the published spec rather than in convoy, and is
  worth proposing upstream.

## Evidence

- `src/spec-format.test.ts` decodes one document in all three formats and
  asserts structural equality, then pins each individual mapping rule.
