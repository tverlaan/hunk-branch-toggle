import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionCommand,
  ExtensionCommandContext,
  ExtensionCommandHandler,
  ExtensionEventContext,
  ExtensionEventHandler,
  ExtensionEventName,
  ExtensionEventPayloads,
  ExtensionStatusItem,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import branchToggle from "../index.ts";
import type { RunCommand } from "../review.ts";

const head = "a".repeat(40);
const ancestor = "b".repeat(40);

function harness(options: { base?: string; noBase?: boolean; failReload?: boolean; input?: string | null } = {}) {
  const commands = new Map<string, { command: ExtensionCommand; handler: ExtensionCommandHandler }>();
  const events = new Map<ExtensionEventName, ExtensionEventHandler>();
  const reloads: string[] = [];
  const notices: string[] = [];
  let status = "";
  let input = options.input ?? null;
  let retired = false;

  function context() {
    let expired = false;
    const ctx = {
      cwd: "/repo",
      notify(message: string) { notices.push(message); },
      statusLine: {
        set(item: ExtensionStatusItem) {
          if (expired) throw new Error("Expired status controls used after reload");
          status = item.spans.map((span) => span.text).join("");
        },
      },
      dialogs: { async input() { const answer = input; input = null; return answer; } },
    };
    return { ctx, expire() { expired = true; } };
  }

  let current = context();
  function emit<E extends ExtensionEventName>(name: E, event: ExtensionEventPayloads[E]) {
    return events.get(name)?.(event, current.ctx as unknown as ExtensionEventContext);
  }
  const run: RunCommand = async (file, args) => {
    if (file === "git") {
      if (args[0] === "symbolic-ref") {
        if (options.noBase) throw new Error("No default");
        return "refs/remotes/origin/main\n";
      }
      if (args[0] === "rev-parse") {
        if (options.noBase && args.at(-1) !== "HEAD^{commit}" && args.at(-1) !== "develop^{commit}") throw new Error("Unknown ref");
        return head;
      }
      if (args[0] === "merge-base") return ancestor;
      throw new Error(`Unexpected git call ${args}`);
    }
    if (args[1] === "list") return JSON.stringify({ sessions: [{ pid: 12, sessionId: "ours" }] });
    if (options.failReload) throw new Error("Reload failed");
    reloads.push(args.at(-1)!);
    current.expire();
    current = context();
    await emit("changeset_loaded", { changeset: { id: "diff", title: "diff", sourceLabel: "/repo", files: [] } });
    await emit("session_reload", { reason: "daemon", changeset: { id: "diff", title: "diff", sourceLabel: "/repo", files: [] } });
    return JSON.stringify({ result: { sessionId: "ours" } });
  };
  const api = {
    config: options.base ? { base_ref: options.base } : {},
    on(name: ExtensionEventName, handler: ExtensionEventHandler) { events.set(name, handler); },
    registerCommand(command: ExtensionCommand, handler: ExtensionCommandHandler) { commands.set(command.id, { command, handler }); },
  } as unknown as HunkExtensionAPI;
  branchToggle(api, run, 12);
  void emit("changeset_loaded", { changeset: { id: "diff", title: "diff", sourceLabel: "/repo", files: [] } });
  return {
    commands, reloads, notices, emit,
    get status() { return status; },
    async invoke(id: string) {
      assert.equal(retired, false);
      await commands.get(id)!.handler(current.ctx as unknown as ExtensionCommandContext);
    },
    async shutdown() { retired = true; await emit("shutdown", {}); },
  };
}

test("registers B and leaves the initial review untouched and honestly labelled", () => {
  const h = harness();
  assert.equal(h.commands.get("toggle")!.command.key, "B");
  assert.deepEqual(h.reloads, []);
  assert.equal(h.status, "Original diff");
});

test("cycles branch to all uncommitted and survives expired reload contexts", async () => {
  const h = harness();
  await h.invoke("toggle");
  assert.deepEqual(h.reloads, [ancestor]);
  assert.equal(h.status, "Branch vs origin/main");
  await h.invoke("toggle");
  assert.deepEqual(h.reloads, [ancestor, "HEAD"]);
  assert.equal(h.status, "Uncommitted");
  assert.deepEqual(h.notices, []);
});

test("provides a direct all-uncommitted action", async () => {
  const h = harness();
  await h.invoke("uncommitted");
  assert.deepEqual(h.reloads, ["HEAD"]);
  assert.equal(h.status, "Uncommitted");
});

test("selecting a new base in branch mode reloads without losing the mode", async () => {
  const h = harness({ input: "develop" });
  await h.invoke("branch");
  await h.invoke("base");
  assert.equal(h.status, "Branch vs develop");
  assert.equal(h.reloads.length, 2);
});

test("base selection outside branch mode does not change the comparison", async () => {
  const h = harness({ input: "develop" });
  await h.invoke("base");
  assert.deepEqual(h.reloads, []);
  await h.invoke("toggle");
  assert.equal(h.status, "Branch vs develop");
});

test("asks for a base when detection is unavailable", async () => {
  const h = harness({ noBase: true, input: "develop" });
  await h.invoke("toggle");
  assert.equal(h.status, "Branch vs develop");
});

test("cancelling base selection leaves the current diff unchanged", async () => {
  const h = harness({ noBase: true });
  await h.invoke("toggle");
  assert.deepEqual(h.reloads, []);
  assert.equal(h.status, "Original diff");
});

test("reload failures do not claim a successful mode switch", async () => {
  const h = harness({ failReload: true });
  await h.invoke("toggle");
  assert.equal(h.status, "Original diff");
  assert.deepEqual(h.notices, ["Reload failed"]);
});

test("config cannot inject command options", async () => {
  const h = harness({ base: "--help" });
  await h.invoke("toggle");
  assert.deepEqual(h.reloads, []);
  assert.match(h.notices[0], /not an option/);
});

test("external comparison changes clear the label; watch refreshes retain it", async () => {
  const h = harness();
  await h.invoke("toggle");
  const changeset = { id: "diff", title: "diff", sourceLabel: "/repo", files: [] };
  await h.emit("session_reload", { reason: "watch", changeset });
  assert.equal(h.status, "Branch vs origin/main");
  await h.emit("session_reload", { reason: "daemon", changeset });
  assert.equal(h.status, "Original diff");
});

test("ignores overlapping toggles while a switch is in progress", async () => {
  const h = harness();
  await Promise.all([h.invoke("toggle"), h.invoke("toggle")]);
  assert.equal(h.reloads.length, 1);
});
