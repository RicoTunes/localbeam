import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../models/file_item.dart';
import '../models/server_info.dart';

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
}
