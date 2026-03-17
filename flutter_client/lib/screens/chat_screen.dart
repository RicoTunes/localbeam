import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:file_picker/file_picker.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:emoji_picker_flutter/emoji_picker_flutter.dart';
import '../services/api_service.dart';
import 'auth_screen.dart';

// ─────────────────────────────────────────────────────────────
// ChatScreen  — WhatsApp-style chat matching the web interface
// ─────────────────────────────────────────────────────────────

class ChatScreen extends StatefulWidget {
  final ValueChanged<bool>? onConversationChanged;
  const ChatScreen({super.key, this.onConversationChanged});
  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;

  static const _recorderChannel = MethodChannel('com.localbeam/recorder');
  static const _playerChannel = MethodChannel('com.localbeam/player');

  String _deviceId = '';
  String _deviceName = '';
  List<P2PDevice> _devices = [];
  List<Map<String, dynamic>> _allMessages = [];
  Timer? _pollTimer;

  // Active conversation
  String? _activeConvoId;
  String? _activeConvoName;
  List<Map<String, dynamic>> _convoMessages = [];
  Timer? _convoTimer;
  final _msgCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();
  final _msgFocusNode = FocusNode();
  List<Map<String, dynamic>> _typers = [];
  DateTime? _lastTypingSent;

  // Voice recording state
  bool _isRecording = false;
  int _recordingSeconds = 0;
  Timer? _recordingTimer;

  // Audio playback state
  String? _playingMsgId;
  bool _isAudioPlaying = false;
  int _audioPosition = 0;
  int _audioDuration = 0;

  // Friends
  List<Map<String, dynamic>> _friends = [];
  List<Map<String, dynamic>> _incomingRequests = [];
  List<Map<String, dynamic>> _outgoingRequests = [];

  // Reply state
  Map<String, dynamic>? _replyToMessage;

  // Edit state
  String? _editingMsgId;

  // Emoji picker state
  bool _showEmojiPicker = false;

  // Track which friend requests are being processed
  final Set<String> _processingRequests = {};

  // Friend poll timer
  Timer? _friendPollTimer;

  // Tab state: 0 = Messages, 1 = Friends
  int _chatTab = 0;

  // Scaffold key — must be a class field so it survives rebuilds
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  @override
  void initState() {
    super.initState();
    _msgCtrl.addListener(() {
      if (mounted) setState(() {});
    });
    // Listen for native audio player callbacks
    _playerChannel.setMethodCallHandler((call) async {
      if (!mounted) return;
      if (call.method == 'onComplete') {
        setState(() { _playingMsgId = null; _isAudioPlaying = false; _audioPosition = 0; _audioDuration = 0; });
      } else if (call.method == 'onProgress') {
        final pos = call.arguments['position'] as int? ?? 0;
        final dur = call.arguments['duration'] as int? ?? 0;
        setState(() { _audioPosition = pos; _audioDuration = dur; });
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _init());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _convoTimer?.cancel();
    _recordingTimer?.cancel();
    _friendPollTimer?.cancel();
    _stopAudioPlayback();
    _msgCtrl.dispose();
    _scrollCtrl.dispose();
    _msgFocusNode.dispose();
    super.dispose();
  }

  Future<void> _init() async {
    final prefs = await SharedPreferences.getInstance();
    _deviceId = prefs.getString('p2p_device_id') ?? '';
    _deviceName = prefs.getString('p2p_device_name') ?? '';
    if (_deviceId.isEmpty) {
      final api = context.read<ApiService>();
      final result = await api.p2pRegister(name: _deviceName.isNotEmpty ? _deviceName : null);
      if (result != null) {
        _deviceId = result['device_id'] ?? '';
        _deviceName = result['name'] ?? '';
        await prefs.setString('p2p_device_id', _deviceId);
        await prefs.setString('p2p_device_name', _deviceName);
      }
    }
    // Link device to auth account if logged in
    final api = context.read<ApiService>();
    await api.loadAuthState();
    if (api.isLoggedIn && _deviceId.isNotEmpty) {
      api.authLinkDevice(_deviceId);
      _loadFriends();
    }
    _startPolling();
  }

  Future<void> _loadFriends() async {
    final api = context.read<ApiService>();
    if (!api.isLoggedIn) return;
    try {
      final profile = await api.authProfile();
      if (profile != null && mounted) {
        final user = profile['user'];
        final friends = user is Map ? user['friends'] : profile['friends'];
        if (friends is List) {
          final newFriends = List<Map<String, dynamic>>.from(friends);
          final changed = newFriends.length != _friends.length;
          _friends = newFriends;
          if (changed && mounted) setState(() {});
        }
      }
      // Also load friend requests
      final reqData = await api.authFriendRequests();
      if (mounted) {
        final newIn = List<Map<String, dynamic>>.from(reqData['incoming'] ?? []);
        final newOut = List<Map<String, dynamic>>.from(reqData['outgoing'] ?? []);
        final changed = newIn.length != _incomingRequests.length || newOut.length != _outgoingRequests.length;
        _incomingRequests = newIn;
        _outgoingRequests = newOut;
        if (changed) setState(() {});
      }
    } catch (e) {
      debugPrint('[FriendReq] _loadFriends error: $e');
    }
  }

  Future<void> _acceptFriendRequest(String reqId, String fromName) async {
    if (_processingRequests.contains(reqId)) return;
    setState(() => _processingRequests.add(reqId));
    try {
      final api2 = context.read<ApiService>();
      final result = await api2.authAcceptFriend(reqId);
      if (mounted) {
        _processingRequests.remove(reqId);
        if (result['error'] != null) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text('Could not accept: ${result['error']}'),
            backgroundColor: const Color(0xFFF87171),
          ));
          setState(() {});
        } else {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text('$fromName is now your friend! Tap their name to chat.'),
            backgroundColor: const Color(0xFF4ADE80),
          ));
          await _loadFriends();
        }
      }
    } catch (e) {
      if (mounted) {
        _processingRequests.remove(reqId);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Connection error. Please try again.'),
          backgroundColor: const Color(0xFFF87171),
        ));
        setState(() {});
      }
    }
  }

  Future<void> _rejectFriendRequest(String reqId, String fromName) async {
    if (_processingRequests.contains(reqId)) return;
    setState(() => _processingRequests.add(reqId));
    try {
      final api2 = context.read<ApiService>();
      await api2.authRejectFriend(reqId);
      if (mounted) {
        _processingRequests.remove(reqId);
        await _loadFriends();
      }
    } catch (e) {
      if (mounted) {
        _processingRequests.remove(reqId);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Connection error. Please try again.'),
          backgroundColor: Color(0xFFF87171),
        ));
        setState(() {});
      }
    }
  }

  void _startPolling() {
    _pollTimer?.cancel();
    _friendPollTimer?.cancel();
    _pollConversations();
    _pollTimer = Timer.periodic(const Duration(seconds: 3), (_) => _pollConversations());
    // Poll friends & requests every 10 seconds so new requests appear automatically
    _friendPollTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      if (mounted) _loadFriends();
    });
  }

  Future<void> _pollConversations() async {
    if (!mounted || _deviceId.isEmpty) return;
    final api = context.read<ApiService>();
    api.p2pRegister(deviceId: _deviceId, name: _deviceName);
    final devices = await api.p2pDevices();
    final msgs = await api.p2pGetMessages(_deviceId);
    if (mounted) {
      // Only rebuild if data actually changed — avoids keyboard/drawer dismissal
      final devChanged = devices.length != _devices.length ||
          devices.any((d) => !_devices.any((od) => od.id == d.id));
      final msgChanged = msgs.length != _allMessages.length ||
          (msgs.isNotEmpty && _allMessages.isNotEmpty &&
           msgs.first['id'] != _allMessages.first['id']);
      if (devChanged || msgChanged) {
        setState(() {
          _devices = devices;
          _allMessages = msgs;
        });
      } else {
        _devices = devices;
        _allMessages = msgs;
      }
    }
  }

  List<_Conversation> _buildConversations() {
    final Map<String, _Conversation> convos = {};
    for (final msg in _allMessages) {
      final senderId = msg['sender_id'] as String? ?? '';
      final recipientId = msg['recipient_id'] as String? ?? '';
      final otherId = senderId == _deviceId ? recipientId : senderId;
      if (otherId.isEmpty) continue;
      if (!convos.containsKey(otherId)) {
        String name = msg['sender_name'] as String? ?? 'Unknown';
        if (senderId == _deviceId) {
          final dev = _devices.where((d) => d.id == otherId).toList();
          name = dev.isNotEmpty ? dev.first.name : otherId.substring(0, 8);
        }
        convos[otherId] = _Conversation(deviceId: otherId, deviceName: name, lastMessage: msg, unreadCount: 0);
      }
      final existing = convos[otherId]!;
      final existingTs = (existing.lastMessage['timestamp'] as num?)?.toDouble() ?? 0;
      final newTs = (msg['timestamp'] as num?)?.toDouble() ?? 0;
      if (newTs > existingTs) {
        convos[otherId] = _Conversation(deviceId: otherId, deviceName: existing.deviceName, lastMessage: msg, unreadCount: existing.unreadCount);
      }
      if (recipientId == _deviceId && msg['read'] != true) {
        convos[otherId] = _Conversation(deviceId: otherId, deviceName: convos[otherId]!.deviceName, lastMessage: convos[otherId]!.lastMessage, unreadCount: convos[otherId]!.unreadCount + 1);
      }
    }
    final list = convos.values.toList();
    list.sort((a, b) {
      final aTs = (a.lastMessage['timestamp'] as num?)?.toDouble() ?? 0;
      final bTs = (b.lastMessage['timestamp'] as num?)?.toDouble() ?? 0;
      return bTs.compareTo(aTs);
    });
    return list;
  }

  void _openConversation(String deviceId, String deviceName) {
    setState(() { _activeConvoId = deviceId; _activeConvoName = deviceName; });
    widget.onConversationChanged?.call(true);
    _loadConvoMessages();
    _convoTimer?.cancel();
    _convoTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      _loadConvoMessages();
      _checkTyping();
    });
  }

  void _closeConversation() {
    _convoTimer?.cancel();
    setState(() { _activeConvoId = null; _activeConvoName = null; _convoMessages = []; _typers = []; });
    widget.onConversationChanged?.call(false);
    _pollConversations();
  }

  Future<void> _loadConvoMessages() async {
    if (_activeConvoId == null || _deviceId.isEmpty) return;
    final api = context.read<ApiService>();
    final msgs = await api.p2pGetMessages(_deviceId, withDevice: _activeConvoId!);
    if (mounted && _activeConvoId != null) {
      setState(() => _convoMessages = msgs);
      for (final msg in msgs) {
        if (msg['recipient_id'] == _deviceId && msg['read'] != true) {
          api.p2pMarkRead(msg['id'] as String);
        }
      }
      _scrollToBottom();
    }
  }

  Future<void> _checkTyping() async {
    if (_deviceId.isEmpty) return;
    final api = context.read<ApiService>();
    final typers = await api.p2pGetTyping(_deviceId);
    if (mounted) {
      setState(() => _typers = typers.where((t) => t['device_id'] == _activeConvoId).toList());
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(_scrollCtrl.position.maxScrollExtent, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  // ── Send message (or edit if _editingMsgId is set) ────────
  Future<void> _sendMessage() async {
    final text = _msgCtrl.text.trim();
    if (text.isEmpty || _activeConvoId == null) return;
    _msgCtrl.clear();
    final editId = _editingMsgId;
    final replyId = _replyToMessage?['id'] as String?;
    setState(() { _replyToMessage = null; _editingMsgId = null; _showEmojiPicker = false; });
    final api = context.read<ApiService>();
    if (editId != null) {
      // Call edit API
      await api.p2pEditMessage(editId, text);
    } else {
      await api.p2pSendMessage(senderId: _deviceId, recipientId: _activeConvoId!, senderName: _deviceName, text: text, replyTo: replyId);
    }
    _loadConvoMessages();
  }

  // ── Send files (multi-select) ──────────────────────────────
  Future<void> _sendFile() async {
    if (_activeConvoId == null) return;
    final result = await FilePicker.platform.pickFiles(allowMultiple: true, type: FileType.any);
    if (result == null || result.files.isEmpty) return;
    final api = context.read<ApiService>();
    for (final pickedFile in result.files) {
      if (pickedFile.path == null) continue;
      final file = File(pickedFile.path!);
      final bytes = await file.readAsBytes();
      final base64Data = base64Encode(bytes);
      final fileName = pickedFile.name;
      final ext = fileName.split('.').last.toLowerCase();
      String mimeType = 'application/octet-stream';
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].contains(ext)) mimeType = 'image/$ext';
      else if (['mp4', 'mov', 'avi', 'webm'].contains(ext)) mimeType = 'video/$ext';
      else if (['mp3', 'wav', 'ogg', 'aac', 'm4a'].contains(ext)) mimeType = 'audio/$ext';
      else if (ext == 'pdf') mimeType = 'application/pdf';
      await api.p2pSendMessage(senderId: _deviceId, recipientId: _activeConvoId!, senderName: _deviceName, mediaData: base64Data, mediaType: mimeType, fileName: fileName);
    }
    _loadConvoMessages();
  }

  // ── Send photos (multi-select images) ──────────────────────
  Future<void> _sendPhotos() async {
    if (_activeConvoId == null) return;
    final result = await FilePicker.platform.pickFiles(allowMultiple: true, type: FileType.image);
    if (result == null || result.files.isEmpty) return;
    final api = context.read<ApiService>();
    for (final pickedFile in result.files) {
      if (pickedFile.path == null) continue;
      final file = File(pickedFile.path!);
      final bytes = await file.readAsBytes();
      final base64Data = base64Encode(bytes);
      final fileName = pickedFile.name;
      final ext = fileName.split('.').last.toLowerCase();
      final mimeType = 'image/${ext == 'jpg' ? 'jpeg' : ext}';
      await api.p2pSendMessage(senderId: _deviceId, recipientId: _activeConvoId!, senderName: _deviceName, mediaData: base64Data, mediaType: mimeType, fileName: fileName);
    }
    _loadConvoMessages();
  }

  // ── Attachment menu ────────────────────────────────────────
  void _showAttachmentMenu() {
    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFF1E293B),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const CircleAvatar(backgroundColor: Color(0xFF4ADE80), child: Icon(Icons.photo_library, color: Colors.white)),
              title: const Text('Photos', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
              subtitle: const Text('Select multiple photos', style: TextStyle(color: Color(0xFF94A3B8), fontSize: 12)),
              onTap: () { Navigator.pop(ctx); _sendPhotos(); },
            ),
            ListTile(
              leading: const CircleAvatar(backgroundColor: Color(0xFF667EEA), child: Icon(Icons.insert_drive_file, color: Colors.white)),
              title: const Text('Files', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
              subtitle: const Text('Any file type', style: TextStyle(color: Color(0xFF94A3B8), fontSize: 12)),
              onTap: () { Navigator.pop(ctx); _sendFile(); },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  // ── Audio Playback ─────────────────────────────────────────
  Future<void> _toggleAudioPlayback(String msgId) async {
    // If already playing this message, toggle pause/resume
    if (_playingMsgId == msgId) {
      if (_isAudioPlaying) {
        await _playerChannel.invokeMethod('pause');
        setState(() => _isAudioPlaying = false);
      } else {
        await _playerChannel.invokeMethod('resume');
        setState(() => _isAudioPlaying = true);
      }
      return;
    }
    // Stop any current playback
    await _stopAudioPlayback();
    // Download audio to temp file via trusted HTTPS client
    try {
      setState(() { _playingMsgId = msgId; _isAudioPlaying = false; _audioPosition = 0; _audioDuration = 0; });
      final api = context.read<ApiService>();
      final url = api.p2pMediaUrl(msgId);
      final tempDir = await Directory.systemTemp.createTemp('voice_');
      final tempFile = File('${tempDir.path}/audio.m4a');
      // Use the trusted IOClient via api_service
      final request = http.Request('GET', Uri.parse(url));
      final ioClient = api.trustedClient;
      final resp = await ioClient.send(request).timeout(const Duration(seconds: 30));
      if (resp.statusCode == 200) {
        final sink = tempFile.openWrite();
        await for (final chunk in resp.stream) {
          sink.add(chunk);
        }
        await sink.close();
        // Play via native player
        final duration = await _playerChannel.invokeMethod('play', {'path': tempFile.path});
        if (mounted) {
          setState(() { _isAudioPlaying = true; _audioDuration = duration as int? ?? 0; });
        }
      } else {
        setState(() { _playingMsgId = null; });
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Failed to load audio'), backgroundColor: Color(0xFFF87171)));
      }
    } catch (e) {
      debugPrint('Audio playback error: $e');
      setState(() { _playingMsgId = null; _isAudioPlaying = false; });
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Playback error: $e'), backgroundColor: const Color(0xFFF87171)));
    }
  }

  Future<void> _stopAudioPlayback() async {
    try { await _playerChannel.invokeMethod('stop'); } catch (_) {}
    if (mounted) setState(() { _playingMsgId = null; _isAudioPlaying = false; _audioPosition = 0; _audioDuration = 0; });
  }

  // ── Voice Recording ────────────────────────────────────────
  Future<void> _toggleVoiceRecording() async {
    if (_isRecording) { await _stopAndSendVoice(); } else { await _startVoiceRecording(); }
  }

  Future<void> _startVoiceRecording() async {
    try {
      final result = await _recorderChannel.invokeMethod('startRecording');
      if (result != null) {
        setState(() { _isRecording = true; _recordingSeconds = 0; });
        _recordingTimer = Timer.periodic(const Duration(seconds: 1), (_) {
          if (mounted) setState(() => _recordingSeconds++);
        });
      }
    } on PlatformException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Mic error: ${e.message}'), backgroundColor: const Color(0xFFF87171)));
      }
    }
  }

  Future<void> _stopAndSendVoice() async {
    _recordingTimer?.cancel();
    final duration = _recordingSeconds;
    try {
      final path = await _recorderChannel.invokeMethod('stopRecording') as String?;
      setState(() { _isRecording = false; _recordingSeconds = 0; });
      if (path != null && _activeConvoId != null) {
        final file = File(path);
        if (await file.exists()) {
          final bytes = await file.readAsBytes();
          final base64Data = base64Encode(bytes);
          final mins = duration ~/ 60;
          final secs = duration % 60;
          final api = context.read<ApiService>();
          await api.p2pSendMessage(
            senderId: _deviceId, recipientId: _activeConvoId!, senderName: _deviceName,
            text: '🎙️ Voice message ($mins:${secs.toString().padLeft(2, '0')})',
            mediaData: base64Data, mediaType: 'audio/m4a', fileName: 'voice_message.m4a',
          );
          _loadConvoMessages();
          file.delete().catchError((_) => file);
        }
      }
    } on PlatformException catch (e) {
      setState(() { _isRecording = false; _recordingSeconds = 0; });
      debugPrint('Stop recording error: ${e.message}');
    }
  }

  Future<void> _cancelVoiceRecording() async {
    _recordingTimer?.cancel();
    try { await _recorderChannel.invokeMethod('cancelRecording'); } catch (_) {}
    setState(() { _isRecording = false; _recordingSeconds = 0; });
  }

  // ── Typing indicator ───────────────────────────────────────
  void _onTextChanged(String text) {
    if (_activeConvoId == null) return;
    final now = DateTime.now();
    if (_lastTypingSent == null || now.difference(_lastTypingSent!) > const Duration(seconds: 2)) {
      _lastTypingSent = now;
      context.read<ApiService>().p2pSendTyping(_deviceId, _activeConvoId!);
    }
  }

  // ── Reply ──────────────────────────────────────────────────
  void _setReplyTo(Map<String, dynamic> msg) {
    setState(() { _replyToMessage = msg; _editingMsgId = null; });
    // Focus the text field so keyboard opens
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _msgFocusNode.requestFocus();
    });
  }

  void _cancelReply() {
    setState(() { _replyToMessage = null; _editingMsgId = null; });
  }

  String _getReplyPreviewText(Map<String, dynamic> msg) {
    final text = msg['text'] as String? ?? '';
    final hasMedia = msg['has_media'] == true;
    final mediaType = msg['media_type'] as String? ?? '';
    if (text.isNotEmpty && !(hasMedia && mediaType.startsWith('audio/'))) {
      return text.length > 80 ? '${text.substring(0, 80)}...' : text;
    }
    if (hasMedia) {
      if (mediaType.startsWith('image/')) return '📷 Photo';
      if (mediaType.startsWith('audio/')) return '🎵 Voice message';
      if (mediaType.startsWith('video/')) return '🎥 Video';
      return '📎 ${msg['file_name'] ?? 'File'}';
    }
    return '...';
  }

  // ── Message context menu (long press / 3-dot) ─────────────
  void _showMessageMenu(Map<String, dynamic> msg, Offset globalPosition) {
    final isMine = (msg['sender_id'] as String?) == _deviceId;
    final RenderBox overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
    showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(
        globalPosition & const Size(1, 1),
        Offset.zero & overlay.size,
      ),
      color: const Color(0xFF1E293B),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      items: [
        PopupMenuItem(value: 'reply', child: Row(children: const [Icon(Icons.reply, color: Color(0xFF667EEA), size: 20), SizedBox(width: 10), Text('Reply', style: TextStyle(color: Colors.white, fontSize: 14))])),
        if (isMine && (msg['text'] as String? ?? '').isNotEmpty)
          PopupMenuItem(value: 'edit', child: Row(children: const [Icon(Icons.edit, color: Color(0xFF4ADE80), size: 20), SizedBox(width: 10), Text('Edit', style: TextStyle(color: Colors.white, fontSize: 14))])),
        PopupMenuItem(value: 'forward', child: Row(children: const [Icon(Icons.forward, color: Color(0xFF94A3B8), size: 20), SizedBox(width: 10), Text('Forward', style: TextStyle(color: Colors.white, fontSize: 14))])),
        if (isMine)
          PopupMenuItem(value: 'delete', child: Row(children: const [Icon(Icons.delete_outline, color: Color(0xFFF87171), size: 20), SizedBox(width: 10), Text('Delete', style: TextStyle(color: Color(0xFFF87171), fontSize: 14))])),
      ],
    ).then((value) {
      if (value == null) return;
      switch (value) {
        case 'reply':
          _setReplyTo(msg);
          break;
        case 'edit':
          setState(() {
            _editingMsgId = msg['id'] as String?;
            _msgCtrl.text = msg['text'] as String? ?? '';
            _replyToMessage = null;
          });
          break;
        case 'forward':
          _forwardMessage(msg);
          break;
        case 'delete':
          _deleteMessage(msg);
          break;
      }
    });
  }

  Future<void> _forwardMessage(Map<String, dynamic> msg) async {
    final otherDevices = _devices.where((d) => d.id != _deviceId).toList();
    if (otherDevices.isEmpty && _friends.isEmpty) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('No contacts to forward to'), backgroundColor: Color(0xFF94A3B8)));
      return;
    }
    final selected = await showModalBottomSheet<String>(
      context: context, backgroundColor: const Color(0xFF1E293B),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Forward to', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Colors.white)),
          const SizedBox(height: 12),
          ..._friends.map((f) {
            final name = f['name'] as String? ?? 'Unknown';
            final deviceId = f['device_id'] as String?;
            return ListTile(
              leading: CircleAvatar(backgroundColor: const Color(0xFF7C3AED).withOpacity(0.2), child: Text(name[0].toUpperCase(), style: const TextStyle(color: Color(0xFF7C3AED), fontWeight: FontWeight.w700))),
              title: Text(name, style: const TextStyle(color: Colors.white)),
              onTap: deviceId != null ? () => Navigator.pop(ctx, deviceId) : null,
              enabled: deviceId != null,
            );
          }),
          ...otherDevices.where((d) => !_friends.any((f) => f['device_id'] == d.id)).map((d) => ListTile(
            leading: CircleAvatar(backgroundColor: const Color(0xFF667EEA).withOpacity(0.2), child: Icon(Icons.computer, color: const Color(0xFF667EEA), size: 18)),
            title: Text(d.name, style: const TextStyle(color: Colors.white)),
            onTap: () => Navigator.pop(ctx, d.id),
          )),
        ]),
      ),
    );
    if (selected == null) return;
    final api = context.read<ApiService>();
    final text = msg['text'] as String? ?? '';
    await api.p2pSendMessage(senderId: _deviceId, recipientId: selected, senderName: _deviceName, text: text.isEmpty ? '📎 Forwarded' : text);
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Message forwarded ✓'), backgroundColor: Color(0xFF4ADE80)));
  }

  Future<void> _deleteMessage(Map<String, dynamic> msg) async {
    final msgId = msg['id'] as String? ?? '';
    if (msgId.isEmpty) return;
    final api = context.read<ApiService>();
    try {
      await api.trustedClient.delete(Uri.parse('${api.baseUrl}/api/p2p/messages/$msgId'));
      _loadConvoMessages();
    } catch (_) {}
  }

  void _showNewChatDialog() {
    final api = context.read<ApiService>();
    final otherDevices = _devices.where((d) => d.id != _deviceId).toList();
    showModalBottomSheet(
      context: context, backgroundColor: const Color(0xFF1E293B),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      isScrollControlled: true,
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.55, maxChildSize: 0.85, minChildSize: 0.3, expand: false,
        builder: (ctx, scrollCtrl) => Padding(
          padding: const EdgeInsets.all(20),
          child: ListView(
            controller: scrollCtrl,
            children: [
              Row(
                children: [
                  const Expanded(child: Text('Start Chat', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: Colors.white))),
                  if (api.isLoggedIn)
                    IconButton(
                      onPressed: () { Navigator.pop(ctx); _showAddFriendDialog(); },
                      icon: const Icon(Icons.person_add, color: Color(0xFF667EEA)),
                      tooltip: 'Add friend',
                    ),
                ],
              ),
              const SizedBox(height: 8),
              // Friends section
              if (api.isLoggedIn && _friends.isNotEmpty) ...[
                Padding(
                  padding: const EdgeInsets.only(bottom: 8, top: 4),
                  child: Text('FRIENDS', style: TextStyle(color: const Color(0xFF667EEA).withOpacity(0.7), fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 1)),
                ),
                ..._friends.map((f) {
                  final friendName = f['name'] as String? ?? 'Unknown';
                  final friendDeviceId = f['device_id'] as String?;
                  final isOnline = f['online'] == true;
                  return ListTile(
                    leading: CircleAvatar(
                      backgroundColor: const Color(0xFF7C3AED).withOpacity(0.2),
                      child: Text(friendName.isNotEmpty ? friendName[0].toUpperCase() : '?', style: const TextStyle(color: Color(0xFF7C3AED), fontWeight: FontWeight.w700)),
                    ),
                    title: Text(friendName, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
                    subtitle: Text(isOnline ? 'Online' : (friendDeviceId != null ? 'Offline' : 'Not connected'), style: TextStyle(color: isOnline ? const Color(0xFF4ADE80) : const Color(0xFF94A3B8), fontSize: 12)),
                    trailing: friendDeviceId != null
                        ? const Icon(Icons.chat_bubble_outline, color: Color(0xFF7C3AED))
                        : Icon(Icons.cloud_off, color: Colors.white.withOpacity(0.2), size: 18),
                    onTap: friendDeviceId != null ? () { Navigator.pop(ctx); _openConversation(friendDeviceId, friendName); } : null,
                  );
                }),
                if (otherDevices.isNotEmpty)
                  Padding(padding: const EdgeInsets.only(top: 12, bottom: 8), child: Divider(color: Colors.white.withOpacity(0.08))),
              ],
              // Nearby devices section
              if (otherDevices.isNotEmpty) ...[
                Padding(
                  padding: const EdgeInsets.only(bottom: 8, top: 4),
                  child: Text('NEARBY DEVICES', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 1)),
                ),
                ...otherDevices.map((d) => ListTile(
                  leading: CircleAvatar(
                    backgroundColor: const Color(0xFF667EEA).withOpacity(0.2),
                    child: Icon(d.userAgent.toLowerCase().contains('mobile') ? Icons.phone_android : Icons.computer, color: const Color(0xFF667EEA)),
                  ),
                  title: Text(d.name, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
                  subtitle: Text(d.isOnline ? 'Online' : 'Offline', style: TextStyle(color: d.isOnline ? const Color(0xFF4ADE80) : const Color(0xFF94A3B8))),
                  trailing: const Icon(Icons.chat_bubble_outline, color: Color(0xFF667EEA)),
                  onTap: () { Navigator.pop(ctx); _openConversation(d.id, d.name); },
                )),
              ],
              if (otherDevices.isEmpty && _friends.isEmpty) ...[
                const SizedBox(height: 32),
                Center(child: Column(children: [
                  Icon(Icons.people_outline, size: 48, color: Colors.white.withOpacity(0.15)),
                  const SizedBox(height: 12),
                  Text('No contacts yet', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 14)),
                  if (!api.isLoggedIn) ...[
                    const SizedBox(height: 8),
                    Text('Login to add friends', style: TextStyle(color: Colors.white.withOpacity(0.25), fontSize: 12)),
                  ],
                ])),
              ],
              if (!api.isLoggedIn) ...[
                const SizedBox(height: 16),
                Center(
                  child: TextButton.icon(
                    onPressed: () { Navigator.pop(ctx); _showAuthScreen(); },
                    icon: const Icon(Icons.login, size: 16, color: Color(0xFF667EEA)),
                    label: const Text('Login to add friends', style: TextStyle(color: Color(0xFF667EEA), fontSize: 13)),
                  ),
                ),
              ],
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
  }

  void _showAddFriendDialog() {
    final ctrl = TextEditingController();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF1E293B),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('Add Friend', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Enter email or phone number', style: TextStyle(color: Colors.white.withOpacity(0.5), fontSize: 13)),
            const SizedBox(height: 16),
            TextField(
              controller: ctrl,
              style: const TextStyle(color: Colors.white),
              decoration: InputDecoration(
                hintText: 'Email or phone...',
                hintStyle: TextStyle(color: Colors.white.withOpacity(0.3)),
                prefixIcon: const Icon(Icons.person_add, color: Color(0xFF667EEA), size: 20),
                filled: true, fillColor: const Color(0xFF0F172A),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
                focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: Color(0xFF667EEA), width: 1.5)),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: Text('Cancel', style: TextStyle(color: Colors.white.withOpacity(0.5)))),
          Container(
            decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]), borderRadius: BorderRadius.circular(10)),
            child: TextButton(
              onPressed: () async {
                final id = ctrl.text.trim();
                if (id.isEmpty) return;
                Navigator.pop(ctx);
                final api = context.read<ApiService>();
                final result = await api.authAddFriend(id);
                if (mounted) {
                  if (result['error'] != null) {
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(result['error']), backgroundColor: const Color(0xFFF87171)));
                  } else {
                    final msg = result['message'] ?? 'Friend request sent!';
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$msg ✓'), backgroundColor: const Color(0xFF4ADE80)));
                    _loadFriends();
                  }
                }
              },
              child: const Text('Add', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
            ),
          ),
        ],
      ),
    );
  }

  void _showAuthScreen() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => const _AuthScreenWrapper(),
    )).then((_) {
      // Reload friends after auth
      final api = context.read<ApiService>();
      if (api.isLoggedIn && _deviceId.isNotEmpty) {
        api.authLinkDevice(_deviceId);
        _loadFriends();
      }
    });
  }

  String _formatTime(double ts) {
    final dt = DateTime.fromMillisecondsSinceEpoch((ts * 1000).toInt());
    final now = DateTime.now();
    if (now.difference(dt).inDays > 0) {
      return '${dt.day}/${dt.month} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    }
    return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }

  String _formatLastSeen(double ts) {
    final dt = DateTime.fromMillisecondsSinceEpoch((ts * 1000).toInt());
    final diff = DateTime.now().difference(dt);
    if (diff.inMinutes < 1) return 'Just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
  }

  // ── Group consecutive images from same sender ──────────────
  List<_ChatEntry> _groupMessages(List<Map<String, dynamic>> messages) {
    final result = <_ChatEntry>[];
    int i = 0;
    while (i < messages.length) {
      final msg = messages[i];
      final mediaType = msg['media_type'] as String? ?? '';
      if (msg['has_media'] == true && mediaType.startsWith('image/')) {
        final senderId = msg['sender_id'] as String? ?? '';
        final group = <Map<String, dynamic>>[msg];
        int j = i + 1;
        while (j < messages.length) {
          final next = messages[j];
          final nextType = next['media_type'] as String? ?? '';
          if (next['has_media'] == true && nextType.startsWith('image/') && (next['sender_id'] as String? ?? '') == senderId) {
            group.add(next); j++;
          } else { break; }
        }
        if (group.length > 1) {
          result.add(_ChatEntry(type: _EntryType.imageGroup, messages: group));
        } else {
          result.add(_ChatEntry(type: _EntryType.single, messages: [msg]));
        }
        i = j;
      } else {
        result.add(_ChatEntry(type: _EntryType.single, messages: [msg]));
        i++;
      }
    }
    return result;
  }

  // ══════════════════════════════════════════════════════════
  //  B U I L D
  // ══════════════════════════════════════════════════════════
  @override
  Widget build(BuildContext context) {
    super.build(context);
    final api = context.watch<ApiService>();
    // Auto-connect to server in background (Chat works with server, not PC pairing)
    if (!api.isConnected) {
      api.ensureConnected();
    }
    return Scaffold(
      key: _scaffoldKey,
      backgroundColor: const Color(0xFF0F172A),
      drawer: _buildFriendsDrawer(),
      body: SafeArea(child: _activeConvoId != null ? _buildChatWindow() : _buildConversationList(_scaffoldKey)),
    );
  }

  // ── Friends panel sidebar/drawer ───────────────────────────
  Widget _buildFriendsDrawer() {
    final api = context.watch<ApiService>();
    return Drawer(
      backgroundColor: const Color(0xFF0F172A),
      width: MediaQuery.of(context).size.width * 0.82,
      child: SafeArea(
        child: Column(children: [
          // Drawer header
          Container(
            padding: const EdgeInsets.fromLTRB(20, 20, 16, 16),
            decoration: const BoxDecoration(
              color: Color(0xFF1E293B),
              border: Border(bottom: BorderSide(color: Color(0xFF334155), width: 0.5)),
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(Icons.people, color: Colors.white, size: 20),
                ),
                const SizedBox(width: 12),
                const Expanded(child: Text('Friends', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: Colors.white))),
                if (api.isLoggedIn)
                  IconButton(
                    onPressed: () { Navigator.pop(context); _showAddFriendDialog(); },
                    icon: const Icon(Icons.person_add_alt_1, color: Color(0xFF7C3AED), size: 22),
                    tooltip: 'Add friend',
                  ),
              ]),
              if (api.isLoggedIn && api.currentUser != null) ...[
                const SizedBox(height: 12),
                Row(children: [
                  CircleAvatar(
                    radius: 16, backgroundColor: const Color(0xFF7C3AED).withOpacity(0.2),
                    child: Text((api.currentUser!['name'] as String? ?? '?')[0].toUpperCase(), style: const TextStyle(color: Color(0xFF7C3AED), fontSize: 13, fontWeight: FontWeight.w700)),
                  ),
                  const SizedBox(width: 10),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(api.currentUser!['name'] as String? ?? '', style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600)),
                    Text(api.currentUser!['email'] as String? ?? '', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 11)),
                  ])),
                ]),
              ],
            ]),
          ),
          // Friend requests in drawer
          if (api.isLoggedIn && _incomingRequests.isNotEmpty)
            Container(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              color: const Color(0xFF22C55E).withOpacity(0.06),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  const Icon(Icons.person_add, color: Color(0xFF22C55E), size: 15),
                  const SizedBox(width: 6),
                  Text('Requests (${_incomingRequests.length})', style: const TextStyle(color: Color(0xFF22C55E), fontSize: 12, fontWeight: FontWeight.w700)),
                ]),
                const SizedBox(height: 6),
                ..._incomingRequests.map((r) {
                  final reqId = r['id']?.toString() ?? '';
                  final fromName = r['from_name'] as String? ?? 'Unknown';
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(children: [
                      CircleAvatar(radius: 14, backgroundColor: const Color(0xFF667EEA).withOpacity(0.2),
                        child: Text(fromName[0].toUpperCase(), style: const TextStyle(color: Color(0xFF667EEA), fontSize: 11, fontWeight: FontWeight.w700))),
                      const SizedBox(width: 8),
                      Expanded(child: Text(fromName, style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600))),
                      if (_processingRequests.contains(reqId))
                        const SizedBox(width: 40, height: 28, child: Center(child: SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF22C55E)))))
                      else ...[
                        SizedBox(height: 28, child: ElevatedButton(
                          style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF22C55E), foregroundColor: Colors.white, padding: const EdgeInsets.symmetric(horizontal: 10), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)), textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700), elevation: 0, minimumSize: const Size(0, 28)),
                          onPressed: () => _acceptFriendRequest(reqId, fromName),
                          child: const Text('Accept'),
                        )),
                        const SizedBox(width: 4),
                        SizedBox(height: 28, child: TextButton(
                          style: TextButton.styleFrom(backgroundColor: const Color(0xFFEF4444).withOpacity(0.12), foregroundColor: const Color(0xFFEF4444), padding: const EdgeInsets.symmetric(horizontal: 8), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)), textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700), minimumSize: const Size(0, 28)),
                          onPressed: () => _rejectFriendRequest(reqId, fromName),
                          child: const Text('Reject'),
                        )),
                      ],
                    ]),
                  );
                }),
              ]),
            ),
          // Friends list
          Expanded(
            child: _friends.isEmpty
                ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Icon(Icons.people_outline, size: 48, color: Colors.white.withOpacity(0.12)),
                    const SizedBox(height: 12),
                    Text('No friends yet', style: TextStyle(color: Colors.white.withOpacity(0.35), fontSize: 14)),
                    if (api.isLoggedIn) ...[
                      const SizedBox(height: 8),
                      GestureDetector(
                        onTap: () { Navigator.pop(context); _showAddFriendDialog(); },
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                          decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]), borderRadius: BorderRadius.circular(16)),
                          child: const Text('Add Friend', style: TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600)),
                        ),
                      ),
                    ] else ...[
                      const SizedBox(height: 8),
                      GestureDetector(
                        onTap: () { Navigator.pop(context); _showAuthScreen(); },
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                          decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]), borderRadius: BorderRadius.circular(16)),
                          child: const Text('Login to add friends', style: TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600)),
                        ),
                      ),
                    ],
                  ]))
                : ListView.builder(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    itemCount: _friends.length,
                    itemBuilder: (ctx, i) {
                      final f = _friends[i];
                      final name = f['name'] as String? ?? 'Unknown';
                      final email = f['email'] as String? ?? '';
                      final devId = f['device_id'] as String? ?? '';
                      final isOnline = f['online'] == true;
                      return InkWell(
                        onTap: devId.isNotEmpty ? () { Navigator.pop(context); _openConversation(devId, name); } : null,
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                          child: Row(children: [
                            Stack(children: [
                              CircleAvatar(
                                radius: 20,
                                backgroundColor: const Color(0xFF7C3AED).withOpacity(0.15),
                                child: Text(name.isNotEmpty ? name[0].toUpperCase() : '?', style: const TextStyle(color: Color(0xFF7C3AED), fontWeight: FontWeight.w700, fontSize: 16)),
                              ),
                              if (isOnline) Positioned(right: 0, bottom: 0, child: Container(
                                width: 12, height: 12,
                                decoration: BoxDecoration(color: const Color(0xFF22C55E), shape: BoxShape.circle, border: Border.all(color: const Color(0xFF0F172A), width: 2)),
                              )),
                            ]),
                            const SizedBox(width: 12),
                            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(name, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 14)),
                              if (email.isNotEmpty)
                                Text(email, style: TextStyle(color: Colors.white.withOpacity(0.35), fontSize: 11)),
                            ])),
                            if (isOnline)
                              Text('Online', style: const TextStyle(color: Color(0xFF22C55E), fontSize: 11, fontWeight: FontWeight.w600))
                            else
                              Text('Offline', style: TextStyle(color: Colors.white.withOpacity(0.25), fontSize: 11)),
                            if (devId.isNotEmpty) ...[
                              const SizedBox(width: 8),
                              Icon(Icons.chat_bubble_outline, color: const Color(0xFF667EEA).withOpacity(0.5), size: 16),
                            ],
                          ]),
                        ),
                      );
                    },
                  ),
          ),
          // Outgoing requests at bottom
          if (api.isLoggedIn && _outgoingRequests.isNotEmpty)
            Container(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              decoration: const BoxDecoration(border: Border(top: BorderSide(color: Color(0xFF334155), width: 0.5))),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Pending Sent (${_outgoingRequests.length})', style: TextStyle(color: const Color(0xFF667EEA).withOpacity(0.6), fontSize: 10, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
                ..._outgoingRequests.map((r) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(children: [
                    Icon(Icons.hourglass_top, color: Colors.white.withOpacity(0.25), size: 13),
                    const SizedBox(width: 6),
                    Expanded(child: Text(r['to_name'] as String? ?? 'Unknown', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 11))),
                  ]),
                )),
              ]),
            ),
        ]),
      ),
    );
  }

  Widget _buildConversationList(GlobalKey<ScaffoldState> scaffoldKey) {
    final conversations = _buildConversations();
    final api = context.watch<ApiService>();
    final hasRequests = api.isLoggedIn && _incomingRequests.isNotEmpty;
    return Column(children: [
      // ── Top header bar ─────────────────────────────────────
      Container(
        padding: const EdgeInsets.fromLTRB(6, 8, 8, 0),
        decoration: const BoxDecoration(color: Color(0xFF1E293B), border: Border(bottom: BorderSide(color: Color(0xFF334155), width: 0.5))),
        child: Column(children: [
          // Title row with actions
          Row(children: [
            // Menu button to open friends drawer
            IconButton(
              onPressed: () => scaffoldKey.currentState?.openDrawer(),
              icon: Stack(children: [
                const Icon(Icons.people_alt_outlined, color: Color(0xFF667EEA), size: 24),
                if (hasRequests)
                  Positioned(right: -2, top: -2, child: Container(
                    width: 10, height: 10,
                    decoration: BoxDecoration(color: const Color(0xFF22C55E), shape: BoxShape.circle, border: Border.all(color: const Color(0xFF1E293B), width: 1.5)),
                  )),
              ]),
              tooltip: 'Friends',
            ),
            const Expanded(child: Text('LocalBeam', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: Colors.white))),
            if (api.isLoggedIn)
              IconButton(onPressed: _showAddFriendDialog, icon: const Icon(Icons.person_add_alt_1, color: Color(0xFF7C3AED), size: 22), tooltip: 'Add friend')
            else
              IconButton(onPressed: _showAuthScreen, icon: const Icon(Icons.login, color: Color(0xFF667EEA), size: 22), tooltip: 'Login'),
            IconButton(onPressed: () { _pollConversations(); _loadFriends(); }, icon: const Icon(Icons.refresh, color: Color(0xFF94A3B8), size: 22), tooltip: 'Refresh'),
            IconButton(onPressed: _showNewChatDialog, icon: const Icon(Icons.edit_square, color: Color(0xFF667EEA), size: 22), tooltip: 'New chat'),
          ]),
          // Messages / Friends tab switcher
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
            child: Container(
              height: 36,
              decoration: BoxDecoration(
                color: const Color(0xFF0F172A).withOpacity(0.6),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(children: [
                Expanded(child: GestureDetector(
                  onTap: () => setState(() => _chatTab = 0),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 200),
                    decoration: BoxDecoration(
                      gradient: _chatTab == 0 ? const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]) : null,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    alignment: Alignment.center,
                    child: Text('Messages', style: TextStyle(color: _chatTab == 0 ? Colors.white : Colors.white.withOpacity(0.4), fontSize: 13, fontWeight: FontWeight.w700)),
                  ),
                )),
                Expanded(child: GestureDetector(
                  onTap: () => setState(() => _chatTab = 1),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 200),
                    decoration: BoxDecoration(
                      gradient: _chatTab == 1 ? const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]) : null,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    alignment: Alignment.center,
                    child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                      Text('Friends', style: TextStyle(color: _chatTab == 1 ? Colors.white : Colors.white.withOpacity(0.4), fontSize: 13, fontWeight: FontWeight.w700)),
                      if (_friends.isNotEmpty) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                          decoration: BoxDecoration(
                            color: _chatTab == 1 ? Colors.white.withOpacity(0.2) : const Color(0xFF667EEA).withOpacity(0.2),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text('${_friends.length}', style: TextStyle(color: _chatTab == 1 ? Colors.white : const Color(0xFF667EEA), fontSize: 11, fontWeight: FontWeight.w700)),
                        ),
                      ],
                      if (hasRequests) ...[
                        const SizedBox(width: 4),
                        Container(
                          width: 8, height: 8,
                          decoration: const BoxDecoration(color: Color(0xFF22C55E), shape: BoxShape.circle),
                        ),
                      ],
                    ]),
                  ),
                )),
              ]),
            ),
          ),
        ]),
      ),
      // ── Incoming friend request alert (always visible on both tabs) ──
      if (hasRequests)
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          color: const Color(0xFF22C55E).withOpacity(0.08),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              const Icon(Icons.person_add, color: Color(0xFF22C55E), size: 15),
              const SizedBox(width: 6),
              Text('Friend Requests (${_incomingRequests.length})', style: const TextStyle(color: Color(0xFF22C55E), fontSize: 12, fontWeight: FontWeight.w700)),
            ]),
            const SizedBox(height: 6),
            ..._incomingRequests.map((r) {
              final reqId = r['id']?.toString() ?? '';
              final fromName = r['from_name'] as String? ?? 'Unknown';
              final fromEmail = r['from_email'] as String? ?? '';
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(children: [
                  CircleAvatar(radius: 15, backgroundColor: const Color(0xFF667EEA).withOpacity(0.2),
                    child: Text(fromName[0].toUpperCase(), style: const TextStyle(color: Color(0xFF667EEA), fontSize: 11, fontWeight: FontWeight.w700))),
                  const SizedBox(width: 8),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(fromName, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600)),
                    if (fromEmail.isNotEmpty)
                      Text(fromEmail, style: TextStyle(color: Colors.white.withOpacity(0.35), fontSize: 10)),
                  ])),
                  const SizedBox(width: 4),
                  if (_processingRequests.contains(reqId))
                    const SizedBox(width: 50, height: 30, child: Center(child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF22C55E)))))
                  else ...[
                    SizedBox(height: 30, child: ElevatedButton(
                      style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF22C55E), foregroundColor: Colors.white, padding: const EdgeInsets.symmetric(horizontal: 12), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)), textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700), elevation: 0, minimumSize: const Size(0, 30)),
                      onPressed: () => _acceptFriendRequest(reqId, fromName),
                      child: const Text('Accept'),
                    )),
                    const SizedBox(width: 6),
                    SizedBox(height: 30, child: TextButton(
                      style: TextButton.styleFrom(backgroundColor: const Color(0xFFEF4444).withOpacity(0.12), foregroundColor: const Color(0xFFEF4444), padding: const EdgeInsets.symmetric(horizontal: 10), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)), textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700), minimumSize: const Size(0, 30)),
                      onPressed: () => _rejectFriendRequest(reqId, fromName),
                      child: const Text('Reject'),
                    )),
                  ],
                ]),
              );
            }),
          ]),
        ),
      // ── Tab content ────────────────────────────────────────
      Expanded(child: _chatTab == 0 ? _buildMessagesTab(conversations, api) : _buildFriendsTab(conversations, api)),
    ]);
  }

  // ── Messages tab content ───────────────────────────────────
  Widget _buildMessagesTab(List<_Conversation> conversations, ApiService api) {
    // Merge friend contacts that don't have existing conversations
    final friendContacts = _friends.where((f) {
      final devId = f['device_id'] as String? ?? '';
      return devId.isNotEmpty && !conversations.any((c) => c.deviceId == devId);
    }).toList();

    final totalItems = conversations.length + friendContacts.length;

    if (totalItems == 0) {
      return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.chat_bubble_outline, size: 64, color: Colors.white.withOpacity(0.12)),
        const SizedBox(height: 16),
        Text('No conversations yet', style: TextStyle(color: Colors.white.withOpacity(0.35), fontSize: 16)),
        const SizedBox(height: 8),
        Text(api.isLoggedIn ? 'Add friends or tap + to start a chat' : 'Tap + to start a new chat', style: TextStyle(color: Colors.white.withOpacity(0.2), fontSize: 13)),
        if (!api.isLoggedIn) ...[
          const SizedBox(height: 16),
          GestureDetector(
            onTap: _showAuthScreen,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
              decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]), borderRadius: BorderRadius.circular(20)),
              child: const Text('Login to add friends', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 13)),
            ),
          ),
        ],
      ]));
    }

    return ListView.builder(
      itemCount: totalItems,
      itemBuilder: (ctx, i) {
        // Show conversations first, then friend contacts
        if (i < conversations.length) {
          final convo = conversations[i];
          final isFriend = _friends.any((f) => f['device_id'] == convo.deviceId);
          return _ConversationTile(convo: convo, myDeviceId: _deviceId, onTap: () => _openConversation(convo.deviceId, convo.deviceName), formatTime: _formatLastSeen, isFriend: isFriend);
        }
        // Friend contacts without conversations
        final f = friendContacts[i - conversations.length];
        final name = f['name'] as String? ?? 'Unknown';
        final devId = f['device_id'] as String? ?? '';
        final isOnline = f['online'] == true;
        return InkWell(
          onTap: devId.isNotEmpty ? () => _openConversation(devId, name) : null,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Color(0xFF1E293B), width: 1))),
            child: Row(children: [
              Stack(children: [
                CircleAvatar(radius: 24, backgroundColor: const Color(0xFF7C3AED).withOpacity(0.15),
                  child: Text(name.isNotEmpty ? name[0].toUpperCase() : '?', style: const TextStyle(color: Color(0xFF7C3AED), fontWeight: FontWeight.w700, fontSize: 18))),
                Positioned(right: 0, bottom: 0, child: Container(
                  width: 16, height: 16,
                  decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]), shape: BoxShape.circle, border: Border.all(color: const Color(0xFF0F172A), width: 2)),
                  child: const Icon(Icons.person, color: Colors.white, size: 9),
                )),
              ]),
              const SizedBox(width: 14),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(name, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 15)),
                const SizedBox(height: 4),
                Text(isOnline ? 'Online — Tap to chat' : 'Tap to start a chat', style: TextStyle(color: isOnline ? const Color(0xFF4ADE80) : const Color(0xFF94A3B8), fontSize: 13)),
              ])),
              if (isOnline) Container(width: 10, height: 10, decoration: const BoxDecoration(color: Color(0xFF4ADE80), shape: BoxShape.circle)),
            ]),
          ),
        );
      },
    );
  }

  // ── Friends tab content ────────────────────────────────────
  Widget _buildFriendsTab(List<_Conversation> conversations, ApiService api) {
    if (!api.isLoggedIn) {
      return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.people_outline, size: 64, color: Colors.white.withOpacity(0.12)),
        const SizedBox(height: 16),
        Text('Login to see friends', style: TextStyle(color: Colors.white.withOpacity(0.35), fontSize: 16)),
        const SizedBox(height: 16),
        GestureDetector(
          onTap: _showAuthScreen,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
            decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]), borderRadius: BorderRadius.circular(20)),
            child: const Text('Login', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 14)),
          ),
        ),
      ]));
    }

    if (_friends.isEmpty && _outgoingRequests.isEmpty) {
      return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.people_outline, size: 64, color: Colors.white.withOpacity(0.12)),
        const SizedBox(height: 16),
        Text('No friends yet', style: TextStyle(color: Colors.white.withOpacity(0.35), fontSize: 16)),
        const SizedBox(height: 8),
        Text('Add friends by email or phone', style: TextStyle(color: Colors.white.withOpacity(0.2), fontSize: 13)),
        const SizedBox(height: 16),
        GestureDetector(
          onTap: _showAddFriendDialog,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
            decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]), borderRadius: BorderRadius.circular(20)),
            child: const Text('Add Friend', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 13)),
          ),
        ),
      ]));
    }

    return ListView(padding: const EdgeInsets.symmetric(vertical: 4), children: [
      // Friend list
      ..._friends.map((f) {
        final name = f['name'] as String? ?? 'Unknown';
        final email = f['email'] as String? ?? '';
        final devId = f['device_id'] as String? ?? '';
        final isOnline = f['online'] == true;
        return InkWell(
          onTap: devId.isNotEmpty ? () => _openConversation(devId, name) : null,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Color(0xFF1E293B), width: 1))),
            child: Row(children: [
              Stack(children: [
                CircleAvatar(radius: 22, backgroundColor: const Color(0xFF7C3AED).withOpacity(0.15),
                  child: Text(name.isNotEmpty ? name[0].toUpperCase() : '?', style: const TextStyle(color: Color(0xFF7C3AED), fontWeight: FontWeight.w700, fontSize: 16))),
                if (isOnline) Positioned(right: 0, bottom: 0, child: Container(
                  width: 12, height: 12,
                  decoration: BoxDecoration(color: const Color(0xFF22C55E), shape: BoxShape.circle, border: Border.all(color: const Color(0xFF0F172A), width: 2)),
                )),
              ]),
              const SizedBox(width: 14),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(name, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 15)),
                if (email.isNotEmpty)
                  Text(email, style: TextStyle(color: Colors.white.withOpacity(0.35), fontSize: 11)),
              ])),
              Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                Text(isOnline ? 'Online' : 'Offline', style: TextStyle(color: isOnline ? const Color(0xFF22C55E) : Colors.white.withOpacity(0.25), fontSize: 11, fontWeight: FontWeight.w600)),
                if (devId.isNotEmpty)
                  Padding(padding: const EdgeInsets.only(top: 4), child: Icon(Icons.chat_bubble_outline, color: const Color(0xFF667EEA).withOpacity(0.5), size: 16)),
              ]),
            ]),
          ),
        );
      }),
      // Outgoing requests at the bottom
      if (_outgoingRequests.isNotEmpty) ...[
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 6),
          child: Text('PENDING SENT', style: TextStyle(color: const Color(0xFF667EEA).withOpacity(0.5), fontSize: 10, fontWeight: FontWeight.w700, letterSpacing: 1)),
        ),
        ..._outgoingRequests.map((r) {
          final reqId = r['id']?.toString() ?? '';
          return Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(children: [
              Icon(Icons.hourglass_top, color: Colors.white.withOpacity(0.25), size: 14),
              const SizedBox(width: 8),
              Expanded(child: Text(r['to_name'] as String? ?? 'Unknown', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 13))),
              TextButton(
                style: TextButton.styleFrom(foregroundColor: Colors.white.withOpacity(0.4), padding: const EdgeInsets.symmetric(horizontal: 8), minimumSize: const Size(40, 28), textStyle: const TextStyle(fontSize: 11)),
                onPressed: () async {
                  final api2 = context.read<ApiService>();
                  await api2.authRejectFriend(reqId);
                  if (mounted) _loadFriends();
                },
                child: const Text('Cancel'),
              ),
            ]),
          );
        }),
      ],
    ]);
  }

  Widget _buildChatWindow() {
    final otherDevice = _devices.where((d) => d.id == _activeConvoId).toList();
    final isOnline = otherDevice.isNotEmpty && otherDevice.first.isOnline;
    final api = context.read<ApiService>();
    final grouped = _groupMessages(_convoMessages);

    return Column(children: [
      // Header
      Container(
        padding: const EdgeInsets.fromLTRB(4, 8, 12, 8),
        decoration: const BoxDecoration(color: Color(0xFF1E293B), border: Border(bottom: BorderSide(color: Color(0xFF334155), width: 0.5))),
        child: Row(children: [
          IconButton(onPressed: _closeConversation, icon: const Icon(Icons.arrow_back, color: Colors.white)),
          CircleAvatar(
            radius: 18, backgroundColor: const Color(0xFF667EEA).withOpacity(0.2),
            child: Icon(
              otherDevice.isNotEmpty && otherDevice.first.userAgent.toLowerCase().contains('mobile') ? Icons.phone_android : Icons.computer,
              color: const Color(0xFF667EEA), size: 20,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(_activeConvoName ?? 'Chat', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 16)),
            if (_typers.isNotEmpty)
              const Text('typing...', style: TextStyle(color: Color(0xFF4ADE80), fontSize: 12, fontStyle: FontStyle.italic))
            else
              Text(isOnline ? 'Online' : 'Offline', style: TextStyle(color: isOnline ? const Color(0xFF4ADE80) : const Color(0xFF94A3B8), fontSize: 12)),
          ])),
        ]),
      ),
      // Messages
      Expanded(
        child: grouped.isEmpty
            ? Center(child: Text('No messages yet', style: TextStyle(color: Colors.white.withOpacity(0.3), fontSize: 14)))
            : ListView.builder(
                controller: _scrollCtrl,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                itemCount: grouped.length,
                itemBuilder: (ctx, i) {
                  final entry = grouped[i];
                  final isMine = (entry.messages.first['sender_id'] as String?) == _deviceId;
                  if (entry.type == _EntryType.imageGroup) {
                    return _SwipeToReply(
                      onReply: () => _setReplyTo(entry.messages.last),
                      child: GestureDetector(
                        onLongPressStart: (details) => _showMessageMenu(entry.messages.last, details.globalPosition),
                        child: _ImageGroupBubble(messages: entry.messages, isMine: isMine, formatTime: _formatTime, mediaUrlBuilder: (id) => api.p2pMediaUrl(id)),
                      ),
                    );
                  }
                  final msg = entry.messages.first;
                  return _SwipeToReply(
                    onReply: () => _setReplyTo(msg),
                    child: GestureDetector(
                      onLongPressStart: (details) => _showMessageMenu(msg, details.globalPosition),
                      child: _MessageBubble(
                        message: msg, isMine: isMine, formatTime: _formatTime,
                        mediaUrlBuilder: (id) => api.p2pMediaUrl(id),
                        playingMsgId: _playingMsgId, isAudioPlaying: _isAudioPlaying,
                        audioPosition: _audioPosition, audioDuration: _audioDuration,
                        onPlayAudio: _toggleAudioPlayback,
                        myDeviceId: _deviceId,
                      ),
                    ),
                  );
                },
              ),
      ),
      // Typing indicator
      if (_typers.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(left: 16, bottom: 4),
          child: Row(children: [
            _TypingDots(),
            const SizedBox(width: 8),
            Text('${_typers.first['name'] ?? 'Someone'} is typing...', style: const TextStyle(color: Color(0xFF94A3B8), fontSize: 12, fontStyle: FontStyle.italic)),
          ]),
        ),
      // Input / Recording bar (reply preview is now inside)
      Container(
        decoration: const BoxDecoration(color: Color(0xFF1E293B), border: Border(top: BorderSide(color: Color(0xFF334155), width: 0.5))),
        child: SafeArea(top: false, child: Column(mainAxisSize: MainAxisSize.min, children: [
          // WhatsApp-style reply preview bar
          if (_replyToMessage != null)
            Container(
              margin: const EdgeInsets.fromLTRB(8, 8, 8, 0),
              padding: const EdgeInsets.fromLTRB(0, 0, 4, 0),
              decoration: BoxDecoration(
                color: const Color(0xFF0F172A).withOpacity(0.8),
                borderRadius: const BorderRadius.only(topLeft: Radius.circular(12), topRight: Radius.circular(12)),
              ),
              child: Row(children: [
                // Colored left border
                Container(
                  width: 4,
                  height: 48,
                  decoration: BoxDecoration(
                    color: (_replyToMessage!['sender_id'] as String?) == _deviceId
                        ? const Color(0xFF667EEA)
                        : const Color(0xFF22C55E),
                    borderRadius: const BorderRadius.only(topLeft: Radius.circular(12)),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                    Text(
                      (_replyToMessage!['sender_id'] as String?) == _deviceId ? 'You' : (_replyToMessage!['sender_name'] as String? ?? 'Unknown'),
                      style: TextStyle(
                        color: (_replyToMessage!['sender_id'] as String?) == _deviceId
                            ? const Color(0xFF667EEA)
                            : const Color(0xFF22C55E),
                        fontSize: 13, fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(_getReplyPreviewText(_replyToMessage!), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: Colors.white.withOpacity(0.45), fontSize: 13)),
                  ]),
                )),
                GestureDetector(
                  onTap: _cancelReply,
                  child: Container(
                    width: 28, height: 28,
                    decoration: BoxDecoration(color: Colors.white.withOpacity(0.08), shape: BoxShape.circle),
                    child: const Icon(Icons.close, color: Color(0xFF94A3B8), size: 16),
                  ),
                ),
                const SizedBox(width: 4),
              ]),
            ),
          // Input row
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
            child: _isRecording ? _buildRecordingBar() : _buildInputBar(),
          ),
          // Emoji picker panel
          if (_showEmojiPicker)
            SizedBox(
              height: 280,
              child: EmojiPicker(
                onEmojiSelected: (category, emoji) {
                  final cursorPos = _msgCtrl.selection.baseOffset;
                  final text = _msgCtrl.text;
                  final newText = cursorPos >= 0
                      ? text.substring(0, cursorPos) + emoji.emoji + text.substring(cursorPos)
                      : text + emoji.emoji;
                  _msgCtrl.text = newText;
                  final newPos = (cursorPos >= 0 ? cursorPos : text.length) + emoji.emoji.length;
                  _msgCtrl.selection = TextSelection.collapsed(offset: newPos);
                },
                onBackspacePressed: () {
                  _msgCtrl..text = _msgCtrl.text.characters.skipLast(1).toString()
                    ..selection = TextSelection.fromPosition(TextPosition(offset: _msgCtrl.text.length));
                },
                config: Config(
                  height: 280,
                  checkPlatformCompatibility: true,
                  emojiViewConfig: EmojiViewConfig(
                    columns: 8,
                    emojiSizeMax: 28,
                    backgroundColor: const Color(0xFF0F172A),
                    noRecents: const Text('No Recents', style: TextStyle(fontSize: 16, color: Color(0xFF64748B))),
                  ),
                  categoryViewConfig: const CategoryViewConfig(
                    backgroundColor: Color(0xFF1E293B),
                    indicatorColor: Color(0xFF667EEA),
                    iconColorSelected: Color(0xFF667EEA),
                    iconColor: Color(0xFF64748B),
                  ),
                  bottomActionBarConfig: const BottomActionBarConfig(
                    backgroundColor: Color(0xFF1E293B),
                    buttonColor: Color(0xFF667EEA),
                    buttonIconColor: Colors.white,
                  ),
                  searchViewConfig: SearchViewConfig(
                    backgroundColor: const Color(0xFF0F172A),
                    buttonIconColor: const Color(0xFF667EEA),
                    hintText: 'Search emoji...',
                  ),
                ),
              ),
            ),
        ])),
      ),
    ]);
  }

  Widget _buildInputBar() {
    final hasText = _msgCtrl.text.trim().isNotEmpty;
    return Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
      IconButton(onPressed: _showAttachmentMenu, icon: const Icon(Icons.attach_file, color: Color(0xFF94A3B8)), tooltip: 'Attach'),
      Expanded(
        child: Container(
          constraints: const BoxConstraints(maxHeight: 120),
          decoration: BoxDecoration(color: const Color(0xFF0F172A), borderRadius: BorderRadius.circular(24)),
          child: Row(children: [
            Expanded(
              child: TextField(
                controller: _msgCtrl, focusNode: _msgFocusNode, onChanged: _onTextChanged, onSubmitted: (_) => _sendMessage(),
                maxLines: 5, minLines: 1,
                style: const TextStyle(color: Colors.white, fontSize: 15),
                decoration: const InputDecoration(hintText: 'Type a message...', hintStyle: TextStyle(color: Color(0xFF64748B)), contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 10), border: InputBorder.none),
              ),
            ),
            GestureDetector(
              onTap: () => setState(() { _showEmojiPicker = !_showEmojiPicker; if (_showEmojiPicker) _msgFocusNode.unfocus(); }),
              child: Padding(
                padding: const EdgeInsets.only(right: 10),
                child: Icon(_showEmojiPicker ? Icons.keyboard : Icons.emoji_emotions_outlined, color: _showEmojiPicker ? const Color(0xFF667EEA) : const Color(0xFF64748B), size: 24),
              ),
            ),
          ]),
        ),
      ),
      const SizedBox(width: 4),
      hasText
          ? Container(
              decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF764BA2)]), borderRadius: BorderRadius.circular(24)),
              child: IconButton(onPressed: _sendMessage, icon: const Icon(Icons.send, color: Colors.white, size: 20), tooltip: 'Send'),
            )
          : Container(
              decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF4ADE80), Color(0xFF22C55E)]), borderRadius: BorderRadius.circular(24)),
              child: IconButton(onPressed: _toggleVoiceRecording, icon: const Icon(Icons.mic, color: Colors.white, size: 20), tooltip: 'Voice message'),
            ),
    ]);
  }

  Widget _buildRecordingBar() {
    final mins = _recordingSeconds ~/ 60;
    final secs = _recordingSeconds % 60;
    return Row(children: [
      IconButton(onPressed: _cancelVoiceRecording, icon: const Icon(Icons.delete_outline, color: Color(0xFFF87171), size: 24), tooltip: 'Cancel'),
      const SizedBox(width: 8),
      Container(width: 10, height: 10, decoration: BoxDecoration(color: const Color(0xFFF87171), shape: BoxShape.circle, boxShadow: [BoxShadow(color: const Color(0xFFF87171).withOpacity(0.5), blurRadius: 6)])),
      const SizedBox(width: 10),
      Text('$mins:${secs.toString().padLeft(2, '0')}', style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600)),
      const Spacer(),
      Text('Recording...', style: TextStyle(color: Colors.white.withOpacity(0.5), fontSize: 13)),
      const SizedBox(width: 12),
      Container(
        decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF764BA2)]), borderRadius: BorderRadius.circular(24)),
        child: IconButton(onPressed: _stopAndSendVoice, icon: const Icon(Icons.send, color: Colors.white, size: 20), tooltip: 'Send voice'),
      ),
    ]);
  }
}

// ══════════════════════════════════════════════════════════════
//  D A T A   M O D E L S
// ══════════════════════════════════════════════════════════════

enum _EntryType { single, imageGroup }

class _ChatEntry {
  final _EntryType type;
  final List<Map<String, dynamic>> messages;
  _ChatEntry({required this.type, required this.messages});
}

class _Conversation {
  final String deviceId, deviceName;
  final Map<String, dynamic> lastMessage;
  final int unreadCount;
  _Conversation({required this.deviceId, required this.deviceName, required this.lastMessage, required this.unreadCount});
}

// ══════════════════════════════════════════════════════════════
//  S U B   W I D G E T S
// ══════════════════════════════════════════════════════════════

class _ConversationTile extends StatelessWidget {
  final _Conversation convo;
  final String myDeviceId;
  final VoidCallback onTap;
  final String Function(double) formatTime;
  final bool isFriend;
  const _ConversationTile({required this.convo, required this.myDeviceId, required this.onTap, required this.formatTime, this.isFriend = false});

  @override
  Widget build(BuildContext context) {
    final msg = convo.lastMessage;
    final ts = (msg['timestamp'] as num?)?.toDouble() ?? 0;
    final text = msg['text'] as String? ?? '';
    final hasMedia = msg['has_media'] == true;
    final isMine = msg['sender_id'] == myDeviceId;
    String preview;
    if (text.isNotEmpty) { preview = text; }
    else if (hasMedia) {
      final mime = msg['media_type'] as String? ?? '';
      if (mime.startsWith('image/')) preview = '📷 Photo';
      else if (mime.startsWith('video/')) preview = '🎥 Video';
      else if (mime.startsWith('audio/')) preview = '🎵 Voice';
      else preview = '📎 File';
    } else { preview = '...'; }
    if (isMine) preview = 'You: $preview';

    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Color(0xFF1E293B), width: 1))),
        child: Row(children: [
          Stack(
            children: [
              CircleAvatar(
                radius: 24, backgroundColor: (isFriend ? const Color(0xFF7C3AED) : const Color(0xFF667EEA)).withOpacity(0.15),
                child: Text(convo.deviceName.isNotEmpty ? convo.deviceName[0].toUpperCase() : '?', style: TextStyle(color: isFriend ? const Color(0xFF7C3AED) : const Color(0xFF667EEA), fontWeight: FontWeight.w700, fontSize: 18)),
              ),
              if (isFriend)
                Positioned(
                  right: 0, bottom: 0,
                  child: Container(
                    width: 16, height: 16,
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]),
                      shape: BoxShape.circle,
                      border: Border.all(color: const Color(0xFF0F172A), width: 2),
                    ),
                    child: const Icon(Icons.person, color: Colors.white, size: 9),
                  ),
                ),
            ],
          ),
          const SizedBox(width: 14),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(convo.deviceName, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 15)),
            const SizedBox(height: 4),
            Text(preview, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(
              color: convo.unreadCount > 0 ? Colors.white.withOpacity(0.8) : const Color(0xFF94A3B8),
              fontSize: 13, fontWeight: convo.unreadCount > 0 ? FontWeight.w600 : FontWeight.normal,
            )),
          ])),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(formatTime(ts), style: const TextStyle(color: Color(0xFF64748B), fontSize: 11)),
            if (convo.unreadCount > 0) ...[
              const SizedBox(height: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                decoration: BoxDecoration(gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF764BA2)]), borderRadius: BorderRadius.circular(12)),
                child: Text('${convo.unreadCount}', style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
              ),
            ],
          ]),
        ]),
      ),
    );
  }
}

// ── Image Group Bubble (photo grid + gallery) ────────────────
class _ImageGroupBubble extends StatelessWidget {
  final List<Map<String, dynamic>> messages;
  final bool isMine;
  final String Function(double) formatTime;
  final String Function(String) mediaUrlBuilder;
  const _ImageGroupBubble({required this.messages, required this.isMine, required this.formatTime, required this.mediaUrlBuilder});

  @override
  Widget build(BuildContext context) {
    final lastMsg = messages.last;
    final ts = (lastMsg['timestamp'] as num?)?.toDouble() ?? 0;
    final isRead = lastMsg['read'] == true;
    final imageUrls = messages.map((m) => mediaUrlBuilder(m['id'] as String? ?? '')).toList();
    const maxShow = 6;
    final visible = imageUrls.length > maxShow ? imageUrls.sublist(0, maxShow) : imageUrls;
    final remaining = imageUrls.length - visible.length;
    final cols = visible.length == 1 ? 1 : (visible.length == 2 ? 2 : 3);

    return Align(
      alignment: isMine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: EdgeInsets.only(top: 3, bottom: 3, left: isMine ? 48 : 0, right: isMine ? 0 : 48),
        child: Column(crossAxisAlignment: isMine ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: SizedBox(
              width: cols == 1 ? 220.0 : (cols == 2 ? 230.0 : 250.0),
              child: GridView.builder(
                shrinkWrap: true, physics: const NeverScrollableScrollPhysics(),
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: cols, crossAxisSpacing: 2, mainAxisSpacing: 2),
                itemCount: visible.length,
                itemBuilder: (ctx, idx) {
                  final isLast = idx == visible.length - 1 && remaining > 0;
                  return GestureDetector(
                    onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => _PhotoGalleryViewer(imageUrls: imageUrls, initialIndex: idx))),
                    child: Stack(fit: StackFit.expand, children: [
                      Image.network(visible[idx], fit: BoxFit.cover, errorBuilder: (_, __, ___) => Container(color: Colors.white.withOpacity(0.1), child: const Center(child: Icon(Icons.broken_image, color: Color(0xFF94A3B8))))),
                      if (isLast) Container(color: Colors.black.withOpacity(0.5), child: Center(child: Text('+$remaining', style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w700)))),
                    ]),
                  );
                },
              ),
            ),
          ),
          const SizedBox(height: 4),
          Row(mainAxisSize: MainAxisSize.min, children: [
            Text(formatTime(ts), style: TextStyle(color: isMine ? Colors.white.withOpacity(0.5) : const Color(0xFF64748B), fontSize: 11)),
            if (isMine) ...[const SizedBox(width: 4), Icon(isRead ? Icons.done_all : Icons.done, size: 14, color: isRead ? const Color(0xFF4ADE80) : Colors.white.withOpacity(0.4))],
          ]),
        ]),
      ),
    );
  }
}

// ── Single Message Bubble ────────────────────────────────────
class _MessageBubble extends StatelessWidget {
  final Map<String, dynamic> message;
  final bool isMine;
  final String Function(double) formatTime;
  final String Function(String) mediaUrlBuilder;
  final String? playingMsgId;
  final bool isAudioPlaying;
  final int audioPosition;
  final int audioDuration;
  final Future<void> Function(String msgId) onPlayAudio;
  final String myDeviceId;
  const _MessageBubble({required this.message, required this.isMine, required this.formatTime, required this.mediaUrlBuilder, this.playingMsgId, this.isAudioPlaying = false, this.audioPosition = 0, this.audioDuration = 0, required this.onPlayAudio, this.myDeviceId = ''});

  @override
  Widget build(BuildContext context) {
    final text = message['text'] as String? ?? '';
    final hasMedia = message['has_media'] == true;
    final mediaType = message['media_type'] as String? ?? '';
    final fileName = message['file_name'] as String? ?? '';
    final ts = (message['timestamp'] as num?)?.toDouble() ?? 0;
    final isRead = message['read'] == true;
    final msgId = message['id'] as String? ?? '';
    final replyTo = message['reply_to'] as Map<String, dynamic>?;

    return Align(
      alignment: isMine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: EdgeInsets.only(top: 3, bottom: 3, left: isMine ? 48 : 0, right: isMine ? 0 : 48),
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
        decoration: BoxDecoration(
          gradient: isMine ? const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF764BA2)], begin: Alignment.topLeft, end: Alignment.bottomRight) : null,
          color: isMine ? null : const Color(0xFF1E293B),
          borderRadius: BorderRadius.only(topLeft: const Radius.circular(16), topRight: const Radius.circular(16), bottomLeft: Radius.circular(isMine ? 16 : 4), bottomRight: Radius.circular(isMine ? 4 : 16)),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // Reply-to reference (WhatsApp style)
          if (replyTo != null) ...[
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(0, 0, 10, 0),
              margin: const EdgeInsets.only(bottom: 6),
              decoration: BoxDecoration(
                color: isMine ? Colors.white.withOpacity(0.12) : const Color(0xFF0F172A).withOpacity(0.5),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Builder(builder: (context) {
                final isReplyToSelf = (replyTo['sender_id'] as String?) == myDeviceId;
                // When inside own bubble (gradient bg), use lighter colors so they're visible
                final barColor = isReplyToSelf
                    ? (isMine ? const Color(0xFFB8C9FF) : const Color(0xFF667EEA))
                    : (isMine ? const Color(0xFF6EE7B7) : const Color(0xFF22C55E));
                final nameColor = isReplyToSelf
                    ? (isMine ? const Color(0xFFE0E7FF) : const Color(0xFF667EEA))
                    : (isMine ? const Color(0xFF6EE7B7) : const Color(0xFF22C55E));
                return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  // Colored left border bar
                  Container(
                    width: 4,
                    constraints: const BoxConstraints(minHeight: 40),
                    decoration: BoxDecoration(
                      color: barColor,
                      borderRadius: const BorderRadius.only(topLeft: Radius.circular(8), bottomLeft: Radius.circular(8)),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                      Text(
                        isReplyToSelf ? 'You' : (replyTo['sender_name'] as String? ?? 'Unknown'),
                        style: TextStyle(color: nameColor, fontSize: 12, fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        replyTo['text'] as String? ?? '...',
                        maxLines: 3, overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: isMine ? Colors.white.withOpacity(0.7) : Colors.white.withOpacity(0.4), fontSize: 13),
                      ),
                    ]),
                  )),
                ]);
              }),
            ),
          ],
          // Image
          if (hasMedia && mediaType.startsWith('image/')) ...[
            GestureDetector(
              onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => _PhotoGalleryViewer(imageUrls: [mediaUrlBuilder(msgId)], initialIndex: 0))),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.network(mediaUrlBuilder(msgId), width: 220, height: 180, fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => Container(width: 220, height: 60, decoration: BoxDecoration(color: Colors.white.withOpacity(0.1), borderRadius: BorderRadius.circular(10)), child: const Center(child: Icon(Icons.broken_image, color: Color(0xFF94A3B8))))),
              ),
            ),
            if (text.isNotEmpty) const SizedBox(height: 6),
          // Video
          ] else if (hasMedia && mediaType.startsWith('video/')) ...[
            Container(width: 220, height: 120, decoration: BoxDecoration(color: Colors.black38, borderRadius: BorderRadius.circular(10)), child: const Center(child: Icon(Icons.play_circle_fill, color: Colors.white70, size: 48))),
            if (text.isEmpty && fileName.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(fileName, style: TextStyle(color: isMine ? Colors.white70 : const Color(0xFF94A3B8), fontSize: 12))),
            if (text.isNotEmpty) const SizedBox(height: 6),
          // Audio / Voice
          ] else if (hasMedia && mediaType.startsWith('audio/')) ...[
            Builder(builder: (context) {
              final isThisPlaying = playingMsgId == msgId;
              final isPlaying = isThisPlaying && isAudioPlaying;
              final isLoading = isThisPlaying && !isAudioPlaying && audioPosition == 0 && audioDuration == 0;
              final pos = isThisPlaying ? audioPosition : 0;
              final dur = isThisPlaying ? audioDuration : 0;
              final progress = dur > 0 ? pos / dur : 0.0;
              String timeLabel;
              if (isThisPlaying && dur > 0) {
                final secs = (pos / 1000).round();
                final total = (dur / 1000).round();
                timeLabel = '${secs ~/ 60}:${(secs % 60).toString().padLeft(2, '0')} / ${total ~/ 60}:${(total % 60).toString().padLeft(2, '0')}';
              } else {
                timeLabel = 'Voice';
              }
              return GestureDetector(
                onTap: () => onPlayAudio(msgId),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  decoration: BoxDecoration(color: Colors.white.withOpacity(0.08), borderRadius: BorderRadius.circular(20)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    isLoading
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF4ADE80)))
                        : Icon(isPlaying ? Icons.pause_circle_filled : Icons.play_circle_filled, color: const Color(0xFF4ADE80), size: 28),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                        SizedBox(
                          width: 120,
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(2),
                            child: LinearProgressIndicator(
                              value: progress,
                              backgroundColor: isMine ? Colors.white.withOpacity(0.15) : const Color(0xFF334155),
                              valueColor: AlwaysStoppedAnimation<Color>(isThisPlaying ? const Color(0xFF4ADE80) : (isMine ? Colors.white.withOpacity(0.4) : const Color(0xFF667EEA).withOpacity(0.5))),
                              minHeight: 3,
                            ),
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(timeLabel, style: TextStyle(color: isMine ? Colors.white.withOpacity(0.7) : const Color(0xFFCBD5E1), fontSize: 11)),
                      ]),
                    ),
                  ]),
                ),
              );
            }),
            if (text.isNotEmpty) const SizedBox(height: 6),
          // Generic file
          ] else if (hasMedia) ...[
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: Colors.white.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                const Icon(Icons.insert_drive_file, color: Color(0xFF667EEA), size: 24),
                const SizedBox(width: 8),
                Flexible(child: Text(fileName.isNotEmpty ? fileName : 'File', maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: isMine ? Colors.white : const Color(0xFFCBD5E1), fontSize: 13))),
              ]),
            ),
            if (text.isNotEmpty) const SizedBox(height: 6),
          ],
          // Text (hide "Voice message" text for audio)
          if (text.isNotEmpty && !(hasMedia && mediaType.startsWith('audio/')))
            Text(text, style: TextStyle(color: isMine ? Colors.white : const Color(0xFFE2E8F0), fontSize: 15, height: 1.35)),
          // Timestamp + edited + read
          const SizedBox(height: 4),
          Row(mainAxisSize: MainAxisSize.min, children: [
            if (message['edited'] == true) ...[
              Icon(Icons.edit, size: 10, color: isMine ? Colors.white.withOpacity(0.45) : const Color(0xFF64748B)),
              const SizedBox(width: 2),
              Text('edited ', style: TextStyle(color: isMine ? Colors.white.withOpacity(0.45) : const Color(0xFF64748B), fontSize: 10, fontStyle: FontStyle.italic)),
            ],
            Text(formatTime(ts), style: TextStyle(color: isMine ? Colors.white.withOpacity(0.5) : const Color(0xFF64748B), fontSize: 11)),
            if (isMine) ...[const SizedBox(width: 4), Icon(isRead ? Icons.done_all : Icons.done, size: 14, color: isRead ? const Color(0xFF4ADE80) : Colors.white.withOpacity(0.4))],
          ]),
        ]),
      ),
    );
  }
}

// ── Fullscreen Photo Gallery Viewer ──────────────────────────
class _PhotoGalleryViewer extends StatefulWidget {
  final List<String> imageUrls;
  final int initialIndex;
  const _PhotoGalleryViewer({required this.imageUrls, required this.initialIndex});

  @override
  State<_PhotoGalleryViewer> createState() => _PhotoGalleryViewerState();
}

class _PhotoGalleryViewerState extends State<_PhotoGalleryViewer> {
  late PageController _pageCtrl;
  late int _currentIndex;

  @override
  void initState() {
    super.initState();
    _currentIndex = widget.initialIndex;
    _pageCtrl = PageController(initialPage: widget.initialIndex);
  }

  @override
  void dispose() { _pageCtrl.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(child: Stack(children: [
        PageView.builder(
          controller: _pageCtrl, itemCount: widget.imageUrls.length,
          onPageChanged: (i) => setState(() => _currentIndex = i),
          itemBuilder: (ctx, i) => InteractiveViewer(
            minScale: 0.5, maxScale: 4.0,
            child: Center(child: Image.network(widget.imageUrls[i], fit: BoxFit.contain,
              errorBuilder: (_, __, ___) => const Icon(Icons.broken_image, color: Color(0xFF94A3B8), size: 64))),
          ),
        ),
        Positioned(
          top: 0, left: 0, right: 0,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.black.withOpacity(0.7), Colors.transparent])),
            child: Row(children: [
              IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.arrow_back, color: Colors.white)),
              const Spacer(),
              if (widget.imageUrls.length > 1) Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(color: Colors.white.withOpacity(0.15), borderRadius: BorderRadius.circular(16)),
                child: Text('${_currentIndex + 1} / ${widget.imageUrls.length}', style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600)),
              ),
              const Spacer(),
              const SizedBox(width: 48),
            ]),
          ),
        ),
      ])),
    );
  }
}

// ── Swipe to Reply Widget ────────────────────────────────────
class _SwipeToReply extends StatefulWidget {
  final Widget child;
  final VoidCallback onReply;
  const _SwipeToReply({required this.child, required this.onReply});
  @override
  State<_SwipeToReply> createState() => _SwipeToReplyState();
}

class _SwipeToReplyState extends State<_SwipeToReply> with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  double _dragOffset = 0;
  bool _triggered = false;
  static const _threshold = 60.0;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 200));
    _ctrl.addListener(() {
      setState(() => _dragOffset = _dragOffset * (1 - _ctrl.value));
      if (_ctrl.isCompleted) {
        _dragOffset = 0;
        _ctrl.reset();
      }
    });
  }

  @override
  void dispose() { _ctrl.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onHorizontalDragUpdate: (details) {
        if (details.delta.dx > 0) {
          setState(() => _dragOffset = (_dragOffset + details.delta.dx).clamp(0, 100));
          if (_dragOffset >= _threshold && !_triggered) {
            _triggered = true;
            HapticFeedback.lightImpact();
          }
        }
      },
      onHorizontalDragEnd: (_) {
        if (_triggered) {
          widget.onReply();
        }
        _triggered = false;
        _ctrl.forward(from: 0);
      },
      onHorizontalDragCancel: () {
        _triggered = false;
        _ctrl.forward(from: 0);
      },
      child: Stack(
        children: [
          // Reply icon that appears through swipe
          if (_dragOffset > 10)
            Positioned(
              left: 4,
              top: 0, bottom: 0,
              child: Opacity(
                opacity: (_dragOffset / _threshold).clamp(0, 1),
                child: Center(
                  child: Container(
                    width: 32, height: 32,
                    decoration: BoxDecoration(
                      color: const Color(0xFF667EEA).withOpacity(0.2),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(Icons.reply, color: const Color(0xFF667EEA), size: 18),
                  ),
                ),
              ),
            ),
          Transform.translate(
            offset: Offset(_dragOffset, 0),
            child: widget.child,
          ),
        ],
      ),
    );
  }
}

// ── Animated typing dots ─────────────────────────────────────
class _TypingDots extends StatefulWidget {
  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots> with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  @override
  void initState() { super.initState(); _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat(); }
  @override
  void dispose() { _ctrl.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(animation: _ctrl, builder: (ctx, _) {
      return Row(mainAxisSize: MainAxisSize.min, children: List.generate(3, (i) {
        final offset = (_ctrl.value * 3 - i).clamp(0.0, 1.0);
        final y = -4 * (1 - (2 * offset - 1).abs());
        return Transform.translate(offset: Offset(0, y), child: Container(
          width: 6, height: 6, margin: const EdgeInsets.symmetric(horizontal: 1.5),
          decoration: BoxDecoration(color: const Color(0xFF667EEA).withOpacity(0.6 + 0.4 * offset), shape: BoxShape.circle),
        ));
      }));
    });
  }
}

class AnimatedBuilder extends AnimatedWidget {
  final Widget Function(BuildContext, Widget?) builder;
  const AnimatedBuilder({super.key, required Animation<double> animation, required this.builder}) : super(listenable: animation);
  @override
  Widget build(BuildContext context) => builder(context, null);
}

// ── Auth Screen Wrapper (opens AuthScreen and pops on success) ──
class _AuthScreenWrapper extends StatelessWidget {
  const _AuthScreenWrapper();

  @override
  Widget build(BuildContext context) {
    return Consumer<ApiService>(
      builder: (context, api, _) {
        if (api.isLoggedIn) {
          // Auto-pop when logged in
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (Navigator.of(context).canPop()) Navigator.of(context).pop();
          });
          return const Scaffold(
            backgroundColor: Color(0xFF0F172A),
            body: Center(child: CircularProgressIndicator(color: Color(0xFF667EEA))),
          );
        }
        return const AuthScreen();
      },
    );
  }
}
