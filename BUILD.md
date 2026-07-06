# Building convoy

One Swift SPM package produces both the `convoy` CLI and `Convoy.app` (the menubar host). No
Xcode project — plain SPM + [Swift Bundler](https://swiftbundler.dev/) for the `.app`.

## Requirements

- Swift 6+ (`swift --version`)
- macOS 13+ (MenuBarExtra)
- `st` + `pty` on PATH (the tools convoy orchestrates)
- For the app bundle: `swift-bundler` (installed in the packaging step)

## CLI

```sh
swift build --product convoy            # debug → .build/debug/convoy
swift build -c release --product convoy # release → .build/release/convoy
swift test                              # ConvoyKit unit tests (AC-1 derivation, JSON binder)
```

Try it against the live bus:

```sh
.build/debug/convoy ls
.build/debug/convoy doctor
.build/debug/convoy add worker --identity demo-wk --dry-run   # shows derived wiring; launches nothing
```

## App bundle (Convoy.app)

The menubar app is the `ConvoyApp` executable target, bundled into `Convoy.app` by Swift Bundler
(config in `Bundler.toml`, Info.plist keys included: `LSUIElement`, Calendar usage description,
etc.). Ad-hoc signed for local/demo use; the signing identity is swappable so Developer ID +
notarization drops in later without code changes.

```sh
# packaging step — see Bundler.toml (added in the app-packaging change)
swift bundler bundle -c release        # → .build/bundler/Convoy.app
codesign --deep --force -s - .build/bundler/Convoy.app   # ad-hoc
convoy app install --bundle .build/bundler/Convoy.app    # copy to /Applications (non-brew path)
```

## Distribution

`brew install --cask myobie/convoy/convoy` installs `Convoy.app` to `/Applications` and symlinks
the `convoy` CLI. See the `myobie/homebrew-convoy` tap.
