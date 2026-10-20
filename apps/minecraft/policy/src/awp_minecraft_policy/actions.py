"""VPT's actions as device input, through the keymap the sim sidecar shares."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import numpy as np

KEYMAP_PATH = Path(os.environ.get("AWP_MINECRAFT_KEYMAP", Path(__file__).resolve().parents[3] / "shared" / "keymap.json"))


class Translator:
    def __init__(self) -> None:
        from minestudio.simulator.entry import CameraConfig
        from minestudio.utils.vpt_lib.action_mapping import CameraHierarchicalMapping
        from minestudio.utils.vpt_lib.actions import ActionTransformer

        keymap = json.loads(KEYMAP_PATH.read_text())
        self.deg_per_count: float = keymap["deg_per_count"]
        self.keys = {action: key for key, action in keymap["keys"].items()}
        camera = CameraConfig()
        self.mapper = CameraHierarchicalMapping(n_camera_bins=camera.n_camera_bins)
        self.transformer = ActionTransformer(**camera.action_transformer_kwargs)

    def env_action(self, action: dict[str, Any]) -> dict[str, Any]:
        """VPT's sampled action (button and camera bins) as a MineRL env action."""
        acs = {k: (v.cpu().numpy() if hasattr(v, "cpu") else np.asarray(v)) for k, v in action.items()}
        return self.transformer.policy2env(self.mapper.to_factored(acs))

    def slot(self, action: dict[str, Any]) -> dict[str, Any]:
        """One input_chunk slot: the held keys, and the camera turn in mouse counts."""
        env = self.env_action(action)
        keys = [self.keys[name] for name, v in env.items() if name in self.keys and int(np.asarray(v).reshape(-1)[0]) == 1]
        pitch, yaw = (float(x) for x in np.asarray(env.get("camera", [0.0, 0.0])).reshape(-1)[:2])
        out: dict[str, Any] = {"keys": sorted(keys)}
        dx, dy = round(yaw / self.deg_per_count), round(pitch / self.deg_per_count)
        if dx:
            out["mouse_dx"] = dx
        if dy:
            out["mouse_dy"] = dy
        return out
