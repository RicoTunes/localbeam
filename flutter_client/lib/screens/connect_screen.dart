import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';
import '../services/api_service.dart';

class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key});

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  // QR scanner
  MobileScannerController? _scanCtrl;
  bool _scanning = false;
  bool _scanProcessing = false;

  // Manual fallback
  bool _showManual = false;
  final _ipCtrl = TextEditingController();
  final _portCtrl = TextEditingController(text: '5001');
  final _formKey = GlobalKey<FormState>();

  // Status
  bool _loading = false;
  String? _errorMsg;
  String? _successMsg;

  @override
  void dispose() {
    _scanCtrl?.dispose();
    _ipCtrl.dispose();
    _portCtrl.dispose();
    super.dispose();
  }

  // ── QR scanner ─────────────────────────────────────────────
  void _startScan() {
    _scanCtrl = MobileScannerController(
      detectionSpeed: DetectionSpeed.noDuplicates,
      facing: CameraFacing.back,
    );
    setState(() {
      _scanning = true;
      _errorMsg = null;
      _successMsg = null;
    });
  }

  void _stopScan() {
    _scanCtrl?.dispose();
    _scanCtrl = null;
    setState(() => _scanning = false);
  }

  void _onDetect(BarcodeCapture capture) {
    if (_scanProcessing) return;
    final raw = capture.barcodes
        .map((b) => b.rawValue)
        .whereType<String>()
        .firstOrNull;
    if (raw == null) return;

    // Parse LocalBeam QR: http://IP:PORT/...
    final uri = Uri.tryParse(raw);
    if (uri == null || uri.host.isEmpty) return;

    final ip = uri.host;
    final port = uri.hasPort ? uri.port : 5001;

    _scanProcessing = true;
    _stopScan();
    _doConnect(ip, port: port);
  }

  // ── Manual connect ─────────────────────────────────────────
  Future<void> _manualConnect() async {
    if (!_formKey.currentState!.validate()) return;
    _doConnect(
      _ipCtrl.text.trim(),
      port: int.tryParse(_portCtrl.text.trim()) ?? 5001,
    );
  }

  // ── Shared connect logic ───────────────────────────────────
  Future<void> _doConnect(String ip, {int port = 5001}) async {
    setState(() {
      _loading = true;
      _errorMsg = null;
      _successMsg = null;
    });

    final api = context.read<ApiService>();
    final ok = await api.connect(ip, port: port);

    if (!mounted) return;
    setState(() {
      _loading = false;
      _scanProcessing = false;
    });

    if (ok) {
      setState(() => _successMsg = 'Paired with $ip:$port');
      await Future.delayed(const Duration(milliseconds: 800));
      if (mounted) Navigator.of(context).pop(true);
    } else {
      setState(() => _errorMsg =
          'Could not connect to $ip:$port\nMake sure LocalBeam is running on the PC.');
    }
  }

  // ── Build ──────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0F172A),
      appBar: AppBar(
        backgroundColor: const Color(0xFF1E293B),
        title: const Text('Connect to PC',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
        iconTheme: const IconThemeData(color: Color(0xFF94A3B8)),
        elevation: 0,
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 12),

              // Header
              const Icon(Icons.wifi_tethering, size: 52, color: Color(0xFF667EEA)),
              const SizedBox(height: 16),
              const Text('Pair with LocalBeam',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                      color: Colors.white,
                      fontSize: 22,
                      fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              const Text(
                'On your PC, open LocalBeam and scan the QR\nshown on the Dashboard page.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Color(0xFF94A3B8), height: 1.5),
              ),

              const SizedBox(height: 32),

              // QR scanner area
              if (_scanning) ...[
                ClipRRect(
                  borderRadius: BorderRadius.circular(20),
                  child: SizedBox(
                    height: 300,
                    child: Stack(
                      children: [
                        MobileScanner(
                          controller: _scanCtrl!,
                          onDetect: _onDetect,
                        ),
                        Center(
                          child: Container(
                            width: 220,
                            height: 220,
                            decoration: BoxDecoration(
                              border: Border.all(
                                  color: const Color(0xFF667EEA), width: 3),
                              borderRadius: BorderRadius.circular(16),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: _stopScan,
                  icon: const Icon(Icons.close),
                  label: const Text('Cancel'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: const Color(0xFF94A3B8),
                    side: const BorderSide(color: Color(0xFF334155)),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
                  ),
                ),
              ] else ...[
                ElevatedButton.icon(
                  onPressed: _loading ? null : _startScan,
                  icon: const Icon(Icons.qr_code_scanner, size: 22),
                  label: const Text('Scan QR Code',
                      style: TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w600)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF667EEA),
                    foregroundColor: Colors.white,
                    disabledBackgroundColor:
                        const Color(0xFF667EEA).withOpacity(.4),
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16)),
                    elevation: 0,
                  ),
                ),
              ],

              const SizedBox(height: 24),

              // Status messages
              if (_loading)
                const Center(
                    child: CircularProgressIndicator(color: Color(0xFF667EEA))),

              if (_successMsg != null)
                _StatusCard(
                    message: _successMsg!,
                    icon: Icons.check_circle_outline,
                    color: const Color(0xFF4ADE80)),

              if (_errorMsg != null)
                _StatusCard(
                    message: _errorMsg!,
                    icon: Icons.error_outline,
                    color: const Color(0xFFEF4444)),

              const SizedBox(height: 8),

              // Manual entry toggle
              TextButton(
                onPressed: () => setState(() => _showManual = !_showManual),
                child: Text(
                  _showManual ? 'Hide manual entry' : 'Enter IP address manually',
                  style: const TextStyle(color: Color(0xFF667EEA)),
                ),
              ),

              if (_showManual) ...[
                const SizedBox(height: 8),
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: const Color(0xFF1E293B),
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: const Color(0xFF334155)),
                  ),
                  child: Form(
                    key: _formKey,
                    child: Column(
                      children: [
                        TextFormField(
                          controller: _ipCtrl,
                          style: const TextStyle(color: Colors.white),
                          keyboardType: TextInputType.number,
                          decoration: _inputDeco('PC IP Address',
                              hint: '192.168.x.x'),
                          validator: (v) =>
                              (v == null || v.isEmpty) ? 'Required' : null,
                        ),
                        const SizedBox(height: 12),
                        TextFormField(
                          controller: _portCtrl,
                          style: const TextStyle(color: Colors.white),
                          keyboardType: TextInputType.number,
                          decoration: _inputDeco('Port', hint: '5001'),
                        ),
                        const SizedBox(height: 16),
                        SizedBox(
                          width: double.infinity,
                          child: ElevatedButton(
                            onPressed: _loading ? null : _manualConnect,
                            style: ElevatedButton.styleFrom(
                              backgroundColor: const Color(0xFF334155),
                              foregroundColor: Colors.white,
                              padding:
                                  const EdgeInsets.symmetric(vertical: 14),
                              shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(12)),
                              elevation: 0,
                            ),
                            child: const Text('Connect'),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],

              const SizedBox(height: 40),

              // Instruction hint
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: const Color(0xFF667EEA).withOpacity(.08),
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(
                      color: const Color(0xFF667EEA).withOpacity(.2)),
                ),
                child: const Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.lightbulb_outline,
                        color: Color(0xFF667EEA), size: 18),
                    SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'On PC: open http://localhost:5001 → Dashboard tab → QR code is shown there.',
                        style: TextStyle(
                            color: Color(0xFF94A3B8),
                            fontSize: 13,
                            height: 1.5),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  InputDecoration _inputDeco(String label, {String? hint}) => InputDecoration(
        labelText: label,
        hintText: hint,
        labelStyle: const TextStyle(color: Color(0xFF94A3B8)),
        hintStyle: const TextStyle(color: Color(0xFF475569)),
        filled: true,
        fillColor: const Color(0xFF0F172A),
        border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFF334155))),
        enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFF334155))),
        focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFF667EEA))),
      );
}

// ── Status card widget ────────────────────────────────────────
class _StatusCard extends StatelessWidget {
  final String message;
  final IconData icon;
  final Color color;

  const _StatusCard(
      {required this.message, required this.icon, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color.withOpacity(.08),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withOpacity(.3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(
              child: Text(message,
                  style: TextStyle(color: color, height: 1.5, fontSize: 13))),
        ],
      ),
    );
  }
}
