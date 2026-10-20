"""Device state to MineRL env actions, through the keymap the policy server shares."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import numpy as np

KEYMAP_PATH = Path(os.environ.get("AWP_MINECRAFT_KEYMAP", Path(__file__).resolve().parents[3] / "shared" / "keymap.json"))
KEYMAP: dict[str, Any] = json.loads(KEYMAP_PATH.read_text())
KEYS: dict[str, str] = KEYMAP["keys"]
DEG_PER_COUNT: float = KEYMAP["deg_per_count"]
MAX_CAMERA_DEG: float = KEYMAP["max_camera_deg"]


def env_action(noop: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """The env action for one step of device state: held keys set their actions, mouse counts turn the camera."""
    action = dict(noop)
    for key in state.get("held", []):
        name = KEYS.get(key)
        if name is not None:
            action[name] = 1
    pitch = float(np.clip(state.get("mouse_dy", 0) * DEG_PER_COUNT, -MAX_CAMERA_DEG, MAX_CAMERA_DEG))
    yaw = float(np.clip(state.get("mouse_dx", 0) * DEG_PER_COUNT, -MAX_CAMERA_DEG, MAX_CAMERA_DEG))
    action["camera"] = np.array([pitch, yaw])
    return action


def hotbar_slot(state: dict[str, Any]) -> int | None:
    """The hotbar slot (1-9) a step selects, if a digit key went down in it."""
    for key in state.get("pressed", []):
        name = KEYS.get(key, "")
        if name.startswith("hotbar."):
            return int(name.split(".")[1])
    return None
