#!/usr/bin/env python3
"""
Simple runner script for the Wireless File Transfer app
"""

import os
import sys
import subprocess
import webbrowser
import time
from pathlib import Path

def check_dependencies():
    """Check if required packages are installed"""
    try:
        import flask
        import qrcode
        import netifaces
        print("✓ All dependencies are installed")
        return True
    except ImportError as e:
        print(f"✗ Missing dependency: {e}")
        print("Installing dependencies...")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"])
            print("✓ Dependencies installed successfully")
            return True
        except subprocess.CalledProcessError:
            print("✗ Failed to install dependencies")
            return False

def get_default_directory():
    """Get a sensible default directory for sharing"""
    # Try Downloads folder first
    downloads = Path.home() / "Downloads"
    if downloads.exists():
        return str(downloads)
    
    # Try Desktop
    desktop = Path.home() / "Desktop"
    if desktop.exists():
        return str(desktop)
    
    # Use current directory
    return os.getcwd()

def main():
    print("=" * 60)
    print("Wireless File Transfer - Xender-like File Sharing")
    print("=" * 60)
    
    # Check dependencies
    if not check_dependencies():
        print("Please install dependencies manually:")
        print("  pip install -r requirements.txt")
        input("Press Enter to exit...")
        return
    
    # Get port
    port = 5000
    try:
        port_input = input(f"Enter port number [default: {port}]: ").strip()
        if port_input:
            port = int(port_input)
    except ValueError:
        print("Invalid port, using default 5000")
    
    # Get directory
    default_dir = get_default_directory()
    print(f"\nDefault shared directory: {default_dir}")
    change_dir = input("Change directory? (y/N): ").strip().lower()
    
    if change_dir == 'y':
        new_dir = input("Enter full path to directory: ").strip()
        if os.path.exists(new_dir):
            directory = new_dir
        else:
            print("Directory doesn't exist, using default")
            directory = default_dir
    else:
        directory = default_dir
    
    # Ask about opening browser
    open_browser = input("\nOpen browser automatically? (Y/n): ").strip().lower()
    open_browser = open_browser != 'n'
    
    # Build command
    cmd = [sys.executable, "app.py", "--port", str(port), "--directory", directory]
    if open_browser:
        cmd.append("--open-browser")
    
    print("\n" + "=" * 60)
    print("Starting server...")
    print(f"Port: {port}")
    print(f"Shared directory: {directory}")
    print("=" * 60)
    print("\nInstructions:")
    print("1. Make sure your phone is on the same Wi-Fi network")
    print("2. Scan the QR code that appears in the browser")
    print("3. Open the link on your phone to transfer files")
    print("\nPress Ctrl+C to stop the server")
    print("=" * 60)
    
    # Run the server
    try:
        subprocess.run(cmd)
    except KeyboardInterrupt:
        print("\nServer stopped by user")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main()