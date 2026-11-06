#!/usr/bin/env python3
"""Exercise the installed Hunk binary in a private PTY, never the user's terminal."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

EXTENSION = Path(__file__).resolve().parent.parent
search_path = os.pathsep.join(
    entry for entry in os.environ.get("PATH", "").split(os.pathsep)
    if Path(entry).resolve() != EXTENSION / "node_modules" / ".bin"
)
HUNK = shutil.which("hunk", path=search_path)
if HUNK is None:
    raise RuntimeError("The test runner needs hunk on PATH")


def sessions():
    result = subprocess.run([HUNK, "session", "list", "--json"], capture_output=True, text=True, check=True, timeout=10)
    return json.loads(result.stdout)["sessions"]


with tempfile.TemporaryDirectory(prefix="hunk-toggle-pty-") as directory:
    cwd = Path(directory)

    def git(*args):
        return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()

    git("init", "-b", "main")
    git("config", "user.name", "Toggle Test")
    git("config", "user.email", "toggle@example.test")
    git("config", "commit.gpgsign", "false")
    (cwd / "tracked.txt").write_text("initial\n")
    (cwd / "staged.txt").write_text("initial\n")
    git("add", ".")
    git("commit", "-m", "Initial")
    git("checkout", "-b", "feature")
    (cwd / "committed.txt").write_text("committed on branch\n")
    git("add", ".")
    git("commit", "-m", "Feature")
    (cwd / "staged.txt").write_text("staged edit\n")
    git("add", "staged.txt")
    (cwd / "tracked.txt").write_text("unstaged edit\n")
    (cwd / "untracked.txt").write_text("untracked file\n")
    original_status = git("status", "--porcelain")
    neighbors = {s["sessionId"]: s["title"] for s in sessions()}

    pid, master = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.environ["TERM"] = "xterm-256color"
        args = [HUNK, "diff", "HEAD"]
        if "--global-install" not in sys.argv:
            args.extend(["--extension", str(EXTENSION)])
        if "--without-hunk-on-path" in sys.argv:
            os.environ["PATH"] = "/usr/bin:/bin"
            assert shutil.which("hunk") is None
        os.execv(HUNK, args)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    output = bytearray()

    def drain():
        while select.select([master], [], [], 0)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            if not data:
                return
            output.extend(data)

    def screen_text():
        # OpenTUI paints changed cells, so concatenated output is not a screenshot.
        rows = [[" "] * 140 for _ in range(40)]
        row, column = 0, 0
        tokens = re.finditer(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.|[^\x1b]", output.decode(errors="replace"), re.S)
        for token in tokens:
            value = token.group()
            if value.startswith("\x1b["):
                params = value[2:-1]
                if value[-1] in "Hf" and not params.startswith("?"):
                    parts = params.split(";")
                    row = int(parts[0] or "1") - 1
                    column = int(parts[1] or "1") - 1 if len(parts) > 1 else 0
                elif value[-1] == "J" and params == "2":
                    rows = [[" "] * 140 for _ in range(40)]
                elif value[-1] == "K" and 0 <= row < 40:
                    start = 0 if params == "2" else column
                    rows[row][start:] = [" "] * (140 - start)
            elif value.startswith("\x1b"):
                continue
            elif value == "\r":
                column = 0
            elif value == "\n":
                row += 1
            elif value.isprintable():
                if 0 <= row < 40 and 0 <= column < 140:
                    rows[row][column] = value
                column += 1
        return "\n".join("".join(row) for row in rows)

    def wait_for(paths, label):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            drain()
            own = [s for s in sessions() if s["pid"] == pid]
            if len(own) == 1:
                actual = {f["path"] for f in own[0]["files"]}
                if actual == paths and label in screen_text():
                    return own[0]
            time.sleep(0.15)
        raise AssertionError(f"Timed out waiting for {paths} and {label!r}. Terminal tail:\n{output[-6000:].decode(errors='replace')}")

    reaped = False
    try:
        uncommitted = {"tracked.txt", "staged.txt", "untracked.txt"}
        initial = wait_for(uncommitted, "Original diff")
        os.write(master, b"B")
        branch = wait_for(uncommitted | {"committed.txt"}, "Branch vs main")
        os.write(master, b"B")
        final = wait_for(uncommitted, "Uncommitted")
        assert initial["sessionId"] == branch["sessionId"] == final["sessionId"]
        assert git("status", "--porcelain") == original_status
        current = {s["sessionId"]: s["title"] for s in sessions()}
        assert all(current.get(id) == title for id, title in neighbors.items())
        print("PASS: real Hunk PTY toggle includes staged/unstaged/untracked changes; branch adds committed changes; same session; Git and other windows untouched.")
    finally:
        os.write(master, b"q")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            drain()
            if os.waitpid(pid, os.WNOHANG)[0] == pid:
                reaped = True
                break
            time.sleep(0.05)
        if not reaped:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        os.close(master)
