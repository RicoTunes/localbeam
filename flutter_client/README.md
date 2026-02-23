# Wireless File Transfer - Flutter Android Client

A Flutter application for Android that connects to the Python file transfer server. Scan QR codes to connect and transfer files blazing fast.

## Features

- **QR Code Scanner**: Scan server QR code to connect automatically
- **File Browser**: Browse files on laptop/server
- **Fast Transfers**: Download/upload files at Wi-Fi speeds
- **Progress Tracking**: Real-time transfer progress
- **Clipboard Sharing**: Share text between devices
- **Dark/Light Theme**: Modern Material Design
- **Background Transfers**: Continue transfers in background

## Prerequisites

- Flutter SDK (version 3.0 or higher)
- Android Studio or VS Code with Flutter extension
- Android device/emulator with API 21+

## Installation

1. Clone this repository
2. Navigate to the flutter_client directory:
   ```bash
   cd flutter_client
   ```
3. Install dependencies:
   ```bash
   flutter pub get
   ```
4. Run the app:
   ```bash
   flutter run
   ```

## Building for Android

### APK
```bash
flutter build apk --release
```

### App Bundle
```bash
flutter build appbundle --release
```

## Connecting to Server

1. Start the Python server on your laptop:
   ```bash
   python run.py
   ```
2. Open the Flutter app on your Android device
3. Tap "Scan QR Code" and point camera at server QR code
4. App automatically connects to server
5. Browse and transfer files

## Manual Connection

If QR code scanning doesn't work:
1. Note the server URL shown on laptop (e.g., `http://192.168.1.100:5000`)
2. In app, tap "Manual Connect"
3. Enter the server URL
4. Tap "Connect"

## Permissions

The app requires:
- Camera permission (for QR scanning)
- Storage permission (for file access)
- Internet permission (for network transfers)

## Project Structure

```
flutter_client/
├── lib/
│   ├── main.dart              # App entry point
│   ├── screens/               # App screens
│   │   ├── home_screen.dart
│   │   ├── scanner_screen.dart
│   │   ├── browser_screen.dart
│   │   └── transfer_screen.dart
│   ├── services/              # Business logic
│   │   ├── api_service.dart
│   │   ├── transfer_service.dart
│   │   └── qr_service.dart
│   ├── widgets/               # Reusable widgets
│   │   ├── file_item.dart
│   │   ├── progress_widget.dart
│   │   └── connection_status.dart
│   └── models/                # Data models
│       ├── file_model.dart
│       └── server_model.dart
├── android/                   # Android-specific files
├── ios/                       # iOS-specific files
├── assets/                    # Images, fonts
└── pubspec.yaml              # Dependencies
```

## Dependencies

Key packages used:
- `qr_code_scanner`: QR code scanning
- `http`: API communication
- `provider`: State management
- `permission_handler`: Permission management
- `path_provider`: File system access
- `share_plus`: File sharing
- `fluttertoast`: Notifications

## API Integration

The app communicates with the Python server via REST API:

- `GET /api/info` - Get server information
- `GET /api/files` - List files
- `GET /api/download/{filename}` - Download file
- `POST /api/upload` - Upload file
- `POST /api/clipboard` - Share clipboard

## Troubleshooting

### Connection Issues
- Ensure both devices on same Wi-Fi
- Check firewall settings on laptop
- Verify server is running (`python run.py`)

### QR Code Not Scanning
- Grant camera permission
- Ensure good lighting
- Try manual connection

### File Transfer Fails
- Check storage permission
- Ensure enough storage space
- Try smaller files first

## Development

### Adding Features
1. Fork the repository
2. Create feature branch
3. Implement changes
4. Test thoroughly
5. Submit pull request

### Code Style
- Follow Dart style guide
- Use meaningful variable names
- Add comments for complex logic
- Write tests for new features

## License

MIT License - Free to use, modify, and distribute.

## Support

For issues:
1. Check troubleshooting section
2. Open GitHub issue
3. Ensure Flutter environment is properly set up

## Screenshots

![Home Screen](https://via.placeholder.com/300x600/2196F3/FFFFFF?text=Home+Screen)
![QR Scanner](https://via.placeholder.com/300x600/4CAF50/FFFFFF?text=QR+Scanner)
![File Browser](https://via.placeholder.com/300x600/FF9800/FFFFFF?text=File+Browser)

---

**Enjoy wireless file transfers with the Flutter app!** 📱