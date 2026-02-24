import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_service.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.watch<ApiService>();
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final info = api.info;

    return Scaffold(
      backgroundColor:
          isDark ? const Color(0xFF0F172A) : const Color(0xFFF1F5F9),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.only(left: 4, bottom: 16),
                child: Text('Settings',
                    style:
                        TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
              ),
              // Connection card
              _SectionCard(
                title: 'Connection',
                icon: Icons.wifi,
                isDark: isDark,
                children: [
                  _InfoRow('Status',
                      api.isConnected ? 'Connected ✓' : 'Disconnected',
                      valueColor: api.isConnected
                          ? const Color(0xFF4ADE80)
                          : const Color(0xFFF87171)),
                  if (api.serverIp != null)
                    _InfoRow('Server IP', api.serverIp!),
                  _InfoRow('Port', '${api.serverPort}'),
                  if (info != null) ...[
                    _InfoRow('Fast Port', '${info.fastPort}'),
                    _InfoRow('Shared Folder', info.directory,
                        mono: true),
                  ],
                  const SizedBox(height: 12),
                  _ActionButton(
                    label: 'Disconnect',
                    icon: Icons.logout,
                    color: const Color(0xFFF87171),
                    onTap: () => api.disconnect(),
                  ),
                  const SizedBox(height: 8),
                  _ActionButton(
                    label: 'Re-check Connection',
                    icon: Icons.refresh,
                    color: const Color(0xFF667EEA),
                    onTap: () async {
                      await api.checkConnection();
                      if (context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                          content: Text(api.isConnected
                              ? 'Still connected ✓'
                              : 'Connection lost'),
                        ));
                      }
                    },
                  ),
                ],
              ),
              const SizedBox(height: 16),
              // About card
              _SectionCard(
                title: 'About',
                icon: Icons.info_outline,
                isDark: isDark,
                children: [
                  _InfoRow('App', 'Wireless Transfer'),
                  _InfoRow('Version', '1.0.0'),
                  _InfoRow('Transfer', 'Raw TCP fast server'),
                  _InfoRow('Protocol', 'HTTP · LAN only'),
                ],
              ),
              const SizedBox(height: 16),
              // How it works
              _SectionCard(
                title: 'How it works',
                icon: Icons.help_outline,
                isDark: isDark,
                children: [
                  _Step('1', 'Run the Python app on your laptop'),
                  _Step('2', 'Enter the IP shown in the terminal (or scan QR)'),
                  _Step('3', 'Browse your laptop\'s files here'),
                  _Step('4', 'Tap a file → tap Download to save it'),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Widgets ───────────────────────────────────────────────────────────────

class _SectionCard extends StatelessWidget {
  final String title;
  final IconData icon;
  final bool isDark;
  final List<Widget> children;
  const _SectionCard({
    required this.title,
    required this.icon,
    required this.isDark,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF1E293B) : Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: isDark
              ? Colors.white.withOpacity(.07)
              : Colors.black.withOpacity(.05),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 16, color: const Color(0xFF667EEA)),
              const SizedBox(width: 7),
              Text(title,
                  style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 13,
                      color: Color(0xFF667EEA),
                      letterSpacing: .5)),
            ],
          ),
          const SizedBox(height: 14),
          ...children,
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final String label;
  final String value;
  final Color? valueColor;
  final bool mono;
  const _InfoRow(this.label, this.value, {this.valueColor, this.mono = false});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label,
              style: TextStyle(
                  fontSize: 13,
                  color: Colors.grey.withOpacity(.6),
                  fontWeight: FontWeight.w500)),
          const SizedBox(width: 16),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: valueColor,
                fontFamily: mono ? 'monospace' : null,
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final Color color;
  final VoidCallback onTap;
  const _ActionButton({
    required this.label,
    required this.icon,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
        decoration: BoxDecoration(
          color: color.withOpacity(.1),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withOpacity(.25)),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: color, size: 17),
            const SizedBox(width: 8),
            Text(label,
                style: TextStyle(
                    color: color,
                    fontWeight: FontWeight.w600,
                    fontSize: 14)),
          ],
        ),
      ),
    );
  }
}

class _Step extends StatelessWidget {
  final String number;
  final String text;
  const _Step(this.number, this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 22, height: 22,
            margin: const EdgeInsets.only(right: 10, top: 1),
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: const LinearGradient(
                  colors: [Color(0xFF667EEA), Color(0xFF764BA2)]),
            ),
            child: Center(
              child: Text(number,
                  style: const TextStyle(
                      color: Colors.white,
                      fontSize: 11,
                      fontWeight: FontWeight.w700)),
            ),
          ),
          Expanded(
            child: Text(text,
                style:
                    const TextStyle(fontSize: 13, height: 1.6)),
          ),
        ],
      ),
    );
  }
}
