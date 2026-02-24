import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_service.dart';

// ── Data model ────────────────────────────────────────────────
class _Transfer {
  final String id;
  final String name;
  final int size;
  final int sent;
  final String status; // active | paused | done
  final String clientIp;

  _Transfer.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        name = j['name'] as String,
        size = (j['size'] as num).toInt(),
        sent = (j['sent'] as num).toInt(),
        status = j['status'] as String,
        clientIp = j['client_ip'] as String;

  double get progress => size > 0 ? (sent / size).clamp(0.0, 1.0) : 0;

  String get sizeLabel => _fmt(size);
  String get sentLabel => _fmt(sent);

  static String _fmt(int b) {
    if (b <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    int i = 0;
    double v = b.toDouble();
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return '${v.toStringAsFixed(1)} ${units[i]}';
  }
}

// ── Screen ────────────────────────────────────────────────────
class TransfersScreen extends StatefulWidget {
  const TransfersScreen({super.key});

  @override
  State<TransfersScreen> createState() => _TransfersScreenState();
}

class _TransfersScreenState extends State<TransfersScreen>
    with AutomaticKeepAliveClientMixin {
  List<_Transfer> _transfers = [];
  Timer? _timer;
  bool _polling = false;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _startPolling();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _startPolling() {
    _poll();
    _timer = Timer.periodic(const Duration(seconds: 2), (_) => _poll());
  }

  Future<void> _poll() async {
    if (_polling) return;
    _polling = true;
    try {
      final api = context.read<ApiService>();
      final resp = await api.getTransfers();
      if (resp != null && mounted) {
        final list = (jsonDecode(resp)['transfers'] as List)
            .map((j) => _Transfer.fromJson(j as Map<String, dynamic>))
            .toList();
        setState(() => _transfers = list);
      }
    } catch (_) {
      // server offline / not connected — silently ignore
    } finally {
      _polling = false;
    }
  }

  Future<void> _action(String tid, String action) async {
    try {
      final api = context.read<ApiService>();
      await api.transferAction(tid, action);
      _poll();
    } catch (_) {}
  }

  // ── UI ────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Scaffold(
      backgroundColor: const Color(0xFF0F172A),
      appBar: AppBar(
        backgroundColor: const Color(0xFF1E293B),
        title: const Text('Transfers',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
        actions: [
          IconButton(
            onPressed: _poll,
            icon: const Icon(Icons.refresh, color: Color(0xFF94A3B8)),
            tooltip: 'Refresh',
          ),
        ],
        elevation: 0,
      ),
      body: _transfers.isEmpty
          ? _emptyState()
          : ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: _transfers.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (_, i) => _XferTile(
                xfer: _transfers[i],
                onPause: () => _action(_transfers[i].id, 'pause'),
                onResume: () => _action(_transfers[i].id, 'resume'),
                onCancel: () => _action(_transfers[i].id, 'cancel'),
              ),
            ),
    );
  }

  Widget _emptyState() => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.swap_horiz,
                size: 64, color: Color(0xFF334155)),
            const SizedBox(height: 16),
            const Text('No active transfers',
                style: TextStyle(
                    color: Color(0xFF94A3B8),
                    fontSize: 16,
                    fontWeight: FontWeight.w500)),
            const SizedBox(height: 8),
            const Text('Download a file from the phone browser\nto see it here.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Color(0xFF475569), fontSize: 13, height: 1.5)),
            const SizedBox(height: 24),
            TextButton.icon(
              onPressed: _poll,
              icon: const Icon(Icons.refresh, color: Color(0xFF667EEA)),
              label: const Text('Check now',
                  style: TextStyle(color: Color(0xFF667EEA))),
            )
          ],
        ),
      );
}

// ── Transfer tile ─────────────────────────────────────────────
class _XferTile extends StatelessWidget {
  final _Transfer xfer;
  final VoidCallback onPause;
  final VoidCallback onResume;
  final VoidCallback onCancel;

  const _XferTile({
    required this.xfer,
    required this.onPause,
    required this.onResume,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final pct = (xfer.progress * 100).round();
    final isActive = xfer.status == 'active';
    final isPaused = xfer.status == 'paused';
    final isDone = xfer.status == 'done';

    final dotColor = isActive
        ? const Color(0xFF4ADE80)
        : isPaused
            ? const Color(0xFFFBBF24)
            : const Color(0xFF475569);

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF334155)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // File icon
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: const Color(0xFF667EEA).withOpacity(.12),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Icon(Icons.insert_drive_file_outlined,
                    color: Color(0xFF667EEA), size: 20),
              ),
              const SizedBox(width: 12),
              // Name + device
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      xfer.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w600,
                          fontSize: 14),
                    ),
                    const SizedBox(height: 2),
                    Text(xfer.clientIp,
                        style: const TextStyle(
                            color: Color(0xFF64748B), fontSize: 11)),
                  ],
                ),
              ),
              // Status dot
              Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                      shape: BoxShape.circle, color: dotColor)),
            ],
          ),

          const SizedBox(height: 14),

          // Progress bar
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: xfer.progress,
              minHeight: 6,
              backgroundColor: const Color(0xFF334155),
              valueColor: AlwaysStoppedAnimation<Color>(
                isDone
                    ? const Color(0xFF475569)
                    : isActive
                        ? const Color(0xFF667EEA)
                        : const Color(0xFFFBBF24),
              ),
            ),
          ),

          const SizedBox(height: 10),

          // Bytes + pct + buttons
          Row(
            children: [
              Text('$pct%  •  ${xfer.sentLabel} / ${xfer.sizeLabel}',
                  style: const TextStyle(
                      color: Color(0xFF94A3B8), fontSize: 12)),
              const Spacer(),
              if (isActive)
                _IconBtn(
                    icon: Icons.pause_rounded,
                    color: const Color(0xFFFBBF24),
                    onTap: onPause,
                    tooltip: 'Pause'),
              if (isPaused)
                _IconBtn(
                    icon: Icons.play_arrow_rounded,
                    color: const Color(0xFF4ADE80),
                    onTap: onResume,
                    tooltip: 'Resume'),
              if (!isDone) ...[
                const SizedBox(width: 6),
                _IconBtn(
                    icon: Icons.close_rounded,
                    color: const Color(0xFFEF4444),
                    onTap: onCancel,
                    tooltip: 'Cancel'),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

class _IconBtn extends StatelessWidget {
  final IconData icon;
  final Color color;
  final VoidCallback onTap;
  final String tooltip;

  const _IconBtn(
      {required this.icon,
      required this.color,
      required this.onTap,
      required this.tooltip});

  @override
  Widget build(BuildContext context) => Tooltip(
        message: tooltip,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
                color: color.withOpacity(.12),
                borderRadius: BorderRadius.circular(8)),
            child: Icon(icon, color: color, size: 16),
          ),
        ),
      );
}
