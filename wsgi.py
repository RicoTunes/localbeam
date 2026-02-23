"""
WSGI entry point for cloud deployment (Railway, Render, etc.)

Initialises the app without local-only features:
  - no Windows firewall rules
  - no raw-socket fast-transfer server  (cloud doesn't allow arbitrary TCP ports)
  - no filesystem file-watcher
Everything else (upload, download, browse, QR) works normally.
"""
import os
from pathlib import Path

# ── Set globals BEFORE any Flask route is hit ──────────────────────────────
import app as _server

# Shared directory: use UPLOAD_DIR env var or fall back to ./uploads
uploads_dir = os.environ.get('UPLOAD_DIR', str(Path(__file__).parent / 'uploads'))
os.makedirs(uploads_dir, exist_ok=True)

_server.shared_directory   = uploads_dir
_server.fast_transfer_port = None          # raw TCP not available on cloud
_server.is_running         = True

# Re-export the Flask app object for gunicorn
app = _server.app
