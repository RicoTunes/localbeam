import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_service.dart';
import '../screens/connect_screen.dart';

/// A widget that shows a "Connect to PC" prompt for local file sharing.
/// Only used by Share screen — other features auto-connect to server.
class ConnectPromptWrapper extends StatelessWidget {
  final Widget? child;
  final String feature;
  final IconData icon;

  const ConnectPromptWrapper({
    super.key,
    this.child,
    this.feature = 'this feature',
    this.icon = Icons.wifi_off,
  });

  @override
  Widget build(BuildContext context) {
    final api = context.watch<ApiService>();
    if (api.isConnected && child != null) return child!;

    return Scaffold(
      backgroundColor: const Color(0xFF0F172A),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.all(24),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [
                      const Color(0xFF667EEA).withAlpha(30),
                      const Color(0xFF7C3AED).withAlpha(20),
                    ],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, size: 56, color: const Color(0xFF667EEA)),
              ),
              const SizedBox(height: 24),
              Text(
                'Connect to PC',
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 22,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 10),
              Text(
                'Pair with a nearby device to share files locally.\nMake sure both devices are on the same Wi-Fi.',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: Color(0xFF94A3B8),
                  fontSize: 14,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 32),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: () {
                    Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => const ConnectScreen()),
                    );
                  },
                  icon: const Icon(Icons.qr_code_scanner, size: 20),
                  label: const Text('Connect Now',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF667EEA),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                    elevation: 0,
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                'Chat, Status & BEAM AI work without pairing!',
                style: TextStyle(
                  color: const Color(0xFF667EEA).withAlpha(180),
                  fontSize: 12,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
