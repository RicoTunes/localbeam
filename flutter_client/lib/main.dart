import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'services/api_service.dart';
import 'services/peer_service.dart';
import 'screens/main_shell.dart';

/// Trust all certificates so Image.network works with self-signed HTTPS
class _TrustAllCerts extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    return super.createHttpClient(context)
      ..badCertificateCallback = (X509Certificate cert, String host, int port) => true;
  }
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Trust self-signed certificates globally (local network only)
  HttpOverrides.global = _TrustAllCerts();

  // Initialise PeerService (loads stored device name)
  final peerService = PeerService();
  await peerService.init();

  // Create ApiService and load auth state
  final apiService = ApiService();
  await apiService.loadAuthState();

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => apiService),
        ChangeNotifierProvider(create: (_) => peerService),
      ],
      child: const WirelessTransferApp(),
    ),
  );
}

class WirelessTransferApp extends StatelessWidget {
  const WirelessTransferApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Wireless Transfer',
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.dark,
      theme: _buildTheme(Brightness.light),
      darkTheme: _buildTheme(Brightness.dark),
      home: const MainShell(),
    );
  }

  ThemeData _buildTheme(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(0xFF667EEA),
        brightness: brightness,
      ),
      scaffoldBackgroundColor:
          isDark ? const Color(0xFF0F172A) : const Color(0xFFF8FAFC),
      cardTheme: CardThemeData(
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        color: isDark ? const Color(0xFF1E293B) : Colors.white,
      ),
      appBarTheme: AppBarTheme(
        elevation: 0,
        scrolledUnderElevation: 0,
        backgroundColor:
            isDark ? const Color(0xFF0F172A) : const Color(0xFFF8FAFC),
        foregroundColor:
            isDark ? Colors.white : const Color(0xFF1E293B),
        titleTextStyle: TextStyle(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          color: isDark ? Colors.white : const Color(0xFF1E293B),
        ),
      ),
      fontFamily: 'Poppins',
    );
  }
}
