"""One Minecraft game behind the world: launched once, then reset to an initial state by commands."""

from __future__ import annotations

import base64
import hashlib
import math
import random
from typing import Any

import cv2
import numpy as np

from .keymap import env_action, hotbar_slot

JPEG_QUALITY = 80
SETTLE = 40  # ticks after each command phase, so commands, chunk loads and light updates land
STABLE = 20  # identical idle frames that mark a settled stage
MAX_SETTLE = 800

COMMON = [
    "/gamerule sendCommandFeedback false",
    "/gamerule doImmediateRespawn true",
    "/gamerule doDaylightCycle false",
    "/gamerule doWeatherCycle false",
    "/time set 1000",
    "/weather clear",
    "/kill @e[type=!player]",
    "/clear @p",
    "/effect clear @p",
    "/effect give @p minecraft:instant_health 1 10 true",
    "/effect give @p minecraft:saturation 1 10 true",
]

# The conformance stage: a closed room at y = 200, open to the sky. Nothing outside it reaches the frame,
# there are no mobs and no random ticks, and it is lit by sky light only (block light flickers randomly).
ROOM_RULES = [
    "/gamerule doMobSpawning false",
    "/gamerule randomTickSpeed 0",
    "/gamerule doFireTick false",
    "/gamerule mobGriefing false",
    "/time set 6000",
    "/forceload add -16 -16 15 15",
]
ROOM = [
    "/fill -8 199 -8 8 207 8 minecraft:white_concrete hollow",
    "/fill -7 207 -7 7 207 7 minecraft:air",
    "/fill -7 200 7 -5 203 7 minecraft:red_wool",
    "/fill 5 200 7 7 203 7 minecraft:blue_wool",
    "/fill 7 200 -2 7 202 2 minecraft:green_wool",
    "/fill -7 200 -2 -7 202 2 minecraft:yellow_wool",
    "/fill -1 200 3 1 200 4 minecraft:oak_log",
    "/kill @e[type=!player]",
    "/tp @p 0.5 200 0.5 0 0",
]

LIVE_RULES = ["/gamerule doMobSpawning true", "/gamerule randomTickSpeed 3", "/gamerule mobGriefing true"]
BIOMES = {"plains_day": "plains", "forest_wood": "forest"}
INITIAL_STATES = ["plains_day", "forest_wood", "conformance_room"]


class Stage:
    def __init__(self, seed: int = 7) -> None:
        self.seed = seed
        self.sim: Any = None
        self.state: str | None = None
        self.selected = 1
        self.rng = random.Random(seed)

    def _launch(self) -> None:
        from minestudio.simulator.entry import MinecraftSim

        sim = MinecraftSim(action_type="env", obs_size=(640, 360), render_size=(640, 360), seed=self.seed, callbacks=[])
        sim.reset()  # the one hard reset: the game generates its world
        self.sim = sim

    def _noop(self) -> dict[str, Any]:
        return self.sim.env.action_space.no_op()

    def _tick(self, action: dict[str, Any] | None = None) -> dict[str, Any]:
        _, _, _, _, info = self.sim.step(action if action is not None else self._noop())
        return info

    def _commands(self, commands: list[str]) -> None:
        for c in commands:
            self.sim.env.execute_cmd(c)

    def _settle(self, ticks: int) -> dict[str, Any]:
        first = self._noop()
        first["hotbar.1"] = 1  # every reset starts with the first hotbar slot selected
        info = self._tick(first)
        for _ in range(ticks - 1):
            info = self._tick()
        self.selected = 1
        return info

    def _settle_until_still(self) -> dict[str, Any]:
        """Idle until the frame stops changing: the fog colour blends over wall-clock seconds after a biome change."""
        info = self._settle(SETTLE)
        last, same = None, 0
        for _ in range(MAX_SETTLE):
            digest = hashlib.sha256(np.ascontiguousarray(info["pov"]).tobytes()).digest()
            same = same + 1 if digest == last else 0
            if same >= STABLE:
                break
            last = digest
            info = self._tick()
        return info

    def reset(self, initial_state: str) -> dict[str, Any]:
        if initial_state not in INITIAL_STATES:
            raise ValueError(f"no initial state {initial_state}")
        if self.sim is None:
            self._launch()
        self._commands(COMMON)
        if initial_state == "conformance_room":
            self._commands(ROOM_RULES)
            self._settle(SETTLE)
            self._commands(ROOM)
            info = self._settle(SETTLE) if self.state == "conformance_room" else self._settle_until_still()
        else:
            x, z = self.rng.randrange(-20000, 20000), self.rng.randrange(-20000, 20000)
            self._commands([*LIVE_RULES, f"/teleportbiome @a {BIOMES[initial_state]} {x} ~0 {z}"])
            info = self._settle(SETTLE * 2)
        self.state = initial_state
        return self._result(info)

    def step(self, device_state: dict[str, Any]) -> dict[str, Any]:
        if self.sim is None:
            raise RuntimeError("reset first")
        info = self._tick(env_action(self._noop(), device_state))
        slot = hotbar_slot(device_state)
        if slot is not None:
            self.selected = slot
        return self._result(info)

    def close(self) -> None:
        if self.sim is not None:
            self.sim.close()
            self.sim = None

    def _result(self, info: dict[str, Any]) -> dict[str, Any]:
        bgr = cv2.cvtColor(info["pov"], cv2.COLOR_RGB2BGR)
        ok, jpeg = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if not ok:
            raise RuntimeError("JPEG encoding failed")
        return {"frame_b64": base64.b64encode(jpeg.tobytes()).decode("ascii"), "info": summarize(info, self.selected)}


def plain(value: Any) -> Any:
    """JSON-ready: numpy scalars and arrays to Python values."""
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, np.ndarray):
        return plain(value.tolist())
    if isinstance(value, np.generic):
        return value.item()
    return value


def counts(stat: Any) -> dict[str, int]:
    """A MineRL statistic (item to count), without zeros."""
    out: dict[str, int] = {}
    for k, v in (plain(stat) or {}).items():
        if isinstance(v, (int, float)) and v:
            out[k] = int(v)
    return out


def wrap_degrees(a: float) -> float:
    return (a + 180.0) % 360.0 - 180.0


def summarize(info: dict[str, Any], selected: int) -> dict[str, Any]:
    pos = plain(info.get("player_pos", {}))
    stats = plain(info.get("location_stats", {}))
    inventory = [
        {"slot": int(k), "type": v["type"], "quantity": int(v["quantity"])}
        for k, v in plain(info.get("inventory", {})).items()
        if v.get("type") not in ("none", "air") and int(v.get("quantity", 0)) > 0
    ]
    yaw = wrap_degrees(float(pos.get("yaw", 0.0)))
    return {
        "health": round(float(plain(info.get("health", 0.0))), 2),
        "food": int(plain(info.get("food_level", 0))),
        "pos": {
            "x": round(float(pos.get("x", 0.0)), 4),
            "y": round(float(pos.get("y", 0.0)), 4),
            "z": round(float(pos.get("z", 0.0)), 4),
            "pitch": round(float(pos.get("pitch", 0.0)), 3),
            "yaw": round(yaw if math.isfinite(yaw) else 0.0, 3),
        },
        "selected_slot": selected,
        "inventory": sorted(inventory, key=lambda i: i["slot"]),
        "mainhand": plain(info.get("equipped_items", {})).get("mainhand", {}).get("type", "air"),
        "light": int(stats.get("light_level", 0) or 0),
        "sky": bool(stats.get("can_see_sky", False)),
        "gui_open": bool(plain(info.get("isGuiOpen", False))),
        "mined": counts(info.get("mine_block")),
        "picked_up": counts(info.get("pickup")),
        "crafted": counts(info.get("craft_item")),
        "killed": counts(info.get("kill_entity")),
    }
