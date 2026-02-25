import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/api_service.dart';
import '../models/file_item.dart';
import '../widgets/file_card.dart';

class BrowserScreen extends StatefulWidget {
  const BrowserScreen({super.key});

  @override
  State<BrowserScreen> createState() => _BrowserScreenState();
}

class _BrowserScreenState extends State<BrowserScreen> {
  List<FileItem> _items = [];
  String _currentPath = '';
  bool _loading = true;
  String? _error;
  final List<String> _history = [];
  final _searchCtrl = TextEditingController();
  String _query = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadInitial());
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadInitial() async {
    final api = context.read<ApiService>();
    final startDir = api.info?.directory ?? '';
    await _browse(startDir);
  }

  /// Re-fetch server info; if the shared directory changed, navigate there.
  /// Otherwise just reload the current directory listing.
  Future<void> _refreshAndDetectChange() async {
    final api = context.read<ApiService>();
    final oldDir = api.info?.directory ?? '';
    await api.checkConnection();
    if (!mounted) return;
    final newDir = api.info?.directory ?? '';
    if (newDir.isNotEmpty && newDir != oldDir) {
      // Shared directory changed on the server — navigate to the new root
      _history.clear();
      _searchCtrl.clear();
      _query = '';
      await _browse(newDir);
    } else {
      await _browse(_currentPath);
    }
  }

  Future<void> _browse(String path) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final api = context.read<ApiService>();
    final result = await api.browse(path);
    if (!mounted) return;
    if (result != null) {
      setState(() {
        _items = result.items;
        _currentPath = result.currentPath.isNotEmpty ? result.currentPath : path;
        _loading = false;
      });
    } else {
      setState(() {
        _error = 'Failed to load directory';
        _loading = false;
      });
    }
  }

  void _navigateTo(String path) {
    _history.add(_currentPath);
    _searchCtrl.clear();
    _query = '';
    _browse(path);
  }

  void _goBack() {
    if (_history.isEmpty) return;
    final prev = _history.removeLast();
    _searchCtrl.clear();
    _query = '';
    _browse(prev);
  }

  List<FileItem> get _filtered {
    if (_query.isEmpty) return _items;
    final q = _query.toLowerCase();
    return _items.where((f) => f.name.toLowerCase().contains(q)).toList();
  }

  // Sorted: folders first, then by name
  List<FileItem> get _sorted {
    final list = List<FileItem>.from(_filtered);
    list.sort((a, b) {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.toLowerCase().compareTo(b.name.toLowerCase());
    });
    return list;
  }

  String _shortPath(String path) {
    if (path.isEmpty) return '/';
    // Show just last 2 segments
    final sep = path.contains(r'\') ? r'\' : '/';
    final parts = path.split(sep).where((s) => s.isNotEmpty).toList();
    if (parts.length <= 2) return path;
    return '…${sep}${parts[parts.length - 2]}${sep}${parts.last}';
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final api = context.watch<ApiService>();

    return Scaffold(
      backgroundColor:
          isDark ? const Color(0xFF0F172A) : const Color(0xFFF1F5F9),
      body: SafeArea(
        child: Column(
          children: [
            // ── Header ──────────────────────────────────────
            _Header(
              api: api,
              canGoBack: _history.isNotEmpty,
              onBack: _goBack,
              onRefresh: _refreshAndDetectChange,
              isDark: isDark,
            ),
            // ── Breadcrumb ───────────────────────────────────
            _Breadcrumb(
              path: _shortPath(_currentPath),
              isDark: isDark,
            ),
            // ── Search ───────────────────────────────────────
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              child: TextField(
                controller: _searchCtrl,
                onChanged: (v) => setState(() => _query = v),
                style: TextStyle(
                    color: isDark ? Colors.white : const Color(0xFF1E293B),
                    fontSize: 14),
                decoration: InputDecoration(
                  hintText: 'Search files…',
                  hintStyle: TextStyle(
                      color: Colors.grey.withOpacity(.5), fontSize: 14),
                  prefixIcon: Icon(Icons.search,
                      color: Colors.grey.withOpacity(.6), size: 20),
                  suffixIcon: _query.isNotEmpty
                      ? IconButton(
                          icon: const Icon(Icons.clear, size: 18),
                          onPressed: () {
                            _searchCtrl.clear();
                            setState(() => _query = '');
                          },
                        )
                      : null,
                  filled: true,
                  fillColor:
                      isDark ? const Color(0xFF1E293B) : Colors.white,
                  contentPadding: const EdgeInsets.symmetric(
                      horizontal: 16, vertical: 12),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ),
            // ── File list ────────────────────────────────────
            Expanded(
              child: _loading
                  ? const Center(
                      child: CircularProgressIndicator(
                          color: Color(0xFF667EEA)))
                  : _error != null
                      ? _ErrorState(
                          message: _error!,
                          onRetry: () => _browse(_currentPath))
                      : _sorted.isEmpty
                          ? _EmptyState(hasQuery: _query.isNotEmpty)
                          : ListView.builder(
                              padding: const EdgeInsets.fromLTRB(14, 4, 14, 24),
                              itemCount: _sorted.length,
                              itemBuilder: (ctx, i) {
                                final item = _sorted[i];
                                return FileCard(
                                  item: item,
                                  onTap: item.isDirectory
                                      ? () => _navigateTo(item.path)
                                      : () => _showFileSheet(item),
                                  onDownload: item.isDirectory
                                      ? null
                                      : () => _download(item),
                                );
                              },
                            ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _download(FileItem file) async {
    final api = context.read<ApiService>();
    final url = api.downloadUrl(file.path);
    final uri = Uri.parse(url);
    try {
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri, mode: LaunchMode.externalApplication);
      } else {
        // Fallback to Flask
        final fallback = Uri.parse(api.flaskDownloadUrl(file.path));
        await launchUrl(fallback, mode: LaunchMode.externalApplication);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Download failed: $e')),
        );
      }
    }
  }

  void _showFileSheet(FileItem file) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _FileDetailSheet(
        file: file,
        onDownload: () {
          Navigator.pop(context);
          _download(file);
        },
      ),
    );
  }
}

// ── Header ────────────────────────────────────────────────────────────────
class _Header extends StatelessWidget {
  final ApiService api;
  final bool canGoBack;
  final VoidCallback onBack;
  final VoidCallback onRefresh;
  final bool isDark;
  const _Header({
    required this.api,
    required this.canGoBack,
    required this.onBack,
    required this.onRefresh,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
      child: Row(
        children: [
          // Back button
          AnimatedOpacity(
            opacity: canGoBack ? 1 : .3,
            duration: const Duration(milliseconds: 200),
            child: _IconBtn(
              icon: Icons.arrow_back_ios_rounded,
              onTap: canGoBack ? onBack : null,
              isDark: isDark,
            ),
          ),
          const SizedBox(width: 10),
          // Title + connection dot
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'File Browser',
                  style: TextStyle(
                      fontSize: 18, fontWeight: FontWeight.w800),
                ),
                Row(
                  children: [
                    Container(
                      width: 7, height: 7,
                      margin: const EdgeInsets.only(right: 5),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: api.isConnected
                            ? const Color(0xFF4ADE80)
                            : const Color(0xFFF87171),
                        boxShadow: api.isConnected
                            ? [
                                BoxShadow(
                                  color: const Color(0xFF4ADE80).withOpacity(.5),
                                  blurRadius: 6,
                                )
                              ]
                            : null,
                      ),
                    ),
                    Text(
                      api.isConnected
                          ? '${api.serverIp} · Fast Transfer'
                          : 'Disconnected',
                      style: TextStyle(
                        fontSize: 11,
                        color: Colors.grey.withOpacity(.6),
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          // Refresh
          _IconBtn(
              icon: Icons.refresh_rounded,
              onTap: onRefresh,
              isDark: isDark),
        ],
      ),
    );
  }
}

class _IconBtn extends StatelessWidget {
  final IconData icon;
  final VoidCallback? onTap;
  final bool isDark;
  const _IconBtn(
      {required this.icon, required this.onTap, required this.isDark});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 40, height: 40,
        decoration: BoxDecoration(
          color: isDark
              ? Colors.white.withOpacity(.07)
              : Colors.black.withOpacity(.05),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(icon, size: 18,
            color: isDark ? Colors.white : const Color(0xFF1E293B)),
      ),
    );
  }
}

// ── Breadcrumb ────────────────────────────────────────────────────────────
class _Breadcrumb extends StatelessWidget {
  final String path;
  final bool isDark;
  const _Breadcrumb({required this.path, required this.isDark});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: isDark
            ? Colors.white.withOpacity(.05)
            : Colors.black.withOpacity(.04),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          Container(
            width: 22, height: 22,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(5),
              gradient: const LinearGradient(
                  colors: [Color(0xFF667EEA), Color(0xFF764BA2)]),
            ),
            child: const Icon(Icons.home, color: Colors.white, size: 13),
          ),
          const SizedBox(width: 8),
          const Icon(Icons.chevron_right,
              size: 14, color: Colors.grey),
          const SizedBox(width: 4),
          Expanded(
            child: Text(
              path,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                color: Colors.grey.withOpacity(.8),
                fontFamily: 'monospace',
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Empty / Error states ──────────────────────────────────────────────────
class _EmptyState extends StatelessWidget {
  final bool hasQuery;
  const _EmptyState({required this.hasQuery});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(hasQuery ? Icons.search_off : Icons.folder_open,
              size: 64, color: Colors.grey.withOpacity(.3)),
          const SizedBox(height: 16),
          Text(
            hasQuery ? 'No matches found' : 'This folder is empty',
            style: TextStyle(color: Colors.grey.withOpacity(.5), fontSize: 15),
          ),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorState({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline, size: 56, color: Color(0xFFF87171)),
          const SizedBox(height: 12),
          Text(message,
              style: const TextStyle(color: Color(0xFFF87171), fontSize: 13)),
          const SizedBox(height: 16),
          TextButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh, color: Color(0xFF667EEA)),
            label: const Text('Retry',
                style: TextStyle(color: Color(0xFF667EEA))),
          ),
        ],
      ),
    );
  }
}

// ── File detail bottom sheet ──────────────────────────────────────────────
class _FileDetailSheet extends StatelessWidget {
  final FileItem file;
  final VoidCallback onDownload;
  const _FileDetailSheet({required this.file, required this.onDownload});

  String _size() {
    final b = file.size;
    if (b <= 0) return '—';
    if (b < 1024) return '$b B';
    if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(1)} KB';
    if (b < 1024 * 1024 * 1024)
      return '${(b / (1024 * 1024)).toStringAsFixed(1)} MB';
    return '${(b / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB';
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.fromLTRB(
          24, 16, 24, MediaQuery.of(context).viewInsets.bottom + 32),
      decoration: const BoxDecoration(
        color: Color(0xFF1E293B),
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Handle
          Center(
            child: Container(
              width: 36, height: 4,
              margin: const EdgeInsets.only(bottom: 20),
              decoration: BoxDecoration(
                color: Colors.white.withOpacity(.2),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          // Icon + name
          Row(
            children: [
              _FileIconBubble(extension: file.extension, size: 52),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      file.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${file.extension.isNotEmpty ? file.extension.toUpperCase().replaceFirst('.', '') : 'File'}  ·  ${_size()}',
                      style: TextStyle(
                          color: Colors.white.withOpacity(.45), fontSize: 12),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),
          // Path
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.black.withOpacity(.2),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              file.path,
              style: TextStyle(
                color: Colors.white.withOpacity(.5),
                fontSize: 11,
                fontFamily: 'monospace',
              ),
            ),
          ),
          const SizedBox(height: 20),
          // Download button
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton.icon(
              onPressed: onDownload,
              icon: const Icon(Icons.download_rounded),
              label: const Text('Download',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF4ADE80),
                foregroundColor: Colors.white,
                elevation: 0,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _FileIconBubble extends StatelessWidget {
  final String extension;
  final double size;
  const _FileIconBubble({required this.extension, required this.size});

  static const _gradients = {
    'folder': [Color(0xFF667EEA), Color(0xFF764BA2)],
    'apk': [Color(0xFF3DDC84), Color(0xFF00B96B)],
    'image': [Color(0xFFF43F5E), Color(0xFFEC4899)],
    'video': [Color(0xFF8B5CF6), Color(0xFF6D28D9)],
    'audio': [Color(0xFF3B82F6), Color(0xFF2563EB)],
    'doc': [Color(0xFFF97316), Color(0xFFEA580C)],
    'archive': [Color(0xFF78716C), Color(0xFF57534E)],
    'default': [Color(0xFF94A3B8), Color(0xFF64748B)],
  };

  String _category() {
    final ext = extension.toLowerCase();
    if (ext == '.apk') return 'apk';
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].contains(ext))
      return 'image';
    if (['.mp4', '.mkv', '.avi', '.mov', '.wmv'].contains(ext)) return 'video';
    if (['.mp3', '.wav', '.flac', '.aac', '.ogg'].contains(ext)) return 'audio';
    if (['.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx', '.ppt']
        .contains(ext)) return 'doc';
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].contains(ext)) return 'archive';
    return 'default';
  }

  IconData _icon() {
    switch (_category()) {
      case 'apk': return Icons.android;
      case 'image': return Icons.image;
      case 'video': return Icons.videocam;
      case 'audio': return Icons.music_note;
      case 'doc': return Icons.description;
      case 'archive': return Icons.archive;
      default: return Icons.insert_drive_file;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = _gradients[_category()] ?? _gradients['default']!;
    return Container(
      width: size, height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.26),
        gradient: LinearGradient(colors: colors),
      ),
      child: Icon(_icon(), color: Colors.white, size: size * 0.5),
    );
  }
}
