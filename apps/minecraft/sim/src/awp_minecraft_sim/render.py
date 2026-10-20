"""Where Minecraft renders. MineStudio launches the game through `xvfb-run` (CPU) or `vglrun` (GPU)."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

# On WSL the game renders straight onto the WSLg display through Mesa's d3d12 driver, on the GPU.
# MineStudio always wraps the CPU path in xvfb-run, so a stand-in of that name runs the game directly.
WSLG_SHIM = """#!/bin/bash
[ "$1" = "-a" ] && shift
export DISPLAY=${DISPLAY:-:0} GALLIUM_DRIVER=${GALLIUM_DRIVER:-d3d12}
export MESA_D3D12_DEFAULT_ADAPTER_NAME=${MESA_D3D12_DEFAULT_ADAPTER_NAME:-NVIDIA}
exec "$@"
"""

# Game options for every instance: no tutorial toast, chat invisible but still usable for commands
# (hiding it outright disables commands), no view bobbing, clouds, or particles, so frames depend only
# on world state.
OPTIONS = {
    "tutorialStep": "none",
    "chatOpacity": "0.0",
    "textBackgroundOpacity": "0.0",
    "chatScale": "0.0",
    "bobView": "false",
    "renderClouds": '"false"',
    "particles": "2",
    "entityShadows": "false",
}


def default_mode() -> str:
    try:
        return "wslg" if "microsoft" in Path("/proc/version").read_text().lower() else "xvfb"
    except OSError:
        return "xvfb"


def setup() -> str:
    """Prepare the environment MineStudio launches the game in. Returns the rendering mode."""
    mode = os.environ.get("AWP_MINECRAFT_RENDER") or default_mode()
    home = Path(os.environ.setdefault("MINESTUDIO_DIR", str(Path.home() / ".minestudio")))
    runtime = home / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / "options.txt").write_text("".join(f"{k}:{v}\n" for k, v in OPTIONS.items()))
    if mode == "wslg":
        bin_dir = Path(tempfile.mkdtemp(prefix="awp-minecraft-"))
        shim = bin_dir / "xvfb-run"
        shim.write_text(WSLG_SHIM)
        shim.chmod(0o755)
        os.environ["PATH"] = f"{bin_dir}:{os.environ['PATH']}"
    elif mode == "vgl":
        os.environ["MINESTUDIO_GPU_RENDER"] = "1"
    elif mode == "xvfb" and shutil.which("xvfb-run") is None:
        raise RuntimeError("AWP_MINECRAFT_RENDER=xvfb needs xvfb-run (apt install xvfb)")
    if shutil.which("java") is None:
        raise RuntimeError("Minecraft needs Java 8 on PATH (JAVA_HOME/bin)")
    return mode
