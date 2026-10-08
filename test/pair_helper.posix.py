"""Exercise the macOS/Linux helper with a pseudo-terminal and a fake Node binary.

No network, real credentials, or T3 processes are used.
"""
import errno
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import time


def check(exit_code):
    with tempfile.TemporaryDirectory(prefix="t3 helper test ") as temp:
        root = Path(temp)
        scripts = root / "checkout with spaces" / "scripts"
        scripts.mkdir(parents=True)
        helper = scripts / "pair.sh"
        shutil.copyfile(Path(__file__).resolve().parents[1] / "scripts" / "pair.sh", helper)
        fake_node = root / "node"
        fake_node.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$PAIR_TEST_ARGS"\ncat > "$PAIR_TEST_INPUT"\nexit "$PAIR_TEST_EXIT"\n')
        fake_node.chmod(0o700)
        env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"],
                   PAIR_TEST_ARGS=str(root / "args"), PAIR_TEST_INPUT=str(root / "input"),
                   PAIR_TEST_EXIT=str(exit_code))
        master, slave = pty.openpty()
        child = subprocess.Popen(["bash", str(helper)], stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        output = b""
        sent = False
        secret = b"http://localhost/pair#token=fake-private-helper-test"
        deadline = time.monotonic() + 10
        try:
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], 0.1)
                if not ready:
                    continue
                try:
                    chunk = os.read(master, 4096)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                output += chunk
                if b"(hidden): " in output and not sent:
                    # Wait until read -s has disabled echo; the prompt precedes read.
                    import termios
                    while termios.tcgetattr(master)[3] & termios.ECHO:
                        if time.monotonic() >= deadline:
                            raise AssertionError("Input echo was not disabled")
                        time.sleep(0.01)
                    os.write(master, secret + b"\n")
                    sent = True
            assert sent, "Missing hidden-input prompt"
            assert child.wait(timeout=2) == exit_code, "Exit status was not propagated"
            assert secret not in output, "Pairing secret was echoed"
            assert (root / "input").read_bytes() == secret + b"\n"
            assert (root / "args").read_text().splitlines() == [str(scripts / "../dist/cli.js"), "pair", "--stdin"]
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)


check(0)
check(7)
print("POSIX pairing helper: hidden input, spaced paths, stdin and failure propagation passed")
