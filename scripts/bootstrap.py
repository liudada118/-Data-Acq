"""Install local dependencies and build the desktop acquisition workstation."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd=ROOT):
    print(" > " + " ".join(map(str, args)), flush=True)
    subprocess.run([str(item) for item in args], cwd=cwd, check=True)


def main():
    for program in ("node", "cmake"):
        if not shutil.which(program):
            raise SystemExit(f"Missing {program}. Install Node.js 22.12+ and CMake 3.24+ first.")
    local_python = ROOT / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
    if not local_python.is_file():
        venv.EnvBuilder(with_pip=True).create(ROOT / ".venv")
    run([local_python, "-m", "pip", "install", "-r", ROOT / "requirements.txt",
         "-r", ROOT / "requirements-desktop.txt"])
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        raise SystemExit("npm was not found alongside Node.js.")
    run([npm, "ci"], ROOT / "frontend")
    run([npm, "run", "build"], ROOT / "frontend")
    configure = ["cmake", "-S", ROOT, "-B", ROOT / "build"]
    if os.name == "nt":
        configure.extend(["-G", "Visual Studio 17 2022", "-A", "x64"])
    else:
        configure.append("-DCMAKE_BUILD_TYPE=Release")
    run(configure)
    run(["cmake", "--build", ROOT / "build", "--config", "Release", "--parallel"])
    print("\nReady. Launch with: .venv\\Scripts\\python.exe desktop\\launch.py", flush=True)


if __name__ == "__main__":
    main()
