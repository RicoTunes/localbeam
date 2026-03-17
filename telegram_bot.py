"""
BEAM AI — Telegram Bot Integration
===================================
Allows users to chat with their BEAM AI assistant via Telegram.
Supports text messages, voice messages (with transcription + TTS reply),
and image analysis via Qwen Vision.

Usage:
  1. Create a bot via @BotFather on Telegram → get your bot token
  2. Set the token via the /api/telegram/config endpoint or telegram_config.json
  3. Start the server — the bot auto-starts and responds to messages
"""

import os
import json
import time
import asyncio
import threading
import base64
import tempfile
import traceback
import ssl
import io
import re as _re
from pathlib import Path

try:
    import edge_tts
    _edge_tts_available = True
except ImportError:
    _edge_tts_available = False
    print("[TELEGRAM] edge_tts not installed — voice replies disabled")

# ──────────────────────────────────────────────────────────────
# Config file for Telegram bot tokens
# ──────────────────────────────────────────────────────────────
_CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'telegram_config.json')
_config_lock = threading.Lock()
_active_bots = {}          # token -> {'thread': Thread, 'loop': asyncio.AbstractEventLoop, 'app': Application}
_telegram_conversations = {}  # f"tg_{user_id}" -> [{role, content, timestamp}]

# API keys
GROQ_API_KEY = os.environ.get('GROQ_API_KEY', '')
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')

# Edge TTS voices — same as browser version
EDGE_TTS_VOICE_FEMALE = 'en-US-AriaNeural'
EDGE_TTS_VOICE_MALE = 'en-US-AndrewNeural'
DEFAULT_TTS_VOICE = EDGE_TTS_VOICE_FEMALE

def _load_config():
    """Load telegram config: {beam_token: "...", bot_tokens: {bot_id: "..."}}"""
    try:
        if os.path.exists(_CONFIG_FILE):
            with open(_CONFIG_FILE, 'r') as f:
                return json.load(f)
    except Exception as e:
        print(f"[TELEGRAM] Config load error: {e}")
    return {}

def _save_config(config):
    """Save telegram config to file."""
    try:
        with open(_CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)
    except Exception as e:
        print(f"[TELEGRAM] Config save error: {e}")


def _get_beam_token():
    """Get the main BEAM AI Telegram bot token."""
    config = _load_config()
    return config.get('beam_token', '')


def set_beam_token(token):
    """Set the main BEAM AI Telegram bot token and restart the bot."""
    with _config_lock:
        config = _load_config()
        old_token = config.get('beam_token', '')
        config['beam_token'] = token.strip()
        _save_config(config)

    # Stop old bot if running
    if old_token and old_token in _active_bots:
        stop_bot(old_token)

    # Start new bot if token is provided
    if token.strip():
        start_beam_bot(token.strip())
    return True


def get_status():
    """Get status of all active Telegram bots."""
    config = _load_config()
    beam_token = config.get('beam_token', '')
    return {
        'beam_bot_configured': bool(beam_token),
        'beam_bot_running': beam_token in _active_bots if beam_token else False,
        'active_bots': len(_active_bots),
    }


# ──────────────────────────────────────────────────────────────
# Core AI Functions — imported from app.py at runtime
# ──────────────────────────────────────────────────────────────
_app_module = None

def _get_app():
    """Lazy import of app module to avoid circular imports."""
    global _app_module
    if _app_module is None:
        import app as _app_module
    return _app_module


def _ai_chat(user_id, text, owner_id=None):
    """Get BEAM AI response for a Telegram user's message.
    Uses the same AI backend as the main app."""
    app_mod = _get_app()

    # Get or create user profile
    profile_key = owner_id or f'tg_{user_id}'
    profile = app_mod._get_user_profile(profile_key)

    # Build conversation context
    conv_key = f'tg_{user_id}'
    with app_mod._ai_lock:
        if conv_key not in app_mod._ai_conversations:
            app_mod._ai_conversations[conv_key] = []
        conv = app_mod._ai_conversations[conv_key]

    # Build context info from profile
    context_parts = []
    if profile.get('name'):
        context_parts.append(f"User's name: {profile['name']}")
    if profile.get('interests'):
        context_parts.append(f"Interests: {', '.join(profile['interests'][:10])}")
    if profile.get('personality_traits'):
        context_parts.append(f"Personality: {', '.join(profile['personality_traits'][:5])}")
    if profile.get('memories'):
        recent_memories = profile['memories'][-5:]
        context_parts.append(f"Key memories: {'; '.join(m['text'] for m in recent_memories if isinstance(m, dict) and 'text' in m)}")

    context_info = '\n'.join(context_parts) if context_parts else ''

    system_prompt = app_mod.AI_SYSTEM_PROMPT + f"""

PLATFORM: You are responding via Telegram messenger. Keep formatting Telegram-compatible (use *bold*, _italic_, `code`).
Current date/time: {time.strftime('%Y-%m-%d %H:%M %A')}
{('User context:\n' + context_info) if context_info else ''}
"""

    messages = [{'role': 'system', 'content': system_prompt}]
    # Add last 20 conversation messages for context
    for msg in conv[-20:]:
        messages.append({'role': msg['role'], 'content': msg['content']})
    messages.append({'role': 'user', 'content': text})

    # Call DeepSeek
    reply = app_mod._deepseek_chat(messages, max_tokens=1024, temperature=0.7)

    # Handle action blocks (web search, remember, etc.)
    reply = _process_ai_actions(reply, messages, profile_key, app_mod)

    # Store conversation
    with app_mod._ai_lock:
        conv.append({'role': 'user', 'content': text, 'timestamp': time.time()})
        conv.append({'role': 'assistant', 'content': reply, 'timestamp': time.time()})
        if len(conv) > 60:
            app_mod._ai_conversations[conv_key] = conv[-60:]

    # Update user profile from exchange
    try:
        app_mod._update_user_profile_from_exchange(profile_key, text, reply)
    except Exception:
        pass

    # Save conversation
    try:
        app_mod._save_ai_conversations()
    except Exception:
        pass

    return reply


def _process_ai_actions(reply, messages, profile_key, app_mod):
    """Process JSON action blocks in the AI response (web search, remember, etc.)."""
    import re

    # Check for web search action
    search_match = re.search(r'\{[^}]*"action"\s*:\s*"web_search"[^}]*"query"\s*:\s*"([^"]+)"[^}]*\}', reply, re.DOTALL)
    if not search_match:
        search_match = re.search(r'\{[^}]*"query"\s*:\s*"([^"]+)"[^}]*"action"\s*:\s*"web_search"[^}]*\}', reply, re.DOTALL)

    if search_match:
        query = search_match.group(1)
        print(f"[TELEGRAM] AI requested web search: {query}")
        try:
            search_context = app_mod._web_search_context(query)
            if search_context:
                # Do a second pass with search results
                messages.append({'role': 'assistant', 'content': reply})
                messages.append({'role': 'user', 'content': f'Here are the search results:{search_context}\n\nNow provide a complete answer based on these search results. Do NOT include any JSON action blocks in your response.'})
                reply = app_mod._deepseek_chat(messages, max_tokens=1500, temperature=0.5)
        except Exception as e:
            print(f"[TELEGRAM] Web search error: {e}")

    # Check for remember action
    remember_matches = re.finditer(r'\{[^}]*"action"\s*:\s*"remember"[^}]*\}', reply, re.DOTALL)
    for match in remember_matches:
        try:
            action_data = json.loads(match.group())
            key = action_data.get('key', '')
            value = action_data.get('value', '')
            if key and value:
                profile = app_mod._get_user_profile(profile_key)
                memories = profile.setdefault('memories', [])
                memories.append({'text': f"{key}: {value}", 'timestamp': time.time()})
                if len(memories) > 50:
                    profile['memories'] = memories[-50:]
                app_mod._save_ai_profiles()
                print(f"[TELEGRAM] Remembered: {key} = {value}")
        except Exception:
            pass

    # Clean JSON action blocks from the reply text
    reply = re.sub(r'```json\s*\{[^}]*"action"[^}]*\}\s*```', '', reply)
    reply = re.sub(r'\{[^}]*"action"\s*:\s*"(web_search|remember|create_task|create_reminder)"[^}]*\}', '', reply)
    reply = reply.strip()

    return reply


async def _transcribe_voice_async(audio_bytes, mime_type='audio/ogg'):
    """Transcribe voice message using Groq Whisper API (runs in executor for sync HTTP)."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _transcribe_voice, audio_bytes, mime_type)


def _transcribe_voice(audio_bytes, mime_type='audio/ogg'):
    """Transcribe voice message using Groq Whisper API."""
    import urllib.request
    import urllib.error
    import uuid

    print(f"[TELEGRAM] Transcribing {len(audio_bytes)} bytes of {mime_type}...")

    boundary = uuid.uuid4().hex
    body = b''

    # model field
    body += f'--{boundary}\r\n'.encode()
    body += b'Content-Disposition: form-data; name="model"\r\n\r\n'
    body += b'whisper-large-v3\r\n'

    # language field
    body += f'--{boundary}\r\n'.encode()
    body += b'Content-Disposition: form-data; name="language"\r\n\r\n'
    body += b'en\r\n'

    # temperature field
    body += f'--{boundary}\r\n'.encode()
    body += b'Content-Disposition: form-data; name="temperature"\r\n\r\n'
    body += b'0.0\r\n'

    # prompt field
    body += f'--{boundary}\r\n'.encode()
    body += b'Content-Disposition: form-data; name="prompt"\r\n\r\n'
    body += b'This is a spoken voice message in a conversation with an AI assistant.\r\n'

    # file field
    ext = 'ogg'
    if 'mp3' in mime_type:
        ext = 'mp3'
    elif 'wav' in mime_type:
        ext = 'wav'
    elif 'webm' in mime_type:
        ext = 'webm'

    body += f'--{boundary}\r\n'.encode()
    body += f'Content-Disposition: form-data; name="file"; filename="voice.{ext}"\r\n'.encode()
    body += f'Content-Type: {mime_type}\r\n\r\n'.encode()
    body += audio_bytes
    body += b'\r\n'
    body += f'--{boundary}--\r\n'.encode()

    headers = {
        'Authorization': f'Bearer {GROQ_API_KEY}',
        'Content-Type': f'multipart/form-data; boundary={boundary}',
    }

    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

        req = urllib.request.Request(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            data=body, headers=headers, method='POST'
        )
        with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            text = result.get('text', '').strip()
            print(f"[TELEGRAM] Whisper transcription: '{text[:100]}'")
            return text if text else None
    except Exception as e:
        print(f"[TELEGRAM] Whisper error: {e}")
        traceback.print_exc()
        return None


async def _generate_voice_reply_async(text, voice=None):
    """Generate TTS audio using edge_tts natively in async. Returns (audio_bytes, 'mp3') or (None, None)."""
    if not _edge_tts_available:
        print("[TELEGRAM] edge_tts not available")
        return None, None

    if not text or len(text.strip()) < 2:
        return None, None

    voice = voice or DEFAULT_TTS_VOICE
    clean = text.strip()
    # Limit to ~2000 chars for TTS
    if len(clean) > 2000:
        clean = clean[:2000] + '...'

    try:
        communicate = edge_tts.Communicate(clean, voice, rate='+5%', pitch='+0Hz')
        audio_chunks = []
        async for chunk in communicate.stream():
            if chunk['type'] == 'audio':
                audio_chunks.append(chunk['data'])

        if audio_chunks:
            audio_data = b''.join(audio_chunks)
            print(f"[TELEGRAM] Edge TTS generated {len(audio_data)} bytes (voice={voice})")
            if len(audio_data) > 100:
                return audio_data, 'mp3'
        print("[TELEGRAM] Edge TTS: no audio data")
        return None, None
    except Exception as e:
        print(f"[TELEGRAM] Edge TTS error: {e}")
        traceback.print_exc()
        return None, None


def _generate_voice_reply(text):
    """Sync wrapper — generates TTS. Falls back to None if edge_tts unavailable."""
    # Try using edge_tts via app module (sync)
    try:
        app_mod = _get_app()
        result = app_mod._generate_tts(text)
        if result.get('audio'):
            audio_bytes = base64.b64decode(result['audio'])
            fmt = result.get('format', 'mp3')
            return audio_bytes, fmt
    except Exception as e:
        print(f"[TELEGRAM] TTS fallback error: {e}")
    return None, None


def _analyze_image(image_bytes, mime_type, question="What's in this image? Describe it."):
    """Analyze an image using Qwen Vision."""
    try:
        app_mod = _get_app()
        result = app_mod._deepseek_vision_chat(
            image_bytes, mime_type,
            question=question,
            max_tokens=1500,
            temperature=0.3
        )
        return result
    except Exception as e:
        print(f"[TELEGRAM] Vision error: {e}")
        return "I couldn't analyze this image right now. Please try again."


def _extract_pdf_text(pdf_bytes, password=None):
    """Extract text from a PDF file (handles encoded, encrypted, scanned PDFs).
    Uses PyMuPDF (fitz) which handles most protections and encodings."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return None, 'PyMuPDF not installed'

    try:
        doc = fitz.open(stream=pdf_bytes, filetype='pdf')
    except Exception as e:
        return None, f'Cannot open PDF: {e}'

    # Try to decrypt if encrypted
    if doc.is_encrypted:
        passwords_to_try = [password, '', 'password', '1234', '0000'] if password else ['', 'password', '1234', '0000']
        decrypted = False
        for pw in passwords_to_try:
            if pw is not None:
                try:
                    if doc.authenticate(pw):
                        decrypted = True
                        break
                except Exception:
                    pass
        if not decrypted:
            doc.close()
            return None, 'PDF is password-protected and I couldn\'t unlock it. Send the password along with the file.'

    all_text = []
    total_pages = len(doc)
    max_pages = min(total_pages, 50)  # Limit to 50 pages

    for page_num in range(max_pages):
        page = doc[page_num]
        text = page.get_text('text')  # Standard text extraction
        if text and text.strip():
            all_text.append(f'--- Page {page_num + 1} ---\n{text.strip()}')
        else:
            # Try extracting from blocks (handles some encoded PDFs)
            blocks = page.get_text('blocks')
            block_text = ' '.join(b[4] for b in blocks if len(b) > 4 and isinstance(b[4], str) and b[4].strip())
            if block_text.strip():
                all_text.append(f'--- Page {page_num + 1} ---\n{block_text.strip()}')

    doc.close()

    if not all_text:
        return None, 'PDF appears to be scanned/image-based with no extractable text.'

    combined = '\n\n'.join(all_text)
    # Truncate if too long (Telegram + AI limits)
    if len(combined) > 15000:
        combined = combined[:15000] + f'\n\n... [Truncated — showing first ~{max_pages} pages of {total_pages}]'

    return combined, None


# ──────────────────────────────────────────────────────────────
# Telegram Bot Runner
# ──────────────────────────────────────────────────────────────

def _run_bot_in_thread(token, bot_type='beam', bot_data=None):
    """Run a Telegram bot in a background thread with its own event loop."""

    async def _main():
        from telegram import Update, BotCommand
        from telegram.ext import (
            ApplicationBuilder, CommandHandler, MessageHandler,
            filters, ContextTypes
        )
        from telegram.constants import ParseMode, ChatAction

        print(f"[TELEGRAM] Starting {bot_type} bot...")

        # ── Command handlers ──

        async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
            user = update.effective_user
            welcome = (
                f"Hey {user.first_name}! 👋\n\n"
                f"I'm *BEAM AI* — your personal AI assistant, now on Telegram!\n\n"
                f"💬 Send me any message and I'll respond\n"
                f"🎤 Send a voice message and I'll listen & reply with voice\n"
                f"📸 Send a photo and I'll analyze it\n"
                f"🔍 I can search the web, set reminders, help with coding, and much more\n\n"
                f"Type /help to see all commands.\n"
                f"Type /clear to reset our conversation.\n\n"
                f"Let's go! What can I help you with? 🚀"
            )
            await update.message.reply_text(welcome, parse_mode=ParseMode.MARKDOWN)

        async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
            help_text = (
                "*BEAM AI — Commands*\n\n"
                "/start — Welcome message\n"
                "/clear — Clear conversation history\n"
                "/voice — Toggle voice replies on/off\n"
                "/help — Show this help\n\n"
                "*What I can do:*\n"
                "• Answer questions on any topic\n"
                "• Search the web for live info\n"
                "• Analyze photos & documents\n"
                "• Help with coding & debugging\n"
                "• Creative writing & brainstorming\n"
                "• Math, science, study help\n"
                "• And much more — just ask!\n\n"
                "_Send me a text, voice, or photo to get started._"
            )
            await update.message.reply_text(help_text, parse_mode=ParseMode.MARKDOWN)

        async def cmd_clear(update: Update, context: ContextTypes.DEFAULT_TYPE):
            user_id = update.effective_user.id
            conv_key = f'tg_{user_id}'
            try:
                app_mod = _get_app()
                with app_mod._ai_lock:
                    if conv_key in app_mod._ai_conversations:
                        app_mod._ai_conversations[conv_key] = []
                app_mod._save_ai_conversations()
            except Exception:
                pass
            await update.message.reply_text("🧹 Conversation cleared! Fresh start.")

        async def cmd_voice(update: Update, context: ContextTypes.DEFAULT_TYPE):
            user_id = update.effective_user.id
            key = f'voice_{user_id}'
            current = context.bot_data.get(key, False)  # Default OFF — voice only for voice input
            context.bot_data[key] = not current
            if context.bot_data[key]:
                await update.message.reply_text("🔊 Voice replies *enabled* for text messages too. I'll send voice with every response.", parse_mode=ParseMode.MARKDOWN)
            else:
                await update.message.reply_text("🔇 Voice replies for text *disabled*. I'll only reply with voice when you send me a voice message.", parse_mode=ParseMode.MARKDOWN)

        # ── Message handlers ──

        async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
            """Handle text messages — get AI response + optional voice."""
            if not update.message or not update.message.text:
                return
            user_id = update.effective_user.id
            text = update.message.text.strip()
            if not text:
                return

            # Show typing indicator
            await update.message.chat.send_action(ChatAction.TYPING)

            # Get AI response (runs sync function in executor)
            loop = asyncio.get_event_loop()
            try:
                reply = await loop.run_in_executor(None, _ai_chat, user_id, text)
            except Exception as e:
                print(f"[TELEGRAM] AI error: {e}")
                traceback.print_exc()
                reply = "I'm having trouble thinking right now. Please try again in a moment. 🤔"

            # Send text reply — try Markdown first, fall back to plain text
            try:
                await update.message.reply_text(reply, parse_mode=ParseMode.MARKDOWN)
            except Exception:
                try:
                    await update.message.reply_text(reply)
                except Exception as e:
                    print(f"[TELEGRAM] Send error: {e}")
                    await update.message.reply_text("Sorry, I encountered an error sending my response.")

            # Only send voice reply for text if user explicitly toggled it ON (default: OFF)
            voice_enabled = context.bot_data.get(f'voice_{user_id}', False)
            if voice_enabled:
                await _send_voice_reply_async(update, reply)

        async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE):
            """Handle voice/audio messages — transcribe, get AI response, reply with voice."""
            if not update.message:
                return
            user_id = update.effective_user.id

            # Support both voice and audio messages
            voice_obj = update.message.voice or update.message.audio
            if not voice_obj:
                return

            await update.message.chat.send_action(ChatAction.TYPING)

            # Download voice file
            try:
                voice_file = await voice_obj.get_file()
                voice_bytes = await voice_file.download_as_bytearray()
                print(f"[TELEGRAM] Downloaded voice: {len(voice_bytes)} bytes")
            except Exception as e:
                print(f"[TELEGRAM] Voice download error: {e}")
                traceback.print_exc()
                await update.message.reply_text("Couldn't download your voice message. Try again?")
                return

            # Transcribe with Groq Whisper
            mime = getattr(voice_obj, 'mime_type', None) or 'audio/ogg'
            transcription = await _transcribe_voice_async(bytes(voice_bytes), mime)

            if not transcription:
                await update.message.reply_text("I couldn't understand that voice message. Could you try again or type it out? 🎤")
                return

            # Show what we heard
            try:
                await update.message.reply_text(f"🎤 _\"{transcription}\"_", parse_mode=ParseMode.MARKDOWN)
            except Exception:
                await update.message.reply_text(f"🎤 \"{transcription}\"")
            await update.message.chat.send_action(ChatAction.TYPING)

            # Get AI response
            loop = asyncio.get_event_loop()
            try:
                reply = await loop.run_in_executor(None, _ai_chat, user_id, transcription)
            except Exception as e:
                print(f"[TELEGRAM] AI error: {e}")
                reply = "I'm having trouble processing that. Could you try again?"

            # Send text reply
            try:
                await update.message.reply_text(reply, parse_mode=ParseMode.MARKDOWN)
            except Exception:
                try:
                    await update.message.reply_text(reply)
                except Exception:
                    pass

            # Always send voice reply for voice messages
            await _send_voice_reply_async(update, reply)

        async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
            """Handle photo messages — analyze with vision AI."""
            if not update.message or not update.message.photo:
                return
            user_id = update.effective_user.id

            await update.message.chat.send_action(ChatAction.TYPING)

            # Get the largest photo
            photo = update.message.photo[-1]  # Largest size
            try:
                photo_file = await photo.get_file()
                photo_bytes = await photo_file.download_as_bytearray()
            except Exception as e:
                print(f"[TELEGRAM] Photo download error: {e}")
                await update.message.reply_text("Couldn't download the photo. Try again?")
                return

            # Get caption as question if provided
            question = update.message.caption or "Describe this image in detail. What do you see?"

            # Analyze image
            loop = asyncio.get_event_loop()
            try:
                analysis = await loop.run_in_executor(
                    None, _analyze_image, bytes(photo_bytes), 'image/jpeg', question
                )
            except Exception as e:
                print(f"[TELEGRAM] Vision error: {e}")
                analysis = "I couldn't analyze this image right now. Please try again."

            # Store in conversation
            try:
                app_mod = _get_app()
                conv_key = f'tg_{user_id}'
                with app_mod._ai_lock:
                    if conv_key not in app_mod._ai_conversations:
                        app_mod._ai_conversations[conv_key] = []
                    conv = app_mod._ai_conversations[conv_key]
                    conv.append({'role': 'user', 'content': f'[Sent a photo] {question}', 'timestamp': time.time()})
                    conv.append({'role': 'assistant', 'content': analysis, 'timestamp': time.time()})
                    if len(conv) > 60:
                        app_mod._ai_conversations[conv_key] = conv[-60:]
                app_mod._save_ai_conversations()
            except Exception:
                pass

            try:
                await update.message.reply_text(analysis, parse_mode=ParseMode.MARKDOWN)
            except Exception:
                await update.message.reply_text(analysis)

        async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE):
            """Handle document uploads — images, PDFs, and other files."""
            if not update.message or not update.message.document:
                return

            user_id = update.effective_user.id
            doc = update.message.document
            mime = doc.mime_type or ''
            fname = doc.file_name or 'unknown'

            # ── Images ──
            if mime.startswith('image/'):
                await update.message.chat.send_action(ChatAction.TYPING)
                try:
                    doc_file = await doc.get_file()
                    doc_bytes = await doc_file.download_as_bytearray()
                    question = update.message.caption or "Describe this image in detail."
                    loop = asyncio.get_event_loop()
                    analysis = await loop.run_in_executor(
                        None, _analyze_image, bytes(doc_bytes), mime, question
                    )
                    try:
                        await update.message.reply_text(analysis, parse_mode=ParseMode.MARKDOWN)
                    except Exception:
                        await update.message.reply_text(analysis)
                except Exception as e:
                    print(f"[TELEGRAM] Document analysis error: {e}")
                    await update.message.reply_text("I couldn't analyze this file.")
                return

            # ── PDFs ──
            if mime == 'application/pdf' or fname.lower().endswith('.pdf'):
                await update.message.chat.send_action(ChatAction.TYPING)
                await update.message.reply_text(f"📄 Reading *{fname}*...", parse_mode=ParseMode.MARKDOWN)

                try:
                    doc_file = await doc.get_file()
                    doc_bytes = await doc_file.download_as_bytearray()
                    print(f"[TELEGRAM] PDF received: {fname}, {len(doc_bytes)} bytes")
                except Exception as e:
                    print(f"[TELEGRAM] PDF download error: {e}")
                    await update.message.reply_text("Couldn't download the PDF. Try again?")
                    return

                # Extract text (supports encrypted/encoded PDFs)
                password = None
                caption = update.message.caption or ''
                # Check if user provided a password in the caption
                pw_match = _re.search(r'(?:password|pw|pass)[:\s]+(.+)', caption, _re.IGNORECASE)
                if pw_match:
                    password = pw_match.group(1).strip()

                loop = asyncio.get_event_loop()
                pdf_text, pdf_error = await loop.run_in_executor(
                    None, _extract_pdf_text, bytes(doc_bytes), password
                )

                if pdf_error:
                    await update.message.reply_text(f"⚠️ {pdf_error}")
                    return

                if not pdf_text or len(pdf_text.strip()) < 10:
                    await update.message.reply_text("The PDF appears to be empty or contains no readable text.")
                    return

                # If user asked a specific question in caption, answer it about the PDF
                user_question = caption.strip()
                # Remove password part from question
                if pw_match:
                    user_question = caption[:pw_match.start()].strip()

                if user_question and len(user_question) > 3:
                    prompt = f"""The user sent a PDF file named "{fname}". Here is the extracted text from the PDF:

---BEGIN PDF TEXT---
{pdf_text}
---END PDF TEXT---

The user's question about this PDF: {user_question}

Answer the question based on the PDF content."""
                else:
                    prompt = f"""The user sent a PDF file named "{fname}". Here is the extracted text from the PDF:

---BEGIN PDF TEXT---
{pdf_text}
---END PDF TEXT---

Provide a clear, helpful summary of this document. Highlight the key points, main topics, and any important details."""

                await update.message.chat.send_action(ChatAction.TYPING)

                try:
                    reply = await loop.run_in_executor(None, _ai_chat, user_id, prompt)
                except Exception as e:
                    print(f"[TELEGRAM] AI error on PDF: {e}")
                    # Fall back to just showing extracted text
                    reply = f"📄 *{fname}* — Extracted text:\n\n{pdf_text[:3000]}"

                # Store PDF context in conversation
                try:
                    app_mod = _get_app()
                    conv_key = f'tg_{user_id}'
                    with app_mod._ai_lock:
                        if conv_key not in app_mod._ai_conversations:
                            app_mod._ai_conversations[conv_key] = []
                        conv = app_mod._ai_conversations[conv_key]
                        conv.append({'role': 'user', 'content': f'[Sent PDF: {fname}] {user_question or "Summarize this document"}', 'timestamp': time.time()})
                        conv.append({'role': 'assistant', 'content': reply, 'timestamp': time.time()})
                        if len(conv) > 60:
                            app_mod._ai_conversations[conv_key] = conv[-60:]
                    app_mod._save_ai_conversations()
                except Exception:
                    pass

                try:
                    await update.message.reply_text(reply, parse_mode=ParseMode.MARKDOWN)
                except Exception:
                    try:
                        await update.message.reply_text(reply)
                    except Exception:
                        # If reply is too long, split it
                        for i in range(0, len(reply), 4000):
                            chunk = reply[i:i+4000]
                            await update.message.reply_text(chunk)
                return

            # ── Other files ──
            await update.message.reply_text(
                f"I received your file (*{fname}*).\n\n"
                "I can currently handle:\n"
                "📸 Images — send as photo or document\n"
                "📄 PDFs — I'll read and summarize them\n\n"
                "_For other file types, try uploading to LocalBeam directly._",
                parse_mode=ParseMode.MARKDOWN
            )

        async def _send_voice_reply_async(update, text):
            """Generate and send TTS voice reply using native async edge_tts."""
            try:
                await update.message.chat.send_action(ChatAction.RECORD_VOICE)

                # Use native async edge_tts (best approach — no executor needed)
                audio_bytes, fmt = await _generate_voice_reply_async(text)

                if audio_bytes and len(audio_bytes) > 100:
                    print(f"[TELEGRAM] Sending voice reply: {len(audio_bytes)} bytes")
                    # Send as voice note directly from memory
                    voice_io = io.BytesIO(audio_bytes)
                    voice_io.name = f'reply.{fmt}'  # telegram needs a filename
                    await update.message.reply_voice(voice=voice_io)
                    print(f"[TELEGRAM] Voice reply sent!")
                else:
                    print(f"[TELEGRAM] No audio generated for voice reply")
            except Exception as e:
                print(f"[TELEGRAM] Voice reply error: {e}")
                traceback.print_exc()

        # ── Error handler ──
        async def error_handler(update, context: ContextTypes.DEFAULT_TYPE):
            print(f"[TELEGRAM] Error: {context.error}")
            traceback.print_exc()

        # ── Build and start the application ──
        app_bot = ApplicationBuilder().token(token).build()

        # Register commands
        app_bot.add_handler(CommandHandler("start", cmd_start))
        app_bot.add_handler(CommandHandler("help", cmd_help))
        app_bot.add_handler(CommandHandler("clear", cmd_clear))
        app_bot.add_handler(CommandHandler("voice", cmd_voice))

        # Register message handlers
        app_bot.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
        app_bot.add_handler(MessageHandler(filters.VOICE | filters.AUDIO, handle_voice))
        app_bot.add_handler(MessageHandler(filters.PHOTO, handle_photo))
        app_bot.add_handler(MessageHandler(filters.Document.ALL, handle_document))

        app_bot.add_error_handler(error_handler)

        # Set bot commands menu
        try:
            await app_bot.bot.set_my_commands([
                BotCommand("start", "Start conversation"),
                BotCommand("help", "Show help"),
                BotCommand("clear", "Clear conversation history"),
                BotCommand("voice", "Toggle voice replies"),
            ])
        except Exception as e:
            print(f"[TELEGRAM] Could not set commands: {e}")

        bot_info = await app_bot.bot.get_me()
        print(f"[TELEGRAM] ✅ Bot started: @{bot_info.username} ({bot_info.first_name})")
        print(f"[TELEGRAM] Send /start to @{bot_info.username} on Telegram to begin chatting with BEAM AI!")

        # Store reference for stopping
        _active_bots[token] = {
            'app': app_bot,
            'username': bot_info.username,
            'type': bot_type,
        }

        # Run polling (works from any server, no public URL needed)
        await app_bot.initialize()
        await app_bot.start()
        await app_bot.updater.start_polling(
            drop_pending_updates=True,
            allowed_updates=["message", "callback_query"],
        )

        # Keep running until stopped
        stop_event = asyncio.Event()
        _active_bots[token]['stop_event'] = stop_event
        _active_bots[token]['loop'] = asyncio.get_event_loop()
        await stop_event.wait()

        # Cleanup
        print(f"[TELEGRAM] Stopping bot @{bot_info.username}...")
        await app_bot.updater.stop()
        await app_bot.stop()
        await app_bot.shutdown()
        print(f"[TELEGRAM] Bot @{bot_info.username} stopped.")

    def _thread_target():
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(_main())
        except Exception as e:
            print(f"[TELEGRAM] Bot thread error: {e}")
            traceback.print_exc()
        finally:
            if token in _active_bots:
                del _active_bots[token]

    thread = threading.Thread(target=_thread_target, daemon=True, name=f'telegram-{bot_type}')
    thread.start()
    return thread


def start_beam_bot(token=None):
    """Start the main BEAM AI Telegram bot."""
    if not token:
        token = _get_beam_token()
    if not token:
        print("[TELEGRAM] No BEAM bot token configured. Set one via /api/telegram/config")
        return False

    if token in _active_bots:
        print("[TELEGRAM] BEAM bot already running")
        return True

    print(f"[TELEGRAM] Starting BEAM AI bot...")
    _run_bot_in_thread(token, bot_type='beam')
    return True


def stop_bot(token):
    """Stop a running Telegram bot."""
    bot_info = _active_bots.get(token)
    if not bot_info:
        return False

    stop_event = bot_info.get('stop_event')
    loop = bot_info.get('loop')
    if stop_event and loop:
        loop.call_soon_threadsafe(stop_event.set)
        return True
    return False


def stop_all():
    """Stop all running Telegram bots."""
    tokens = list(_active_bots.keys())
    for token in tokens:
        stop_bot(token)


def auto_start():
    """Auto-start configured Telegram bots. Called on server startup."""
    config = _load_config()
    beam_token = config.get('beam_token', '')
    if beam_token:
        print(f"[TELEGRAM] Auto-starting BEAM AI bot...")
        start_beam_bot(beam_token)
    else:
        print("[TELEGRAM] No Telegram bot configured. To enable:")
        print("[TELEGRAM]   1. Create a bot via @BotFather on Telegram")
        print("[TELEGRAM]   2. POST the token to /api/telegram/config")
        print("[TELEGRAM]   3. Or add it to telegram_config.json")


# ──────────────────────────────────────────────────────────────
# Flask route registration — call from app.py
# ──────────────────────────────────────────────────────────────

def register_routes(app):
    """Register Telegram-related API routes on the Flask app."""

    @app.route('/api/telegram/config', methods=['GET'])
    def telegram_config_get():
        config = _load_config()
        beam_token = config.get('beam_token', '')
        return json.dumps({
            'configured': bool(beam_token),
            'token_preview': f"{beam_token[:8]}...{beam_token[-4:]}" if len(beam_token) > 12 else '',
            'status': get_status(),
        }), 200, {'Content-Type': 'application/json'}

    @app.route('/api/telegram/config', methods=['POST'])
    def telegram_config_set():
        from flask import request, jsonify
        data = request.json or {}
        token = data.get('token', '').strip()

        if not token:
            return jsonify({'error': 'token required'}), 400

        # Basic validation
        if ':' not in token or len(token) < 30:
            return jsonify({'error': 'Invalid Telegram bot token format. Get one from @BotFather.'}), 400

        set_beam_token(token)
        return jsonify({
            'success': True,
            'message': 'Telegram bot token saved and bot is starting...',
            'status': get_status(),
        })

    @app.route('/api/telegram/config', methods=['DELETE'])
    def telegram_config_delete():
        config = _load_config()
        old_token = config.get('beam_token', '')
        if old_token and old_token in _active_bots:
            stop_bot(old_token)
        config['beam_token'] = ''
        _save_config(config)
        return json.dumps({'success': True, 'message': 'Telegram bot stopped and token removed.'}), 200, {'Content-Type': 'application/json'}

    @app.route('/api/telegram/status', methods=['GET'])
    def telegram_status():
        status = get_status()
        bots_info = []
        for token, info in _active_bots.items():
            bots_info.append({
                'username': info.get('username', ''),
                'type': info.get('type', 'unknown'),
                'running': True,
            })
        status['bots'] = bots_info
        return json.dumps(status), 200, {'Content-Type': 'application/json'}

    @app.route('/api/telegram/restart', methods=['POST'])
    def telegram_restart():
        config = _load_config()
        beam_token = config.get('beam_token', '')
        if not beam_token:
            return json.dumps({'error': 'No bot token configured'}), 400, {'Content-Type': 'application/json'}

        # Stop if running
        if beam_token in _active_bots:
            stop_bot(beam_token)
            time.sleep(2)

        # Restart
        start_beam_bot(beam_token)
        return json.dumps({'success': True, 'message': 'Bot restarting...'}), 200, {'Content-Type': 'application/json'}

    print("[TELEGRAM] API routes registered: /api/telegram/config, /api/telegram/status, /api/telegram/restart")
