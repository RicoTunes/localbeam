# Wireless File Transfer - Xender-like File Sharing

A Python application that enables blazing fast file transfers between your laptop and Android device without USB cables. Simply scan a QR code with your phone to connect and transfer files over local Wi-Fi.

## Features

- **QR Code Connection**: Scan QR code with phone to instantly connect
- **Blazing Fast Transfers**: Local network transfers at Wi-Fi speeds
- **No Installation Required**: Phone accesses via browser, no app needed
- **File Browser**: Browse and select files from laptop directory
- **Clipboard Sharing**: Share text between devices
- **Real-time Updates**: Auto-refreshes file list
- **Modern UI**: Clean, responsive interface with dark/light themes
- **Cross-platform**: Works on Windows, macOS, Linux

## How It Works

1. **Start the server** on your laptop
2. **Scan the QR code** with your phone's camera
3. **Open the link** on your phone's browser
4. **Browse files** on your laptop and download to phone
5. **Upload files** from phone to laptop

## Installation

### Prerequisites
- Python 3.7 or higher
- pip package manager

### Setup

1. Clone or download this repository
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Usage

### Quick Start
Run the helper script:
```bash
python run.py
```

Or run directly:
```bash
python app.py --port 5000 --directory ~/Downloads --open-browser
```

### Command Line Options
- `--port`: Port to run server on (default: 5000)
- `--directory`: Directory to share (default: Downloads folder)
- `--open-browser`: Automatically open browser on start

### Manual Start
```python
python app.py
```

## Phone Access

1. Ensure phone and laptop are on the same Wi-Fi network
2. Open phone's camera and point at QR code
3. Tap the notification/link that appears
4. Alternatively, manually enter the URL shown on the laptop

## File Transfer

### From Laptop to Phone
1. Browse files in the web interface
2. Click download button next to any file
3. File downloads directly to phone

### From Phone to Laptop
1. Click "Upload" button in phone interface
2. Select files from phone
3. Files upload to shared directory on laptop

## Advanced Features

### Clipboard Sharing
- Type text in the "Clipboard Sharing" box on laptop
- Click "Share to Phone" to send to phone's clipboard
- Phone can also send text to laptop

### Quick Transfer Categories
- Photos, Documents, Music, Videos
- One-click access to common file types

### Directory Management
- Change shared directory while server is running
- Monitor file changes in real-time

## Technical Details

### Architecture
- **Backend**: Flask web server with REST API
- **Frontend**: HTML5, CSS3, JavaScript
- **QR Code**: qrcode library with PIL
- **File Watching**: watchdog for directory monitoring
- **Network Detection**: netifaces for IP address discovery

### API Endpoints
- `GET /api/files` - List files in shared directory
- `GET /api/download/<filename>` - Download file
- `POST /api/upload` - Upload file from phone
- `GET /api/info` - Server information
- `POST /api/set_directory` - Change shared directory
- `POST /api/clipboard` - Share clipboard text

## Performance Tips

1. **Same Network**: Ensure both devices on same Wi-Fi network
2. **5GHz Wi-Fi**: Use 5GHz band for faster transfers
3. **Close Background Apps**: Free up network bandwidth
4. **Use Chrome/Firefox**: Better performance than Safari
5. **Large Files**: Transfer works best with files < 2GB

## Troubleshooting

### Connection Issues
- Check both devices are on same Wi-Fi
- Disable VPN/firewall temporarily
- Try different port if 5000 is blocked

### QR Code Not Scanning
- Ensure good lighting
- Move phone closer/further
- Manually enter URL shown on laptop

### Slow Transfers
- Check Wi-Fi signal strength
- Reduce other network usage
- Transfer smaller batches of files

## Security Notes

- **Local Network Only**: Server runs on local network only
- **No Internet Exposure**: Files don't leave your local network
- **Temporary Access**: Server stops when you close it
- **No Authentication**: Anyone on same network can access (use firewall if needed)

## Development

### Project Structure
```
wireless-file-transfer/
├── app.py              # Main Flask application
├── run.py              # Helper script for easy startup
├── test_qr.py          # QR code test utility
├── requirements.txt    # Python dependencies
├── README.md           # This file
├── templates/          # HTML templates
│   └── index.html     # Main interface
└── static/            # Static assets
    ├── css/
    │   └── style.css  # Stylesheets
    └── js/
        └── main.js    # Frontend JavaScript
```

### Adding Features
1. Fork the repository
2. Make changes to `app.py` for backend
3. Update `static/` files for frontend
4. Test with `python run.py`
5. Submit pull request

## License

MIT License - Free to use, modify, and distribute.

## Credits

Created as a modern alternative to Xender/SHAREit for local file transfers.

## Support

For issues or questions:
1. Check troubleshooting section above
2. Open GitHub issue
3. Ensure Python and dependencies are properly installed

## Screenshots

![QR Code Interface](https://via.placeholder.com/800x450/667eea/ffffff?text=Wireless+File+Transfer+Interface)
![File Browser](https://via.placeholder.com/800x450/764ba2/ffffff?text=File+Browser+with+Transfer+Options)

---

**Enjoy blazing fast file transfers without cables!** 🚀