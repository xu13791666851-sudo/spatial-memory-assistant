"""Launch loopback only; allow project-scoped connection dependency."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "python-deps"))
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8765, access_log=False, log_level="warning", ws="websockets")
