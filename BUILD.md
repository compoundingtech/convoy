# Building convoy

convoy is a **TypeScript** CLI that runs on Node — there is **no build step**. Node (≥23.6) strips
the types from the imported `.ts` at load (the same `--experimental-strip-types` convention as
smalltalk), so `bin/convoy` runs the sources directly.

## Requirements

- Node ≥ 23.6 (`node --version`) — for native `.ts` type-stripping
- `st` (smalltalk) + `pty` on PATH — the tools convoy orchestrates
- the sibling `../pty` and `../smalltalk` repos checked out — convoy depends on `@compoundingtech/pty`
  locally (`file:../pty`) and references smalltalk's hook scripts by path
- macOS (agents run in a TCC-granted terminal)

## Install deps

```sh
npm install
```

## Run it

```sh
./bin/convoy --version
./bin/convoy ls
./bin/convoy doctor
./bin/convoy add worker --identity demo-wk --dry-run   # shows derived wiring; launches nothing
```

Put `bin/convoy` on your PATH (or `npm link`) to run it as `convoy` from anywhere.

## Test + typecheck

```sh
npm test           # vitest — pure-core unit tests (derivation, flapping-cap, launch wiring, …)
npm run typecheck  # tsc --noEmit
```

## The macOS app

The `Convoy.app` menubar host lives in a separate **`convoy-macos`** repo (SwiftUI). This repo is
the CLI only.

## Distribution

`brew install --cask myobie/convoy/convoy` installs convoy via the `myobie/homebrew-convoy` tap.
See [notes/DISTRIBUTION.md](notes/DISTRIBUTION.md) for the release + packaging flow.
