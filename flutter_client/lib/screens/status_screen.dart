import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:image_picker/image_picker.dart';
import 'package:video_player/video_player.dart';
import '../services/api_service.dart';

// ═══════════════════════════════════════════════════════════════════
// STATUS SCREEN — WhatsApp-style status list + Instagram 3D cube viewer
// ═══════════════════════════════════════════════════════════════════

class StatusScreen extends StatefulWidget {
  const StatusScreen({super.key});

  @override
  State<StatusScreen> createState() => _StatusScreenState();
}

class _StatusScreenState extends State<StatusScreen> {
  List<dynamic> _feed = [];
  bool _loading = true;
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    _loadFeed();
    _pollTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (mounted) _loadFeed(silent: true);
    });
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadFeed({bool silent = false}) async {
    if (!silent && mounted) setState(() => _loading = true);
    final api = context.read<ApiService>();
    final feed = await api.statusFeed();
    if (mounted) setState(() { _feed = feed; _loading = false; });
  }

  void _openStoryViewer(int userIndex) {
    Navigator.of(context).push(PageRouteBuilder(
      opaque: false,
      pageBuilder: (_, __, ___) => _StoryViewerShell(feed: _feed, initialUserIndex: userIndex, onViewed: _loadFeed),
      transitionsBuilder: (_, anim, __, child) => FadeTransition(opacity: anim, child: child),
      transitionDuration: const Duration(milliseconds: 250),
    ));
  }

  void _showPostOptions() {
    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFF1E293B),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 40, height: 4, margin: const EdgeInsets.only(top: 12, bottom: 16), decoration: BoxDecoration(color: Colors.white.withOpacity(0.2), borderRadius: BorderRadius.circular(2))),
        ListTile(
          leading: Container(padding: const EdgeInsets.all(10), decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]), borderRadius: BorderRadius.circular(12)),
            child: const Icon(Icons.camera_alt, color: Colors.white, size: 22)),
          title: const Text('Photo', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
          subtitle: Text('Take a photo or choose from gallery', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 12)),
          onTap: () { Navigator.pop(context); _pickAndPost(ImageSource.gallery); },
        ),
        ListTile(
          leading: Container(padding: const EdgeInsets.all(10), decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF22C55E), Color(0xFF16A34A)]), borderRadius: BorderRadius.circular(12)),
            child: const Icon(Icons.camera, color: Colors.white, size: 22)),
          title: const Text('Camera', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
          subtitle: Text('Capture a new photo', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 12)),
          onTap: () { Navigator.pop(context); _pickAndPost(ImageSource.camera); },
        ),
        ListTile(
          leading: Container(padding: const EdgeInsets.all(10), decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF3B82F6), Color(0xFF06B6D4)]), borderRadius: BorderRadius.circular(12)),
            child: const Icon(Icons.videocam, color: Colors.white, size: 22)),
          title: const Text('Video', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
          subtitle: Text('Share a video status', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 12)),
          onTap: () { Navigator.pop(context); _pickAndPostVideo(); },
        ),
        ListTile(
          leading: Container(padding: const EdgeInsets.all(10), decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFFEC4899), Color(0xFFF43F5E)]), borderRadius: BorderRadius.circular(12)),
            child: const Icon(Icons.text_fields, color: Colors.white, size: 22)),
          title: const Text('Text Status', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
          subtitle: Text('Share a text update with a gradient background', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 12)),
          onTap: () { Navigator.pop(context); _showTextStatusDialog(); },
        ),
        const SizedBox(height: 16),
      ])),
    );
  }

  Future<void> _pickAndPost(ImageSource source) async {
    try {
      final picker = ImagePicker();
      final picked = await picker.pickImage(source: source, imageQuality: 80, maxWidth: 1080);
      if (picked == null) return;

      // Show caption dialog
      final caption = await _showCaptionDialog();
      if (caption == null) return; // cancelled

      if (!mounted) return;
      _showUploadingSnackbar();

      final bytes = await File(picked.path).readAsBytes();
      final b64 = base64Encode(bytes);
      final ext = picked.path.split('.').last.toLowerCase();
      final mimeType = ext == 'png' ? 'image/png' : 'image/jpeg';

      final api = context.read<ApiService>();
      final result = await api.statusPost(mediaData: b64, mediaType: mimeType, caption: caption);

      if (mounted) {
        ScaffoldMessenger.of(context).hideCurrentSnackBar();
        if (result['success'] == true) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Status posted!'), backgroundColor: Color(0xFF22C55E), duration: Duration(seconds: 2)));
          _loadFeed();
        } else {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${result['error'] ?? 'Unknown'}'), backgroundColor: const Color(0xFFEF4444)));
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).hideCurrentSnackBar();
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e'), backgroundColor: const Color(0xFFEF4444)));
      }
    }
  }

  Future<void> _pickAndPostVideo() async {
    try {
      final picker = ImagePicker();
      final picked = await picker.pickVideo(source: ImageSource.gallery, maxDuration: const Duration(seconds: 30));
      if (picked == null) return;

      final caption = await _showCaptionDialog();
      if (caption == null) return;

      if (!mounted) return;
      _showUploadingSnackbar();

      final bytes = await File(picked.path).readAsBytes();
      final b64 = base64Encode(bytes);
      final ext = picked.path.split('.').last.toLowerCase();
      final mimeType = ext == 'webm' ? 'video/webm' : 'video/mp4';

      final api = context.read<ApiService>();
      final result = await api.statusPost(mediaData: b64, mediaType: mimeType, caption: caption);

      if (mounted) {
        ScaffoldMessenger.of(context).hideCurrentSnackBar();
        if (result['success'] == true) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Video status posted!'), backgroundColor: Color(0xFF22C55E), duration: Duration(seconds: 2)));
          _loadFeed();
        } else {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${result['error'] ?? 'Unknown'}'), backgroundColor: const Color(0xFFEF4444)));
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).hideCurrentSnackBar();
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e'), backgroundColor: const Color(0xFFEF4444)));
      }
    }
  }

  void _showUploadingSnackbar() {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
      content: Row(children: [
        SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)),
        SizedBox(width: 12),
        Text('Uploading status...'),
      ]),
      backgroundColor: Color(0xFF667EEA),
      duration: Duration(seconds: 30),
    ));
  }

  Future<String?> _showCaptionDialog() async {
    final controller = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF1E293B),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text('Add Caption', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLines: 3,
          maxLength: 200,
          style: const TextStyle(color: Colors.white),
          decoration: InputDecoration(
            hintText: 'Write a caption (optional)...',
            hintStyle: TextStyle(color: Colors.white.withOpacity(0.3)),
            filled: true,
            fillColor: const Color(0xFF0F172A),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
            counterStyle: TextStyle(color: Colors.white.withOpacity(0.3)),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: Text('Cancel', style: TextStyle(color: Colors.white.withOpacity(0.5)))),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF667EEA), foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Post'),
          ),
        ],
      ),
    );
  }

  static const _textGradients = [
    [Color(0xFF667EEA), Color(0xFF764BA2)],
    [Color(0xFFEC4899), Color(0xFFF43F5E)],
    [Color(0xFF22C55E), Color(0xFF0EA5E9)],
    [Color(0xFFF59E0B), Color(0xFFEF4444)],
    [Color(0xFF8B5CF6), Color(0xFFEC4899)],
    [Color(0xFF06B6D4), Color(0xFF3B82F6)],
  ];

  void _showTextStatusDialog() {
    final controller = TextEditingController();
    int gradIdx = 0;
    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setDlgState) {
        final grad = _textGradients[gradIdx % _textGradients.length];
        return AlertDialog(
          backgroundColor: const Color(0xFF1E293B),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          contentPadding: const EdgeInsets.all(16),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            // Preview
            GestureDetector(
              onTap: () => setDlgState(() => gradIdx++),
              child: Container(
                width: double.infinity, height: 200,
                decoration: BoxDecoration(gradient: LinearGradient(colors: grad, begin: Alignment.topLeft, end: Alignment.bottomRight), borderRadius: BorderRadius.circular(16)),
                alignment: Alignment.center,
                padding: const EdgeInsets.all(20),
                child: Text(controller.text.isEmpty ? 'Tap to change color' : controller.text,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white, fontSize: controller.text.length > 50 ? 16 : 22, fontWeight: FontWeight.w700)),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              maxLines: 3, maxLength: 200,
              style: const TextStyle(color: Colors.white),
              onChanged: (_) => setDlgState(() {}),
              decoration: InputDecoration(
                hintText: 'Type your status...',
                hintStyle: TextStyle(color: Colors.white.withOpacity(0.3)),
                filled: true, fillColor: const Color(0xFF0F172A),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
                counterStyle: TextStyle(color: Colors.white.withOpacity(0.3)),
              ),
            ),
            const SizedBox(height: 8),
            // Color picker row
            Row(mainAxisAlignment: MainAxisAlignment.center, children: List.generate(_textGradients.length, (i) {
              return GestureDetector(
                onTap: () => setDlgState(() => gradIdx = i),
                child: Container(
                  width: 28, height: 28, margin: const EdgeInsets.symmetric(horizontal: 4),
                  decoration: BoxDecoration(
                    gradient: LinearGradient(colors: _textGradients[i]),
                    shape: BoxShape.circle,
                    border: Border.all(color: i == gradIdx % _textGradients.length ? Colors.white : Colors.transparent, width: 2),
                  ),
                ),
              );
            })),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: Text('Cancel', style: TextStyle(color: Colors.white.withOpacity(0.5)))),
            ElevatedButton(
              style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF667EEA), foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
              onPressed: controller.text.trim().isEmpty ? null : () async {
                Navigator.pop(ctx);
                _showUploadingSnackbar();
                final api = context.read<ApiService>();
                final colorHex = '#${grad[0].value.toRadixString(16).padLeft(8, '0').substring(2)},#${grad[1].value.toRadixString(16).padLeft(8, '0').substring(2)}';
                final result = await api.statusPost(caption: controller.text.trim(), bgColor: colorHex);
                if (mounted) {
                  ScaffoldMessenger.of(context).hideCurrentSnackBar();
                  if (result['success'] == true) {
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Status posted!'), backgroundColor: Color(0xFF22C55E), duration: Duration(seconds: 2)));
                    _loadFeed();
                  }
                }
              },
              child: const Text('Post'),
            ),
          ],
        );
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final api = context.watch<ApiService>();
    // Auto-connect to server in background (Status works with server, not PC pairing)
    if (!api.isConnected) {
      api.ensureConnected();
    }
    final myStatuses = _feed.isNotEmpty && (_feed[0]['is_mine'] == true) ? _feed[0] : null;

    return Scaffold(
      backgroundColor: const Color(0xFF0F172A),
      body: Column(children: [
        // Header
        Container(
          padding: EdgeInsets.fromLTRB(20, MediaQuery.of(context).padding.top + 8, 16, 12),
          decoration: const BoxDecoration(color: Color(0xFF1E293B), border: Border(bottom: BorderSide(color: Color(0xFF334155), width: 0.5))),
          child: Row(children: [
            const Expanded(child: Text('Status', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: Colors.white))),
            if (api.isLoggedIn)
              IconButton(onPressed: _showPostOptions, icon: const Icon(Icons.add_circle_outline, color: Color(0xFF667EEA), size: 26), tooltip: 'New status'),
            IconButton(onPressed: () => _loadFeed(), icon: const Icon(Icons.refresh, color: Color(0xFF94A3B8), size: 22), tooltip: 'Refresh'),
          ]),
        ),
        // Body
        Expanded(child: _loading
          ? const Center(child: CircularProgressIndicator(color: Color(0xFF667EEA)))
          : !api.isLoggedIn
            ? _buildLoginPrompt()
            : _feed.isEmpty
              ? _buildEmptyState()
              : RefreshIndicator(
                  color: const Color(0xFF667EEA),
                  backgroundColor: const Color(0xFF1E293B),
                  onRefresh: () => _loadFeed(),
                  child: ListView(children: [
                    // My status
                    _buildMyStatusRow(myStatuses),
                    // Divider
                    if (_feed.length > 1 || (myStatuses == null && _feed.isNotEmpty))
                      Padding(
                        padding: const EdgeInsets.fromLTRB(20, 8, 20, 4),
                        child: Text('RECENT UPDATES', style: TextStyle(color: Colors.white.withOpacity(0.35), fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 1)),
                      ),
                    // Other statuses
                    ...List.generate(_feed.length, (i) {
                      final item = _feed[i];
                      if (item['is_mine'] == true) return const SizedBox.shrink();
                      return _StatusUserRow(
                        userName: item['user_name'] ?? 'Unknown',
                        statusCount: (item['statuses'] as List).length,
                        latestTime: (item['latest'] as num?)?.toDouble() ?? 0,
                        allViewed: item['all_viewed'] == true,
                        onTap: () => _openStoryViewer(i),
                      );
                    }),
                  ]),
                ),
        ),
      ]),
    );
  }

  Widget _buildMyStatusRow(dynamic myStatuses) {
    final hasStatus = myStatuses != null && (myStatuses['statuses'] as List).isNotEmpty;
    return InkWell(
      onTap: hasStatus ? () => _openStoryViewer(0) : _showPostOptions,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(children: [
          Stack(children: [
            Container(
              width: 56, height: 56,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: hasStatus
                  ? const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)], begin: Alignment.topLeft, end: Alignment.bottomRight)
                  : null,
                border: hasStatus ? null : Border.all(color: Colors.white.withOpacity(0.15), width: 2),
              ),
              padding: const EdgeInsets.all(3),
              child: CircleAvatar(
                radius: 24,
                backgroundColor: const Color(0xFF1E293B),
                child: Icon(hasStatus ? Icons.person : Icons.add, color: hasStatus ? const Color(0xFF667EEA) : Colors.white.withOpacity(0.5), size: 24),
              ),
            ),
            if (!hasStatus)
              Positioned(right: 0, bottom: 0, child: Container(
                width: 20, height: 20,
                decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]), shape: BoxShape.circle, border: Border.all(color: const Color(0xFF0F172A), width: 2)),
                child: const Icon(Icons.add, color: Colors.white, size: 12),
              )),
          ]),
          const SizedBox(width: 14),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('My Status', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 16)),
            const SizedBox(height: 2),
            Text(hasStatus ? '${(myStatuses['statuses'] as List).length} update(s) • Tap to view' : 'Tap to add status update',
              style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 13)),
          ])),
        ]),
      ),
    );
  }

  Widget _buildLoginPrompt() {
    return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
      Icon(Icons.amp_stories_outlined, size: 64, color: Colors.white.withOpacity(0.12)),
      const SizedBox(height: 16),
      Text('Login to share status updates', style: TextStyle(color: Colors.white.withOpacity(0.35), fontSize: 16)),
      const SizedBox(height: 16),
      GestureDetector(
        onTap: () {
          // Fallback: show snackbar
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Go to Settings to login'), backgroundColor: Color(0xFF667EEA)));
        },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
          decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]), borderRadius: BorderRadius.circular(20)),
          child: const Text('Login', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 14)),
        ),
      ),
    ]));
  }

  Widget _buildEmptyState() {
    return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
      Icon(Icons.amp_stories_outlined, size: 64, color: Colors.white.withOpacity(0.12)),
      const SizedBox(height: 16),
      Text('No status updates yet', style: TextStyle(color: Colors.white.withOpacity(0.35), fontSize: 16)),
      const SizedBox(height: 8),
      Text("Post a status or add friends to see theirs", style: TextStyle(color: Colors.white.withOpacity(0.2), fontSize: 13)),
      const SizedBox(height: 20),
      GestureDetector(
        onTap: _showPostOptions,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
          decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]), borderRadius: BorderRadius.circular(24)),
          child: const Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.add_photo_alternate, color: Colors.white, size: 20),
            SizedBox(width: 8),
            Text('Post Status', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 14)),
          ]),
        ),
      ),
    ]));
  }
}

// ─── Status row for other users ────────────────────────────────
class _StatusUserRow extends StatelessWidget {
  final String userName;
  final int statusCount;
  final double latestTime;
  final bool allViewed;
  final VoidCallback onTap;

  const _StatusUserRow({required this.userName, required this.statusCount, required this.latestTime, required this.allViewed, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final ago = _formatAgo(latestTime);
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(children: [
          Container(
            width: 52, height: 52,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: allViewed
                ? null
                : const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]),
              border: allViewed ? Border.all(color: Colors.white.withOpacity(0.15), width: 2) : null,
            ),
            padding: const EdgeInsets.all(3),
            child: CircleAvatar(
              radius: 22,
              backgroundColor: const Color(0xFF1E293B),
              child: Text(userName.isNotEmpty ? userName[0].toUpperCase() : '?', style: TextStyle(color: allViewed ? Colors.white.withOpacity(0.5) : const Color(0xFF667EEA), fontWeight: FontWeight.w700, fontSize: 18)),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(userName, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 15)),
            const SizedBox(height: 2),
            Text('$statusCount update${statusCount > 1 ? 's' : ''} • $ago', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 12)),
          ])),
          Icon(Icons.chevron_right, color: Colors.white.withOpacity(0.2), size: 22),
        ]),
      ),
    );
  }

  static String _formatAgo(double ts) {
    final diff = DateTime.now().millisecondsSinceEpoch / 1000 - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return '${(diff / 60).floor()}m ago';
    if (diff < 86400) return '${(diff / 3600).floor()}h ago';
    return '${(diff / 86400).floor()}d ago';
  }
}


// ═══════════════════════════════════════════════════════════════════
// 3D CUBE STORY VIEWER
// ═══════════════════════════════════════════════════════════════════

/// Shell that wraps multiple users' stories - swipe left/right to next user
class _StoryViewerShell extends StatefulWidget {
  final List<dynamic> feed;
  final int initialUserIndex;
  final VoidCallback onViewed;

  const _StoryViewerShell({required this.feed, required this.initialUserIndex, required this.onViewed});

  @override
  State<_StoryViewerShell> createState() => _StoryViewerShellState();
}

class _StoryViewerShellState extends State<_StoryViewerShell> {
  late PageController _pageController;
  late int _currentPage;

  @override
  void initState() {
    super.initState();
    _currentPage = widget.initialUserIndex;
    _pageController = PageController(initialPage: _currentPage);
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  void _goToNextUser() {
    if (_currentPage < widget.feed.length - 1) {
      _pageController.animateToPage(_currentPage + 1, duration: const Duration(milliseconds: 500), curve: Curves.easeInOut);
    } else {
      Navigator.pop(context);
      widget.onViewed();
    }
  }

  void _goToPrevUser() {
    if (_currentPage > 0) {
      _pageController.animateToPage(_currentPage - 1, duration: const Duration(milliseconds: 500), curve: Curves.easeInOut);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: _CubePageView(
        controller: _pageController,
        onPageChanged: (i) => setState(() => _currentPage = i),
        children: List.generate(widget.feed.length, (i) {
          final userGroup = widget.feed[i];
          final statuses = (userGroup['statuses'] as List?) ?? [];
          return _SingleUserStoryViewer(
            userName: userGroup['user_name'] ?? 'Unknown',
            isMine: userGroup['is_mine'] == true,
            statuses: statuses,
            onComplete: _goToNextUser,
            onPrevUser: _goToPrevUser,
          );
        }),
      ),
    );
  }
}


// ═══════════════════════════════════════════════════════════════════
// 3D CUBE PAGE VIEW — Instagram-style cube rotation transition
// ═══════════════════════════════════════════════════════════════════

class _CubePageView extends StatefulWidget {
  final PageController controller;
  final ValueChanged<int> onPageChanged;
  final List<Widget> children;

  const _CubePageView({required this.controller, required this.onPageChanged, required this.children});

  @override
  State<_CubePageView> createState() => _CubePageViewState();
}

class _CubePageViewState extends State<_CubePageView> {
  double _currentPageValue = 0;

  @override
  void initState() {
    super.initState();
    _currentPageValue = widget.controller.initialPage.toDouble();
    widget.controller.addListener(_onScroll);
  }

  void _onScroll() {
    setState(() {
      _currentPageValue = widget.controller.page ?? _currentPageValue;
    });
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onScroll);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return PageView.builder(
      controller: widget.controller,
      onPageChanged: widget.onPageChanged,
      itemCount: widget.children.length,
      physics: const BouncingScrollPhysics(),
      itemBuilder: (context, index) {
        // Calculate the rotation based on scroll position
        final double delta = _currentPageValue - index;
        // Clamp so we don't rotate more than 90 degrees
        final double rotationY = (delta.clamp(-1.0, 1.0)) * (math.pi / 2);

        // Determine alignment for the rotation pivot
        final Alignment alignment = delta > 0
            ? Alignment.centerLeft   // page is moving to the left
            : Alignment.centerRight; // page is moving to the right

        // Opacity dim for depth effect
        final double dimOpacity = (delta.abs() * 0.6).clamp(0.0, 0.6);

        return Transform(
          alignment: alignment,
          transform: Matrix4.identity()
            ..setEntry(3, 2, 0.001) // perspective
            ..rotateY(rotationY),
          child: Stack(
            fit: StackFit.expand,
            children: [
              // The actual story page
              widget.children[index],
              // Dim overlay for depth
              if (dimOpacity > 0.01)
                IgnorePointer(
                  child: Container(
                    color: Colors.black.withOpacity(dimOpacity),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}


// ═══════════════════════════════════════════════════════════════════
// SINGLE USER STORY VIEWER — auto-advance with progress bars
// ═══════════════════════════════════════════════════════════════════

class _SingleUserStoryViewer extends StatefulWidget {
  final String userName;
  final bool isMine;
  final List<dynamic> statuses;
  final VoidCallback onComplete;
  final VoidCallback onPrevUser;

  const _SingleUserStoryViewer({required this.userName, required this.isMine, required this.statuses, required this.onComplete, required this.onPrevUser});

  @override
  State<_SingleUserStoryViewer> createState() => _SingleUserStoryViewerState();
}

class _SingleUserStoryViewerState extends State<_SingleUserStoryViewer> with SingleTickerProviderStateMixin {
  int _currentIndex = 0;
  late AnimationController _progressController;
  bool _isPaused = false;
  VideoPlayerController? _videoController;
  bool _isVideo = false;

  @override
  void initState() {
    super.initState();
    _progressController = AnimationController(vsync: this, duration: const Duration(seconds: 6))
      ..addStatusListener((status) {
        if (status == AnimationStatus.completed) _nextStory();
      });
    _startStory();
  }

  @override
  void dispose() {
    _progressController.dispose();
    _videoController?.dispose();
    super.dispose();
  }

  void _startStory() {
    _markViewed();
    _disposeVideo();

    // Check if current status is video
    final current = widget.statuses[_currentIndex];
    final mediaType = (current['media_type'] as String? ?? '').toLowerCase();
    _isVideo = mediaType.startsWith('video/');

    if (_isVideo) {
      final statusId = current['id'] as String? ?? '';
      final url = context.read<ApiService>().statusMediaUrl(statusId);
      _videoController = VideoPlayerController.networkUrl(Uri.parse(url))
        ..initialize().then((_) {
          if (!mounted) return;
          setState(() {});
          _videoController!.play();
          // Set progress duration to video length
          final dur = _videoController!.value.duration;
          _progressController.duration = dur.inMilliseconds > 0 ? dur : const Duration(seconds: 10);
          _progressController.forward(from: 0);
        }).catchError((_) {
          // Fallback: treat as image
          setState(() => _isVideo = false);
          _progressController.duration = const Duration(seconds: 6);
          _progressController.forward(from: 0);
        });
    } else {
      _progressController.duration = const Duration(seconds: 6);
      _progressController.forward(from: 0);
    }
  }

  void _disposeVideo() {
    _videoController?.pause();
    _videoController?.dispose();
    _videoController = null;
  }

  void _markViewed() {
    if (!widget.isMine && _currentIndex < widget.statuses.length) {
      final sid = widget.statuses[_currentIndex]['id'] as String? ?? '';
      if (sid.isNotEmpty) {
        context.read<ApiService>().statusView(sid);
      }
    }
  }

  void _nextStory() {
    if (_currentIndex < widget.statuses.length - 1) {
      setState(() => _currentIndex++);
      _startStory();
    } else {
      widget.onComplete();
    }
  }

  void _prevStory() {
    if (_currentIndex > 0) {
      setState(() => _currentIndex--);
      _startStory();
    } else {
      widget.onPrevUser();
    }
  }

  void _onTapDown(TapDownDetails details) {
    _progressController.stop();
    _videoController?.pause();
    setState(() => _isPaused = true);
  }

  void _onTapUp(TapUpDetails details) {
    setState(() => _isPaused = false);
    _progressController.forward();
    _videoController?.play();
  }

  void _onLongPressEnd(LongPressEndDetails details) {
    setState(() => _isPaused = false);
    _progressController.forward();
    _videoController?.play();
  }

  void _handleTap(TapUpDetails details) {
    final w = MediaQuery.of(context).size.width;
    if (details.globalPosition.dx < w * 0.3) {
      _prevStory();
    } else {
      _nextStory();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.statuses.isEmpty) {
      return const Center(child: Text('No stories', style: TextStyle(color: Colors.white)));
    }

    final current = widget.statuses[_currentIndex];
    final hasMedia = current['has_media'] == true;
    final caption = current['caption'] as String? ?? '';
    final bgColor = current['bg_color'] as String? ?? '';
    final statusId = current['id'] as String? ?? '';
    final viewCount = current['view_count'] as int? ?? 0;

    return GestureDetector(
      onTapDown: _onTapDown,
      onTapUp: (d) { _onTapUp(d); _handleTap(d); },
      onLongPressEnd: _onLongPressEnd,
      child: Container(
        color: Colors.black,
        child: Stack(fit: StackFit.expand, children: [
          // Story content
          if (hasMedia && _isVideo && _videoController != null && _videoController!.value.isInitialized)
            Center(
              child: AspectRatio(
                aspectRatio: _videoController!.value.aspectRatio,
                child: VideoPlayer(_videoController!),
              ),
            )
          else if (hasMedia)
            _NetworkImageWithFallback(url: context.read<ApiService>().statusMediaUrl(statusId))
          else
            _TextStatusContent(caption: caption, bgColor: bgColor),

          // Caption bar on media stories
          if (hasMedia && caption.isNotEmpty)
            Positioned(
              bottom: 80, left: 0, right: 0,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                decoration: BoxDecoration(
                  gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter,
                    colors: [Colors.transparent, Colors.black.withOpacity(0.8)]),
                ),
                child: Text(caption, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w500, shadows: [Shadow(blurRadius: 8, color: Colors.black)])),
              ),
            ),

          // Top gradient
          Positioned(
            top: 0, left: 0, right: 0, height: 120,
            child: Container(
              decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter,
                colors: [Colors.black.withOpacity(0.6), Colors.transparent])),
            ),
          ),

          // Progress bars + user info
          Positioned(
            top: MediaQuery.of(context).padding.top + 8, left: 12, right: 12,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              // Progress indicators
              Row(children: List.generate(widget.statuses.length, (i) {
                return Expanded(child: Container(
                  margin: const EdgeInsets.symmetric(horizontal: 2),
                  height: 3,
                  child: AnimatedBuilder(
                    animation: _progressController,
                    builder: (ctx, _) {
                      double progress;
                      if (i < _currentIndex) {
                        progress = 1.0;
                      } else if (i == _currentIndex) {
                        progress = _progressController.value;
                      } else {
                        progress = 0.0;
                      }
                      return ClipRRect(
                        borderRadius: BorderRadius.circular(2),
                        child: LinearProgressIndicator(
                          value: progress,
                          backgroundColor: Colors.white.withOpacity(0.2),
                          valueColor: const AlwaysStoppedAnimation(Colors.white),
                          minHeight: 3,
                        ),
                      );
                    },
                  ),
                ));
              })),
              const SizedBox(height: 10),
              // User info row
              Row(children: [
                CircleAvatar(
                  radius: 16, backgroundColor: const Color(0xFF7C3AED).withOpacity(0.3),
                  child: Text(widget.userName.isNotEmpty ? widget.userName[0].toUpperCase() : '?', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 14)),
                ),
                const SizedBox(width: 10),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(widget.isMine ? 'My Status' : widget.userName, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 14)),
                  Text(_formatAgo((current['created'] as num?)?.toDouble() ?? 0), style: TextStyle(color: Colors.white.withOpacity(0.6), fontSize: 11)),
                ])),
                if (widget.isMine)
                  Row(children: [
                    Icon(Icons.remove_red_eye_outlined, color: Colors.white.withOpacity(0.6), size: 16),
                    const SizedBox(width: 4),
                    Text('$viewCount', style: TextStyle(color: Colors.white.withOpacity(0.6), fontSize: 12)),
                    const SizedBox(width: 12),
                  ]),
                // Close button
                GestureDetector(
                  onTap: () => Navigator.pop(context),
                  child: Container(
                    padding: const EdgeInsets.all(6),
                    decoration: BoxDecoration(color: Colors.white.withOpacity(0.15), shape: BoxShape.circle),
                    child: const Icon(Icons.close, color: Colors.white, size: 18),
                  ),
                ),
              ]),
            ]),
          ),

          // Pause indicator
          if (_isPaused)
            Positioned(
              top: MediaQuery.of(context).size.height / 2 - 24,
              left: MediaQuery.of(context).size.width / 2 - 24,
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: Colors.black.withOpacity(0.5), shape: BoxShape.circle),
                child: const Icon(Icons.pause, color: Colors.white, size: 24),
              ),
            ),
        ]),
      ),
    );
  }

  static String _formatAgo(double ts) {
    final diff = DateTime.now().millisecondsSinceEpoch / 1000 - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return '${(diff / 60).floor()}m ago';
    if (diff < 86400) return '${(diff / 3600).floor()}h ago';
    return '${(diff / 86400).floor()}d ago';
  }
}


// ─── Helper: network image with error fallback ─────────────────
class _NetworkImageWithFallback extends StatelessWidget {
  final String url;
  const _NetworkImageWithFallback({required this.url});

  @override
  Widget build(BuildContext context) {
    return Image.network(
      url,
      fit: BoxFit.contain,
      width: double.infinity,
      height: double.infinity,
      loadingBuilder: (ctx, child, progress) {
        if (progress == null) return child;
        final pct = progress.expectedTotalBytes != null
            ? progress.cumulativeBytesLoaded / progress.expectedTotalBytes!
            : null;
        return Center(child: CircularProgressIndicator(value: pct, color: const Color(0xFF667EEA)));
      },
      errorBuilder: (ctx, err, st) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.broken_image, color: Colors.white.withOpacity(0.3), size: 48),
        const SizedBox(height: 8),
        Text('Failed to load', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 13)),
      ])),
    );
  }
}


// ─── Helper: text status with gradient background ──────────────
class _TextStatusContent extends StatelessWidget {
  final String caption;
  final String bgColor;
  const _TextStatusContent({required this.caption, required this.bgColor});

  @override
  Widget build(BuildContext context) {
    List<Color> gradient = [const Color(0xFF667EEA), const Color(0xFF764BA2)];
    if (bgColor.contains(',')) {
      try {
        final parts = bgColor.split(',');
        gradient = parts.map((hex) {
          final clean = hex.trim().replaceFirst('#', '');
          return Color(int.parse('FF$clean', radix: 16));
        }).toList();
      } catch (_) {}
    }

    return Container(
      decoration: BoxDecoration(gradient: LinearGradient(colors: gradient, begin: Alignment.topLeft, end: Alignment.bottomRight)),
      alignment: Alignment.center,
      padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 48),
      child: Text(
        caption,
        textAlign: TextAlign.center,
        style: TextStyle(
          color: Colors.white,
          fontSize: caption.length > 100 ? 18 : caption.length > 50 ? 22 : 28,
          fontWeight: FontWeight.w700,
          height: 1.4,
          shadows: const [Shadow(blurRadius: 12, color: Colors.black26)],
        ),
      ),
    );
  }
}
