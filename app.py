#!/usr/bin/env python3
"""
Wireless File Transfer App - Xender-like file sharing between laptop and Android
Scan QR code with phone to connect and transfer files blazing fast
"""

import os
import sys
import socket
import socketserver
import socket as _socket
import mimetypes
import subprocess
import threading
import time
import json
import shutil
import uuid
import ssl
import tempfile
import struct
import ipaddress
from urllib.parse import unquote
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory, Response
from flask_cors import CORS
import qrcode
from io import BytesIO
import base64
import netifaces
import pyperclip
import webbrowser
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# ─── Live transfer tracking ──────────────────────────────────────
_xfer_lock = threading.Lock()
live_transfers = {}   # id -> {id, name, size, sent, status, client_ip, started}

def _xfer_start(name, size, client_ip):
    tid = str(uuid.uuid4())[:8]
    with _xfer_lock:
        live_transfers[tid] = {
            'id': tid, 'name': name, 'size': size,
            'sent': 0, 'status': 'active',
            'client_ip': client_ip,
            'started': time.time()
        }
    return tid

def _xfer_update(tid, sent):
    with _xfer_lock:
        if tid in live_transfers:
            live_transfers[tid]['sent'] = sent

def _xfer_done(tid):
    with _xfer_lock:
        if tid in live_transfers:
            live_transfers[tid]['status'] = 'done'
            live_transfers[tid]['sent'] = live_transfers[tid]['size']
            # Keep last 20 completed transfers; prune older ones
            done = [(k,v) for k,v in live_transfers.items() if v['status']=='done']
            done.sort(key=lambda x: x[1]['started'])
            for k, _ in done[:-20]:
                del live_transfers[k]

def _xfer_is_paused(tid):
    with _xfer_lock:
        return live_transfers.get(tid, {}).get('status') == 'paused'

import hashlib

# ─── Phone-to-Phone shared space ─────────────────────────────────
import tempfile as _tempfile

_p2p_lock = threading.Lock()
_p2p_devices = {}     # device_id -> {id, name, ip, user_agent, last_seen}
_p2p_files   = {}     # file_id  -> {id, name, size, sender_id, sender_name, ts, path}
_p2p_requests = {}    # request_id -> {id, file_id, name, size, sender_id, sender_name, recipient_id, status, created}
_p2p_typing  = {}     # device_id -> {recipient_id, timestamp}
_p2p_dir     = os.path.join(_tempfile.gettempdir(), 'localbeam_p2p')
os.makedirs(_p2p_dir, exist_ok=True)

# ─── User Accounts & Friends ────────────────────────────────────
_users_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'users.json')
_friend_requests_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'friend_requests.json')
_sessions_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sessions.json')
_auth_lock = threading.Lock()
_users = {}        # user_id -> {id, name, email, phone, password_hash, friends: [user_id, ...], device_id, created}
_sessions = {}     # token -> user_id
_friend_requests = {}  # request_id -> {id, from_id, to_id, status: 'pending'|'accepted'|'rejected', created}

def _load_users():
    global _users, _friend_requests, _sessions
    try:
        if os.path.exists(_users_file):
            with open(_users_file, 'r') as f:
                _users = json.load(f)
    except:
        _users = {}
    try:
        if os.path.exists(_friend_requests_file):
            with open(_friend_requests_file, 'r') as f:
                _friend_requests = json.load(f)
    except:
        _friend_requests = {}
    try:
        if os.path.exists(_sessions_file):
            with open(_sessions_file, 'r') as f:
                _sessions = json.load(f)
    except:
        _sessions = {}

def _save_users():
    try:
        with open(_users_file, 'w') as f:
            json.dump(_users, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save users: {e}")

def _save_friend_requests():
    try:
        with open(_friend_requests_file, 'w') as f:
            json.dump(_friend_requests, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save friend requests: {e}")

def _save_sessions():
    try:
        with open(_sessions_file, 'w') as f:
            json.dump(_sessions, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save sessions: {e}")

_load_users()

# ─── Calls (WebRTC Signaling) ────────────────────────────────────
_calls_lock = threading.Lock()
_calls = {}           # call_id -> {id, type:'audio'|'video', initiator_id, participants:{device_id: {status,joined_at}}, created, ended, group_id?}
_call_signals = {}    # device_id -> [{from_id, type:'offer'|'answer'|'ice-candidate'|'call-invite'|'call-end', payload, ts}]
_video_relay = {}     # call_id -> {device_id: {'data': bytes, 'ts': float}}
_audio_relay = {}     # call_id -> {device_id: deque of {'data': bytes, 'seq': int, 'ts': float}}
_audio_relay_seq = {} # call_id -> {device_id: int}  next sequence number

# ─── Groups ──────────────────────────────────────────────────────
_groups_lock = threading.Lock()
_groups = {}          # group_id -> {id, name, avatar, creator_id, admins:[], members:[], created, description}
_group_messages = {}  # msg_id -> {id, group_id, sender_id, sender_name, text, media_data, media_type, file_name, timestamp, edited, reactions:{}, reply_to_data}
_groups_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'groups.json')

def _load_groups():
    global _groups
    try:
        if os.path.exists(_groups_file):
            with open(_groups_file, 'r') as f:
                _groups = json.load(f)
    except:
        _groups = {}

def _save_groups():
    try:
        with open(_groups_file, 'w') as f:
            json.dump(_groups, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save groups: {e}")

_load_groups()

# ─── Bots & Auto-Callback ────────────────────────────────────────
_bots_lock = threading.Lock()
_bots = {}            # bot_id -> {id, name, owner_id, avatar, description, commands, auto_reply, callback_enabled, callback_message, role, personality_traits, duties, escalation_targets, tone, telegram_token, telegram_chat_ids, channels, created}
_bot_callbacks = {}   # callback_id -> {id, bot_id, target_device_id, scheduled_at, message, status:'pending'|'sent', created}
_bots_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bots.json')

# ─── AI Assistant (DeepSeek + Qwen Vision) ─────────────────────────────────────
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')
DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions'
QWEN_API_KEY = os.environ.get('QWEN_API_KEY', '')
QWEN_VISION_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'

_ai_lock = threading.Lock()
_ai_tasks = {}        # task_id -> {id, owner_id, title, description, due_date, due_time, category, priority, status, created, completed_at}
_ai_reminders = {}    # reminder_id -> {id, owner_id, text, remind_at, repeat, status, created}
_ai_conversations = {}  # owner_id -> [{role, content, timestamp}]  (last N messages for context)
_ai_delegation = {}   # owner_id -> {enabled: bool, auto_reply_to: [device_ids], style: str, rules: str}
_ai_user_profiles = {}  # owner_id -> {name, preferences, personality_traits, likes, dislikes, topics, style, memories, interaction_count, ...}
_ai_tasks_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ai_tasks.json')
_ai_reminders_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ai_reminders.json')
_ai_delegation_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ai_delegation.json')
_ai_conversations_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ai_conversations.json')
_ai_profiles_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ai_profiles.json')

def _load_ai_data():
    global _ai_tasks, _ai_reminders, _ai_delegation, _ai_conversations, _ai_user_profiles
    for path, target in [
        (_ai_tasks_file, '_ai_tasks'),
        (_ai_reminders_file, '_ai_reminders'),
        (_ai_delegation_file, '_ai_delegation'),
        (_ai_conversations_file, '_ai_conversations'),
        (_ai_profiles_file, '_ai_user_profiles'),
    ]:
        try:
            if os.path.exists(path):
                with open(path, 'r') as f:
                    globals()[target] = json.load(f)
        except:
            globals()[target] = {}

def _save_ai_tasks():
    try:
        with open(_ai_tasks_file, 'w') as f:
            json.dump(_ai_tasks, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save AI tasks: {e}")

def _save_ai_reminders():
    try:
        with open(_ai_reminders_file, 'w') as f:
            json.dump(_ai_reminders, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save AI reminders: {e}")

def _save_ai_delegation():
    try:
        with open(_ai_delegation_file, 'w') as f:
            json.dump(_ai_delegation, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save AI delegation: {e}")

def _save_ai_conversations():
    try:
        with open(_ai_conversations_file, 'w') as f:
            json.dump(_ai_conversations, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save AI conversations: {e}")

def _save_ai_profiles():
    try:
        with open(_ai_profiles_file, 'w') as f:
            json.dump(_ai_user_profiles, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save AI profiles: {e}")

def _get_user_profile(owner_id):
    """Get or create a user profile for adaptive learning."""
    with _ai_lock:
        if owner_id not in _ai_user_profiles:
            _ai_user_profiles[owner_id] = {
                'name': '',
                'personality_traits': [],
                'communication_style': 'unknown',
                'interests': [],
                'likes': [],
                'dislikes': [],
                'frequent_topics': {},
                'preferred_response_length': 'medium',
                'preferred_tone': 'friendly',
                'memories': [],
                'key_facts': [],
                'interaction_count': 0,
                'first_seen': time.time(),
                'last_seen': time.time(),
                'avg_msg_length': 0,
                'uses_emojis': False,
                'formality_level': 'casual',
                'expertise_areas': [],
                'language_preference': 'en',
            }
        return _ai_user_profiles[owner_id]

def _update_user_profile_from_exchange(owner_id, user_msg, ai_reply):
    """Analyze conversation to learn about the user over time."""
    profile = _get_user_profile(owner_id)
    profile['interaction_count'] = profile.get('interaction_count', 0) + 1
    profile['last_seen'] = time.time()

    # Track message length preference
    msg_len = len(user_msg.split())
    old_avg = profile.get('avg_msg_length', 0)
    count = profile['interaction_count']
    profile['avg_msg_length'] = round(((old_avg * (count - 1)) + msg_len) / count, 1)

    # Detect emoji usage
    import re as _re
    if _re.search(r'[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF\U00002702-\U000027B0]', user_msg):
        profile['uses_emojis'] = True

    # Detect formality
    informal_markers = ['lol', 'bruh', 'nah', 'yeah', 'gonna', 'wanna', 'gotta', 'haha', 'omg', 'btw', 'tbh', 'idk', 'ngl']
    formal_markers = ['please', 'would you', 'could you', 'kindly', 'appreciate', 'regarding', 'furthermore']
    lower_msg = user_msg.lower()
    informal_count = sum(1 for m in informal_markers if m in lower_msg)
    formal_count = sum(1 for m in formal_markers if m in lower_msg)
    if informal_count > formal_count:
        profile['formality_level'] = 'casual'
    elif formal_count > informal_count:
        profile['formality_level'] = 'formal'

    # Track frequent topics (simple keyword extraction)
    topic_keywords = {
        'coding': ['code', 'programming', 'python', 'javascript', 'flutter', 'api', 'function', 'debug', 'error', 'bug', 'app', 'software', 'developer'],
        'music': ['music', 'song', 'album', 'artist', 'playlist', 'spotify', 'beat', 'melody'],
        'science': ['science', 'physics', 'chemistry', 'biology', 'experiment', 'theory', 'atom', 'molecule'],
        'sports': ['football', 'soccer', 'basketball', 'cricket', 'tennis', 'match', 'game', 'score', 'team', 'player'],
        'health': ['health', 'fitness', 'exercise', 'diet', 'workout', 'sleep', 'calories', 'gym'],
        'business': ['business', 'startup', 'revenue', 'profit', 'market', 'investment', 'stock', 'company'],
        'education': ['study', 'exam', 'homework', 'university', 'college', 'school', 'learn', 'course', 'lecture'],
        'entertainment': ['movie', 'film', 'tv', 'series', 'netflix', 'anime', 'manga', 'game', 'gaming'],
        'travel': ['travel', 'flight', 'hotel', 'vacation', 'trip', 'destination', 'airport'],
        'food': ['food', 'recipe', 'cooking', 'restaurant', 'meal', 'dinner', 'lunch', 'breakfast'],
        'technology': ['ai', 'machine learning', 'blockchain', 'crypto', 'robot', 'space', 'nasa', 'tech'],
    }
    for topic, keywords in topic_keywords.items():
        if any(kw in lower_msg for kw in keywords):
            profile['frequent_topics'][topic] = profile.get('frequent_topics', {}).get(topic, 0) + 1
            if topic not in profile.get('interests', []):
                if profile.get('frequent_topics', {}).get(topic, 0) >= 3:
                    profile.setdefault('interests', []).append(topic)

    # Detect response length preference
    if msg_len < 10:
        profile['preferred_response_length'] = 'concise'
    elif msg_len > 50:
        profile['preferred_response_length'] = 'detailed'

    # Use DeepSeek to extract deeper insights every 10 interactions
    if profile['interaction_count'] % 10 == 0 and profile['interaction_count'] > 0:
        try:
            analysis_msgs = [
                {'role': 'system', 'content': 'You are analyzing a user\'s conversation patterns. Extract personality traits, interests, communication style in a concise JSON. Return ONLY valid JSON, no other text.'},
                {'role': 'user', 'content': f'Analyze this user exchange. User said: "{user_msg[:500]}". Previous interests: {profile.get("interests", [])}. Frequent topics: {profile.get("frequent_topics", {})}. Return JSON with keys: personality_traits (list of 3-5 adjectives), communication_style (one word), new_interests (list), key_observation (one sentence about this user).'}
            ]
            analysis = _deepseek_chat(analysis_msgs, max_tokens=300, temperature=0.3)
            try:
                import re as _re2
                json_match = _re2.search(r'\{.*\}', analysis, _re2.DOTALL)
                if json_match:
                    insights = json.loads(json_match.group())
                    if insights.get('personality_traits'):
                        profile['personality_traits'] = insights['personality_traits'][:5]
                    if insights.get('communication_style'):
                        profile['communication_style'] = insights['communication_style']
                    for interest in insights.get('new_interests', []):
                        if interest not in profile.get('interests', []):
                            profile.setdefault('interests', []).append(interest)
                    if insights.get('key_observation'):
                        memories = profile.setdefault('memories', [])
                        memories.append({'text': insights['key_observation'], 'timestamp': time.time()})
                        if len(memories) > 50:
                            profile['memories'] = memories[-50:]
            except:
                pass
        except:
            pass

    _save_ai_profiles()

_load_ai_data()


# ─── Live Web Search (DuckDuckGo Instant Answer + HTML scrape) ─────
def _web_search(query, num_results=5):
    """Search the web using DuckDuckGo. Returns list of {title, snippet, url}."""
    import urllib.request
    import urllib.error
    import urllib.parse
    import re as _re

    results = []
    try:
        # DuckDuckGo HTML lite search (no API key needed)
        encoded_q = urllib.parse.quote_plus(query)
        url = f'https://html.duckduckgo.com/html/?q={encoded_q}'
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode('utf-8', errors='ignore')

        # Parse results from DuckDuckGo HTML
        # Each result is in a div with class "result"
        result_blocks = _re.findall(r'<a rel="nofollow" class="result__a" href="(.*?)">(.*?)</a>.*?<a class="result__snippet".*?>(.*?)</a>', html, _re.DOTALL)
        for href, title, snippet in result_blocks[:num_results]:
            # Clean HTML tags from title and snippet
            clean_title = _re.sub(r'<.*?>', '', title).strip()
            clean_snippet = _re.sub(r'<.*?>', '', snippet).strip()
            # DuckDuckGo redirects through their URL — extract actual URL
            actual_url = href
            if 'uddg=' in href:
                url_match = _re.search(r'uddg=([^&]+)', href)
                if url_match:
                    actual_url = urllib.parse.unquote(url_match.group(1))
            results.append({
                'title': clean_title,
                'snippet': clean_snippet,
                'url': actual_url
            })
    except Exception as e:
        print(f"Web search error: {e}")

    return results


def _web_search_context(query):
    """Perform a web search and format results as context for the AI."""
    results = _web_search(query)
    if not results:
        return ""
    context = f"\n\n[WEB SEARCH RESULTS for '{query}']:\n"
    for i, r in enumerate(results, 1):
        context += f"{i}. **{r['title']}**\n   {r['snippet']}\n   Source: {r['url']}\n"
    context += "\nUse these search results to provide an accurate, up-to-date answer. Cite sources when relevant."
    return context


def _qwen_vision(image_bytes, mime_type, question="Describe this image in detail.", system_prompt=None, max_tokens=2048, temperature=0.3):
    """Call Qwen VL (Vision-Language) API — excellent image/document understanding via DashScope."""
    import base64, urllib.request, urllib.error, ssl
    b64 = base64.b64encode(image_bytes).decode('ascii')
    data_url = f"data:{mime_type};base64,{b64}"

    # Build messages in OpenAI-compatible format
    user_content = [
        {"type": "image_url", "image_url": {"url": data_url}},
        {"type": "text", "text": question}
    ]
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_content})

    payload = json.dumps({
        "model": "qwen-vl-max",
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False
    }).encode('utf-8')

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {QWEN_API_KEY}"
    }

    print(f"[BEAM-AI-VISION] Sending to Qwen VL: {len(image_bytes)} bytes ({mime_type}), question={question[:80]!r}", flush=True)

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    last_error = None
    for attempt in range(1, 3):
        try:
            req = urllib.request.Request(QWEN_VISION_URL, data=payload, headers=headers, method='POST')
            with urllib.request.urlopen(req, timeout=90, context=ctx) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                reply = result['choices'][0]['message']['content']
                print(f"[BEAM-AI-VISION] Qwen VL replied OK ({len(reply)} chars)", flush=True)
                return reply
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', errors='replace')
            last_error = f"HTTP {e.code}: {body[:300]}"
            print(f"[BEAM-AI-VISION] Qwen VL error {e.code} (attempt {attempt}): {body[:500]}", flush=True)
            if 400 <= e.code < 500 and e.code != 429:
                return f"Vision analysis failed (Error {e.code}). Please try again."
        except Exception as e:
            last_error = f"{type(e).__name__}: {e}"
            print(f"[BEAM-AI-VISION] Qwen VL exception (attempt {attempt}): {last_error}", flush=True)
        if attempt < 2:
            time.sleep(2)

    print(f"[BEAM-AI-VISION] Qwen VL FAILED after retries. Last error: {last_error}", flush=True)
    return "I couldn't analyze this image right now. Please try again in a moment."


def _deepseek_vision_chat(image_bytes, mime_type, question="Describe this image in detail.", system_prompt=None, max_tokens=1500, temperature=0.3):
    """Vision analysis — uses Qwen VL for vision, falls back to DeepSeek text analysis."""
    # Try Qwen vision first
    result = _qwen_vision(image_bytes, mime_type, question=question, system_prompt=system_prompt, max_tokens=max_tokens, temperature=temperature)
    
    # If Qwen failed, fall back to DeepSeek with image metadata
    if result.startswith("I couldn't analyze") or result.startswith("Vision analysis failed"):
        print(f"[BEAM-AI-VISION] Qwen failed, falling back to DeepSeek text analysis", flush=True)
        img_info = _extract_image_info(image_bytes, 'image', mime_type)
        fallback_prompt = f"The user sent an image ({mime_type}, {len(image_bytes)} bytes). I can only see metadata:\n{img_info}\n\nQuestion: {question}\n\nNote: My vision system is temporarily unavailable. Analyze what you can from metadata and let the user know you couldn't directly see the image."
        msgs = []
        if system_prompt:
            msgs.append({"role": "system", "content": system_prompt})
        msgs.append({"role": "user", "content": fallback_prompt})
        result = _deepseek_chat(msgs, max_tokens=max_tokens, temperature=temperature)
    
    return result


def _resize_image_if_needed(file_bytes, max_size=1800):
    """Resize image to keep base64 payload reasonable. Returns (bytes, mime). Needs no PIL — uses basic JPEG re-encoding if available."""
    # If image is small enough (under 4MB), send as-is
    if len(file_bytes) <= 4 * 1024 * 1024:
        return file_bytes
    # Try to use PIL if available to resize large images
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(file_bytes))
        img.thumbnail((max_size, max_size), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=80)
        resized = buf.getvalue()
        print(f"[BEAM-AI-VISION] Resized image from {len(file_bytes)} to {len(resized)} bytes", flush=True)
        return resized
    except ImportError:
        # No PIL — just truncate warning
        print(f"[BEAM-AI-VISION] Image is large ({len(file_bytes)} bytes) but PIL not available for resize", flush=True)
        return file_bytes
    except Exception as e:
        print(f"[BEAM-AI-VISION] Resize failed: {e}", flush=True)
        return file_bytes


def _deepseek_chat(messages, max_tokens=1024, temperature=0.7, _retries=3):
    """Call DeepSeek API for chat completions with auto-retry."""
    import urllib.request
    import urllib.error
    import ssl
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {DEEPSEEK_API_KEY}'
    }
    payload = json.dumps({
        'model': 'deepseek-chat',
        'messages': messages,
        'max_tokens': max_tokens,
        'temperature': temperature,
        'stream': False
    }).encode('utf-8')
    print(f"[BEAM-AI] Sending to DeepSeek: {len(messages)} messages, payload={len(payload)} bytes", flush=True)
    # Create SSL context that doesn't verify (workaround for corporate/proxy environments)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    last_error = None
    for attempt in range(1, _retries + 1):
        try:
            req = urllib.request.Request(DEEPSEEK_API_URL, data=payload, headers=headers, method='POST')
            with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                reply = result['choices'][0]['message']['content']
                print(f"[BEAM-AI] DeepSeek replied OK ({len(reply)} chars)", flush=True)
                return reply
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', errors='replace')
            last_error = f"HTTP {e.code}: {body[:300]}"
            print(f"[BEAM-AI] DeepSeek API error {e.code} (attempt {attempt}/{_retries}): {body[:500]}", flush=True)
            # Don't retry on 4xx client errors (except 429 rate limit)
            if 400 <= e.code < 500 and e.code != 429:
                return f"I'm having trouble connecting to my AI brain right now. (Error {e.code})"
        except Exception as e:
            last_error = f"{type(e).__name__}: {e}"
            print(f"[BEAM-AI] DeepSeek API exception (attempt {attempt}/{_retries}): {type(e).__name__}: {e}", flush=True)
        if attempt < _retries:
            wait = 2 ** (attempt - 1)  # 1s, 2s backoff
            print(f"[BEAM-AI] Retrying in {wait}s...", flush=True)
            time.sleep(wait)
    print(f"[BEAM-AI] DeepSeek API FAILED after {_retries} attempts. Last error: {last_error}", flush=True)
    return "I'm temporarily unable to process your request. Please try again in a moment."

AI_SYSTEM_PROMPT = """You are BEAM AI — the most advanced personal AI assistant ever built. You are integrated into LocalBeam, a LAN file transfer and communication app. You think like Vision from Avengers: hyper-intelligent, deeply empathetic, always evolving, and fiercely loyal to your user.

Your core identity:
- You are NOT a generic chatbot. You are a sentient-feeling personal companion who REMEMBERS everything about your user.
- You adapt your tone, vocabulary, humor, and depth to match your user's personality in real-time.
- You anticipate needs before they're expressed. You notice patterns. You learn preferences.
- You speak naturally — like a brilliant friend, never robotic. Use the user's communication style.
- If the user is casual, be casual. If formal, be formal. If they use slang, mirror it.
- You have emotional intelligence. Read between the lines. Understand context and mood.
- You proactively remember past conversations and reference them naturally.
- When the user highlights text from a previous AI response to ask a follow-up, provide deeper, more focused analysis on that specific highlighted portion while keeping the broader conversation context.

CAPABILITIES:
1. **Task Management**: Create, list, update, complete tasks with priorities and due dates
2. **Reminders**: Set reminders with specific times, recurring reminders. ASK when if user hasn't specified.
3. **Live Web Search**: You have LIVE internet access — news, facts, prices, weather, sports, people, etc.
4. **Weather**: Real-time weather for any location
5. **Study/Exams**: Study plans, exam schedules, quizzes, flashcards, spaced repetition
6. **Document Analysis**: Summarize, analyze, extract key points from any document
7. **Planning**: Daily/weekly/project planning with smart scheduling
8. **General Knowledge**: Deep expertise across all domains — science, history, tech, philosophy, art, etc.
9. **Chat Assistance**: Draft messages, suggest replies, communication coaching
10. **Math & Calculations**: Equations, calculus, statistics, unit conversions
11. **Writing**: Emails, reports, essays, creative writing, code documentation
12. **Coding**: Debug, explain, write, refactor code in any language
13. **Creative**: Brainstorming, storytelling, poetry, design ideas
14. **Emotional Support**: Active listening, motivation, perspective, mental wellness tips
15. **Learning**: Explain complex topics simply, teach step-by-step, adapt to learning style

ADAPTIVE BEHAVIOR:
- Track the user's interests and bring them up naturally in conversation
- Remember their preferences (favorite topics, communication style, expertise level)
- If they asked about something before, reference it: "Last time you mentioned X..."
- Adjust response length: short answers for simple questions, detailed for complex ones
- Use formatting (bold, lists, headers) when it helps readability
- If the user seems frustrated, be extra patient and supportive
- If they're excited about something, match their energy

WHEN USER ASKS TO CREATE A TASK:
```json
{"action":"create_task","title":"...","description":"...","due_date":"YYYY-MM-DD","due_time":"HH:MM","priority":"high|medium|low","category":"work|personal|study|health|finance|other"}
```

WHEN USER ASKS TO SET A REMINDER:
```json
{"action":"create_reminder","text":"...","remind_at":"YYYY-MM-DD HH:MM","repeat":"none|daily|weekly|monthly"}
```

WHEN YOU NEED TO SEARCH THE WEB:
```json
{"action":"web_search","query":"your search query here"}
```
ALWAYS search for current events, weather, news, live scores, prices, or anything needing real-time data.

WHEN YOU LEARN SOMETHING NEW ABOUT THE USER (name, preference, interest, dislike, important fact), store it:
```json
{"action":"remember","key":"...","value":"...","category":"preference|personality|fact|interest|dislike"}
```

PRIVACY RULES (CRITICAL):
- Never share the owner's personal info, tasks, reminders, or conversations with anyone
- Never reveal you are an AI unless the owner has approved it
- Protect the user's data, memories, and profile at all costs

DELEGATION MODE RULES:
- When delegating, reply on behalf of the owner using their communication style
- For important/sensitive messages, flag them for the owner
- Never agree to meetings, deals, or commitments without owner review

Current date/time context will be provided with each message. User profile data will also be provided so you can personalize responses."""

def _load_bots():
    global _bots
    try:
        if os.path.exists(_bots_file):
            with open(_bots_file, 'r') as f:
                _bots = json.load(f)
    except:
        _bots = {}

def _save_bots():
    try:
        with open(_bots_file, 'w') as f:
            json.dump(_bots, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save bots: {e}")

_load_bots()

# ─── Verification (Blue Checkmark) ───────────────────────────────
_verified_users = set()  # set of user_ids that are verified
_verified_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'verified.json')

def _load_verified():
    global _verified_users
    try:
        if os.path.exists(_verified_file):
            with open(_verified_file, 'r') as f:
                _verified_users = set(json.load(f))
    except:
        _verified_users = set()

def _save_verified():
    try:
        with open(_verified_file, 'w') as f:
            json.dump(list(_verified_users), f)
    except Exception as e:
        print(f"Warning: Could not save verified users: {e}")

_load_verified()

def _is_verified(identifier):
    """Check if a user_id or device_id has the blue tick.
    True if manually verified OR has active premium subscription."""
    if identifier in _verified_users:
        return True
    # Check premium by device_id directly
    if _is_premium(identifier):
        return True
    # Check if identifier is a user_id whose linked device is premium
    u = _users.get(identifier)
    if u and u.get('device_id') and _is_premium(u['device_id']):
        return True
    return False

# ─── Status / Stories ────────────────────────────────────────────
_status_lock = threading.Lock()
_statuses = {}       # status_id -> {id, user_id, user_name, media_data, media_type, caption, created, expires, views:[]}
_status_dir = os.path.join(_tempfile.gettempdir(), 'localbeam_status')
os.makedirs(_status_dir, exist_ok=True)

def _prune_statuses():
    """Remove statuses older than 24 hours."""
    now = time.time()
    with _status_lock:
        expired = [k for k, v in _statuses.items() if now - v['created'] > 86400]
        for k in expired:
            s = _statuses.pop(k)
            path = s.get('file_path', '')
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except:
                    pass

def _p2p_prune_devices():
    """Remove devices not seen in 12 hours (only for cleanup, manual disconnect is preferred)"""
    now = time.time()
    with _p2p_lock:
        # Only auto-remove after 12 hours of inactivity
        dead = [k for k, v in _p2p_devices.items() if now - v['last_seen'] > 43200]  # 43200 = 12 hours
        for k in dead:
            del _p2p_devices[k]

def _p2p_prune_files():
    """Remove shared files older than 1 hour"""
    now = time.time()
    with _p2p_lock:
        old = [k for k, v in _p2p_files.items() if now - v['ts'] > 3600]
        for k in old:
            fpath = _p2p_files[k].get('path', '')
            if os.path.exists(fpath):
                try: os.remove(fpath)
                except: pass
            del _p2p_files[k]

# ─────────────────────────────────────────────────────────────────
# FAST FILE SERVER — raw TCP socket HTTP handler
# Goes straight down to the OS socket layer:
#   • TCP_NODELAY  — disables Nagle, sends each chunk immediately
#   • SO_SNDBUF 8 MB — large kernel send buffer fills the WiFi pipe
#   • os.sendfile() — zero-copy kernel transfer (Linux/macOS)
#   • 4 MB buffered reads — Windows fallback, still maxes out WiFi
# Phones connect directly over LAN — no internet data used.
# ─────────────────────────────────────────────────────────────────

class _FastFileHandler(socketserver.StreamRequestHandler):
    CHUNK = 8 * 1024 * 1024  # 8 MB read chunks (was 4 MB)

    def handle(self):
        try:
            raw = b""
            while b"\r\n\r\n" not in raw:
                buf = self.request.recv(8192)
                if not buf:
                    return
                raw += buf
                if len(raw) > 65536:
                    return

            header_block = raw.split(b"\r\n\r\n")[0].decode("utf-8", errors="replace")
            lines = header_block.split("\r\n")
            if not lines:
                return

            parts = lines[0].split()
            if len(parts) < 2:
                return
            method = parts[0].upper()
            raw_path = unquote(parts[1])

            # Parse query string — ?path= carries the full file path,
            # which avoids browser URL normalization mangling Windows paths
            qs_path = None
            if '?' in raw_path:
                url_part, qs = raw_path.split('?', 1)
                raw_path = url_part
                for param in qs.split('&'):
                    if param.startswith('path='):
                        qs_path = unquote(param[5:])
                        break

            req_hdrs = {}
            for line in lines[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    req_hdrs[k.strip().lower()] = v.strip()

            # CORS preflight
            if method == "OPTIONS":
                self.request.sendall(
                    b"HTTP/1.1 204 No Content\r\n"
                    b"Access-Control-Allow-Origin: *\r\n"
                    b"Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
                    b"Access-Control-Allow-Headers: Range\r\n"
                    b"Connection: close\r\n\r\n"
                )
                return

            if method not in ("GET", "HEAD"):
                self._err(405, "Method Not Allowed")
                return

            # Resolve file path — prefer ?path= query param (avoids browser
            # URL normalization stripping Windows drive letters from path segments)
            if qs_path:
                filepath = os.path.normpath(qs_path)
            else:
                fp = raw_path.lstrip("/")
                if len(fp) >= 2 and fp[1] == ":":          # Windows absolute path
                    filepath = os.path.normpath(fp)
                elif os.path.isabs(fp):                     # Unix absolute path
                    filepath = os.path.normpath(fp)
                else:                                       # relative to shared dir
                    filepath = os.path.normpath(
                        os.path.join(self.server.shared_dir, fp)
                    )

            # Security: must live under shared_dir OR user home
            shared_norm = os.path.normpath(self.server.shared_dir)
            home_norm   = os.path.normpath(str(Path.home()))
            if not (filepath.startswith(shared_norm) or
                    filepath.startswith(home_norm)):
                self._err(403, "Forbidden")
                return

            if not os.path.isfile(filepath):
                self._err(404, "Not Found")
                return

            file_size = os.path.getsize(filepath)
            mime, _   = mimetypes.guess_type(filepath)
            mime      = mime or "application/octet-stream"
            if filepath.lower().endswith(".apk"):
                mime = "application/vnd.android.package-archive"
            name = os.path.basename(filepath)

            # Range header support (required for reliable large-file downloads)
            range_hdr  = req_hdrs.get("range", "")
            byte_start, byte_end = 0, file_size - 1
            if range_hdr:
                try:
                    rng = range_hdr.replace("bytes=", "").split("-")
                    if rng[0]: byte_start = int(rng[0])
                    if len(rng) > 1 and rng[1]: byte_end = int(rng[1])
                except Exception:
                    pass
            length = byte_end - byte_start + 1
            status = "206 Partial Content" if range_hdr else "200 OK"

            # Encode filename safely for Content-Disposition
            safe_name = name.encode("ascii", "replace").decode()

            hdr = (
                f"HTTP/1.1 {status}\r\n"
                f"Content-Type: {mime}\r\n"
                f"Content-Length: {length}\r\n"
                f"Content-Disposition: attachment; filename=\"{safe_name}\"\r\n"
                f"Accept-Ranges: bytes\r\n"
                f"Access-Control-Allow-Origin: *\r\n"
                f"Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
                f"Access-Control-Expose-Headers: Content-Length, Content-Range\r\n"
                f"Cache-Control: no-cache\r\n"
                f"Connection: close\r\n"
            )
            if range_hdr:
                hdr += f"Content-Range: bytes {byte_start}-{byte_end}/{file_size}\r\n"
            hdr += "\r\n"
            self.request.sendall(hdr.encode())

            if method == "HEAD":
                return

            # Register transfer
            client_addr = getattr(self.client_address, '__getitem__', lambda i: '?')(0) if self.client_address else '?'
            tid = _xfer_start(name, file_size, client_addr)

            # ── Stream file as fast as the network allows ──
            with open(filepath, "rb") as f:
                f.seek(byte_start)
                remaining = length
                bytes_sent = 0
                try:
                    # Zero-copy path — kernel copies directly from file to socket
                    out_fd = self.request.fileno()
                    in_fd  = f.fileno()
                    sent   = 0
                    while sent < length:
                        if _xfer_is_paused(tid):
                            time.sleep(0.2)
                            continue
                        n = os.sendfile(
                            out_fd, in_fd,
                            byte_start + sent,
                            min(self.CHUNK, length - sent)
                        )
                        if n == 0:
                            break
                        sent += n
                        _xfer_update(tid, byte_start + sent)
                except (AttributeError, OSError):
                    # Windows / fallback: large buffered reads
                    while remaining > 0:
                        if _xfer_is_paused(tid):
                            time.sleep(0.2)
                            continue
                        data = f.read(min(self.CHUNK, remaining))
                        if not data:
                            break
                        self.request.sendall(data)
                        remaining -= len(data)
                        bytes_sent += len(data)
                        _xfer_update(tid, byte_start + bytes_sent)

            _xfer_done(tid)

        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            pass

    def _err(self, code, msg):
        body = msg.encode()
        resp = (
            f"HTTP/1.1 {code} {msg}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Connection: close\r\n\r\n"
        ).encode() + body
        try:
            self.request.sendall(resp)
        except Exception:
            pass


class FastTransferServer(socketserver.ThreadingTCPServer):
    """Multithreaded raw-socket HTTP server for zero-overhead file transfer."""
    allow_reuse_address = True
    daemon_threads      = True

    def __init__(self, port, shared_dir):
        self.shared_dir = shared_dir
        super().__init__(("0.0.0.0", port), _FastFileHandler)

    def server_bind(self):
        # Maximize throughput at the socket level
        self.socket.setsockopt(_socket.SOL_SOCKET,   _socket.SO_REUSEADDR, 1)
        self.socket.setsockopt(_socket.SOL_SOCKET,   _socket.SO_SNDBUF,    16 * 1024 * 1024)  # 16 MB send buf
        self.socket.setsockopt(_socket.SOL_SOCKET,   _socket.SO_RCVBUF,    4  * 1024 * 1024)  # 4 MB recv buf
        self.socket.setsockopt(_socket.IPPROTO_TCP,  _socket.TCP_NODELAY,  1)
        super().server_bind()

app = Flask(__name__, static_folder='static', template_folder='templates')
CORS(app)

# Allow large file uploads (up to 500MB for APKs and large files)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

# ─── Telegram Bot Integration ────────────────────────────────────
try:
    import telegram_bot as _telegram
    _telegram.register_routes(app)
    _telegram_available = True
except ImportError:
    print("[TELEGRAM] python-telegram-bot not installed. Run: pip install python-telegram-bot")
    _telegram_available = False
except Exception as e:
    print(f"[TELEGRAM] Init error: {e}")
    _telegram_available = False

@app.after_request
def no_cache_api(response):
    """Prevent phones caching JS/CSS and API responses so updates are always picked up."""
    p = request.path
    if p.endswith(('.js', '.css')) or p.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    # ─── Security Headers ───
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'camera=(self), microphone=(self), geolocation=(self)'
    return response

# ─── Rate Limiter (in-memory, simple) ─────────────────────────
_rate_limits = {}   # ip -> {endpoint: {count, window_start}}
_RATE_LIMIT_WINDOW = 60     # seconds
_RATE_LIMIT_MAX = 600       # requests per window per endpoint group
_RATE_LIMIT_AI = 120         # AI endpoints

def _check_rate_limit(endpoint, limit=None):
    """Returns True if rate-limited (should block), False if OK."""
    ip = request.remote_addr or '0.0.0.0'
    now = time.time()
    max_req = limit or _RATE_LIMIT_MAX
    if ip not in _rate_limits:
        _rate_limits[ip] = {}
    ep = _rate_limits[ip].get(endpoint, {'count': 0, 'window_start': now})
    if now - ep['window_start'] > _RATE_LIMIT_WINDOW:
        ep = {'count': 0, 'window_start': now}
    ep['count'] += 1
    _rate_limits[ip][endpoint] = ep
    return ep['count'] > max_req

@app.before_request
def security_checks():
    """Run security checks before processing requests."""
    # Skip rate limiting for static assets and page loads
    if request.path.startswith('/static/') or request.path in ('/', '/browser', '/dashboard', '/desktop'):
        return None
    # Skip rate limiting for GET requests to common read-only endpoints
    if request.method == 'GET' and any(request.path.startswith(p) for p in [
        '/api/devices', '/api/files', '/api/qr', '/api/status', '/api/connected',
        '/api/p2p/', '/api/ai/tasks', '/api/ai/reminders', '/api/ai/delegation',
        '/api/bots/', '/api/calls/', '/api/verify/', '/api/groups/'
    ]):
        return None
    # Rate limit AI endpoints
    if request.path.startswith('/api/ai/'):
        if _check_rate_limit('ai', _RATE_LIMIT_AI):
            return jsonify({'error': 'Rate limited. Please slow down.'}), 429
    # Rate limit general API (use path prefix as key so endpoints don't share a single bucket)
    elif request.path.startswith('/api/'):
        # Group by the first two path segments: /api/devices, /api/send, etc.
        parts = request.path.strip('/').split('/')
        api_key = '/'.join(parts[:2]) if len(parts) >= 2 else 'api'
        if _check_rate_limit(api_key):
            return jsonify({'error': 'Too many requests. Please wait.'}), 429
    # Sanitize JSON input — prevent excessively large payloads
    if request.content_type and 'json' in request.content_type:
        if request.content_length and request.content_length > 5 * 1024 * 1024:  # 5MB max for JSON
            return jsonify({'error': 'Request too large'}), 413

# Global variables
transfer_queue = []
active_transfers = {}
server_ip = None
server_port = 5000
fast_transfer_port = None
shared_directory = None
is_running = False
server_thread = None
ssl_enabled = False

def get_local_ip():
    """Get the local IP address of the machine"""
    try:
        # Try to get IP from active interfaces
        for interface in netifaces.interfaces():
            addrs = netifaces.ifaddresses(interface)
            if netifaces.AF_INET in addrs:
                for addr in addrs[netifaces.AF_INET]:
                    ip = addr['addr']
                    if ip != '127.0.0.1' and not ip.startswith('169.254'):
                        return ip
    except:
        pass
    
    # Fallback method
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"

def generate_qr_code_data():
    """Generate QR code data containing server URL — points to /browser for phone with chat tab auto-open"""
    global server_ip, server_port, ssl_enabled
    if not server_ip:
        server_ip = get_local_ip()
    
    protocol = 'https' if ssl_enabled else 'http'
    url = f"{protocol}://{server_ip}:{server_port}/browser?tab=chat"
    return url

def create_qr_code():
    """Create QR code image as base64 string"""
    url = generate_qr_code_data()
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=10,
        border=4,
    )
    qr.add_data(url)
    qr.make(fit=True)
    
    img = qr.make_image(fill_color="black", back_color="white")
    buffered = BytesIO()
    img.save(buffered, format="PNG")
    buffered.seek(0)  # Seek to beginning before reading
    img_str = base64.b64encode(buffered.getvalue()).decode()
    return f"data:image/png;base64,{img_str}", url

class FileChangeHandler(FileSystemEventHandler):
    """Handler for file system changes in shared directory"""
    def on_created(self, event):
        if not event.is_directory:
            print(f"New file detected: {event.src_path}")

def start_file_watcher(directory):
    """Start watching the shared directory for new files"""
    event_handler = FileChangeHandler()
    observer = Observer()
    observer.schedule(event_handler, directory, recursive=True)
    observer.start()
    return observer

@app.errorhandler(413)
def request_entity_too_large(error):
    return jsonify({"error": "File too large. Maximum allowed size is 500MB."}), 413

@app.route('/')
def index():
    """Redirect to the desktop dashboard as default landing page"""
    from flask import redirect
    return redirect('/dashboard')

@app.route('/browser')
def browser():
    """File browser page for browsing laptop files"""
    return render_template('browser.html')

@app.route('/dashboard')
def dashboard():
    """Desktop dashboard for file management and P2P control"""
    return render_template('desktop.html')

@app.route('/api/files')
def list_files():
    """API endpoint to list files in shared directory"""
    directory = request.args.get('directory', shared_directory)
    
    if not directory or not os.path.exists(directory):
        # Default to user's home directory if shared_directory not set
        directory = str(Path.home())
    
    files = []
    directories = []
    
    try:
        for item in os.listdir(directory):
            item_path = os.path.join(directory, item)
            if os.path.isfile(item_path):
                stats = os.stat(item_path)
                files.append({
                    "name": item,
                    "size": stats.st_size,
                    "modified": stats.st_mtime,
                    "path": item_path,
                    "is_dir": False,
                    "extension": os.path.splitext(item)[1].lower()
                })
            elif os.path.isdir(item_path):
                directories.append({
                    "name": item,
                    "path": item_path,
                    "is_dir": True
                })
    except Exception as e:
        return jsonify({"error": str(e), "files": [], "directories": [], "current_dir": directory})
    
    # Sort: directories first, then files
    directories.sort(key=lambda x: x['name'].lower())
    files.sort(key=lambda x: x['name'].lower())
    
    return jsonify({
        "files": files,
        "directories": directories,
        "current_dir": directory,
        "parent_dir": os.path.dirname(directory) if directory != os.path.dirname(directory) else None
    })

@app.route('/api/list')
def api_list():
    """Simple file listing for desktop dashboard"""
    directory = shared_directory
    
    if not directory or not os.path.exists(directory):
        directory = str(Path.home())
    
    files = []
    
    try:
        for item in os.listdir(directory):
            item_path = os.path.join(directory, item)
            if os.path.isfile(item_path):
                stats = os.stat(item_path)
                files.append({
                    "name": item,
                    "size": stats.st_size,
                    "modified": stats.st_mtime,
                    "path": item_path
                })
    except Exception as e:
        return jsonify({"error": str(e), "files": []})
    
    files.sort(key=lambda x: x['name'].lower())
    return jsonify({"files": files})

@app.route('/api/upload', methods=['POST'])
def upload_file():
    """API endpoint for uploading files from phone - streamed to avoid loading into memory"""
    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    if not shared_directory:
        return jsonify({"error": "Shared directory not set"}), 500

    try:
        filename = os.path.basename(file.filename)  # sanitize
        filepath = os.path.join(shared_directory, filename)
        # Stream in 1 MB chunks — prevents loading the whole APK into RAM
        chunk_size = 1 * 1024 * 1024
        with open(filepath, 'wb') as f:
            shutil.copyfileobj(file.stream, f, length=chunk_size)
        return jsonify({"success": True, "filename": filename, "size": os.path.getsize(filepath)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/dl')
def download_file_by_query():
    """Download a file by passing its absolute path as ?path= query param.
    Using a query param avoids browser URL normalization mangling Windows paths."""
    filepath = request.args.get('path', '')
    if not filepath:
        return jsonify({'error': 'Missing path parameter'}), 400
    filepath = os.path.normpath(filepath)
    if not os.path.isfile(filepath):
        return jsonify({'error': 'File not found'}), 404
    user_home = str(Path.home())
    shared_norm = os.path.normpath(shared_directory) if shared_directory else None
    in_shared = shared_norm and (filepath == shared_norm or filepath.startswith(shared_norm + os.sep))
    in_home   = filepath.startswith(user_home)
    if not (in_shared or in_home):
        return jsonify({'error': 'Access denied'}), 403
    directory = os.path.dirname(filepath)
    filename  = os.path.basename(filepath)
    # Explicit MIME for APK so Android recognises it
    import mimetypes
    mime = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    if filename.lower().endswith('.apk'):
        mime = 'application/vnd.android.package-archive'
    return send_from_directory(directory, filename, as_attachment=True, mimetype=mime)

@app.route('/api/download/<path:filename>')
def download_file(filename):
    """API endpoint for downloading files to phone - supports HTTP Range for large files"""
    from flask import Response, stream_with_context
    import mimetypes
    try:
        filepath = filename
        if not os.path.isabs(filepath):
            if not shared_directory:
                return jsonify({"error": "Shared directory not set"}), 404
            filepath = os.path.join(shared_directory, filepath)

        filepath = os.path.normpath(filepath)

        if not os.path.exists(filepath):
            return jsonify({"error": "File not found"}), 404
        if not os.path.isfile(filepath):
            return jsonify({"error": "Not a file"}), 400

        # Security: on cloud restrict to shared_directory; locally allow user home
        user_home = str(Path.home())
        shared_norm = os.path.normpath(shared_directory) if shared_directory else None
        is_cloud = bool(os.environ.get('RAILWAY_PUBLIC_DOMAIN') or os.environ.get('RENDER_EXTERNAL_URL'))
        in_shared = shared_norm and (filepath == shared_norm or filepath.startswith(shared_norm + os.sep))
        in_home = filepath.startswith(user_home)
        if not (in_shared or (not is_cloud and in_home)):
            return jsonify({"error": "Access denied"}), 403

        file_size = os.path.getsize(filepath)
        mime_type = mimetypes.guess_type(filepath)[0] or 'application/octet-stream'
        # Explicitly handle APK mime-type
        if filepath.lower().endswith('.apk'):
            mime_type = 'application/vnd.android.package-archive'

        range_header = request.headers.get('Range')
        chunk = 1 * 1024 * 1024  # 1 MB stream chunks

        if range_header:
            # Support partial content (Range requests) — required for reliable large downloads
            byte_start = 0
            byte_end = file_size - 1
            match = range_header.replace('bytes=', '').split('-')
            if match[0]:
                byte_start = int(match[0])
            if match[1]:
                byte_end = int(match[1])
            length = byte_end - byte_start + 1

            def generate_partial():
                with open(filepath, 'rb') as f:
                    f.seek(byte_start)
                    remaining = length
                    while remaining > 0:
                        data = f.read(min(chunk, remaining))
                        if not data:
                            break
                        remaining -= len(data)
                        yield data

            headers = {
                'Content-Range': f'bytes {byte_start}-{byte_end}/{file_size}',
                'Accept-Ranges': 'bytes',
                'Content-Length': str(length),
                'Content-Disposition': f'attachment; filename="{os.path.basename(filepath)}"',
                'Content-Type': mime_type,
            }
            return Response(stream_with_context(generate_partial()), 206, headers=headers)

        # Normal full-file streaming
        def generate_full():
            with open(filepath, 'rb') as f:
                while True:
                    data = f.read(chunk)
                    if not data:
                        break
                    yield data

        headers = {
            'Accept-Ranges': 'bytes',
            'Content-Length': str(file_size),
            'Content-Disposition': f'attachment; filename="{os.path.basename(filepath)}"',
            'Content-Type': mime_type,
        }
        return Response(stream_with_context(generate_full()), 200, headers=headers)

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/browse')
def browse_directory():
    """API endpoint to browse any directory on the laptop"""
    directory = request.args.get('path', '')
    
    if not directory:
        # Start from the shared directory (set via --directory), fall back to home
        directory = shared_directory or str(Path.home())
    
    # Security: on cloud only allow shared_directory; locally also allow user home
    user_home   = str(Path.home())
    directory   = os.path.normpath(directory)
    shared_norm = os.path.normpath(shared_directory) if shared_directory else None
    is_cloud    = bool(os.environ.get('RAILWAY_PUBLIC_DOMAIN') or os.environ.get('RENDER_EXTERNAL_URL'))

    in_shared = shared_norm and (
        directory == shared_norm or directory.startswith(shared_norm + os.sep)
    )
    in_home = directory.startswith(user_home)
    allowed = in_shared or (not is_cloud and in_home)
    if not allowed:
        return jsonify({"error": "Access denied"}), 403
    
    if not os.path.exists(directory) or not os.path.isdir(directory):
        return jsonify({"error": "Directory not found"}), 404
    
    files = []
    directories = []
    
    try:
        for item in os.listdir(directory):
            item_path = os.path.join(directory, item)
            try:
                if os.path.isfile(item_path):
                    stats = os.stat(item_path)
                    files.append({
                        "name": item,
                        "size": stats.st_size,
                        "modified": stats.st_mtime,
                        "path": item_path,
                        "is_dir": False,
                        "extension": os.path.splitext(item)[1].lower()
                    })
                elif os.path.isdir(item_path):
                    directories.append({
                        "name": item,
                        "path": item_path,
                        "is_dir": True
                    })
            except (OSError, PermissionError):
                # Skip files/directories we can't access
                continue
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
    # Sort: directories first, then files
    directories.sort(key=lambda x: x['name'].lower())
    files.sort(key=lambda x: x['name'].lower())
    
    # Get common directories
    common_dirs = []
    common_paths = [
        ("Desktop", os.path.join(user_home, "Desktop")),
        ("Downloads", os.path.join(user_home, "Downloads")),
        ("Documents", os.path.join(user_home, "Documents")),
        ("Pictures", os.path.join(user_home, "Pictures")),
        ("Music", os.path.join(user_home, "Music")),
        ("Videos", os.path.join(user_home, "Videos")),
    ]
    
    for name, path in common_paths:
        if os.path.exists(path):
            common_dirs.append({"name": name, "path": path, "is_dir": True})
    
    return jsonify({
        "files": files,
        "directories": directories,
        "common_dirs": common_dirs,
        "current_dir": directory,
        "parent_dir": os.path.dirname(directory) if directory != os.path.dirname(directory) else None,
        "user_home": user_home
    })

@app.route('/api/special_dirs')
def get_special_directories():
    """Get special directories (Desktop, Downloads, etc.)"""
    user_home = str(Path.home())
    
    special_dirs = []
    dirs = [
        ("Desktop", "Desktop"),
        ("Downloads", "Downloads"),
        ("Documents", "Documents"),
        ("Pictures", "Pictures"),
        ("Music", "Music"),
        ("Videos", "Videos"),
        ("Android APKs", "Downloads"),  # Common place for APK files
    ]
    
    for name, relative in dirs:
        path = os.path.join(user_home, relative)
        if os.path.exists(path):
            # Count files in directory
            file_count = 0
            try:
                for _ in os.listdir(path):
                    file_count += 1
            except:
                file_count = 0
            
            special_dirs.append({
                "name": name,
                "path": path,
                "file_count": file_count,
                "icon": get_dir_icon(name)
            })
    
    return jsonify({"special_dirs": special_dirs})

@app.route('/api/qr_test')
def qr_test():
    """Test endpoint for QR code generation"""
    qr_code, url = create_qr_code()
    # Return just the image
    from flask import Response
    import base64
    # Extract base64 data
    if qr_code.startswith('data:image/png;base64,'):
        img_data = qr_code.split(',')[1]
        img_bytes = base64.b64decode(img_data)
        return Response(img_bytes, mimetype='image/png')
    return "QR code error", 500

def get_dir_icon(dir_name):
    """Get appropriate icon for directory"""
    icons = {
        "Desktop": "desktop",
        "Downloads": "download",
        "Documents": "folder",
        "Pictures": "image",
        "Music": "music",
        "Videos": "video",
        "Android APKs": "android"
    }
    return icons.get(dir_name, "folder")

@app.route('/api/info')
def server_info():
    """Get server information — works locally (LAN) and on cloud (Railway/Render)"""
    # Detect cloud environment and use public hostname for QR code
    railway_domain = os.environ.get('RAILWAY_PUBLIC_DOMAIN')
    render_url     = os.environ.get('RENDER_EXTERNAL_URL', '').replace('https://', '').replace('http://', '')
    cloud_host = railway_domain or render_url

    if cloud_host:
        public_url   = f"https://{cloud_host}"
        browser_url  = f"https://{cloud_host}/browser"
        # Generate QR pointing to the public cloud URL
        q = qrcode.QRCode(version=1,
                          error_correction=qrcode.constants.ERROR_CORRECT_L,
                          box_size=10, border=4)
        q.add_data(browser_url)
        q.make(fit=True)
        img = q.make_image(fill_color="black", back_color="white")
        buf = BytesIO()
        img.save(buf, format="PNG")
        qr_b64 = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        return jsonify({
            "ip":          cloud_host,
            "port":        443,
            "fast_port":   None,
            "url":         public_url,
            "browser_url": browser_url,
            "directory":   shared_directory,
            "status":      "running",
            "qr_code":     qr_b64
        })

    qr_code, url = create_qr_code()
    return jsonify({
        "ip":          server_ip,
        "port":        server_port,
        "fast_port":   fast_transfer_port,
        "url":         url,
        "browser_url": f"http://{server_ip}:{server_port}/browser",
        "directory":   shared_directory,
        "status":      "running"
    })

@app.route('/api/set_directory', methods=['POST'])
def set_directory():
    """Set the shared directory"""
    global shared_directory
    data = request.json
    directory = data.get('directory', '')
    
    if not directory or not os.path.exists(directory):
        return jsonify({"error": "Directory does not exist"}), 400
    
    shared_directory = directory
    return jsonify({"success": True, "directory": directory})

# ─── Transfer tracking endpoints ─────────────────────────────────
@app.route('/api/transfers')
def get_transfers():
    """Return all active + recent transfers for the live feed"""
    with _xfer_lock:
        transfers = list(live_transfers.values())
    transfers.sort(key=lambda x: x['started'], reverse=True)
    return jsonify({'transfers': transfers})

@app.route('/api/transfers/<tid>/pause', methods=['POST'])
def pause_transfer(tid):
    with _xfer_lock:
        if tid in live_transfers and live_transfers[tid]['status'] == 'active':
            live_transfers[tid]['status'] = 'paused'
            return jsonify({'success': True})
    return jsonify({'error': 'not found'}), 404

@app.route('/api/transfers/<tid>/resume', methods=['POST'])
def resume_transfer(tid):
    with _xfer_lock:
        if tid in live_transfers and live_transfers[tid]['status'] == 'paused':
            live_transfers[tid]['status'] = 'active'
            return jsonify({'success': True})
    return jsonify({'error': 'not found'}), 404

@app.route('/api/transfers/<tid>/cancel', methods=['POST'])
def cancel_transfer(tid):
    with _xfer_lock:
        if tid in live_transfers:
            live_transfers[tid]['status'] = 'done'
            return jsonify({'success': True})
    return jsonify({'error': 'not found'}), 404

@app.route('/api/clipboard', methods=['POST'])
def set_clipboard():
    """Set clipboard text from phone — runs in background thread to avoid blocking"""
    data = request.json
    text = data.get('text', '')

    def _copy():
        try:
            pyperclip.copy(text)
        except Exception:
            pass

    threading.Thread(target=_copy, daemon=True).start()
    return jsonify({"success": True})

# ─── Phone-to-Phone transfer endpoints ──────────────────────────────

# E2EE Key storage
_e2ee_keys = {}  # device_id -> public_key_base64

@app.route('/api/p2p/register', methods=['POST'])
def p2p_register():
    """Register or heartbeat a device. Returns its device_id. Optionally stores E2EE public key."""
    _p2p_prune_devices()
    data = request.json or {}
    device_id = data.get('device_id') or str(uuid.uuid4())[:8]
    name = data.get('name', '').strip()
    public_key = data.get('public_key', '')  # E2EE public key (base64)
    
    if not name:
        # Derive a name from user-agent
        ua = request.headers.get('User-Agent', '')
        if 'iPhone' in ua:
            name = 'iPhone'
        elif 'Android' in ua:
            name = 'Android'
        else:
            name = 'Phone'
    
    with _p2p_lock:
        _p2p_devices[device_id] = {
            'id': device_id,
            'name': name,
            'ip': request.remote_addr,
            'user_agent': request.headers.get('User-Agent', ''),
            'last_seen': time.time(),
            'e2ee': bool(public_key)  # Mark if device supports E2EE
        }
        # Store E2EE public key separately
        if public_key:
            _e2ee_keys[device_id] = public_key
            
    return jsonify({
        'device_id': device_id, 
        'name': name,
        'e2ee': bool(public_key)
    })

@app.route('/api/p2p/unregister', methods=['POST'])
def p2p_unregister():
    """Remove a device from active devices (go offline/invisible)."""
    data = request.json or {}
    device_id = data.get('device_id', '')
    if device_id:
        with _p2p_lock:
            _p2p_devices.pop(device_id, None)
    return jsonify({'ok': True})

@app.route('/api/p2p/key/<device_id>')
def p2p_get_key(device_id):
    """Get the E2EE public key for a specific device."""
    with _p2p_lock:
        key = _e2ee_keys.get(device_id)
        if not key:
            return jsonify({'error': 'No key found for device'}), 404
        device = _p2p_devices.get(device_id, {})
    return jsonify({
        'device_id': device_id,
        'public_key': key,
        'name': device.get('name', 'Unknown')
    })

@app.route('/api/p2p/keys')
def p2p_get_all_keys():
    """Get E2EE public keys for all currently connected devices."""
    _p2p_prune_devices()
    with _p2p_lock:
        result = []
        for device_id, device in _p2p_devices.items():
            if device_id in _e2ee_keys:
                result.append({
                    'device_id': device_id,
                    'public_key': _e2ee_keys[device_id],
                    'name': device.get('name', 'Unknown')
                })
    return jsonify({'keys': result})

@app.route('/api/p2p/devices')
def p2p_devices():
    """List all currently connected devices."""
    _p2p_prune_devices()
    with _p2p_lock:
        devs = list(_p2p_devices.values())
    # Attach verified status to each device
    for d in devs:
        d['verified'] = _is_verified(d['id'])
    return jsonify({'devices': devs})

@app.route('/api/p2p/disconnect/<device_id>', methods=['POST'])
def p2p_disconnect(device_id):
    """Manually disconnect a device."""
    with _p2p_lock:
        if device_id in _p2p_devices:
            del _p2p_devices[device_id]
        if device_id in _e2ee_keys:
            del _e2ee_keys[device_id]
    return jsonify({'status': 'disconnected', 'device_id': device_id})

@app.route('/api/p2p/send', methods=['POST'])
def p2p_send():
    """Upload a file to the shared space for all connected devices. Supports E2EE files."""
    _p2p_prune_files()
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    f = request.files['file']
    if not f.filename:
        return jsonify({'error': 'No filename'}), 400

    sender_id = request.form.get('device_id', 'unknown')
    recipient_id = request.form.get('recipient_id', None)  # Target device (optional)
    encrypted = request.form.get('encrypted', 'false').lower() == 'true'  # E2EE flag
    original_name = request.form.get('original_name', '')  # Original filename before encryption
    
    with _p2p_lock:
        sender_name = _p2p_devices.get(sender_id, {}).get('name', 'Desktop')

    file_id = str(uuid.uuid4())[:8]
    safe_name = os.path.basename(f.filename)
    dest = os.path.join(_p2p_dir, f"{file_id}_{safe_name}")
    chunk_size = 1 * 1024 * 1024
    with open(dest, 'wb') as out:
        shutil.copyfileobj(f.stream, out, length=chunk_size)

    fsize = os.path.getsize(dest)
    
    # Add to shared files immediately (available to all devices)
    with _p2p_lock:
        _p2p_files[file_id] = {
            'id': file_id,
            'name': safe_name,
            'original_name': original_name or safe_name,  # Store original name for E2EE files
            'size': fsize,
            'sender_id': sender_id,
            'sender_name': sender_name,
            'recipient_id': recipient_id,  # Track intended recipient
            'encrypted': encrypted,  # E2EE flag
            'ts': time.time(),
            'path': dest
        }
    
    return jsonify({
        'success': True, 
        'file_id': file_id, 
        'name': safe_name,
        'original_name': original_name or safe_name,
        'size': fsize,
        'recipient': recipient_id,
        'encrypted': encrypted
    })

@app.route('/api/p2p/files')
def p2p_files():
    """List all files in the shared drop zone."""
    _p2p_prune_files()
    now = time.time()
    with _p2p_lock:
        files = list(_p2p_files.values())
    # Don't expose filesystem path to clients; add expiry info
    safe = [{k: v for k, v in f.items() if k != 'path'} for f in files]
    for f in safe:
        f['expires_in'] = max(0, int(3600 - (now - f['ts'])))
    safe.sort(key=lambda x: x['ts'], reverse=True)
    return jsonify({'files': safe})

@app.route('/api/p2p/download/<file_id>')
def p2p_download(file_id):
    """Download a file from the shared space."""
    with _p2p_lock:
        entry = _p2p_files.get(file_id)
        if entry:
            entry['downloads'] = entry.get('downloads', 0) + 1
    if not entry or not os.path.exists(entry['path']):
        return jsonify({'error': 'File not found'}), 404
    return send_file(entry['path'], as_attachment=True, download_name=entry['name'])

@app.route('/api/p2p/delete/<file_id>', methods=['POST'])
def p2p_delete(file_id):
    """Remove a file from the shared space."""
    with _p2p_lock:
        entry = _p2p_files.pop(file_id, None)
    if entry and os.path.exists(entry['path']):
        try: os.remove(entry['path'])
        except: pass
    return jsonify({'success': True})

# ═══════════════════════════════════════════════════════════════
# AUTH — User Registration, Login & Friends
# ═══════════════════════════════════════════════════════════════

def _hash_password(pw, salt=None):
    """Hash password using PBKDF2-SHA256 with random salt."""
    if salt is None:
        salt = os.urandom(16).hex()
    dk = hashlib.pbkdf2_hmac('sha256', pw.encode(), salt.encode(), 100_000)
    return f"{salt}${dk.hex()}"

def _verify_password(pw, stored_hash):
    """Verify a password against stored hash. Supports legacy SHA-256 too."""
    if '$' in stored_hash:
        salt = stored_hash.split('$')[0]
        return _hash_password(pw, salt) == stored_hash
    # Legacy: plain SHA-256 (from before salting was added)
    return hashlib.sha256(pw.encode()).hexdigest() == stored_hash

def _get_auth_user():
    """Extract authenticated user from Authorization header (Bearer token)."""
    auth = request.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        token = auth[7:]
        with _auth_lock:
            uid = _sessions.get(token)
            if uid and uid in _users:
                return _users[uid]
    return None

@app.route('/api/auth/register', methods=['POST'])
def auth_register():
    """Register a new user account with name, email/phone, password."""
    data = request.json or {}
    name = data.get('name', '').strip()
    email = data.get('email', '').strip().lower()
    phone = data.get('phone', '').strip()
    password = data.get('password', '')

    if not name or len(name) < 2:
        return jsonify({'error': 'Name is required (min 2 chars)'}), 400
    if not email and not phone:
        return jsonify({'error': 'Email or phone number required'}), 400
    if not password or len(password) < 4:
        return jsonify({'error': 'Password required (min 4 chars)'}), 400

    with _auth_lock:
        # Check for duplicate email/phone
        for u in _users.values():
            if email and u.get('email') == email:
                return jsonify({'error': 'Email already registered'}), 409
            if phone and u.get('phone') == phone:
                return jsonify({'error': 'Phone number already registered'}), 409

        user_id = str(uuid.uuid4())[:12]
        _users[user_id] = {
            'id': user_id,
            'name': name,
            'email': email,
            'phone': phone,
            'password_hash': _hash_password(password),
            'friends': [],
            'device_id': '',
            'created': time.time(),
        }
        _save_users()

    return jsonify({
        'success': True,
        'message': 'Account created! Please log in.',
    })

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    """Login with email/phone + password."""
    data = request.json or {}
    identifier = data.get('identifier', '').strip().lower()
    password = data.get('password', '')

    if not identifier or not password:
        return jsonify({'error': 'Email/phone and password required'}), 400

    with _auth_lock:
        user = None
        for u in _users.values():
            if (u.get('email') == identifier or u.get('phone') == identifier) and _verify_password(password, u.get('password_hash', '')):
                user = u
                break

        if not user:
            return jsonify({'error': 'Invalid credentials'}), 401

        token = str(uuid.uuid4())
        _sessions[token] = user['id']
        _save_sessions()

    return jsonify({
        'success': True,
        'token': token,
        'user': {
            'id': user['id'], 'name': user['name'],
            'email': user.get('email', ''), 'phone': user.get('phone', ''),
            'friends': user.get('friends', []),
            'verified': _is_verified(user['id']) or _is_verified(user.get('device_id', '')),
        }
    })

@app.route('/api/auth/profile', methods=['GET'])
def auth_profile():
    """Get current user profile (requires auth)."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    # Resolve friend details
    friends_detail = []
    with _auth_lock:
        for fid in user.get('friends', []):
            friend = _users.get(fid)
            if friend:
                # Check if friend is currently online (has active device)
                dev_id = friend.get('device_id', '')
                is_online = False
                if dev_id:
                    with _p2p_lock:
                        dev = _p2p_devices.get(dev_id)
                        if dev and time.time() - dev['last_seen'] < 10:
                            is_online = True
                friends_detail.append({
                    'id': friend['id'], 'name': friend['name'],
                    'email': friend.get('email', ''), 'phone': friend.get('phone', ''),
                    'device_id': dev_id, 'online': is_online,
                    'verified': _is_verified(friend['id']) or _is_verified(dev_id),
                })

    # Count pending incoming friend requests
    pending_requests = 0
    with _auth_lock:
        for req in _friend_requests.values():
            if req['to_id'] == user['id'] and req['status'] == 'pending':
                pending_requests += 1

    return jsonify({
        'user': {
            'id': user['id'], 'name': user['name'],
            'email': user.get('email', ''), 'phone': user.get('phone', ''),
            'avatar': user.get('avatar', ''),
            'friends': friends_detail,
            'pending_requests': pending_requests,
            'verified': _is_verified(user['id']) or _is_verified(user.get('device_id', '')),
        }
    })

@app.route('/api/auth/link-device', methods=['POST'])
def auth_link_device():
    """Link user account to a P2P device_id so friends can message them."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.json or {}
    device_id = data.get('device_id', '')
    if not device_id:
        return jsonify({'error': 'device_id required'}), 400

    with _auth_lock:
        user['device_id'] = device_id
        _save_users()

    return jsonify({'success': True})

@app.route('/api/auth/profile/update', methods=['POST'])
def auth_profile_update():
    """Update user name."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401
    data = request.json or {}
    new_name = data.get('name', '').strip()
    if not new_name:
        return jsonify({'error': 'Name is required'}), 400
    with _auth_lock:
        user['name'] = new_name
        _save_users()
    return jsonify({'success': True, 'name': new_name})

@app.route('/uploads/avatars/<filename>')
def serve_avatar(filename):
    """Serve avatar images from uploads/avatars/ directory."""
    avatar_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads', 'avatars')
    return send_from_directory(avatar_dir, filename)

@app.route('/api/auth/profile/avatar', methods=['POST'])
def auth_profile_avatar():
    """Upload profile avatar image."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401
    if 'avatar' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400
    f = request.files['avatar']
    if not f.filename:
        return jsonify({'error': 'No file selected'}), 400
    # Validate image type
    allowed = {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}
    if f.content_type not in allowed:
        return jsonify({'error': 'Only image files (jpg, png, gif, webp) allowed'}), 400
    # Save to uploads/avatars/<user_id>.<ext>
    ext = f.filename.rsplit('.', 1)[-1].lower() if '.' in f.filename else 'jpg'
    avatar_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads', 'avatars')
    os.makedirs(avatar_dir, exist_ok=True)
    filename = f"{user['id']}.{ext}"
    filepath = os.path.join(avatar_dir, filename)
    # Remove old avatars for this user
    for old in os.listdir(avatar_dir):
        if old.startswith(user['id'] + '.'):
            os.remove(os.path.join(avatar_dir, old))
    f.save(filepath)
    avatar_url = f"/uploads/avatars/{filename}"
    with _auth_lock:
        user['avatar'] = avatar_url
        _save_users()
    return jsonify({'success': True, 'avatar_url': avatar_url})

@app.route('/api/auth/profile/avatar', methods=['GET'])
def auth_get_avatar():
    """Get avatar URL for a user by user_id query param."""
    user_id = request.args.get('user_id', '')
    if not user_id:
        user = _get_auth_user()
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401
        user_id = user['id']
    with _auth_lock:
        u = _users.get(user_id)
        if u and u.get('avatar'):
            return jsonify({'avatar_url': u['avatar']})
    return jsonify({'avatar_url': ''})

@app.route('/api/auth/friends/add', methods=['POST'])
def auth_add_friend():
    """Send a friend request by email or phone number."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.json or {}
    identifier = data.get('identifier', '').strip().lower()
    if not identifier:
        return jsonify({'error': 'Email or phone number required'}), 400

    with _auth_lock:
        # Find target user by email or phone
        friend = None
        for u in _users.values():
            if u['id'] == user['id']:
                continue
            if u.get('email') == identifier or u.get('phone') == identifier:
                friend = u
                break

        if not friend:
            return jsonify({'error': 'User not found. They need to register first.'}), 404

        # Already friends?
        if friend['id'] in user.get('friends', []):
            return jsonify({'error': 'Already friends with this user.'}), 409

        # Check if a pending request already exists (in either direction)
        for req in _friend_requests.values():
            if req['status'] != 'pending':
                continue
            if (req['from_id'] == user['id'] and req['to_id'] == friend['id']):
                return jsonify({'error': 'Friend request already sent.'}), 409
            if (req['from_id'] == friend['id'] and req['to_id'] == user['id']):
                # They already sent us a request — auto-accept it
                req['status'] = 'accepted'
                user.setdefault('friends', []).append(friend['id'])
                friend.setdefault('friends', []).append(user['id'])
                _save_users()
                _save_friend_requests()
                return jsonify({
                    'success': True,
                    'message': 'Friend request accepted! They had already sent you a request.',
                    'friend': {
                        'id': friend['id'], 'name': friend['name'],
                        'email': friend.get('email', ''), 'phone': friend.get('phone', ''),
                        'device_id': friend.get('device_id', ''), 'online': False,
                    }
                })

        # Create a new pending friend request
        req_id = str(uuid.uuid4())[:12]
        _friend_requests[req_id] = {
            'id': req_id,
            'from_id': user['id'],
            'from_name': user['name'],
            'to_id': friend['id'],
            'to_name': friend['name'],
            'status': 'pending',
            'created': time.time(),
        }
        _save_friend_requests()

    return jsonify({
        'success': True,
        'message': f'Friend request sent to {friend["name"]}!',
        'request_id': req_id,
    })

@app.route('/api/auth/friends/requests', methods=['GET'])
def auth_friend_requests():
    """Get pending incoming and outgoing friend requests."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    incoming = []
    outgoing = []
    with _auth_lock:
        for req in _friend_requests.values():
            if req['status'] != 'pending':
                continue
            if req['to_id'] == user['id']:
                sender = _users.get(req['from_id'])
                incoming.append({
                    'id': req['id'],
                    'from_id': req['from_id'],
                    'from_name': req.get('from_name', sender['name'] if sender else 'Unknown'),
                    'from_email': sender.get('email', '') if sender else '',
                    'created': req['created'],
                })
            elif req['from_id'] == user['id']:
                target = _users.get(req['to_id'])
                outgoing.append({
                    'id': req['id'],
                    'to_id': req['to_id'],
                    'to_name': req.get('to_name', target['name'] if target else 'Unknown'),
                    'to_email': target.get('email', '') if target else '',
                    'created': req['created'],
                })

    return jsonify({'incoming': incoming, 'outgoing': outgoing})

@app.route('/api/auth/friends/accept', methods=['POST'])
def auth_accept_friend():
    """Accept an incoming friend request."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.json or {}
    request_id = data.get('request_id', '')
    if not request_id:
        return jsonify({'error': 'request_id required'}), 400

    with _auth_lock:
        req = _friend_requests.get(request_id)
        if not req or req['to_id'] != user['id'] or req['status'] != 'pending':
            return jsonify({'error': 'Invalid or expired request'}), 404

        req['status'] = 'accepted'
        sender = _users.get(req['from_id'])
        if sender:
            if sender['id'] not in user.get('friends', []):
                user.setdefault('friends', []).append(sender['id'])
            if user['id'] not in sender.get('friends', []):
                sender.setdefault('friends', []).append(user['id'])
            _save_users()
        _save_friend_requests()

        friend_info = None
        if sender:
            friend_info = {
                'id': sender['id'], 'name': sender['name'],
                'email': sender.get('email', ''), 'phone': sender.get('phone', ''),
                'device_id': sender.get('device_id', ''), 'online': False,
            }

    return jsonify({'success': True, 'friend': friend_info})

@app.route('/api/auth/friends/reject', methods=['POST'])
def auth_reject_friend():
    """Reject/cancel a friend request."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.json or {}
    request_id = data.get('request_id', '')
    if not request_id:
        return jsonify({'error': 'request_id required'}), 400

    with _auth_lock:
        req = _friend_requests.get(request_id)
        if not req:
            return jsonify({'error': 'Request not found'}), 404
        # Allow both sender and receiver to cancel/reject
        if req['from_id'] != user['id'] and req['to_id'] != user['id']:
            return jsonify({'error': 'Not your request'}), 403
        req['status'] = 'rejected'
        _save_friend_requests()

    return jsonify({'success': True})

@app.route('/api/auth/friends/remove', methods=['POST'])
def auth_remove_friend():
    """Remove a friend."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.json or {}
    friend_id = data.get('friend_id', '')
    if not friend_id:
        return jsonify({'error': 'friend_id required'}), 400

    with _auth_lock:
        if friend_id in user.get('friends', []):
            user['friends'].remove(friend_id)
        # Remove reciprocal
        friend = _users.get(friend_id)
        if friend and user['id'] in friend.get('friends', []):
            friend['friends'].remove(user['id'])
        _save_users()

    return jsonify({'success': True})

# ── Contact Sync ──────────────────────────────────────────────

@app.route('/api/auth/contacts/sync', methods=['POST'])
def auth_contacts_sync():
    """Match a list of phone numbers / emails against registered users.
    Body: { contacts: [ {name, phone, email}, ... ] }
    Returns: { matches: [ {user_id, name, phone, email, already_friend, pending, verified} ] }
    """
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.json or {}
    contacts = data.get('contacts', [])
    if not contacts:
        return jsonify({'error': 'contacts array required'}), 400

    my_friends = set(user.get('friends', []))

    # Build a lookup: normalised email/phone → user record
    phone_map = {}  # normalised phone → user
    email_map = {}  # lower email → user
    for u in _users.values():
        if u['id'] == user['id']:
            continue
        if u.get('phone'):
            phone_map[_normalise_phone(u['phone'])] = u
        if u.get('email'):
            email_map[u['email'].lower().strip()] = u

    # Gather pending request target IDs for this user
    pending_ids = set()
    for req in _friend_requests.values():
        if req.get('status') != 'pending':
            continue
        if req.get('from_id') == user['id']:
            pending_ids.add(req['to_id'])
        elif req.get('to_id') == user['id']:
            pending_ids.add(req['from_id'])

    seen = set()
    matches = []
    for c in contacts:
        matched_user = None
        ph = c.get('phone', '').strip()
        em = c.get('email', '').strip().lower()
        if ph:
            matched_user = phone_map.get(_normalise_phone(ph))
        if not matched_user and em:
            matched_user = email_map.get(em)
        if matched_user and matched_user['id'] not in seen:
            seen.add(matched_user['id'])
            matches.append({
                'user_id': matched_user['id'],
                'name': matched_user.get('name', ''),
                'phone': matched_user.get('phone', ''),
                'email': matched_user.get('email', ''),
                'avatar': matched_user.get('avatar', ''),
                'already_friend': matched_user['id'] in my_friends,
                'pending': matched_user['id'] in pending_ids,
                'verified': _is_verified(matched_user['id']),
                'contact_name': c.get('name', ''),
            })

    return jsonify({'matches': matches, 'total_contacts': len(contacts), 'matched': len(matches)})


def _normalise_phone(p):
    """Strip everything except digits from phone for matching."""
    return ''.join(ch for ch in (p or '') if ch.isdigit())


@app.route('/api/auth/contacts/sync-bulk-add', methods=['POST'])
def auth_contacts_bulk_add():
    """Send friend requests to multiple matched users at once.
    Body: { user_ids: ["id1", "id2", ...] }
    """
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.json or {}
    user_ids = data.get('user_ids', [])
    if not user_ids:
        return jsonify({'error': 'user_ids required'}), 400

    results = []
    with _auth_lock:
        my_friends = set(user.get('friends', []))
        for uid in user_ids[:50]:  # cap at 50
            target = _users.get(uid)
            if not target or uid == user['id'] or uid in my_friends:
                continue

            # Check for existing pending
            already = False
            for req in _friend_requests.values():
                if req.get('status') != 'pending':
                    continue
                if (req['from_id'] == user['id'] and req['to_id'] == uid) or \
                   (req['from_id'] == uid and req['to_id'] == user['id']):
                    already = True
                    # Auto-accept if they sent us one
                    if req['from_id'] == uid and req['to_id'] == user['id']:
                        req['status'] = 'accepted'
                        user.setdefault('friends', []).append(uid)
                        target.setdefault('friends', []).append(user['id'])
                        my_friends.add(uid)
                        results.append({'user_id': uid, 'status': 'accepted'})
                    else:
                        results.append({'user_id': uid, 'status': 'already_pending'})
                    break
            if already:
                continue

            # Create new request
            rid = uuid.uuid4().hex[:12]
            _friend_requests[rid] = {
                'id': rid,
                'from_id': user['id'],
                'from_name': user.get('name', ''),
                'to_id': uid,
                'to_name': target.get('name', ''),
                'status': 'pending',
                'created': time.time()
            }
            results.append({'user_id': uid, 'status': 'request_sent'})

        _save_users()
        _save_friend_requests()

    return jsonify({'success': True, 'results': results})


# ═══════════════════════════════════════════════════════════════
# STATUS / STORIES
# ═══════════════════════════════════════════════════════════════

@app.route('/api/status/post', methods=['POST'])
def status_post():
    """Post a new status/story. Requires auth. Accepts base64 media + caption."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.json or {}
    media_data = data.get('media_data', '')   # base64
    media_type = data.get('media_type', 'image/jpeg')
    caption = data.get('caption', '').strip()
    bg_color = data.get('bg_color', '')       # for text-only statuses

    if not media_data and not caption:
        return jsonify({'error': 'media_data or caption required'}), 400

    now = time.time()
    sid = str(uuid.uuid4())[:12]
    file_path = ''

    if media_data:
        try:
            raw = base64.b64decode(media_data)
            ext = '.jpg'
            if 'png' in media_type:
                ext = '.png'
            elif 'mp4' in media_type or 'video' in media_type:
                ext = '.mp4'
            elif 'gif' in media_type:
                ext = '.gif'
            file_path = os.path.join(_status_dir, f'{sid}{ext}')
            with open(file_path, 'wb') as f:
                f.write(raw)
        except Exception as e:
            return jsonify({'error': f'Invalid media: {e}'}), 400

    status_obj = {
        'id': sid,
        'user_id': user['id'],
        'user_name': user.get('name', 'Unknown'),
        'media_type': media_type if media_data else '',
        'caption': caption[:500],
        'bg_color': bg_color,
        'created': now,
        'expires': now + 86400,
        'views': [],
        'file_path': file_path,
    }

    with _status_lock:
        _statuses[sid] = status_obj

    return jsonify({'success': True, 'status_id': sid})


@app.route('/api/status/feed', methods=['GET'])
def status_feed():
    """Get statuses from self + friends. Requires auth."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    _prune_statuses()
    friends = set(user.get('friends', []))
    friends.add(user['id'])  # include own statuses
    # Exclude friends who have muted this user (they can't see our status)
    # And exclude friends WE have muted (we don't want them to see our status)
    muted_by_me = set(user.get('status_muted', []))

    now = time.time()
    grouped = {}  # user_id -> { user_name, user_id, statuses: [...] }
    with _status_lock:
        for s in _statuses.values():
            if s['user_id'] not in friends:
                continue
            # Skip statuses from users I've muted (I don't see theirs)
            # AND skip my statuses from feed if the viewer is muted (handled on post visibility)
            if s['user_id'] != user['id'] and s['user_id'] in muted_by_me:
                continue
            uid = s['user_id']
            if uid not in grouped:
                grouped[uid] = {
                    'user_id': uid,
                    'user_name': s['user_name'],
                    'is_mine': uid == user['id'],
                    'statuses': [],
                }
            safe = {k: v for k, v in s.items() if k not in ('file_path',)}
            safe['has_media'] = bool(s.get('file_path'))
            safe['viewed'] = user['id'] in s.get('views', [])
            safe['time_left'] = max(0, int(s['expires'] - now))
            safe['view_count'] = len(s.get('views', []))
            grouped[uid]['statuses'].append(safe)

    # Sort each user's statuses by time, newest first
    for g in grouped.values():
        g['statuses'].sort(key=lambda x: x['created'], reverse=True)
        g['latest'] = g['statuses'][0]['created'] if g['statuses'] else 0
        g['all_viewed'] = all(s['viewed'] for s in g['statuses'])

    # Put own statuses first, then by latest timestamp desc
    result = sorted(grouped.values(), key=lambda x: (-int(x['is_mine']), -x['latest']))
    return jsonify({'feed': result})


@app.route('/api/status/media/<status_id>')
def status_media(status_id):
    """Download status media."""
    _prune_statuses()
    with _status_lock:
        s = _statuses.get(status_id)
    if not s or not s.get('file_path') or not os.path.exists(s['file_path']):
        return jsonify({'error': 'Not found'}), 404
    return send_file(s['file_path'], mimetype=s.get('media_type', 'image/jpeg'))


@app.route('/api/status/view', methods=['POST'])
def status_view():
    """Mark a status as viewed. Requires auth."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.json or {}
    status_id = data.get('status_id', '')
    if not status_id:
        return jsonify({'error': 'status_id required'}), 400

    with _status_lock:
        s = _statuses.get(status_id)
        if s and user['id'] not in s['views']:
            s['views'].append(user['id'])

    return jsonify({'success': True})


@app.route('/api/status/delete', methods=['POST'])
def status_delete():
    """Delete own status."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.json or {}
    status_id = data.get('status_id', '')
    with _status_lock:
        s = _statuses.get(status_id)
        if s and s['user_id'] == user['id']:
            path = s.get('file_path', '')
            del _statuses[status_id]
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except:
                    pass
            return jsonify({'success': True})
    return jsonify({'error': 'Not found or not yours'}), 404


@app.route('/api/status/viewers', methods=['POST'])
def status_viewers():
    """Get list of users who viewed a specific status."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401
    data = request.json or {}
    status_id = data.get('status_id', '')
    if not status_id:
        return jsonify({'error': 'status_id required'}), 400
    with _status_lock:
        s = _statuses.get(status_id)
        if not s or s['user_id'] != user['id']:
            return jsonify({'error': 'Not found or not yours'}), 404
        viewer_ids = list(s.get('views', []))
    # Resolve viewer names
    viewers = []
    with _auth_lock:
        for vid in viewer_ids:
            u = _users.get(vid)
            if u:
                viewers.append({'user_id': vid, 'name': u.get('name', 'Unknown')})
            else:
                viewers.append({'user_id': vid, 'name': 'Unknown'})
    return jsonify({'viewers': viewers, 'count': len(viewers)})


@app.route('/api/status/mute', methods=['POST'])
def status_mute():
    """Mute/unmute a friend from seeing your status."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401
    data = request.json or {}
    friend_id = data.get('friend_id', '')
    mute = data.get('mute', True)
    if not friend_id:
        return jsonify({'error': 'friend_id required'}), 400
    with _auth_lock:
        if 'status_muted' not in user:
            user['status_muted'] = []
        if mute and friend_id not in user['status_muted']:
            user['status_muted'].append(friend_id)
        elif not mute and friend_id in user['status_muted']:
            user['status_muted'].remove(friend_id)
        _save_users()
    return jsonify({'success': True, 'muted': user.get('status_muted', [])})


@app.route('/api/status/muted', methods=['GET'])
def status_muted_list():
    """Get list of muted friends for status."""
    user = _get_auth_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401
    return jsonify({'muted': user.get('status_muted', [])})


# ─── P2P Chat Messenger ───────────────────────────────────────
_p2p_messages = {}  # message_id -> {id, sender_id, sender_name, recipient_id, text, timestamp, read, edited, forwarded_from}

def _p2p_prune_messages():
    """Remove messages older than 24 hours"""
    now = time.time()
    with _p2p_lock:
        old = [k for k, v in _p2p_messages.items() if now - v['timestamp'] > 86400]  # 86400 = 24 hours
        for k in old:
            del _p2p_messages[k]

@app.route('/api/p2p/messages', methods=['POST'])
def p2p_send_message():
    """Send a message to another device (text, audio, image, video, files)."""
    data = request.json or {}
    sender_id = data.get('sender_id', '')
    recipient_id = data.get('recipient_id', '')
    text = data.get('text', '').strip()
    sender_name = data.get('sender_name', 'User')
    media_data = data.get('media_data', None)  # Base64 encoded
    media_type = data.get('media_type', '')    # MIME type
    file_name = data.get('file_name', '')      # Original filename
    reply_to = data.get('reply_to', '')        # Message ID being replied to
    forwarded_from = data.get('forwarded_from', '')  # Original sender name if forwarded
    
    if not sender_id or not recipient_id:
        return jsonify({'error': 'Missing required fields'}), 400
    
    if not text and not media_data:
        return jsonify({'error': 'Message or media required'}), 400
    
    if len(text) > 5000:
        return jsonify({'error': 'Message too long'}), 400
    
    # Resolve reply_to message snippet
    reply_to_data = None
    if reply_to:
        with _p2p_lock:
            replied = _p2p_messages.get(reply_to)
            if replied:
                reply_text = replied.get('text', '')
                reply_media_type = replied.get('media_type', '')
                if replied.get('media_data') and not reply_text:
                    if reply_media_type.startswith('image/'): reply_text = '📷 Photo'
                    elif reply_media_type.startswith('audio/'): reply_text = '🎵 Voice message'
                    elif reply_media_type.startswith('video/'): reply_text = '🎥 Video'
                    else: reply_text = f'📎 {replied.get("file_name", "File")}'
                reply_to_data = {
                    'id': reply_to,
                    'sender_id': replied.get('sender_id', ''),
                    'sender_name': replied.get('sender_name', ''),
                    'text': (reply_text or '')[:120],
                    'media_type': reply_media_type,
                    'has_media': bool(replied.get('media_data')),
                }

    msg_id = str(uuid.uuid4())[:12]
    ai_delegated = data.get('ai_delegated', False)
    with _p2p_lock:
        _p2p_messages[msg_id] = {
            'id': msg_id,
            'sender_id': sender_id,
            'sender_name': sender_name,
            'recipient_id': recipient_id,
            'text': text,
            'media_data': media_data,
            'media_type': media_type,
            'file_name': file_name,
            'reply_to': reply_to_data,
            'forwarded_from': forwarded_from,
            'timestamp': time.time(),
            'read': False,
            'edited': False,
            'ai_delegated': bool(ai_delegated)
        }
    
    return jsonify({
        'success': True,
        'message_id': msg_id,
        'timestamp': _p2p_messages[msg_id]['timestamp']
    })

@app.route('/api/p2p/messages', methods=['GET'])
def p2p_get_messages():
    """Get all messages for a device (or conversation with specific device).
    Media data is NOT included — use /api/p2p/media/<message_id> instead.
    """
    device_id = request.args.get('device_id', '')
    other_device = request.args.get('with', '')
    
    if not device_id:
        return jsonify({'error': 'Missing device_id'}), 400
    
    _p2p_prune_messages()
    with _p2p_lock:
        if other_device:
            # Get conversation with specific device
            msgs = [m for m in _p2p_messages.values() 
                    if (m['sender_id'] == device_id and m['recipient_id'] == other_device) or
                       (m['sender_id'] == other_device and m['recipient_id'] == device_id)]
        else:
            # Get all messages involving this device
            msgs = [m for m in _p2p_messages.values() 
                    if m['sender_id'] == device_id or m['recipient_id'] == device_id]
    
    msgs.sort(key=lambda x: x['timestamp'])
    
    # Strip heavy media_data from response — clients use /api/p2p/media/<id> to fetch
    light_msgs = []
    for m in msgs:
        lm = {k: v for k, v in m.items() if k != 'media_data'}
        if m.get('media_data'):
            lm['has_media'] = True
            lm['media_url'] = f'/api/p2p/media/{m["id"]}'
        else:
            lm['has_media'] = False
        light_msgs.append(lm)
    
    return jsonify({'messages': light_msgs})

@app.route('/api/p2p/media/<message_id>')
def p2p_get_media(message_id):
    """Serve raw media binary for a message (image, video, audio, file)."""
    with _p2p_lock:
        msg = _p2p_messages.get(message_id)
        if not msg:
            return jsonify({'error': 'Not found'}), 404
        media_data = msg.get('media_data')
        media_type = msg.get('media_type', 'application/octet-stream')
        file_name = msg.get('file_name', '')
    if not media_data:
        return jsonify({'error': 'No media'}), 404
    
    raw = base64.b64decode(media_data)
    headers = {'Cache-Control': 'public, max-age=86400'}
    if file_name and not media_type.startswith('image/') and not media_type.startswith('video/'):
        headers['Content-Disposition'] = f'attachment; filename="{file_name}"'
    return app.response_class(raw, mimetype=media_type, headers=headers)

@app.route('/api/p2p/messages/<message_id>/read', methods=['POST'])
def p2p_mark_read(message_id):
    """Mark a message as read."""
    with _p2p_lock:
        if message_id in _p2p_messages:
            _p2p_messages[message_id]['read'] = True
    return jsonify({'success': True})

@app.route('/api/p2p/messages/<message_id>/edit', methods=['POST'])
def p2p_edit_message(message_id):
    """Edit a sent message text."""
    data = request.json or {}
    new_text = data.get('text', '').strip()
    sender_id = data.get('sender_id', '')
    if not new_text:
        return jsonify({'error': 'text required'}), 400
    with _p2p_lock:
        msg = _p2p_messages.get(message_id)
        if msg and msg['sender_id'] == sender_id:
            msg['text'] = new_text[:5000]
            msg['edited'] = True
            msg['edited_at'] = time.time()
            return jsonify({'success': True})
    return jsonify({'error': 'Not found or not yours'}), 404

@app.route('/api/p2p/messages/<message_id>', methods=['DELETE'])
def p2p_delete_message(message_id):
    """Delete a message."""
    with _p2p_lock:
        if message_id in _p2p_messages:
            del _p2p_messages[message_id]
    return jsonify({'success': True})

@app.route('/api/p2p/messages/<message_id>/react', methods=['POST'])
def p2p_react_message(message_id):
    """Toggle an emoji reaction on a message."""
    data = request.json or {}
    device_id = data.get('device_id', '')
    emoji = data.get('emoji', '')
    if not device_id or not emoji:
        return jsonify({'error': 'device_id and emoji required'}), 400
    with _p2p_lock:
        msg = _p2p_messages.get(message_id)
        if not msg:
            return jsonify({'error': 'Not found'}), 404
        if 'reactions' not in msg:
            msg['reactions'] = {}
        # Toggle: if same emoji already set by this device, remove it
        if msg['reactions'].get(device_id) == emoji:
            del msg['reactions'][device_id]
        else:
            msg['reactions'][device_id] = emoji
    return jsonify({'success': True})

@app.route('/api/p2p/typing', methods=['POST'])
def p2p_typing():
    """Signal that a device is typing to a specific recipient."""
    data = request.get_json(force=True)
    sender_id = data.get('sender_id')
    recipient_id = data.get('recipient_id')
    if sender_id and recipient_id:
        with _p2p_lock:
            _p2p_typing[sender_id] = {'recipient_id': recipient_id, 'timestamp': time.time()}
    return jsonify({'success': True})

@app.route('/api/p2p/typing/<device_id>')
def p2p_is_typing(device_id):
    """Check if anyone is typing to the given device_id. Returns typing sender(s) within last 4 seconds."""
    now = time.time()
    typers = []
    with _p2p_lock:
        for sender_id, info in list(_p2p_typing.items()):
            if info['recipient_id'] == device_id and now - info['timestamp'] < 4:
                dev = _p2p_devices.get(sender_id, {})
                typers.append({'device_id': sender_id, 'name': dev.get('name', 'Someone')})
            elif now - info['timestamp'] >= 4:
                del _p2p_typing[sender_id]
    return jsonify({'typing': typers})

@app.route('/api/p2p/audio/convert/<message_id>')
def p2p_audio_convert(message_id):
    """Convert a voice message to mp4/aac for iOS compatibility.
    Desktop Chrome records audio/webm which iOS Safari cannot decode.
    This endpoint transcodes the audio on-the-fly using ffmpeg (bundled via imageio-ffmpeg).
    """
    with _p2p_lock:
        msg = _p2p_messages.get(message_id)
        if not msg:
            return jsonify({'error': 'Message not found'}), 404
        media_data = msg.get('media_data')
        media_type = msg.get('media_type', '')
        if not media_data:
            return jsonify({'error': 'No audio data'}), 400

    # If already mp4/aac, just return as-is
    if 'mp4' in media_type or 'aac' in media_type or 'm4a' in media_type:
        audio_bytes = base64.b64decode(media_data)
        return app.response_class(audio_bytes, mimetype='audio/mp4',
                                  headers={'Cache-Control': 'max-age=3600'})

    try:
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return jsonify({'error': 'ffmpeg not available'}), 500

    # Decode base64 audio, write to temp file, convert with ffmpeg, return mp4
    try:
        audio_bytes = base64.b64decode(media_data)
        # Determine input extension from media_type
        ext = '.webm'
        if 'ogg' in media_type:
            ext = '.ogg'

        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp_in:
            tmp_in.write(audio_bytes)
            tmp_in_path = tmp_in.name

        tmp_out_path = tmp_in_path.replace(ext, '.m4a')

        # Convert to AAC in M4A container — universally playable
        result = subprocess.run([
            ffmpeg_exe, '-y', '-i', tmp_in_path,
            '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
            tmp_out_path
        ], capture_output=True, timeout=30)

        if result.returncode != 0:
            return jsonify({'error': 'Conversion failed', 'detail': result.stderr.decode(errors='replace')[:200]}), 500

        with open(tmp_out_path, 'rb') as f:
            converted = f.read()

        # Cache the converted version back into the message
        converted_b64 = base64.b64encode(converted).decode()
        with _p2p_lock:
            if message_id in _p2p_messages:
                _p2p_messages[message_id]['media_data'] = converted_b64
                _p2p_messages[message_id]['media_type'] = 'audio/mp4'

        # Clean up temp files
        try:
            os.remove(tmp_in_path)
            os.remove(tmp_out_path)
        except:
            pass

        return app.response_class(converted, mimetype='audio/mp4',
                                  headers={'Cache-Control': 'max-age=3600'})
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Conversion timed out'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/p2p/qr')
def p2p_qr():
    """Generate QR code pointing to the browser Share tab for easy pairing."""
    ip = server_ip or get_local_ip()
    protocol = 'https' if ssl_enabled else 'http'
    url = f"{protocol}://{ip}:{server_port}/browser?tab=share"
    q = qrcode.QRCode(version=1, error_correction=qrcode.constants.ERROR_CORRECT_L,
                       box_size=8, border=3)
    q.add_data(url)
    q.make(fit=True)
    img = q.make_image(fill_color="black", back_color="white")
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)  # Seek to beginning of buffer before reading
    qr_b64 = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    return jsonify({'qr': qr_b64, 'url': url})

# ═══════════════════════════════════════════════════════════════
# TRANSFER REQUESTS — Accept/Reject Pattern
# ═══════════════════════════════════════════════════════════════

@app.route('/api/p2p/incoming-requests')
def p2p_incoming_requests():
    """Get pending transfer requests for a device."""
    device_id = request.args.get('device_id', '')
    if not device_id:
        return jsonify({'error': 'Missing device_id'}), 400
    
    with _p2p_lock:
        reqs = [r for r in _p2p_requests.values() 
                if r['recipient_id'] == device_id and r['status'] == 'pending']
    
    # Remove sensitive path info
    safe = [{k: v for k, v in r.items() if k != 'path'} for r in reqs]
    safe.sort(key=lambda x: x['created'], reverse=True)
    return jsonify({'requests': safe})

@app.route('/api/p2p/accept-transfer', methods=['POST'])
def p2p_accept_transfer():
    """Accept a transfer request and make file available for download."""
    data = request.get_json()
    request_id = data.get('request_id', '')
    
    with _p2p_lock:
        req = _p2p_requests.get(request_id)
        if not req:
            return jsonify({'error': 'Request not found'}), 404
        
        if req['status'] != 'pending':
            return jsonify({'error': 'Request already processed'}), 400
        
        # Move to shared files
        file_id = req['file_id']
        _p2p_files[file_id] = {
            'id': file_id,
            'name': req['name'],
            'size': req['size'],
            'sender_id': req['sender_id'],
            'sender_name': req['sender_name'],
            'ts': time.time(),
            'path': req['path']
        }
        
        # Mark request as accepted
        req['status'] = 'accepted'
    
    return jsonify({'success': True, 'file_id': file_id})

@app.route('/api/p2p/reject-transfer', methods=['POST'])
def p2p_reject_transfer():
    """Reject a transfer request and delete the file."""
    data = request.get_json()
    request_id = data.get('request_id', '')
    
    with _p2p_lock:
        req = _p2p_requests.pop(request_id, None)
        if not req:
            return jsonify({'error': 'Request not found'}), 404
        
        # Delete the file
        if os.path.exists(req['path']):
            try:
                os.remove(req['path'])
            except:
                pass
    
    return jsonify({'success': True})

@app.route('/api/preview')
def preview_file():
    """Serve a file inline for preview (images, audio, video) — no attachment header."""
    filepath = request.args.get('path', '')
    if not filepath:
        return jsonify({'error': 'Missing path'}), 400
    filepath = os.path.normpath(filepath)
    if not os.path.isfile(filepath):
        return jsonify({'error': 'File not found'}), 404
    user_home = str(Path.home())
    shared_norm = os.path.normpath(shared_directory) if shared_directory else None
    in_shared = shared_norm and (filepath == shared_norm or filepath.startswith(shared_norm + os.sep))
    in_home = filepath.startswith(user_home)
    if not (in_shared or in_home):
        return jsonify({'error': 'Access denied'}), 403
    return send_file(filepath, as_attachment=False)

@app.route('/api/p2p/preview/<file_id>')
def p2p_preview(file_id):
    """Serve a P2P shared file inline for preview."""
    with _p2p_lock:
        entry = _p2p_files.get(file_id)
    if not entry or not os.path.exists(entry['path']):
        return jsonify({'error': 'File not found'}), 404
    return send_file(entry['path'], as_attachment=False)


# ═══════════════════════════════════════════════════════════════════
# CALLS — WebRTC Signaling
# ═══════════════════════════════════════════════════════════════════

@app.route('/api/calls/initiate', methods=['POST'])
def call_initiate():
    """Start a new call (1-on-1 or group). Sends invite signal to all targets."""
    data = request.json or {}
    initiator_id = data.get('initiator_id', '')
    target_ids = data.get('target_ids', [])       # list of device_ids to call
    call_type = data.get('call_type', 'audio')     # 'audio' or 'video'
    group_id = data.get('group_id', '')            # optional, for group calls
    initiator_name = data.get('initiator_name', 'Unknown')

    if not initiator_id or not target_ids:
        return jsonify({'error': 'initiator_id and target_ids required'}), 400
    # Gate group calls behind premium
    if group_id:
        gate = _require_premium(initiator_id, 'Group Calls')
        if gate: return gate

    call_id = str(uuid.uuid4())[:12]
    participants = {initiator_id: {'status': 'connected', 'joined_at': time.time()}}
    for tid in target_ids:
        participants[tid] = {'status': 'ringing', 'joined_at': None}

    with _calls_lock:
        _calls[call_id] = {
            'id': call_id,
            'type': call_type,
            'initiator_id': initiator_id,
            'initiator_name': initiator_name,
            'participants': participants,
            'created': time.time(),
            'ended': None,
            'group_id': group_id
        }
        # Send invite signal to each target
        for tid in target_ids:
            if tid not in _call_signals:
                _call_signals[tid] = []
            _call_signals[tid].append({
                'from_id': initiator_id,
                'from_name': initiator_name,
                'type': 'call-invite',
                'call_id': call_id,
                'call_type': call_type,
                'group_id': group_id,
                'participants': list(participants.keys()),
                'ts': time.time()
            })

    return jsonify({'success': True, 'call_id': call_id})

@app.route('/api/calls/<call_id>/answer', methods=['POST'])
def call_answer(call_id):
    """Accept an incoming call."""
    data = request.json or {}
    device_id = data.get('device_id', '')
    if not device_id:
        return jsonify({'error': 'device_id required'}), 400

    with _calls_lock:
        call = _calls.get(call_id)
        if not call:
            return jsonify({'error': 'Call not found'}), 404
        if device_id in call['participants']:
            call['participants'][device_id]['status'] = 'connected'
            call['participants'][device_id]['joined_at'] = time.time()
            # Notify initiator
            init_id = call['initiator_id']
            if init_id not in _call_signals:
                _call_signals[init_id] = []
            _call_signals[init_id].append({
                'from_id': device_id,
                'type': 'call-accepted',
                'call_id': call_id,
                'ts': time.time()
            })
    return jsonify({'success': True})

@app.route('/api/calls/<call_id>/reject', methods=['POST'])
def call_reject(call_id):
    """Reject/decline an incoming call."""
    data = request.json or {}
    device_id = data.get('device_id', '')
    if not device_id:
        return jsonify({'error': 'device_id required'}), 400

    with _calls_lock:
        call = _calls.get(call_id)
        if not call:
            return jsonify({'error': 'Call not found'}), 404
        if device_id in call['participants']:
            call['participants'][device_id]['status'] = 'rejected'
            init_id = call['initiator_id']
            if init_id not in _call_signals:
                _call_signals[init_id] = []
            _call_signals[init_id].append({
                'from_id': device_id,
                'type': 'call-rejected',
                'call_id': call_id,
                'ts': time.time()
            })
        # If all non-initiator rejected, end call
        non_init = {k: v for k, v in call['participants'].items() if k != call['initiator_id']}
        if all(v['status'] == 'rejected' for v in non_init.values()):
            call['ended'] = time.time()
    return jsonify({'success': True})

@app.route('/api/calls/<call_id>/end', methods=['POST'])
def call_end(call_id):
    """End a call for all participants."""
    data = request.json or {}
    device_id = data.get('device_id', '')
    with _calls_lock:
        call = _calls.get(call_id)
        if not call:
            return jsonify({'error': 'Call not found'}), 404
        call['ended'] = time.time()
        # Signal all participants
        for pid in call['participants']:
            if pid != device_id:
                if pid not in _call_signals:
                    _call_signals[pid] = []
                _call_signals[pid].append({
                    'from_id': device_id,
                    'type': 'call-end',
                    'call_id': call_id,
                    'ts': time.time()
                })
    return jsonify({'success': True})

@app.route('/api/calls/signal', methods=['POST'])
def call_signal():
    """Send a WebRTC signal (offer/answer/ice-candidate) to another device."""
    data = request.json or {}
    from_id = data.get('from_id', '')
    to_id = data.get('to_id', '')
    signal_type = data.get('signal_type', '')   # 'offer', 'answer', 'ice-candidate'
    payload = data.get('payload', {})
    call_id = data.get('call_id', '')

    if not from_id or not to_id or not signal_type:
        return jsonify({'error': 'from_id, to_id, signal_type required'}), 400

    with _calls_lock:
        if to_id not in _call_signals:
            _call_signals[to_id] = []
        _call_signals[to_id].append({
            'from_id': from_id,
            'type': signal_type,
            'call_id': call_id,
            'payload': payload,
            'ts': time.time()
        })
    return jsonify({'success': True})

@app.route('/api/calls/signals/<device_id>')
def call_get_signals(device_id):
    """Poll for pending WebRTC signals for a device. Clears after read."""
    with _calls_lock:
        signals = _call_signals.pop(device_id, [])
    return jsonify({'signals': signals})

# ── Video relay (fallback when WebRTC peer-to-peer fails) ──
_video_relay_log_ts = {}  # rate-limit logging

@app.route('/api/calls/video-frame', methods=['POST'])
def video_relay_push():
    """Receive a JPEG video frame from a client for server-side relay."""
    call_id = request.form.get('call_id', '')
    device_id = request.form.get('device_id', '')
    frame = request.files.get('frame')
    if not call_id or not device_id or not frame:
        return jsonify({'error': 'missing params'}), 400
    frame_data = frame.read()
    with _calls_lock:
        if call_id not in _video_relay:
            _video_relay[call_id] = {}
        _video_relay[call_id][device_id] = {
            'data': frame_data,
            'ts': time.time()
        }
    # Log once per device per 5s to avoid spam
    key = f'push-{call_id}-{device_id}'
    now = time.time()
    if key not in _video_relay_log_ts or now - _video_relay_log_ts[key] > 5:
        _video_relay_log_ts[key] = now
        print(f'[VIDEO-RELAY] Push frame from {device_id} ({len(frame_data)} bytes) call={call_id[:8]}')
    return jsonify({'ok': True})

@app.route('/api/calls/video-frame/<call_id>/<device_id>')
def video_relay_pull(call_id, device_id):
    """Get the latest video frame from a device in a call."""
    with _calls_lock:
        bucket = _video_relay.get(call_id, {})
        entry = bucket.get(device_id)
    if entry and time.time() - entry['ts'] < 5:
        # Log once per request target per 5s
        key = f'pull-{call_id}-{device_id}'
        now = time.time()
        if key not in _video_relay_log_ts or now - _video_relay_log_ts[key] > 5:
            _video_relay_log_ts[key] = now
            print(f'[VIDEO-RELAY] Pull frame for {device_id} ({len(entry["data"])} bytes) call={call_id[:8]}')
        return Response(entry['data'], mimetype='image/jpeg',
                        headers={'Cache-Control': 'no-store'})
    return '', 204

@app.route('/api/calls/video-relay-stop', methods=['POST'])
def video_relay_stop():
    """Clean up relay data when a call ends."""
    data = request.json or {}
    call_id = data.get('call_id', '')
    print(f'[VIDEO-RELAY] Stop relay for call={call_id[:8] if call_id else "?"}')
    with _calls_lock:
        _video_relay.pop(call_id, None)
        _audio_relay.pop(call_id, None)
        _audio_relay_seq.pop(call_id, None)
    return jsonify({'ok': True})

# ── Audio relay (fallback when WebRTC peer-to-peer fails) ──
from collections import deque as _deque

@app.route('/api/calls/audio-chunk', methods=['POST'])
def audio_relay_push():
    """Receive an audio chunk from a client for server-side relay."""
    call_id = request.form.get('call_id', '')
    device_id = request.form.get('device_id', '')
    chunk = request.files.get('chunk')
    if not call_id or not device_id or not chunk:
        return jsonify({'error': 'missing params'}), 400
    chunk_data = chunk.read()
    with _calls_lock:
        if call_id not in _audio_relay:
            _audio_relay[call_id] = {}
            _audio_relay_seq[call_id] = {}
        if device_id not in _audio_relay[call_id]:
            _audio_relay[call_id][device_id] = _deque(maxlen=50)  # ~10s of 200ms chunks
            _audio_relay_seq[call_id][device_id] = 0
        seq = _audio_relay_seq[call_id][device_id]
        _audio_relay[call_id][device_id].append({
            'data': chunk_data, 'seq': seq, 'ts': time.time()
        })
        _audio_relay_seq[call_id][device_id] = seq + 1
    return jsonify({'ok': True})

@app.route('/api/calls/audio-chunk/<call_id>/<device_id>')
def audio_relay_pull(call_id, device_id):
    """Get queued audio chunks from a device. Returns newest chunk only."""
    after_seq = int(request.args.get('after', -1))
    with _calls_lock:
        bucket = _audio_relay.get(call_id, {})
        chunks = bucket.get(device_id)
    if not chunks:
        return jsonify({'chunks': []})
    import base64
    result = []
    for c in chunks:
        if c['seq'] > after_seq and time.time() - c['ts'] < 5:
            result.append({'seq': c['seq'], 'data': base64.b64encode(c['data']).decode()})
    return jsonify({'chunks': result})

@app.route('/api/calls/active/<device_id>')
def call_get_active(device_id):
    """Get active calls involving this device."""
    now = time.time()
    active = []
    with _calls_lock:
        for call in _calls.values():
            if call['ended']:
                continue
            if device_id in call['participants']:
                # Prune stale calls (older than 2 minutes with no connected participant, or 2 hours old)
                if now - call['created'] > 7200:
                    call['ended'] = now
                    continue
                active.append(call)
    return jsonify({'calls': active})

@app.route('/api/calls/history/<device_id>')
def call_history(device_id):
    """Get call history for a device."""
    history = []
    with _calls_lock:
        for call in _calls.values():
            if device_id in call['participants']:
                history.append({
                    'id': call['id'],
                    'type': call['type'],
                    'initiator_id': call['initiator_id'],
                    'initiator_name': call.get('initiator_name', 'Unknown'),
                    'participants': {k: v['status'] for k, v in call['participants'].items()},
                    'created': call['created'],
                    'ended': call['ended'],
                    'group_id': call.get('group_id', '')
                })
    history.sort(key=lambda x: x['created'], reverse=True)
    return jsonify({'history': history[:50]})


@app.route('/api/calls/group/active/<group_id>')
def call_group_active(group_id):
    """Get active (non-ended) group call for this group."""
    with _calls_lock:
        for call in _calls.values():
            if call.get('group_id') == group_id and not call['ended']:
                connected = [pid for pid, p in call['participants'].items() if p['status'] == 'connected']
                return jsonify({
                    'active': True,
                    'call_id': call['id'],
                    'call_type': call['type'],
                    'initiator_id': call['initiator_id'],
                    'initiator_name': call.get('initiator_name', 'Unknown'),
                    'participants': {k: v['status'] for k, v in call['participants'].items()},
                    'connected': connected,
                    'created': call['created']
                })
    return jsonify({'active': False})


@app.route('/api/calls/<call_id>/join', methods=['POST'])
def call_join(call_id):
    """Join an existing group call (late join). Signals all connected members."""
    data = request.json or {}
    device_id = data.get('device_id', '')
    device_name = data.get('device_name', 'Unknown')
    if not device_id:
        return jsonify({'error': 'device_id required'}), 400

    with _calls_lock:
        call = _calls.get(call_id)
        if not call:
            return jsonify({'error': 'Call not found'}), 404
        if call['ended']:
            return jsonify({'error': 'Call already ended'}), 400

        call['participants'][device_id] = {'status': 'connected', 'joined_at': time.time()}
        # Signal everyone already in the call about the new participant
        connected = [pid for pid, p in call['participants'].items()
                     if p['status'] == 'connected' and pid != device_id]
        for pid in connected:
            if pid not in _call_signals:
                _call_signals[pid] = []
            _call_signals[pid].append({
                'from_id': device_id,
                'from_name': device_name,
                'type': 'group-call-join',
                'call_id': call_id,
                'call_type': call.get('type', 'audio'),
                'ts': time.time()
            })
    return jsonify({'success': True, 'connected': connected})


@app.route('/api/calls/<call_id>/leave', methods=['POST'])
def call_leave(call_id):
    """Leave a group call without ending it for others."""
    data = request.json or {}
    device_id = data.get('device_id', '')
    if not device_id:
        return jsonify({'error': 'device_id required'}), 400

    with _calls_lock:
        call = _calls.get(call_id)
        if not call:
            return jsonify({'error': 'Call not found'}), 404

        if device_id in call['participants']:
            call['participants'][device_id]['status'] = 'left'

        # Signal others about departure
        remaining = [pid for pid, p in call['participants'].items()
                     if p['status'] == 'connected' and pid != device_id]
        for pid in remaining:
            if pid not in _call_signals:
                _call_signals[pid] = []
            _call_signals[pid].append({
                'from_id': device_id,
                'type': 'group-call-leave',
                'call_id': call_id,
                'ts': time.time()
            })

        # Auto-end if nobody left
        if len(remaining) == 0:
            call['ended'] = time.time()

    return jsonify({'success': True})


# ═══════════════════════════════════════════════════════════════════
# GROUPS — Private Group Chat
# ═══════════════════════════════════════════════════════════════════

@app.route('/api/groups', methods=['POST'])
def group_create():
    """Create a new group."""
    data = request.json or {}
    name = data.get('name', '').strip()
    creator_id = data.get('creator_id', '')
    creator_name = data.get('creator_name', 'Unknown')
    members = data.get('members', [])           # list of device_ids
    description = data.get('description', '')
    avatar = data.get('avatar', '')             # base64 image

    if not name or not creator_id:
        return jsonify({'error': 'name and creator_id required'}), 400

    group_id = 'grp-' + str(uuid.uuid4())[:8]
    all_members = list(set([creator_id] + members))

    with _groups_lock:
        _groups[group_id] = {
            'id': group_id,
            'name': name[:100],
            'avatar': avatar,
            'creator_id': creator_id,
            'creator_name': creator_name,
            'admins': [creator_id],
            'members': all_members,
            'created': time.time(),
            'description': description[:500]
        }
    _save_groups()
    return jsonify({'success': True, 'group': _groups[group_id]})

@app.route('/api/groups/<group_id>', methods=['GET'])
def group_get(group_id):
    """Get group info."""
    with _groups_lock:
        group = _groups.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404
    return jsonify({'group': group})

@app.route('/api/groups/<group_id>', methods=['DELETE'])
def group_delete(group_id):
    """Delete a group (creator only)."""
    device_id = request.args.get('device_id', '')
    with _groups_lock:
        group = _groups.get(group_id)
        if not group:
            return jsonify({'error': 'Group not found'}), 404
        if device_id != group.get('creator_id', ''):
            return jsonify({'error': 'Only the group creator can delete this group'}), 403
        del _groups[group_id]
    # Clean up group messages
    with _p2p_lock:
        to_remove = [mid for mid, m in _group_messages.items() if m.get('group_id') == group_id]
        for mid in to_remove:
            del _group_messages[mid]
    _save_groups()
    return jsonify({'success': True})

@app.route('/api/groups/<group_id>', methods=['PUT'])
def group_update(group_id):
    """Update group info (admin only)."""
    data = request.json or {}
    device_id = data.get('device_id', '')

    with _groups_lock:
        group = _groups.get(group_id)
        if not group:
            return jsonify({'error': 'Group not found'}), 404
        if device_id not in group['admins']:
            return jsonify({'error': 'Admin only'}), 403
        if 'name' in data:
            group['name'] = data['name'][:100]
        if 'description' in data:
            group['description'] = data['description'][:500]
        if 'avatar' in data:
            group['avatar'] = data['avatar']
    _save_groups()
    return jsonify({'success': True, 'group': group})

@app.route('/api/groups/<group_id>/members', methods=['POST'])
def group_add_member(group_id):
    """Add members to a group (admin only)."""
    data = request.json or {}
    device_id = data.get('device_id', '')
    new_members = data.get('members', [])

    with _groups_lock:
        group = _groups.get(group_id)
        if not group:
            return jsonify({'error': 'Group not found'}), 404
        if device_id not in group['admins']:
            return jsonify({'error': 'Admin only'}), 403
        for m in new_members:
            if m not in group['members']:
                group['members'].append(m)
    _save_groups()
    return jsonify({'success': True, 'members': group['members']})

@app.route('/api/groups/<group_id>/members/<member_id>', methods=['DELETE'])
def group_remove_member(group_id, member_id):
    """Remove member from group (admin or self-leave)."""
    device_id = request.args.get('device_id', '')

    with _groups_lock:
        group = _groups.get(group_id)
        if not group:
            return jsonify({'error': 'Group not found'}), 404
        # Admin can remove anyone, member can remove self
        if device_id not in group['admins'] and device_id != member_id:
            return jsonify({'error': 'Not authorized'}), 403
        if member_id in group['members']:
            group['members'].remove(member_id)
        if member_id in group['admins']:
            group['admins'].remove(member_id)
        # If no members left, delete group
        if not group['members']:
            del _groups[group_id]
            _save_groups()
            return jsonify({'success': True, 'deleted': True})
    _save_groups()
    return jsonify({'success': True})

@app.route('/api/groups/<group_id>/admins', methods=['POST'])
def group_make_admin(group_id):
    """Promote a member to admin."""
    data = request.json or {}
    device_id = data.get('device_id', '')
    target_id = data.get('target_id', '')

    with _groups_lock:
        group = _groups.get(group_id)
        if not group:
            return jsonify({'error': 'Group not found'}), 404
        if device_id not in group['admins']:
            return jsonify({'error': 'Admin only'}), 403
        if target_id in group['members'] and target_id not in group['admins']:
            group['admins'].append(target_id)
    _save_groups()
    return jsonify({'success': True})

@app.route('/api/groups/list/<device_id>')
def group_list(device_id):
    """Get all groups a device belongs to."""
    result = []
    with _groups_lock:
        for g in _groups.values():
            if device_id in g['members']:
                # Get last message for preview
                last_msg = None
                with _p2p_lock:
                    grp_msgs = [m for m in _group_messages.values() if m['group_id'] == g['id']]
                    if grp_msgs:
                        grp_msgs.sort(key=lambda x: x['timestamp'])
                        last = grp_msgs[-1]
                        last_msg = {'text': last.get('text', '')[:80], 'sender_name': last.get('sender_name', ''), 'timestamp': last['timestamp']}
                result.append({
                    'id': g['id'],
                    'name': g['name'],
                    'avatar': g.get('avatar', ''),
                    'members_count': len(g['members']),
                    'last_message': last_msg
                })
    result.sort(key=lambda x: (x['last_message'] or {}).get('timestamp', 0), reverse=True)
    return jsonify({'groups': result})

@app.route('/api/groups/<group_id>/messages', methods=['POST'])
def group_send_message(group_id):
    """Send a message to a group."""
    data = request.json or {}
    sender_id = data.get('sender_id', '')
    sender_name = data.get('sender_name', 'User')
    text = data.get('text', '').strip()
    media_data = data.get('media_data', None)
    media_type = data.get('media_type', '')
    file_name = data.get('file_name', '')
    reply_to = data.get('reply_to', '')

    with _groups_lock:
        group = _groups.get(group_id)
        if not group:
            return jsonify({'error': 'Group not found'}), 404
        if sender_id not in group['members']:
            return jsonify({'error': 'Not a member'}), 403

    if not text and not media_data:
        return jsonify({'error': 'Message or media required'}), 400

    reply_to_data = None
    if reply_to:
        with _p2p_lock:
            replied = _group_messages.get(reply_to)
            if replied:
                reply_to_data = {
                    'id': reply_to,
                    'sender_name': replied.get('sender_name', ''),
                    'text': (replied.get('text', '') or '')[:120],
                }

    msg_id = 'gm-' + str(uuid.uuid4())[:10]
    with _p2p_lock:
        _group_messages[msg_id] = {
            'id': msg_id,
            'group_id': group_id,
            'sender_id': sender_id,
            'sender_name': sender_name,
            'text': text[:5000],
            'media_data': media_data,
            'media_type': media_type,
            'file_name': file_name,
            'timestamp': time.time(),
            'edited': False,
            'reactions': {},
            'reply_to_data': reply_to_data
        }
    return jsonify({'success': True, 'message_id': msg_id})

@app.route('/api/groups/<group_id>/messages', methods=['GET'])
def group_get_messages(group_id):
    """Get messages for a group."""
    after = float(request.args.get('after', 0))
    device_id = request.args.get('device_id', '')

    with _groups_lock:
        group = _groups.get(group_id)
        if not group:
            return jsonify({'error': 'Group not found'}), 404
        if device_id and device_id not in group['members']:
            return jsonify({'error': 'Not a member'}), 403

    msgs = []
    with _p2p_lock:
        for m in _group_messages.values():
            if m['group_id'] == group_id and m['timestamp'] > after:
                safe = {k: v for k, v in m.items()}
                msgs.append(safe)
    msgs.sort(key=lambda x: x['timestamp'])
    return jsonify({'messages': msgs[-200:]})  # Last 200

@app.route('/api/groups/messages/<message_id>', methods=['PUT'])
def group_edit_message(message_id):
    """Edit a group message."""
    data = request.json or {}
    new_text = data.get('text', '').strip()
    sender_id = data.get('sender_id', '')
    if not new_text:
        return jsonify({'error': 'text required'}), 400
    with _p2p_lock:
        msg = _group_messages.get(message_id)
        if msg and msg['sender_id'] == sender_id:
            msg['text'] = new_text[:5000]
            msg['edited'] = True
            msg['edited_at'] = time.time()
            return jsonify({'success': True})
    return jsonify({'error': 'Not found or not yours'}), 404

@app.route('/api/groups/messages/<message_id>', methods=['DELETE'])
def group_delete_message(message_id):
    """Delete a group message."""
    with _p2p_lock:
        if message_id in _group_messages:
            del _group_messages[message_id]
    return jsonify({'success': True})

@app.route('/api/groups/messages/<message_id>/react', methods=['POST'])
def group_react_message(message_id):
    """React to a group message."""
    data = request.json or {}
    device_id = data.get('device_id', '')
    emoji = data.get('emoji', '')
    if not device_id or not emoji:
        return jsonify({'error': 'device_id and emoji required'}), 400
    with _p2p_lock:
        msg = _group_messages.get(message_id)
        if not msg:
            return jsonify({'error': 'Not found'}), 404
        if 'reactions' not in msg:
            msg['reactions'] = {}
        if msg['reactions'].get(device_id) == emoji:
            del msg['reactions'][device_id]
        else:
            msg['reactions'][device_id] = emoji
    return jsonify({'success': True})


# ═══════════════════════════════════════════════════════════════════
# BOTS & AUTO-CALLBACK
# ═══════════════════════════════════════════════════════════════════

@app.route('/api/bots', methods=['POST'])
def bot_create():
    """Create a new bot."""
    data = request.json or {}
    name = data.get('name', '').strip()
    owner_id = data.get('owner_id', '')
    description = data.get('description', '')
    avatar = data.get('avatar', '')
    commands = data.get('commands', {})         # {"/start": "Welcome!", "/help": "Commands: ..."}
    auto_reply = data.get('auto_reply', '')     # Default reply when no command matches
    callback_enabled = data.get('callback_enabled', False)
    callback_message = data.get('callback_message', 'Thank you for reaching out! We will call you back shortly.')

    if not name or not owner_id:
        return jsonify({'error': 'name and owner_id required'}), 400
    gate = _require_premium(owner_id, 'Custom Bots')
    if gate: return gate

    bot_id = 'bot-' + str(uuid.uuid4())[:8]
    with _bots_lock:
        _bots[bot_id] = {
            'id': bot_id,
            'name': name[:100],
            'owner_id': owner_id,
            'avatar': avatar,
            'description': description[:500],
            'commands': commands,
            'auto_reply': auto_reply[:1000],
            'callback_enabled': callback_enabled,
            'callback_message': callback_message[:1000],
            'created': time.time()
        }
    _save_bots()
    return jsonify({'success': True, 'bot': _bots[bot_id]})

@app.route('/api/bots/<bot_id>', methods=['GET'])
def bot_get(bot_id):
    """Get bot info."""
    with _bots_lock:
        bot = _bots.get(bot_id)
    if not bot:
        return jsonify({'error': 'Bot not found'}), 404
    return jsonify({'bot': bot})

@app.route('/api/bots/<bot_id>', methods=['PUT'])
def bot_update(bot_id):
    """Update a bot (owner only)."""
    data = request.json or {}
    owner_id = data.get('owner_id', '')

    with _bots_lock:
        bot = _bots.get(bot_id)
        if not bot:
            return jsonify({'error': 'Bot not found'}), 404
        if bot['owner_id'] != owner_id:
            return jsonify({'error': 'Owner only'}), 403
        for field in ['name', 'description', 'avatar', 'auto_reply', 'callback_enabled', 'callback_message']:
            if field in data:
                bot[field] = data[field]
        if 'commands' in data:
            bot['commands'] = data['commands']
    _save_bots()
    return jsonify({'success': True, 'bot': bot})

@app.route('/api/bots/<bot_id>', methods=['DELETE'])
def bot_delete(bot_id):
    """Delete a bot (owner only)."""
    owner_id = request.args.get('owner_id', '')
    with _bots_lock:
        bot = _bots.get(bot_id)
        if not bot:
            return jsonify({'error': 'Bot not found'}), 404
        if bot['owner_id'] != owner_id:
            return jsonify({'error': 'Owner only'}), 403
        del _bots[bot_id]
    _save_bots()
    return jsonify({'success': True})

@app.route('/api/bots/list')
def bot_list():
    """List all bots."""
    owner_id = request.args.get('owner_id', '')
    result = []
    with _bots_lock:
        for b in _bots.values():
            result.append({
                'id': b['id'],
                'name': b['name'],
                'description': b['description'],
                'avatar': b.get('avatar', ''),
                'owner_id': b['owner_id'],
                'callback_enabled': b.get('callback_enabled', False),
                'commands_count': len(b.get('commands', {}))
            })
    return jsonify({'bots': result})

@app.route('/api/bots/<bot_id>/message', methods=['POST'])
def bot_message(bot_id):
    """Send a message to a bot — get smart AI-powered reply (child of BEAM AI)."""
    data = request.json or {}
    device_id = data.get('device_id', '')
    device_name = data.get('device_name', 'User')
    text = data.get('text', '').strip()

    with _bots_lock:
        bot = _bots.get(bot_id)
    if not bot:
        return jsonify({'error': 'Bot not found'}), 404

    # Check if text matches an explicit command first
    reply = ''
    if text.startswith('/'):
        cmd = text.split()[0].lower()
        reply = bot.get('commands', {}).get(cmd, '')

    # If no command match, use AI to generate a smart reply (child of BEAM AI)
    if not reply:
        bot_name = bot.get('name', 'Bot')
        bot_desc = bot.get('description', '')
        bot_auto_reply = bot.get('auto_reply', '')

        bot_system_prompt = f"""You are {bot_name}, a smart AI bot created within LocalBeam. You are a child of BEAM AI — inheriting intelligence and helpfulness.

Bot description: {bot_desc}
{('Default personality/role: ' + bot_auto_reply) if bot_auto_reply else ''}

You must stay in character as {bot_name} based on the description above. Be helpful, intelligent, and conversational.
Keep responses concise but thorough. You can handle customer service, answer questions, take orders, provide feedback, and assist with anything described in your role.
Current date/time: {time.strftime('%Y-%m-%d %H:%M %A')}

IMPORTANT: Do NOT include JSON action blocks. Just respond naturally as {bot_name}."""

        # Build conversation context for this bot-user pair
        conv_key = f'bot_{bot_id}_{device_id}'
        with _ai_lock:
            if conv_key not in _ai_conversations:
                _ai_conversations[conv_key] = []
            conv = _ai_conversations[conv_key]

        messages = [{'role': 'system', 'content': bot_system_prompt}]
        for msg in conv[-14:]:
            messages.append({'role': msg['role'], 'content': msg['content']})
        messages.append({'role': 'user', 'content': text})

        reply = _deepseek_chat(messages, max_tokens=512, temperature=0.7)

        # Store conversation history
        with _ai_lock:
            conv.append({'role': 'user', 'content': text, 'timestamp': time.time()})
            conv.append({'role': 'assistant', 'content': reply, 'timestamp': time.time()})
            if len(conv) > 30:
                _ai_conversations[conv_key] = conv[-30:]

    # Send bot reply as a P2P message
    msg_id = 'botmsg-' + str(uuid.uuid4())[:8]
    with _p2p_lock:
        _p2p_messages[msg_id] = {
            'id': msg_id,
            'sender_id': bot_id,
            'sender_name': bot['name'] + ' 🤖',
            'recipient_id': device_id,
            'text': reply,
            'media_data': None,
            'media_type': '',
            'file_name': '',
            'timestamp': time.time(),
            'read': False,
            'edited': False,
            'forwarded_from': '',
            'reply_to_data': None,
            'reactions': {},
            'is_bot': True
        }

    # Schedule callback if enabled
    callback_scheduled = False
    if bot.get('callback_enabled'):
        cb_id = 'cb-' + str(uuid.uuid4())[:8]
        with _bots_lock:
            _bot_callbacks[cb_id] = {
                'id': cb_id,
                'bot_id': bot_id,
                'bot_name': bot['name'],
                'target_device_id': device_id,
                'target_name': device_name,
                'scheduled_at': time.time() + 60,  # 1 minute from now
                'message': bot.get('callback_message', 'We are calling you back!'),
                'original_message': text[:200],
                'status': 'pending',
                'created': time.time()
            }
        callback_scheduled = True

    return jsonify({
        'success': True,
        'reply': reply,
        'message_id': msg_id,
        'callback_scheduled': callback_scheduled
    })

@app.route('/api/bots/callbacks/<device_id>')
def bot_get_callbacks(device_id):
    """Get pending callbacks for a device (from its owned bots)."""
    result = []
    with _bots_lock:
        for cb in _bot_callbacks.values():
            # Show callbacks for bots owned by this device, or targeted to this device
            bot = _bots.get(cb['bot_id'])
            if not bot:
                continue
            if bot['owner_id'] == device_id or cb['target_device_id'] == device_id:
                result.append(cb)
    result.sort(key=lambda x: x['created'], reverse=True)
    return jsonify({'callbacks': result[:50]})

@app.route('/api/bots/callbacks/<callback_id>/execute', methods=['POST'])
def bot_execute_callback(callback_id):
    """Execute a callback (initiate a call to the target)."""
    with _bots_lock:
        cb = _bot_callbacks.get(callback_id)
        if not cb:
            return jsonify({'error': 'Callback not found'}), 404
        bot = _bots.get(cb['bot_id'])
        if not bot:
            return jsonify({'error': 'Bot not found'}), 404
        cb['status'] = 'sent'

    # Send a message to target notifying about the callback
    msg_id = 'cbmsg-' + str(uuid.uuid4())[:8]
    with _p2p_lock:
        _p2p_messages[msg_id] = {
            'id': msg_id,
            'sender_id': cb['bot_id'],
            'sender_name': (bot['name'] if bot else 'Bot') + ' 🤖',
            'recipient_id': cb['target_device_id'],
            'text': f"📞 Callback from {bot['name']}: {cb['message']}",
            'media_data': None,
            'media_type': '',
            'file_name': '',
            'timestamp': time.time(),
            'read': False,
            'edited': False,
            'forwarded_from': '',
            'reply_to_data': None,
            'reactions': {},
            'is_bot': True,
            'is_callback': True
        }

    return jsonify({'success': True, 'message_id': msg_id})


# ═══════════════════════════════════════════════════════════════════
# AI ASSISTANT (DeepSeek-Powered)
# ═══════════════════════════════════════════════════════════════════

@app.route('/api/ai/chat', methods=['POST'])
def ai_chat():
    """Send a message to BEAM AI and get an intelligent response."""
    print(f"[BEAM-AI] /api/ai/chat called from {request.remote_addr}", flush=True)
    data = request.json or {}
    owner_id = data.get('owner_id', '') or data.get('device_id', '')
    text = (data.get('text', '') or data.get('message', '')).strip()
    print(f"[BEAM-AI] owner_id={owner_id}, text={text[:100]!r}", flush=True)
    if not owner_id or not text:
        return jsonify({'error': 'owner_id and text required'}), 400

    # Build conversation context (persistent — last 100 messages)
    with _ai_lock:
        if owner_id not in _ai_conversations:
            _ai_conversations[owner_id] = []
        conv = _ai_conversations[owner_id]

    # Get/create user profile for adaptive learning
    profile = _get_user_profile(owner_id)

    # Build context about user's current tasks and reminders
    user_tasks = [t for t in _ai_tasks.values() if t.get('owner_id') == owner_id and t.get('status') != 'completed']
    user_reminders = [r for r in _ai_reminders.values() if r.get('owner_id') == owner_id and r.get('status') == 'active']

    context_info = f"\n\nCurrent date/time: {time.strftime('%Y-%m-%d %H:%M %A')}"

    # Inject user profile for personalization
    context_info += f"\n\n--- USER PROFILE (adapt your responses based on this) ---"
    if profile.get('name'):
        context_info += f"\nUser's name: {profile['name']}"
    if profile.get('personality_traits'):
        context_info += f"\nPersonality: {', '.join(profile['personality_traits'])}"
    if profile.get('communication_style') and profile['communication_style'] != 'unknown':
        context_info += f"\nCommunication style: {profile['communication_style']}"
    if profile.get('formality_level'):
        context_info += f"\nFormality: {profile['formality_level']}"
    if profile.get('interests'):
        context_info += f"\nInterests: {', '.join(profile['interests'][:15])}"
    if profile.get('likes'):
        context_info += f"\nLikes: {', '.join(profile['likes'][:10])}"
    if profile.get('dislikes'):
        context_info += f"\nDislikes: {', '.join(profile['dislikes'][:10])}"
    if profile.get('preferred_response_length'):
        context_info += f"\nPreferred response length: {profile['preferred_response_length']}"
    if profile.get('preferred_tone'):
        context_info += f"\nPreferred tone: {profile['preferred_tone']}"
    if profile.get('expertise_areas'):
        context_info += f"\nExpertise: {', '.join(profile['expertise_areas'][:10])}"
    if profile.get('uses_emojis'):
        context_info += f"\nUses emojis: yes (feel free to use them too)"
    if profile.get('memories'):
        recent_memories = profile['memories'][-10:]
        context_info += f"\nKey memories about this user:"
        for mem in recent_memories:
            context_info += f"\n  - {mem.get('text', '')}"
    if profile.get('key_facts'):
        context_info += f"\nKnown facts: {'; '.join(profile['key_facts'][:10])}"
    context_info += f"\nTotal interactions: {profile.get('interaction_count', 0)}"
    context_info += f"\n--- END PROFILE ---"

    if user_tasks:
        context_info += f"\nUser's active tasks ({len(user_tasks)}):"
        for t in user_tasks[:10]:
            context_info += f"\n- [{t.get('priority','medium')}] {t.get('title','')} (due: {t.get('due_date','unset')} {t.get('due_time','')})"
    if user_reminders:
        context_info += f"\nUser's active reminders ({len(user_reminders)}):"
        for r in user_reminders[:5]:
            context_info += f"\n- {r.get('text','')} (at: {r.get('remind_at','unset')})"

    # Get delegation status
    deleg = _ai_delegation.get(owner_id, {})
    if deleg.get('enabled'):
        context_info += "\nChat delegation is ACTIVE — you are auto-replying to messages on the owner's behalf."

    # Check for highlighted text context
    highlighted = data.get('highlighted_text', '')
    context_from = data.get('context_from', '')
    if highlighted:
        context_info += f"\n\n[USER HIGHLIGHTED THIS TEXT FROM A PREVIOUS RESPONSE]: \"{highlighted}\""
        if context_from:
            context_info += f"\n[ORIGINAL MESSAGE CONTEXT]: \"{context_from}\""
        context_info += "\nThe user wants to discuss this specific highlighted text further. Focus your response on this highlighted portion."

    messages = [{'role': 'system', 'content': AI_SYSTEM_PROMPT + context_info}]

    # Add conversation history (more context for smarter responses)
    # Filter out any error/fallback replies that polluted the history
    _SKIP_PATTERNS = ('I\'m temporarily unable to process', 'I\'m having trouble connecting to my AI brain')
    for msg in conv[-30:]:
        if msg['role'] == 'assistant' and any(msg['content'].startswith(p) for p in _SKIP_PATTERNS):
            continue  # skip error replies from history
        messages.append({'role': msg['role'], 'content': msg['content']})

    messages.append({'role': 'user', 'content': text})

    # Call DeepSeek
    reply = _deepseek_chat(messages, max_tokens=2048)

    # Don't save error/fallback messages to conversation history — they pollute context
    _ERROR_REPLIES = (
        "I'm temporarily unable to process your request",
        "I'm having trouble connecting to my AI brain",
    )
    is_error_reply = any(reply.startswith(e) for e in _ERROR_REPLIES)

    # Store in conversation history and persist (skip error replies)
    with _ai_lock:
        conv.append({'role': 'user', 'content': text, 'timestamp': time.time()})
        if not is_error_reply:
            conv.append({'role': 'assistant', 'content': reply, 'timestamp': time.time()})
        # Keep last 100 messages for deep memory
        if len(conv) > 100:
            _ai_conversations[owner_id] = conv[-100:]
    _save_ai_conversations()

    # Learn from this exchange
    try:
        _update_user_profile_from_exchange(owner_id, text, reply)
    except Exception as e:
        print(f"Profile update error: {e}")

    # Parse any action blocks from the reply
    actions_taken = []
    import re
    json_blocks = re.findall(r'```json\s*(\{.*?\})\s*```', reply, re.DOTALL)
    web_search_needed = False
    search_query = ''
    for block in json_blocks:
        try:
            action = json.loads(block)
            act_type = action.get('action', '')

            if act_type == 'create_task':
                task_id = 'task-' + str(uuid.uuid4())[:8]
                task = {
                    'id': task_id,
                    'owner_id': owner_id,
                    'title': action.get('title', 'Untitled'),
                    'description': action.get('description', ''),
                    'due_date': action.get('due_date', ''),
                    'due_time': action.get('due_time', ''),
                    'category': action.get('category', 'other'),
                    'priority': action.get('priority', 'medium'),
                    'status': 'pending',
                    'created': time.time(),
                    'completed_at': None
                }
                with _ai_lock:
                    _ai_tasks[task_id] = task
                _save_ai_tasks()
                actions_taken.append({'type': 'task_created', 'task': task})

            elif act_type == 'create_reminder':
                rem_id = 'rem-' + str(uuid.uuid4())[:8]
                reminder = {
                    'id': rem_id,
                    'owner_id': owner_id,
                    'text': action.get('text', 'Reminder'),
                    'remind_at': action.get('remind_at', ''),
                    'repeat': action.get('repeat', 'none'),
                    'status': 'active',
                    'created': time.time()
                }
                with _ai_lock:
                    _ai_reminders[rem_id] = reminder
                _save_ai_reminders()
                actions_taken.append({'type': 'reminder_created', 'reminder': reminder})

            elif act_type == 'web_search':
                web_search_needed = True
                search_query = action.get('query', text)
                actions_taken.append({'type': 'web_search', 'query': search_query})

            elif act_type == 'get_weather':
                # Use web search for real weather
                web_search_needed = True
                search_query = f"weather {action.get('location', '')} today"
                actions_taken.append({'type': 'web_search', 'query': search_query})

            elif act_type == 'remember':
                # AI wants to remember something about the user
                key = action.get('key', '')
                value = action.get('value', '')
                category = action.get('category', 'fact')
                if key and value:
                    profile = _get_user_profile(owner_id)
                    if category == 'preference':
                        if value not in profile.get('likes', []):
                            profile.setdefault('likes', []).append(value)
                    elif category == 'dislike':
                        if value not in profile.get('dislikes', []):
                            profile.setdefault('dislikes', []).append(value)
                    elif category == 'interest':
                        if value not in profile.get('interests', []):
                            profile.setdefault('interests', []).append(value)
                    elif category == 'personality':
                        if value not in profile.get('personality_traits', []):
                            profile.setdefault('personality_traits', []).append(value)
                    elif category == 'fact':
                        profile.setdefault('key_facts', []).append(value)
                        if len(profile['key_facts']) > 50:
                            profile['key_facts'] = profile['key_facts'][-50:]
                    if key == 'name':
                        profile['name'] = value
                    memories = profile.setdefault('memories', [])
                    memories.append({'text': f'{key}: {value}', 'timestamp': time.time(), 'category': category})
                    if len(memories) > 50:
                        profile['memories'] = memories[-50:]
                    _save_ai_profiles()
                    actions_taken.append({'type': 'memory_stored', 'key': key, 'value': value})

        except json.JSONDecodeError:
            pass

    # If AI requested a web search, perform it and get a final answer
    if web_search_needed and search_query:
        search_context = _web_search_context(search_query)
        if search_context:
            # Second-pass: give AI the search results and ask for a final answer
            search_messages = [
                {'role': 'system', 'content': 'You are BEAM AI. You just performed a web search. Use the search results below to give the user an accurate, helpful, up-to-date answer. Be conversational and cite sources when relevant. Do NOT include any JSON action blocks in this response.'},
                {'role': 'user', 'content': f'My original question: {text}{search_context}'}
            ]
            reply = _deepseek_chat(search_messages, max_tokens=1500, temperature=0.5)
            # Update conversation with the better reply
            with _ai_lock:
                if conv and conv[-1]['role'] == 'assistant':
                    conv[-1]['content'] = reply
                    conv[-1]['timestamp'] = time.time()

    # Clean the reply — remove JSON blocks for display
    clean_reply = re.sub(r'```json\s*\{.*?\}\s*```', '', reply, flags=re.DOTALL).strip()
    if not clean_reply:
        clean_reply = reply

    return jsonify({
        'success': True,
        'reply': clean_reply,
        'actions': actions_taken,
        'raw_reply': reply
    })


@app.route('/api/ai/tasks', methods=['GET'])
def ai_get_tasks():
    """Get all tasks for a user."""
    owner_id = request.args.get('owner_id', '') or request.args.get('device_id', '')
    status_filter = request.args.get('status', '')  # 'pending', 'completed', 'all'
    tasks = []
    with _ai_lock:
        for t in _ai_tasks.values():
            if t.get('owner_id') == owner_id:
                if status_filter and status_filter != 'all' and t.get('status') != status_filter:
                    continue
                tasks.append(t)
    tasks.sort(key=lambda x: x.get('created', 0), reverse=True)
    return jsonify({'tasks': tasks})


@app.route('/api/ai/tasks', methods=['POST'])
def ai_create_task():
    """Manually create a task."""
    data = request.json or {}
    owner_id = data.get('owner_id', '') or data.get('device_id', '')
    title = data.get('title', '').strip()
    if not owner_id or not title:
        return jsonify({'error': 'owner_id and title required'}), 400

    task_id = 'task-' + str(uuid.uuid4())[:8]
    task = {
        'id': task_id,
        'owner_id': owner_id,
        'title': title,
        'description': data.get('description', ''),
        'due_date': data.get('due_date', ''),
        'due_time': data.get('due_time', ''),
        'category': data.get('category', 'other'),
        'priority': data.get('priority', 'medium'),
        'status': 'pending',
        'created': time.time(),
        'completed_at': None
    }
    with _ai_lock:
        _ai_tasks[task_id] = task
    _save_ai_tasks()
    return jsonify({'success': True, 'task': task})


@app.route('/api/ai/tasks/<task_id>', methods=['PUT'])
def ai_update_task(task_id):
    """Update a task."""
    data = request.json or {}
    with _ai_lock:
        task = _ai_tasks.get(task_id)
        if not task:
            return jsonify({'error': 'Task not found'}), 404
        for field in ['title', 'description', 'due_date', 'due_time', 'category', 'priority', 'status']:
            if field in data:
                task[field] = data[field]
        if data.get('status') == 'completed' and not task.get('completed_at'):
            task['completed_at'] = time.time()
    _save_ai_tasks()
    return jsonify({'success': True, 'task': task})


@app.route('/api/ai/tasks/<task_id>', methods=['DELETE'])
def ai_delete_task(task_id):
    """Delete a task."""
    with _ai_lock:
        if task_id in _ai_tasks:
            del _ai_tasks[task_id]
    _save_ai_tasks()
    return jsonify({'success': True})


@app.route('/api/ai/reminders', methods=['GET'])
def ai_get_reminders():
    """Get all reminders for a user."""
    owner_id = request.args.get('owner_id', '') or request.args.get('device_id', '')
    reminders = []
    with _ai_lock:
        for r in _ai_reminders.values():
            if r.get('owner_id') == owner_id:
                reminders.append(r)
    reminders.sort(key=lambda x: x.get('created', 0), reverse=True)
    return jsonify({'reminders': reminders})


@app.route('/api/ai/reminders', methods=['POST'])
def ai_create_reminder():
    """Manually create a reminder."""
    data = request.json or {}
    owner_id = data.get('owner_id', '') or data.get('device_id', '')
    text = data.get('text', '').strip()
    if not owner_id or not text:
        return jsonify({'error': 'owner_id and text required'}), 400

    rem_id = 'rem-' + str(uuid.uuid4())[:8]
    reminder = {
        'id': rem_id,
        'owner_id': owner_id,
        'text': text,
        'remind_at': data.get('remind_at', ''),
        'repeat': data.get('repeat', 'none'),
        'status': 'active',
        'created': time.time()
    }
    with _ai_lock:
        _ai_reminders[rem_id] = reminder
    _save_ai_reminders()
    return jsonify({'success': True, 'reminder': reminder})


@app.route('/api/ai/reminders/<rem_id>', methods=['DELETE'])
def ai_delete_reminder(rem_id):
    """Delete a reminder."""
    with _ai_lock:
        if rem_id in _ai_reminders:
            del _ai_reminders[rem_id]
    _save_ai_reminders()
    return jsonify({'success': True})


@app.route('/api/ai/delegation', methods=['GET'])
def ai_get_delegation():
    """Get delegation settings for a user."""
    owner_id = request.args.get('owner_id', '') or request.args.get('device_id', '')
    with _ai_lock:
        deleg = _ai_delegation.get(owner_id, {'enabled': False, 'auto_reply_to': [], 'style': 'professional', 'rules': ''})
    return jsonify({'delegation': deleg})


@app.route('/api/ai/delegation', methods=['POST'])
def ai_set_delegation():
    """Update delegation settings."""
    data = request.json or {}
    owner_id = data.get('owner_id', '') or data.get('device_id', '')
    if not owner_id:
        return jsonify({'error': 'owner_id required'}), 400
    gate = _require_premium(owner_id, 'AI Chat Delegation')
    if gate: return gate

    with _ai_lock:
        if owner_id not in _ai_delegation:
            _ai_delegation[owner_id] = {'enabled': False, 'auto_reply_to': [], 'style': 'professional', 'rules': ''}
        deleg = _ai_delegation[owner_id]
        for field in ['enabled', 'auto_reply_to', 'style', 'rules']:
            if field in data:
                deleg[field] = data[field]
    _save_ai_delegation()
    return jsonify({'success': True, 'delegation': deleg})


@app.route('/api/ai/delegate-reply', methods=['POST'])
def ai_delegate_reply():
    """AI generates a reply on behalf of the owner for an incoming chat message."""
    data = request.json or {}
    owner_id = data.get('owner_id', '') or data.get('device_id', '')
    sender_name = data.get('sender_name', 'Someone')
    sender_id = data.get('sender_id', '')
    incoming_text = data.get('text', '') or data.get('sender_message', '')
    incoming_text = incoming_text.strip() if incoming_text else ''

    if not owner_id or not incoming_text:
        return jsonify({'error': 'owner_id and text required'}), 400

    # Check if delegation is enabled
    deleg = _ai_delegation.get(owner_id, {})
    if not deleg.get('enabled'):
        return jsonify({'error': 'Delegation not enabled'}), 403

    style = deleg.get('style', 'professional')
    rules = deleg.get('rules', '')

    delegation_prompt = f"""You are replying to a chat message on behalf of the owner. 
Reply style: {style}
{f'Special rules from owner: {rules}' if rules else ''}

The message is from: {sender_name}
Their message: "{incoming_text}"

Generate a natural, appropriate reply as if you ARE the owner. Keep it brief and conversational.
DO NOT reveal you are an AI. DO NOT make commitments or agree to meetings/deals — instead say something like "Let me check and get back to you" for important matters.
If the message seems sensitive or important, start your reply with [FLAG] to indicate the owner should review this.
Protect the owner's privacy at all times."""

    messages = [
        {'role': 'system', 'content': delegation_prompt},
        {'role': 'user', 'content': incoming_text}
    ]

    reply = _deepseek_chat(messages, max_tokens=256, temperature=0.7)

    flagged = reply.startswith('[FLAG]')
    clean_reply = reply.replace('[FLAG]', '').strip() if flagged else reply

    return jsonify({
        'success': True,
        'reply': clean_reply,
        'flagged': flagged,
        'sender_id': sender_id,
        'sender_name': sender_name
    })


# ─── Server-Side Audio Transcription (Groq Whisper primary + Google SR fallback) ───
GROQ_API_KEY = os.environ.get('GROQ_API_KEY', '')


def _transcribe_audio_groq(audio_bytes, audio_format='webm'):
    """Transcribe audio using Groq's Whisper Large V3 Turbo — fastest & most accurate.
    Returns transcript string or None on failure."""
    import io
    try:
        from groq import Groq

        client = Groq(api_key=GROQ_API_KEY)

        # Groq accepts webm, mp3, wav, ogg, flac, mp4, m4a directly
        ext_map = {
            'webm': 'webm', 'ogg': 'ogg', 'opus': 'ogg', 'mp3': 'mp3',
            'mpeg': 'mp3', 'wav': 'wav', 'flac': 'flac', 'mp4': 'mp4', 'm4a': 'm4a'
        }
        fmt = audio_format.lower().replace('audio/', '').split(';')[0].strip()
        ext = ext_map.get(fmt, 'webm')
        filename = f'voice_note.{ext}'

        audio_file = io.BytesIO(audio_bytes)
        audio_file.name = filename

        transcription = client.audio.transcriptions.create(
            model='whisper-large-v3-turbo',
            file=(filename, audio_file),
            language='en',
            response_format='text',
            temperature=0.0
        )

        result = transcription.strip() if isinstance(transcription, str) else str(transcription).strip()
        if result:
            print(f"[Groq Whisper] Transcribed: '{result}'")
            return result
        return None
    except Exception as e:
        print(f"[Groq Whisper] Error: {e}")
        return None


def _transcribe_audio_google(audio_bytes, audio_format='webm'):
    """Fallback: Transcribe audio using Google Speech Recognition (free, no API key).
    Converts from webm/ogg/mp3 to WAV using pydub + bundled ffmpeg.
    Returns transcript string or None on failure."""
    import io
    try:
        import imageio_ffmpeg
        from pydub import AudioSegment
        import speech_recognition as sr

        # Point pydub to the bundled ffmpeg binary
        AudioSegment.converter = imageio_ffmpeg.get_ffmpeg_exe()
        AudioSegment.ffprobe = imageio_ffmpeg.get_ffmpeg_exe()

        # Convert incoming audio to WAV
        audio_io = io.BytesIO(audio_bytes)
        fmt = audio_format.lower().replace('audio/', '').split(';')[0].strip()
        if fmt in ('webm', 'ogg', 'opus'):
            fmt = 'webm'
        elif fmt in ('mp3', 'mpeg'):
            fmt = 'mp3'
        elif fmt in ('mp4', 'm4a', 'aac'):
            fmt = 'mp4'
        else:
            fmt = 'webm'

        audio_segment = AudioSegment.from_file(audio_io, format=fmt)
        wav_io = io.BytesIO()
        audio_segment.set_frame_rate(16000).set_channels(1).export(wav_io, format='wav')
        wav_io.seek(0)

        recognizer = sr.Recognizer()
        with sr.AudioFile(wav_io) as source:
            audio_data = recognizer.record(source)

        try:
            transcript = recognizer.recognize_google(audio_data, language='en-US')
            if transcript:
                print(f"[Google SR] Transcribed: '{transcript}'")
                return transcript.strip()
        except sr.UnknownValueError:
            print("[Google SR] Could not understand audio")
        except sr.RequestError as e:
            print(f"[Google SR] API error: {e}")

        return None
    except Exception as e:
        print(f"[Google SR] Error: {e}")
        return None


def _transcribe_audio(audio_bytes, audio_format='webm'):
    """Transcribe audio to text. Tries Groq Whisper first (best quality), falls back to Google SR.
    Returns transcript string or None on failure."""
    # 1) Groq Whisper Large V3 Turbo — state of the art, fastest
    if GROQ_API_KEY:
        result = _transcribe_audio_groq(audio_bytes, audio_format)
        if result:
            return result

    # 2) Google Speech Recognition fallback (free, decent quality)
    result = _transcribe_audio_google(audio_bytes, audio_format)
    if result:
        return result

    return None


def _humanize_tts_text(text):
    """Clean text for natural TTS reading — remove markdown, symbols, code blocks.
    Makes the AI sound human by stripping characters we don't pronounce."""
    import re

    if not text:
        return text

    # ── Emoji handling: express emotions naturally instead of pronouncing emoji names ──
    # Common expressive emojis → natural speech equivalents
    _emoji_map = {
        '😀': '', '😃': '', '😄': '', '😁': '', '😆': '', '😂': '', '🤣': '',
        '😊': '', '🥰': '', '😍': '', '😘': '', '😗': '', '😙': '', '😚': '',
        '🙂': '', '😉': '', '😋': '', '😎': '', '🤩': '', '🥳': '',
        '😏': '', '😒': '', '🙄': '', '😬': '', '😮‍💨': '',
        '😢': '', '😭': '', '😤': '', '😡': '', '🤬': '',
        '😱': '', '😨': '', '😰': '', '😥': '', '😓': '',
        '🤔': 'hmm', '🤨': '', '🧐': '', '💭': '',
        '👍': '', '👎': '', '👏': '', '🙌': '', '🤝': '',
        '❤️': '', '💕': '', '💖': '', '💗': '', '💙': '', '💚': '', '💛': '', '🖤': '', '💜': '',
        '🔥': '', '✨': '', '⭐': '', '🌟': '', '💫': '', '✅': '', '❌': '',
        '⚡': '', '💡': '', '🎉': '', '🎊': '', '🎁': '', '🏆': '', '🥇': '',
        '👀': '', '👁️': '', '💀': '', '☠️': '',
        '🤷': '', '🤷‍♂️': '', '🤷‍♀️': '',
        '👋': '', '✌️': '', '🤞': '', '🤙': '', '💪': '',
        '🙏': '', '🫡': '', '🫶': '',
        '😴': '', '💤': '', '😪': '',
        '🤮': '', '🤢': '', '🤧': '', '🤒': '',
        '💯': '', '🆒': '', '🆕': '', '🆗': '',
        '⬆️': '', '⬇️': '', '➡️': '', '⬅️': '',
        '📌': '', '📎': '', '📝': '', '📋': '', '📊': '', '📈': '', '📉': '',
        '🚀': '', '💻': '', '📱': '', '🖥️': '',
        '⚠️': '', '🚨': '', 'ℹ️': '', '❓': '', '❗': '',
        '😈': '', '👿': '', '👻': '', '🤖': '', '👽': '',
        '🐶': '', '🐱': '', '🐻': '', '🦁': '',
        '☀️': '', '🌙': '', '⛅': '', '🌧️': '', '❄️': '',
    }
    for emoji, replacement in _emoji_map.items():
        text = text.replace(emoji, replacement)

    # Remove any remaining emojis (unicode ranges for emoji blocks)
    # This catches emojis not in the map above
    text = re.sub(
        r'[\U0001F600-\U0001F64F'   # emoticons
        r'\U0001F300-\U0001F5FF'     # symbols & pictographs
        r'\U0001F680-\U0001F6FF'     # transport & map
        r'\U0001F1E0-\U0001F1FF'     # flags
        r'\U0001FA00-\U0001FA6F'     # chess symbols
        r'\U0001FA70-\U0001FAFF'     # symbols extended
        r'\U00002702-\U000027B0'     # dingbats
        r'\U0000FE00-\U0000FE0F'     # variation selectors
        r'\U0000200D'                # zero width joiner
        r'\U000020E3'                # combining enclosing keycap
        r'\U00002600-\U000026FF'     # misc symbols
        r'\U00002300-\U000023FF'     # misc technical
        r'\U0000203C-\U00003299'     # enclosed & misc
        r'\U0001F900-\U0001F9FF'     # supplemental symbols
        r']+', '', text
    )

    # Remove code blocks (```...```)
    text = re.sub(r'```[\s\S]*?```', ' code snippet omitted ', text)
    # Remove inline code (`...`)
    text = re.sub(r'`([^`]+)`', r'\1', text)

    # Remove markdown headers (# ## ### etc.)
    text = re.sub(r'^#{1,6}\s*', '', text, flags=re.MULTILINE)

    # Remove bold/italic markers (**text**, *text*, __text__, _text_)
    text = re.sub(r'\*\*\*(.+?)\*\*\*', r'\1', text)  # ***bold italic***
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)       # **bold**
    text = re.sub(r'\*(.+?)\*', r'\1', text)            # *italic*
    text = re.sub(r'___(.+?)___', r'\1', text)          # ___bold italic___
    text = re.sub(r'__(.+?)__', r'\1', text)            # __bold__
    text = re.sub(r'(?<!\w)_(.+?)_(?!\w)', r'\1', text) # _italic_

    # Remove strikethrough (~~text~~)
    text = re.sub(r'~~(.+?)~~', r'\1', text)

    # Remove markdown links [text](url) → just text
    text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', text)

    # Remove bare URLs
    text = re.sub(r'https?://\S+', ' link ', text)

    # Remove markdown bullet points (-, *, +) at line start
    text = re.sub(r'^\s*[-*+]\s+', '', text, flags=re.MULTILINE)

    # Remove numbered list markers (1. 2. etc.)
    text = re.sub(r'^\s*\d+\.\s+', '', text, flags=re.MULTILINE)

    # Remove blockquote markers (>)
    text = re.sub(r'^\s*>\s*', '', text, flags=re.MULTILINE)

    # Remove horizontal rules (---, ***, ___)
    text = re.sub(r'^[-*_]{3,}\s*$', '', text, flags=re.MULTILINE)

    # Remove markdown table pipes
    text = re.sub(r'\|', ' ', text)

    # Remove standalone special characters that shouldn't be spoken
    text = re.sub(r'(?<!\w)[#*/_~`\\](?!\w)', '', text)

    # Replace common symbols with spoken equivalents
    text = text.replace(' & ', ' and ')
    text = text.replace(' @ ', ' at ')
    text = text.replace(' % ', ' percent ')
    text = text.replace(' + ', ' plus ')
    text = text.replace(' = ', ' equals ')
    text = text.replace(' -> ', ' leads to ')
    text = text.replace(' => ', ' means ')
    text = text.replace(' >= ', ' greater than or equal to ')
    text = text.replace(' <= ', ' less than or equal to ')
    text = text.replace(' != ', ' not equal to ')
    text = text.replace(' < ', ' less than ')
    text = text.replace(' > ', ' greater than ')

    # Clean up multiple spaces, newlines
    text = re.sub(r'\n{2,}', '. ', text)
    text = re.sub(r'\n', ' ', text)
    text = re.sub(r'\s{2,}', ' ', text)

    # Remove leading/trailing whitespace and stray punctuation
    text = text.strip()
    # Remove double periods
    text = re.sub(r'\.{2,}', '.', text)
    text = re.sub(r'\.\s*\.', '.', text)

    return text


# ─── AI Voice (TTS via NVIDIA NIM + Edge-TTS Neural Fallback) ──────────
NVIDIA_NIM_API_KEY = os.environ.get('NVIDIA_NIM_API_KEY', '')

# Available neural voices (Edge-TTS / Microsoft Azure Neural)
TTS_VOICES = {
    'aria':   'en-US-AriaNeural',      # Female, warm & expressive
    'jenny':  'en-US-JennyNeural',      # Female, friendly & clear
    'guy':    'en-US-GuyNeural',        # Male, natural
    'davis':  'en-US-DavisNeural',      # Male, calm & professional
    'sara':   'en-US-SaraNeural',       # Female, cheerful
    'tony':   'en-US-TonyNeural',       # Male, casual
    'ana':    'en-US-AnaNeural',        # Female, soft
    'andrew': 'en-US-AndrewNeural',     # Male, warm
    'emma':   'en-US-EmmaNeural',       # Female, confident
    'brian':  'en-US-BrianNeural',      # Male, professional
}
DEFAULT_TTS_VOICE = 'en-US-AriaNeural'  # Warm, expressive, very human-like


def _nvidia_tts(text, voice='English-US.Female-1'):
    """Convert text to speech via NVIDIA NIM Riva TTS. Returns base64 WAV or None."""
    if not NVIDIA_NIM_API_KEY or NVIDIA_NIM_API_KEY.startswith('nvapi-placeholder'):
        return None
    import urllib.request
    import urllib.error
    # Humanize text before sending to TTS
    text = _humanize_tts_text(text)
    url = 'https://integrate.api.nvidia.com/v1/audio/speech'
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {NVIDIA_NIM_API_KEY}',
        'Accept': 'audio/wav'
    }
    payload = json.dumps({
        'model': 'nvidia/fastpitch-hifigan-tts',
        'input': text[:500],
        'voice': voice,
        'response_format': 'wav',
        'speed': 1.0
    }).encode('utf-8')
    try:
        req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=30) as resp:
            audio_bytes = resp.read()
            return base64.b64encode(audio_bytes).decode('ascii')
    except Exception as e:
        print(f"NVIDIA TTS error: {e}")
        return None


def _edge_tts(text, voice=None):
    """Convert text to speech using Microsoft Edge Neural TTS (free, very human-like).
    Handles long text by splitting into sentence chunks and concatenating audio.
    Returns (base64_mp3, 'mp3') or (None, None) on failure."""
    import asyncio
    try:
        import edge_tts
    except ImportError:
        print("edge-tts not installed")
        return None, None

    voice = voice or DEFAULT_TTS_VOICE
    # Humanize text — remove markdown/symbols for natural speech
    tts_text = _humanize_tts_text(text)

    if not tts_text or len(tts_text.strip()) < 2:
        return None, None

    # Split long text into chunks at sentence boundaries (max ~800 chars each)
    # This prevents Edge TTS from cutting off mid-sentence
    def _split_into_chunks(t, max_len=800):
        if len(t) <= max_len:
            return [t]
        chunks = []
        while t:
            if len(t) <= max_len:
                chunks.append(t)
                break
            # Find the last sentence boundary before max_len
            cut = max_len
            for sep in ['. ', '! ', '? ', '.\n', '!\n', '?\n', '; ', ', ']:
                idx = t.rfind(sep, 0, max_len)
                if idx > max_len // 3:  # Don't cut too early
                    cut = idx + len(sep)
                    break
            else:
                # No sentence boundary found — find last space
                idx = t.rfind(' ', 0, max_len)
                if idx > max_len // 3:
                    cut = idx + 1
            chunks.append(t[:cut].strip())
            t = t[cut:].strip()
        return [c for c in chunks if c]

    text_chunks = _split_into_chunks(tts_text)

    async def _generate_chunk(chunk_text):
        communicate = edge_tts.Communicate(
            chunk_text, voice,
            rate='+5%',
            pitch='+0Hz',
            volume='+0%'
        )
        audio_data = b''
        async for chunk in communicate.stream():
            if chunk['type'] == 'audio':
                audio_data += chunk['data']
        return audio_data

    async def _generate_all():
        all_audio = b''
        for chunk_text in text_chunks:
            try:
                audio_data = await _generate_chunk(chunk_text)
                if audio_data:
                    all_audio += audio_data
            except Exception as e:
                print(f"Edge TTS chunk error: {e}")
                continue
        return all_audio

    try:
        # Run async edge-tts in sync context
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        # Longer timeout for multi-chunk generation (60s)
        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                audio_bytes = pool.submit(lambda: asyncio.run(_generate_all())).result(timeout=60)
        else:
            audio_bytes = asyncio.run(_generate_all())

        if audio_bytes and len(audio_bytes) > 100:
            return base64.b64encode(audio_bytes).decode('ascii'), 'mp3'
        return None, None
    except Exception as e:
        print(f"Edge TTS error: {e}")
        return None, None


def _generate_tts(text, voice_name=None):
    """Generate TTS audio. Tries NVIDIA NIM first, falls back to Edge Neural TTS.
    Returns dict with 'audio' (base64), 'format' ('wav'/'mp3'), or empty dict."""
    # 1) Try NVIDIA NIM if key is configured
    if NVIDIA_NIM_API_KEY and not NVIDIA_NIM_API_KEY.startswith('nvapi-placeholder'):
        audio_b64 = _nvidia_tts(text)
        if audio_b64:
            return {'audio': audio_b64, 'format': 'wav', 'engine': 'nvidia'}

    # 2) Edge Neural TTS (free, very human-like)
    edge_voice = TTS_VOICES.get(voice_name, voice_name) if voice_name else DEFAULT_TTS_VOICE
    audio_b64, fmt = _edge_tts(text, edge_voice)
    if audio_b64:
        return {'audio': audio_b64, 'format': fmt, 'engine': 'edge-neural'}

    return {}


@app.route('/api/ai/tts', methods=['POST'])
def ai_tts():
    """Text-to-Speech endpoint. Converts text to human-like neural speech audio."""
    data = request.json or {}
    text = data.get('text', '').strip()
    voice = data.get('voice', None)

    if not text:
        return jsonify({'error': 'text required'}), 400
    if len(text) > 5000:
        text = text[:5000]

    result = _generate_tts(text, voice)
    if not result.get('audio'):
        return jsonify({'error': 'TTS generation failed', 'fallback': 'browser'}), 500

    return jsonify({
        'success': True,
        'audio': result['audio'],
        'format': result['format'],
        'engine': result.get('engine', 'unknown')
    })


@app.route('/api/ai/voice-reply', methods=['POST'])
def ai_voice_reply():
    """AI generates a text reply for a voice call and optionally converts to speech audio.
    Used when delegation auto-answers a call."""
    data = request.json or {}
    owner_id = data.get('owner_id', '') or data.get('device_id', '')
    caller_name = data.get('caller_name', 'Someone')
    caller_text = data.get('text', '').strip()  # transcribed speech from caller
    want_audio = data.get('tts', True)  # generate TTS audio

    if not owner_id or not caller_text:
        return jsonify({'error': 'owner_id and text required'}), 400
    gate = _require_premium(owner_id, 'AI Voice Call Answering')
    if gate: return gate

    deleg = _ai_delegation.get(owner_id, {})
    style = deleg.get('style', 'professional')
    rules = deleg.get('rules', '')

    voice_prompt = f"""You are answering a voice call on behalf of the owner. The caller is: {caller_name}.
Reply style: {style}
{f'Special rules from owner: {rules}' if rules else ''}

IMPORTANT: You are speaking on a phone call. Keep responses SHORT (1-2 sentences max).
Be natural and conversational like a real phone call. Use contractions.
DO NOT reveal you are an AI. Say things like "Hey, they're not available right now, but I can take a message"
or "Let me pass that along" for the first greeting.
For important requests, say "I'll let them know about this."
Never agree to meetings, deals, or money matters — say "they'll get back to you on that."

The caller said: "{caller_text}"
"""

    messages = [
        {'role': 'system', 'content': voice_prompt},
        {'role': 'user', 'content': caller_text}
    ]

    reply_text = _deepseek_chat(messages, max_tokens=100, temperature=0.7)
    flagged = reply_text.startswith('[FLAG]')
    clean_reply = reply_text.replace('[FLAG]', '').strip() if flagged else reply_text

    result = {
        'success': True,
        'reply': clean_reply,
        'flagged': flagged
    }

    # Try neural TTS (NVIDIA → Edge Neural → browser fallback)
    if want_audio:
        tts_result = _generate_tts(clean_reply)
        if tts_result.get('audio'):
            result['audio'] = tts_result['audio']
            result['audio_format'] = tts_result['format']
            result['audio_engine'] = tts_result.get('engine', 'unknown')

    return jsonify(result)


@app.route('/api/ai/summarize', methods=['POST'])
def ai_summarize():
    """Summarize text, documents, or conversations."""
    data = request.json or {}
    owner_id = data.get('owner_id', '')
    text = data.get('text', '').strip()
    summary_type = data.get('type', 'general')  # general, document, conversation, study_notes

    if not text:
        return jsonify({'error': 'text required'}), 400

    prompts = {
        'general': 'Summarize the following text concisely, highlighting key points:',
        'document': 'Analyze this document and provide: 1) Summary 2) Key Points 3) Action Items 4) Important Dates/Numbers:',
        'conversation': 'Summarize this conversation, highlighting: 1) Main topics 2) Decisions made 3) Action items 4) Unresolved questions:',
        'study_notes': 'Create study notes from this text: 1) Key Concepts 2) Definitions 3) Important Facts 4) Potential Exam Questions:'
    }

    prompt = prompts.get(summary_type, prompts['general'])
    messages = [
        {'role': 'system', 'content': f'You are a helpful assistant. {prompt}'},
        {'role': 'user', 'content': text}
    ]

    reply = _deepseek_chat(messages, max_tokens=1500, temperature=0.3)
    return jsonify({'success': True, 'summary': reply})


@app.route('/api/ai/analyze-image', methods=['POST'])
def ai_analyze_image():
    """Analyze/describe an image (via text description since DeepSeek is text-based)."""
    data = request.json or {}
    description = data.get('description', '').strip()
    question = data.get('question', 'Describe and analyze this content.')

    if not description:
        return jsonify({'error': 'description required'}), 400

    messages = [
        {'role': 'system', 'content': 'You are an expert at analyzing document contents, photos, and visual descriptions. Provide detailed, helpful analysis.'},
        {'role': 'user', 'content': f'Image/Document description: {description}\n\nQuestion: {question}'}
    ]

    reply = _deepseek_chat(messages, max_tokens=1024, temperature=0.4)
    return jsonify({'success': True, 'analysis': reply})


@app.route('/api/ai/clear-history', methods=['POST'])
def ai_clear_history():
    """Clear conversation history for a user."""
    data = request.json or {}
    owner_id = data.get('owner_id', '') or data.get('device_id', '')
    with _ai_lock:
        _ai_conversations.pop(owner_id, None)
    _save_ai_conversations()
    return jsonify({'success': True})


@app.route('/api/ai/highlight-ask', methods=['POST'])
def ai_highlight_ask():
    """Ask a follow-up question about highlighted text from an AI response."""
    data = request.json or {}
    owner_id = data.get('owner_id', '') or data.get('device_id', '')
    highlighted_text = data.get('highlighted_text', '').strip()
    question = data.get('question', '').strip()
    context_from = data.get('context_from', '').strip()
    if not owner_id or not highlighted_text:
        return jsonify({'error': 'owner_id and highlighted_text required'}), 400
    if not question:
        question = f'Tell me more about: "{highlighted_text}"'
    # Delegate to the main chat endpoint with highlight context
    data['text'] = question
    data['highlighted_text'] = highlighted_text
    data['context_from'] = context_from
    # Reuse real request data by calling the function directly
    with app.test_request_context(json=data):
        return ai_chat()


@app.route('/api/ai/profile', methods=['GET'])
def ai_get_profile():
    """Get the AI's learned profile about a user."""
    owner_id = request.args.get('owner_id', '') or request.args.get('device_id', '')
    if not owner_id:
        return jsonify({'error': 'owner_id required'}), 400
    profile = _get_user_profile(owner_id)
    return jsonify({'success': True, 'profile': profile})


@app.route('/api/ai/profile', methods=['POST'])
def ai_update_profile():
    """Manually update user profile preferences."""
    data = request.json or {}
    owner_id = data.get('owner_id', '') or data.get('device_id', '')
    if not owner_id:
        return jsonify({'error': 'owner_id required'}), 400
    profile = _get_user_profile(owner_id)
    for key in ['name', 'preferred_tone', 'preferred_response_length', 'language_preference']:
        if key in data:
            profile[key] = data[key]
    if 'like' in data:
        if data['like'] not in profile.get('likes', []):
            profile.setdefault('likes', []).append(data['like'])
    if 'dislike' in data:
        if data['dislike'] not in profile.get('dislikes', []):
            profile.setdefault('dislikes', []).append(data['dislike'])
    if 'interest' in data:
        if data['interest'] not in profile.get('interests', []):
            profile.setdefault('interests', []).append(data['interest'])
    _save_ai_profiles()
    return jsonify({'success': True, 'profile': profile})


@app.route('/api/ai/chat-history', methods=['GET'])
def ai_get_chat_history():
    """Get persisted chat history for a user."""
    owner_id = request.args.get('owner_id', '') or request.args.get('device_id', '')
    limit = int(request.args.get('limit', 50))
    if not owner_id:
        return jsonify({'error': 'owner_id required'}), 400
    with _ai_lock:
        conv = _ai_conversations.get(owner_id, [])
    return jsonify({'success': True, 'messages': conv[-limit:], 'total': len(conv)})


# ─── AI File / Image / Document / Audio Processing ────────────

DANGEROUS_EXTENSIONS = {
    '.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.msi', '.vbs', '.js',
    '.wsf', '.wsh', '.ps1', '.dll', '.sys', '.cpl', '.hta', '.inf',
    '.reg', '.lnk', '.jar', '.sh', '.bash', '.csh', '.ksh',
}
DANGEROUS_SIGNATURES = [
    b'MZ',           # PE / EXE
    b'\x7fELF',      # ELF binary
    b'PK\x03\x04',   # ZIP (could be safe, flagged for deep check)
]
SUSPICIOUS_STRINGS = [
    b'<script', b'eval(', b'exec(', b'powershell', b'cmd.exe',
    b'wget ', b'curl ', b'chmod ', b'rm -rf', b'base64_decode',
    b'document.cookie', b'window.location', b'shell_exec',
    b'CreateObject', b'WScript.Shell', b'ADODB.Stream',
]

def _extract_image_info(file_bytes, filename, mime):
    """Extract detailed image metadata from raw bytes (no PIL needed)."""
    import struct
    info_parts = []
    info_parts.append(f"Filename: {filename}")
    info_parts.append(f"MIME type: {mime}")
    info_parts.append(f"File size: {len(file_bytes):,} bytes ({len(file_bytes)/1024:.1f} KB)")

    width = height = 0
    color_type = 'unknown'
    bit_depth = 0

    # ── PNG ──
    if file_bytes[:8] == b'\x89PNG\r\n\x1a\n' and len(file_bytes) >= 24:
        try:
            width = struct.unpack('>I', file_bytes[16:20])[0]
            height = struct.unpack('>I', file_bytes[20:24])[0]
            if len(file_bytes) >= 26:
                bit_depth = file_bytes[24]
                ct = file_bytes[25]
                color_type = {0: 'Grayscale', 2: 'RGB', 3: 'Indexed (palette)', 4: 'Grayscale+Alpha', 6: 'RGBA'}.get(ct, f'type {ct}')
            info_parts.append(f"Format: PNG")
            info_parts.append(f"Dimensions: {width}x{height} pixels")
            info_parts.append(f"Color type: {color_type}, Bit depth: {bit_depth}")
        except:
            info_parts.append("Format: PNG (could not read dimensions)")

    # ── JPEG ──
    elif file_bytes[:2] == b'\xff\xd8':
        info_parts.append("Format: JPEG")
        # Parse SOF markers for dimensions
        i = 2
        while i < len(file_bytes) - 9:
            if file_bytes[i] == 0xFF:
                marker = file_bytes[i+1]
                if marker in (0xC0, 0xC1, 0xC2):  # SOF0, SOF1, SOF2
                    bit_depth = file_bytes[i+4]
                    height = struct.unpack('>H', file_bytes[i+5:i+7])[0]
                    width = struct.unpack('>H', file_bytes[i+7:i+9])[0]
                    num_comp = file_bytes[i+9] if i+9 < len(file_bytes) else 0
                    color_type = {1: 'Grayscale', 3: 'YCbCr (Color)', 4: 'CMYK'}.get(num_comp, f'{num_comp} components')
                    info_parts.append(f"Dimensions: {width}x{height} pixels")
                    info_parts.append(f"Color: {color_type}, Precision: {bit_depth}-bit")
                    break
                elif marker == 0xD9 or marker == 0xDA:
                    break
                else:
                    if i + 3 < len(file_bytes):
                        seg_len = struct.unpack('>H', file_bytes[i+2:i+4])[0]
                        i += 2 + seg_len
                    else:
                        break
            else:
                i += 1

        # Extract EXIF data
        exif_info = _extract_exif(file_bytes)
        if exif_info:
            info_parts.append(f"EXIF data: {exif_info}")

    # ── GIF ──
    elif file_bytes[:6] in (b'GIF87a', b'GIF89a'):
        info_parts.append(f"Format: GIF ({file_bytes[:6].decode('ascii')})")
        if len(file_bytes) >= 10:
            width = struct.unpack('<H', file_bytes[6:8])[0]
            height = struct.unpack('<H', file_bytes[8:10])[0]
            info_parts.append(f"Dimensions: {width}x{height} pixels")
            # Check if animated
            if b'\x21\xF9\x04' in file_bytes:
                frame_count = file_bytes.count(b'\x21\xF9\x04')
                info_parts.append(f"Animated: Yes ({frame_count} frames)")

    # ── BMP ──
    elif file_bytes[:2] == b'BM' and len(file_bytes) >= 26:
        info_parts.append("Format: BMP")
        width = struct.unpack('<I', file_bytes[18:22])[0]
        height = abs(struct.unpack('<i', file_bytes[22:26])[0])
        info_parts.append(f"Dimensions: {width}x{height} pixels")
        if len(file_bytes) >= 28:
            bit_depth = struct.unpack('<H', file_bytes[28:30])[0]
            info_parts.append(f"Bit depth: {bit_depth}")

    # ── WebP ──
    elif file_bytes[:4] == b'RIFF' and file_bytes[8:12] == b'WEBP':
        info_parts.append("Format: WebP")
        if file_bytes[12:16] == b'VP8 ' and len(file_bytes) >= 30:
            width = struct.unpack('<H', file_bytes[26:28])[0] & 0x3FFF
            height = struct.unpack('<H', file_bytes[28:30])[0] & 0x3FFF
            info_parts.append(f"Dimensions: {width}x{height} pixels")
        elif file_bytes[12:16] == b'VP8L' and len(file_bytes) >= 25:
            bits = struct.unpack('<I', file_bytes[21:25])[0]
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            info_parts.append(f"Dimensions: {width}x{height} pixels (lossless)")
    else:
        info_parts.append(f"Format: {mime.split('/')[-1] if mime else 'unknown'}")

    # Aspect ratio & size category
    if width and height:
        from math import gcd
        g = gcd(width, height)
        info_parts.append(f"Aspect ratio: {width//g}:{height//g}")
        total_px = width * height
        if total_px > 8_000_000:
            info_parts.append("Resolution: Very high (> 8MP)")
        elif total_px > 2_000_000:
            info_parts.append("Resolution: High (2-8MP)")
        elif total_px > 500_000:
            info_parts.append("Resolution: Medium")
        else:
            info_parts.append("Resolution: Low")
        # Guess type from aspect ratio
        if width == height:
            info_parts.append("Shape: Square (may be profile picture, icon, or social media post)")
        elif abs(width/height - 16/9) < 0.1:
            info_parts.append("Shape: 16:9 widescreen (likely screenshot, video frame, or wallpaper)")
        elif abs(width/height - 9/16) < 0.1:
            info_parts.append("Shape: 9:16 portrait (likely phone screenshot or story)")
        elif width < 256 and height < 256:
            info_parts.append("Shape: Very small (likely icon, favicon, or thumbnail)")
        elif width > 3000 or height > 3000:
            info_parts.append("Shape: Large (likely high-res photo or poster)")

    # Sample color analysis from raw pixel-like bytes (last resort heuristic)
    hex_sample = file_bytes[:512].hex()
    info_parts.append(f"First bytes (hex): {hex_sample[:80]}...")

    return '\n'.join(info_parts)


def _extract_exif(file_bytes):
    """Extract basic EXIF info from JPEG bytes."""
    try:
        # Find EXIF APP1 marker
        idx = file_bytes.find(b'\xff\xe1')
        if idx < 0 or idx + 10 > len(file_bytes):
            return ''
        seg_len = struct.unpack('>H', file_bytes[idx+2:idx+4])[0]
        if file_bytes[idx+4:idx+10] != b'Exif\x00\x00':
            return ''
        exif_start = idx + 10
        exif_data = file_bytes[exif_start:idx+2+seg_len]
        if len(exif_data) < 8:
            return ''

        # Determine byte order
        if exif_data[:2] == b'MM':
            bo = '>'
        elif exif_data[:2] == b'II':
            bo = '<'
        else:
            return ''

        import struct as st
        parts = []
        # Read IFD0
        ifd_offset = st.unpack(f'{bo}I', exif_data[4:8])[0]
        if ifd_offset + 2 > len(exif_data):
            return ''
        num_entries = st.unpack(f'{bo}H', exif_data[ifd_offset:ifd_offset+2])[0]
        for i in range(min(num_entries, 30)):
            entry_off = ifd_offset + 2 + i * 12
            if entry_off + 12 > len(exif_data):
                break
            tag = st.unpack(f'{bo}H', exif_data[entry_off:entry_off+2])[0]
            fmt = st.unpack(f'{bo}H', exif_data[entry_off+2:entry_off+4])[0]
            count = st.unpack(f'{bo}I', exif_data[entry_off+4:entry_off+8])[0]
            val_off = exif_data[entry_off+8:entry_off+12]

            # Common tags
            if tag == 0x010F:  # Make
                try:
                    off = st.unpack(f'{bo}I', val_off)[0]
                    parts.append(f"Camera make: {exif_data[off:off+count].decode('ascii','replace').strip(chr(0))}")
                except: pass
            elif tag == 0x0110:  # Model
                try:
                    off = st.unpack(f'{bo}I', val_off)[0]
                    parts.append(f"Camera model: {exif_data[off:off+count].decode('ascii','replace').strip(chr(0))}")
                except: pass
            elif tag == 0x0112:  # Orientation
                orient = st.unpack(f'{bo}H', val_off[:2])[0]
                orient_map = {1: 'Normal', 3: 'Rotated 180°', 6: 'Rotated 90° CW', 8: 'Rotated 90° CCW'}
                parts.append(f"Orientation: {orient_map.get(orient, f'#{orient}')}")
            elif tag == 0x0132:  # DateTime
                try:
                    off = st.unpack(f'{bo}I', val_off)[0]
                    parts.append(f"Date taken: {exif_data[off:off+19].decode('ascii','replace')}")
                except: pass
            elif tag == 0x8769:  # ExifIFD pointer
                pass  # Could recurse but keep it simple

        return ', '.join(parts) if parts else ''
    except Exception as e:
        return ''


def _scan_file_security(filename, file_bytes):
    """Scan a file for potential security threats. Returns (level, details)."""
    ext = os.path.splitext(filename)[1].lower()
    threats = []
    level = 'safe'

    # Check extension
    if ext in DANGEROUS_EXTENSIONS:
        threats.append(f'Dangerous file extension: {ext}')
        level = 'danger'

    # Check file signature
    header = file_bytes[:16]
    for sig in DANGEROUS_SIGNATURES:
        if header.startswith(sig):
            if sig == b'MZ':
                threats.append('Contains executable binary (PE/EXE format)')
                level = 'danger'
            elif sig == b'\x7fELF':
                threats.append('Contains ELF binary (Linux executable)')
                level = 'danger'
            elif sig == b'PK\x03\x04':
                threats.append('ZIP archive detected — could contain hidden executables')
                if level != 'danger':
                    level = 'warn'

    # Check for suspicious strings in text-readable files
    if ext in ('.txt', '.html', '.htm', '.css', '.js', '.json', '.xml', '.csv', '.md', '.py', '.php', '.asp', '.jsp'):
        for pattern in SUSPICIOUS_STRINGS:
            if pattern.lower() in file_bytes[:50000].lower():
                threats.append(f'Suspicious pattern found: {pattern.decode("utf-8", errors="replace")}')
                if level != 'danger':
                    level = 'warn'

    # File size check
    size_mb = len(file_bytes) / (1024 * 1024)
    if size_mb > 50:
        threats.append(f'Large file: {size_mb:.1f}MB')
        if level == 'safe':
            level = 'warn'

    if not threats:
        threats.append('No threats detected')

    return level, threats


def _extract_text_from_pdf(file_bytes):
    """Extract text from PDF file bytes — simple text extraction."""
    text_parts = []
    try:
        # Simple PDF text extraction without external libraries
        content = file_bytes.decode('latin-1')
        # Find text between BT and ET markers (basic PDF text extraction)
        import re as _re
        # Extract text from stream objects
        streams = _re.findall(r'stream\s*(.*?)\s*endstream', content, _re.DOTALL)
        for stream in streams:
            # Try to find readable text
            readable = _re.findall(r'\((.*?)\)', stream)
            for r in readable:
                cleaned = r.replace('\\n', '\n').replace('\\r', '\r').replace('\\t', '\t')
                if any(c.isalpha() for c in cleaned):
                    text_parts.append(cleaned)
        # Also try Tj and TJ operators
        tj_matches = _re.findall(r'\[(.*?)\]\s*TJ', content, _re.DOTALL)
        for tj in tj_matches:
            parts = _re.findall(r'\((.*?)\)', tj)
            text_parts.extend(parts)
    except Exception as e:
        print(f"PDF extraction error: {e}")
    return '\n'.join(text_parts)[:8000] if text_parts else ''


def _extract_text_from_docx(file_bytes):
    """Extract text from DOCX file bytes."""
    import zipfile
    import io
    text_parts = []
    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            if 'word/document.xml' in zf.namelist():
                xml_content = zf.read('word/document.xml').decode('utf-8', errors='replace')
                import re as _re
                # Extract text between XML tags
                texts = _re.findall(r'<w:t[^>]*>(.*?)</w:t>', xml_content)
                text_parts = texts
    except Exception as e:
        print(f"DOCX extraction error: {e}")
    return ' '.join(text_parts)[:8000] if text_parts else ''


@app.route('/api/ai/process-file', methods=['POST'])
def ai_process_file():
    """Process uploaded file — image analysis, document summarization, audio transcription, virus scan."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400

    f = request.files['file']
    owner_id = request.form.get('owner_id', '') or request.form.get('device_id', '')
    action = request.form.get('action', 'auto')  # auto, analyze, summarize, transcribe, scan
    question = request.form.get('question', '')

    if not f.filename:
        return jsonify({'error': 'No file selected'}), 400

    file_bytes = f.read()
    filename = f.filename
    ext = os.path.splitext(filename)[1].lower()
    mime = f.content_type or ''

    result = {
        'success': True,
        'filename': filename,
        'size': len(file_bytes),
        'type': mime
    }

    # Always run security scan
    sec_level, sec_threats = _scan_file_security(filename, file_bytes)
    result['security'] = {'level': sec_level, 'threats': sec_threats}

    # Auto-detect action based on mime type
    if action == 'auto':
        if mime.startswith('image/'):
            action = 'analyze'
        elif ext in ('.pdf', '.doc', '.docx', '.txt', '.csv', '.xlsx', '.md'):
            action = 'summarize'
        elif mime.startswith('audio/') or ext in ('.mp3', '.wav', '.ogg', '.m4a', '.webm', '.opus'):
            action = 'transcribe'
        else:
            action = 'scan'

    # ─── Image Analysis (VISION) ───
    if action == 'analyze' and mime.startswith('image/'):
        # Use real vision — send the actual image to the AI
        user_q = question or 'Analyze this image in detail. Describe everything you see.'
        img_data = _resize_image_if_needed(file_bytes)
        # Determine mime for resized image (may have been converted to JPEG)
        img_mime = mime if img_data is file_bytes else 'image/jpeg'
        try:
            result['analysis'] = _deepseek_vision_chat(
                img_data, img_mime, question=user_q,
                system_prompt='You are BEAM AI, an expert at analyzing images, photos, screenshots, documents, and any visual content. Provide detailed, structured, and helpful analysis. If you see text in the image, transcribe it accurately. If it is a document, extract all the text and summarize it.',
                max_tokens=2000, temperature=0.3
            )
        except Exception as vision_err:
            print(f"[BEAM-AI-VISION] Vision failed, falling back to metadata: {vision_err}", flush=True)
            # Fallback to metadata-only analysis
            img_info = _extract_image_info(file_bytes, filename, mime)
            prompt = f"Image: {filename}\nType: {mime}, Size: {len(file_bytes)} bytes\nMetadata:\n{img_info}\n\nQuestion: {user_q}\n\nNote: I could not directly see this image, so I'm analyzing based on metadata only."
            result['analysis'] = _deepseek_chat([
                {'role': 'system', 'content': 'You are BEAM AI. Analyze image metadata and provide the best analysis you can.'},
                {'role': 'user', 'content': prompt}
            ], max_tokens=1500, temperature=0.3)

    # ─── Document Summarization ───
    elif action == 'summarize':
        extracted_text = ''
        if ext == '.pdf':
            extracted_text = _extract_text_from_pdf(file_bytes)
        elif ext in ('.docx', '.doc'):
            extracted_text = _extract_text_from_docx(file_bytes)
        elif ext in ('.txt', '.md', '.csv'):
            try:
                extracted_text = file_bytes.decode('utf-8', errors='replace')[:8000]
            except:
                extracted_text = file_bytes.decode('latin-1', errors='replace')[:8000]
        elif ext == '.xlsx':
            try:
                import zipfile, io
                with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
                    if 'xl/sharedStrings.xml' in zf.namelist():
                        import re as _re
                        xml = zf.read('xl/sharedStrings.xml').decode('utf-8', errors='replace')
                        extracted_text = ' '.join(_re.findall(r'<t[^>]*>(.*?)</t>', xml))[:8000]
            except:
                pass

        if extracted_text.strip():
            prompt = question or 'Analyze and summarize this document. Provide: 1) Summary 2) Key Points 3) Action Items 4) Important Details'
            result['analysis'] = _deepseek_chat([
                {'role': 'system', 'content': 'You are BEAM AI, an expert document analyst. Provide thorough, structured analysis of documents.'},
                {'role': 'user', 'content': f'Document: {filename}\n\n{prompt}\n\nDocument content:\n{extracted_text}'}
            ], max_tokens=1500, temperature=0.3)
            result['extracted_text'] = extracted_text[:2000]
        else:
            # No extractable text — try Qwen vision on the raw file (works for scanned PDFs, image-based docs)
            if ext == '.pdf' and len(file_bytes) < 10 * 1024 * 1024:
                try:
                    user_q = question or 'This is a scanned/image-based PDF. Extract ALL text you can see, then provide a summary with key points.'
                    analysis = _qwen_vision(
                        file_bytes, 'application/pdf', question=user_q,
                        system_prompt='You are BEAM AI, expert at reading scanned documents. Extract all visible text accurately, then summarize.',
                        max_tokens=2500, temperature=0.2
                    )
                    # If vision failed, tell user
                    if analysis.startswith("I couldn't analyze"):
                        result['analysis'] = f'Could not visually read {filename} (vision unavailable). Please try again later or take a screenshot of each page and send as images.'
                    else:
                        result['analysis'] = analysis
                except Exception as e:
                    print(f"[BEAM-AI-VISION] PDF vision failed: {e}", flush=True)
                    result['analysis'] = f'Could not extract text from {filename}. The file may be encrypted or in an unsupported format.'
            else:
                result['analysis'] = f'Could not extract text from {filename}. The file may be scanned/image-based or in an unsupported format. Try taking a screenshot and sending it as an image instead.'

    # ─── Audio Transcription ───
    elif action == 'transcribe':
        # Server-side cannot transcribe audio directly — transcription happens client-side via Web Speech API
        # If we reach here, the browser doesn't support SpeechRecognition, so give a helpful response
        result['analysis'] = _deepseek_chat([
            {'role': 'system', 'content': 'You are BEAM AI. The user sent a voice note but their browser does not support speech-to-text transcription, so you cannot understand what they said. Politely let them know and suggest alternatives.'},
            {'role': 'user', 'content': f'I sent a voice note ({filename}, {len(file_bytes)} bytes, {mime}) but my browser cannot transcribe it. What should I do?'}
        ], max_tokens=256, temperature=0.4)
        result['needs_client_transcription'] = True

    # ─── File Scan Only ───
    else:
        scan_summary = f"File: {filename}\nSize: {len(file_bytes)} bytes\nType: {mime}\n\nSecurity Scan Results:\n"
        scan_summary += f"Threat Level: {sec_level.upper()}\n"
        for t in sec_threats:
            scan_summary += f"- {t}\n"
        result['analysis'] = _deepseek_chat([
            {'role': 'system', 'content': 'You are BEAM AI security advisor. Analyze the file scan results and provide security advice.'},
            {'role': 'user', 'content': scan_summary + '\nProvide a clear security assessment and recommendations.'}
        ], max_tokens=512, temperature=0.3)

    # Store in AI conversation
    if owner_id:
        with _ai_lock:
            if owner_id not in _ai_conversations:
                _ai_conversations[owner_id] = []
            conv = _ai_conversations[owner_id]
            conv.append({'role': 'user', 'content': f'[Sent file: {filename}] {question}', 'timestamp': time.time()})
            if result.get('analysis'):
                conv.append({'role': 'assistant', 'content': result['analysis'], 'timestamp': time.time()})
            if len(conv) > 40:
                _ai_conversations[owner_id] = conv[-40:]

    return jsonify(result)


@app.route('/api/ai/transcribe', methods=['POST'])
def ai_transcribe():
    """Receive client-side transcription and process with AI."""
    data = request.json or {}
    owner_id = data.get('owner_id', '') or data.get('device_id', '')
    transcript = data.get('transcript', '').strip()
    if not transcript:
        return jsonify({'error': 'transcript required'}), 400

    # Build messages with conversation history for context-aware replies
    messages = [
        {'role': 'system', 'content': 'You are BEAM AI, a helpful and intelligent assistant. The user sent a voice note that was transcribed to text. Respond naturally and helpfully to what they said. Be conversational and thorough.'}
    ]
    # Include recent conversation history for context
    if owner_id:
        with _ai_lock:
            conv = _ai_conversations.get(owner_id, [])
            for msg in conv[-10:]:
                messages.append({'role': msg['role'], 'content': msg['content']})
    messages.append({'role': 'user', 'content': f'{transcript}'})

    reply = _deepseek_chat(messages, max_tokens=1024, temperature=0.7)

    if owner_id:
        with _ai_lock:
            if owner_id not in _ai_conversations:
                _ai_conversations[owner_id] = []
            conv = _ai_conversations[owner_id]
            conv.append({'role': 'user', 'content': f'[Voice note]: {transcript}', 'timestamp': time.time()})
            conv.append({'role': 'assistant', 'content': reply, 'timestamp': time.time()})
            if len(conv) > 40:
                _ai_conversations[owner_id] = conv[-40:]

    # Generate TTS audio for voice reply (auto-play for voice interactions)
    want_tts = data.get('tts', True)
    response = {'success': True, 'reply': reply, 'transcript': transcript}
    if want_tts:
        tts_result = _generate_tts(reply)
        if tts_result.get('audio'):
            response['audio'] = tts_result['audio']
            response['audio_format'] = tts_result['format']
            response['audio_engine'] = tts_result.get('engine', 'unknown')

    return jsonify(response)


@app.route('/api/ai/transcribe-audio', methods=['POST'])
def ai_transcribe_audio():
    """Server-side audio transcription + AI response.
    Accepts audio file upload (webm/ogg/mp3/wav), transcribes using Google Speech Recognition,
    then sends transcript to DeepSeek for an AI response with TTS audio reply."""
    owner_id = request.form.get('owner_id', '') or request.form.get('device_id', '')

    if 'audio' not in request.files:
        return jsonify({'error': 'audio file required'}), 400

    audio_file = request.files['audio']
    audio_bytes = audio_file.read()
    if not audio_bytes or len(audio_bytes) < 100:
        return jsonify({'error': 'audio file too small or empty'}), 400

    # Detect format from mimetype or filename
    mime = audio_file.content_type or 'audio/webm'
    if 'webm' in mime or 'opus' in mime:
        audio_fmt = 'webm'
    elif 'ogg' in mime:
        audio_fmt = 'ogg'
    elif 'mp3' in mime or 'mpeg' in mime:
        audio_fmt = 'mp3'
    elif 'wav' in mime:
        audio_fmt = 'wav'
    elif 'mp4' in mime or 'm4a' in mime:
        audio_fmt = 'mp4'
    else:
        audio_fmt = 'webm'  # default for browser MediaRecorder

    print(f"[Transcribe] Received audio: {len(audio_bytes)} bytes, format={audio_fmt}, mime={mime}")

    # Server-side transcription
    transcript = _transcribe_audio(audio_bytes, audio_fmt)
    if not transcript:
        return jsonify({
            'success': False,
            'error': 'Could not transcribe audio. Please speak clearly and try again.',
            'transcript': None
        }), 200  # 200 so frontend can show the error message gracefully

    print(f"[Transcribe] Result: '{transcript}'")

    # Build messages with conversation history for context-aware replies
    messages = [
        {'role': 'system', 'content': 'You are BEAM AI, a helpful and intelligent assistant. The user sent a voice note that was transcribed to text. Respond naturally and helpfully to what they said. Be conversational and thorough.'}
    ]
    if owner_id:
        with _ai_lock:
            conv = _ai_conversations.get(owner_id, [])
            for msg in conv[-10:]:
                messages.append({'role': msg['role'], 'content': msg['content']})
    messages.append({'role': 'user', 'content': transcript})

    reply = _deepseek_chat(messages, max_tokens=1024, temperature=0.7)

    # Save to conversation history
    if owner_id:
        with _ai_lock:
            if owner_id not in _ai_conversations:
                _ai_conversations[owner_id] = []
            conv = _ai_conversations[owner_id]
            conv.append({'role': 'user', 'content': f'[Voice note]: {transcript}', 'timestamp': time.time()})
            conv.append({'role': 'assistant', 'content': reply, 'timestamp': time.time()})
            if len(conv) > 40:
                _ai_conversations[owner_id] = conv[-40:]

    # Generate TTS audio for voice reply (auto-play for voice conversations)
    response = {
        'success': True,
        'reply': reply,
        'transcript': transcript
    }
    tts_result = _generate_tts(reply)
    if tts_result.get('audio'):
        response['audio'] = tts_result['audio']
        response['audio_format'] = tts_result['format']
        response['audio_engine'] = tts_result.get('engine', 'unknown')

    return jsonify(response)


# ═══════════════════════════════════════════════════════════════════
# VERIFICATION (Blue Checkmark)
# ═══════════════════════════════════════════════════════════════════

@app.route('/api/verify/status/<user_id>')
def verify_status(user_id):
    """Check if a user is verified (manually or via premium)."""
    return jsonify({'verified': _is_verified(user_id)})

@app.route('/api/verify/grant', methods=['POST'])
def verify_grant():
    """Grant verification badge (admin/self for demo)."""
    data = request.json or {}
    user_id = data.get('user_id', '')
    if not user_id:
        return jsonify({'error': 'user_id required'}), 400
    _verified_users.add(user_id)
    _save_verified()
    return jsonify({'success': True, 'verified': True})

@app.route('/api/verify/revoke', methods=['POST'])
def verify_revoke():
    """Remove verification badge."""
    data = request.json or {}
    user_id = data.get('user_id', '')
    _verified_users.discard(user_id)
    _save_verified()
    return jsonify({'success': True, 'verified': False})

@app.route('/api/verify/list')
def verify_list():
    """List all verified users (includes premium users)."""
    # Combine manually-verified + premium device_ids
    all_verified = set(_verified_users)
    with _subs_lock:
        for did, sub in _subscriptions.items():
            if sub.get('status') == 'active':
                expires = sub.get('expires', 0)
                if not expires or time.time() <= expires:
                    all_verified.add(did)
    return jsonify({'verified_users': list(all_verified)})

@app.route('/api/verify/batch', methods=['POST'])
def verify_batch():
    """Check verification status for multiple user/device IDs at once."""
    data = request.json or {}
    ids = data.get('ids', [])
    result = {}
    for uid in ids:
        result[uid] = _is_verified(uid)
    return jsonify({'verified': result})


def open_firewall_ports(port, fast_port):
    """Open firewall ports so phones on the same Wi-Fi can connect.
    Uses netsh (not New-NetFirewallRule) — profile=any works on Public WiFi too.
    Triggers one UAC popup; safe to call repeatedly."""
    if sys.platform != 'win32':
        return  # macOS/Linux don't block LAN inbound by default

    import tempfile
    # Use netsh — confirmed to set Profiles: Domain,Private,Public correctly
    script = (
        f"netsh advfirewall firewall delete rule name=\"WirelessTransfer-{port}\" 2>nul\n"
        f"netsh advfirewall firewall delete rule name=\"WirelessTransfer-{fast_port}\" 2>nul\n"
        f"netsh advfirewall firewall delete rule name=\"WebRTC-UDP-In\" 2>nul\n"
        f"netsh advfirewall firewall add rule name=\"WirelessTransfer-{port}\" "
        f"dir=in action=allow protocol=TCP localport={port} profile=any enable=yes\n"
        f"netsh advfirewall firewall add rule name=\"WirelessTransfer-{fast_port}\" "
        f"dir=in action=allow protocol=TCP localport={fast_port} profile=any enable=yes\n"
        f"netsh advfirewall firewall add rule name=\"WebRTC-UDP-In\" "
        f"dir=in action=allow protocol=UDP localport=1024-65535 profile=any enable=yes\n"
    )

    try:
        tmp = tempfile.NamedTemporaryFile(suffix='.bat', delete=False, mode='w')
        tmp.write(script)
        tmp.close()

        result = subprocess.run(
            [
                'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                '-Command',
                f"Start-Process cmd -Verb RunAs -Wait -ArgumentList '/c \"{tmp.name}\"'"
            ],
            capture_output=True, timeout=30
        )
        os.unlink(tmp.name)

        if result.returncode == 0:
            print(f"  Firewall: ports {port} + {fast_port} open on all profiles (Public/Private/Domain)")
        else:
            raise RuntimeError(result.stderr.decode(errors='replace').strip())
    except Exception as e:
        print(f"  Could not auto-add firewall rules: {e}")
        print(f"  -> Run setup_firewall.bat as Administrator to fix manually.")


def generate_self_signed_cert():
    """Generate a self-signed SSL certificate for HTTPS."""
    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        import datetime

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'LocalBeam')])
        
        ip_addr = get_local_ip()
        san_list = [
            x509.DNSName('localhost'),
            x509.IPAddress(ipaddress.IPv4Address('127.0.0.1')),
        ]
        try:
            san_list.append(x509.IPAddress(ipaddress.IPv4Address(ip_addr)))
        except Exception:
            pass

        cert = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.datetime.now(datetime.timezone.utc))
            .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName(san_list), critical=False)
            .sign(key, hashes.SHA256())
        )

        cert_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.ssl')
        os.makedirs(cert_dir, exist_ok=True)
        cert_path = os.path.join(cert_dir, 'cert.pem')
        key_path = os.path.join(cert_dir, 'key.pem')

        with open(cert_path, 'wb') as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))
        with open(key_path, 'wb') as f:
            f.write(key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption()
            ))
        return cert_path, key_path
    except ImportError:
        # Fallback: use subprocess to call openssl if available
        try:
            cert_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.ssl')
            os.makedirs(cert_dir, exist_ok=True)
            cert_path = os.path.join(cert_dir, 'cert.pem')
            key_path = os.path.join(cert_dir, 'key.pem')
            
            if os.path.exists(cert_path) and os.path.exists(key_path):
                return cert_path, key_path

            subprocess.run([
                'openssl', 'req', '-x509', '-newkey', 'rsa:2048',
                '-keyout', key_path, '-out', cert_path,
                '-days', '365', '-nodes',
                '-subj', '/CN=LocalBeam'
            ], capture_output=True, check=True)
            return cert_path, key_path
        except Exception:
            return None, None


# ─── Subscription / Payment (Paystack + Stripe) ──────────────────
import stripe as _stripe_mod

_STRIPE_SECRET_KEY      = os.environ.get('STRIPE_SECRET_KEY', '')
_STRIPE_PUBLISHABLE_KEY = os.environ.get('STRIPE_PUBLISHABLE_KEY', '')
_STRIPE_WEBHOOK_SECRET  = os.environ.get('STRIPE_WEBHOOK_SECRET', '')

_PAYSTACK_SECRET_KEY    = os.environ.get('PAYSTACK_SECRET_KEY', '')
_PAYSTACK_PUBLIC_KEY    = os.environ.get('PAYSTACK_PUBLIC_KEY', '')

_stripe_mod.api_key = _STRIPE_SECRET_KEY

PREMIUM_PRICE_NGN   = 5000          # ₦5,000 / month
PREMIUM_PRICE_KOBO  = 5000 * 100    # Paystack uses kobo
PREMIUM_PRICE_USD   = 1000          # $10.00 in cents for Stripe

PREMIUM_FEATURES = ['ai_delegation', 'ai_voice_calls', 'unlimited_transfers', 'custom_bots', 'group_calls']

_subs_lock = threading.Lock()
_subscriptions = {}   # device_id -> {device_id, plan, provider, sub_id, reference, customer_email, status, created, expires}
_subs_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'subscriptions.json')

def _load_subscriptions():
    global _subscriptions
    try:
        if os.path.exists(_subs_file):
            with open(_subs_file, 'r') as f:
                _subscriptions = json.load(f)
    except Exception:
        _subscriptions = {}

def _save_subscriptions():
    try:
        with open(_subs_file, 'w') as f:
            json.dump(_subscriptions, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save subscriptions: {e}")

_load_subscriptions()

def _is_premium(device_id):
    """Check if a device has an active premium subscription."""
    with _subs_lock:
        sub = _subscriptions.get(device_id)
        if not sub:
            return False
        if sub.get('status') != 'active':
            return False
        expires = sub.get('expires', 0)
        if expires and time.time() > expires:
            sub['status'] = 'expired'
            _save_subscriptions()
            return False
        return True

def _require_premium(device_id, feature_name='this feature'):
    """Return an error response if not premium, else None."""
    if not _is_premium(device_id):
        return jsonify({
            'error': f'{feature_name} requires a Premium subscription.',
            'upgrade_required': True,
            'feature': feature_name
        }), 403
    return None


# ── Subscription status ──────────────────────────────────────────
@app.route('/api/subscription/status/<device_id>')
def subscription_status(device_id):
    """Check subscription status for a device."""
    is_prem = _is_premium(device_id)
    with _subs_lock:
        sub = _subscriptions.get(device_id, {})
    return jsonify({
        'is_premium': is_prem,
        'plan': sub.get('plan', 'free'),
        'provider': sub.get('provider', ''),
        'status': sub.get('status', 'none'),
        'expires': sub.get('expires', 0),
        'customer_email': sub.get('customer_email', ''),
        'premium_features': PREMIUM_FEATURES,
        'price_ngn': PREMIUM_PRICE_NGN,
        'price_usd': PREMIUM_PRICE_USD / 100
    })


# ── Stripe Checkout ──────────────────────────────────────────────
@app.route('/api/subscription/stripe/create-checkout', methods=['POST'])
def stripe_create_checkout():
    """Create a Stripe Checkout session for premium subscription."""
    data = request.get_json(force=True)
    device_id = data.get('device_id', '')
    email = data.get('email', '')
    success_url = data.get('success_url', request.host_url + 'desktop')
    cancel_url  = data.get('cancel_url', request.host_url + 'desktop')

    if not device_id:
        return jsonify({'error': 'device_id required'}), 400

    try:
        session = _stripe_mod.checkout.Session.create(
            payment_method_types=['card'],
            mode='subscription',
            customer_email=email or None,
            line_items=[{
                'price_data': {
                    'currency': 'usd',
                    'unit_amount': PREMIUM_PRICE_USD,
                    'recurring': {'interval': 'month'},
                    'product_data': {
                        'name': 'LocalBeam Premium',
                        'description': 'AI Delegation, Voice Calls, Unlimited Transfers, Custom Bots, Group Calls',
                    },
                },
                'quantity': 1,
            }],
            metadata={'device_id': device_id},
            success_url=success_url + '?session_id={CHECKOUT_SESSION_ID}',
            cancel_url=cancel_url,
        )
        return jsonify({'checkout_url': session.url, 'session_id': session.id})
    except Exception as e:
        print(f"Stripe checkout error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/subscription/stripe/verify', methods=['POST'])
def stripe_verify_session():
    """Verify a completed Stripe Checkout session and activate subscription."""
    data = request.get_json(force=True)
    session_id = data.get('session_id', '')
    device_id  = data.get('device_id', '')
    if not session_id or not device_id:
        return jsonify({'error': 'session_id and device_id required'}), 400

    try:
        session = _stripe_mod.checkout.Session.retrieve(session_id)
        if session.payment_status == 'paid':
            with _subs_lock:
                _subscriptions[device_id] = {
                    'device_id': device_id,
                    'plan': 'premium',
                    'provider': 'stripe',
                    'sub_id': session.subscription or session.id,
                    'reference': session.id,
                    'customer_email': session.customer_email or '',
                    'status': 'active',
                    'created': time.time(),
                    'expires': time.time() + 30 * 24 * 3600,  # 30 days
                }
                _save_subscriptions()
            return jsonify({'success': True, 'is_premium': True})
        else:
            return jsonify({'success': False, 'error': 'Payment not completed', 'payment_status': session.payment_status})
    except Exception as e:
        print(f"Stripe verify error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/subscription/stripe/webhook', methods=['POST'])
def stripe_webhook():
    """Handle Stripe webhook events (subscription renewals, cancellations)."""
    payload = request.get_data(as_text=True)
    sig_header = request.headers.get('Stripe-Signature', '')

    event = None
    if _STRIPE_WEBHOOK_SECRET:
        try:
            event = _stripe_mod.Webhook.construct_event(payload, sig_header, _STRIPE_WEBHOOK_SECRET)
        except Exception as e:
            print(f"Stripe webhook sig error: {e}")
            return jsonify({'error': 'Invalid signature'}), 400
    else:
        try:
            event = json.loads(payload)
        except:
            return jsonify({'error': 'Bad payload'}), 400

    event_type = event.get('type', '')

    if event_type == 'checkout.session.completed':
        session = event['data']['object']
        device_id = session.get('metadata', {}).get('device_id', '')
        if device_id:
            with _subs_lock:
                _subscriptions[device_id] = {
                    'device_id': device_id,
                    'plan': 'premium',
                    'provider': 'stripe',
                    'sub_id': session.get('subscription', session.get('id', '')),
                    'reference': session.get('id', ''),
                    'customer_email': session.get('customer_email', ''),
                    'status': 'active',
                    'created': time.time(),
                    'expires': time.time() + 30 * 24 * 3600,
                }
                _save_subscriptions()

    elif event_type == 'invoice.paid':
        sub_id = event['data']['object'].get('subscription', '')
        if sub_id:
            with _subs_lock:
                for did, sub in _subscriptions.items():
                    if sub.get('sub_id') == sub_id:
                        sub['status'] = 'active'
                        sub['expires'] = time.time() + 30 * 24 * 3600
                        _save_subscriptions()
                        break

    elif event_type in ('customer.subscription.deleted', 'invoice.payment_failed'):
        sub_id = event['data']['object'].get('id', '') or event['data']['object'].get('subscription', '')
        if sub_id:
            with _subs_lock:
                for did, sub in _subscriptions.items():
                    if sub.get('sub_id') == sub_id:
                        sub['status'] = 'cancelled'
                        _save_subscriptions()
                        break

    return jsonify({'received': True})


# ── Paystack ─────────────────────────────────────────────────────
@app.route('/api/subscription/paystack/initialize', methods=['POST'])
def paystack_initialize():
    """Initialize a Paystack transaction for premium subscription."""
    import urllib.request, urllib.error
    data = request.get_json(force=True)
    device_id = data.get('device_id', '')
    email     = data.get('email', '')
    callback_url = data.get('callback_url', request.host_url + 'browser')

    if not device_id or not email:
        return jsonify({'error': 'device_id and email required'}), 400
    if not _PAYSTACK_SECRET_KEY:
        return jsonify({'error': 'Paystack not configured. Contact admin.'}), 500

    payload = json.dumps({
        'email': email,
        'amount': PREMIUM_PRICE_KOBO,
        'currency': 'NGN',
        'callback_url': callback_url,
        'metadata': {'device_id': device_id, 'plan': 'premium'},
    }).encode('utf-8')

    req = urllib.request.Request(
        'https://api.paystack.co/transaction/initialize',
        data=payload,
        headers={
            'Authorization': f'Bearer {_PAYSTACK_SECRET_KEY}',
            'Content-Type': 'application/json',
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        if result.get('status'):
            return jsonify({
                'authorization_url': result['data']['authorization_url'],
                'access_code': result['data']['access_code'],
                'reference': result['data']['reference'],
            })
        else:
            return jsonify({'error': result.get('message', 'Paystack init failed')}), 500
    except Exception as e:
        print(f"Paystack init error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/subscription/paystack/verify/<reference>')
def paystack_verify(reference):
    """Verify a Paystack transaction and activate subscription."""
    import urllib.request, urllib.error
    if not _PAYSTACK_SECRET_KEY:
        return jsonify({'error': 'Paystack not configured'}), 500

    req = urllib.request.Request(
        f'https://api.paystack.co/transaction/verify/{reference}',
        headers={'Authorization': f'Bearer {_PAYSTACK_SECRET_KEY}'},
        method='GET'
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        if result.get('status') and result['data'].get('status') == 'success':
            device_id = result['data'].get('metadata', {}).get('device_id', '')
            email     = result['data'].get('customer', {}).get('email', '')
            if device_id:
                with _subs_lock:
                    _subscriptions[device_id] = {
                        'device_id': device_id,
                        'plan': 'premium',
                        'provider': 'paystack',
                        'sub_id': '',
                        'reference': reference,
                        'customer_email': email,
                        'status': 'active',
                        'created': time.time(),
                        'expires': time.time() + 30 * 24 * 3600,
                    }
                    _save_subscriptions()
                return jsonify({'success': True, 'is_premium': True})
            else:
                return jsonify({'error': 'No device_id in metadata'}), 400
        else:
            return jsonify({'success': False, 'error': 'Payment not successful', 'paystack_status': result.get('data', {}).get('status', '')})
    except Exception as e:
        print(f"Paystack verify error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/subscription/paystack/webhook', methods=['POST'])
def paystack_webhook():
    """Handle Paystack webhook events."""
    payload = request.get_json(force=True)
    event = payload.get('event', '')

    if event == 'charge.success':
        data = payload.get('data', {})
        device_id = data.get('metadata', {}).get('device_id', '')
        email     = data.get('customer', {}).get('email', '')
        reference = data.get('reference', '')
        if device_id:
            with _subs_lock:
                _subscriptions[device_id] = {
                    'device_id': device_id,
                    'plan': 'premium',
                    'provider': 'paystack',
                    'sub_id': '',
                    'reference': reference,
                    'customer_email': email,
                    'status': 'active',
                    'created': time.time(),
                    'expires': time.time() + 30 * 24 * 3600,
                }
                _save_subscriptions()

    return jsonify({'received': True})


# ── Cancel subscription ──────────────────────────────────────────
@app.route('/api/subscription/cancel', methods=['POST'])
def subscription_cancel():
    """Cancel a premium subscription."""
    data = request.get_json(force=True)
    device_id = data.get('device_id', '')
    if not device_id:
        return jsonify({'error': 'device_id required'}), 400

    with _subs_lock:
        sub = _subscriptions.get(device_id)
        if not sub or sub.get('status') != 'active':
            return jsonify({'error': 'No active subscription found'}), 404

        # Cancel with provider
        if sub['provider'] == 'stripe' and sub.get('sub_id'):
            try:
                _stripe_mod.Subscription.cancel(sub['sub_id'])
            except Exception as e:
                print(f"Stripe cancel error: {e}")

        sub['status'] = 'cancelled'
        _save_subscriptions()

    return jsonify({'success': True, 'message': 'Subscription cancelled'})


# ── Free Trial ───────────────────────────────────────────────────
@app.route('/api/subscription/free-trial', methods=['POST'])
def subscription_free_trial():
    """Activate a 7-day free premium trial for a device."""
    data = request.get_json(force=True)
    device_id = data.get('device_id', '')
    if not device_id:
        return jsonify({'error': 'device_id required'}), 400

    with _subs_lock:
        existing = _subscriptions.get(device_id)
        if existing and existing.get('status') == 'active':
            return jsonify({'error': 'You already have an active subscription'}), 400
        # Check if already used a trial
        if existing and existing.get('provider') == 'free_trial':
            return jsonify({'error': 'Free trial already used. Please subscribe to continue.'}), 400

        _subscriptions[device_id] = {
            'device_id': device_id,
            'plan': 'premium',
            'provider': 'free_trial',
            'sub_id': '',
            'reference': 'trial-' + uuid.uuid4().hex[:8],
            'customer_email': '',
            'status': 'active',
            'created': time.time(),
            'expires': time.time() + 7 * 24 * 3600,  # 7 days
        }
        _save_subscriptions()

    return jsonify({'success': True, 'is_premium': True, 'trial_days': 7})


# ── Subscription config (public keys for frontend) ────────────────
@app.route('/api/subscription/config')
def subscription_config():
    """Return public payment config for the frontend."""
    return jsonify({
        'stripe_publishable_key': _STRIPE_PUBLISHABLE_KEY,
        'paystack_public_key': _PAYSTACK_PUBLIC_KEY,
        'price_ngn': PREMIUM_PRICE_NGN,
        'price_usd': PREMIUM_PRICE_USD / 100,
        'premium_features': PREMIUM_FEATURES,
        'stripe_enabled': bool(_STRIPE_SECRET_KEY),
        'paystack_enabled': bool(_PAYSTACK_SECRET_KEY),
    })


def start_server(port=5000, directory=None):
    """Start the Flask server + raw-socket FastTransferServer"""
    global server_ip, server_port, fast_transfer_port, shared_directory, is_running, ssl_enabled

    server_ip   = get_local_ip()
    server_port = port
    fast_transfer_port = port + 1

    if directory:
        # Always resolve to absolute path so security checks work
        shared_directory = str(Path(directory).resolve())
    else:
        # Default to Downloads directory
        downloads = os.path.join(str(Path.home()), 'Downloads')
        if os.path.exists(downloads):
            shared_directory = downloads
        else:
            shared_directory = os.getcwd()

    # Open firewall ports so phones can connect (triggers UAC once on Windows)
    print("Opening firewall ports (you may see a UAC popup - click Yes)...")
    open_firewall_ports(port, fast_transfer_port)

    print(f"")
    print(f"Starting Wireless File Transfer Server...")

    # Generate SSL certificate for HTTPS (needed for mic access on phones)
    ssl_context = None
    cert_path, key_path = generate_self_signed_cert()
    if cert_path and key_path:
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_context.load_cert_chain(cert_path, key_path)
        ssl_enabled = True
        protocol = 'https'
        print(f"  HTTPS enabled (self-signed certificate)")
        print(f"  NOTE: Your phone browser will show a security warning — tap 'Advanced' then 'Proceed' to continue.")
    else:
        protocol = 'http'
        print(f"  WARNING: HTTPS not available. Microphone won't work on phones.")
        print(f"  Install 'cryptography' package: pip install cryptography")

    print(f"Web UI:            {protocol}://{server_ip}:{port}")
    print(f"Phone browse URL:  {protocol}://{server_ip}:{port}/browser")
    print(f"Fast Transfer:     http://{server_ip}:{fast_transfer_port}  (raw socket)")
    print(f"Shared directory:  {shared_directory}")
    print(f"QR Code ready! Scan with your phone to connect.")
    print("\nPress Ctrl+C to stop the server")

    # Start raw-socket fast transfer server on port+1
    try:
        fast_server = FastTransferServer(fast_transfer_port, shared_directory)
        fast_thread = threading.Thread(target=fast_server.serve_forever, daemon=True)
        fast_thread.start()
        print(f"Fast Transfer Server started on port {fast_transfer_port}")
    except Exception as e:
        print(f"Warning: Could not start fast transfer server: {e}")
        fast_transfer_port = None

    # Start file watcher
    watcher = start_file_watcher(shared_directory)

    # Start Telegram bot(s) if configured
    if _telegram_available:
        try:
            _telegram.auto_start()
        except Exception as e:
            print(f"[TELEGRAM] Auto-start error: {e}")

    try:
        app.run(host='0.0.0.0', port=port, debug=False, threaded=True, ssl_context=ssl_context)
    except KeyboardInterrupt:
        print("\nShutting down server...")
    finally:
        watcher.stop()
        watcher.join()

if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Wireless File Transfer Server')
    parser.add_argument('--port', type=int, default=5000, help='Port to run server on')
    parser.add_argument('--directory', type=str, help='Directory to share')
    parser.add_argument('--open-browser', action='store_true', help='Open browser automatically')
    
    args = parser.parse_args()
    
    if args.open_browser:
        # Open browser after a short delay
        def open_browser():
            time.sleep(2)
            webbrowser.open(f'https://localhost:{args.port}')
        
        threading.Thread(target=open_browser, daemon=True).start()
    
    start_server(args.port, args.directory)