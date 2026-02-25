import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../models/file_item.dart';
import '../models/server_info.dart';

// ── P2P data models ─────────────────────────────────────────────
class P2PDevice {
  final String id;
  final String name;
  final String userAgent;
  final double lastSeen;
  P2PDevice({required this.id, required this.name, required this.userAgent, required this.lastSeen});
  factory P2PDevice.fromJson(Map<String, dynamic> j) => P2PDevice(
    id: j['id'] ?? '', name: j['name'] ?? '', userAgent: j['user_agent'] ?? '',
    lastSeen: (j['last_seen'] as num?)?.toDouble() ?? 0,
  );
  bool get isOnline => (DateTime.now().millisecondsSinceEpoch / 1000 - lastSeen) < 10;
}

class P2PFile {
  final String id;
  final String name;
  final int size;
  final String senderId;
  final String senderName;
  final double ts;
  final int expiresIn;
  P2PFile({required this.id, required this.name, required this.size,
    required this.senderId, required this.senderName, required this.ts, required this.expiresIn});
  factory P2PFile.fromJson(Map<String, dynamic> j) => P2PFile(
    id: j['id'] ?? '', name: j['name'] ?? '', size: (j['size'] as num?)?.toInt() ?? 0,
    senderId: j['sender_id'] ?? '', senderName: j['sender_name'] ?? '',
    ts: (j['ts'] as num?)?.toDouble() ?? 0, expiresIn: (j['expires_in'] as num?)?.toInt() ?? 0,
  );
  int get expiresInMin => (expiresIn / 60).ceil();
}

class ApiService extends ChangeNotifier {
  static const _prefKeyIp = 'server_ip';
  static const _prefKeyPort = 'server_port';

  String? _serverIp;
  int _serverPort = 5001;
  ServerInfo? _info;
  bool _connected = false;
  String? _error;

  bool get isConnected => _connected;
  ServerInfo? get info => _info;
  String? get serverIp => _serverIp;
  int get serverPort => _serverPort;
  String? get error => _error;
  String get baseUrl => 'http://$_serverIp:$_serverPort';

  ApiService() {
    _loadSaved();
  }

  Future<void> _loadSaved() async {
    final prefs = await SharedPreferences.getInstance();
    final ip = prefs.getString(_prefKeyIp);
    final port = prefs.getInt(_prefKeyPort) ?? 5001;
    if (ip != null && ip.isNotEmpty) {
      _serverIp = ip;
      _serverPort = port;
      await checkConnection();
    }
  }

  Future<bool> connect(String ip, {int port = 5001}) async {
    _serverIp = ip.trim();
    _serverPort = port;
    _error = null;
    notifyListeners();

    final ok = await checkConnection();
    if (ok) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_prefKeyIp, _serverIp!);
      await prefs.setInt(_prefKeyPort, _serverPort);
    }
    return ok;
  }

  Future<bool> checkConnection() async {
    if (_serverIp == null || _serverIp!.isEmpty) return false;
    try {
      final uri = Uri.parse('$baseUrl/api/info');
      final resp = await http.get(uri).timeout(const Duration(seconds: 5));
      if (resp.statusCode == 200) {
        _info = ServerInfo.fromJson(jsonDecode(resp.body) as Map<String, dynamic>);
        _connected = true;
        _error = null;
        notifyListeners();
        return true;
      }
    } catch (e) {
      _error = e.toString();
    }
    _connected = false;
    _info = null;
    notifyListeners();
    return false;
  }

  void disconnect() {
    _connected = false;
    _info = null;
    _serverIp = null;
    notifyListeners();
  }

  Future<BrowseResult?> browse(String path) async {
    if (!_connected) return null;
    try {
      final uri = Uri.parse('$baseUrl/api/browse').replace(
        queryParameters: {'path': path},
      );
      final resp = await http.get(uri).timeout(const Duration(seconds: 10));
      if (resp.statusCode == 200) {
        return BrowseResult.fromJson(jsonDecode(resp.body) as Map<String, dynamic>);
      }
    } catch (e) {
      debugPrint('browse error: $e');
    }
    return null;
  }

  /// Build download URL — prefers fast server (port 5002)
  String downloadUrl(String filePath) {
    final fastBase = _info?.fastBaseUrl ?? baseUrl;
    return '$fastBase/?path=${Uri.encodeComponent(filePath)}';
  }

  /// Build Flask fallback download URL
  String flaskDownloadUrl(String filePath) {
    return '$baseUrl/api/dl?path=${Uri.encodeComponent(filePath)}';
  }

  /// Get live transfer feed JSON
  Future<String?> getTransfers() async {
    try {
      final resp = await http
          .get(Uri.parse('$baseUrl/api/transfers'))
          .timeout(const Duration(seconds: 4));
      if (resp.statusCode == 200) return resp.body;
    } catch (_) {}
    return null;
  }

  /// Pause / resume / cancel a transfer
  Future<void> transferAction(String tid, String action) async {
    try {
      await http
          .post(Uri.parse('$baseUrl/api/transfers/$tid/$action'))
          .timeout(const Duration(seconds: 4));
    } catch (_) {}
  }

  // ── P2P (server-relayed sharing) ──────────────────────────────

  /// Register / heartbeat this device. Returns {device_id, name}.
  Future<Map<String, dynamic>?> p2pRegister({String? deviceId, String? name}) async {
    try {
      final body = <String, dynamic>{};
      if (deviceId != null) body['device_id'] = deviceId;
      if (name != null) body['name'] = name;
      final resp = await http.post(
        Uri.parse('$baseUrl/api/p2p/register'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode(body),
      ).timeout(const Duration(seconds: 5));
      if (resp.statusCode == 200) return jsonDecode(resp.body);
    } catch (e) { debugPrint('p2pRegister error: $e'); }
    return null;
  }

  /// List connected devices.
  Future<List<P2PDevice>> p2pDevices() async {
    try {
      final resp = await http.get(
        Uri.parse('$baseUrl/api/p2p/devices?_t=${DateTime.now().millisecondsSinceEpoch}'),
      ).timeout(const Duration(seconds: 5));
      if (resp.statusCode == 200) {
        final data = jsonDecode(resp.body);
        return (data['devices'] as List).map((d) => P2PDevice.fromJson(d)).toList();
      }
    } catch (_) {}
    return [];
  }

  /// List shared files.
  Future<List<P2PFile>> p2pFiles() async {
    try {
      final resp = await http.get(
        Uri.parse('$baseUrl/api/p2p/files?_t=${DateTime.now().millisecondsSinceEpoch}'),
      ).timeout(const Duration(seconds: 5));
      if (resp.statusCode == 200) {
        final data = jsonDecode(resp.body);
        return (data['files'] as List).map((f) => P2PFile.fromJson(f)).toList();
      }
    } catch (_) {}
    return [];
  }

  /// Upload a file to P2P shared space. Returns file_id on success.
  Future<String?> p2pSendFile(File file, String deviceId, {void Function(double)? onProgress}) async {
    try {
      final request = http.MultipartRequest('POST', Uri.parse('$baseUrl/api/p2p/send'));
      request.fields['device_id'] = deviceId;
      request.files.add(await http.MultipartFile.fromPath('file', file.path));
      final streamed = await request.send().timeout(const Duration(minutes: 10));
      final respBody = await streamed.stream.bytesToString();
      if (streamed.statusCode == 200) {
        final data = jsonDecode(respBody);
        return data['file_id'] as String?;
      }
    } catch (e) { debugPrint('p2pSend error: $e'); }
    return null;
  }

  /// Download a P2P shared file. Returns the saved File on success.
  Future<File?> p2pDownload(String fileId, String filename, String savePath,
      {void Function(int received, int total)? onProgress}) async {
    try {
      final request = http.Request('GET', Uri.parse('$baseUrl/api/p2p/download/$fileId'));
      final resp = await request.send().timeout(const Duration(minutes: 10));
      if (resp.statusCode == 200) {
        final total = resp.contentLength ?? 0;
        int received = 0;
        final sink = File(savePath).openWrite();
        await for (final chunk in resp.stream) {
          sink.add(chunk);
          received += chunk.length;
          onProgress?.call(received, total);
        }
        await sink.close();
        return File(savePath);
      }
    } catch (e) { debugPrint('p2pDownload error: $e'); }
    return null;
  }

  /// Delete a P2P shared file.
  Future<void> p2pDelete(String fileId) async {
    try {
      await http.post(Uri.parse('$baseUrl/api/p2p/delete/$fileId')).timeout(const Duration(seconds: 5));
    } catch (_) {}
  }

  /// Get P2P QR code data.
  Future<Map<String, dynamic>?> p2pQR() async {
    try {
      final resp = await http.get(Uri.parse('$baseUrl/api/p2p/qr?_t=${DateTime.now().millisecondsSinceEpoch}')).timeout(const Duration(seconds: 5));
      if (resp.statusCode == 200) return jsonDecode(resp.body);
    } catch (_) {}
    return null;
  }

  /// Preview URL for a P2P file.
  String p2pPreviewUrl(String fileId) => '$baseUrl/api/p2p/preview/$fileId';

  /// Preview URL for a regular file.
  String previewUrl(String filePath) => '$baseUrl/api/preview?path=${Uri.encodeComponent(filePath)}';
}
