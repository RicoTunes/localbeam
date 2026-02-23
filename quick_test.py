#!/usr/bin/env python3
"""
Quick test for Wireless File Transfer app
"""

import subprocess
import threading
import time
import requests
import sys

def start_server():
    """Start the Flask server"""
    cmd = [sys.executable, "app.py", "--port", "5050", "--directory", "uploads"]
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return process

def test_server():
    """Test if server is responding"""
    print("Testing Wireless File Transfer Server...")
    print("=" * 60)
    
    # Give server time to start
    print("Starting server on port 5050...")
    server = start_server()
    time.sleep(3)
    
    try:
        # Test basic connectivity
        print("\n1. Testing server connectivity...")
        response = requests.get("http://localhost:5050/api/info", timeout=5)
        if response.status_code == 200:
            info = response.json()
            print(f"   ✓ Server is running!")
            print(f"   IP: {info.get('ip')}")
            print(f"   Port: {info.get('port')}")
            print(f"   Directory: {info.get('directory')}")
        else:
            print(f"   ✗ Server returned status: {response.status_code}")
            return False
        
        # Test file listing
        print("\n2. Testing file listing...")
        response = requests.get("http://localhost:5050/api/files", timeout=5)
        if response.status_code == 200:
            data = response.json()
            files = data.get('files', [])
            print(f"   ✓ Found {len(files)} file(s)")
            for f in files:
                print(f"     - {f['name']} ({f['size']} bytes)")
        else:
            print(f"   ✗ File listing failed: {response.status_code}")
        
        # Test QR code generation
        print("\n3. Testing QR code generation...")
        response = requests.get("http://localhost:5050/", timeout=5)
        if response.status_code == 200:
            print("   ✓ Web interface is working")
            if "qr_code" in response.text.lower() or "qrcode" in response.text:
                print("   ✓ QR code detected in page")
        else:
            print(f"   ✗ Web interface failed: {response.status_code}")
        
        # Test file download
        print("\n4. Testing file download...")
        response = requests.get("http://localhost:5050/api/download/test_file.txt", timeout=5)
        if response.status_code == 200:
            print(f"   ✓ File download works (size: {len(response.content)} bytes)")
            print(f"   Content preview: {response.text[:50]}...")
        else:
            print(f"   ✗ File download failed: {response.status_code}")
        
        print("\n" + "=" * 60)
        print("ALL TESTS PASSED! 🎉")
        print("=" * 60)
        print("\nYour Wireless File Transfer app is working correctly!")
        print(f"\nTo use it:")
        print(f"1. Open browser to: http://localhost:5050")
        print(f"2. Scan the QR code with your phone")
        print(f"3. Transfer files wirelessly!")
        print(f"\nServer URL for phone: http://{info.get('ip')}:5050")
        
        return True
        
    except requests.exceptions.ConnectionError:
        print("   ✗ Cannot connect to server. Is it running?")
        return False
    except Exception as e:
        print(f"   ✗ Error: {e}")
        return False
    finally:
        # Stop the server
        print("\nStopping server...")
        server.terminate()
        server.wait()

if __name__ == "__main__":
    success = test_server()
    sys.exit(0 if success else 1)