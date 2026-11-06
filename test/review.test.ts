import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { branchBaseline, detectBase, ownSessionId, reloadReview, resolveCommit, runCommand, type RunCommand } from "../review.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

export function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-toggle-"));
  directories.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Toggle Test");
  git("config", "user.email", "toggle@example.test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "file.txt"), "initial\n");
  git("add", ".");
  git("commit", "-m", "Initial");
  return { cwd, git };
}

test("branch baseline includes committed, staged, unstaged, and staged additions", async () => {
  const { cwd, git } = repository();
  const fork = git("rev-parse", "HEAD");
  git("checkout", "-b", "feature");
  writeFileSync(join(cwd, "file.txt"), "initial\ncommitted\n");
  git("commit", "-am", "Feature");
  writeFileSync(join(cwd, "file.txt"), "initial\ncommitted\nstaged\n");
  writeFileSync(join(cwd, "added.txt"), "staged addition\n");
  git("add", ".");
  writeFileSync(join(cwd, "file.txt"), "initial\ncommitted\nstaged\nunstaged\n");
  const ancestor = await branchBaseline(cwd, "main");
  assert.equal(ancestor, fork);
  const branch = git("diff", ancestor);
  assert.match(branch, /\+committed/);
  assert.match(branch, /\+staged/);
  assert.match(branch, /\+unstaged/);
  assert.match(branch, /\+staged addition/);
  const uncommitted = git("diff", "HEAD");
  assert.doesNotMatch(uncommitted, /\+committed/);
  assert.match(uncommitted, /\+staged/);
  assert.match(uncommitted, /\+unstaged/);
  assert.match(uncommitted, /\+staged addition/);
});

test("base branch changes after the fork are not attributed to the feature", async () => {
  const { cwd, git } = repository();
  const fork = git("rev-parse", "HEAD");
  git("checkout", "-b", "feature");
  writeFileSync(join(cwd, "feature.txt"), "feature\n");
  git("add", ".");
  git("commit", "-m", "Feature");
  git("checkout", "main");
  writeFileSync(join(cwd, "main-only.txt"), "main only\n");
  git("add", ".");
  git("commit", "-m", "Main moved");
  git("checkout", "feature");
  const ancestor = await branchBaseline(cwd, "main");
  assert.equal(ancestor, fork);
  assert.doesNotMatch(git("diff", ancestor), /main-only/);
});

test("detects origin's default branch before stale local main", async () => {
  const { cwd, git } = repository();
  git("update-ref", "refs/remotes/origin/develop", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  assert.equal(await detectBase(cwd), "refs/remotes/origin/develop");
});

test("falls back to local main and master without a remote HEAD", async () => {
  const { cwd, git } = repository();
  assert.equal(await detectBase(cwd), "refs/heads/main");
  git("branch", "-m", "master");
  assert.equal(await detectBase(cwd), "refs/heads/master");
});

test("auto-detected main is not shadowed by a tag with the same name", async () => {
  const { cwd, git } = repository();
  git("tag", "main");
  writeFileSync(join(cwd, "file.txt"), "main advanced\n");
  git("commit", "-am", "Advance main");
  const base = await detectBase(cwd);
  assert.equal(base, "refs/heads/main");
  assert.equal(await branchBaseline(cwd, base!), git("rev-parse", "HEAD"));
});

test("auto-detected remote branch is not shadowed by a local origin/main branch", async () => {
  const { cwd, git } = repository();
  git("branch", "origin/main");
  writeFileSync(join(cwd, "file.txt"), "main advanced\n");
  git("commit", "-am", "Advance main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const base = await detectBase(cwd);
  assert.equal(base, "refs/remotes/origin/main");
  assert.equal(await branchBaseline(cwd, base!), git("rev-parse", "HEAD"));
});

test("does not guess an unrelated feature branch as base", async () => {
  const { cwd, git } = repository();
  git("branch", "-m", "feature");
  assert.equal(await detectBase(cwd), null);
});

test("works in linked worktrees and subdirectories", async () => {
  const { cwd, git } = repository();
  const sibling = `${cwd}-linked`;
  directories.push(sibling);
  git("worktree", "add", "-b", "linked", sibling);
  mkdirSync(join(sibling, "nested"));
  assert.equal(await branchBaseline(join(sibling, "nested"), "main"), git("rev-parse", "main"));
});

test("recomputes the merge-base after a rebase", async () => {
  const { cwd, git } = repository();
  git("branch", "feature");
  writeFileSync(join(cwd, "file.txt"), "main moved\n");
  git("commit", "-am", "Advance main");
  git("checkout", "feature");
  const before = await branchBaseline(cwd, "main");
  git("rebase", "main");
  assert.notEqual(await branchBaseline(cwd, "main"), before);
});

test("rejects options, ranges, non-commit objects, and unresolved refs", async () => {
  const { cwd } = repository();
  for (const ref of ["--help", "", "main\n--help", "main..HEAD", "HEAD^{tree}", "absent"]) {
    await assert.rejects(resolveCommit(cwd, ref));
  }
});

test("reports missing HEAD and unrelated histories without changing Git state", async () => {
  const { cwd, git } = repository();
  git("checkout", "--orphan", "unrelated");
  await assert.rejects(branchBaseline(cwd, "main"));
  git("add", ".");
  git("commit", "-m", "Unrelated root");
  await assert.rejects(branchBaseline(cwd, "main"));
  assert.equal(git("branch", "--show-current"), "unrelated");
});

test("selects the extension's process, not another window in the same repo", () => {
  assert.equal(ownSessionId(JSON.stringify({ sessions: [
    { pid: 1, sessionId: "other" }, { pid: 2, sessionId: "ours" },
  ] }), 2), "ours");
});

test("fails closed when the session identity is missing or ambiguous", () => {
  for (const sessions of [[], [{ pid: 1, sessionId: "other" }], [
    { pid: 2, sessionId: "one" }, { pid: 2, sessionId: "two" },
  ]]) assert.throws(() => ownSessionId(JSON.stringify({ sessions }), 2));
});

test("reloads its own window through the running executable without a PATH lookup", async () => {
  const calls: string[][] = [];
  const executables: string[] = [];
  const run: RunCommand = async (file, args) => {
    calls.push(args);
    executables.push(file);
    return args[1] === "list"
      ? JSON.stringify({ sessions: [{ pid: 123, sessionId: "ours" }] })
      : JSON.stringify({ result: { sessionId: "ours" } });
  };
  await reloadReview("/repo", "HEAD", run, 123);
  assert.deepEqual(executables, [process.execPath, process.execPath]);
  assert.deepEqual(calls[1], ["session", "reload", "ours", "--json", "--", "diff", "HEAD"]);
});

test("checks the reload acknowledgement and propagates failures", async () => {
  const list = JSON.stringify({ sessions: [{ pid: 123, sessionId: "ours" }] });
  await assert.rejects(reloadReview("/repo", "HEAD", async (_file, args) => args[1] === "list" ? list : "{}", 123));
  await assert.rejects(reloadReview("/repo", "HEAD", async () => { throw new Error("Offline"); }, 123), /Offline/);
});

test("subprocess errors use captured stderr rather than writing into the TUI", async () => {
  await assert.rejects(runCommand("git", ["not-a-real-command"], tmpdir()), /not-a-real-command/);
});
