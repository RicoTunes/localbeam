import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:file_picker/file_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/api_service.dart';

// ─────────────────────────────────────────────────────────────
// ShareScreen  — server-relayed phone-to-phone file sharing
// Mirrors the web browser's Share tab functionality
// ─────────────────────────────────────────────────────────────
class ShareScreen extends StatefulWidget {
  const ShareScreen({super.key});
  @override
  State<ShareScreen> createState() => _ShareScreenState();
}

class _ShareScreenState extends State<ShareScreen>
    with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;

  String _deviceId = '';
  String _deviceName = '';
  List<P2PDevice> _devices = [];
  List<P2PFile> _files = [];
  Timer? _pollTimer;
  bool _sending = false;
  double _sendProgress = 0;
  String? _sendingName;
  bool _downloading = false;
  double _dlProgress = 0;
  String? _dlName;
  String? _qrData; // base64 QR
  bool _qrExpanded = true;

  // Transfer history (local)
  List<Map<String, dynamic>> _history = [];

  @override
  void initState() {
    super.initState();
    _loadHistory();
    WidgetsBinding.instance.addPostFrameCallback((_) => _init());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  // ── Init & register ───────────────────────────────────────
  Future<void> _init() async {
    final prefs = await SharedPreferences.getInstance();
    _deviceId = prefs.getString('p2p_device_id') ?? '';
    _deviceName = prefs.getString('p2p_device_name') ?? '';

    await _register();
    _startPolling();
    _loadQR();
  }

  Future<void> _register() async {
    final api = context.read<ApiService>();
    final result = await api.p2pRegister(
      deviceId: _deviceId.isNotEmpty ? _deviceId : null,
      name: _deviceName.isNotEmpty ? _deviceName : null,
    );
    if (result != null) {
      _deviceId = result['device_id'] ?? _deviceId;
      _deviceName = result['name'] ?? _deviceName;
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('p2p_device_id', _deviceId);
      await prefs.setString('p2p_device_name', _deviceName);
      if (mounted) setState(() {});
    }
  }

  void _startPolling() {
    _pollTimer?.cancel();
    _poll();
    _pollTimer = Timer.periodic(const Duration(seconds: 3), (_) => _poll());
  }

  Future<void> _poll() async {
    if (!mounted) return;
    final api = context.read<ApiService>();

    // heartbeat
    api.p2pRegister(deviceId: _deviceId, name: _deviceName);

    final devices = await api.p2pDevices();
    final files = await api.p2pFiles();
    if (mounted) {
      setState(() {
        _devices = devices;
        _files = files;
      });
    }
  }

  // ── QR ────────────────────────────────────────────────────
  Future<void> _loadQR() async {
    final api = context.read<ApiService>();
    final data = await api.p2pQR();
    if (data != null && mounted) {
      setState(() => _qrData = data['qr'] as String?);
    }
  }

  // ── Rename ────────────────────────────────────────────────
  Future<void> _rename() async {
    final ctrl = TextEditingController(text: _deviceName);
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Device Name'),
        content: TextField(controller: ctrl, autofocus: true,
          decoration: const InputDecoration(hintText: 'Enter name')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('Save')),
        ],
      ),
    );
    if (name != null && name.isNotEmpty) {
      _deviceName = name;
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('p2p_device_name', _deviceName);
      _register();
    }
  }

  // ── Send files ────────────────────────────────────────────
  Future<void> _sendFiles() async {
    final result = await FilePicker.platform.pickFiles(allowMultiple: true);
    if (result == null || result.files.isEmpty) return;

    final api = context.read<ApiService>();
    setState(() { _sending = true; _sendProgress = 0; });

    for (int i = 0; i < result.files.length; i++) {
      final pf = result.files[i];
      if (pf.path == null) continue;
      setState(() {
        _sendingName = '${pf.name} (${i + 1}/${result.files.length})';
        _sendProgress = 0;
      });

      final fileId = await api.p2pSendFile(File(pf.path!), _deviceId);
      if (fileId != null) {
        _addHistory(pf.name, pf.size ?? 0, 'sent');
      }
      setState(() => _sendProgress = 1.0);
    }

    setState(() { _sending = false; _sendingName = null; });
    _poll();
  }

  // ── Download file ─────────────────────────────────────────
  Future<void> _downloadFile(P2PFile f) async {
    final api = context.read<ApiService>();
    final dir = await getExternalStorageDirectory() ?? await getApplicationDocumentsDirectory();
    final savePath = '${dir.path}/${f.name}';

    setState(() { _downloading = true; _dlProgress = 0; _dlName = f.name; });

    final file = await api.p2pDownload(f.id, f.name, savePath,
      onProgress: (received, total) {
        if (total > 0 && mounted) {
          setState(() => _dlProgress = received / total);
        }
      },
    );

    if (file != null) {
      _addHistory(f.name, f.size, 'received');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Downloaded ${f.name}'), backgroundColor: const Color(0xFF22C55E)),
        );
      }
    }

    setState(() { _downloading = false; _dlName = null; });
  }

  // ── Delete file ───────────────────────────────────────────
  Future<void> _deleteFile(String fileId) async {
    await context.read<ApiService>().p2pDelete(fileId);
    _poll();
  }

  // ── History ───────────────────────────────────────────────
  Future<void> _loadHistory() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString('p2p_history') ?? '[]';
    try {
      _history = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
    } catch (_) {
      _history = [];
    }
  }

  Future<void> _addHistory(String name, int size, String type) async {
    _history.insert(0, {'name': name, 'size': size, 'type': type, 'time': DateTime.now().millisecondsSinceEpoch});
    if (_history.length > 50) _history = _history.sublist(0, 50);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('p2p_history', jsonEncode(_history));
    if (mounted) setState(() {});
  }

  Future<void> _clearHistory() async {
    _history.clear();
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('p2p_history');
    if (mounted) setState(() {});
  }

  // ── Helpers ───────────────────────────────────────────────
  String _formatSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    if (bytes < 1024 * 1024 * 1024) return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
    return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB';
  }

  String _timeAgo(int ms) {
    final s = (DateTime.now().millisecondsSinceEpoch - ms) ~/ 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return '${s ~/ 60}m ago';
    if (s < 86400) return '${s ~/ 3600}h ago';
    return '${s ~/ 86400}d ago';
  }

  IconData _fileIcon(String name) {
    final ext = name.contains('.') ? '.${name.split('.').last.toLowerCase()}' : '';
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].contains(ext)) return Icons.image;
    if (['.mp4', '.avi', '.mov', '.mkv', '.wmv'].contains(ext)) return Icons.videocam;
    if (['.mp3', '.wav', '.flac', '.aac', '.ogg'].contains(ext)) return Icons.audiotrack;
    if (['.pdf'].contains(ext)) return Icons.picture_as_pdf;
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].contains(ext)) return Icons.archive;
    if (['.apk'].contains(ext)) return Icons.android;
    return Icons.insert_drive_file;
  }

  // ── BUILD ─────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    super.build(context);
    final others = _devices.where((d) => d.id != _deviceId).toList();

    return Scaffold(
      backgroundColor: const Color(0xFF0F172A),
      appBar: AppBar(
        backgroundColor: const Color(0xFF1E293B),
        title: const Text('Share', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
        actions: [
          IconButton(
            onPressed: _poll,
            icon: const Icon(Icons.refresh, color: Color(0xFF94A3B8)),
            tooltip: 'Refresh',
          ),
        ],
        elevation: 0,
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // ── My Device card ─────────────────────────────
          _buildMyDevice(),
          const SizedBox(height: 16),

          // ── QR Code ────────────────────────────────────
          _buildQRCard(),
          const SizedBox(height: 16),

          // ── Connected devices ──────────────────────────
          _sectionHeader(Icons.wifi, 'Connected Devices', count: others.length),
          const SizedBox(height: 8),
          if (others.isEmpty)
            _emptyState(Icons.search, 'No other devices connected')
          else
            ...others.map(_buildDeviceTile),
          const SizedBox(height: 16),

          // ── Send button ────────────────────────────────
          _buildSendButton(),
          const SizedBox(height: 12),

          // ── Send progress ──────────────────────────────
          if (_sending) _buildProgress(_sendingName ?? 'Sending…', _sendProgress, const Color(0xFF667EEA)),
          if (_downloading) _buildProgress('Downloading ${_dlName ?? ''}', _dlProgress, const Color(0xFF4ADE80)),

          // ── Shared files ───────────────────────────────
          const SizedBox(height: 16),
          _sectionHeader(Icons.inbox, 'Shared Files', count: _files.length),
          const SizedBox(height: 8),
          if (_files.isEmpty)
            _emptyState(Icons.inbox_outlined, 'No files shared yet')
          else
            ..._files.map(_buildFileTile),

          // ── History ────────────────────────────────────
          const SizedBox(height: 20),
          Row(children: [
            _sectionHeader(Icons.history, 'History', count: _history.length),
            const Spacer(),
            if (_history.isNotEmpty)
              IconButton(
                icon: const Icon(Icons.delete_outline, color: Color(0xFFEF4444), size: 18),
                onPressed: _clearHistory,
                tooltip: 'Clear',
              ),
          ]),
          const SizedBox(height: 8),
          if (_history.isEmpty)
            _emptyState(Icons.history, 'No transfer history')
          else
            ..._history.take(20).map(_buildHistoryTile),

          const SizedBox(height: 80),
        ],
      ),
    );
  }

  // ── Widgets ────────────────────────────────────────────────

  Widget _buildMyDevice() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: LinearGradient(colors: [
          const Color(0xFF667EEA).withOpacity(.15),
          const Color(0xFF764BA2).withOpacity(.10),
        ]),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF667EEA).withOpacity(.2)),
      ),
      child: Row(children: [
        Container(
          width: 44, height: 44,
          decoration: BoxDecoration(
            gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF764BA2)]),
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Icon(Icons.phone_android, color: Colors.white, size: 22),
        ),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(_deviceName.isNotEmpty ? _deviceName : 'My Device',
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 15)),
          Text(_deviceId.isNotEmpty ? 'ID: $_deviceId' : 'Connecting…',
            style: TextStyle(color: Colors.white.withOpacity(.4), fontSize: 11, fontFamily: 'monospace')),
        ])),
        IconButton(
          icon: const Icon(Icons.edit, color: Color(0xFF667EEA), size: 18),
          onPressed: _rename,
        ),
      ]),
    );
  }

  Widget _buildQRCard() {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 250),
      padding: EdgeInsets.all(_qrExpanded ? 16 : 12),
      decoration: BoxDecoration(
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF667EEA).withOpacity(.15)),
      ),
      child: Column(children: [
        InkWell(
          onTap: () => setState(() => _qrExpanded = !_qrExpanded),
          child: Row(children: [
            const Icon(Icons.qr_code, color: Color(0xFF667EEA), size: 18),
            const SizedBox(width: 8),
            const Text('Scan to Join',
              style: TextStyle(color: Color(0xFF94A3B8), fontSize: 12, fontWeight: FontWeight.w700,
                letterSpacing: .5)),
            const Spacer(),
            Icon(_qrExpanded ? Icons.expand_less : Icons.expand_more, color: const Color(0xFF667EEA), size: 20),
          ]),
        ),
        if (_qrExpanded && _qrData != null) ...[
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: Image.memory(
              base64Decode(_qrData!.replaceFirst('data:image/png;base64,', '')),
              width: 160, height: 160, fit: BoxFit.contain,
            ),
          ),
        ],
      ]),
    );
  }

  Widget _buildDeviceTile(P2PDevice d) {
    final isOnline = d.isOnline;
    IconData icon = d.userAgent.contains('iPhone') ? Icons.phone_iphone :
                    d.userAgent.contains('Android') ? Icons.phone_android : Icons.devices;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.white.withOpacity(.04)),
      ),
      child: Row(children: [
        Container(
          width: 38, height: 38,
          decoration: BoxDecoration(
            gradient: const LinearGradient(colors: [Color(0xFF3B82F6), Color(0xFF2563EB)]),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(icon, color: Colors.white, size: 18),
        ),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(d.name, style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w500)),
          Text(isOnline ? 'Online' : 'Offline',
            style: TextStyle(color: isOnline ? const Color(0xFF4ADE80) : const Color(0xFF64748B), fontSize: 11)),
        ])),
        Container(
          width: 10, height: 10,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: isOnline ? const Color(0xFF4ADE80) : const Color(0xFF475569),
            boxShadow: isOnline ? [BoxShadow(color: const Color(0xFF4ADE80).withOpacity(.5), blurRadius: 6)] : null,
          ),
        ),
      ]),
    );
  }

  Widget _buildSendButton() {
    return SizedBox(
      width: double.infinity,
      height: 50,
      child: ElevatedButton.icon(
        onPressed: _sending ? null : _sendFiles,
        icon: const Icon(Icons.send, size: 20),
        label: const Text('Send Files', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        style: ElevatedButton.styleFrom(
          backgroundColor: const Color(0xFF667EEA),
          foregroundColor: Colors.white,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          elevation: 0,
        ),
      ),
    );
  }

  Widget _buildProgress(String label, double progress, Color color) {
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withOpacity(.2)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600),
          overflow: TextOverflow.ellipsis),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(2),
          child: LinearProgressIndicator(
            value: progress, minHeight: 4,
            backgroundColor: const Color(0xFF263246),
            valueColor: AlwaysStoppedAnimation(color),
          ),
        ),
        const SizedBox(height: 4),
        Text('${(progress * 100).toInt()}%',
          style: TextStyle(color: Colors.white.withOpacity(.5), fontSize: 11)),
      ]),
    );
  }

  Widget _buildFileTile(P2PFile f) {
    final isMine = f.senderId == _deviceId;
    final sender = isMine ? 'You' : f.senderName;
    final expiryMin = f.expiresInMin;
    final isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']
        .any((e) => f.name.toLowerCase().endsWith(e));

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.white.withOpacity(.04)),
      ),
      child: Row(children: [
        // Thumbnail or icon
        Container(
          width: 40, height: 40,
          decoration: BoxDecoration(
            color: const Color(0xFF334155),
            borderRadius: BorderRadius.circular(10),
          ),
          clipBehavior: Clip.antiAlias,
          child: isImage
              ? Image.network(
                  context.read<ApiService>().p2pPreviewUrl(f.id),
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => Icon(_fileIcon(f.name), color: const Color(0xFF94A3B8), size: 20),
                )
              : Icon(_fileIcon(f.name), color: const Color(0xFF94A3B8), size: 20),
        ),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(f.name, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w500),
            overflow: TextOverflow.ellipsis),
          Text('${_formatSize(f.size)} · from $sender',
            style: TextStyle(color: Colors.white.withOpacity(.4), fontSize: 11)),
          Row(children: [
            Icon(Icons.access_time, size: 10,
              color: expiryMin <= 10 ? const Color(0xFFEF4444) : const Color(0xFF475569)),
            const SizedBox(width: 3),
            Text('${expiryMin}m left',
              style: TextStyle(fontSize: 10, fontWeight: expiryMin <= 10 ? FontWeight.w600 : FontWeight.normal,
                color: expiryMin <= 10 ? const Color(0xFFEF4444) : expiryMin <= 30 ? const Color(0xFFF59E0B) : const Color(0xFF475569))),
          ]),
        ])),
        // Download
        _circleBtn(Icons.download, const Color(0xFF22C55E), () => _downloadFile(f)),
        if (isMine) ...[
          const SizedBox(width: 6),
          _circleBtn(Icons.delete, const Color(0xFFEF4444), () => _deleteFile(f.id), filled: false),
        ],
      ]),
    );
  }

  Widget _buildHistoryTile(Map<String, dynamic> h) {
    final isSent = h['type'] == 'sent';
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white.withOpacity(.03)),
      ),
      child: Row(children: [
        Container(
          width: 32, height: 32,
          decoration: BoxDecoration(
            color: Colors.white.withOpacity(.04),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Icon(isSent ? Icons.arrow_upward : Icons.arrow_downward,
            color: isSent ? const Color(0xFF667EEA) : const Color(0xFF4ADE80), size: 16),
        ),
        const SizedBox(width: 10),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(h['name'] ?? '', style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w500),
            overflow: TextOverflow.ellipsis),
          Text('${_formatSize(h['size'] ?? 0)} · ${h['type']} · ${_timeAgo(h['time'] ?? 0)}',
            style: TextStyle(color: Colors.white.withOpacity(.4), fontSize: 10)),
        ])),
      ]),
    );
  }

  Widget _circleBtn(IconData icon, Color color, VoidCallback onTap, {bool filled = true}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 36, height: 36,
        decoration: BoxDecoration(
          gradient: filled ? LinearGradient(colors: [color, color.withOpacity(.8)]) : null,
          color: filled ? null : color.withOpacity(.12),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(icon, color: filled ? Colors.white : color, size: 18),
      ),
    );
  }

  Widget _sectionHeader(IconData icon, String title, {int count = 0}) {
    return Row(children: [
      Icon(icon, color: const Color(0xFF667EEA), size: 16),
      const SizedBox(width: 8),
      Text(title, style: const TextStyle(color: Color(0xFF94A3B8), fontSize: 12,
        fontWeight: FontWeight.w700, letterSpacing: .4)),
      const SizedBox(width: 8),
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
        decoration: BoxDecoration(
          color: const Color(0xFF667EEA).withOpacity(.15),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text('$count', style: const TextStyle(color: Color(0xFF667EEA), fontSize: 11, fontWeight: FontWeight.w700)),
      ),
    ]);
  }

  Widget _emptyState(IconData icon, String text) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 20),
      child: Column(children: [
        Icon(icon, size: 32, color: const Color(0xFF334155)),
        const SizedBox(height: 8),
        Text(text, style: TextStyle(color: Colors.white.withOpacity(.3), fontSize: 13)),
      ]),
    );
  }
}
