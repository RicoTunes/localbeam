#!/usr/bin/env python3
"""
Wireless File Transfer App - Xender-like file sharing between laptop and Android
Scan QR code with phone to connect and transfer files blazing fast
"""

import os
import sys
import socket
import socketserver
import socket as _socket
import mimetypes
import subprocess
import threading
import time
import json
import shutil
from urllib.parse import unquote
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
import qrcode
from io import BytesIO
import base64
import netifaces
import pyperclip
import webbrowser
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# ─────────────────────────────────────────────────────────────────
# FAST FILE SERVER — raw TCP socket HTTP handler
# Goes straight down to the OS socket layer:
#   • TCP_NODELAY  — disables Nagle, sends each chunk immediately
#   • SO_SNDBUF 8 MB — large kernel send buffer fills the WiFi pipe
#   • os.sendfile() — zero-copy kernel transfer (Linux/macOS)
#   • 4 MB buffered reads — Windows fallback, still maxes out WiFi
# Phones connect directly over LAN — no internet data used.
# ─────────────────────────────────────────────────────────────────

class _FastFileHandler(socketserver.StreamRequestHandler):
    CHUNK = 4 * 1024 * 1024  # 4 MB

    def handle(self):
        try:
            raw = b""
            while b"\r\n\r\n" not in raw:
                buf = self.request.recv(8192)
                if not buf:
                    return
                raw += buf
                if len(raw) > 65536:
                    return

            header_block = raw.split(b"\r\n\r\n")[0].decode("utf-8", errors="replace")
            lines = header_block.split("\r\n")
            if not lines:
                return

            parts = lines[0].split()
            if len(parts) < 2:
                return
            method = parts[0].upper()
            raw_path = unquote(parts[1])

            req_hdrs = {}
            for line in lines[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    req_hdrs[k.strip().lower()] = v.strip()

            # CORS preflight
            if method == "OPTIONS":
                self.request.sendall(
                    b"HTTP/1.1 204 No Content\r\n"
                    b"Access-Control-Allow-Origin: *\r\n"
                    b"Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
                    b"Access-Control-Allow-Headers: Range\r\n"
                    b"Connection: close\r\n\r\n"
                )
                return

            if method not in ("GET", "HEAD"):
                self._err(405, "Method Not Allowed")
                return

            # Resolve file path (supports relative names and absolute paths)
            fp = raw_path.lstrip("/")
            if len(fp) >= 2 and fp[1] == ":":          # Windows absolute path
                filepath = os.path.normpath(fp)
            elif os.path.isabs(fp):                     # Unix absolute path
                filepath = os.path.normpath(fp)
            else:                                       # relative to shared dir
                filepath = os.path.normpath(
                    os.path.join(self.server.shared_dir, fp)
                )

            # Security: must live under shared_dir OR user home
            shared_norm = os.path.normpath(self.server.shared_dir)
            home_norm   = os.path.normpath(str(Path.home()))
            if not (filepath.startswith(shared_norm) or
                    filepath.startswith(home_norm)):
                self._err(403, "Forbidden")
                return

            if not os.path.isfile(filepath):
                self._err(404, "Not Found")
                return

            file_size = os.path.getsize(filepath)
            mime, _   = mimetypes.guess_type(filepath)
            mime      = mime or "application/octet-stream"
            if filepath.lower().endswith(".apk"):
                mime = "application/vnd.android.package-archive"
            name = os.path.basename(filepath)

            # Range header support (required for reliable large-file downloads)
            range_hdr  = req_hdrs.get("range", "")
            byte_start, byte_end = 0, file_size - 1
            if range_hdr:
                try:
                    rng = range_hdr.replace("bytes=", "").split("-")
                    if rng[0]: byte_start = int(rng[0])
                    if len(rng) > 1 and rng[1]: byte_end = int(rng[1])
                except Exception:
                    pass
            length = byte_end - byte_start + 1
            status = "206 Partial Content" if range_hdr else "200 OK"

            # Encode filename safely for Content-Disposition
            safe_name = name.encode("ascii", "replace").decode()

            hdr = (
                f"HTTP/1.1 {status}\r\n"
                f"Content-Type: {mime}\r\n"
                f"Content-Length: {length}\r\n"
                f"Content-Disposition: attachment; filename=\"{safe_name}\"\r\n"
                f"Accept-Ranges: bytes\r\n"
                f"Access-Control-Allow-Origin: *\r\n"
                f"Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
                f"Access-Control-Expose-Headers: Content-Length, Content-Range\r\n"
                f"Cache-Control: no-cache\r\n"
                f"Connection: close\r\n"
            )
            if range_hdr:
                hdr += f"Content-Range: bytes {byte_start}-{byte_end}/{file_size}\r\n"
            hdr += "\r\n"
            self.request.sendall(hdr.encode())

            if method == "HEAD":
                return

            # ── Stream file as fast as the network allows ──
            with open(filepath, "rb") as f:
                f.seek(byte_start)
                remaining = length
                try:
                    # Zero-copy path — kernel copies directly from file to socket
                    out_fd = self.request.fileno()
                    in_fd  = f.fileno()
                    sent   = 0
                    while sent < length:
                        n = os.sendfile(
                            out_fd, in_fd,
                            byte_start + sent,
                            min(self.CHUNK, length - sent)
                        )
                        if n == 0:
                            break
                        sent += n
                except (AttributeError, OSError):
                    # Windows / fallback: large buffered reads
                    while remaining > 0:
                        data = f.read(min(self.CHUNK, remaining))
                        if not data:
                            break
                        self.request.sendall(data)
                        remaining -= len(data)

        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            pass

    def _err(self, code, msg):
        body = msg.encode()
        resp = (
            f"HTTP/1.1 {code} {msg}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Connection: close\r\n\r\n"
        ).encode() + body
        try:
            self.request.sendall(resp)
        except Exception:
            pass


class FastTransferServer(socketserver.ThreadingTCPServer):
    """Multithreaded raw-socket HTTP server for zero-overhead file transfer."""
    allow_reuse_address = True
    daemon_threads      = True

    def __init__(self, port, shared_dir):
        self.shared_dir = shared_dir
        super().__init__(("0.0.0.0", port), _FastFileHandler)

    def server_bind(self):
        # Maximize throughput at the socket level
        self.socket.setsockopt(_socket.SOL_SOCKET,   _socket.SO_REUSEADDR, 1)
        self.socket.setsockopt(_socket.SOL_SOCKET,   _socket.SO_SNDBUF,    8 * 1024 * 1024)
        self.socket.setsockopt(_socket.IPPROTO_TCP,  _socket.TCP_NODELAY,  1)
        super().server_bind()

app = Flask(__name__, static_folder='static', template_folder='templates')
CORS(app)

# Allow large file uploads (up to 500MB for APKs and large files)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

# Global variables
transfer_queue = []
active_transfers = {}
server_ip = None
server_port = 5000
fast_transfer_port = None
shared_directory = None
is_running = False
server_thread = None

def get_local_ip():
    """Get the local IP address of the machine"""
    try:
        # Try to get IP from active interfaces
        for interface in netifaces.interfaces():
            addrs = netifaces.ifaddresses(interface)
            if netifaces.AF_INET in addrs:
                for addr in addrs[netifaces.AF_INET]:
                    ip = addr['addr']
                    if ip != '127.0.0.1' and not ip.startswith('169.254'):
                        return ip
    except:
        pass
    
    # Fallback method
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"

def generate_qr_code_data():
    """Generate QR code data containing server URL — points to /browser for phone"""
    global server_ip, server_port
    if not server_ip:
        server_ip = get_local_ip()
    
    url = f"http://{server_ip}:{server_port}/browser"
    return url

def create_qr_code():
    """Create QR code image as base64 string"""
    url = generate_qr_code_data()
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=10,
        border=4,
    )
    qr.add_data(url)
    qr.make(fit=True)
    
    img = qr.make_image(fill_color="black", back_color="white")
    buffered = BytesIO()
    img.save(buffered, format="PNG")
    img_str = base64.b64encode(buffered.getvalue()).decode()
    return f"data:image/png;base64,{img_str}", url

class FileChangeHandler(FileSystemEventHandler):
    """Handler for file system changes in shared directory"""
    def on_created(self, event):
        if not event.is_directory:
            print(f"New file detected: {event.src_path}")

def start_file_watcher(directory):
    """Start watching the shared directory for new files"""
    event_handler = FileChangeHandler()
    observer = Observer()
    observer.schedule(event_handler, directory, recursive=True)
    observer.start()
    return observer

@app.errorhandler(413)
def request_entity_too_large(error):
    return jsonify({"error": "File too large. Maximum allowed size is 500MB."}), 413

@app.route('/')
def index():
    """Main page with QR code and file browser"""
    qr_code, url = create_qr_code()
    return render_template('index.html', qr_code=qr_code, server_url=url)

@app.route('/browser')
def browser():
    """File browser page for browsing laptop files"""
    return render_template('browser.html')

@app.route('/api/files')
def list_files():
    """API endpoint to list files in shared directory"""
    directory = request.args.get('directory', shared_directory)
    
    if not directory or not os.path.exists(directory):
        # Default to user's home directory if shared_directory not set
        directory = str(Path.home())
    
    files = []
    directories = []
    
    try:
        for item in os.listdir(directory):
            item_path = os.path.join(directory, item)
            if os.path.isfile(item_path):
                stats = os.stat(item_path)
                files.append({
                    "name": item,
                    "size": stats.st_size,
                    "modified": stats.st_mtime,
                    "path": item_path,
                    "is_dir": False,
                    "extension": os.path.splitext(item)[1].lower()
                })
            elif os.path.isdir(item_path):
                directories.append({
                    "name": item,
                    "path": item_path,
                    "is_dir": True
                })
    except Exception as e:
        return jsonify({"error": str(e), "files": [], "directories": [], "current_dir": directory})
    
    # Sort: directories first, then files
    directories.sort(key=lambda x: x['name'].lower())
    files.sort(key=lambda x: x['name'].lower())
    
    return jsonify({
        "files": files,
        "directories": directories,
        "current_dir": directory,
        "parent_dir": os.path.dirname(directory) if directory != os.path.dirname(directory) else None
    })

@app.route('/api/upload', methods=['POST'])
def upload_file():
    """API endpoint for uploading files from phone - streamed to avoid loading into memory"""
    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    if not shared_directory:
        return jsonify({"error": "Shared directory not set"}), 500

    try:
        filename = os.path.basename(file.filename)  # sanitize
        filepath = os.path.join(shared_directory, filename)
        # Stream in 1 MB chunks — prevents loading the whole APK into RAM
        chunk_size = 1 * 1024 * 1024
        with open(filepath, 'wb') as f:
            shutil.copyfileobj(file.stream, f, length=chunk_size)
        return jsonify({"success": True, "filename": filename, "size": os.path.getsize(filepath)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/download/<path:filename>')
def download_file(filename):
    """API endpoint for downloading files to phone - supports HTTP Range for large files"""
    from flask import Response, stream_with_context
    import mimetypes
    try:
        filepath = filename
        if not os.path.isabs(filepath):
            if not shared_directory:
                return jsonify({"error": "Shared directory not set"}), 404
            filepath = os.path.join(shared_directory, filepath)

        filepath = os.path.normpath(filepath)

        if not os.path.exists(filepath):
            return jsonify({"error": "File not found"}), 404
        if not os.path.isfile(filepath):
            return jsonify({"error": "Not a file"}), 400

        user_home = str(Path.home())
        if not filepath.startswith(user_home):
            return jsonify({"error": "Access denied"}), 403

        file_size = os.path.getsize(filepath)
        mime_type = mimetypes.guess_type(filepath)[0] or 'application/octet-stream'
        # Explicitly handle APK mime-type
        if filepath.lower().endswith('.apk'):
            mime_type = 'application/vnd.android.package-archive'

        range_header = request.headers.get('Range')
        chunk = 1 * 1024 * 1024  # 1 MB stream chunks

        if range_header:
            # Support partial content (Range requests) — required for reliable large downloads
            byte_start = 0
            byte_end = file_size - 1
            match = range_header.replace('bytes=', '').split('-')
            if match[0]:
                byte_start = int(match[0])
            if match[1]:
                byte_end = int(match[1])
            length = byte_end - byte_start + 1

            def generate_partial():
                with open(filepath, 'rb') as f:
                    f.seek(byte_start)
                    remaining = length
                    while remaining > 0:
                        data = f.read(min(chunk, remaining))
                        if not data:
                            break
                        remaining -= len(data)
                        yield data

            headers = {
                'Content-Range': f'bytes {byte_start}-{byte_end}/{file_size}',
                'Accept-Ranges': 'bytes',
                'Content-Length': str(length),
                'Content-Disposition': f'attachment; filename="{os.path.basename(filepath)}"',
                'Content-Type': mime_type,
            }
            return Response(stream_with_context(generate_partial()), 206, headers=headers)

        # Normal full-file streaming
        def generate_full():
            with open(filepath, 'rb') as f:
                while True:
                    data = f.read(chunk)
                    if not data:
                        break
                    yield data

        headers = {
            'Accept-Ranges': 'bytes',
            'Content-Length': str(file_size),
            'Content-Disposition': f'attachment; filename="{os.path.basename(filepath)}"',
            'Content-Type': mime_type,
        }
        return Response(stream_with_context(generate_full()), 200, headers=headers)

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/browse')
def browse_directory():
    """API endpoint to browse any directory on the laptop"""
    directory = request.args.get('path', '')
    
    if not directory:
        # Start from the shared directory (set via --directory), fall back to home
        directory = shared_directory or str(Path.home())
    
    # Security: on cloud only allow shared_directory; locally also allow user home
    user_home   = str(Path.home())
    directory   = os.path.normpath(directory)
    shared_norm = os.path.normpath(shared_directory) if shared_directory else None
    is_cloud    = bool(os.environ.get('RAILWAY_PUBLIC_DOMAIN') or os.environ.get('RENDER_EXTERNAL_URL'))

    in_shared = shared_norm and (
        directory == shared_norm or directory.startswith(shared_norm + os.sep)
    )
    in_home = directory.startswith(user_home)
    allowed = in_shared or (not is_cloud and in_home)
    if not allowed:
        return jsonify({"error": "Access denied"}), 403
    
    if not os.path.exists(directory) or not os.path.isdir(directory):
        return jsonify({"error": "Directory not found"}), 404
    
    files = []
    directories = []
    
    try:
        for item in os.listdir(directory):
            item_path = os.path.join(directory, item)
            try:
                if os.path.isfile(item_path):
                    stats = os.stat(item_path)
                    files.append({
                        "name": item,
                        "size": stats.st_size,
                        "modified": stats.st_mtime,
                        "path": item_path,
                        "is_dir": False,
                        "extension": os.path.splitext(item)[1].lower()
                    })
                elif os.path.isdir(item_path):
                    directories.append({
                        "name": item,
                        "path": item_path,
                        "is_dir": True
                    })
            except (OSError, PermissionError):
                # Skip files/directories we can't access
                continue
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
    # Sort: directories first, then files
    directories.sort(key=lambda x: x['name'].lower())
    files.sort(key=lambda x: x['name'].lower())
    
    # Get common directories
    common_dirs = []
    common_paths = [
        ("Desktop", os.path.join(user_home, "Desktop")),
        ("Downloads", os.path.join(user_home, "Downloads")),
        ("Documents", os.path.join(user_home, "Documents")),
        ("Pictures", os.path.join(user_home, "Pictures")),
        ("Music", os.path.join(user_home, "Music")),
        ("Videos", os.path.join(user_home, "Videos")),
    ]
    
    for name, path in common_paths:
        if os.path.exists(path):
            common_dirs.append({"name": name, "path": path, "is_dir": True})
    
    return jsonify({
        "files": files,
        "directories": directories,
        "common_dirs": common_dirs,
        "current_dir": directory,
        "parent_dir": os.path.dirname(directory) if directory != os.path.dirname(directory) else None,
        "user_home": user_home
    })

@app.route('/api/special_dirs')
def get_special_directories():
    """Get special directories (Desktop, Downloads, etc.)"""
    user_home = str(Path.home())
    
    special_dirs = []
    dirs = [
        ("Desktop", "Desktop"),
        ("Downloads", "Downloads"),
        ("Documents", "Documents"),
        ("Pictures", "Pictures"),
        ("Music", "Music"),
        ("Videos", "Videos"),
        ("Android APKs", "Downloads"),  # Common place for APK files
    ]
    
    for name, relative in dirs:
        path = os.path.join(user_home, relative)
        if os.path.exists(path):
            # Count files in directory
            file_count = 0
            try:
                for _ in os.listdir(path):
                    file_count += 1
            except:
                file_count = 0
            
            special_dirs.append({
                "name": name,
                "path": path,
                "file_count": file_count,
                "icon": get_dir_icon(name)
            })
    
    return jsonify({"special_dirs": special_dirs})

@app.route('/api/qr_test')
def qr_test():
    """Test endpoint for QR code generation"""
    qr_code, url = create_qr_code()
    # Return just the image
    from flask import Response
    import base64
    # Extract base64 data
    if qr_code.startswith('data:image/png;base64,'):
        img_data = qr_code.split(',')[1]
        img_bytes = base64.b64decode(img_data)
        return Response(img_bytes, mimetype='image/png')
    return "QR code error", 500

def get_dir_icon(dir_name):
    """Get appropriate icon for directory"""
    icons = {
        "Desktop": "desktop",
        "Downloads": "download",
        "Documents": "folder",
        "Pictures": "image",
        "Music": "music",
        "Videos": "video",
        "Android APKs": "android"
    }
    return icons.get(dir_name, "folder")

@app.route('/api/info')
def server_info():
    """Get server information — works locally (LAN) and on cloud (Railway/Render)"""
    # Detect cloud environment and use public hostname for QR code
    railway_domain = os.environ.get('RAILWAY_PUBLIC_DOMAIN')
    render_url     = os.environ.get('RENDER_EXTERNAL_URL', '').replace('https://', '').replace('http://', '')
    cloud_host = railway_domain or render_url

    if cloud_host:
        public_url   = f"https://{cloud_host}"
        browser_url  = f"https://{cloud_host}/browser"
        # Generate QR pointing to the public cloud URL
        q = qrcode.QRCode(version=1,
                          error_correction=qrcode.constants.ERROR_CORRECT_L,
                          box_size=10, border=4)
        q.add_data(browser_url)
        q.make(fit=True)
        img = q.make_image(fill_color="black", back_color="white")
        buf = BytesIO()
        img.save(buf, format="PNG")
        qr_b64 = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        return jsonify({
            "ip":          cloud_host,
            "port":        443,
            "fast_port":   None,
            "url":         public_url,
            "browser_url": browser_url,
            "directory":   shared_directory,
            "status":      "running",
            "qr_code":     qr_b64
        })

    qr_code, url = create_qr_code()
    return jsonify({
        "ip":          server_ip,
        "port":        server_port,
        "fast_port":   fast_transfer_port,
        "url":         url,
        "browser_url": f"http://{server_ip}:{server_port}/browser",
        "directory":   shared_directory,
        "status":      "running"
    })

@app.route('/api/set_directory', methods=['POST'])
def set_directory():
    """Set the shared directory"""
    global shared_directory
    data = request.json
    directory = data.get('directory', '')
    
    if not directory or not os.path.exists(directory):
        return jsonify({"error": "Directory does not exist"}), 400
    
    shared_directory = directory
    return jsonify({"success": True, "directory": directory})

@app.route('/api/clipboard', methods=['POST'])
def set_clipboard():
    """Set clipboard text from phone — runs in background thread to avoid blocking"""
    data = request.json
    text = data.get('text', '')

    def _copy():
        try:
            pyperclip.copy(text)
        except Exception:
            pass

    threading.Thread(target=_copy, daemon=True).start()
    return jsonify({"success": True})

def open_firewall_ports(port, fast_port):
    """Open firewall ports so phones on the same Wi-Fi can connect.
    Uses netsh (not New-NetFirewallRule) — profile=any works on Public WiFi too.
    Triggers one UAC popup; safe to call repeatedly."""
    if sys.platform != 'win32':
        return  # macOS/Linux don't block LAN inbound by default

    import tempfile
    # Use netsh — confirmed to set Profiles: Domain,Private,Public correctly
    script = (
        f"netsh advfirewall firewall delete rule name=\"WirelessTransfer-{port}\" 2>nul\n"
        f"netsh advfirewall firewall delete rule name=\"WirelessTransfer-{fast_port}\" 2>nul\n"
        f"netsh advfirewall firewall add rule name=\"WirelessTransfer-{port}\" "
        f"dir=in action=allow protocol=TCP localport={port} profile=any enable=yes\n"
        f"netsh advfirewall firewall add rule name=\"WirelessTransfer-{fast_port}\" "
        f"dir=in action=allow protocol=TCP localport={fast_port} profile=any enable=yes\n"
    )

    try:
        tmp = tempfile.NamedTemporaryFile(suffix='.bat', delete=False, mode='w')
        tmp.write(script)
        tmp.close()

        result = subprocess.run(
            [
                'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                '-Command',
                f"Start-Process cmd -Verb RunAs -Wait -ArgumentList '/c \"{tmp.name}\"'"
            ],
            capture_output=True, timeout=30
        )
        os.unlink(tmp.name)

        if result.returncode == 0:
            print(f"  Firewall: ports {port} + {fast_port} open on all profiles (Public/Private/Domain)")
        else:
            raise RuntimeError(result.stderr.decode(errors='replace').strip())
    except Exception as e:
        print(f"  Could not auto-add firewall rules: {e}")
        print(f"  -> Run setup_firewall.bat as Administrator to fix manually.")


def start_server(port=5000, directory=None):
    """Start the Flask server + raw-socket FastTransferServer"""
    global server_ip, server_port, fast_transfer_port, shared_directory, is_running

    server_ip   = get_local_ip()
    server_port = port
    fast_transfer_port = port + 1

    if directory:
        # Always resolve to absolute path so security checks work
        shared_directory = str(Path(directory).resolve())
    else:
        # Default to Downloads directory
        downloads = os.path.join(str(Path.home()), 'Downloads')
        if os.path.exists(downloads):
            shared_directory = downloads
        else:
            shared_directory = os.getcwd()

    # Open firewall ports so phones can connect (triggers UAC once on Windows)
    print("Opening firewall ports (you may see a UAC popup - click Yes)...")
    open_firewall_ports(port, fast_transfer_port)

    print(f"")
    print(f"Starting Wireless File Transfer Server...")
    print(f"Web UI:            http://{server_ip}:{port}")
    print(f"Phone browse URL:  http://{server_ip}:{port}/browser")
    print(f"Fast Transfer:     http://{server_ip}:{fast_transfer_port}  (raw socket)")
    print(f"Shared directory:  {shared_directory}")
    print(f"QR Code ready! Scan with your phone to connect.")
    print("\nPress Ctrl+C to stop the server")

    # Start raw-socket fast transfer server on port+1
    try:
        fast_server = FastTransferServer(fast_transfer_port, shared_directory)
        fast_thread = threading.Thread(target=fast_server.serve_forever, daemon=True)
        fast_thread.start()
        print(f"Fast Transfer Server started on port {fast_transfer_port}")
    except Exception as e:
        print(f"Warning: Could not start fast transfer server: {e}")
        fast_transfer_port = None

    # Start file watcher
    watcher = start_file_watcher(shared_directory)

    try:
        app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
    except KeyboardInterrupt:
        print("\nShutting down server...")
    finally:
        watcher.stop()
        watcher.join()

if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Wireless File Transfer Server')
    parser.add_argument('--port', type=int, default=5000, help='Port to run server on')
    parser.add_argument('--directory', type=str, help='Directory to share')
    parser.add_argument('--open-browser', action='store_true', help='Open browser automatically')
    
    args = parser.parse_args()
    
    if args.open_browser:
        # Open browser after a short delay
        def open_browser():
            time.sleep(2)
            webbrowser.open(f'http://localhost:{args.port}')
        
        threading.Thread(target=open_browser, daemon=True).start()
    
    start_server(args.port, args.directory)