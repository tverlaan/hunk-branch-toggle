import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionStatusLineControls,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import { branchBaseline, detectBase, reloadReview, resolveCommit, runCommand, type RunCommand } from "./review.ts";

type Mode = "original" | "uncommitted" | "branch";

export default function branchToggle(hunk: HunkExtensionAPI, run: RunCommand = runCommand, pid = process.pid) {
  let mode: Mode = "original";
  let base = typeof hunk.config.base_ref === "string" ? hunk.config.base_ref : null;
  let busy = false;
  let live: (ExtensionContext & { statusLine: ExtensionStatusLineControls }) | null = null;

  function paint() {
    const baseLabel = base?.replace(/^refs\/(?:remotes|heads)\//, "");
    const label = mode === "branch" ? `Branch vs ${baseLabel}` : mode === "uncommitted" ? "Uncommitted" : "Original diff";
    live?.statusLine.set({
      id: "mode",
      spans: [{ text: busy ? `${label} · switching…` : label, tone: "accent" }],
      priority: 10,
    });
  }

  hunk.on("changeset_loaded", (_event, ctx) => {
    live = ctx;
    paint();
  });
  hunk.on("session_reload", (event, ctx) => {
    live = ctx;
    // External comparisons must not inherit a label that describes a different baseline.
    if (event.reason === "daemon") mode = "original";
    paint();
  });
  hunk.on("shutdown", () => { live = null; });

  async function changeMode(ctx: ExtensionCommandContext, next: "branch" | "uncommitted", nextBase = base) {
    let baseline = "HEAD";
    if (next === "branch") {
      nextBase ??= await detectBase(ctx.cwd, run);
      if (nextBase === null) {
        nextBase = await ctx.dialogs.input({ title: "Base branch", placeholder: "main, origin/main, or a commit" });
        if (nextBase === null) return;
      }
      nextBase = nextBase.trim();
      baseline = await branchBaseline(ctx.cwd, nextBase, run);
    } else {
      await resolveCommit(ctx.cwd, "HEAD", run);
    }
    await reloadReview(ctx.cwd, baseline, run, pid);
    mode = next;
    base = nextBase;
    paint();
  }

  function command(
    id: string,
    title: string,
    action: (ctx: ExtensionCommandContext) => Promise<void>,
    key?: string,
  ) {
    hunk.registerCommand({ id, title, ...(key ? { key } : {}) }, async (ctx) => {
      if (busy) return;
      busy = true;
      paint();
      try {
        await action(ctx);
      } catch (error) {
        (live ?? ctx).notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        busy = false;
        paint();
      }
    });
  }

  command("toggle", "Toggle uncommitted / branch diff", (ctx) => changeMode(ctx, mode === "branch" ? "uncommitted" : "branch"), "B");
  command("uncommitted", "Show all uncommitted changes", (ctx) => changeMode(ctx, "uncommitted"));
  command("branch", "Show committed + uncommitted branch changes", (ctx) => changeMode(ctx, "branch"));
  command("base", "Choose base branch…", async (ctx) => {
    const value = await ctx.dialogs.input({
      title: "Base branch",
      placeholder: "main, origin/main, or a commit",
      initial: base ?? (await detectBase(ctx.cwd, run)) ?? "",
    });
    if (value === null) return;
    const candidate = value.trim();
    await branchBaseline(ctx.cwd, candidate, run);
    if (mode === "branch") {
      await changeMode(ctx, "branch", candidate);
    } else {
      base = candidate;
      ctx.notify(`Branch diff base: ${base}`);
    }
  });
}
