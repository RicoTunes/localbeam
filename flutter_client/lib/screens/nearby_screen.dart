import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/peer_service.dart';

// ─────────────────────────────────────────────────────────────
// NearbyScreen  — discover LocalBeam phones & share files P2P
// ─────────────────────────────────────────────────────────────
class NearbyScreen extends StatefulWidget {
  const NearbyScreen({super.key});

  @override
  State<NearbyScreen> createState() => _NearbyScreenState();
}

class _NearbyScreenState extends State<NearbyScreen>
    with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;

  bool _dialogShowing = false;
  bool _serviceStarted = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final ps = context.read<PeerService>();
      ps.addListener(_onPeerServiceChanged);
      _startService(ps);
    });
  }

  @override
  void dispose() {
    context.read<PeerService>().removeListener(_onPeerServiceChanged);
    super.dispose();
  }

  // ── Start peer service ────────────────────────────────────

  Future<void> _startService(PeerService ps) async {
    if (_serviceStarted) return;
    _serviceStarted = true;
    await ps.start();
  }

  // ── Listen for incoming requests ──────────────────────────

  void _onPeerServiceChanged() {
    final ps = context.read<PeerService>();
    if (ps.pendingIncoming != null && !_dialogShowing && mounted) {
      _showIncomingDialog(ps.pendingIncoming!);
    }
  }

  void _showIncomingDialog(IncomingRequest req) {
    _dialogShowing = true;
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => _IncomingDialog(request: req),
    ).then((_) {
      _dialogShowing = false;
    });
  }

  // ── Build ─────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final ps = context.watch<PeerService>();

    return Scaffold(
      backgroundColor: const Color(0xFF0F172A),
      appBar: AppBar(
        backgroundColor: const Color(0xFF1E293B),
        title: const Text('Nearby Devices',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
        actions: [
          // Refresh / scan button
          IconButton(
            onPressed: ps.isScanning ? null : () => ps.scanSubnet(),
            icon: ps.isScanning
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: Color(0xFF667EEA)))
                : const Icon(Icons.radar, color: Color(0xFF94A3B8)),
            tooltip: 'Scan network',
          ),
          // Start/Stop service
          IconButton(
            onPressed: () async {
              if (ps.isRunning) {
                await ps.stop();
              } else {
                await ps.start();
              }
            },
            icon: Icon(
              ps.isRunning ? Icons.wifi : Icons.wifi_off,
              color: ps.isRunning
                  ? const Color(0xFF4ADE80)
                  : const Color(0xFF64748B),
            ),
            tooltip: ps.isRunning ? 'Stop (go invisible)' : 'Start (go visible)',
          ),
        ],
        elevation: 0,
      ),

      body: Column(
        children: [
          // ── Your device card ────────────────────────────
          _DeviceCard(ps: ps),

          // ── Transfer progress bar ───────────────────────
          if (ps.transfer != null &&
              ps.transfer!.state != XferState.idle)
            _TransferProgress(
              info: ps.transfer!,
              onDismiss: () => ps.clearTransfer(),
            ),

          // ── Peer list ──────────────────────────────────
          Expanded(
            child: ps.peers.isEmpty
                ? _EmptyState(isRunning: ps.isRunning, isScanning: ps.isScanning)
                : ListView.separated(
                    padding: const EdgeInsets.all(16),
                    itemCount: ps.peers.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 10),
                    itemBuilder: (_, i) => _PeerTile(
                      peer: ps.peers[i],
                      onSend: () => ps.pickAndSendFile(ps.peers[i]),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Your device card
// ─────────────────────────────────────────────────────────────
class _DeviceCard extends StatefulWidget {
  final PeerService ps;
  const _DeviceCard({required this.ps});

  @override
  State<_DeviceCard> createState() => _DeviceCardState();
}

class _DeviceCardState extends State<_DeviceCard> {
  bool _editing = false;
  late TextEditingController _nameCtrl;
  String? _ownIp;

  @override
  void initState() {
    super.initState();
    _nameCtrl = TextEditingController(text: widget.ps.deviceName);
    _loadOwnIp();
  }

  @override
  void didUpdateWidget(_DeviceCard old) {
    super.didUpdateWidget(old);
    if (!_editing) _nameCtrl.text = widget.ps.deviceName;
  }

  Future<void> _loadOwnIp() async {
    final ip = await widget.ps.getOwnIp();
    if (mounted) setState(() => _ownIp = ip);
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ps = widget.ps;
    return Container(
      margin: const EdgeInsets.all(16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF1E293B), Color(0xFF1A2535)],
        ),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: ps.isRunning
              ? const Color(0xFF4ADE80).withOpacity(.3)
              : const Color(0xFF334155),
        ),
      ),
      child: Row(
        children: [
          // Status dot
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: ps.isRunning
                  ? const Color(0xFF4ADE80).withOpacity(.12)
                  : const Color(0xFF475569).withOpacity(.2),
            ),
            child: Icon(
              Icons.phone_android,
              color: ps.isRunning
                  ? const Color(0xFF4ADE80)
                  : const Color(0xFF64748B),
              size: 22,
            ),
          ),
          const SizedBox(width: 14),

          Expanded(
            child: _editing
                ? Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _nameCtrl,
                          autofocus: true,
                          style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w600),
                          decoration: const InputDecoration(
                            isDense: true,
                            contentPadding: EdgeInsets.symmetric(
                                vertical: 6, horizontal: 10),
                            border: OutlineInputBorder(),
                            focusedBorder: OutlineInputBorder(
                              borderSide:
                                  BorderSide(color: Color(0xFF667EEA)),
                            ),
                          ),
                          onSubmitted: (_) => _save(ps),
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.check,
                            color: Color(0xFF4ADE80), size: 20),
                        onPressed: () => _save(ps),
                      ),
                    ],
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            ps.deviceName,
                            style: const TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.w600,
                                fontSize: 15),
                          ),
                          const SizedBox(width: 6),
                          GestureDetector(
                            onTap: () => setState(() => _editing = true),
                            child: const Icon(Icons.edit,
                                size: 14, color: Color(0xFF64748B)),
                          ),
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        ps.isRunning
                            ? 'Visible on network${_ownIp != null ? ' • $_ownIp' : ''}'
                            : 'Invisible (tap WiFi icon to start)',
                        style: TextStyle(
                          color: ps.isRunning
                              ? const Color(0xFF4ADE80)
                              : const Color(0xFF64748B),
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
          ),

          // Peer count badge
          if (ps.peers.isNotEmpty)
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: const Color(0xFF667EEA).withOpacity(.15),
                borderRadius: BorderRadius.circular(20),
              ),
              child: Text(
                '${ps.peers.length} nearby',
                style: const TextStyle(
                    color: Color(0xFF667EEA),
                    fontSize: 12,
                    fontWeight: FontWeight.w500),
              ),
            ),
        ],
      ),
    );
  }

  void _save(PeerService ps) {
    ps.setDeviceName(_nameCtrl.text);
    setState(() => _editing = false);
  }
}

// ─────────────────────────────────────────────────────────────
// Peer tile
// ─────────────────────────────────────────────────────────────
class _PeerTile extends StatelessWidget {
  final DiscoveredPeer peer;
  final VoidCallback onSend;

  const _PeerTile({required this.peer, required this.onSend});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF334155)),
      ),
      child: Row(
        children: [
          // Avatar
          Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: const Color(0xFF667EEA).withOpacity(.1),
              border: Border.all(
                  color: const Color(0xFF667EEA).withOpacity(.25)),
            ),
            child: Center(
              child: Text(
                peer.name.isNotEmpty
                    ? peer.name[0].toUpperCase()
                    : '?',
                style: const TextStyle(
                    color: Color(0xFF667EEA),
                    fontWeight: FontWeight.bold,
                    fontSize: 18),
              ),
            ),
          ),
          const SizedBox(width: 14),

          // Name + IP
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  peer.name,
                  style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w600,
                      fontSize: 14),
                ),
                const SizedBox(height: 3),
                Text(
                  peer.ip,
                  style: const TextStyle(
                      color: Color(0xFF64748B), fontSize: 12),
                ),
              ],
            ),
          ),

          // Send file button
          ElevatedButton.icon(
            onPressed: onSend,
            icon: const Icon(Icons.send_rounded, size: 16),
            label: const Text('Send'),
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF667EEA),
              foregroundColor: Colors.white,
              padding:
                  const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              textStyle: const TextStyle(fontWeight: FontWeight.w600),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12)),
              elevation: 0,
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Transfer progress card
// ─────────────────────────────────────────────────────────────
class _TransferProgress extends StatelessWidget {
  final TransferInfo info;
  final VoidCallback onDismiss;

  const _TransferProgress({required this.info, required this.onDismiss});

  @override
  Widget build(BuildContext context) {
    final isDone = info.state == XferState.done ||
        info.state == XferState.failed;
    final isError = info.state == XferState.failed;

    final barColor = isError
        ? const Color(0xFFEF4444)
        : info.state == XferState.done
            ? const Color(0xFF4ADE80)
            : info.isSending
                ? const Color(0xFF667EEA)
                : const Color(0xFFFBBF24);

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: isError
              ? const Color(0xFFEF4444).withOpacity(.4)
              : barColor.withOpacity(.3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                info.isSending
                    ? Icons.upload_rounded
                    : Icons.download_rounded,
                size: 16,
                color: barColor,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  info.filename,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w500,
                      fontSize: 13),
                ),
              ),
              if (isDone)
                GestureDetector(
                  onTap: onDismiss,
                  child: const Icon(Icons.close,
                      size: 16, color: Color(0xFF64748B)),
                ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: isDone ? 1.0 : info.progress,
              minHeight: 5,
              backgroundColor: const Color(0xFF334155),
              valueColor: AlwaysStoppedAnimation<Color>(barColor),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            info.stateLabel,
            style: TextStyle(
                color: isError
                    ? const Color(0xFFEF4444)
                    : const Color(0xFF94A3B8),
                fontSize: 11),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────
class _EmptyState extends StatelessWidget {
  final bool isRunning;
  final bool isScanning;

  const _EmptyState({required this.isRunning, required this.isScanning});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            isRunning ? Icons.radar : Icons.wifi_off,
            size: 64,
            color: const Color(0xFF334155),
          ),
          const SizedBox(height: 16),
          Text(
            isRunning ? 'No devices found yet' : 'Not broadcasting',
            style: const TextStyle(
                color: Color(0xFF94A3B8),
                fontSize: 16,
                fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: 8),
          Text(
            isRunning
                ? 'Make sure other phones have LocalBeam open\nTap the radar icon to scan'
                : 'Tap the WiFi icon above to become visible',
            textAlign: TextAlign.center,
            style: const TextStyle(
                color: Color(0xFF475569), fontSize: 13, height: 1.5),
          ),
          if (isRunning && !isScanning) ...[
            const SizedBox(height: 20),
            TextButton.icon(
              onPressed: () =>
                  context.read<PeerService>().scanSubnet(),
              icon: const Icon(Icons.search, color: Color(0xFF667EEA)),
              label: const Text('Scan network',
                  style: TextStyle(color: Color(0xFF667EEA))),
            ),
          ],
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Incoming request dialog
// ─────────────────────────────────────────────────────────────
class _IncomingDialog extends StatelessWidget {
  final IncomingRequest request;

  const _IncomingDialog({required this.request});

  String _fmtSize(int bytes) {
    if (bytes <= 0) return '?';
    const units = ['B', 'KB', 'MB', 'GB'];
    int i = 0;
    double v = bytes.toDouble();
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return '${v.toStringAsFixed(1)} ${units[i]}';
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: const Color(0xFF1E293B),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      title: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: const Color(0xFF667EEA).withOpacity(.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(Icons.file_download_outlined,
                color: Color(0xFF667EEA)),
          ),
          const SizedBox(width: 12),
          const Expanded(
            child: Text('Incoming File',
                style: TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w700,
                    fontSize: 17)),
          ),
        ],
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          RichText(
            text: TextSpan(
              style: const TextStyle(
                  color: Color(0xFF94A3B8), fontSize: 14, height: 1.6),
              children: [
                TextSpan(
                  text: request.fromName,
                  style: const TextStyle(
                      color: Colors.white, fontWeight: FontWeight.w600),
                ),
                const TextSpan(text: ' ('),
                TextSpan(text: request.fromIp),
                const TextSpan(text: ') wants to send you:'),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFF0F172A),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              children: [
                const Icon(Icons.insert_drive_file_outlined,
                    color: Color(0xFF667EEA), size: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        request.filename,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w500,
                            fontSize: 13),
                      ),
                      Text(
                        _fmtSize(request.fileSize),
                        style: const TextStyle(
                            color: Color(0xFF64748B), fontSize: 11),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      actions: [
        // Decline
        TextButton(
          onPressed: () {
            context.read<PeerService>().respondToIncoming(false);
            Navigator.of(context).pop();
          },
          style: TextButton.styleFrom(
            foregroundColor: const Color(0xFFEF4444),
          ),
          child: const Text('Decline'),
        ),
        // Accept
        ElevatedButton(
          onPressed: () {
            context.read<PeerService>().respondToIncoming(true);
            Navigator.of(context).pop();
          },
          style: ElevatedButton.styleFrom(
            backgroundColor: const Color(0xFF667EEA),
            foregroundColor: Colors.white,
            shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(10)),
            elevation: 0,
          ),
          child: const Text('Accept', style: TextStyle(fontWeight: FontWeight.w600)),
        ),
      ],
    );
  }
}
