# Hunk branch toggle

A dependency-free extension for Hunk 0.24.1. Press **Shift+B** to switch the current window between:

- **Branch:** the merge-base of the chosen base branch and `HEAD`, compared to the current working tree. Includes committed, staged, and unstaged changes.
- **Uncommitted:** `HEAD` compared to the current working tree. Includes staged and unstaged changes.

Hunk also displays untracked files in these working-tree comparisons by default.

## Install

Install with Hunk's extension manager:

```sh
hunk extension install tverlaan/hunk-branch-toggle
```

Hunk loads it for every new review. Restart an already-running Hunk window to load the extension. No runtime npm installation or build is needed.

For a one-off local test:

```sh
hunk diff HEAD --extension /path/to/hunk-branch-toggle
```

## Use

The **Extensions** menu provides the toggle, direct commands for either mode, and **Choose base branch…**. A status-row label shows the active mode.

The initial comparison is left untouched and labelled **Original diff**. The first Shift+B enters branch mode; the second enters all-uncommitted mode. To start with all uncommitted changes, use `hunk diff HEAD`: bare `hunk diff` only shows unstaged edits in Hunk 0.24.1.

## Base branch

The extension uses `origin/HEAD` when available, then tries `origin/main`, `main`, `origin/master`, and `master`. It never fetches or changes Git state. If none exists, it asks for a base. Choose a different base through the Extensions menu; that choice lasts for this session.

A per-repository default can be set in `.hunk/config.toml`:

```toml
[extension.hunk-branch-toggle]
base_ref = "origin/develop"
```

The merge-base is recalculated each time you enter branch mode, choose a base while in branch mode, or invoke the direct branch command. Ordinary refreshes keep the selected baseline; after rebasing or fetching a moved base, invoke the branch command or toggle out and back.

Switching modes requests a **whole-repository** diff: prior command-line pathspecs and staged-only/revision comparisons are replaced, not restored. Hunk owns the reload and reconciliation of review notes. The extension does not write repository files.

## Keybinding

The default uppercase `B` is unused by Hunk's built-in commands. Remap it in your user config:

```toml
[keybindings]
"hunk-branch-toggle.toggle" = "ctrl+b"
```

## Development

The unit tests use Node's native TypeScript stripping: use Node 22.18+ on the 22.x line, or Node 23.6+ (Node 24 LTS recommended). The PTY smoke test is POSIX-only (macOS/Linux); it does not run on Windows.

```sh
npm ci --ignore-scripts --omit=optional
npm run typecheck
npm test
npm run test:pty
```

The manifest requires extension API 26 because that version introduced `ctx.statusLine`.

`hunkdiff` is a pinned development dependency for the public API types, not a runtime dependency. Mode switching uses the packaged Hunk executable; launching Hunk from source through `bun` or `node` is not supported.

CI runs typechecking and unit tests on Node 22 and 24, plus both PTY smoke tests on Linux. To publish a GitHub release, update `package.json` and the lockfile, then push a matching `v` tag (for example, `v0.1.0`). The release is created only after CI passes.

The PTY smoke test needs Python 3 and `hunk` on the test runner's PATH. Add `--without-hunk-on-path` when running `python3 test/pty-smoke.py` to test Hunk with a restricted launch environment. It creates a temporary Git repository and private terminal, tests both modes against the installed Hunk binary, checks staged/unstaged/untracked coverage, and verifies that Git state and neighboring Hunk windows remain unchanged.

## License

[MIT](LICENSE)
