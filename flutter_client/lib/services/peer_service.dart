import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:bonsoir/bonsoir.dart';
import 'package:file_picker/file_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

// ── Constants ─────────────────────────────────────────────────
const _kPort = 7001;
const _kServiceType = '_localbeam._tcp';

// ── Data models ───────────────────────────────────────────────

class DiscoveredPeer {
  final String name;
  final String ip;
  final int port;
  final DateTime seenAt;

  DiscoveredPeer({
    required this.name,
    required this.ip,
    required this.port,
    DateTime? seenAt,
  }) : seenAt = seenAt ?? DateTime.now();

  @override
  bool operator ==(Object other) =>
      other is DiscoveredPeer && other.ip == ip && other.port == port;

  @override
  int get hashCode => Object.hash(ip, port);
}

class IncomingRequest {
  final String fromName;
  final String fromIp;
  final String filename;
  final int fileSize;
  final Completer<bool> _response;

  IncomingRequest({
    required this.fromName,
    required this.fromIp,
    required this.filename,
    required this.fileSize,
    required Completer<bool> response,
  }) : _response = response;

  void accept() => _response.complete(true);
  void decline() => _response.complete(false);
}

enum XferState { idle, requesting, sending, receiving, done, failed }

class TransferInfo {
  final String filename;
  final int totalBytes;
  int sentBytes;
  XferState state;
  String? message;
  bool isSending;

  TransferInfo({
    required this.filename,
    required this.totalBytes,
    this.sentBytes = 0,
    this.state = XferState.idle,
    this.message,
    this.isSending = false,
  });

  double get progress =>
      totalBytes > 0 ? (sentBytes / totalBytes).clamp(0.0, 1.0) : 0;

  String get stateLabel {
    switch (state) {
      case XferState.requesting:
        return 'Waiting for acceptance…';
      case XferState.sending:
        return 'Sending…';
      case XferState.receiving:
        return 'Receiving…';
      case XferState.done:
        return message ?? 'Complete';
      case XferState.failed:
        return 'Failed: ${message ?? 'unknown error'}';
      default:
        return '';
    }
  }
}

// ── PeerService ───────────────────────────────────────────────

class PeerService extends ChangeNotifier {
  // ── State ────────────────────────────────────────────────
  final List<DiscoveredPeer> peers = [];
  IncomingRequest? pendingIncoming;
  TransferInfo? transfer;

  String _deviceName = 'LocalBeam';
  bool _running = false;
  bool _scanning = false;

  String get deviceName => _deviceName;
  bool get isRunning => _running;
  bool get isScanning => _scanning;

  // ── Internals ─────────────────────────────────────────────
  HttpServer? _server;
  BonsoirBroadcast? _broadcast;
  BonsoirDiscovery? _discovery;
  StreamSubscription? _discoverySub;

  // ── Init / lifecycle ──────────────────────────────────────

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _deviceName = prefs.getString('peer_name') ??
        'LocalBeam-${DateTime.now().millisecondsSinceEpoch % 9000 + 1000}';
    await prefs.setString('peer_name', _deviceName);
  }

  Future<void> setDeviceName(String name) async {
    if (name.trim().isEmpty) return;
    _deviceName = name.trim();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('peer_name', _deviceName);
    notifyListeners();
    if (_running) {
      await stop();
      await start();
    }
  }

  Future<void> start() async {
    if (_running) return;
    try {
      await _startHttpServer();
      await _startBroadcast();
      await _startDiscovery();
      _running = true;
      notifyListeners();
    } catch (e) {
      debugPrint('PeerService.start error: $e');
    }
  }

  Future<void> stop() async {
    _running = false;
    await _discoverySub?.cancel();
    await _server?.close(force: true);
    await _broadcast?.stop();
    await _discovery?.stop();
    _server = null;
    _broadcast = null;
    _discovery = null;
    _discoverySub = null;
    peers.clear();
    notifyListeners();
  }

  // ── HTTP Server ───────────────────────────────────────────

  Future<void> _startHttpServer() async {
    _server = await HttpServer.bind(
      InternetAddress.anyIPv4,
      _kPort,
      shared: true,
    );
    _server!.listen(_handleRequest, onError: (e) {
      debugPrint('HTTP server error: $e');
    });
  }

  Future<void> _handleRequest(HttpRequest req) async {
    final path = req.uri.path;
    try {
      if (req.method == 'GET' && path == '/localbeam/ping') {
        _respond(req.response, {'name': _deviceName, 'port': _kPort});
      } else if (req.method == 'POST' && path == '/localbeam/request') {
        await _handleIncomingRequest(req);
      } else if (req.method == 'POST' && path == '/localbeam/send') {
        await _handleReceiveFile(req);
      } else {
        req.response.statusCode = HttpStatus.notFound;
        _respond(req.response, {'error': 'not found'});
      }
    } catch (e) {
      req.response.statusCode = HttpStatus.internalServerError;
      try {
        _respond(req.response, {'error': e.toString()});
      } catch (_) {}
    }
  }

  Future<void> _handleIncomingRequest(HttpRequest req) async {
    final body = jsonDecode(
      await utf8.decoder.bind(req).join(),
    ) as Map<String, dynamic>;

    final fromIp = req.connectionInfo?.remoteAddress.address ?? 'unknown';
    final comp = Completer<bool>();

    pendingIncoming = IncomingRequest(
      fromName: (body['fromName'] as String?) ?? 'Unknown Device',
      fromIp: fromIp,
      filename: (body['filename'] as String?) ?? 'file',
      fileSize: (body['size'] as num?)?.toInt() ?? 0,
      response: comp,
    );
    notifyListeners();

    bool accepted = false;
    try {
      accepted = await comp.future.timeout(const Duration(seconds: 30));
    } on TimeoutException {
      accepted = false;
    }

    pendingIncoming = null;
    notifyListeners();

    _respond(req.response, {'accepted': accepted});
  }

  Future<void> _handleReceiveFile(HttpRequest req) async {
    final rawName = req.headers.value('x-filename') ?? 'received_file';
    final filename = Uri.decodeComponent(rawName);
    final totalSize =
        int.tryParse(req.headers.value('x-filesize') ?? '0') ?? 0;

    transfer = TransferInfo(
      filename: filename,
      totalBytes: totalSize,
      state: XferState.receiving,
      isSending: false,
    );
    notifyListeners();

    try {
      final dir = await getApplicationDocumentsDirectory();
      final saveDir = Directory('${dir.path}/LocalBeam');
      await saveDir.create(recursive: true);

      final savePath = '${saveDir.path}/$filename';
      final sink = File(savePath).openWrite();
      int received = 0;

      await for (final chunk in req) {
        sink.add(chunk);
        received += chunk.length;
        transfer!.sentBytes = received;
        notifyListeners();
      }

      await sink.flush();
      await sink.close();

      transfer!.state = XferState.done;
      transfer!.message = 'Saved to LocalBeam/$filename';
    } catch (e) {
      transfer!.state = XferState.failed;
      transfer!.message = e.toString();
    }
    notifyListeners();

    _respond(req.response, {'ok': true});
  }

  // Accept or decline an incoming transfer request
  void respondToIncoming(bool accept) {
    if (accept) {
      pendingIncoming?.accept();
    } else {
      pendingIncoming?.decline();
    }
  }

  // ── mDNS Broadcast ────────────────────────────────────────

  Future<void> _startBroadcast() async {
    final service = BonsoirService(
      name: _deviceName,
      type: _kServiceType,
      port: _kPort,
      attributes: {'n': _deviceName},
    );
    _broadcast = BonsoirBroadcast(service: service);
    await _broadcast!.initialize();
    await _broadcast!.start();
  }

  // ── mDNS Discovery ────────────────────────────────────────

  Future<void> _startDiscovery() async {
    _discovery = BonsoirDiscovery(type: _kServiceType);
    await _discovery!.initialize();
    _discoverySub = _discovery!.eventStream?.listen(_onDiscoveryEvent);
    await _discovery!.start();
  }

  void _onDiscoveryEvent(BonsoirDiscoveryEvent event) {
    switch (event) {
      case BonsoirDiscoveryServiceFoundEvent():
        event.service?.resolve(_discovery!.serviceResolver);
      case BonsoirDiscoveryServiceResolvedEvent():
        final svc = event.service; // BonsoirService in v6
        final host = svc.host; // String? — populated after resolution
        if (host == null || host.isEmpty) return;
        final name = svc.attributes['n'] ?? svc.name;
        if (name == _deviceName) return;
        final peer = DiscoveredPeer(name: name, ip: host, port: svc.port);
        if (!peers.contains(peer)) {
          peers.add(peer);
          notifyListeners();
        }
      case BonsoirDiscoveryServiceLostEvent():
        final svc = event.service;
        if (svc == null) return;
        final name = svc.attributes['n'] ?? svc.name;
        peers.removeWhere((p) => p.name == name);
        notifyListeners();
      default:
        break;
    }
  }

  // ── Manual subnet scan (fallback) ─────────────────────────

  Future<void> scanSubnet() async {
    if (_scanning) return;
    _scanning = true;
    notifyListeners();

    final ownIp = await _getOwnIp();
    if (ownIp != null) {
      final parts = ownIp.split('.');
      if (parts.length == 4) {
        final base = parts.sublist(0, 3).join('.');
        final futures = List.generate(254, (i) {
          final targetIp = '$base.${i + 1}';
          if (targetIp == ownIp) return Future.value();
          return _probeIp(targetIp);
        });
        await Future.wait(futures);
      }
    }

    _scanning = false;
    notifyListeners();
  }

  Future<void> _probeIp(String ip) async {
    try {
      final client = HttpClient()
        ..connectionTimeout = const Duration(milliseconds: 500);
      final req = await client
          .getUrl(Uri.parse('http://$ip:$_kPort/localbeam/ping'))
          .timeout(const Duration(milliseconds: 700));
      final resp = await req.close().timeout(const Duration(milliseconds: 800));
      final body = jsonDecode(
        await utf8.decoder.bind(resp).join(),
      ) as Map<String, dynamic>;
      client.close();

      final name = (body['name'] as String?) ?? 'LocalBeam Device';
      final port = (body['port'] as num?)?.toInt() ?? _kPort;
      if (name == _deviceName) return;

      final peer = DiscoveredPeer(name: name, ip: ip, port: port);
      if (!peers.contains(peer)) {
        peers.add(peer);
        notifyListeners();
      }
    } catch (_) {
      // Not a LocalBeam device or offline
    }
  }

  // ── Send file to a peer ───────────────────────────────────

  Future<void> pickAndSendFile(DiscoveredPeer peer) async {
    final result = await FilePicker.platform.pickFiles(
      withData: true,
      allowMultiple: false,
    );
    if (result == null || result.files.isEmpty) return;
    await sendFile(peer, result.files.first);
  }

  Future<void> sendFile(DiscoveredPeer peer, PlatformFile file) async {
    // 1 — Show requesting state
    transfer = TransferInfo(
      filename: file.name,
      totalBytes: file.size,
      state: XferState.requesting,
      isSending: true,
    );
    notifyListeners();

    final client = HttpClient();
    try {
      // 2 — Ask for permission
      final reqUri =
          Uri.parse('http://${peer.ip}:${peer.port}/localbeam/request');
      final httpReq = await client
          .postUrl(reqUri)
          .timeout(const Duration(seconds: 5));
      httpReq.headers.contentType = ContentType.json;
      httpReq.write(jsonEncode({
        'fromName': _deviceName,
        'fromPort': _kPort,
        'filename': file.name,
        'size': file.size,
      }));
      final httpResp =
          await httpReq.close().timeout(const Duration(seconds: 35));
      final respBody = jsonDecode(
        await utf8.decoder.bind(httpResp).join(),
      ) as Map<String, dynamic>;

      if (respBody['accepted'] != true) {
        transfer!.state = XferState.failed;
        transfer!.message = 'Transfer declined by ${peer.name}';
        notifyListeners();
        client.close();
        return;
      }

      // 3 — Send file bytes
      transfer!.state = XferState.sending;
      notifyListeners();

      final bytes = file.bytes ?? await File(file.path!).readAsBytes();
      final sendUri =
          Uri.parse('http://${peer.ip}:${peer.port}/localbeam/send');
      final sendReq = await client
          .postUrl(sendUri)
          .timeout(const Duration(seconds: 10));
      sendReq.headers.set('x-filename', Uri.encodeComponent(file.name));
      sendReq.headers.set('x-filesize', bytes.length.toString());
      sendReq.headers.contentType = ContentType.binary;

      const chunkSize = 64 * 1024; // 64 KB chunks
      int offset = 0;
      while (offset < bytes.length) {
        final end = (offset + chunkSize).clamp(0, bytes.length);
        sendReq.add(bytes.sublist(offset, end));
        offset = end;
        transfer!.sentBytes = offset;
        notifyListeners();
        // Brief yield to keep UI responsive
        await Future.delayed(Duration.zero);
      }

      await sendReq.close().timeout(const Duration(seconds: 120));

      transfer!.state = XferState.done;
      transfer!.message = 'Sent to ${peer.name}';
    } catch (e) {
      transfer!.state = XferState.failed;
      transfer!.message = e.toString().replaceAll('Exception:', '').trim();
    } finally {
      client.close();
    }
    notifyListeners();
  }

  // ── Helpers ───────────────────────────────────────────────

  Future<String?> _getOwnIp() async {
    try {
      final interfaces = await NetworkInterface.list(
        type: InternetAddressType.IPv4,
        includeLinkLocal: false,
      );
      for (final iface in interfaces) {
        for (final addr in iface.addresses) {
          if (!addr.isLoopback) return addr.address;
        }
      }
    } catch (_) {}
    return null;
  }

  Future<String?> getOwnIp() => _getOwnIp();

  void _respond(HttpResponse resp, Map<String, dynamic> data) {
    resp.headers.contentType = ContentType.json;
    resp.write(jsonEncode(data));
    resp.close();
  }

  void clearTransfer() {
    transfer = null;
    notifyListeners();
  }

  void refreshPeers() {
    peers.removeWhere(
      (p) => DateTime.now().difference(p.seenAt).inMinutes > 2,
    );
    notifyListeners();
  }
}
