"""A WebSocket policy server: one JSON message in, one out, per request.

    {"type": "reset"}                                  -> {"type": "reset"}           VPT's memory starts over
    {"type": "config", "delay_ms": 300}                -> {"type": "config", ...}     added inference delay
    {"type": "act", "id": 7, "frame_b64": "<jpeg>"}    -> {"type": "slots", "id": 7, "slots": [...], "latency_ms": 9.1}

Each act answers one slot of device input in the world's input_chunk shape. VPT's recurrent memory lives
per connection, as one episode; the agent resets it on world.reset and when it opens a session.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import time
from typing import Any

import cv2
import numpy as np
import websockets

from .actions import Translator

DEFAULT_MODEL = "CraftJarvis/MineStudio_VPT.rl_from_early_game_2x"


class Policy:
    def __init__(self, repo: str, device: str) -> None:
        import torch
        from minestudio.models import VPTPolicy

        self.torch = torch
        self.model = VPTPolicy.from_pretrained(repo).to(device).eval()
        self.translator = Translator()

    def act(self, jpeg: bytes, state: Any) -> tuple[dict[str, Any], Any]:
        bgr = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        image = cv2.resize(rgb, (128, 128), interpolation=cv2.INTER_LINEAR)
        with self.torch.inference_mode():
            action, state = self.model.get_action({"image": image}, state, input_shape="*")
        return self.translator.slot(action), state


async def serve(policy: Policy, host: str, port: int) -> None:
    lock = asyncio.Lock()  # one GPU, one inference at a time

    async def session(ws: Any) -> None:
        state = None
        delay_ms = 0.0
        async for raw in ws:
            msg = json.loads(raw)
            kind = msg.get("type")
            if kind == "reset":
                state = None
                await ws.send(json.dumps({"type": "reset"}))
            elif kind == "config":
                delay_ms = max(0.0, float(msg.get("delay_ms", 0)))
                await ws.send(json.dumps({"type": "config", "delay_ms": delay_ms}))
            elif kind == "act":
                t0 = time.monotonic()
                async with lock:
                    slot, state = await asyncio.to_thread(policy.act, base64.b64decode(msg["frame_b64"]), state)
                if delay_ms:
                    await asyncio.sleep(delay_ms / 1000)
                latency = (time.monotonic() - t0) * 1000
                await ws.send(json.dumps({"type": "slots", "id": msg.get("id"), "slots": [slot], "latency_ms": round(latency, 1)}))
            else:
                await ws.send(json.dumps({"type": "error", "error": f"unknown type {kind!r}"}))

    async with websockets.serve(session, host, port, max_size=8 * 1024 * 1024):
        print(f"awp-minecraft-policy on ws://{host}:{port}", flush=True)
        await asyncio.Future()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--host", default=os.environ.get("AWP_POLICY_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("AWP_POLICY_PORT", "8716")))
    p.add_argument("--model", default=os.environ.get("AWP_POLICY_MODEL", DEFAULT_MODEL))
    p.add_argument("--device", default=os.environ.get("AWP_POLICY_DEVICE", "cuda"))
    args = p.parse_args()
    policy = Policy(args.model, args.device)
    asyncio.run(serve(policy, args.host, args.port))


if __name__ == "__main__":
    main()
