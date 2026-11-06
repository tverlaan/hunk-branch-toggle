# Hunk branch toggle

A dependency-free extension for Hunk 0.24.1. Press **Shift+B** to switch the current window between:

- **Branch:** the merge-base of the chosen base branch and `HEAD`, compared to the current working tree. Includes committed, staged, and unstaged changes.
- **Uncommitted:** `HEAD` compared to the current working tree. Includes staged and unstaged changes.

Hunk also displays untracked files in these working-tree comparisons by default.

## Use

```sh
hunk diff HEAD --extension /Users/timmo/Code/hunk-branch-toggle
```

For every new Hunk window, add this path to your user config (`~/.config/hunk/config.toml`):

```toml
[extensions]
paths = ["/Users/timmo/Code/hunk-branch-toggle"]
```

Restart an already-running Hunk window to load the extension. No runtime npm installation or build is needed.

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

```sh
npm ci --ignore-scripts --omit=optional
npm run typecheck
npm test
npm run test:pty
```

`hunkdiff` is a pinned development dependency for the public API types, not a runtime dependency. The extension uses asynchronous, argument-array subprocess calls and reuses the running Hunk executable, so `hunk` does not need to be on the application's PATH. It identifies its own live session by process ID and fails closed if that identity is ambiguous; it never selects another window by repository path.

The PTY smoke test needs Python 3 and `hunk` on the test runner's PATH. Add `--without-hunk-on-path` when running `python3 test/pty-smoke.py` to test Hunk with a restricted launch environment. It creates a temporary Git repository and private terminal, tests both modes against the installed Hunk binary, checks staged/unstaged/untracked coverage, and verifies that Git state and neighboring Hunk windows remain unchanged.
