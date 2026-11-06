import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type RunCommand = (file: string, args: string[], cwd: string) => Promise<string>;

export const runCommand: RunCommand = async (file, args, cwd) => {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
};

export async function resolveCommit(cwd: string, ref: string, run = runCommand): Promise<string> {
  if (!ref || ref.startsWith("-") || /[\x00-\x20\x7f]/.test(ref)) {
    throw new Error("Enter a Git branch or commit, not an option or a range.");
  }
  const commit = (await run("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], cwd)).trim();
  if (!OBJECT_ID.test(commit)) throw new Error(`Cannot resolve a single commit for ${ref}.`);
  return commit;
}

export async function detectBase(cwd: string, run = runCommand): Promise<string | null> {
  try {
    const ref = (await run("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd)).trim();
    await resolveCommit(cwd, ref, run);
    return ref;
  } catch {
    // Local-only repositories and clones without origin/HEAD still have useful conventional bases.
  }
  for (const ref of ["refs/remotes/origin/main", "refs/heads/main", "refs/remotes/origin/master", "refs/heads/master"]) {
    try {
      await resolveCommit(cwd, ref, run);
      return ref;
    } catch {
      continue;
    }
  }
  return null;
}

export async function branchBaseline(cwd: string, base: string, run = runCommand): Promise<string> {
  const baseCommit = await resolveCommit(cwd, base, run);
  const head = await resolveCommit(cwd, "HEAD", run);
  const ancestor = (await run("git", ["merge-base", head, baseCommit], cwd)).trim();
  if (!OBJECT_ID.test(ancestor)) throw new Error(`No single common ancestor with ${base}.`);
  return ancestor;
}

export function ownSessionId(payload: string, pid: number): string {
  const parsed = JSON.parse(payload) as { sessions?: Array<{ pid: number; sessionId: string }> };
  const matches = parsed.sessions?.filter((session) => session.pid === pid) ?? [];
  if (matches.length !== 1 || typeof matches[0].sessionId !== "string" || !matches[0].sessionId) {
    throw new Error("Cannot identify this Hunk window uniquely. No review was changed.");
  }
  return matches[0].sessionId;
}

export async function reloadReview(
  cwd: string,
  baseline: string,
  run = runCommand,
  pid = process.pid,
): Promise<void> {
  const executable = process.execPath;
  const id = ownSessionId(await run(executable, ["session", "list", "--json"], cwd), pid);
  const output = await run(executable, ["session", "reload", id, "--json", "--", "diff", baseline], cwd);
  const response = JSON.parse(output) as { result?: { sessionId?: string } };
  if (response.result?.sessionId !== id) throw new Error("Hunk did not confirm the requested review reload.");
}
