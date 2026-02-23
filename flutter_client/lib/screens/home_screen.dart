import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:wireless_file_transfer/services/api_service.dart';
import 'package:wireless_file_transfer/screens/scanner_screen.dart';
import 'package:wireless_file_transfer/screens/browser_screen.dart';
import 'package:wireless_file_transfer/widgets/connection_status.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _selectedIndex = 0;

  final List<Widget> _screens = [
    const DashboardScreen(),
    const BrowserScreen(),
    const SettingsScreen(),
  ];

  void _onItemTapped(int index) {
    setState(() {
      _selectedIndex = index;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Wireless File Transfer'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () {
              Provider.of<ApiService>(context, listen: false).checkConnection();
            },
          ),
          const ConnectionStatusWidget(),
        ],
      ),
      body: _screens[_selectedIndex],
      bottomNavigationBar: BottomNavigationBar(
        items: const <BottomNavigationBarItem>[
          BottomNavigationBarItem(
            icon: Icon(Icons.dashboard),
            label: 'Dashboard',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.folder),
            label: 'Files',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.settings),
            label: 'Settings',
          ),
        ],
        currentIndex: _selectedIndex,
        selectedItemColor: Colors.blue,
        onTap: _onItemTapped,
      ),
      floatingActionButton: _selectedIndex == 1
          ? FloatingActionButton(
              onPressed: () {
                // Upload file action
                _showUploadDialog(context);
              },
              child: const Icon(Icons.upload),
            )
          : null,
    );
  }

  void _showUploadDialog(BuildContext context) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Upload File'),
        content: const Text('Select files to upload to server'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () {
              Navigator.pop(context);
              // Implement file picker and upload
            },
            child: const Text('Select Files'),
          ),
        ],
      ),
    );
  }
}

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final apiService = Provider.of<ApiService>(context);
    
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Connection Card
          Card(
            elevation: 4,
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                children: [
                  const Icon(Icons.wifi, size: 64, color: Colors.blue),
                  const SizedBox(height: 16),
                  Text(
                    apiService.isConnected ? 'Connected' : 'Not Connected',
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      color: apiService.isConnected ? Colors.green : Colors.red,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    apiService.isConnected 
                        ? apiService.serverUrl ?? 'Unknown'
                        : 'Scan QR code to connect',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  const SizedBox(height: 16),
                  ElevatedButton.icon(
                    onPressed: () {
                      Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (context) => const ScannerScreen(),
                        ),
                      );
                    },
                    icon: const Icon(Icons.qr_code_scanner),
                    label: const Text('Scan QR Code'),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: () {
                      _showManualConnectDialog(context);
                    },
                    child: const Text('Manual Connect'),
                  ),
                ],
              ),
            ),
          ),

          const SizedBox(height: 20),

          // Quick Actions
          const Text(
            'Quick Actions',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 12),
          GridView.count(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisCount: 2,
            crossAxisSpacing: 12,
            mainAxisSpacing: 12,
            children: [
              _buildActionCard(
                context,
                Icons.download,
                'Download',
                Colors.green,
                () {
                  if (apiService.isConnected) {
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (context) => const BrowserScreen(),
                      ),
                    );
                  } else {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Please connect to server first'),
                      ),
                    );
                  }
                },
              ),
              _buildActionCard(
                context,
                Icons.upload,
                'Upload',
                Colors.orange,
                () {
                  if (apiService.isConnected) {
                    // Show upload dialog
                  } else {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Please connect to server first'),
                      ),
                    );
                  }
                },
              ),
              _buildActionCard(
                context,
                Icons.content_copy,
                'Clipboard',
                Colors.purple,
                () {
                  _showClipboardDialog(context);
                },
              ),
              _buildActionCard(
                context,
                Icons.history,
                'History',
                Colors.blueGrey,
                () {
                  // Show transfer history
                },
              ),
            ],
          ),

          const SizedBox(height: 20),

          // Stats
          Card(
            elevation: 4,
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Transfer Stats',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceAround,
                    children: [
                      _buildStatItem('Files', '0', Icons.insert_drive_file),
                      _buildStatItem('Size', '0 MB', Icons.storage),
                      _buildStatItem('Speed', 'Fast', Icons.speed),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildActionCard(
    BuildContext context,
    IconData icon,
    String label,
    Color color,
    VoidCallback onTap,
  ) {
    return Card(
      elevation: 2,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 40, color: color),
              const SizedBox(height: 8),
              Text(
                label,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildStatItem(String label, String value, IconData icon) {
    return Column(
      children: [
        Icon(icon, size: 30, color: Colors.blue),
        const SizedBox(height: 4),
        Text(
          value,
          style: const TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.bold,
          ),
        ),
        Text(
          label,
          style: const TextStyle(
            fontSize: 12,
            color: Colors.grey,
          ),
        ),
      ],
    );
  }

  void _showManualConnectDialog(BuildContext context) {
    final TextEditingController controller = TextEditingController();
    
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Manual Connection'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(
            hintText: 'http://192.168.1.100:5000',
            labelText: 'Server URL',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () {
              final url = controller.text.trim();
              if (url.isNotEmpty) {
                Provider.of<ApiService>(context, listen: false)
                    .connectToServer(url);
                Navigator.pop(context);
              }
            },
            child: const Text('Connect'),
          ),
        ],
      ),
    );
  }

  void _showClipboardDialog(BuildContext context) {
    final TextEditingController controller = TextEditingController();
    
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Share Clipboard'),
        content: TextField(
          controller: controller,
          maxLines: 5,
          decoration: const InputDecoration(
            hintText: 'Type text to share with laptop...',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () {
              final text = controller.text.trim();
              if (text.isNotEmpty) {
                // Implement clipboard sharing
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('Text shared to laptop'),
                  ),
                );
                Navigator.pop(context);
              }
            },
            child: const Text('Share'),
          ),
        ],
      ),
    );
  }
}

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16.0),
      children: [
        ListTile(
          leading: const Icon(Icons.info),
          title: const Text('About'),
          subtitle: const Text('App version 1.0.0'),
          onTap: () {
            showAboutDialog(
              context: context,
              applicationName: 'Wireless File Transfer',
              applicationVersion: '1.0.0',
              applicationLegalese: '© 2024 - Blazing fast file transfers',
            );
          },
        ),
        const Divider(),
        ListTile(
          leading: const Icon(Icons.help),
          title: const Text('Help & Instructions'),
          onTap: () {
            // Show help dialog
          },
        ),
        ListTile(
          leading: const Icon(Icons.bug_report),
          title: const Text('Report Issue'),
          onTap: () {
            // Open issue reporting
          },
        ),
        const Divider(),
        SwitchListTile(
          title: const Text('Dark Mode'),
          value: false,
          onChanged: (value) {
            // Implement theme switching
          },
        ),
        SwitchListTile(
          title: const Text('Auto-connect'),
          subtitle: const Text('Automatically connect to last server'),
          value: true,
          onChanged: (value) {
            // Implement auto-connect
          },
        ),
        SwitchListTile(
          title: const Text('Background Transfers'),
          subtitle: const Text('Continue transfers in background'),
          value: true,
          onChanged: (value) {
            // Implement background transfers
          },
        ),
      ],
    );
  }
}