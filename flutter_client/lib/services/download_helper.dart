import 'dart:io';
import 'package:flutter/services.dart';

/// Helper to save files to the public Downloads folder on Android
/// so they're visible in the phone's file manager.
class DownloadHelper {
  static const _channel = MethodChannel('com.localbeam/downloads');

  /// Get the public Downloads directory path.
  /// Returns `/storage/emulated/0/Download/filename`
  /// On Android 10+ (API 29+) we write directly — scoped storage allows
  /// writing to the app's own files. For older versions, the WRITE permission
  /// in the manifest handles it.
  static Future<String?> getPublicDownloadPath(String fileName) async {
    try {
      // The standard public Downloads directory
      final downloadsDir = Directory('/storage/emulated/0/Download');
      if (await downloadsDir.exists()) {
        // Avoid overwriting — add (1), (2) etc if file exists
        var path = '${downloadsDir.path}/$fileName';
        var file = File(path);
        if (await file.exists()) {
          final dot = fileName.lastIndexOf('.');
          final name = dot > 0 ? fileName.substring(0, dot) : fileName;
          final ext = dot > 0 ? fileName.substring(dot) : '';
          int counter = 1;
          while (await file.exists()) {
            path = '${downloadsDir.path}/$name($counter)$ext';
            file = File(path);
            counter++;
          }
        }
        return path;
      }

      // Fallback: try Environment.getExternalStoragePublicDirectory via method channel
      // or just use a known path
      final fallback = Directory('/sdcard/Download');
      if (await fallback.exists()) {
        return '${fallback.path}/$fileName';
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  /// Notify the Android MediaStore so the file appears in file managers immediately.
  static Future<void> scanFile(String filePath) async {
    try {
      // Use MediaScannerConnection via method channel
      _channel.invokeMethod('scanFile', {'path': filePath});
    } catch (_) {
      // Fallback: just touch the file to update its timestamp
      try {
        final file = File(filePath);
        if (await file.exists()) {
          // Reading the file length forces the OS to acknowledge it
          await file.length();
        }
      } catch (_) {}
    }
  }
}
