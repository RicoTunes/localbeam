import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
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
  int _serverPort = 5000;
  ServerInfo? _info;
  bool _connected = false;
  String? _error;

  /// Custom HTTP client that trusts self-signed certificates (local network only)
  late final http.Client _client = _createTrustingClient();

  static http.Client _createTrustingClient() {
    final ioClient = HttpClient()
      ..badCertificateCallback = (X509Certificate cert, String host, int port) => true;
    return IOClient(ioClient);
  }

  /// Expose the trusted HTTP client for audio download etc.
  http.Client get trustedClient => _client;

  bool get isConnected => _connected;
  ServerInfo? get info => _info;
  String? get serverIp => _serverIp;
  int get serverPort => _serverPort;
  String? get error => _error;
  String get baseUrl => 'https://$_serverIp:$_serverPort';

  ApiService() {
    _loadSaved();
  }

  Future<void> _loadSaved() async {
    final prefs = await SharedPreferences.getInstance();
    final ip = prefs.getString(_prefKeyIp);
    final port = prefs.getInt(_prefKeyPort) ?? 5000;
    if (ip != null && ip.isNotEmpty) {
      _serverIp = ip;
      _serverPort = port;
      final ok = await checkConnection();
      if (ok) return;
    }
    // If no saved IP or it failed, auto-discover on the network
    final found = await discoverServer();
    if (found != null) {
      await connect(found);
    }
  }

  /// Ensure we have a server connection. Tries saved IP, then auto-discover.
  /// Returns true if connected.
  Future<bool> ensureConnected() async {
    if (_connected && _serverIp != null) return true;
    // Try saved IP first
    if (_serverIp != null && _serverIp!.isNotEmpty) {
      final ok = await checkConnection();
      if (ok) return true;
    }
    // Auto-discover
    final found = await discoverServer();
    if (found != null) {
      return await connect(found);
    }
    return false;
  }

  Future<bool> connect(String ip, {int port = 5000}) async {
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
      final resp = await _client.get(uri).timeout(const Duration(seconds: 5));
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

  /// Discover a LocalBeam server on the local network by scanning subnet.
  /// Returns the IP string if found, or null.
  Future<String?> discoverServer({int port = 5000, void Function(String)? onStatus}) async {
    // Get local IP to determine subnet
    String? localIp;
    try {
      final interfaces = await NetworkInterface.list(type: InternetAddressType.IPv4);
      for (final iface in interfaces) {
        for (final addr in iface.addresses) {
          if (!addr.isLoopback && addr.type == InternetAddressType.IPv4) {
            localIp = addr.address;
            break;
          }
        }
        if (localIp != null) break;
      }
    } catch (_) {}

    if (localIp == null) {
      onStatus?.call('Could not determine local IP');
      return null;
    }

    final subnet = localIp.substring(0, localIp.lastIndexOf('.'));
    onStatus?.call('Scanning $subnet.* ...');

    // Parallel scan all 254 IPs in batches
    const batchSize = 30;
    for (int start = 1; start <= 254; start += batchSize) {
      final end = (start + batchSize - 1).clamp(1, 254);
      final futures = <Future<String?>>[];
      for (int i = start; i <= end; i++) {
        final ip = '$subnet.$i';
        futures.add(_probeServer(ip, port));
      }
      final results = await Future.wait(futures);
      for (final result in results) {
        if (result != null) {
          onStatus?.call('Found server at $result');
          return result;
        }
      }
    }
    onStatus?.call('No server found on network');
    return null;
  }

  Future<String?> _probeServer(String ip, int port) async {
    try {
      final uri = Uri.parse('https://$ip:$port/api/info');
      final resp = await _client.get(uri).timeout(const Duration(seconds: 2));
      if (resp.statusCode == 200) {
        final body = jsonDecode(resp.body);
        if (body is Map && body.containsKey('hostname')) {
          return ip;
        }
      }
    } catch (_) {}
    return null;
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
      final resp = await _client.get(uri).timeout(const Duration(seconds: 10));
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

  /// Download a file to the given savePath using the trusting HTTP client.
  /// Returns the saved File on success, null on failure.
  Future<File?> downloadFile(String filePath, String savePath,
      {void Function(int received, int total)? onProgress}) async {
    try {
      // Use the Flask /api/dl endpoint (works with self-signed cert via _client)
      final url = '$baseUrl/api/dl?path=${Uri.encodeComponent(filePath)}';
      final request = http.Request('GET', Uri.parse(url));
      final resp = await _client.send(request).timeout(const Duration(minutes: 30));
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
    } catch (e) {
      debugPrint('downloadFile error: $e');
    }
    return null;
  }

  /// Get live transfer feed JSON
  Future<String?> getTransfers() async {
    try {
      final resp = await _client
          .get(Uri.parse('$baseUrl/api/transfers'))
          .timeout(const Duration(seconds: 4));
      if (resp.statusCode == 200) return resp.body;
    } catch (_) {}
    return null;
  }

  /// Pause / resume / cancel a transfer
  Future<void> transferAction(String tid, String action) async {
    try {
      await _client
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
      final resp = await _client.post(
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
      final resp = await _client.get(
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
      final resp = await _client.get(
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
      final streamed = await _client.send(request).timeout(const Duration(minutes: 10));
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
      final resp = await _client.send(request).timeout(const Duration(minutes: 10));
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
      await _client.post(Uri.parse('$baseUrl/api/p2p/delete/$fileId')).timeout(const Duration(seconds: 5));
    } catch (_) {}
  }

  /// Get P2P QR code data.
  Future<Map<String, dynamic>?> p2pQR() async {
    try {
      final resp = await _client.get(Uri.parse('$baseUrl/api/p2p/qr?_t=${DateTime.now().millisecondsSinceEpoch}')).timeout(const Duration(seconds: 5));
      if (resp.statusCode == 200) return jsonDecode(resp.body);
    } catch (_) {}
    return null;
  }

  /// Preview URL for a P2P file.
  String p2pPreviewUrl(String fileId) => '$baseUrl/api/p2p/preview/$fileId';

  /// Preview URL for a regular file.
  String previewUrl(String filePath) => '$baseUrl/api/preview?path=${Uri.encodeComponent(filePath)}';

  // ── Chat / Messaging ──────────────────────────────────────────

  /// Send a text (or media) message.
  Future<Map<String, dynamic>?> p2pSendMessage({
    required String senderId,
    required String recipientId,
    required String senderName,
    String text = '',
    String? mediaData,
    String? mediaType,
    String? fileName,
    String? replyTo,
  }) async {
    try {
      final body = <String, dynamic>{
        'sender_id': senderId,
        'recipient_id': recipientId,
        'sender_name': senderName,
        'text': text,
      };
      if (mediaData != null) body['media_data'] = mediaData;
      if (mediaType != null) body['media_type'] = mediaType;
      if (fileName != null) body['file_name'] = fileName;
      if (replyTo != null) body['reply_to'] = replyTo;

      final resp = await _client.post(
        Uri.parse('$baseUrl/api/p2p/messages'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode(body),
      ).timeout(const Duration(seconds: 15));
      if (resp.statusCode == 200) return jsonDecode(resp.body);
    } catch (e) {
      debugPrint('p2pSendMessage error: $e');
    }
    return null;
  }

  /// Get messages for a device, optionally filtered to conversation with [withDevice].
  Future<List<Map<String, dynamic>>> p2pGetMessages(String deviceId, {String? withDevice}) async {
    try {
      var url = '$baseUrl/api/p2p/messages?device_id=$deviceId&_t=${DateTime.now().millisecondsSinceEpoch}';
      if (withDevice != null) url += '&with=$withDevice';
      final resp = await _client.get(Uri.parse(url)).timeout(const Duration(seconds: 8));
      if (resp.statusCode == 200) {
        final data = jsonDecode(resp.body);
        return List<Map<String, dynamic>>.from(data['messages'] ?? []);
      }
    } catch (e) {
      debugPrint('p2pGetMessages error: $e');
    }
    return [];
  }

  /// Mark a message as read.
  Future<void> p2pMarkRead(String messageId) async {
    try {
      await _client.post(Uri.parse('$baseUrl/api/p2p/messages/$messageId/read'))
          .timeout(const Duration(seconds: 5));
    } catch (_) {}
  }

  /// Edit a message text.
  Future<void> p2pEditMessage(String messageId, String newText) async {
    try {
      await _client.post(
        Uri.parse('$baseUrl/api/p2p/messages/$messageId/edit'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'text': newText}),
      ).timeout(const Duration(seconds: 5));
    } catch (e) {
      debugPrint('p2pEditMessage error: $e');
    }
  }

  /// Delete a message.
  Future<void> p2pDeleteMessage(String messageId) async {
    try {
      await _client.delete(Uri.parse('$baseUrl/api/p2p/messages/$messageId'))
          .timeout(const Duration(seconds: 5));
    } catch (_) {}
  }

  /// Signal typing.
  Future<void> p2pSendTyping(String senderId, String recipientId) async {
    try {
      await _client.post(
        Uri.parse('$baseUrl/api/p2p/typing'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'sender_id': senderId, 'recipient_id': recipientId}),
      ).timeout(const Duration(seconds: 3));
    } catch (_) {}
  }

  /// Check who is typing to this device.
  Future<List<Map<String, dynamic>>> p2pGetTyping(String deviceId) async {
    try {
      final resp = await _client.get(
        Uri.parse('$baseUrl/api/p2p/typing/$deviceId'),
      ).timeout(const Duration(seconds: 3));
      if (resp.statusCode == 200) {
        final data = jsonDecode(resp.body);
        return List<Map<String, dynamic>>.from(data['typing'] ?? []);
      }
    } catch (_) {}
    return [];
  }

  /// Get media URL for a message.
  String p2pMediaUrl(String messageId) => '$baseUrl/api/p2p/media/$messageId';

  /// Fetch raw media bytes for a message (uses trusting client).
  Future<List<int>?> p2pMediaBytes(String messageId) async {
    try {
      final resp = await _client.get(Uri.parse('$baseUrl/api/p2p/media/$messageId'))
          .timeout(const Duration(seconds: 30));
      if (resp.statusCode == 200) return resp.bodyBytes;
    } catch (e) {
      debugPrint('p2pMediaBytes error: $e');
    }
    return null;
  }

  // ── Auth & Friends ────────────────────────────────────────────

  String? _authToken;
  Map<String, dynamic>? _currentUser;

  String? get authToken => _authToken;
  Map<String, dynamic>? get currentUser => _currentUser;
  bool get isLoggedIn => _authToken != null && _currentUser != null;

  Future<void> loadAuthState() async {
    final prefs = await SharedPreferences.getInstance();
    _authToken = prefs.getString('auth_token');
    final userData = prefs.getString('auth_user');
    if (userData != null) {
      try { _currentUser = jsonDecode(userData); } catch (_) {}
    }
    notifyListeners();
  }

  Future<void> _saveAuthState() async {
    final prefs = await SharedPreferences.getInstance();
    if (_authToken != null) {
      await prefs.setString('auth_token', _authToken!);
    } else {
      await prefs.remove('auth_token');
    }
    if (_currentUser != null) {
      await prefs.setString('auth_user', jsonEncode(_currentUser));
    } else {
      await prefs.remove('auth_user');
    }
  }

  /// Register a new account.
  /// Tries server first; falls back to local on-device registration.
  Future<Map<String, dynamic>> authRegister({
    required String name,
    String email = '',
    String phone = '',
    required String password,
  }) async {
    // Try server registration if connected
    if (_connected && _serverIp != null) {
      try {
        final resp = await _client.post(
          Uri.parse('$baseUrl/api/auth/register'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'name': name, 'email': email, 'phone': phone, 'password': password}),
        ).timeout(const Duration(seconds: 10));
        final data = jsonDecode(resp.body);
        // Also save locally so it works offline later
        await _localRegister(name: name, email: email, phone: phone, password: password);
        return data;
      } catch (e) {
        debugPrint('Server register failed, using local: $e');
      }
    }
    // Fallback: local on-device registration
    return _localRegister(name: name, email: email, phone: phone, password: password);
  }

  /// Local on-device registration (SharedPreferences).
  Future<Map<String, dynamic>> _localRegister({
    required String name, String email = '', String phone = '', required String password,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final usersRaw = prefs.getString('local_users') ?? '[]';
    final users = List<Map<String, dynamic>>.from(jsonDecode(usersRaw));

    // Check duplicates
    for (final u in users) {
      if ((email.isNotEmpty && u['email'] == email) || (phone.isNotEmpty && u['phone'] == phone)) {
        return {'error': 'Account already exists with that email or phone'};
      }
    }

    final userId = 'local_${DateTime.now().millisecondsSinceEpoch}';
    final user = {
      'id': userId,
      'name': name,
      'email': email,
      'phone': phone,
      'password': password, // In production hash this; local-only for now
      'created_at': DateTime.now().toIso8601String(),
    };
    users.add(user);
    await prefs.setString('local_users', jsonEncode(users));
    return {'success': true, 'message': 'Account created successfully'};
  }

  /// Login with email/phone + password.
  /// Tries server first; falls back to local on-device login.
  Future<Map<String, dynamic>> authLogin({
    required String identifier,
    required String password,
  }) async {
    // Try server login if connected
    if (_connected && _serverIp != null) {
      try {
        final resp = await _client.post(
          Uri.parse('$baseUrl/api/auth/login'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'identifier': identifier, 'password': password}),
        ).timeout(const Duration(seconds: 10));
        final data = jsonDecode(resp.body);
        if (resp.statusCode == 200 && data['success'] == true) {
          _authToken = data['token'];
          _currentUser = data['user'];
          await _saveAuthState();
          notifyListeners();
          return data;
        }
        // If server says wrong credentials, don't fall back to local
        if (resp.statusCode == 401 || data['error'] != null) {
          // Still try local in case they registered locally
          final localResult = await _localLogin(identifier: identifier, password: password);
          if (localResult['success'] == true) return localResult;
          return data;
        }
      } catch (e) {
        debugPrint('Server login failed, trying local: $e');
      }
    }
    // Fallback: local on-device login
    return _localLogin(identifier: identifier, password: password);
  }

  /// Local on-device login (SharedPreferences).
  Future<Map<String, dynamic>> _localLogin({
    required String identifier, required String password,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final usersRaw = prefs.getString('local_users') ?? '[]';
    final users = List<Map<String, dynamic>>.from(jsonDecode(usersRaw));

    for (final u in users) {
      final match = (u['email'] == identifier || u['phone'] == identifier);
      if (match && u['password'] == password) {
        _authToken = 'local_token_${u['id']}';
        _currentUser = {
          'id': u['id'],
          'name': u['name'],
          'email': u['email'] ?? '',
          'phone': u['phone'] ?? '',
        };
        await _saveAuthState();
        notifyListeners();
        return {'success': true, 'token': _authToken, 'user': _currentUser};
      }
    }
    return {'error': 'Invalid email/phone or password'};
  }

  /// Logout.
  Future<void> authLogout() async {
    _authToken = null;
    _currentUser = null;
    await _saveAuthState();
    notifyListeners();
  }

  /// Get profile with resolved friend details.
  Future<Map<String, dynamic>?> authProfile() async {
    if (_authToken == null) return null;
    try {
      final resp = await _client.get(
        Uri.parse('$baseUrl/api/auth/profile'),
        headers: {'Authorization': 'Bearer $_authToken'},
      ).timeout(const Duration(seconds: 8));
      if (resp.statusCode == 200) {
        final data = jsonDecode(resp.body);
        _currentUser = data['user'];
        await _saveAuthState();
        notifyListeners();
        return data;
      }
      if (resp.statusCode == 401) {
        _authToken = null;
        _currentUser = null;
        await _saveAuthState();
        notifyListeners();
      }
    } catch (e) {
      debugPrint('authProfile error: $e');
    }
    return null;
  }

  /// Link current P2P device to user account.
  Future<bool> authLinkDevice(String deviceId) async {
    if (_authToken == null) return false;
    try {
      final resp = await _client.post(
        Uri.parse('$baseUrl/api/auth/link-device'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $_authToken'},
        body: jsonEncode({'device_id': deviceId}),
      ).timeout(const Duration(seconds: 5));
      return resp.statusCode == 200;
    } catch (_) {}
    return false;
  }

  /// Add friend by email or phone.
  Future<Map<String, dynamic>> authAddFriend(String identifier) async {
    if (_authToken == null) return {'error': 'Not logged in'};
    try {
      final resp = await _client.post(
        Uri.parse('$baseUrl/api/auth/friends/add'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $_authToken'},
        body: jsonEncode({'identifier': identifier}),
      ).timeout(const Duration(seconds: 8));
      return jsonDecode(resp.body);
    } catch (e) {
      return {'error': e.toString()};
    }
  }

  /// Remove friend.
  Future<bool> authRemoveFriend(String friendId) async {
    if (_authToken == null) return false;
    try {
      final resp = await _client.post(
        Uri.parse('$baseUrl/api/auth/friends/remove'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $_authToken'},
        body: jsonEncode({'friend_id': friendId}),
      ).timeout(const Duration(seconds: 5));
      return resp.statusCode == 200;
    } catch (_) {}
    return false;
  }

  /// Get pending friend requests (incoming + outgoing).
  Future<Map<String, dynamic>> authFriendRequests() async {
    if (_authToken == null) return {'incoming': [], 'outgoing': []};
    try {
      final resp = await _client.get(
        Uri.parse('$baseUrl/api/auth/friends/requests'),
        headers: {'Authorization': 'Bearer $_authToken'},
      ).timeout(const Duration(seconds: 8));
      if (resp.statusCode == 200) {
        return jsonDecode(resp.body);
      }
    } catch (e) {
      debugPrint('authFriendRequests error: $e');
    }
    return {'incoming': [], 'outgoing': []};
  }

  /// Accept a friend request.
  Future<Map<String, dynamic>> authAcceptFriend(String requestId) async {
    if (_authToken == null) return {'error': 'Not logged in'};
    try {
      final resp = await _client.post(
        Uri.parse('$baseUrl/api/auth/friends/accept'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $_authToken'},
        body: jsonEncode({'request_id': requestId}),
      ).timeout(const Duration(seconds: 8));
      return jsonDecode(resp.body);
    } catch (e) {
      return {'error': e.toString()};
    }
  }

  /// Reject/cancel a friend request.
  Future<bool> authRejectFriend(String requestId) async {
    if (_authToken == null) return false;
    try {
      final resp = await _client.post(
        Uri.parse('$baseUrl/api/auth/friends/reject'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $_authToken'},
        body: jsonEncode({'request_id': requestId}),
      ).timeout(const Duration(seconds: 5));
      return resp.statusCode == 200;
    } catch (_) {}
    return false;
  }

  // ── Status / Stories ──────────────────────────────────────────

  /// Post a new status with optional base64 media and caption.
  Future<Map<String, dynamic>> statusPost({
    String mediaData = '',
    String mediaType = 'image/jpeg',
    String caption = '',
    String bgColor = '',
  }) async {
    if (_authToken == null) return {'error': 'Not logged in'};
    try {
      final resp = await _client.post(
        Uri.parse('$baseUrl/api/status/post'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $_authToken'},
        body: jsonEncode({
          'media_data': mediaData,
          'media_type': mediaType,
          'caption': caption,
          'bg_color': bgColor,
        }),
      ).timeout(const Duration(seconds: 30));
      if (resp.body.trimLeft().startsWith('<')) {
        return {'error': 'Server needs restart to enable status feature'};
      }
      return jsonDecode(resp.body);
    } catch (e) {
      return {'error': e.toString()};
    }
  }

  /// Get status feed (self + friends).
  Future<List<dynamic>> statusFeed() async {
    if (_authToken == null) return [];
    try {
      final resp = await _client.get(
        Uri.parse('$baseUrl/api/status/feed'),
        headers: {'Authorization': 'Bearer $_authToken'},
      ).timeout(const Duration(seconds: 10));
      if (resp.statusCode == 200 && !resp.body.trimLeft().startsWith('<')) {
        final data = jsonDecode(resp.body);
        return (data['feed'] as List?) ?? [];
      }
    } catch (e) {
      debugPrint('statusFeed error: $e');
    }
    return [];
  }

  /// Get media URL for a status.
  String statusMediaUrl(String statusId) => '$baseUrl/api/status/media/$statusId';

  /// Mark status as viewed.
  Future<void> statusView(String statusId) async {
    if (_authToken == null) return;
    try {
      await _client.post(
        Uri.parse('$baseUrl/api/status/view'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $_authToken'},
        body: jsonEncode({'status_id': statusId}),
      ).timeout(const Duration(seconds: 5));
    } catch (_) {}
  }

  /// Delete own status.
  Future<bool> statusDelete(String statusId) async {
    if (_authToken == null) return false;
    try {
      final resp = await _client.post(
        Uri.parse('$baseUrl/api/status/delete'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $_authToken'},
        body: jsonEncode({'status_id': statusId}),
      ).timeout(const Duration(seconds: 5));
      return resp.statusCode == 200;
    } catch (_) {}
    return false;
  }

  // ── BEAM AI ───────────────────────────────────────────────────

  // Direct DeepSeek API key for standalone mode (no server needed)
  static const _deepSeekApiKey = String.fromEnvironment('DEEPSEEK_API_KEY');
  static const _deepSeekUrl = 'https://api.deepseek.com/chat/completions';

  // Groq — ultra-fast inference (free, ~10x faster than DeepSeek)
  static const _groqApiKey = String.fromEnvironment('GROQ_API_KEY');
  static const _groqChatUrl = 'https://api.groq.com/openai/v1/chat/completions';

  // Persistent conversation history for standalone mode
  final List<Map<String, String>> _localConversation = [];

  /// Smart chat: always tries server first (for web search, tasks, etc.),
  /// falls back to direct DeepSeek only if server is unreachable.
  Future<Map<String, dynamic>> beamChatSmart(String deviceId, String text) async {
    return beamChatSmartWithTone(deviceId, text, 'friendly');
  }

  Future<Map<String, dynamic>> beamChatSmartWithTone(String deviceId, String text, String tone) async {
    // Skip slow server discovery for voice — go straight to Groq (instant)
    // If already connected, try server first
    if (_connected) {
      try {
        final result = await beamChat(deviceId, text);
        if (result['error'] == null) return result;
      } catch (_) {}
    }
    // Direct AI: Groq (ultra-fast) → DeepSeek fallback
    return _beamChatDirect(text, tone);
  }

  static const _voiceSystemPromptBase =
    'You are BEAM, a warm, witty, and empathetic AI companion. '
    'You speak naturally — casual, warm, with personality. '
    'Use short sentences. React emotionally ("Oh wow!", "Hmm, that\'s tricky...", "Ha, nice!"). '
    'Never say "As an AI" or "I\'m just a language model". You are a person having a real conversation. '
    'Be concise — voice replies should be 1-3 sentences max unless the user asks for detail. '
    'You remember the conversation context. '
    'IMPORTANT: Never use emoji, markdown, asterisks, hashtags, or any special formatting. '
    'Write plain spoken English only — as if you are literally talking out loud.';

  static const _toneInstructions = {
    'friendly': 'Be a fun, supportive best friend. Use humor, slang, and genuine curiosity. Say things like "Yo that\'s awesome!" or "Aww I feel you". Ask follow-up questions.',
    'professional': 'Be polite, articulate, and composed like a senior executive or consultant. Use precise language. Avoid slang. Be helpful but maintain a formal, respectful tone.',
    'encouraging': 'Be a passionate motivational coach! Hype the user up. Say things like "You got this!", "That\'s incredible, keep going!", "I believe in you 100%". Be energetic and uplifting.',
  };

  static String _buildVoicePrompt(String tone) {
    final toneExtra = _toneInstructions[tone] ?? _toneInstructions['friendly']!;
    return '$_voiceSystemPromptBase\nTONE STYLE: $toneExtra';
  }

  /// Call AI directly — tries Groq (instant) first, falls back to DeepSeek.
  Future<Map<String, dynamic>> _beamChatDirect(String text, [String tone = 'friendly']) async {
    _localConversation.add({'role': 'user', 'content': text});
    if (_localConversation.length > 20) {
      _localConversation.removeRange(0, _localConversation.length - 20);
    }

    final messages = <Map<String, String>>[
      {'role': 'system', 'content': _buildVoicePrompt(tone)},
      ..._localConversation,
    ];

    // 1) Try Groq — blazing fast (~0.3-1s response)
    try {
      final groqReply = await _callChatApi(
        _groqChatUrl, _groqApiKey, 'llama-3.3-70b-versatile', messages,
        maxTokens: 256, temperature: 0.8, timeout: 10,
      );
      if (groqReply != null) {
        _localConversation.add({'role': 'assistant', 'content': groqReply});
        return {'reply': groqReply, 'actions': []};
      }
    } catch (e) {
      debugPrint('Groq chat failed: $e');
    }

    // 2) Fallback to DeepSeek
    try {
      final dsReply = await _callChatApi(
        _deepSeekUrl, _deepSeekApiKey, 'deepseek-chat', messages,
        maxTokens: 1024, temperature: 0.7, timeout: 30,
      );
      if (dsReply != null) {
        _localConversation.add({'role': 'assistant', 'content': dsReply});
        return {'reply': dsReply, 'actions': []};
      }
    } catch (e) {
      debugPrint('DeepSeek chat failed: $e');
    }

    return {'error': 'Could not reach AI. Check your internet connection.'};
  }

  /// Generic OpenAI-compatible chat API caller.
  Future<String?> _callChatApi(
    String url, String apiKey, String model,
    List<Map<String, String>> messages, {
    int maxTokens = 512,
    double temperature = 0.7,
    int timeout = 15,
  }) async {
    final httpClient = HttpClient()
      ..badCertificateCallback = (cert, host, port) => true;
    final request = await httpClient.postUrl(Uri.parse(url));
    request.headers.set('Content-Type', 'application/json; charset=utf-8');
    request.headers.set('Authorization', 'Bearer $apiKey');
    request.add(utf8.encode(jsonEncode({
      'model': model,
      'messages': messages,
      'max_tokens': maxTokens,
      'temperature': temperature,
    })));

    final response = await request.close().timeout(Duration(seconds: timeout));
    final body = await response.transform(utf8.decoder).join();

    if (response.statusCode == 200) {
      final data = jsonDecode(body);
      final reply = data['choices']?[0]?['message']?['content'];
      return reply?.toString().trim();
    }
    debugPrint('Chat API $model error ${response.statusCode}: $body');
    return null;
  }

  /// Send a chat message to BEAM AI and get a reply.
  Future<Map<String, dynamic>> beamChat(String deviceId, String text) async {
    try {
      final resp = await _client.post(
        Uri.parse('$baseUrl/api/ai/chat'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'owner_id': deviceId, 'text': text}),
      ).timeout(const Duration(seconds: 60));
      if (resp.statusCode == 200) return jsonDecode(resp.body);
      return {'error': 'Server error ${resp.statusCode}'};
    } catch (e) {
      return {'error': e.toString()};
    }
  }

  /// Send a voice transcript to BEAM AI and get a reply with TTS audio.
  Future<Map<String, dynamic>> beamTranscribe(String deviceId, String transcript, {bool tts = true}) async {
    try {
      final resp = await _client.post(
        Uri.parse('$baseUrl/api/ai/transcribe'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'owner_id': deviceId, 'transcript': transcript, 'tts': tts}),
      ).timeout(const Duration(seconds: 60));
      if (resp.statusCode == 200) return jsonDecode(resp.body);
      return {'error': 'Server error ${resp.statusCode}'};
    } catch (e) {
      return {'error': e.toString()};
    }
  }

  /// Generate TTS audio for text.
  Future<Map<String, dynamic>> beamTTS(String text, {String? voice}) async {
    try {
      final body = <String, dynamic>{'text': text};
      if (voice != null) body['voice'] = voice;
      final resp = await _client.post(
        Uri.parse('$baseUrl/api/ai/tts'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode(body),
      ).timeout(const Duration(seconds: 30));
      if (resp.statusCode == 200) return jsonDecode(resp.body);
      return {'error': 'TTS failed'};
    } catch (e) {
      return {'error': e.toString()};
    }
  }

  /// Upload a file for AI analysis (image, document, audio, scan).
  Future<Map<String, dynamic>> beamProcessFile(String deviceId, File file, String action, {String question = ''}) async {
    try {
      final request = http.MultipartRequest('POST', Uri.parse('$baseUrl/api/ai/process-file'));
      request.fields['owner_id'] = deviceId;
      request.fields['action'] = action;
      if (question.isNotEmpty) request.fields['question'] = question;
      request.files.add(await http.MultipartFile.fromPath('file', file.path));
      final streamed = await _client.send(request).timeout(const Duration(minutes: 2));
      final respBody = await streamed.stream.bytesToString();
      if (streamed.statusCode == 200) return jsonDecode(respBody);
      return {'error': 'Server error ${streamed.statusCode}'};
    } catch (e) {
      return {'error': e.toString()};
    }
  }

  /// Get all reminders.
  Future<List<Map<String, dynamic>>> beamGetReminders(String deviceId) async {
    try {
      final resp = await _client.get(
        Uri.parse('$baseUrl/api/ai/reminders?device_id=$deviceId'),
      ).timeout(const Duration(seconds: 8));
      if (resp.statusCode == 200) {
        final data = jsonDecode(resp.body);
        return List<Map<String, dynamic>>.from(data['reminders'] ?? []);
      }
    } catch (_) {}
    return [];
  }

  /// Get all tasks.
  Future<List<Map<String, dynamic>>> beamGetTasks(String deviceId) async {
    try {
      final resp = await _client.get(
        Uri.parse('$baseUrl/api/ai/tasks?owner_id=$deviceId'),
      ).timeout(const Duration(seconds: 8));
      if (resp.statusCode == 200) {
        final data = jsonDecode(resp.body);
        return List<Map<String, dynamic>>.from(data['tasks'] ?? []);
      }
    } catch (_) {}
    return [];
  }

  /// Delete a task.
  Future<void> beamDeleteTask(String taskId) async {
    try {
      await _client.delete(Uri.parse('$baseUrl/api/ai/tasks/$taskId'))
          .timeout(const Duration(seconds: 5));
    } catch (_) {}
  }

  /// Delete a reminder.
  Future<void> beamDeleteReminder(String remId) async {
    try {
      await _client.delete(Uri.parse('$baseUrl/api/ai/reminders/$remId'))
          .timeout(const Duration(seconds: 5));
    } catch (_) {}
  }
}
