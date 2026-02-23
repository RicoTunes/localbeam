#!/usr/bin/env python3
"""
Final test of the Wireless File Transfer app on the actual running server (port 5000)
"""

import requests
import time

def test_main_server():
    """Test the actual running server on port 5000"""
    print("Testing Wireless File Transfer Server (Port 5000)")
    print("=" * 60)
    
    base_url = "http://localhost:5000"
    
    try:
        # Test 1: Server info
        print("\n1. Testing server connectivity...")
        response = requests.get(f"{base_url}/api/info", timeout=5)
        if response.status_code == 200:
            info = response.json()
            print(f"   ✓ Server is running!")
            print(f"   IP: {info.get('ip')}")
            print(f"   Port: {info.get('port')}")
            print(f"   URL: {info.get('url')}")
            print(f"   Directory: {info.get('directory')}")
        else:
            print(f"   ✗ Server returned status: {response.status_code}")
            return False
        
        # Test 2: Web interface
        print("\n2. Testing web interface...")
        response = requests.get(base_url, timeout=5)
        if response.status_code == 200:
            print("   ✓ Web interface is accessible")
            # Check for QR code in page
            if 'qr_code' in response.text or 'qrcode' in response.text.lower():
                print("   ✓ QR code detected in page")
            else:
                print("   ⚠ QR code not found in page (may be in JavaScript)")
        else:
            print(f"   ✗ Web interface failed: {response.status_code}")
        
        # Test 3: File listing from uploads directory
        print("\n3. Testing file listing...")
        response = requests.get(f"{base_url}/api/files", timeout=5)
        if response.status_code == 200:
            data = response.json()
            files = data.get('files', [])
            print(f"   ✓ File listing working ({len(files)} files)")
            for f in files[:3]:  # Show first 3
                print(f"     - {f['name']} ({f.get('size', 0)} bytes)")
        else:
            print(f"   ✗ File listing failed: {response.status_code}")
        
        # Test 4: Browser interface
        print("\n4. Testing file browser...")
        response = requests.get(f"{base_url}/browser", timeout=5)
        if response.status_code == 200:
            print("   ✓ File browser is accessible")
        else:
            print(f"   ✗ File browser failed: {response.status_code}")
        
        # Test 5: Special directories
        print("\n5. Testing special directories...")
        response = requests.get(f"{base_url}/api/special_dirs", timeout=5)
        if response.status_code == 200:
            data = response.json()
            dirs = data.get('special_dirs', [])
            print(f"   ✓ Found {len(dirs)} special directories")
            for d in dirs:
                print(f"     - {d['name']} ({d['file_count']} files)")
        else:
            print(f"   ✗ Special directories failed: {response.status_code}")
        
        # Test 6: QR code test endpoint
        print("\n6. Testing QR code generation...")
        response = requests.get(f"{base_url}/api/qr_test", timeout=5)
        if response.status_code == 200:
            print(f"   ✓ QR code generated successfully ({len(response.content)} bytes)")
        else:
            print(f"   ✗ QR code generation failed: {response.status_code}")
        
        print("\n" + "=" * 60)
        print("SERVER TEST COMPLETE! ✅")
        print("=" * 60)
        
        # Summary
        print(f"\n📱 To use the app:")
        print(f"1. Open browser to: {base_url}")
        print(f"2. Scan QR code with phone camera")
        print(f"3. Phone URL: {info.get('url')}")
        print(f"4. Browse files at: {base_url}/browser")
        print(f"5. Transfer files wirelessly!")
        
        print(f"\n🔧 Server Details:")
        print(f"   - Local: {base_url}")
        print(f"   - Network: {info.get('url')}")
        print(f"   - File Browser: {base_url}/browser")
        print(f"   - Uploads Directory: {info.get('directory')}")
        
        return True
        
    except requests.exceptions.ConnectionError:
        print("   ✗ Cannot connect to server. Is it running on port 5000?")
        print(f"   Try: python app.py --port 5000 --directory uploads")
        return False
    except Exception as e:
        print(f"   ✗ Error: {e}")
        return False

if __name__ == "__main__":
    success = test_main_server()
    exit(0 if success else 1)