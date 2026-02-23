#!/usr/bin/env python3
"""Test the server endpoints directly"""

import requests
import json

def test_server():
    base_url = "http://localhost:5000"
    
    print("Testing server endpoints...")
    print("=" * 60)
    
    # Test 1: Main page
    try:
        response = requests.get(base_url, timeout=5)
        print(f"1. Main page: {response.status_code}")
        if response.status_code == 200:
            print("   ✓ Server is running")
            # Check for QR code
            if 'qr_code' in response.text or 'qrcode' in response.text.lower():
                print("   ✓ QR code found in page")
    except Exception as e:
        print(f"   ✗ Error: {e}")
    
    # Test 2: API info
    try:
        response = requests.get(f"{base_url}/api/info", timeout=5)
        print(f"\n2. API info: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            print(f"   ✓ Response: {json.dumps(data, indent=2)}")
        else:
            print(f"   Response text: {response.text[:200]}")
    except Exception as e:
        print(f"   ✗ Error: {e}")
    
    # Test 3: QR test endpoint
    try:
        response = requests.get(f"{base_url}/api/qr_test", timeout=5)
        print(f"\n3. QR test: {response.status_code}")
        if response.status_code == 200:
            print(f"   ✓ QR image returned ({len(response.content)} bytes)")
            # Check if it's an image
            content_type = response.headers.get('Content-Type', '')
            print(f"   Content-Type: {content_type}")
        else:
            print(f"   Response: {response.text[:100]}")
    except Exception as e:
        print(f"   ✗ Error: {e}")
    
    # Test 4: File listing
    try:
        response = requests.get(f"{base_url}/api/files", timeout=5)
        print(f"\n4. File listing: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            files = data.get('files', [])
            print(f"   ✓ Found {len(files)} files")
    except Exception as e:
        print(f"   ✗ Error: {e}")
    
    print("\n" + "=" * 60)
    print("Test complete")

if __name__ == "__main__":
    test_server()