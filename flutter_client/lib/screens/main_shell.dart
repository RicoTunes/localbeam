import 'package:flutter/material.dart';
import 'browser_screen.dart';
import 'nearby_screen.dart';
import 'settings_screen.dart';
import 'transfers_screen.dart';

class MainShell extends StatefulWidget {
  const MainShell({super.key});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _index = 0;

  static const _pages = [
    BrowserScreen(),
    NearbyScreen(),
    TransfersScreen(),
    SettingsScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Scaffold(
      body: IndexedStack(index: _index, children: _pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        backgroundColor: isDark ? const Color(0xFF1E293B) : Colors.white,
        indicatorColor: const Color(0xFF667EEA).withOpacity(.18),
        elevation: 0,
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.folder_outlined),
            selectedIcon: Icon(Icons.folder, color: Color(0xFF667EEA)),
            label: 'Files',
          ),
          NavigationDestination(
            icon: Icon(Icons.devices_other_outlined),
            selectedIcon: Icon(Icons.devices_other, color: Color(0xFF667EEA)),
            label: 'Nearby',
          ),
          NavigationDestination(
            icon: Icon(Icons.swap_horiz_outlined),
            selectedIcon: Icon(Icons.swap_horiz, color: Color(0xFF667EEA)),
            label: 'Transfers',
          ),
          NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings, color: Color(0xFF667EEA)),
            label: 'Settings',
          ),
        ],
      ),
    );
  }
}

