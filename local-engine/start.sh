#!/usr/bin/env bash
# StemSplit local engine: start it (and set it up on the first run).
# Usage:  bash start.sh
set -e
cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is missing. Install it first:  sudo apt install ffmpeg"
  exit 1
fi

# venv/.ready is only written after a complete setup, so an interrupted or failed setup is redone next time
if [ ! -f venv/.ready ]; then
  echo "First start: setting up (one-time, a few minutes)…"
  rm -rf venv
  if ! python3 -m venv venv; then
    rm -rf venv
    echo "Could not create a Python environment. Try:  sudo apt install python3-venv"
    exit 1
  fi
  ./venv/bin/pip install --upgrade pip -q
  if command -v nvidia-smi >/dev/null 2>&1; then
    echo "NVIDIA graphics card found: installing PyTorch with GPU support (large download, about 3 GB)…"
    ./venv/bin/pip install torch
  else
    echo "Installing PyTorch for CPU (about 200 MB)…"
    ./venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
  fi
  ./venv/bin/pip install demucs lameenc numpy
  touch venv/.ready
  echo "Setup done."
fi

# older setups missed numpy (Demucs needs it but doesn't declare it)
./venv/bin/python -c "import numpy" 2>/dev/null || ./venv/bin/pip install -q numpy

exec ./venv/bin/python stemsplit_local.py "$@"
