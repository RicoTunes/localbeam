#!/usr/bin/env python3
"""
Test QR code generation for the Wireless File Transfer app
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app import get_local_ip, create_qr_code
import webbrowser
import tempfile

def test_qr_generation():
    """Test QR code generation and display"""
    print("Testing QR Code Generation for Wireless File Transfer")
    print("=" * 60)
    
    # Get local IP
    ip = get_local_ip()
    print(f"Local IP Address: {ip}")
    print(f"Server URL: http://{ip}:5000")
    
    # Generate QR code
    print("\nGenerating QR code...")
    qr_data, url = create_qr_code()
    
    print(f"QR Code URL: {url}")
    print(f"QR Code Data (base64): {qr_data[:50]}...")
    
    # Create HTML to display QR code
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Wireless File Transfer QR Code</title>
        <style>
            body {{ font-family: Arial, sans-serif; padding: 40px; text-align: center; }}
            .container {{ max-width: 600px; margin: 0 auto; }}
            h1 {{ color: #333; }}
            .qr-container {{ margin: 30px 0; }}
            .url {{ 
                background: #f5f5f5; 
                padding: 15px; 
                border-radius: 8px;
                font-family: monospace;
                word-break: break-all;
                margin: 20px 0;
            }}
            .instructions {{ 
                text-align: left; 
                background: #e8f4ff; 
                padding: 20px; 
                border-radius: 8px;
                margin-top: 30px;
            }}
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Wireless File Transfer QR Code</h1>
            <p>Scan this QR code with your phone to connect to the file transfer server</p>
            
            <div class="qr-container">
                <img src="{qr_data}" alt="QR Code" style="width: 300px; height: 300px;">
            </div>
            
            <div class="url">
                <strong>Server URL:</strong><br>
                {url}
            </div>
            
            <div class="instructions">
                <h3>How to use:</h3>
                <ol>
                    <li>Make sure your phone and laptop are on the same Wi-Fi network</li>
                    <li>Open your phone's camera or any QR code scanner app</li>
                    <li>Point your phone at this QR code</li>
                    <li>Tap the link that appears to open the file transfer interface</li>
                    <li>Browse and transfer files between devices</li>
                </ol>
                <p><strong>Note:</strong> The server must be running for the connection to work.</p>
            </div>
        </div>
    </body>
    </html>
    """
    
    # Save HTML to temp file and open in browser
    with tempfile.NamedTemporaryFile(mode='w', suffix='.html', delete=False) as f:
        f.write(html)
        temp_file = f.name
    
    print(f"\nOpening QR code in browser...")
    webbrowser.open(f'file://{temp_file}')
    
    print("\nQR code test completed successfully!")
    print("You can also run the full server with: python run.py")

if __name__ == "__main__":
    test_qr_generation()