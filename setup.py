#!/usr/bin/env python3
"""
Setup script for Wireless File Transfer application
Installs dependencies and creates necessary directories
"""

import os
import sys
import subprocess
import platform
from pathlib import Path

def print_header():
    print("=" * 60)
    print("Wireless File Transfer - Setup")
    print("=" * 60)
    print("A Python app for blazing fast file transfers")
    print("between laptop and Android via QR code scanning")
    print("=" * 60)

def check_python_version():
    """Check Python version"""
    print("\nChecking Python version...")
    if sys.version_info < (3, 7):
        print(f"ERROR: Python 3.7+ required, found {sys.version}")
        return False
    print(f"✓ Python {sys.version_info.major}.{sys.version_info.minor} detected")
    return True

def install_dependencies():
    """Install required Python packages"""
    print("\nInstalling dependencies...")
    
    requirements_file = "requirements.txt"
    if not os.path.exists(requirements_file):
        print("ERROR: requirements.txt not found")
        return False
    
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", requirements_file])
        print("✓ Dependencies installed successfully")
        return True
    except subprocess.CalledProcessError as e:
        print(f"ERROR: Failed to install dependencies: {e}")
        print("\nTry installing manually:")
        print("  pip install flask qrcode[pil] pillow netifaces flask-cors pyperclip watchdog")
        return False

def create_directories():
    """Create necessary directories"""
    print("\nCreating directory structure...")
    
    directories = [
        "static/css",
        "static/js",
        "templates",
        "uploads",
        "logs"
    ]
    
    for directory in directories:
        os.makedirs(directory, exist_ok=True)
        print(f"  Created: {directory}/")
    
    # Create a sample file for testing
    sample_file = "uploads/sample_file.txt"
    if not os.path.exists(sample_file):
        with open(sample_file, "w") as f:
            f.write("This is a sample file for testing wireless file transfer.\n")
            f.write("You can delete this file or replace it with your own files.\n")
        print(f"  Created sample file: {sample_file}")
    
    return True

def check_firewall():
    """Check and warn about firewall settings"""
    print("\nChecking firewall settings...")
    
    system = platform.system()
    if system == "Windows":
        print("⚠  On Windows, you may need to allow Python through firewall")
        print("   When prompted, click 'Allow access' for private networks")
    elif system == "Darwin":  # macOS
        print("⚠  On macOS, check System Preferences > Security & Privacy > Firewall")
    elif system == "Linux":
        print("⚠  On Linux, check your firewall settings (ufw, firewalld, etc.)")
    
    print("\nFor file transfer to work:")
    print("1. Ensure both devices are on same Wi-Fi network")
    print("2. Firewall must allow incoming connections on port 5000")
    print("3. Private network profile should allow Python/flask")
    return True

def create_start_script():
    """Create platform-specific start scripts"""
    print("\nCreating start scripts...")
    
    # Windows batch file
    with open("start_windows.bat", "w") as f:
        f.write("@echo off\n")
        f.write("echo Starting Wireless File Transfer Server...\n")
        f.write("echo.\n")
        f.write("python run.py\n")
        f.write("pause\n")
    
    # Linux/macOS shell script
    with open("start.sh", "w") as f:
        f.write("#!/bin/bash\n")
        f.write("echo 'Starting Wireless File Transfer Server...'\n")
        f.write("echo ''\n")
        f.write("python3 run.py\n")
    
    os.chmod("start.sh", 0o755)
    
    print("  Created: start_windows.bat (for Windows)")
    print("  Created: start.sh (for Linux/macOS)")
    
    return True

def test_installation():
    """Test if installation works"""
    print("\nTesting installation...")
    
    # Test Python imports
    test_imports = [
        "flask",
        "qrcode",
        "PIL",
        "netifaces",
        "flask_cors"
    ]
    
    all_imports_ok = True
    for module in test_imports:
        try:
            __import__(module.replace(".", "_"))
            print(f"  ✓ {module}")
        except ImportError:
            print(f"  ✗ {module} (not installed)")
            all_imports_ok = False
    
    return all_imports_ok

def main():
    print_header()
    
    if not check_python_version():
        return 1
    
    if not install_dependencies():
        return 1
    
    create_directories()
    check_firewall()
    create_start_script()
    
    if not test_installation():
        print("\n⚠  Some dependencies may be missing")
        print("   Try: pip install -r requirements.txt")
    
    print("\n" + "=" * 60)
    print("SETUP COMPLETE!")
    print("=" * 60)
    print("\nTo start the server:")
    print("- Windows: Double-click start_windows.bat")
    print("- Linux/macOS: Run ./start.sh")
    print("- Or manually: python run.py")
    print("\nOnce server is running:")
    print("1. Open browser to http://localhost:5000")
    print("2. Scan QR code with phone camera")
    print("3. Transfer files wirelessly!")
    print("\nFor Flutter Android app:")
    print("1. Install Flutter SDK")
    print("2. Navigate to flutter_client/")
    print("3. Run: flutter pub get")
    print("4. Run: flutter run")
    print("\nNeed help? Check README.md for detailed instructions")
    print("=" * 60)
    
    return 0

if __name__ == "__main__":
    sys.exit(main())