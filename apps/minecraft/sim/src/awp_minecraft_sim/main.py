"""NDJSON over stdio. One request per line in, one reply per line out, in order:

    {"id": 1, "op": "hello"}                                   -> {"id": 1, "ok": true, "version": "...", "initial_states": [...]}
    {"id": 2, "op": "reset", "initial_state": "plains_day"}    -> {"id": 2, "ok": true, "frame_b64": "...", "info": {...}}
    {"id": 3, "op": "step", "device_state": {...}}             -> {"id": 3, "ok": true, "frame_b64": "...", "info": {...}}
    {"id": 4, "op": "close"}                                   -> {"id": 4, "ok": true}

A failed request answers {"id", "ok": false, "error"}. One step is one game tick (50 ms of game time).
Only replies go to stdout; everything else, MineStudio's output included, goes to stderr.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any

from . import __version__


def main() -> None:
    replies = os.fdopen(os.dup(1), "w", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    from . import render
    from .stage import INITIAL_STATES, Stage

    mode = render.setup()
    print(f"awp-minecraft-sim {__version__}: rendering with {mode}", file=sys.stderr, flush=True)
    stage = Stage(seed=int(os.environ.get("AWP_MINECRAFT_SEED", "7")))

    def reply(message: dict[str, Any]) -> None:
        replies.write(json.dumps(message, separators=(",", ":")) + "\n")

    for line in sys.stdin:
        if not line.strip():
            continue
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            op = request.get("op")
            if op == "hello":
                out: dict[str, Any] = {"version": __version__, "initial_states": INITIAL_STATES, "render": mode}
            elif op == "reset":
                out = stage.reset(request["initial_state"])
            elif op == "step":
                out = stage.step(request["device_state"])
            elif op == "close":
                stage.close()
                reply({"id": request.get("id"), "ok": True})
                return
            else:
                raise ValueError(f"unknown op {op!r}")
            reply({"id": request.get("id"), "ok": True, **out})
        except Exception as exc:  # the world decides what a failure means
            traceback.print_exc(file=sys.stderr)
            reply({"id": request.get("id"), "ok": False, "error": f"{type(exc).__name__}: {exc}"})
    stage.close()


if __name__ == "__main__":
    main()
