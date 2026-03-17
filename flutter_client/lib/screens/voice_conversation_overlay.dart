import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:audioplayers/audioplayers.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:record/record.dart';
import 'package:flutter_tts/flutter_tts.dart';
import '../services/api_service.dart';

// ═══════════════════════════════════════════════════════════════
// BEAM Voice Conversation — full-screen voice overlay
// Tap-to-talk, live transcription, AI voice replies,
// waveform visualiser, thinking animation, male / female voice
// ═══════════════════════════════════════════════════════════════

class VoiceConversationOverlay extends StatefulWidget {
  const VoiceConversationOverlay({super.key});

  @override
  State<VoiceConversationOverlay> createState() => _VoiceConversationOverlayState();
}

class _VoiceConversationOverlayState extends State<VoiceConversationOverlay>
    with TickerProviderStateMixin {
  // ─── Audio Recording + Playback ────────────────────────────
  final AudioRecorder _recorder = AudioRecorder();
  final AudioPlayer _audioPlayer = AudioPlayer();
  final FlutterTts _flutterTts = FlutterTts();
  bool _flutterTtsReady = false;
  static const _groqKey = String.fromEnvironment('GROQ_API_KEY');

  // ─── State ─────────────────────────────────────────────────
  bool _isListening = false;   // recording mic
  bool _isAiThinking = false;
  bool _isAiSpeaking = false;
  bool _micReady = false;      // permission granted
  String _liveTranscript = '';
  String _selectedVoice = 'female'; // 'male' or 'female'
  String _selectedTone = 'friendly'; // friendly, professional, encouraging
  String _deviceId = 'flutter-device';
  bool _showTextInput = false;
  String? _recordingPath;
  Timer? _silenceTimer;        // auto-stop after silence
  Timer? _ampPollTimer;        // poll amplitude
  bool _hasSpoken = false;     // user made sound
  final _textCtrl = TextEditingController();
  final _textFocusNode = FocusNode();

  final List<_VoiceTurn> _turns = [];
  final ScrollController _scrollCtrl = ScrollController();

  // ─── Animations ────────────────────────────────────────────
  late AnimationController _waveCtrl;
  late AnimationController _thinkCtrl;
  late AnimationController _pulseCtrl;
  late AnimationController _rippleCtrl;

  @override
  void initState() {
    super.initState();
    _waveCtrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 1500))..repeat();
    _thinkCtrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 2000))..repeat();
    _pulseCtrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 1000))..repeat(reverse: true);
    _rippleCtrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 2500))..repeat();
    _initMic();
    _loadDeviceId();
    _loadVoicePrefs();
    _initFlutterTts();
  }

  Future<void> _initFlutterTts() async {
    try {
      await _flutterTts.setLanguage('en-US');
      await _flutterTts.setSpeechRate(0.5);
      await _flutterTts.setVolume(1.0);
      await _flutterTts.setPitch(1.0);
      _flutterTtsReady = true;
      debugPrint('FlutterTTS initialized successfully');
    } catch (e) {
      debugPrint('FlutterTTS init error: $e');
    }
  }

  Future<void> _loadDeviceId() async {
    final prefs = await SharedPreferences.getInstance();
    _deviceId = prefs.getString('p2p_device_id') ?? 'flutter-device';
  }

  Future<void> _loadVoicePrefs() async {
    final prefs = await SharedPreferences.getInstance();
    final v = prefs.getString('beam_voice') ?? 'female';
    final t = prefs.getString('beam_tone') ?? 'friendly';
    if (mounted) setState(() { _selectedVoice = v; _selectedTone = t; });
  }

  Future<void> _saveVoicePrefs() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('beam_voice', _selectedVoice);
    await prefs.setString('beam_tone', _selectedTone);
  }

  Future<void> _initMic() async {
    try {
      final micStatus = await Permission.microphone.request();
      debugPrint('Mic permission: $micStatus');
      _micReady = micStatus.isGranted;
      if (!_micReady && mounted) {
        setState(() => _showTextInput = true);
      }
    } catch (e) {
      debugPrint('Mic permission error: $e');
      _micReady = false;
    }
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _waveCtrl.dispose();
    _thinkCtrl.dispose();
    _pulseCtrl.dispose();
    _rippleCtrl.dispose();
    _audioPlayer.dispose();
    _flutterTts.stop();
    _silenceTimer?.cancel();
    _ampPollTimer?.cancel();
    _textCtrl.dispose();
    _textFocusNode.dispose();
    _recorder.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    Future.delayed(const Duration(milliseconds: 120), () {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(
          _scrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // TAP TO TALK — Record audio, send to Groq Whisper, get text
  // ═══════════════════════════════════════════════════════════
  void _onMicTap() {
    if (_isAiThinking || _isAiSpeaking) return;
    if (_isListening) {
      _stopRecordingAndTranscribe();
    } else {
      _startRecording();
    }
  }

  Future<void> _startRecording() async {
    if (!_micReady) {
      await _initMic();
      if (!_micReady) {
        if (mounted) {
          setState(() => _showTextInput = true);
          _textFocusNode.requestFocus();
        }
        return;
      }
    }

    try {
      final dir = await getTemporaryDirectory();
      _recordingPath = '${dir.path}/beam_rec_${DateTime.now().millisecondsSinceEpoch}.m4a';
      await _recorder.start(
        const RecordConfig(
          encoder: AudioEncoder.aacLc,
          bitRate: 128000,
          sampleRate: 16000,
          numChannels: 1,
          autoGain: true,
          echoCancel: true,
          noiseSuppress: true,
        ),
        path: _recordingPath!,
      );
      _hasSpoken = false;
      if (mounted) {
        setState(() {
          _isListening = true;
          _liveTranscript = 'Listening...';
        });
      }
      debugPrint('Recording started: $_recordingPath');

      // ─── Auto-stop on silence ────────────────────────────
      // Poll amplitude every 200ms. Once user has spoken and
      // amplitude drops below threshold for 2s, auto-stop.
      _silenceTimer?.cancel();
      _ampPollTimer?.cancel();
      int silentTicks = 0;
      const silenceThreshold = -35.0; // dBFS
      const ticksNeeded = 7;          // 7 x 200ms = 1.4 sec

      _ampPollTimer = Timer.periodic(const Duration(milliseconds: 200), (timer) async {
        if (!_isListening) { timer.cancel(); return; }
        try {
          final amp = await _recorder.getAmplitude();
          final db = amp.current;

          // Once we detect speech (above threshold), mark it
          if (db > silenceThreshold) {
            _hasSpoken = true;
            silentTicks = 0;
            if (mounted) setState(() => _liveTranscript = 'Listening...');
          } else if (_hasSpoken) {
            silentTicks++;
            if (silentTicks >= ticksNeeded) {
              timer.cancel();
              debugPrint('Silence detected — auto-stopping');
              _stopRecordingAndTranscribe();
            }
          }
        } catch (_) {}
      });
    } catch (e) {
      debugPrint('Start recording error: $e');
      if (mounted) {
        setState(() => _showTextInput = true);
        _textFocusNode.requestFocus();
      }
    }
  }

  Future<void> _stopRecordingAndTranscribe() async {
    _ampPollTimer?.cancel();
    _silenceTimer?.cancel();
    try {
      final path = await _recorder.stop();
      debugPrint('Recording stopped: $path');
      if (!mounted) return;
      setState(() {
        _isListening = false;
        _liveTranscript = 'Transcribing...';
      });

      if (path == null || !File(path).existsSync()) {
        setState(() => _liveTranscript = '');
        return;
      }

      // Send to Groq Whisper for transcription
      final transcript = await _transcribeWithGroq(path);
      if (!mounted) return;

      if (transcript != null && transcript.isNotEmpty) {
        setState(() => _liveTranscript = '');
        _addTurn(transcript, true);
        _sendToAi(transcript);
      } else {
        setState(() => _liveTranscript = '');
        // Fallback: show text input
        setState(() => _showTextInput = true);
        _textFocusNode.requestFocus();
      }
    } catch (e) {
      debugPrint('Stop recording error: $e');
      if (mounted) setState(() { _isListening = false; _liveTranscript = ''; });
    }
  }

  /// Transcribe audio using Groq Whisper API directly from the client
  Future<String?> _transcribeWithGroq(String audioPath) async {
    try {
      final uri = Uri.parse('https://api.groq.com/openai/v1/audio/transcriptions');
      final request = http.MultipartRequest('POST', uri);
      request.headers['Authorization'] = 'Bearer $_groqKey';
      request.fields['model'] = 'whisper-large-v3';
      request.fields['language'] = 'en';
      request.fields['response_format'] = 'json';
      request.fields['temperature'] = '0.0';
      request.fields['prompt'] = 'This is a spoken voice conversation with an AI assistant.';
      request.files.add(await http.MultipartFile.fromPath('file', audioPath));

      debugPrint('Sending audio to Groq Whisper (large-v3)...');
      final streamed = await request.send().timeout(const Duration(seconds: 15));
      final resp = await http.Response.fromStream(streamed);
      debugPrint('Groq Whisper response: ${resp.statusCode}');

      if (resp.statusCode == 200) {
        final json = jsonDecode(resp.body);
        final text = (json['text'] ?? '').toString().trim();
        debugPrint('Transcribed: "$text"');
        return text;
      } else {
        debugPrint('Groq Whisper error: ${resp.body}');
        return null;
      }
    } catch (e) {
      debugPrint('Groq Whisper exception: $e');
      return null;
    }
  }

  // ─── Send to AI & receive reply ────────────────────────────
  Future<void> _sendToAi(String text) async {
    setState(() => _isAiThinking = true);
    _scrollToBottom();

    final api = context.read<ApiService>();
    final result = await api.beamChatSmartWithTone(_deviceId, text, _selectedTone);
    if (!mounted) return;

    final reply = result['reply'] ?? result['error'] ?? 'No response';
    _addTurn(reply, false);
    setState(() => _isAiThinking = false);
    _scrollToBottom();

    // Auto-play TTS
    await _speakReply(reply);
  }

  // ═══════════════════════════════════════════════════════════
  // Text cleaner — strip emojis, markdown, symbols for natural TTS
  // ═══════════════════════════════════════════════════════════
  String _cleanForTts(String text) {
    var s = text;
    // Remove emoji unicode ranges
    s = s.replaceAll(RegExp(
      r'[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|'
      r'[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|'
      r'[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|'
      r'[\u{1FA70}-\u{1FAFF}]|[\u{200D}]|[\u{20E3}]|[\u{E0020}-\u{E007F}]',
      unicode: true,
    ), '');
    // Remove markdown: **bold**, *italic*, __bold__, _italic_
    s = s.replaceAll(RegExp(r'\*\*(.+?)\*\*'), r'$1');
    s = s.replaceAll(RegExp(r'\*(.+?)\*'), r'$1');
    s = s.replaceAll(RegExp(r'__(.+?)__'), r'$1');
    s = s.replaceAll(RegExp(r'_(.+?)_'), r'$1');
    // Remove # headers
    s = s.replaceAll(RegExp(r'^#{1,6}\s*', multiLine: true), '');
    // Remove remaining stray * and # not part of words
    s = s.replaceAll(RegExp(r'(?<=\s|^)[*#]+(?=\s|$)'), '');
    // Remove markdown links [text](url) -> text
    s = s.replaceAll(RegExp(r'\[([^\]]+)\]\([^)]+\)'), r'$1');
    // Remove code blocks
    s = s.replaceAll(RegExp(r'```[\s\S]*?```'), '');
    s = s.replaceAll(RegExp(r'`([^`]+)`'), r'$1');
    // Remove bullet points
    s = s.replaceAll(RegExp(r'^\s*[-•]\s*', multiLine: true), '');
    // Collapse whitespace
    s = s.replaceAll(RegExp(r'\s+'), ' ').trim();
    return s;
  }

  // ═══════════════════════════════════════════════════════════
  // TTS — Edge TTS Neural (same as browser) → Groq PlayAI → FlutterTTS
  // ═══════════════════════════════════════════════════════════

  // Edge TTS Neural Voices — same ones used in the browser version
  static const _edgeVoices = {
    'female': 'en-US-AriaNeural',       // Warm, expressive (browser default)
    'male':   'en-US-AndrewNeural',     // Warm, natural male
  };

  // Groq PlayAI voices — backup high-quality neural voices
  static const _groqVoices = {
    'female': 'Arista-PlayAI',
    'male': 'Fritz-PlayAI',
  };

  Future<void> _speakReply(String text) async {
    if (!mounted) return;
    setState(() => _isAiSpeaking = true);
    final cleanText = _cleanForTts(text);
    if (cleanText.isEmpty) {
      if (mounted) setState(() => _isAiSpeaking = false);
      return;
    }

    debugPrint('=== TTS START === "${cleanText.substring(0, min(60, cleanText.length))}..."');
    bool played = false;

    // ── Tier 1: Edge TTS Neural via WebSocket (same as browser — best quality) ──
    try {
      final voice = _edgeVoices[_selectedVoice] ?? _edgeVoices['female']!;
      debugPrint('Trying Edge TTS: voice=$voice');
      final audioBytes = await _edgeTtsWebSocket(cleanText, voice);
      if (audioBytes != null && audioBytes.length > 500 && mounted) {
        debugPrint('Edge TTS OK: ${audioBytes.length} bytes');
        played = await _playAudioBytes(audioBytes, 'mp3');
      }
    } catch (e) {
      debugPrint('Edge TTS error: $e');
    }

    // ── Tier 2: Groq PlayAI TTS (REST, reliable) ──
    if (!played && mounted) {
      try {
        debugPrint('Trying Groq PlayAI TTS...');
        final gVoice = _groqVoices[_selectedVoice] ?? _groqVoices['female']!;
        final resp = await http.post(
          Uri.parse('https://api.groq.com/openai/v1/audio/speech'),
          headers: {
            'Authorization': 'Bearer $_groqKey',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({
            'model': 'playai-tts',
            'input': cleanText,
            'voice': gVoice,
            'response_format': 'mp3',
          }),
        ).timeout(const Duration(seconds: 15));
        debugPrint('Groq TTS: status=${resp.statusCode}, bytes=${resp.bodyBytes.length}');
        if (resp.statusCode == 200 && resp.bodyBytes.length > 500 && mounted) {
          played = await _playAudioBytes(resp.bodyBytes, 'mp3');
        }
      } catch (e) {
        debugPrint('Groq TTS error: $e');
      }
    }

    // ── Tier 3: On-device FlutterTTS (always works) ──
    if (!played && mounted && _flutterTtsReady) {
      debugPrint('Falling back to FlutterTTS...');
      try {
        if (_selectedVoice == 'male') {
          await _flutterTts.setPitch(0.85);
          await _flutterTts.setSpeechRate(0.48);
        } else {
          await _flutterTts.setPitch(1.05);
          await _flutterTts.setSpeechRate(0.5);
        }
        final c = Completer<void>();
        _flutterTts.setCompletionHandler(() { if (!c.isCompleted) c.complete(); });
        _flutterTts.setErrorHandler((_) { if (!c.isCompleted) c.complete(); });
        final r = await _flutterTts.speak(cleanText);
        if (r == 1) {
          await c.future.timeout(Duration(seconds: max(8, cleanText.length ~/ 5)),
            onTimeout: () {});
          played = true;
        }
      } catch (e) {
        debugPrint('FlutterTTS error: $e');
      }
    }

    if (!played) debugPrint('=== TTS FAILED ===');
    if (mounted) setState(() => _isAiSpeaking = false);
  }

  /// Play audio bytes via audioplayers
  Future<bool> _playAudioBytes(Uint8List bytes, String ext) async {
    try {
      final dir = await getTemporaryDirectory();
      final file = File('${dir.path}/beam_tts_${DateTime.now().millisecondsSinceEpoch}.$ext');
      await file.writeAsBytes(bytes);
      final c = Completer<void>();
      late final StreamSubscription sub;
      sub = _audioPlayer.onPlayerComplete.listen((_) {
        if (!c.isCompleted) c.complete();
        sub.cancel();
      });
      await _audioPlayer.setVolume(1.0);
      await _audioPlayer.play(DeviceFileSource(file.path));
      await c.future.timeout(const Duration(seconds: 60), onTimeout: () {});
      sub.cancel();
      return true;
    } catch (e) {
      debugPrint('_playAudioBytes error: $e');
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Edge TTS WebSocket — same protocol as Python edge_tts library
  // Connects to Microsoft's free speech.platform.bing.com
  // ═══════════════════════════════════════════════════════════
  static const _edgeTtsToken = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

  Future<Uint8List?> _edgeTtsWebSocket(String text, String voice) async {
    WebSocket? ws;
    try {
      // Generate unique request ID (hex, no dashes)
      final reqId = List.generate(16, (_) => Random().nextInt(256)
          .toRadixString(16).padLeft(2, '0')).join();

      final wsUrl = 'wss://speech.platform.bing.com/consumer/speech/synthesize/'
          'readaloud/edge/v1?TrustedClientToken=$_edgeTtsToken&ConnectionId=$reqId';

      debugPrint('Edge TTS: connecting WS...');
      ws = await WebSocket.connect(
        wsUrl,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
          'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        },
      ).timeout(const Duration(seconds: 6));
      debugPrint('Edge TTS: WS connected');

      // Step 1: Send config
      final ts = DateTime.now().toUtc().toIso8601String();
      ws.add(
        'X-Timestamp:$ts\r\n'
        'Content-Type:application/json; charset=utf-8\r\n'
        'Path:speech.config\r\n\r\n'
        '{"context":{"synthesis":{"audio":{"metadataoptions":{'
        '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
        '"outputFormat":"audio-24khz-96kbitrate-mono-mp3"}}}}'
      );

      // Step 2: Send SSML
      final escaped = text
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&apos;');

      final ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
          'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">'
          '<voice name="$voice">'
          '<prosody rate="+5%" pitch="+0Hz">'
          '$escaped'
          '</prosody></voice></speak>';

      ws.add(
        'X-RequestId:$reqId\r\n'
        'X-Timestamp:$ts\r\n'
        'Content-Type:application/ssml+xml\r\n'
        'Path:ssml\r\n\r\n'
        '$ssml'
      );

      // Step 3: Collect audio — use listen() with timeout instead of await for
      final audioChunks = <int>[];
      final completer = Completer<Uint8List?>();

      final sub = ws.listen(
        (data) {
          if (completer.isCompleted) return;
          if (data is List<int>) {
            // Binary frame: 2-byte header length (big-endian) + header text + audio
            if (data.length > 2) {
              final headerLen = (data[0] << 8) | data[1];
              final audioStart = headerLen + 2;
              if (audioStart < data.length) {
                audioChunks.addAll(data.sublist(audioStart));
              }
            }
          } else if (data is String) {
            if (data.contains('Path:turn.end')) {
              debugPrint('Edge TTS: turn.end, ${audioChunks.length} bytes');
              if (!completer.isCompleted) {
                completer.complete(
                  audioChunks.length > 500 ? Uint8List.fromList(audioChunks) : null
                );
              }
            }
          }
        },
        onError: (e) {
          debugPrint('Edge TTS WS stream error: $e');
          if (!completer.isCompleted) completer.complete(null);
        },
        onDone: () {
          debugPrint('Edge TTS WS stream done, ${audioChunks.length} bytes');
          if (!completer.isCompleted) {
            completer.complete(
              audioChunks.length > 500 ? Uint8List.fromList(audioChunks) : null
            );
          }
        },
      );

      // Timeout: 12s max for TTS generation
      final result = await completer.future.timeout(
        const Duration(seconds: 12),
        onTimeout: () {
          debugPrint('Edge TTS: timed out after 12s');
          return audioChunks.length > 500 ? Uint8List.fromList(audioChunks) : null;
        },
      );

      await sub.cancel();
      try { await ws.close(); } catch (_) {}
      return result;
    } catch (e) {
      debugPrint('Edge TTS WS error: $e');
      try { ws?.close(); } catch (_) {}
      return null;
    }
  }

  /// Send typed text (fallback when STT unavailable)
  void _sendTypedText() {
    final text = _textCtrl.text.trim();
    if (text.isEmpty || _isAiThinking) return;
    _textCtrl.clear();
    _addTurn(text, true);
    _sendToAi(text);
  }

  void _addTurn(String text, bool isUser) {
    setState(() {
      _turns.add(_VoiceTurn(text: text, isUser: isUser, time: DateTime.now()));
      _liveTranscript = '';
    });
  }

  // ═══════════════════════════════════════════════════════════
  // BUILD
  // ═══════════════════════════════════════════════════════════
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF0A0E21), Color(0xFF141B2D), Color(0xFF0F172A)],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              _buildTopBar(),
              _buildVoiceSelector(),
              _buildVisualiser(),
              Expanded(child: _buildConversation()),
              if (_showTextInput) _buildTextInput(),
              _buildMicArea(),
              const SizedBox(height: 16),
            ],
          ),
        ),
      ),
    );
  }

  // ─── Top bar ─────────────────────────────────────────────────
  Widget _buildTopBar() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          GestureDetector(
            onTap: () => Navigator.of(context).pop(),
            child: Container(
              width: 40, height: 40,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: Colors.white.withOpacity(0.08),
              ),
              child: const Icon(Icons.arrow_back_ios_new, color: Colors.white70, size: 18),
            ),
          ),
          const SizedBox(width: 12),
          Container(
            width: 36, height: 36,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: const LinearGradient(
                colors: [Color(0xFF667EEA), Color(0xFF7C3AED)],
              ),
              boxShadow: [
                BoxShadow(color: const Color(0xFF667EEA).withOpacity(0.4), blurRadius: 12),
              ],
            ),
            child: const Icon(Icons.auto_awesome, color: Colors.white, size: 16),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('BEAM Voice', style: TextStyle(
                  color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700, letterSpacing: 0.5,
                )),
                Text(
                  _isAiSpeaking
                      ? 'Speaking...'
                      : _isAiThinking
                          ? 'Thinking...'
                          : _isListening
                              ? 'Listening...'
                              : 'Tap mic to talk',
                  style: TextStyle(
                    color: _isAiSpeaking
                        ? const Color(0xFF667EEA)
                        : _isListening
                            ? Colors.greenAccent
                            : Colors.white54,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          // End conversation
          GestureDetector(
            onTap: () => Navigator.of(context).pop(),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(20),
                color: Colors.redAccent.withOpacity(0.15),
                border: Border.all(color: Colors.redAccent.withOpacity(0.3)),
              ),
              child: const Text('End', style: TextStyle(
                color: Colors.redAccent, fontSize: 12, fontWeight: FontWeight.w600,
              )),
            ),
          ),
        ],
      ),
    );
  }

  // ─── Voice + Tone selector ──────────────────────────────────
  Widget _buildVoiceSelector() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Column(
        children: [
          // Gender row
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _voiceChip('female', '♀ Female', Icons.face_3),
              const SizedBox(width: 8),
              _voiceChip('male', '♂ Male', Icons.face),
            ],
          ),
          const SizedBox(height: 6),
          // Tone row
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _toneChip('friendly', '😊 Friendly'),
              const SizedBox(width: 6),
              _toneChip('professional', '💼 Pro'),
              const SizedBox(width: 6),
              _toneChip('encouraging', '🔥 Hype'),
            ],
          ),
        ],
      ),
    );
  }

  Widget _voiceChip(String value, String label, IconData icon) {
    final selected = _selectedVoice == value;
    return GestureDetector(
      onTap: () { setState(() => _selectedVoice = value); _saveVoicePrefs(); },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 250),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          color: selected ? const Color(0xFF667EEA).withOpacity(0.2) : Colors.white.withOpacity(0.04),
          border: Border.all(
            color: selected ? const Color(0xFF667EEA) : Colors.white.withOpacity(0.08),
            width: selected ? 1.5 : 1,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: selected ? const Color(0xFF667EEA) : Colors.white38),
            const SizedBox(width: 5),
            Text(label, style: TextStyle(
              fontSize: 11, fontWeight: FontWeight.w600,
              color: selected ? const Color(0xFF667EEA) : Colors.white38,
            )),
          ],
        ),
      ),
    );
  }

  Widget _toneChip(String value, String label) {
    final selected = _selectedTone == value;
    return GestureDetector(
      onTap: () { setState(() => _selectedTone = value); _saveVoicePrefs(); },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 250),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          color: selected ? const Color(0xFF7C3AED).withOpacity(0.2) : Colors.white.withOpacity(0.04),
          border: Border.all(
            color: selected ? const Color(0xFF7C3AED) : Colors.white.withOpacity(0.08),
            width: selected ? 1.5 : 1,
          ),
        ),
        child: Text(label, style: TextStyle(
          fontSize: 11, fontWeight: FontWeight.w600,
          color: selected ? const Color(0xFF7C3AED) : Colors.white38,
        )),
      ),
    );
  }

  // ─── Scrollable conversation (Apple Music lyrics style) ─────
  Widget _buildConversation() {
    final count = _turns.length
        + (_isListening && _liveTranscript.isNotEmpty ? 1 : 0)
        + (_isAiThinking ? 1 : 0);

    if (count == 0) {
      return Center(
        child: Text(
          'Tap the mic to start talking',
          style: const TextStyle(color: Colors.white24, fontSize: 14),
        ),
      );
    }

    return ShaderMask(
      shaderCallback: (bounds) => const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [Colors.transparent, Colors.white, Colors.white, Colors.transparent],
        stops: [0.0, 0.06, 0.92, 1.0],
      ).createShader(bounds),
      blendMode: BlendMode.dstIn,
      child: ListView.builder(
        controller: _scrollCtrl,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
        physics: const BouncingScrollPhysics(),
        itemCount: count,
        itemBuilder: (context, index) {
          int offset = 0;
          if (_isListening && _liveTranscript.isNotEmpty) {
            if (index == 0) return _buildLiveTranscript();
            offset = 1;
          }
          final turnIdx = index - offset;
          if (turnIdx < _turns.length) {
            return _buildAnimatedTurn(_turns[turnIdx], turnIdx);
          }
          return _buildThinkingBubble();
        },
      ),
    );
  }

  // ─── Central Visualiser ─────────────────────────────────────
  Widget _buildVisualiser() {
    // Determine mode for the sand painter
    _SandMode mode;
    if (_isAiSpeaking) {
      mode = _SandMode.speaking;
    } else if (_isAiThinking) {
      mode = _SandMode.thinking;
    } else if (_isListening) {
      mode = _SandMode.listening;
    } else {
      mode = _SandMode.idle;
    }

    return SizedBox(
      height: 120,
      width: double.infinity,
      child: AnimatedBuilder(
        animation: Listenable.merge([_waveCtrl, _thinkCtrl, _pulseCtrl]),
        builder: (context, _) {
          return CustomPaint(
            painter: _SandVisualizerPainter(
              mode: mode,
              waveT: _waveCtrl.value,
              thinkT: _thinkCtrl.value,
              pulseT: _pulseCtrl.value,
            ),
            size: Size.infinite,
          );
        },
      ),
    );
  }

  // ─── Live Transcript ────────────────────────────────────────
  Widget _buildLiveTranscript() {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.greenAccent.withOpacity(0.06),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.greenAccent.withOpacity(0.15)),
      ),
      child: Row(
        children: [
          Container(
            width: 6, height: 6,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: Colors.greenAccent,
              boxShadow: [BoxShadow(color: Colors.greenAccent.withOpacity(0.5), blurRadius: 6)],
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              _liveTranscript,
              style: const TextStyle(
                color: Colors.greenAccent, fontSize: 15, height: 1.4,
                fontStyle: FontStyle.italic,
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ─── Lyrics-style animated turn (slide up + fade in) ────────
  Widget _buildAnimatedTurn(_VoiceTurn turn, int index) {
    final isLatest = index == _turns.length - 1;
    final age = _turns.length - 1 - index;
    // Apple Music lyrics: latest line bright, older lines dim
    final dimOpacity = isLatest ? 1.0 : (0.9 - age * 0.05).clamp(0.4, 0.9);

    return TweenAnimationBuilder<double>(
      key: ValueKey('turn_${turn.time.millisecondsSinceEpoch}'),
      tween: Tween(begin: 0.0, end: 1.0),
      duration: const Duration(milliseconds: 600),
      curve: Curves.easeOutCubic,
      builder: (context, enterAnim, child) {
        return Transform.translate(
          offset: Offset(0, 28 * (1 - enterAnim)),
          child: child,
        );
      },
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 400),
        opacity: dimOpacity,
        child: _buildTurnBubble(turn),
      ),
    );
  }

  // ─── Conversation turn bubble ───────────────────────────────
  Widget _buildTurnBubble(_VoiceTurn turn) {
    final isUser = turn.isUser;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        children: [
          if (!isUser) ...[
            Container(
              width: 28, height: 28,
              margin: const EdgeInsets.only(right: 8, top: 4),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: const LinearGradient(
                  colors: [Color(0xFF667EEA), Color(0xFF7C3AED)],
                ),
              ),
              child: const Icon(Icons.auto_awesome, color: Colors.white, size: 13),
            ),
          ],
          Flexible(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: isUser
                    ? const Color(0xFF667EEA).withOpacity(0.15)
                    : Colors.white.withOpacity(0.05),
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(16),
                  topRight: const Radius.circular(16),
                  bottomLeft: Radius.circular(isUser ? 16 : 4),
                  bottomRight: Radius.circular(isUser ? 4 : 16),
                ),
                border: Border.all(
                  color: isUser
                      ? const Color(0xFF667EEA).withOpacity(0.2)
                      : Colors.white.withOpacity(0.06),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    isUser ? 'You' : 'BEAM',
                    style: TextStyle(
                      fontSize: 11, fontWeight: FontWeight.w700,
                      color: isUser ? const Color(0xFF667EEA) : const Color(0xFF7C3AED),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    turn.text,
                    style: TextStyle(
                      color: Colors.white.withOpacity(0.88),
                      fontSize: 14, height: 1.45,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${turn.time.hour.toString().padLeft(2, '0')}:${turn.time.minute.toString().padLeft(2, '0')}',
                    style: TextStyle(fontSize: 10, color: Colors.white.withOpacity(0.25)),
                  ),
                ],
              ),
            ),
          ),
          if (isUser) ...[
            Container(
              width: 28, height: 28,
              margin: const EdgeInsets.only(left: 8, top: 4),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: const Color(0xFF667EEA).withOpacity(0.15),
              ),
              child: Icon(Icons.person, color: const Color(0xFF667EEA).withOpacity(0.7), size: 14),
            ),
          ],
        ],
      ),
    );
  }

  // ─── Thinking bubble ────────────────────────────────────────
  Widget _buildThinkingBubble() {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 28, height: 28,
            margin: const EdgeInsets.only(right: 8, top: 4),
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: const LinearGradient(
                colors: [Color(0xFF667EEA), Color(0xFF7C3AED)],
              ),
            ),
            child: const Icon(Icons.auto_awesome, color: Colors.white, size: 13),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: Colors.white.withOpacity(0.05),
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(16),
                topRight: Radius.circular(16),
                bottomLeft: Radius.circular(4),
                bottomRight: Radius.circular(16),
              ),
              border: Border.all(color: Colors.white.withOpacity(0.06)),
            ),
            child: const _ThinkingWave(),
          ),
        ],
      ),
    );
  }

  // ─── Text Input Fallback ────────────────────────────────────
  Widget _buildTextInput() {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      padding: const EdgeInsets.symmetric(horizontal: 4),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.06),
        borderRadius: BorderRadius.circular(28),
        border: Border.all(color: const Color(0xFF667EEA).withOpacity(0.2)),
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _textCtrl,
              focusNode: _textFocusNode,
              style: const TextStyle(color: Colors.white, fontSize: 15),
              decoration: InputDecoration(
                hintText: 'Type your message...',
                hintStyle: TextStyle(color: Colors.white.withOpacity(0.3)),
                border: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              ),
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _sendTypedText(),
            ),
          ),
          GestureDetector(
            onTap: _sendTypedText,
            child: Container(
              width: 40, height: 40,
              margin: const EdgeInsets.only(right: 4),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: const LinearGradient(
                  colors: [Color(0xFF667EEA), Color(0xFF7C3AED)],
                ),
              ),
              child: const Icon(Icons.send_rounded, color: Colors.white, size: 18),
            ),
          ),
        ],
      ),
    );
  }

  // ─── Mic Area (bottom) ──────────────────────────────────────
  Widget _buildMicArea() {
    final bool canTap = !_isAiThinking && !_isAiSpeaking;
    final String label = _isListening
        ? 'Tap to send'
        : _isAiSpeaking
            ? 'BEAM is speaking...'
            : _isAiThinking
                ? 'BEAM is thinking...'
                : 'Tap to talk';

    return Column(
      children: [
        // Listening: show animated ring
        GestureDetector(
          onTap: canTap ? _onMicTap : null,
          child: AnimatedBuilder(
            animation: _pulseCtrl,
            builder: (context, _) {
              final ringScale = _isListening ? 1.0 + _pulseCtrl.value * 0.1 : 1.0;
              return Transform.scale(
                scale: ringScale,
                child: Container(
                  width: 72, height: 72,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: LinearGradient(
                      colors: _isListening
                          ? [const Color(0xFF10B981), const Color(0xFF059669)]
                          : canTap
                              ? [const Color(0xFF667EEA), const Color(0xFF7C3AED)]
                              : [Colors.white24, Colors.white12],
                    ),
                    boxShadow: [
                      if (_isListening)
                        BoxShadow(color: Colors.greenAccent.withOpacity(0.4), blurRadius: 30, spreadRadius: 4)
                      else if (canTap)
                        BoxShadow(color: const Color(0xFF667EEA).withOpacity(0.3), blurRadius: 20, spreadRadius: 2),
                    ],
                  ),
                  child: Icon(
                    _isListening ? Icons.stop_rounded : Icons.mic,
                    color: Colors.white,
                    size: 32,
                  ),
                ),
              );
            },
          ),
        ),
        const SizedBox(height: 10),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(label, style: TextStyle(
              color: _isListening ? Colors.greenAccent : Colors.white.withOpacity(0.45),
              fontSize: 13, fontWeight: FontWeight.w500,
            )),
            const SizedBox(width: 16),
            // Keyboard toggle
            GestureDetector(
              onTap: () => setState(() => _showTextInput = !_showTextInput),
              child: Container(
                width: 36, height: 36,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: _showTextInput
                      ? const Color(0xFF667EEA).withOpacity(0.2)
                      : Colors.white.withOpacity(0.06),
                  border: Border.all(
                    color: _showTextInput
                        ? const Color(0xFF667EEA)
                        : Colors.white.withOpacity(0.1),
                  ),
                ),
                child: Icon(
                  _showTextInput ? Icons.mic : Icons.keyboard,
                  color: _showTextInput ? const Color(0xFF667EEA) : Colors.white38,
                  size: 16,
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Data Model
// ═══════════════════════════════════════════════════════════════
class _VoiceTurn {
  final String text;
  final bool isUser;
  final DateTime time;
  const _VoiceTurn({required this.text, required this.isUser, required this.time});
}

// ═══════════════════════════════════════════════════════════════
// Thinking Wave Animation (for inline thinking bubble)
// ═══════════════════════════════════════════════════════════════
class _ThinkingWave extends StatefulWidget {
  const _ThinkingWave();
  @override
  State<_ThinkingWave> createState() => _ThinkingWaveState();
}

class _ThinkingWaveState extends State<_ThinkingWave> with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 1800))..repeat();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (context, _) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: List.generate(5, (i) {
            final phase = i / 5;
            final val = ((_ctrl.value + phase) % 1.0);
            final height = 4.0 + sin(val * 2 * pi) * 10;
            return Container(
              margin: EdgeInsets.only(right: i < 4 ? 3 : 0),
              width: 4,
              height: height.abs().clamp(4.0, 14.0),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(2),
                color: const Color(0xFF667EEA).withOpacity(0.4 + sin(val * pi) * 0.5),
              ),
            );
          }),
        );
      },
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Sand Visualizer Mode
// ═══════════════════════════════════════════════════════════════
enum _SandMode { idle, listening, speaking, thinking }

// ═══════════════════════════════════════════════════════════════
// Sand Visualizer CustomPainter
// Draws particles that vibrate like sand on a speaker membrane.
// Each mode produces different intensity/color/pattern.
// ═══════════════════════════════════════════════════════════════
class _SandVisualizerPainter extends CustomPainter {
  final _SandMode mode;
  final double waveT;
  final double thinkT;
  final double pulseT;

  // Pre-seeded particle positions (generated once, deterministic)
  static final List<_SandGrain> _grains = _generateGrains(120);

  _SandVisualizerPainter({
    required this.mode,
    required this.waveT,
    required this.thinkT,
    required this.pulseT,
  });

  static List<_SandGrain> _generateGrains(int count) {
    final rng = Random(42); // deterministic seed
    return List.generate(count, (i) {
      return _SandGrain(
        baseX: rng.nextDouble(),     // 0..1 normalized
        baseY: rng.nextDouble(),
        size: 2.0 + rng.nextDouble() * 3.5,
        phase: rng.nextDouble() * 2 * pi,
        speed: 0.5 + rng.nextDouble() * 2.0,
        freq: 1.0 + rng.nextDouble() * 3.0,
      );
    });
  }

  @override
  void paint(Canvas canvas, Size size) {
    final cx = size.width / 2;
    final cy = size.height / 2;
    final maxRadius = size.width * 0.42;

    // Draw subtle base circle (membrane)
    final membranePaint = Paint()
      ..color = const Color(0xFF667EEA).withOpacity(0.04)
      ..style = PaintingStyle.fill;
    canvas.drawCircle(Offset(cx, cy), maxRadius, membranePaint);

    final ringPaint = Paint()
      ..color = const Color(0xFF667EEA).withOpacity(0.08)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    canvas.drawCircle(Offset(cx, cy), maxRadius, ringPaint);

    // Determine animation parameters per mode
    double intensity;   // how much grains vibrate
    double spreadX;     // horizontal scatter
    double spreadY;     // vertical scatter (pitch)
    Color baseColor;
    Color glowColor;
    double t;

    switch (mode) {
      case _SandMode.idle:
        intensity = 0.12;
        spreadX = 0.6;
        spreadY = 0.3;
        baseColor = const Color(0xFF667EEA);
        glowColor = const Color(0xFF667EEA);
        t = pulseT;
        break;
      case _SandMode.listening:
        intensity = 0.7;
        spreadX = 1.0;
        spreadY = 0.9;
        baseColor = const Color(0xFF10B981);
        glowColor = const Color(0xFF34D399);
        t = waveT;
        break;
      case _SandMode.speaking:
        intensity = 1.0;
        spreadX = 1.2;
        spreadY = 1.0;
        baseColor = const Color(0xFF667EEA);
        glowColor = const Color(0xFF7C3AED);
        t = waveT;
        break;
      case _SandMode.thinking:
        intensity = 0.4;
        spreadX = 0.8;
        spreadY = 0.5;
        baseColor = const Color(0xFF7C3AED);
        glowColor = const Color(0xFF667EEA);
        t = thinkT;
        break;
    }

    for (final grain in _grains) {
      // Position in circle — polar layout
      final angleSeed = grain.baseX * 2 * pi;
      final rSeed = grain.baseY;
      final baseR = rSeed * maxRadius * 0.85;

      // Vibration displacement (simulates sand shaking)
      final vibX = sin(t * 2 * pi * grain.freq + grain.phase) * intensity * spreadX * 8;
      final vibY = cos(t * 2 * pi * grain.speed + grain.phase * 1.3) * intensity * spreadY * 8;

      // Additional harmonic for complex pattern
      final harmonic = sin(t * 4 * pi * grain.freq * 0.7 + grain.phase * 2.1) * intensity * 4;

      final px = cx + cos(angleSeed) * baseR + vibX + harmonic * 0.5;
      final py = cy + sin(angleSeed) * baseR + vibY + harmonic;

      // Distance from center affects opacity and color tint
      final dist = sqrt(pow(px - cx, 2) + pow(py - cy, 2));
      final normalizedDist = (dist / maxRadius).clamp(0.0, 1.0);

      // Opacity: particles near edge are brighter during activity
      final baseOpacity = mode == _SandMode.idle ? 0.25 : 0.35;
      final opacityBoost = intensity * sin(t * 2 * pi + grain.phase).abs() * 0.5;
      final opacity = (baseOpacity + opacityBoost + normalizedDist * 0.2).clamp(0.15, 0.95);

      final color = Color.lerp(baseColor, glowColor, normalizedDist)!.withOpacity(opacity);

      final grainPaint = Paint()
        ..color = color
        ..style = PaintingStyle.fill;

      // Grain size wobbles slightly
      final sizeWobble = grain.size + sin(t * 2 * pi * 2 + grain.phase) * intensity * 1.2;
      final finalSize = sizeWobble.clamp(1.5, 6.5);

      canvas.drawCircle(Offset(px, py), finalSize, grainPaint);

      // Glow for active modes
      if (intensity > 0.3 && opacity > 0.4) {
        final glowPaint = Paint()
          ..color = glowColor.withOpacity(opacity * 0.2)
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 4);
        canvas.drawCircle(Offset(px, py), finalSize * 1.8, glowPaint);
      }
    }

    // ─── Connect the dots (neural network style) ─────────────
    // Draw lines between nearby grains — looks like AI connecting thoughts
    final linePaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 0.6;
    final connectionDist = maxRadius * (0.25 + intensity * 0.2);
    final grainPositions = <Offset>[];

    // Collect positions for connection lines
    for (final grain in _grains) {
      final angleSeed = grain.baseX * 2 * pi;
      final rSeed = grain.baseY;
      final baseR = rSeed * maxRadius * 0.85;
      final vibX2 = sin(t * 2 * pi * grain.freq + grain.phase) * intensity * spreadX * 8;
      final vibY2 = cos(t * 2 * pi * grain.speed + grain.phase * 1.3) * intensity * spreadY * 8;
      final harmonic2 = sin(t * 4 * pi * grain.freq * 0.7 + grain.phase * 2.1) * intensity * 4;
      grainPositions.add(Offset(
        cx + cos(angleSeed) * baseR + vibX2 + harmonic2 * 0.5,
        cy + sin(angleSeed) * baseR + vibY2 + harmonic2,
      ));
    }

    // Draw connection lines between nearby grains
    for (int i = 0; i < grainPositions.length; i++) {
      for (int j = i + 1; j < grainPositions.length; j++) {
        final d = (grainPositions[i] - grainPositions[j]).distance;
        if (d < connectionDist) {
          final lineOpacity = ((1.0 - d / connectionDist) * 0.25 * intensity).clamp(0.0, 0.2);
          linePaint.color = baseColor.withOpacity(lineOpacity);
          canvas.drawLine(grainPositions[i], grainPositions[j], linePaint);
        }
      }
    }

    // Speaking mode: draw a subtle wave line across the middle
    if (mode == _SandMode.speaking) {
      final wavePaint = Paint()
        ..color = glowColor.withOpacity(0.15)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2;
      final path = Path();
      for (int i = 0; i <= 60; i++) {
        final x = cx - maxRadius + (i / 60) * maxRadius * 2;
        final y = cy + sin(waveT * 2 * pi * 3 + i * 0.15) * 12 * intensity
                     + cos(waveT * 2 * pi * 5 + i * 0.08) * 6;
        if (i == 0) path.moveTo(x, y); else path.lineTo(x, y);
      }
      canvas.drawPath(path, wavePaint);
    }

    // Thinking mode: rotating ring of brighter dots with pulse trail
    if (mode == _SandMode.thinking) {
      for (int i = 0; i < 8; i++) {
        final angle = thinkT * 2 * pi + i * (2 * pi / 8);
        final r = maxRadius * 0.65;
        final dx = cx + cos(angle) * r;
        final dy = cy + sin(angle) * r;
        final dotPaint = Paint()
          ..color = const Color(0xFF7C3AED).withOpacity(0.5 + sin(thinkT * 4 * pi + i).abs() * 0.4)
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3);
        canvas.drawCircle(Offset(dx, dy), 4, dotPaint);
        // Connect thinking dots to nearby grains
        for (int g = 0; g < grainPositions.length; g += 3) {
          final gd = (Offset(dx, dy) - grainPositions[g]).distance;
          if (gd < connectionDist * 1.5) {
            linePaint.color = const Color(0xFF7C3AED).withOpacity(0.08);
            canvas.drawLine(Offset(dx, dy), grainPositions[g], linePaint);
          }
        }
      }
    }
  }

  @override
  bool shouldRepaint(covariant _SandVisualizerPainter old) => true;
}

class _SandGrain {
  final double baseX, baseY, size, phase, speed, freq;
  const _SandGrain({
    required this.baseX,
    required this.baseY,
    required this.size,
    required this.phase,
    required this.speed,
    required this.freq,
  });
}
