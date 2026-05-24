#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────
# MODE-S Meteo — RPi4 installation script
# Run as: bash install.sh
# Tested on: Raspberry Pi OS Bookworm 64-bit (Python 3.11)
# ──────────────────────────────────────────────────────────────────────────
set -e

INSTALL_DIR="/home/rspi22/modes_wind"
VENV_DIR="$INSTALL_DIR/venv"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  MODE-S Meteo — Installation"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── Python version check ──────────────────────────────────────────────────
PYTHON=$(which python3)
PY_VER=$($PYTHON -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo "Python version: $PY_VER"

if python3 -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)"; then
    echo "✓  Python $PY_VER — OK"
else
    echo "✗  Python 3.11+ required. Current: $PY_VER"
    echo "   On RPi OS Bookworm: sudo apt install python3.11"
    exit 1
fi

# ── Create virtual environment ────────────────────────────────────────────
echo ""
echo "Creating virtual environment in $VENV_DIR …"
python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"

# ── Upgrade pip ───────────────────────────────────────────────────────────
pip install --upgrade pip --quiet

# ── Install pyModeS v3 from PyPI ─────────────────────────────────────────
echo "Installing pyModeS v3 from PyPI …"
pip install "pyModeS>=3.0.0" --quiet

# ── Install Flask ─────────────────────────────────────────────────────────
echo "Installing Flask …"
pip install flask --quiet

# ── Create data and log directories ──────────────────────────────────────
mkdir -p "$INSTALL_DIR/data"
mkdir -p "$INSTALL_DIR/logs"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Installation complete!"
echo ""
echo "  To start the system:"
echo "    cd $INSTALL_DIR"
echo "    source venv/bin/activate"
echo "    python3 run.py"
echo ""
echo "  To run in background:"
echo "    source venv/bin/activate"
echo "    nohup python3 run.py > logs/modes_meteo.log 2>&1 &"
echo ""
echo "  Web interface: http://192.168.0.114:5010"
echo "  Username: admin  Password: admin123"
echo "═══════════════════════════════════════════════════════"
echo ""
