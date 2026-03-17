import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:audioplayers/audioplayers.dart';
import '../services/api_service.dart';
import 'voice_conversation_overlay.dart';

// ═══════════════════════════════════════════════════════════════
// BEAM AI - Full-featured AI assistant screen
// ═══════════════════════════════════════════════════════════════

class BeamAiScreen extends StatefulWidget {
  const BeamAiScreen({super.key});

  @override
  State<BeamAiScreen> createState() => _BeamAiScreenState();
}

class _BeamAiScreenState extends State<BeamAiScreen> with TickerProviderStateMixin {
  final _textController = TextEditingController();
  final _scrollController = ScrollController();
  final _focusNode = FocusNode();
  final List<_AiMessage> _messages = [];
  bool _isLoading = false;
  bool _showAttachMenu = false;
  File? _pendingFile;
  String? _pendingFileType; // 'image', 'document', 'file'
  String _deviceId = '';

  // Text selection highlight bar
  String? _selectedText;
  bool _showHighlightBar = false;

  // TTS playback
  bool _isSpeaking = false;
  int _speakingIndex = -1;
  final AudioPlayer _audioPlayer = AudioPlayer();

  @override
  void initState() {
    super.initState();
    _loadDeviceId();
    _autoConnectServer();
    // Add welcome message
    _messages.add(_AiMessage(
      text: "Hey! I'm BEAM AI, your personal assistant. I can help with tasks, reminders, answer questions, analyze files, search the web, and much more. What's on your mind?",
      isUser: false,
      timestamp: DateTime.now(),
      isAnimating: false,
    ));
  }

  Future<void> _loadDeviceId() async {
    final prefs = await SharedPreferences.getInstance();
    _deviceId = prefs.getString('p2p_device_id') ?? 'flutter-device';
  }

  /// Auto-connect to server in background for full AI features
  Future<void> _autoConnectServer() async {
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final api = context.read<ApiService>();
      if (!api.isConnected) {
        await api.ensureConnected();
      }
    });
  }

  @override
  void dispose() {
    _textController.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    _audioPlayer.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    Future.delayed(const Duration(milliseconds: 100), () {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  // ─── Send Text Message ─────────────────────────────────────
  Future<void> _sendMessage([String? overrideText]) async {
    final text = overrideText ?? _textController.text.trim();
    if (text.isEmpty && _pendingFile == null) return;
    _textController.clear();
    setState(() => _showAttachMenu = false);

    // If there's a pending file, process it with AI
    if (_pendingFile != null) {
      await _sendFileToAi(text);
      return;
    }

    // Add user message
    setState(() {
      _messages.add(_AiMessage(
        text: text,
        isUser: true,
        timestamp: DateTime.now(),
      ));
      _isLoading = true;
    });
    _scrollToBottom();

    // Call AI (uses server if connected, otherwise calls DeepSeek directly)
    final api = context.read<ApiService>();
    final result = await api.beamChatSmart(_deviceId, text);

    if (!mounted) return;

    final reply = result['reply'] ?? result['error'] ?? 'No response';
    final actions = List<Map<String, dynamic>>.from(result['actions'] ?? []);

    // Add AI reply with typing animation
    final aiMsg = _AiMessage(
      text: reply,
      isUser: false,
      timestamp: DateTime.now(),
      isAnimating: true,
      actions: actions,
    );
    setState(() {
      _messages.add(aiMsg);
      _isLoading = false;
    });
    _scrollToBottom();

    // Start typing animation
    _animateTyping(_messages.length - 1);
  }

  // ─── Typing Animation ─────────────────────────────────────
  void _animateTyping(int index) {
    if (index >= _messages.length) return;
    final msg = _messages[index];
    if (!msg.isAnimating) return;

    final fullText = msg.text;
    int charIndex = 0;

    Timer.periodic(const Duration(milliseconds: 18), (timer) {
      if (!mounted || charIndex >= fullText.length) {
        timer.cancel();
        if (mounted && index < _messages.length) {
          setState(() {
            _messages[index] = msg.copyWith(
              displayedText: fullText,
              isAnimating: false,
            );
          });
          _scrollToBottom();
        }
        return;
      }

      charIndex += 2; // 2 chars at a time for speed
      if (charIndex > fullText.length) charIndex = fullText.length;

      if (mounted && index < _messages.length) {
        setState(() {
          _messages[index] = msg.copyWith(
            displayedText: fullText.substring(0, charIndex),
          );
        });
        if (charIndex % 20 == 0) _scrollToBottom();
      }
    });
  }

  // ─── Send File to AI ───────────────────────────────────────
  Future<void> _sendFileToAi(String question) async {
    final file = _pendingFile!;
    final fileType = _pendingFileType ?? 'file';
    setState(() {
      _pendingFile = null;
      _pendingFileType = null;
    });

    // Determine action
    String action;
    if (fileType == 'image') {
      action = 'analyze';
    } else if (fileType == 'document') {
      action = 'summarize';
    } else {
      action = 'scan'; // security scan
    }

    final fileName = file.path.split(Platform.pathSeparator).last;

    // Add user message with file badge
    setState(() {
      _messages.add(_AiMessage(
        text: question.isNotEmpty ? question : 'Analyze this $fileType',
        isUser: true,
        timestamp: DateTime.now(),
        fileName: fileName,
        fileType: fileType,
      ));
      _isLoading = true;
    });
    _scrollToBottom();

    final api = context.read<ApiService>();
    final result = await api.beamProcessFile(_deviceId, file, action, question: question);

    if (!mounted) return;

    final reply = result['analysis'] ?? result['error'] ?? 'Could not process file.';
    final secLevel = result['security']?['level'] ?? '';

    final aiMsg = _AiMessage(
      text: reply,
      isUser: false,
      timestamp: DateTime.now(),
      isAnimating: true,
      securityLevel: secLevel,
    );
    setState(() {
      _messages.add(aiMsg);
      _isLoading = false;
    });
    _scrollToBottom();
    _animateTyping(_messages.length - 1);
  }

  // ─── Pick Image ────────────────────────────────────────────
  Future<void> _pickImage() async {
    setState(() => _showAttachMenu = false);
    final picker = ImagePicker();
    final result = await picker.pickImage(source: ImageSource.gallery, imageQuality: 80);
    if (result != null) {
      setState(() {
        _pendingFile = File(result.path);
        _pendingFileType = 'image';
      });
    }
  }

  Future<void> _takePhoto() async {
    setState(() => _showAttachMenu = false);
    final picker = ImagePicker();
    final result = await picker.pickImage(source: ImageSource.camera, imageQuality: 80);
    if (result != null) {
      setState(() {
        _pendingFile = File(result.path);
        _pendingFileType = 'image';
      });
    }
  }

  // ─── Pick Document ─────────────────────────────────────────
  Future<void> _pickDocument() async {
    setState(() => _showAttachMenu = false);
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['pdf', 'doc', 'docx', 'txt', 'csv', 'xlsx'],
    );
    if (result != null && result.files.single.path != null) {
      setState(() {
        _pendingFile = File(result.files.single.path!);
        _pendingFileType = 'document';
      });
    }
  }

  // ─── Pick Any File ─────────────────────────────────────────
  Future<void> _pickFile() async {
    setState(() => _showAttachMenu = false);
    final result = await FilePicker.platform.pickFiles();
    if (result != null && result.files.single.path != null) {
      setState(() {
        _pendingFile = File(result.files.single.path!);
        _pendingFileType = 'file';
      });
    }
  }

  // ─── TTS Playback ─────────────────────────────────────────
  Future<void> _playTTS(int index) async {
    if (_speakingIndex == index && _isSpeaking) {
      await _audioPlayer.stop();
      setState(() { _isSpeaking = false; _speakingIndex = -1; });
      return;
    }

    final msg = _messages[index];
    setState(() { _isSpeaking = true; _speakingIndex = index; });

    try {
      final api = context.read<ApiService>();
      // Try server TTS first if connected
      if (api.isConnected) {
        final result = await api.beamTTS(msg.text);
        if (!mounted) return;

        if (result['audio'] != null) {
          final audioBytes = base64Decode(result['audio']);
          final fmt = result['format'] ?? 'mp3';
          final dir = await getTemporaryDirectory();
          final file = File('${dir.path}/beam_tts_$index.$fmt');
          await file.writeAsBytes(audioBytes);

          _audioPlayer.onPlayerComplete.listen((_) {
            if (mounted) setState(() { _isSpeaking = false; _speakingIndex = -1; });
          });
          await _audioPlayer.play(DeviceFileSource(file.path));
          return;
        }
      }
      // Fallback: use Flutter TTS
      // No audio available, just inform user
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Connect to server for voice playback'), backgroundColor: Color(0xFF667EEA), duration: Duration(seconds: 2)),
        );
      }
    } catch (e) {
      debugPrint('TTS error: $e');
    }

    if (mounted) {
      setState(() { _isSpeaking = false; _speakingIndex = -1; });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // BUILD
  // ═══════════════════════════════════════════════════════════
  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;

    return Scaffold(
      backgroundColor: isDark ? const Color(0xFF0F172A) : const Color(0xFFF1F5F9),
      body: Column(
        children: [
          // ─── Header ───
          _buildHeader(isDark),

          // ─── Messages ───
          Expanded(
            child: GestureDetector(
              onTap: () {
                _focusNode.unfocus();
                setState(() { _showAttachMenu = false; _showHighlightBar = false; _selectedText = null; });
              },
              child: _messages.length <= 1 && !_isLoading
                  ? _buildWelcome(isDark)
                  : _buildMessageList(isDark),
            ),
          ),

          // ─── Pending File Preview ───
          if (_pendingFile != null) _buildFilePreview(isDark),

          // ─── Text Highlight Bar (Ask / Explain / Deeper) ───
          if (_showHighlightBar && _selectedText != null) _buildHighlightBar(isDark),

          // ─── Attach Menu ───
          if (_showAttachMenu) _buildAttachMenu(isDark),

          // ─── Input Bar ───
          _buildInputBar(isDark, bottomInset),
        ],
      ),
    );
  }

  // ─── Header ─────────────────────────────────────────────────
  Widget _buildHeader(bool isDark) {
    return Container(
      padding: EdgeInsets.only(
        top: MediaQuery.of(context).padding.top + 8,
        left: 16, right: 16, bottom: 12,
      ),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF667EEA), Color(0xFF7C3AED)],
          begin: Alignment.centerLeft,
          end: Alignment.centerRight,
        ),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFF667EEA).withOpacity(0.3),
            blurRadius: 20,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Row(
        children: [
          // AI Avatar
          Container(
            width: 40, height: 40,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(
                colors: [Colors.white.withOpacity(0.3), Colors.white.withOpacity(0.1)],
              ),
              border: Border.all(color: Colors.white.withOpacity(0.4), width: 2),
            ),
            child: const Icon(Icons.auto_awesome, color: Colors.white, size: 20),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('BEAM AI', style: TextStyle(
                  color: Colors.white, fontSize: 17, fontWeight: FontWeight.w700,
                  letterSpacing: 0.5,
                )),
                Row(
                  children: [
                    Container(
                      width: 7, height: 7,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Colors.greenAccent,
                        boxShadow: [BoxShadow(color: Colors.greenAccent.withOpacity(0.5), blurRadius: 4)],
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text('Online • Neural TTS',
                      style: TextStyle(color: Colors.white.withOpacity(0.8), fontSize: 11),
                    ),
                  ],
                ),
              ],
            ),
          ),
          // Menu
          IconButton(
            icon: const Icon(Icons.more_vert, color: Colors.white),
            onPressed: () => _showAiMenu(context),
          ),
        ],
      ),
    );
  }

  void _showAiMenu(BuildContext context) {
    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFF1E293B),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(width: 40, height: 4,
              decoration: BoxDecoration(color: Colors.white24, borderRadius: BorderRadius.circular(2))),
            const SizedBox(height: 20),
            _menuItem(Icons.delete_sweep, 'Clear Chat', () {
              Navigator.pop(ctx);
              setState(() => _messages.removeRange(1, _messages.length));
            }),
            _menuItem(Icons.task_alt, 'View Tasks', () {
              Navigator.pop(ctx);
              _showTasksSheet();
            }),
            _menuItem(Icons.notifications_active, 'View Reminders', () {
              Navigator.pop(ctx);
              _showRemindersSheet();
            }),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }

  Widget _menuItem(IconData icon, String label, VoidCallback onTap) {
    return ListTile(
      leading: Icon(icon, color: const Color(0xFF667EEA)),
      title: Text(label, style: const TextStyle(color: Colors.white)),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      onTap: onTap,
    );
  }

  // ─── Tasks Sheet ────────────────────────────────────────────
  void _showTasksSheet() async {
    final api = context.read<ApiService>();
    final tasks = await api.beamGetTasks(_deviceId);
    if (!mounted) return;
    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFF1E293B),
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.6,
        minChildSize: 0.3,
        maxChildSize: 0.9,
        expand: false,
        builder: (ctx, sc) => Column(
          children: [
            const SizedBox(height: 12),
            Container(width: 40, height: 4,
              decoration: BoxDecoration(color: Colors.white24, borderRadius: BorderRadius.circular(2))),
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('My Tasks', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w700)),
            ),
            Expanded(
              child: tasks.isEmpty
                ? const Center(child: Text('No tasks yet. Ask BEAM AI to create one!',
                    style: TextStyle(color: Colors.white54)))
                : ListView.builder(
                    controller: sc,
                    itemCount: tasks.length,
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    itemBuilder: (ctx, i) {
                      final t = tasks[i];
                      final priority = t['priority'] ?? 'medium';
                      final color = priority == 'high' ? Colors.redAccent
                          : priority == 'low' ? Colors.grey : const Color(0xFF667EEA);
                      return Container(
                        margin: const EdgeInsets.only(bottom: 8),
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: const Color(0xFF0F172A),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: color.withOpacity(0.3)),
                        ),
                        child: Row(
                          children: [
                            Icon(Icons.circle, size: 10, color: color),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(t['title'] ?? '', style: const TextStyle(
                                    color: Colors.white, fontWeight: FontWeight.w600)),
                                  if (t['due_date'] != null && t['due_date'].isNotEmpty)
                                    Text('Due: ${t['due_date']} ${t['due_time'] ?? ''}',
                                      style: const TextStyle(color: Colors.white54, fontSize: 12)),
                                ],
                              ),
                            ),
                            IconButton(
                              icon: const Icon(Icons.delete, color: Colors.white38, size: 18),
                              onPressed: () async {
                                await api.beamDeleteTask(t['id']);
                                Navigator.pop(ctx);
                                _showTasksSheet();
                              },
                            ),
                          ],
                        ),
                      );
                    },
                  ),
            ),
          ],
        ),
      ),
    );
  }

  // ─── Reminders Sheet ────────────────────────────────────────
  void _showRemindersSheet() async {
    final api = context.read<ApiService>();
    final rems = await api.beamGetReminders(_deviceId);
    if (!mounted) return;
    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFF1E293B),
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.6,
        minChildSize: 0.3,
        maxChildSize: 0.9,
        expand: false,
        builder: (ctx, sc) => Column(
          children: [
            const SizedBox(height: 12),
            Container(width: 40, height: 4,
              decoration: BoxDecoration(color: Colors.white24, borderRadius: BorderRadius.circular(2))),
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('My Reminders', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w700)),
            ),
            Expanded(
              child: rems.isEmpty
                ? const Center(child: Text('No reminders. Ask BEAM AI to set one!',
                    style: TextStyle(color: Colors.white54)))
                : ListView.builder(
                    controller: sc,
                    itemCount: rems.length,
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    itemBuilder: (ctx, i) {
                      final r = rems[i];
                      return Container(
                        margin: const EdgeInsets.only(bottom: 8),
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: const Color(0xFF0F172A),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: Colors.amber.withOpacity(0.3)),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.notifications_active, color: Colors.amber, size: 18),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(r['text'] ?? '', style: const TextStyle(
                                    color: Colors.white, fontWeight: FontWeight.w600)),
                                  if (r['remind_at'] != null && r['remind_at'].isNotEmpty)
                                    Text(r['remind_at'],
                                      style: const TextStyle(color: Colors.white54, fontSize: 12)),
                                ],
                              ),
                            ),
                            IconButton(
                              icon: const Icon(Icons.delete, color: Colors.white38, size: 18),
                              onPressed: () async {
                                await api.beamDeleteReminder(r['id']);
                                Navigator.pop(ctx);
                                _showRemindersSheet();
                              },
                            ),
                          ],
                        ),
                      );
                    },
                  ),
            ),
          ],
        ),
      ),
    );
  }

  // ─── Welcome (only shown when chat is empty) ───────────────
  Widget _buildWelcome(bool isDark) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // AI logo
            Container(
              width: 80, height: 80,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: const LinearGradient(
                  colors: [Color(0xFF667EEA), Color(0xFF7C3AED)],
                  begin: Alignment.topLeft, end: Alignment.bottomRight,
                ),
                boxShadow: [
                  BoxShadow(
                    color: const Color(0xFF667EEA).withOpacity(0.4),
                    blurRadius: 40, spreadRadius: 4,
                  ),
                ],
              ),
              child: const Icon(Icons.auto_awesome, color: Colors.white, size: 36),
            ),
            const SizedBox(height: 20),
            const Text('BEAM AI', style: TextStyle(
              fontSize: 24, fontWeight: FontWeight.w800,
              color: Colors.white, letterSpacing: 1,
            )),
            const SizedBox(height: 8),
            Text('Your personal AI assistant',
              style: TextStyle(color: Colors.white.withOpacity(0.5), fontSize: 14)),
            const SizedBox(height: 28),

            // Welcome bubble
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: isDark ? const Color(0xFF1E293B) : Colors.white,
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: const Color(0xFF667EEA).withOpacity(0.2)),
              ),
              child: Text(
                _messages.isNotEmpty ? _messages[0].text : "Hey! I'm BEAM AI. What can I help you with?",
                style: TextStyle(
                  color: isDark ? Colors.white.withOpacity(0.85) : Colors.black87,
                  fontSize: 14, height: 1.5,
                ),
                textAlign: TextAlign.center,
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ─── Message List ───────────────────────────────────────────
  Widget _buildMessageList(bool isDark) {
    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      itemCount: _messages.length + (_isLoading ? 1 : 0),
      itemBuilder: (context, index) {
        if (index == _messages.length && _isLoading) {
          return _buildTypingIndicator(isDark);
        }
        final msg = _messages[index];
        if (index == 0 && !msg.isUser) {
          // Skip welcome message in list when chat is active
          return const SizedBox.shrink();
        }
        return _buildMessageBubble(msg, index, isDark);
      },
    );
  }

  // ─── Message Bubble ─────────────────────────────────────────
  Widget _buildMessageBubble(_AiMessage msg, int index, bool isDark) {
    final isUser = msg.isUser;
    final displayText = msg.isAnimating
        ? (msg.displayedText ?? '')
        : msg.text;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        mainAxisAlignment: isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (!isUser) ...[
            // AI avatar
            Container(
              width: 30, height: 30,
              margin: const EdgeInsets.only(right: 8, bottom: 2),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: const LinearGradient(
                  colors: [Color(0xFF667EEA), Color(0xFF7C3AED)],
                ),
                boxShadow: [
                  BoxShadow(color: const Color(0xFF667EEA).withOpacity(0.3), blurRadius: 8),
                ],
              ),
              child: const Icon(Icons.auto_awesome, color: Colors.white, size: 14),
            ),
          ],
          // Bubble
          Flexible(
            child: Container(
              constraints: BoxConstraints(
                maxWidth: MediaQuery.of(context).size.width * 0.78,
              ),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: isUser
                    ? const Color(0xFF667EEA)
                    : (isDark ? const Color(0xFF1E293B) : Colors.white),
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(18),
                  topRight: const Radius.circular(18),
                  bottomLeft: Radius.circular(isUser ? 18 : 4),
                  bottomRight: Radius.circular(isUser ? 4 : 18),
                ),
                border: isUser ? null : Border.all(
                  color: isDark ? Colors.white.withOpacity(0.06) : Colors.black.withOpacity(0.06),
                ),
                boxShadow: [
                  BoxShadow(
                    color: (isUser ? const Color(0xFF667EEA) : Colors.black).withOpacity(0.1),
                    blurRadius: 8, offset: const Offset(0, 2),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // File badge
                  if (msg.fileName != null) ...[
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      margin: const EdgeInsets.only(bottom: 6),
                      decoration: BoxDecoration(
                        color: Colors.white.withOpacity(isUser ? 0.2 : 0.05),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            msg.fileType == 'image' ? Icons.image
                                : msg.fileType == 'document' ? Icons.description
                                : Icons.insert_drive_file,
                            size: 14,
                            color: isUser ? Colors.white70 : const Color(0xFF667EEA),
                          ),
                          const SizedBox(width: 6),
                          Flexible(
                            child: Text(msg.fileName!,
                              style: TextStyle(
                                fontSize: 11,
                                color: isUser ? Colors.white70 : Colors.white54,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],

                  // Security badge
                  if (msg.securityLevel.isNotEmpty) ...[
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      margin: const EdgeInsets.only(bottom: 6),
                      decoration: BoxDecoration(
                        color: msg.securityLevel == 'safe'
                            ? Colors.green.withOpacity(0.15)
                            : msg.securityLevel == 'warning'
                            ? Colors.orange.withOpacity(0.15)
                            : Colors.red.withOpacity(0.15),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            msg.securityLevel == 'safe' ? Icons.verified_user
                                : Icons.warning,
                            size: 12,
                            color: msg.securityLevel == 'safe' ? Colors.green : Colors.orange,
                          ),
                          const SizedBox(width: 4),
                          Text(msg.securityLevel.toUpperCase(),
                            style: TextStyle(
                              fontSize: 10, fontWeight: FontWeight.w700,
                              color: msg.securityLevel == 'safe' ? Colors.green : Colors.orange,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],

                  // Message text
                  isUser || msg.isAnimating
                    ? Text(
                        displayText,
                        style: TextStyle(
                          color: isUser ? Colors.white : (isDark ? Colors.white.withOpacity(0.9) : Colors.black87),
                          fontSize: 14, height: 1.45,
                        ),
                      )
                    : SelectableText(
                        displayText,
                        style: TextStyle(
                          color: isDark ? Colors.white.withOpacity(0.9) : Colors.black87,
                          fontSize: 14, height: 1.45,
                        ),
                        onSelectionChanged: (selection, cause) {
                          final sel = displayText.substring(selection.start, selection.end);
                          if (sel.trim().isNotEmpty && sel.trim().length > 2) {
                            setState(() { _selectedText = sel.trim(); _showHighlightBar = true; });
                          } else {
                            setState(() { _showHighlightBar = false; });
                          }
                        },
                      ),

                  // Cursor for typing animation
                  if (msg.isAnimating) ...[
                    const SizedBox(height: 2),
                    Container(
                      width: 2, height: 14,
                      color: const Color(0xFF667EEA),
                    ),
                  ],

                  // Action badges
                  if (msg.actions.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: msg.actions.map((a) {
                        final type = a['type'] ?? '';
                        IconData icon;
                        String label;
                        Color color;
                        if (type == 'task_created') {
                          icon = Icons.task_alt;
                          label = 'Task created: ${a['task']?['title'] ?? ''}';
                          color = const Color(0xFF667EEA);
                        } else if (type == 'reminder_created') {
                          icon = Icons.notifications_active;
                          label = 'Reminder set: ${a['reminder']?['text'] ?? ''}';
                          color = Colors.amber;
                        } else if (type == 'web_search_done') {
                          icon = Icons.search;
                          label = 'Web search: ${a['query'] ?? ''}';
                          color = Colors.tealAccent;
                        } else {
                          icon = Icons.info;
                          label = type;
                          color = Colors.grey;
                        }
                        return Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                          decoration: BoxDecoration(
                            color: color.withOpacity(0.15),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: color.withOpacity(0.3)),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(icon, size: 12, color: color),
                              const SizedBox(width: 4),
                              Flexible(
                                child: Text(label,
                                  style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w600),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ],
                          ),
                        );
                      }).toList(),
                    ),
                  ],

                  // Listen button (AI messages only, after animation)
                  if (!isUser && !msg.isAnimating && msg.text.length > 10) ...[
                    const SizedBox(height: 6),
                    GestureDetector(
                      onTap: () => _playTTS(index),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            _speakingIndex == index && _isSpeaking ? Icons.pause_circle : Icons.volume_up,
                            size: 14,
                            color: const Color(0xFF667EEA).withOpacity(0.7),
                          ),
                          const SizedBox(width: 4),
                          Text(
                            _speakingIndex == index && _isSpeaking ? 'Playing...' : 'Listen',
                            style: TextStyle(
                              fontSize: 11,
                              color: const Color(0xFF667EEA).withOpacity(0.7),
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],

                  // Timestamp
                  const SizedBox(height: 4),
                  Text(
                    '${msg.timestamp.hour.toString().padLeft(2, '0')}:${msg.timestamp.minute.toString().padLeft(2, '0')}',
                    style: TextStyle(
                      fontSize: 10,
                      color: isUser ? Colors.white.withOpacity(0.5) : Colors.white.withOpacity(0.3),
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (isUser) const SizedBox(width: 4),
        ],
      ),
    );
  }

  // ─── Typing Indicator ───────────────────────────────────────
  Widget _buildTypingIndicator(bool isDark) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Container(
            width: 30, height: 30,
            margin: const EdgeInsets.only(right: 8, bottom: 2),
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: const LinearGradient(
                colors: [Color(0xFF667EEA), Color(0xFF7C3AED)],
              ),
            ),
            child: const Icon(Icons.auto_awesome, color: Colors.white, size: 14),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: isDark ? const Color(0xFF1E293B) : Colors.white,
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(18),
                topRight: Radius.circular(18),
                bottomRight: Radius.circular(18),
                bottomLeft: Radius.circular(4),
              ),
            ),
            child: const _TypingDots(),
          ),
        ],
      ),
    );
  }

  // ─── File Preview ───────────────────────────────────────────
  Widget _buildFilePreview(bool isDark) {
    final name = _pendingFile!.path.split(Platform.pathSeparator).last;
    final isImage = _pendingFileType == 'image';

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF1E293B) : Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFF667EEA).withOpacity(0.3)),
      ),
      child: Row(
        children: [
          if (isImage)
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: Image.file(_pendingFile!, width: 48, height: 48, fit: BoxFit.cover),
            )
          else
            Container(
              width: 48, height: 48,
              decoration: BoxDecoration(
                color: const Color(0xFF667EEA).withOpacity(0.1),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(
                _pendingFileType == 'document' ? Icons.description : Icons.insert_drive_file,
                color: const Color(0xFF667EEA), size: 22,
              ),
            ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name,
                  style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600),
                  overflow: TextOverflow.ellipsis,
                ),
                Text('Tap send to analyze with AI',
                  style: TextStyle(color: Colors.white.withOpacity(0.5), fontSize: 11)),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close, color: Colors.white38, size: 18),
            onPressed: () => setState(() { _pendingFile = null; _pendingFileType = null; }),
          ),
        ],
      ),
    );
  }

  // ─── Attach Menu ────────────────────────────────────────────
  Widget _buildAttachMenu(bool isDark) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF1E293B) : Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.white.withOpacity(0.06)),
        boxShadow: [
          BoxShadow(color: Colors.black.withOpacity(0.2), blurRadius: 16, offset: const Offset(0, -4)),
        ],
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          _attachOption(Icons.image, 'Gallery', Colors.pinkAccent, _pickImage),
          _attachOption(Icons.camera_alt, 'Camera', Colors.amber, _takePhoto),
          _attachOption(Icons.description, 'Document', Colors.blue, _pickDocument),
          _attachOption(Icons.folder, 'File', Colors.teal, _pickFile),
        ],
      ),
    );
  }

  Widget _attachOption(IconData icon, String label, Color color, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 50, height: 50,
            decoration: BoxDecoration(
              color: color.withOpacity(0.12),
              shape: BoxShape.circle,
            ),
            child: Icon(icon, color: color, size: 22),
          ),
          const SizedBox(height: 6),
          Text(label, style: TextStyle(color: Colors.white.withOpacity(0.6), fontSize: 11)),
        ],
      ),
    );
  }

  // ─── Highlight Bar (Ask / Explain / Deeper) ─────────────────
  Widget _buildHighlightBar(bool isDark) {
    final selectedPreview = (_selectedText != null && _selectedText!.length > 40)
        ? '"${_selectedText!.substring(0, 40)}..."'
        : '"${_selectedText ?? ''}"';

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF1E293B) : Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF667EEA).withOpacity(0.25)),
        boxShadow: [
          BoxShadow(color: const Color(0xFF667EEA).withOpacity(0.08), blurRadius: 12, offset: const Offset(0, -2)),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Selected text preview
          Row(
            children: [
              const Text('\u201C\u201C', style: TextStyle(color: Color(0xFF667EEA), fontSize: 16, fontWeight: FontWeight.w800)),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  selectedPreview,
                  style: TextStyle(color: Colors.white.withOpacity(0.6), fontSize: 12, fontStyle: FontStyle.italic),
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          // Action buttons
          Row(
            children: [
              _highlightActionBtn(Icons.question_answer, 'Ask', const Color(0xFF667EEA), true, () {
                _onHighlightAction('ask');
              }),
              const SizedBox(width: 8),
              _highlightActionBtn(Icons.lightbulb_outline, 'Explain', const Color(0xFF667EEA), false, () {
                _onHighlightAction('explain');
              }),
              const SizedBox(width: 8),
              _highlightActionBtn(Icons.all_inclusive, 'Deeper', const Color(0xFF667EEA), false, () {
                _onHighlightAction('deeper');
              }),
              const Spacer(),
              GestureDetector(
                onTap: () => setState(() { _showHighlightBar = false; _selectedText = null; }),
                child: Icon(Icons.close, color: Colors.white.withOpacity(0.4), size: 20),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _highlightActionBtn(IconData icon, String label, Color color, bool filled, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        decoration: BoxDecoration(
          color: filled ? color : Colors.transparent,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: color.withOpacity(filled ? 0 : 0.4)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: filled ? Colors.white : color.withOpacity(0.8)),
            const SizedBox(width: 4),
            Text(label, style: TextStyle(
              fontSize: 12, fontWeight: FontWeight.w600,
              color: filled ? Colors.white : color.withOpacity(0.8),
            )),
          ],
        ),
      ),
    );
  }

  void _onHighlightAction(String action) {
    if (_selectedText == null || _selectedText!.isEmpty) return;
    final text = _selectedText!;
    setState(() { _showHighlightBar = false; _selectedText = null; });

    String prompt;
    switch (action) {
      case 'ask':
        prompt = 'About this: "$text"\n\nWhat can you tell me about this?';
        break;
      case 'explain':
        prompt = 'Please explain this in simple terms: "$text"';
        break;
      case 'deeper':
        prompt = 'Go deeper into this topic with more detail and examples: "$text"';
        break;
      default:
        prompt = text;
    }
    _sendMessage(prompt);
  }

  // ─── Input Bar ──────────────────────────────────────────────
  Widget _buildInputBar(bool isDark, double bottomInset) {
    return Container(
      padding: EdgeInsets.only(
        left: 8, right: 8, top: 8,
        bottom: bottomInset > 0 ? 8 : MediaQuery.of(context).padding.bottom + 8,
      ),
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF0F172A) : const Color(0xFFF1F5F9),
        border: Border(top: BorderSide(color: Colors.white.withOpacity(0.05))),
      ),
      child: Row(
        children: [
          // Attach button
          IconButton(
            icon: Icon(
              _showAttachMenu ? Icons.close : Icons.add_circle_outline,
              color: const Color(0xFF667EEA),
              size: 26,
            ),
            onPressed: () => setState(() => _showAttachMenu = !_showAttachMenu),
          ),
          // Text field
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                color: isDark ? const Color(0xFF1E293B) : Colors.white,
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: Colors.white.withOpacity(0.06)),
              ),
              child: TextField(
                controller: _textController,
                focusNode: _focusNode,
                style: const TextStyle(color: Colors.white, fontSize: 15),
                decoration: InputDecoration(
                  hintText: 'Ask BEAM AI anything...',
                  hintStyle: TextStyle(color: Colors.white.withOpacity(0.3)),
                  border: InputBorder.none,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                ),
                maxLines: 4,
                minLines: 1,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _sendMessage(),
                onTap: () => setState(() => _showAttachMenu = false),
              ),
            ),
          ),
          const SizedBox(width: 4),
          // Mic button — opens voice conversation overlay
          GestureDetector(
            onTap: _isLoading ? null : () {
              Navigator.of(context).push(
                PageRouteBuilder(
                  pageBuilder: (_, __, ___) => const VoiceConversationOverlay(),
                  transitionsBuilder: (_, anim, __, child) {
                    return FadeTransition(
                      opacity: anim,
                      child: SlideTransition(
                        position: Tween<Offset>(
                          begin: const Offset(0, 0.15),
                          end: Offset.zero,
                        ).animate(CurvedAnimation(parent: anim, curve: Curves.easeOut)),
                        child: child,
                      ),
                    );
                  },
                  transitionDuration: const Duration(milliseconds: 350),
                ),
              );
            },
            child: Container(
              width: 38, height: 38,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: const LinearGradient(
                  colors: [Color(0xFF667EEA), Color(0xFF7C3AED)],
                ),
                boxShadow: [
                  BoxShadow(color: const Color(0xFF667EEA).withOpacity(0.3), blurRadius: 8),
                ],
              ),
              child: const Icon(Icons.mic, color: Colors.white, size: 19),
            ),
          ),
          const SizedBox(width: 4),
          // Send button
          Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: const LinearGradient(
                colors: [Color(0xFF667EEA), Color(0xFF7C3AED)],
              ),
              boxShadow: [
                BoxShadow(color: const Color(0xFF667EEA).withOpacity(0.3), blurRadius: 8),
              ],
            ),
            child: IconButton(
              icon: Icon(
                _isLoading ? Icons.hourglass_empty : Icons.send_rounded,
                color: Colors.white, size: 20,
              ),
              onPressed: _isLoading ? null : () => _sendMessage(),
            ),
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Data Model
// ═══════════════════════════════════════════════════════════════
class _AiMessage {
  final String text;
  final String? displayedText;
  final bool isUser;
  final DateTime timestamp;
  final bool isAnimating;
  final String? fileName;
  final String? fileType;
  final String securityLevel;
  final List<Map<String, dynamic>> actions;
  final String? audioBase64;

  _AiMessage({
    required this.text,
    this.displayedText,
    required this.isUser,
    required this.timestamp,
    this.isAnimating = false,
    this.fileName,
    this.fileType,
    this.securityLevel = '',
    this.actions = const [],
    this.audioBase64,
  });

  _AiMessage copyWith({
    String? displayedText,
    bool? isAnimating,
  }) {
    return _AiMessage(
      text: text,
      displayedText: displayedText ?? this.displayedText,
      isUser: isUser,
      timestamp: timestamp,
      isAnimating: isAnimating ?? this.isAnimating,
      fileName: fileName,
      fileType: fileType,
      securityLevel: securityLevel,
      actions: actions,
      audioBase64: audioBase64,
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Typing Dots Animation
// ═══════════════════════════════════════════════════════════════
class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots> with TickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 1200),
      vsync: this,
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: List.generate(3, (i) {
            final delay = i * 0.2;
            final value = (_controller.value - delay).clamp(0.0, 1.0);
            final bounce = (value < 0.5)
                ? Curves.easeOut.transform(value * 2)
                : Curves.easeIn.transform((1 - value) * 2);
            return Container(
              margin: EdgeInsets.only(right: i < 2 ? 4 : 0),
              child: Transform.translate(
                offset: Offset(0, -bounce * 6),
                child: Container(
                  width: 8, height: 8,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: const Color(0xFF667EEA).withOpacity(0.4 + bounce * 0.6),
                  ),
                ),
              ),
            );
          }),
        );
      },
    );
  }
}
