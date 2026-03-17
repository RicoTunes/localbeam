/* ═══════════════════════════════════════════════════════════════
   DESKTOP DASHBOARD JS v1
   LocalBeam — Professional Dashboard with E2EE
   ═══════════════════════════════════════════════════════════════ */

const API_BASE = window.location.origin + '/api';
let currentPage = 'devices';

// ── Toast notifications ──────────────────────────────────────
function showNotification(message, type = 'info') {
  let container = document.getElementById('desktopToastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'desktopToastContainer';
    container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  const bgColor = type === 'success' ? '#22C55E' : type === 'error' ? '#EF4444' : '#667EEA';
  toast.style.cssText = `background:${bgColor};color:#fff;padding:10px 18px;border-radius:10px;font-size:14px;font-family:Poppins,sans-serif;`
    + 'box-shadow:0 4px 12px rgba(0,0,0,0.3);opacity:0;transform:translateX(40px);transition:all 0.3s ease;pointer-events:auto;max-width:340px;word-break:break-word;';
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
  setTimeout(() => {
    toast.style.opacity = '0'; toast.style.transform = 'translateX(40px)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
let files = [];
let devices = [];
let p2pDevices = [];
let p2pFiles = [];
let transferHistory = [];
let selectedFiles = new Set();
let currentPath = ['Home'];
let viewMode = 'grid'; // grid or list
let desktopDeviceId = null;
let desktopDeviceName = 'LocalBeam Desktop';
let p2pPollInterval = null;
let targetP2PDeviceId = null; // Track which device to send files to
let _deskOnlineAvailable = true;

// E2EE State
let e2eeEnabled = false;
let desktopPublicKey = null;

// Voice recording and microphone permission state
let desktopMicrophonePermission = 'prompt'; // 'prompt', 'granted', or 'denied'

// ── Reply State ──────────────────────────────────────────────
let _deskReplyTo = null; // { id, sender_id, sender_name, text }

// ── Auth State ───────────────────────────────────────────────
let authToken = localStorage.getItem('lb_auth_token') || null;
let authUser  = JSON.parse(localStorage.getItem('lb_auth_user') || 'null');
let authFriends = [];
let authFriendRequests = { incoming: [], outgoing: [] };


// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  loadInitialData();
  setInterval(() => refreshData(true), 5000); // Auto-refresh every 5s (silent)
});

function initEventListeners() {
  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      navigateTo(page);
    });
  });



  // Header buttons
  document.getElementById('refreshBtn').addEventListener('click', () => refreshData(false));
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('toggleSidebar').addEventListener('click', toggleSidebar);

  // Enter to send chat message, Escape to cancel edit/forward/reply
  document.getElementById('desktopChatInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendDesktopChatMessage();
    } else if (e.key === 'Escape') {
      if (_deskEditMsg) cancelDeskEdit();
      else if (_deskForwardMsg) cancelDeskForward();
      else if (_deskReplyTo) cancelDeskReply();
    }
  });
  // Auto-grow textarea with smart scrollbar
  document.getElementById('desktopChatInput').addEventListener('input', function() {
    this.style.height = 'auto';
    const h = Math.min(this.scrollHeight, 100);
    this.style.height = h + 'px';
    // Show scrollbar only when content overflows
    if (this.scrollHeight > 100) {
      this.classList.add('has-scroll');
    } else {
      this.classList.remove('has-scroll');
    }
    // Signal typing
    _emitDesktopTyping();
  });

  // Share actions
  document.getElementById('sendFilesBtn').addEventListener('click', sendFilesToDevice);

  // Settings
  document.getElementById('themeSelect').addEventListener('change', applyTheme);
}

async function loadInitialData() {
  try {
    // Initialize E2EE Crypto in background (non-blocking)
    initE2EEAsync();
    
    // Note: Microphone permission will be requested when user clicks record button, not on page load
    
    // Register desktop as P2P device first
    await registerDesktopDevice();
    
    // Restore auth session if token exists
    await restoreAuthSession();
    
    await Promise.all([
      loadDevices(),
      loadP2PData(),
      loadTransferHistory(),
      loadDesktopChatList()
    ]);
    updateStats();
    
    // Start polling for P2P updates
    startP2PPoll();
    
    // Start polling for incoming calls globally (works on any page)
    pollIncomingCalls();
    
    // Poll chat list every 5 seconds
    setInterval(() => {
      if (currentPage === 'chat') {
        loadDesktopChatList();
      }
    }, 5000);
    
    // Set Devices page as default home
    navigateTo('share');
  } catch (err) {
    console.error('Failed to load initial data:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
// E2EE ENCRYPTION SUPPORT
// ═══════════════════════════════════════════════════════════════

// Non-blocking async initialization (runs in background)
function initE2EEAsync() {
  setTimeout(async () => {
    try {
      await initE2EE();
    } catch (err) {
      console.error('[E2EE] Async init failed:', err);
    }
  }, 100);
}

async function initE2EE() {
  try {
    if (typeof LocalBeamCrypto === 'undefined' || !LocalBeamCrypto) {
      console.warn('[E2EE] Crypto module not loaded');
      e2eeEnabled = false;
      updateE2EEIndicator();
      return;
    }
    
    if (!LocalBeamCrypto.isSupported()) {
      console.warn('[E2EE] WebCrypto not supported in this browser');
      e2eeEnabled = false;
      updateE2EEIndicator();
      return;
    }
    
    const result = await LocalBeamCrypto.init();
    desktopPublicKey = result.publicKey;
    e2eeEnabled = true;
    
    console.log('[E2EE] Initialized with public key:', desktopPublicKey.substring(0, 20) + '...');
    updateE2EEIndicator();
  } catch (err) {
    console.error('[E2EE] Initialization failed:', err);
    e2eeEnabled = false;
    updateE2EEIndicator();
  }
}

function updateE2EEIndicator() {
  // Update UI to show E2EE status (icon only)
  const indicator = document.getElementById('e2eeIndicator');
  if (indicator) {
    indicator.innerHTML = e2eeEnabled 
      ? '<i class="fas fa-lock"></i>'
      : '<i class="fas fa-lock-open"></i>';
    indicator.className = `e2ee-indicator ${e2eeEnabled ? 'secure' : 'insecure'}`;
    indicator.title = e2eeEnabled ? 'End-to-End Encryption Enabled' : 'End-to-End Encryption Disabled';
  }
}

async function fetchAndImportPeerKey(deviceId) {
  try {
    if (typeof LocalBeamCrypto === 'undefined' || !LocalBeamCrypto) {
      console.warn('[E2EE] Crypto module not available');
      return false;
    }
    
    // First check if we already have the key
    if (LocalBeamCrypto.hasKeyFor(deviceId)) {
      return true;
    }
    
    // Fetch from server
    const res = await fetch(`${API_BASE}/p2p/key/${deviceId}`);
    if (!res.ok) {
      console.warn(`[E2EE] No key available for device: ${deviceId}`);
      return false;
    }
    
    const data = await res.json();
    const success = await LocalBeamCrypto.importPeerKey(deviceId, data.public_key);
    
    if (success) {
      console.log(`[E2EE] Key exchange complete with: ${data.name}`);
    }
    return success;
  } catch (err) {
    console.error('[E2EE] Failed to fetch peer key:', err);
    return false;
  }
}

async function refreshData(silent) {
  if (!silent) {
    const btn = document.getElementById('refreshBtn');
    if (btn) { btn.classList.add('spin'); setTimeout(() => btn.classList.remove('spin'), 800); }
  }
  if (currentPage === 'share') await loadP2PData();
  else if (currentPage === 'stats') { await loadTransferHistory(); updateStats(); }
  else if (currentPage === 'chat') await loadDesktopChatList();
  else if (currentPage === 'calls') await loadCallsPage();
  else if (currentPage === 'groups') await loadGroupsPage();
  else if (currentPage === 'bots') await loadBotsPage();
  else if (currentPage === 'status') await deskStatusLoadFeed();
  else if (currentPage === 'settings' && authToken) await restoreAuthSession();
  if (!silent) showNotification('Refreshed', 'success');
}

// ═══════════════════════════════════════════════════════════════
// P2P DEVICE REGISTRATION (Desktop as Device)
// ═══════════════════════════════════════════════════════════════

async function registerDesktopDevice() {
  try {
    // Load or generate desktop device ID
    if (!desktopDeviceId) {
      const stored = localStorage.getItem('desktopDeviceId');
      if (stored) {
        desktopDeviceId = stored;
      } else {
        desktopDeviceId = 'desktop-' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('desktopDeviceId', desktopDeviceId);
      }
    }

    // Register desktop with server (include E2EE public key)
    const res = await fetch(`${API_BASE}/p2p/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: desktopDeviceId,
        name: desktopDeviceName,
        user_agent: 'Desktop Dashboard',
        public_key: desktopPublicKey || ''  // E2EE public key
      })
    });

    if (res.ok) {
      const data = await res.json();
      desktopDeviceId = data.device_id;
      console.log('Desktop registered as device:', desktopDeviceId, 'E2EE:', data.e2ee);
    }
  } catch (err) {
    console.error('Failed to register desktop device:', err);
  }
}

function startP2PPoll() {
  if (p2pPollInterval) clearInterval(p2pPollInterval);
  
  // Poll every 3 seconds when on Share page
  p2pPollInterval = setInterval(() => {
    if (!_deskOnlineAvailable) return;
    if (currentPage === 'share') {
      loadP2PData();
      // Also refresh desktop's heartbeat
      registerDesktopDevice();
    }
  }, 3000);
}

/* ── Online Availability Toggle ── */
function toggleDesktopOnline(isOnline) {
  _deskOnlineAvailable = isOnline;
  const statusEl = document.getElementById('deskOnlineStatus');
  if (statusEl) {
    statusEl.textContent = isOnline ? 'Receiving messages & files' : 'Paused — not receiving';
    statusEl.style.color = isOnline ? 'var(--text-muted)' : '#EF4444';
  }
  if (!isOnline) {
    if (p2pPollInterval) { clearInterval(p2pPollInterval); p2pPollInterval = null; }
    if (_deskChatPollInterval) { clearInterval(_deskChatPollInterval); _deskChatPollInterval = null; }
    if (_deskTypingPollTimer) { clearInterval(_deskTypingPollTimer); _deskTypingPollTimer = null; }
    // Unregister so other devices don't see us
    if (desktopDeviceId) {
      fetch(`${API_BASE}/p2p/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: desktopDeviceId })
      }).catch(() => {});
    }
  } else {
    registerDesktopDevice();
    startP2PPoll();
    // Re-open chat poll if a conversation was open
    const chatPanel = document.getElementById('desktopChatPanel');
    if (chatPanel && !chatPanel.classList.contains('hidden') && _deskChatCurrentConversation) {
      loadDesktopChatMessages(_deskChatCurrentConversation);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION
// ═════════════════════════════════════════════════════════════════

function navigateTo(page) {
  // Auto-PiP: if in a call on the calls page and navigating away, show PiP
  if (_currentCallId && !_pipActive && !_callFromChat && currentPage === 'calls' && page !== 'calls') {
    enterPiP();
  }

  // Update active nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });

  // Update active page
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');

  // Close sidebar on mobile
  if (window.innerWidth < 768) {
    document.querySelector('.sidebar').classList.remove('open');
    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.classList.remove('active');
  }

  currentPage = page;

  // Load page data
  if (page === 'share') { loadDevices(); loadP2PData(); }
  else if (page === 'chat') loadDesktopChatList();
  else if (page === 'calls') loadCallsPage();
  else if (page === 'groups') loadGroupsPage();
  else if (page === 'bots') loadBotsPage();
  else if (page === 'stats') {
    loadTransferHistory();
    updateStats();
  } else if (page === 'settings') loadSettings();
  else if (page === 'status') deskStatusInit();
  else if (page === 'subscription') loadSubscriptionPage();
}

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  
  if (window.innerWidth < 768) {
    // Mobile: slide in/out with overlay
    sidebar.classList.toggle('open');
    sidebar.classList.remove('collapsed');
    if (overlay) overlay.classList.toggle('active', sidebar.classList.contains('open'));
  } else {
    // Desktop/tablet: collapse/expand width
    sidebar.classList.toggle('collapsed');
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
  }
}

// Close sidebar when clicking overlay
document.addEventListener('DOMContentLoaded', function() {
  const overlay = document.getElementById('sidebarOverlay');
  if (overlay) {
    overlay.addEventListener('click', function() {
      document.querySelector('.sidebar').classList.remove('open');
      overlay.classList.remove('active');
    });
  }
  
  // Close button inside sidebar
  const closeBtn = document.getElementById('closeSidebar');
  if (closeBtn) {
    closeBtn.addEventListener('click', toggleSidebar);
  }
});

// ═══════════════════════════════════════════════════════════════
// FILE MANAGEMENT (P2P Shared Files Only)
// ═══════════════════════════════════════════════════════════════

async function loadFiles() {
  // Load ONLY P2P shared files - not the entire PC filesystem
  try {
    const response = await fetch(`${API_BASE}/p2p/files`);
    const data = await response.json();
    files = data.files || [];
    renderFiles();
  } catch (err) {
    console.error('Failed to load files:', err);
  }
}

function renderFiles() {
  const fileView = document.getElementById('fileView');
  
  if (files.length === 0) {
    fileView.innerHTML = `
      <div class="file-loading">
        <div class="empty-state">
          <i class="fas fa-lock"></i>
          <p>No shared files yet</p>
          <p style="font-size: 12px; opacity: 0.7; margin-top: 8px;">Files shared between devices will appear here</p>
        </div>
      </div>
    `;
    return;
  }

  fileView.innerHTML = files
    .map(file => {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      const isVideo = ['.mp4','.avi','.mov','.mkv','.wmv','.webm'].includes(ext);
      const isAudio = ['.mp3','.wav','.flac','.aac','.ogg','.m4a'].includes(ext);
      const isImage = ['.jpg','.jpeg','.png','.gif','.bmp','.webp','.svg'].includes(ext);
      
      return `
      <div class="file-item" data-file="${file.name}" data-id="${file.id}">
        <input type="checkbox" class="file-checkbox" data-file="${file.name}" data-id="${file.id}">
        <div class="file-icon">
          ${getFileIcon(file.name)}
        </div>
        <div class="file-name" title="${file.name}">${truncate(file.name, 15)}</div>
        <div class="file-size">${formatBytes(file.size)}</div>
      </div>
    `})
    .join('');

  // Add checkbox listeners
  fileView.querySelectorAll('.file-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const fileId = e.target.dataset.id;
      if (e.target.checked) {
        selectedFiles.add(fileId);
        e.target.closest('.file-item').classList.add('selected');
      } else {
        selectedFiles.delete(fileId);
        e.target.closest('.file-item').classList.remove('selected');
      }
      updateSelectionUI();
    });
  });

  // Add click to details - uses P2P file IDs now
  fileView.querySelectorAll('.file-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (!e.target.classList.contains('file-checkbox')) {
        const fileId = item.dataset.id;
        const filename = item.dataset.file;
        const ext = '.' + filename.split('.').pop().toLowerCase();
        const fileUrl = `${API_BASE}/p2p/download/${fileId}`;
        
        // Open appropriate viewer based on file type
        if (['.mp4','.avi','.mov','.mkv','.wmv','.webm'].includes(ext)) {
          openVideoPlayer(fileUrl, filename);
        } else if (['.mp3','.wav','.flac','.aac','.ogg','.m4a'].includes(ext)) {
          openAudioPlayer(fileUrl, filename);
        } else if (['.jpg','.jpeg','.png','.gif','.bmp','.webp','.svg'].includes(ext)) {
          openImageViewer(fileUrl, filename);
        } else if (['.pdf','.doc','.docx','.txt','.xls','.xlsx','.ppt','.pptx'].includes(ext)) {
          window.open(fileUrl, '_blank');
        }
      }
    });
  });
}

function updateSelectionUI() {
  const count = selectedFiles.size;
  document.querySelector('.selected-count').textContent = 
    count === 0 ? '0 selected' : `${count} selected`;
  document.getElementById('selectAll').checked = count === files.length;
  document.getElementById('downloadSelectedBtn').disabled = count === 0;
  document.getElementById('deleteSelectedBtn').disabled = count === 0;
}

function selectAllFiles(e) {
  if (e.target.checked) {
    files.forEach(f => selectedFiles.add(f.id));
  } else {
    selectedFiles.clear();
  }
  renderFiles();
  updateSelectionUI();
}

async function downloadSelectedFiles() {
  if (selectedFiles.size === 0) return;
  
  for (const fileId of selectedFiles) {
    const file = files.find(f => f.id === fileId);
    if (file) {
      try {
        showNotification(`Downloading ${file.name}...`);
        const response = await fetch(`${API_BASE}/p2p/download/${fileId}`);
        if (!response.ok) throw new Error('Download failed');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showNotification(`Downloaded ${file.name}`, 'success');
      } catch (err) {
        console.error('Failed to download:', err);
        showNotification(`Failed to download ${file.name}`, 'error');
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

async function deleteSelectedFiles() {
  if (!confirm(`Delete ${selectedFiles.size} file(s)?`)) return;

  for (const fileId of selectedFiles) {
    try {
      await fetch(`${API_BASE}/p2p/delete/${fileId}`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  }

  selectedFiles.clear();
  await loadFiles();
}

async function handleFileUpload(e) {
  const files = Array.from(e.target.files);
  
  if (targetP2PDeviceId) {
    // Send to P2P device
    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('recipient_id', targetP2PDeviceId);
      
      try {
        const res = await fetch(`${API_BASE}/p2p/send`, {
          method: 'POST',
          body: formData
        });
        
        if (res.ok) {
          console.log(`File ${file.name} sent to device`);
        } else {
          alert(`Failed to send ${file.name}`);
        }
      } catch (err) {
        console.error('Failed to send file:', err);
        alert(`Error sending ${file.name}`);
      }
    }
    
    targetP2PDeviceId = null; // Reset
    await loadP2PData(); // Refresh
  } else {
    // Upload to shared directory
    const formData = new FormData();
    files.forEach(file => {
      formData.append('files', file);
    });

    try {
      await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: formData
      });
      await loadFiles();
    } catch (err) {
      console.error('Upload failed:', err);
    }
  }

  e.target.value = '';
}

function filterFiles(query) {
  const items = document.querySelectorAll('.file-item');
  items.forEach(item => {
    const name = item.dataset.file.toLowerCase();
    item.style.display = name.includes(query.toLowerCase()) ? '' : 'none';
  });
}

function toggleFileView() {
  viewMode = viewMode === 'grid' ? 'list' : 'grid';
  document.getElementById('fileView').classList.toggle('list-view', viewMode === 'list');
  document.getElementById('toggleViewBtn').innerHTML = 
    viewMode === 'grid' 
      ? '<i class="fas fa-list"></i> List'
      : '<i class="fas fa-th"></i> Grid';
}

// ═══════════════════════════════════════════════════════════════
// P2P SHARING
// ═══════════════════════════════════════════════════════════════

// Store P2P file metadata by ID for safe access
let p2pFileMetadata = {};

let _deskQrCached = null; // cache QR so we don't refetch every poll

async function loadP2PData() {
  try {
    // Only fetch QR once (it doesn't change), cache it
    const fetches = [
      fetch(`${API_BASE}/p2p/devices`),
      fetch(`${API_BASE}/p2p/files`)
    ];
    if (!_deskQrCached) fetches.push(fetch(`${API_BASE}/p2p/qr`));

    const results = await Promise.all(fetches);

    const devicesData = await results[0].json();
    const filesData = await results[1].json();

    if (!_deskQrCached && results[2]) {
      try {
        const qrData = await results[2].json();
        if (qrData.qr) _deskQrCached = qrData;
      } catch (_) {}
    }

    // Extract arrays from responses
    p2pDevices = devicesData.devices || [];
    p2pFiles = filesData.files || [];
    
    // Store metadata for safe access
    p2pFileMetadata = {};
    p2pFiles.forEach(f => {
      p2pFileMetadata[f.id] = f;
    });

    renderP2PUI(_deskQrCached || {});
  } catch (err) {
    console.error('Failed to load P2P data:', err);
  }
}

function renderP2PUI(qrData) {
  // Clear devices list and shared files list FIRST to prevent duplication
  const devicesList = document.getElementById('devicesList');
  const sharedFilesList = document.getElementById('sharedFilesList');
  if (devicesList) devicesList.innerHTML = '';
  if (sharedFilesList) sharedFilesList.innerHTML = '';
  
  // Update desktop device info (use existing container instead of creating new elements)
  const desktopInfoContainer = document.getElementById('desktopDeviceInfo');
  if (desktopInfoContainer) {
    desktopInfoContainer.innerHTML = `
      <div style="margin-bottom: 8px;"><strong>Name:</strong> ${desktopDeviceName}</div>
      <div><strong>ID:</strong> <code style="background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 11px;">${desktopDeviceId || 'Registering...'}</code></div>
    `;
  }

  // QR Code - now points to desktop device instead of just browser
  if (qrData.qr) {
    const qrContainer = document.getElementById('qrContainer');
    if (qrContainer) {
      qrContainer.innerHTML = `
        <div style="text-align: center;">
          <img src="data:image/png;base64,${qrData.qr.split(',')[1] || qrData.qr}" alt="QR Code" style="max-width: 100%; border-radius: 8px;">
          <p style="font-size: 12px; color: #94A3B8; margin-top: 8px;">Scan with your phone to pair</p>
        </div>
      `;
    }
  }

  // Connected Devices (exclude self)
  const targetDeviceSelect = document.getElementById('targetDevice');

  // Filter out desktop itself from the list
  const otherDevices = p2pDevices.filter(d => d.id !== desktopDeviceId);

  if (otherDevices.length === 0) {
    if (devicesList) devicesList.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-wifi"></i>
        <p>No other devices connected</p>
        <p style="font-size: 12px; margin-top: 8px;">Scan the QR code with your phone to add devices</p>
      </div>
    `;
    targetDeviceSelect.innerHTML = '<option>Select a device...</option>';
  } else {
    if (devicesList) devicesList.innerHTML = otherDevices
      .map(d => {
        // Calculate if online (last_seen within 10 seconds)
        const now = Date.now() / 1000;
        const isOnline = (now - (d.last_seen || 0)) < 10;
        return `
          <div class="device-item">
            <div>
              <div class="device-name">${d.name} ${vBadge(d.id)}</div>
              <div class="device-status">
                <span class="device-dot ${isOnline ? '' : 'offline'}"></span>
                ${isOnline ? 'Online' : 'Offline'}
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    // Preserve selected value if it exists
    const currentSelection = targetDeviceSelect.value;
    
    targetDeviceSelect.innerHTML = `
      <option value="">Select a device...</option>
      ${otherDevices.map(d => `<option value="${d.id}" ${d.id === currentSelection ? 'selected' : ''}>${d.name} ${d.e2ee ? '🔒' : ''}</option>`).join('')}
    `;
  }

  // Update devices table (Share page)
  const devicesTableBody = document.getElementById('devicesTableBody');
  if (devicesTableBody) {
    if (otherDevices.length === 0) {
      devicesTableBody.innerHTML = '<tr class="empty-row"><td colspan="5" class="text-center text-muted">No devices connected</td></tr>';
    } else {
      devicesTableBody.innerHTML = otherDevices.map(d => {
        const now = Date.now() / 1000;
        const isOnline = (now - (d.last_seen || 0)) < 10;
        const lastSeen = d.last_seen ? new Date(d.last_seen * 1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';
        return `<tr>
          <td><strong>${d.name}</strong></td>
          <td>${d.device_type || 'Unknown'}</td>
          <td><span class="device-dot ${isOnline ? '' : 'offline'}"></span> ${isOnline ? 'Online' : 'Offline'}</td>
          <td>${lastSeen}</td>
          <td><button class="btn btn-sm btn-primary" onclick="document.getElementById('targetDevice').value='${d.id}'"><i class="fas fa-paper-plane"></i></button></td>
        </tr>`;
      }).join('');
    }
  }

  // Shared Files
  if (p2pFiles.length === 0) {
    if (sharedFilesList) sharedFilesList.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-inbox"></i>
        <p>No files shared yet</p>
      </div>
    `;
  } else {
    if (sharedFilesList) sharedFilesList.innerHTML = p2pFiles
      .map(f => {
        const displayName = f.original_name || f.name;
        const ext = '.' + displayName.split('.').pop().toLowerCase();
        const isVideo = ['.mp4','.avi','.mov','.mkv','.wmv','.webm'].includes(ext);
        const isAudio = ['.mp3','.wav','.flac','.aac','.ogg','.m4a'].includes(ext);
        const isImage = ['.jpg','.jpeg','.png','.gif','.bmp','.webp','.svg'].includes(ext);
        const isDoc = ['.pdf','.doc','.docx','.txt','.xls','.xlsx','.ppt','.pptx'].includes(ext);
        const isEncrypted = f.encrypted === true;
        
        // E2EE indicator
        const encryptIcon = isEncrypted ? '<i class="fas fa-lock e2ee-badge" title="End-to-End Encrypted"></i> ' : '';
        
        let actionBtn = '';
        
        if (isVideo || isAudio) {
          actionBtn = `<button class="btn btn-sm btn-primary p2p-action" data-action="play" data-file-id="${f.id}" title="Play"><i class="fas fa-play"></i></button>`;
        } else if (isImage) {
          actionBtn = `<button class="btn btn-sm btn-info p2p-action" data-action="view" data-file-id="${f.id}" title="View"><i class="fas fa-eye"></i></button>`;
        } else if (isDoc) {
          actionBtn = `<button class="btn btn-sm btn-info p2p-action" data-action="open" data-file-id="${f.id}" title="Open"><i class="fas fa-external-link-alt"></i></button>`;
        }
        
        return `
        <div class="file-item-small ${isEncrypted ? 'encrypted' : ''}" data-file-id="${f.id}">
          <div style="cursor: pointer; flex: 1; min-width: 0;" class="p2p-file-main">
            <div class="file-item-small-name" title="${displayName}">${encryptIcon}${displayName}</div>
            <div class="file-item-small-size">${formatBytes(f.size)} • from ${f.sender_name || 'Unknown'}</div>
          </div>
          <div class="btn-group">
            ${actionBtn}
            <button class="btn btn-sm btn-success p2p-action" data-action="download" data-file-id="${f.id}" title="Download">
              <i class="fas fa-download"></i>
            </button>
            <button class="btn btn-sm btn-danger p2p-delete" data-file-id="${f.id}" title="Delete">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </div>
      `})
      .join('');
      
      // Attach event listeners to P2P action buttons
      sharedFilesList.querySelectorAll('.p2p-action').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          const fileId = btn.dataset.fileId;
          const fileData = p2pFileMetadata[fileId];
          
          if (!fileData) {
            console.error('File data not found:', fileId);
            return;
          }
          
          const displayName = fileData.original_name || fileData.name;
          const senderId = fileData.sender_id || '';
          const isEncrypted = fileData.encrypted === true;
          
          if (action === 'play') playP2PFile(fileId, displayName, senderId, isEncrypted);
          else if (action === 'view') viewP2PImage(fileId, displayName, senderId, isEncrypted);
          else if (action === 'open') openP2PDocument(fileId, displayName, senderId, isEncrypted);
          else if (action === 'download') downloadP2PFile(fileId, displayName, senderId, isEncrypted);
        });
      });
      
      // Attach event listeners to delete buttons
      sharedFilesList.querySelectorAll('.p2p-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const fileId = btn.dataset.fileId;
          deleteP2PFile(fileId);
        });
      });
      
      // Attach event listeners to file main area (for click to play/view)
      sharedFilesList.querySelectorAll('.p2p-file-main').forEach(area => {
        area.addEventListener('click', (e) => {
          const container = area.closest('.file-item-small');
          const fileId = container.dataset.fileId;
          const fileData = p2pFileMetadata[fileId];
          
          if (!fileData) return;
          
          const displayName = fileData.original_name || fileData.name;
          const senderId = fileData.sender_id || '';
          const isEncrypted = fileData.encrypted === true;
          
          // Default action depends on file type
          const ext = '.' + displayName.split('.').pop().toLowerCase();
          if (['.mp4','.avi','.mov','.mkv','.wmv','.webm'].includes(ext)) {
            playP2PFile(fileId, displayName, senderId, isEncrypted);
          } else if (['.mp3','.wav','.flac','.aac','.ogg','.m4a'].includes(ext)) {
            playP2PFile(fileId, displayName, senderId, isEncrypted);
          } else if (['.jpg','.jpeg','.png','.gif','.bmp','.webp','.svg'].includes(ext)) {
            viewP2PImage(fileId, displayName, senderId, isEncrypted);
          } else if (['.pdf','.doc','.docx','.txt','.xls','.xlsx','.ppt','.pptx'].includes(ext)) {
            openP2PDocument(fileId, displayName, senderId, isEncrypted);
          } else {
            downloadP2PFile(fileId, displayName, senderId, isEncrypted);
          }
        });
      });
  }
}

async function sendFilesToDevice() {
  const deviceId = document.getElementById('targetDevice').value;
  if (!deviceId || deviceId === '') {
    alert('Please select a device first');
    return;
  }

  // Store the device ID before opening file picker
  targetP2PDeviceId = deviceId;
  console.log('Sending files to device:', targetP2PDeviceId);
  
  // E2EE key exchange skipped — file encryption disabled for compatibility
  
  // Use p2pFileInput for P2P transfers
  let p2pInput = document.getElementById('p2pFileInput');
  if (!p2pInput) {
    p2pInput = document.createElement('input');
    p2pInput.type = 'file';
    p2pInput.id = 'p2pFileInput';
    p2pInput.multiple = true;
    p2pInput.style.display = 'none';
    p2pInput.addEventListener('change', handleP2PFileUpload);
    document.body.appendChild(p2pInput);
  }
  p2pInput.click();
}

async function handleP2PFileUpload(e) {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;
  
  const deviceId = targetP2PDeviceId;
  if (!deviceId) {
    alert('No device selected');
    return;
  }
  
  console.log(`Sending ${files.length} files to ${deviceId}`);
  
  // E2EE file encryption disabled — HTTPS already secures the local network transport,
  // and the receiving browser has no decryption support, causing .enc files that can't be opened.
  const canEncrypt = false;
  
  for (const file of files) {
    try {
      const formData = new FormData();
      
      if (canEncrypt && LocalBeamCrypto) {
        // Encrypt file before sending
        console.log(`[E2EE] Encrypting ${file.name}...`);
        const encrypted = await LocalBeamCrypto.encryptFile(file, deviceId);
        
        // Create a File from the encrypted blob
        const encryptedFile = new File([encrypted.blob], encrypted.encryptedName, {
          type: 'application/x-localbeam-encrypted'
        });
        
        formData.append('file', encryptedFile);
        formData.append('encrypted', 'true');
        formData.append('original_name', file.name);
        console.log(`[E2EE] Encrypted: ${file.size} -> ${encrypted.encryptedSize} bytes`);
      } else {
        formData.append('file', file);
        formData.append('encrypted', 'false');
      }
      
      formData.append('device_id', desktopDeviceId);  // Sender ID
      formData.append('recipient_id', deviceId);       // Recipient ID
      
      const res = await fetch(`${API_BASE}/p2p/send`, {
        method: 'POST',
        body: formData
      });
      
      if (res.ok) {
        const data = await res.json();
        const status = data.encrypted ? '🔒 Encrypted' : '📄 Unencrypted';
        console.log(`[P2P] File ${file.name} sent (${status}):`, data);
        alert(`File "${file.name}" sent successfully! ${status}`);
      } else {
        const err = await res.json();
        alert(`Failed to send ${file.name}: ${err.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('Failed to send file:', err);
      alert(`Error sending ${file.name}: ${err.message}`);
    }
  }
  
  targetP2PDeviceId = null;
  e.target.value = '';
  await loadP2PData();
}

async function downloadP2PFile(fileId, fileName, senderId, isEncrypted) {
  try {
    // Check if file is encrypted and we can decrypt it
    const canDecrypt = isEncrypted && e2eeEnabled && typeof LocalBeamCrypto !== 'undefined' && LocalBeamCrypto && LocalBeamCrypto.hasKeyFor(senderId);
    
    if (isEncrypted && !canDecrypt) {
      // Try to fetch sender's key first
      if (e2eeEnabled) {
        console.log('[E2EE] Attempting to get sender key...');
        await fetchAndImportPeerKey(senderId);
      }
    }
    
    // Re-check after key fetch attempt
    const shouldDecrypt = isEncrypted && e2eeEnabled && typeof LocalBeamCrypto !== 'undefined' && LocalBeamCrypto && LocalBeamCrypto.hasKeyFor(senderId);
    
    if (shouldDecrypt && LocalBeamCrypto) {
      // Download and decrypt
      console.log(`[E2EE] Downloading and decrypting ${fileName}...`);
      
      const response = await fetch(`${API_BASE}/p2p/download/${fileId}`);
      if (!response.ok) throw new Error('Download failed');
      
      const encryptedData = await response.arrayBuffer();
      
      try {
        const decrypted = await LocalBeamCrypto.decryptFile(encryptedData, senderId);
        
        // Create download from decrypted data
        const url = URL.createObjectURL(decrypted.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = decrypted.metadata.name;
        link.click();
        URL.revokeObjectURL(url);
        
        console.log(`[E2EE] Decrypted: ${decrypted.metadata.name}`);
      } catch (decryptErr) {
        console.error('[E2EE] Decryption failed:', decryptErr);
        alert('Failed to decrypt file. You may not have the correct key.');
      }
    } else {
      // Normal unencrypted download — fetch as blob for self-signed HTTPS reliability
      showNotification(`Downloading ${fileName}...`);
      const response = await fetch(`${API_BASE}/p2p/download/${fileId}`);
      if (!response.ok) throw new Error('Download failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showNotification(`Downloaded ${fileName}`, 'success');
    }
  } catch (err) {
    console.error('Failed to download P2P file:', err);
    showNotification('Failed to download file', 'error');
  }
}

async function deleteP2PFile(fileId) {
  if (!confirm('Delete this shared file?')) return;
  
  try {
    await fetch(`${API_BASE}/p2p/delete/${fileId}`, { method: 'POST' });
    await loadP2PData();
  } catch (err) {
    console.error('Failed to delete P2P file:', err);
  }
}

async function playP2PFile(fileId, fileName, senderId, isEncrypted) {
  const ext = '.' + fileName.split('.').pop().toLowerCase();
  let fileUrl;
  
  if (isEncrypted && e2eeEnabled) {
    // Fetch and decrypt the file first
    if (typeof LocalBeamCrypto !== 'undefined' && LocalBeamCrypto) {
      if (!LocalBeamCrypto.hasKeyFor(senderId)) {
        await fetchAndImportPeerKey(senderId);
      }
      
      if (LocalBeamCrypto.hasKeyFor(senderId)) {
        try {
          console.log(`[E2EE] Decrypting media file: ${fileName}`);
          const response = await fetch(`${API_BASE}/p2p/download/${fileId}`);
          const encryptedData = await response.arrayBuffer();
          const decrypted = await LocalBeamCrypto.decryptFile(encryptedData, senderId);
          fileUrl = URL.createObjectURL(decrypted.blob);
        } catch (err) {
          console.error('[E2EE] Media decryption failed:', err);
          alert('Failed to decrypt media file');
          return;
        }
      } else {
        alert('Cannot play encrypted file: missing decryption key');
        return;
      }
    } else {
      alert('E2EE not available - cannot decrypt file');
      return;
    }
  } else {
    fileUrl = `${API_BASE}/p2p/download/${fileId}`;
  }
  
  if (['.mp4','.avi','.mov','.mkv','.wmv','.webm'].includes(ext)) {
    openVideoPlayer(fileUrl, fileName);
  } else if (['.mp3','.wav','.flac','.aac','.ogg','.m4a'].includes(ext)) {
    openAudioPlayer(fileUrl, fileName);
  }
}

async function viewP2PImage(fileId, fileName, senderId, isEncrypted) {
  let fileUrl;
  
  if (isEncrypted && e2eeEnabled) {
    if (typeof LocalBeamCrypto !== 'undefined' && LocalBeamCrypto) {
      if (!LocalBeamCrypto.hasKeyFor(senderId)) {
        await fetchAndImportPeerKey(senderId);
      }
      
      if (LocalBeamCrypto.hasKeyFor(senderId)) {
        try {
          console.log(`[E2EE] Decrypting image: ${fileName}`);
          const response = await fetch(`${API_BASE}/p2p/download/${fileId}`);
          const encryptedData = await response.arrayBuffer();
          const decrypted = await LocalBeamCrypto.decryptFile(encryptedData, senderId);
          fileUrl = URL.createObjectURL(decrypted.blob);
        } catch (err) {
          console.error('[E2EE] Image decryption failed:', err);
          alert('Failed to decrypt image');
          return;
        }
      } else {
        alert('Cannot view encrypted image: missing decryption key');
        return;
      }
    } else {
      alert('E2EE not available - cannot decrypt file');
      return;
    }
  } else {
    fileUrl = `${API_BASE}/p2p/download/${fileId}`;
  }
  
  openImageViewer(fileUrl, fileName);
}

async function openP2PDocument(fileId, fileName, senderId, isEncrypted) {
  if (isEncrypted && e2eeEnabled) {
    if (typeof LocalBeamCrypto !== 'undefined' && LocalBeamCrypto) {
      if (!LocalBeamCrypto.hasKeyFor(senderId)) {
        await fetchAndImportPeerKey(senderId);
      }
      
      if (LocalBeamCrypto.hasKeyFor(senderId)) {
        try {
          console.log(`[E2EE] Decrypting document: ${fileName}`);
          const response = await fetch(`${API_BASE}/p2p/download/${fileId}`);
          const encryptedData = await response.arrayBuffer();
          const decrypted = await LocalBeamCrypto.decryptFile(encryptedData, senderId);
          const fileUrl = URL.createObjectURL(decrypted.blob);
          window.open(fileUrl, '_blank');
        } catch (err) {
          console.error('[E2EE] Document decryption failed:', err);
          alert('Failed to decrypt document');
        }
      } else {
        alert('Cannot open encrypted document: missing decryption key');
      }
    } else {
      alert('E2EE not available - cannot decrypt file');
    }
  } else {
    const fileUrl = `${API_BASE}/p2p/download/${fileId}`;
    window.open(fileUrl, '_blank');
  }
}

function openImageViewer(imageUrl, fileName) {
  // Create or show image viewer modal
  let modal = document.getElementById('imageViewerModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'imageViewerModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="image-viewer-wrap">
        <button class="player-close" onclick="closeImageViewer()">
          <i class="fas fa-times"></i>
        </button>
        <div class="image-viewer-content">
          <img id="viewerImage" src="" alt="">
          <div class="image-viewer-info">
            <span id="viewerFileName"></span>
            <button class="btn btn-sm btn-success" onclick="downloadViewerImage()">
              <i class="fas fa-download"></i> Download
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  
  document.getElementById('viewerImage').src = imageUrl;
  document.getElementById('viewerFileName').textContent = fileName;
  modal.style.display = 'flex';
  modal.dataset.url = imageUrl;
  modal.dataset.name = fileName;
}

function closeImageViewer() {
  const modal = document.getElementById('imageViewerModal');
  if (modal) modal.style.display = 'none';
}

async function downloadViewerImage() {
  const modal = document.getElementById('imageViewerModal');
  if (modal) {
    try {
      const fileName = modal.dataset.name;
      showNotification(`Downloading ${fileName}...`);
      const response = await fetch(modal.dataset.url);
      if (!response.ok) throw new Error('Download failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showNotification(`Downloaded ${fileName}`, 'success');
    } catch (err) {
      console.error('Image download failed:', err);
      showNotification('Failed to download image', 'error');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// DEVICE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

async function loadDevices() {
  try {
    const response = await fetch(`${API_BASE}/p2p/devices`);
    const data = await response.json();
    devices = Array.isArray(data) ? data : (data.devices || []);
    renderDevicesTable();
  } catch (err) {
    console.error('Failed to load devices:', err);
  }
}

function renderDevicesTable() {
  const tbody = document.getElementById('devicesTableBody');

  if (devices.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5" class="text-center">No devices connected</td></tr>';
    return;
  }

  tbody.innerHTML = devices
    .map(d => {
      const name = d.name || 'Unknown Device';
      const userAgent = d.user_agent || d.userAgent || 'Unknown';
      const id = d.id || d.device_id || 'unknown';
      const lastSeen = d.last_seen || d.lastSeen || 0;
      // Devices in the list are considered online (pruned after 60s of inactivity)
      const isOnline = d.is_online !== undefined ? d.is_online : (d.isOnline !== undefined ? d.isOnline : true);
      
      return `
      <tr>
        <td>${name}</td>
        <td>${getDeviceType(userAgent)}</td>
        <td><span class="device-status"><span class="device-dot ${isOnline ? '' : 'offline'}"></span>${isOnline ? 'Online' : 'Offline'}</span></td>
        <td>${formatTime(lastSeen)}</td>
        <td>
          <button class="btn btn-sm" onclick="disconnectDevice('${id}', '${name}')">Disconnect</button>
        </td>
      </tr>
    `;
    })
    .join('');
}

async function disconnectDevice(deviceId, deviceName) {
  if (!confirm(`Disconnect ${deviceName}?`)) return;
  try {
    const response = await fetch(`${API_BASE}/p2p/disconnect/${deviceId}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'}
    });
    const data = await response.json();
    if (data.status === 'disconnected') {
      showNotification(`${deviceName} disconnected`);
      loadDevices();
    } else {
      showNotification('Failed to disconnect device');
    }
  } catch (err) {
    console.error('Failed to disconnect device:', err);
    showNotification('Error disconnecting device');
  }
}

// ═══════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════

async function loadTransferHistory() {
  try {
    // For now, use localStorage data from mobile browser
    const raw = localStorage.getItem('p2p_history') || '[]';
    transferHistory = JSON.parse(raw).slice(0, 20);
    renderTransferHistory();
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

function renderTransferHistory() {
  const historyList = document.getElementById('historyList');

  if (transferHistory.length === 0) {
    historyList.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-history"></i>
        <p>No transfer history</p>
      </div>
    `;
    return;
  }

  historyList.innerHTML = transferHistory
    .map(h => `
      <div class="history-item">
        <div class="history-icon">
          <i class="fas fa-arrow-${h.type === 'sent' ? 'up' : 'down'}"></i>
        </div>
        <div class="history-details">
          <div class="history-name">${h.name}</div>
          <div class="history-meta">${h.type} · ${formatBytes(h.size)} · ${formatTime(h.time)}</div>
        </div>
      </div>
    `)
    .join('');
}

function updateStats() {
  // Storage
  let totalSize = 0;
  files.forEach(f => totalSize += f.size);
  document.getElementById('storageUsage').textContent = formatBytes(totalSize);
  document.getElementById('storageDetail').textContent = `${formatBytes(totalSize)} total`;
  document.getElementById('storageBar').style.width = '45%'; // Demo

  // File count
  document.getElementById('fileCount').textContent = files.length;

  // Active devices
  const deviceList = Array.isArray(devices) ? devices : (devices?.devices || []);
  const activeDevices = deviceList.filter(d => d.isOnline).length;
  document.getElementById('activeDeviceCount').textContent = activeDevices;

  // Transfers
  document.getElementById('transferCount').textContent = transferHistory.length;
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════

function loadSettings() {
  const serverUrl = `${API_BASE.replace('/api', '')}`;
  document.getElementById('serverUrl').value = serverUrl;
  document.getElementById('sharedDir').value = 'uploads/';

  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.getElementById('themeSelect').value = savedTheme;
}

function applyTheme(e) {
  const theme = e ? (e.target ? e.target.value : e) : 'dark';
  localStorage.setItem('theme', theme);
  _setTheme(theme);
}

function _setTheme(theme) {
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  // Update toggle icon
  const icon = document.querySelector('#themeToggle i');
  const resolved = document.documentElement.getAttribute('data-theme');
  if (icon) icon.className = resolved === 'light' ? 'fas fa-sun' : 'fas fa-moon';
}

function toggleTheme() {
  const current = localStorage.getItem('theme') || 'dark';
  const next = current === 'dark' ? 'light' : (current === 'light' ? 'auto' : 'dark');
  localStorage.setItem('theme', next);
  const sel = document.getElementById('themeSelect');
  if (sel) sel.value = next;
  _setTheme(next);
  showNotification('Theme: ' + next.charAt(0).toUpperCase() + next.slice(1), 'info');
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function getFileIcon(filename) {
  const ext = '.' + filename.split('.').pop().toLowerCase();
  const icons = {
    '.pdf': '📄',
    '.doc': '📝',
    '.docx': '📝',
    '.xls': '📊',
    '.xlsx': '📊',
    '.ppt': '🎯',
    '.pptx': '🎯',
    '.jpg': '🖼️',
    '.jpeg': '🖼️',
    '.png': '🖼️',
    '.gif': '🖼️',
    '.mp4': '🎬',
    '.avi': '🎬',
    '.mov': '🎬',
    '.mp3': '🎵',
    '.wav': '🎵',
    '.zip': '📦',
    '.rar': '📦',
    '.7z': '📦',
    '.apk': '📱',
    '.exe': '⚙️',
  };
  return icons[ext] || '📄';
}

function getDeviceType(userAgent) {
  if (!userAgent) return 'Unknown Device';
  if (userAgent.includes('iPhone')) return 'iPhone';
  if (userAgent.includes('Android')) return 'Android';
  if (userAgent.includes('Windows')) return 'Windows';
  if (userAgent.includes('Mac')) return 'macOS';
  return 'Unknown';
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function formatTime(ms) {
  if (!ms) return 'Never';
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function truncate(text, length) {
  return text.length > length ? text.substring(0, length) + '...' : text;
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOM VIDEO PLAYER
// ═══════════════════════════════════════════════════════════════════════════

let currentVideoFile = null;
let currentAudioFile = null;

function openVideoPlayer(fileUrl, fileName) {
  currentVideoFile = {url: fileUrl, name: fileName};
  const video = document.getElementById('customVideoElement');
  const modal = document.getElementById('videoPlayerModal');
  
  // Reset video
  video.src = fileUrl;
  modal.style.display = 'flex';
  
  // Reset play button
  const playBtn = document.querySelector('.video-player-wrap .btn-control');
  if (playBtn) playBtn.innerHTML = '<i class="fas fa-pause"></i>';
  
  // Remove previous event listeners
  video.onloadedmetadata = () => {
    document.getElementById('duration').textContent = formatMediaTime(video.duration);
  };
  
  video.ontimeupdate = () => {
    const progress = (video.currentTime / video.duration) * 100 || 0;
    document.getElementById('videoProgress').value = progress;
    document.getElementById('currentTime').textContent = formatMediaTime(video.currentTime);
  };
  
  video.onended = () => {
    const playBtn = document.querySelector('.video-player-wrap .btn-control');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
  };
  
  document.getElementById('videoProgress').oninput = (e) => {
    video.currentTime = (e.target.value / 100) * video.duration;
  };
  
  document.getElementById('videoVolume').oninput = (e) => {
    video.volume = e.target.value / 100;
  };
  
  video.play().catch(e => console.log('Video autoplay blocked'));
}

function closeVideoPlayer() {
  const video = document.getElementById('customVideoElement');
  if (video) video.pause();
  document.getElementById('videoPlayerModal').style.display = 'none';
}

function toggleVideoPlay() {
  const video = document.getElementById('customVideoElement');
  const playBtn = document.querySelector('.video-player-wrap .btn-control');
  if (video.paused) {
    video.play();
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-pause"></i>';
  } else {
    video.pause();
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
  }
}

function rewindVideo() {
  const video = document.getElementById('customVideoElement');
  video.currentTime = Math.max(0, video.currentTime - 10);
}

function forwardVideo() {
  const video = document.getElementById('customVideoElement');
  video.currentTime = Math.min(video.duration, video.currentTime + 10);
}

function toggleVideoMute() {
  const video = document.getElementById('customVideoElement');
  const btn = document.querySelector('.volume-container .btn-control');
  if (video.muted) {
    video.muted = false;
    if (btn) btn.innerHTML = '<i class="fas fa-volume-up"></i>';
  } else {
    video.muted = true;
    if (btn) btn.innerHTML = '<i class="fas fa-volume-mute"></i>';
  }
}

function changeVideoSpeed() {
  const speed = parseFloat(document.getElementById('videoSpeed').value);
  document.getElementById('customVideoElement').playbackRate = speed;
}

function toggleVideoFullscreen() {
  const elem = document.querySelector('.custom-video-player');
  if (document.fullscreenElement) {
    document.exitFullscreen();
    document.getElementById('videoFullscreenBtn').innerHTML = '<i class="fas fa-expand"></i>';
  } else {
    elem.requestFullscreen();
    document.getElementById('videoFullscreenBtn').innerHTML = '<i class="fas fa-compress"></i>';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOM AUDIO PLAYER
// ═══════════════════════════════════════════════════════════════════════════

function openAudioPlayer(fileUrl, fileName) {
  currentAudioFile = {url: fileUrl, name: fileName};
  const audio = document.getElementById('customAudioElement');
  const modal = document.getElementById('audioPlayerModal');
  
  audio.src = fileUrl;
  modal.style.display = 'flex';
  document.getElementById('audioName').textContent = fileName;
  
  // Reset play button
  const playBtn = document.querySelector('.btn-play-large');
  if (playBtn) playBtn.innerHTML = '<i class="fas fa-pause"></i>';
  
  audio.onloadedmetadata = () => {
    document.getElementById('audioDuration').textContent = formatMediaTime(audio.duration);
  };
  
  audio.ontimeupdate = () => {
    const progress = (audio.currentTime / audio.duration) * 100 || 0;
    document.getElementById('audioProgress').value = progress;
    document.getElementById('audioCurrentTime').textContent = formatMediaTime(audio.currentTime);
  };
  
  audio.onplay = () => {
    startAudioVisualizer();
    const playBtn = document.querySelector('.btn-play-large');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-pause"></i>';
  };
  
  audio.onpause = () => {
    stopAudioVisualizer();
    const playBtn = document.querySelector('.btn-play-large');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
  };
  
  audio.onended = () => {
    stopAudioVisualizer();
    const playBtn = document.querySelector('.btn-play-large');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
  };
  
  document.getElementById('audioProgress').oninput = (e) => {
    audio.currentTime = (e.target.value / 100) * audio.duration;
  };
  
  document.getElementById('audioVolume').oninput = (e) => {
    audio.volume = e.target.value / 100;
  };
  
  audio.play().catch(e => console.log('Audio autoplay blocked'));
}

function closeAudioPlayer() {
  const audio = document.getElementById('customAudioElement');
  if (audio) audio.pause();
  stopAudioVisualizer();
  document.getElementById('audioPlayerModal').style.display = 'none';
}

function toggleAudioPlay() {
  const audio = document.getElementById('customAudioElement');
  const btn = document.querySelector('.btn-play-large');
  if (audio.paused) {
    audio.play();
    if (btn) btn.innerHTML = '<i class="fas fa-pause"></i>';
  } else {
    audio.pause();
    if (btn) btn.innerHTML = '<i class="fas fa-play"></i>';
  }
}

function rewindAudio() {
  const audio = document.getElementById('customAudioElement');
  audio.currentTime = Math.max(0, audio.currentTime - 5);
}

function forwardAudio() {
  const audio = document.getElementById('customAudioElement');
  audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
}

function toggleAudioMute() {
  const audio = document.getElementById('customAudioElement');
  const btn = document.querySelector('.audio-controls .volume-container .btn-control');
  if (audio.muted) {
    audio.muted = false;
    if (btn) btn.innerHTML = '<i class="fas fa-volume-up"></i>';
  } else {
    audio.muted = true;
    if (btn) btn.innerHTML = '<i class="fas fa-volume-mute"></i>';
  }
}

function changeAudioSpeed() {
  const speed = parseFloat(document.getElementById('audioSpeed').value);
  document.getElementById('customAudioElement').playbackRate = speed;
}

function startAudioVisualizer() {
  const bars = document.querySelectorAll('.vis-bar');
  bars.forEach(bar => bar.style.animationPlayState = 'running');
}

function stopAudioVisualizer() {
  const bars = document.querySelectorAll('.vis-bar');
  bars.forEach(bar => bar.style.animationPlayState = 'paused');
}

function formatMediaTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
// ═══════════════════════════════════════════════════════════════
// DESKTOP CHAT MESSENGER
// ═══════════════════════════════════════════════════════════════

let _deskChatConversations = {};
let _deskChatCurrentConversation = null;
let _deskChatMessages = [];
let _deskChatLastMessageId = null;  // Track last loaded message to only append new ones
let _deskChatPollInterval = null;
let _deskTypingPollTimer = null;
let _deskLastTypingEmit = 0;
let _deskMediaRecorder = null;
let _deskEditMsg = null;   // { id, text } — message being edited
let _deskForwardMsg = null; // message object being forwarded
let _deskAudioChunks = [];
let _deskRecordingStartTime = null;
let _deskRecordingTimer = null;
let _deskRecordingMimeType = 'audio/webm';

// Emit typing signal (throttled to once per 2.5s)
function _emitDesktopTyping() {
  if (!_deskChatCurrentConversation || !desktopDeviceId) return;
  const now = Date.now();
  if (now - _deskLastTypingEmit < 2500) return;
  _deskLastTypingEmit = now;
  fetch(`${API_BASE}/p2p/typing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender_id: desktopDeviceId, recipient_id: _deskChatCurrentConversation })
  }).catch(() => {});
}

// Poll for typing status of the other user
async function _pollDesktopTyping() {
  if (!_deskChatCurrentConversation || !desktopDeviceId) return;
  try {
    const r = await fetch(`${API_BASE}/p2p/typing/${desktopDeviceId}`);
    const data = await r.json();
    const indicator = document.getElementById('desktopTypingIndicator');
    const statusEl = document.getElementById('desktopChatStatus');
    if (data.typing && data.typing.length > 0) {
      if (indicator) indicator.classList.add('active');
      if (statusEl) statusEl.style.display = 'none';
    } else {
      if (indicator) indicator.classList.remove('active');
      if (statusEl) statusEl.style.display = '';
    }
  } catch (e) {}
}

async function loadDesktopChatList() {
  try {
    if (!desktopDeviceId) return;
    
    // First, load existing conversations from messages
    const r = await fetch(`${API_BASE}/p2p/messages?device_id=${desktopDeviceId}`);
    const data = await r.json();
    
    // Build conversation map from messages
    const convMap = {};
    for (const msg of data.messages || []) {
      const otherDevice = msg.sender_id === desktopDeviceId ? msg.recipient_id : msg.sender_id;
      const otherName = msg.sender_id === desktopDeviceId ? msg.sender_name : msg.sender_name;
      if (!convMap[otherDevice]) {
        convMap[otherDevice] = {
          device_id: otherDevice,
          name: otherName,
          last_message: msg.text,
          timestamp: msg.timestamp,
          unreadCount: (!msg.read && msg.recipient_id === desktopDeviceId) ? 1 : 0
        };
      } else {
        if (msg.timestamp > convMap[otherDevice].timestamp) {
          convMap[otherDevice].last_message = msg.text;
          convMap[otherDevice].timestamp = msg.timestamp;
        }
        if (!msg.read && msg.recipient_id === desktopDeviceId) {
          convMap[otherDevice].unreadCount = (convMap[otherDevice].unreadCount || 0) + 1;
        }
      }
    }
    
    // Now add connected devices that aren't in conversations yet
    try {
      const devicesResp = await fetch(`${API_BASE}/p2p/devices`);
      const devicesData = await devicesResp.json();
      const devices = devicesData.devices || [];
      
      for (const device of devices) {
        const deviceId = device.id || device.device_id;
        if (deviceId !== desktopDeviceId && !convMap[deviceId]) {
          // Add as new conversation starter
          convMap[deviceId] = {
            device_id: deviceId,
            name: device.name || 'Unknown Device',
            last_message: 'Start a conversation',
            timestamp: 0,  // Show at bottom
            unreadCount: 0,
            isNew: true
          };
        }
      }
    } catch (e) {
      console.error('Failed to load devices:', e);
    }
    
    _deskChatConversations = convMap;
    renderDesktopChatList();
    
    // Update badge — total unread messages across all conversations
    const totalUnread = Object.values(convMap).reduce((sum, c) => sum + (c.unreadCount || 0), 0);
    const badge = document.getElementById('chatNavBadge');
    if (badge) {
      badge.textContent = totalUnread;
      badge.style.display = totalUnread > 0 ? 'flex' : 'none';
    }
  } catch (e) {
    console.error('Failed to load desktop chat list:', e);
  }
}

function renderDesktopChatList() {
  const el = document.getElementById('desktopChatConvList');
  const convs = Object.values(_deskChatConversations).sort((a, b) => {
    // Existing conversations (with messages) first
    if (a.isNew && !b.isNew) return 1;
    if (!a.isNew && b.isNew) return -1;
    // Then sort by timestamp
    return b.timestamp - a.timestamp;
  });
  
  if (convs.length === 0) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>No conversations yet</p><p style="font-size:0.8rem;margin-top:8px">Connect a device to start</p></div>';
    return;
  }
  
  el.innerHTML = convs.map(c => {
    const avatar = (c.name || 'U').charAt(0).toUpperCase();
    const preview = c.isNew ? '<i style="font-size:0.75rem">Start a conversation</i>' : c.last_message.substring(0, 30);
    const activeClass = _deskChatCurrentConversation === c.device_id ? 'active' : '';
    const newBadge = c.isNew ? '<span class="chat-new-badge">NEW</span>' : '';
    const unreadBadge = (c.unreadCount > 0) ? `<span class="chat-conv-unread-count">${c.unreadCount}</span>` : '';
    
    return `
      <div class="chat-conv-item ${activeClass}" onclick="openDesktopChatConversation('${c.device_id}', '${escapeHtml(c.name)}')">
        <div class="chat-conv-item-avatar">${avatar}</div>
        <div class="chat-conv-details">
          <div class="chat-conv-name">${escapeHtml(c.name)} ${vBadge(c.device_id)}${newBadge}</div>
          <div class="chat-conv-preview">${preview}</div>
        </div>
        ${unreadBadge}
      </div>
    `;
  }).join('');
}

async function openDesktopChatConversation(deviceId, deviceName) {
  _deskChatCurrentConversation = deviceId;
  _deskChatLastMessageId = null;  // Reset message tracking for new conversation
  document.getElementById('chatEmptyState').style.display = 'none';
  document.getElementById('chatWindow').style.display = 'flex';
  document.getElementById('desktopChatUserName').textContent = deviceName;
  
  // On small screens, switch to chat view (WhatsApp mobile style)
  const container = document.querySelector('.chat-container-desktop');
  if (container && window.innerWidth <= 768) {
    container.classList.add('chat-active');
  }
  
  renderDesktopChatList();
  await loadDesktopChatMessages(deviceId);
  
  // Start polling (increased to 15 seconds for stable media playback)
  if (_deskChatPollInterval) clearInterval(_deskChatPollInterval);
  _deskChatPollInterval = setInterval(() => loadDesktopChatMessages(deviceId), 15000);
  
  // Start typing indicator poll
  if (_deskTypingPollTimer) clearInterval(_deskTypingPollTimer);
  _deskTypingPollTimer = setInterval(_pollDesktopTyping, 2000);
}

// Back button: go from chat view back to conversations list
function closeChatGoBack() {
  const container = document.querySelector('.chat-container-desktop');
  if (container) {
    container.classList.remove('chat-active');
  }
  // Clear current conversation selection
  _deskChatCurrentConversation = null;
  _deskChatLastMessageId = null;
  _deskChatMessages = [];
  cancelDeskReply();
  cancelDeskEdit();
  cancelDeskForward();
  if (_deskChatPollInterval) {
    clearInterval(_deskChatPollInterval);
    _deskChatPollInterval = null;
  }
  if (_deskTypingPollTimer) {
    clearInterval(_deskTypingPollTimer);
    _deskTypingPollTimer = null;
  }
  const dti = document.getElementById('desktopTypingIndicator');
  if (dti) dti.classList.remove('active');
  document.getElementById('chatWindow').style.display = 'none';
  document.getElementById('chatEmptyState').style.display = 'flex';
  renderDesktopChatList();
}

async function loadDesktopChatMessages(deviceId) {
  try {
    const r = await fetch(`${API_BASE}/p2p/messages?device_id=${desktopDeviceId}&with=${deviceId}`);
    const data = await r.json();
    const allMessages = data.messages || [];
    
    // On first load or if we have messages already
    if (_deskChatLastMessageId === null) {
      // First load - render all messages
      _deskChatMessages = allMessages;
      if (allMessages.length > 0) {
        _deskChatLastMessageId = allMessages[allMessages.length - 1].id;
      }
      renderDesktopChatMessages();
    } else if (allMessages.length > _deskChatMessages.length) {
      // New messages arrived - only append them
      const oldCount = _deskChatMessages.length;
      _deskChatMessages = allMessages;
      const newMessages = allMessages.slice(oldCount);
      appendDesktopChatMessages(newMessages);
      _deskChatLastMessageId = allMessages[allMessages.length - 1].id;

      // AI Delegation: auto-reply to new incoming messages
      for (const nm of newMessages) {
        if (nm.sender_id !== desktopDeviceId && nm.recipient_id === desktopDeviceId && !nm.is_bot && nm.text) {
          aiTryDelegateReply(nm.sender_id, nm.sender_name, nm.text).catch(() => {});
        }
      }
    } else if (allMessages.length === _deskChatMessages.length && allMessages.length > 0) {
      // Same count — check for edits, reactions, or other changes
      let hasChanges = false;
      for (let i = 0; i < allMessages.length; i++) {
        const a = allMessages[i], b = _deskChatMessages[i];
        if (a.text !== b.text || a.edited !== b.edited ||
            JSON.stringify(a.reactions || {}) !== JSON.stringify(b.reactions || {})) {
          hasChanges = true; break;
        }
      }
      if (hasChanges) {
        _deskChatMessages = allMessages;
        renderDesktopChatMessages();
      }
    }
    
    // Mark as read
    for (const msg of allMessages) {
      if (!msg.read && msg.recipient_id === desktopDeviceId) {
        fetch(`${API_BASE}/p2p/messages/${msg.id}/read`, {method: 'POST'}).catch(e => console.error(e));
      }
    }
  } catch (e) {
    console.error('Failed to load messages:', e);
  }
}

// Convert base64 audio to blob URL for playback
function deskB64toBlobUrl(b64Data, contentType) {
  try {
    const byteChars = atob(b64Data);
    const byteArrays = [];
    for (let i = 0; i < byteChars.length; i += 512) {
      const slice = byteChars.slice(i, i + 512);
      const bytes = new Uint8Array(slice.length);
      for (let j = 0; j < slice.length; j++) bytes[j] = slice.charCodeAt(j);
      byteArrays.push(bytes);
    }
    return URL.createObjectURL(new Blob(byteArrays, contentType ? { type: contentType } : undefined));
  } catch (e) {
    console.error('deskB64toBlobUrl error:', e);
    return `data:${contentType};base64,${b64Data}`;
  }
}

// Desktop voice note store
const _deskVnStore = {};

function buildDesktopVoiceNoteHTML(msgId) {
  // Generate random bar heights for visual effect
  const barCount = 28;
  let barsHtml = '';
  for (let i = 0; i < barCount; i++) {
    const h = Math.floor(Math.random() * 18) + 4;
    barsHtml += `<div class="vn-viz-bar" data-h="${h}" style="height:${h}px;"></div>`;
  }
  return `<div class="voice-note-player" style="display:flex;align-items:center;gap:10px;margin-top:6px;padding:6px 10px;background:rgba(0,0,0,0.08);border-radius:20px;min-width:0;max-width:100%;">` +
    `<button onclick="toggleDesktopVoiceNote('${msgId}')" style="width:30px;height:30px;border-radius:50%;border:none;background:#667EEA;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fas fa-play" id="dvn-icon-${msgId}"></i></button>` +
    `<div class="vn-visualizer" id="dvn-viz-${msgId}" onclick="seekDesktopVoiceNote(event,'${msgId}')">${barsHtml}</div>` +
    `<span id="dvn-time-${msgId}" style="font-size:0.7rem;color:#94A3B8;flex-shrink:0;min-width:35px;text-align:right;">0:00</span>` +
    `</div>`;
}

function toggleDesktopVoiceNote(msgId) {
  const store = _deskVnStore[msgId];
  if (!store) { console.error('No voice data for', msgId); return; }
  
  const icon = document.getElementById('dvn-icon-' + msgId);
  
  if (!store.audio) {
    console.log('Creating desktop audio for', msgId, 'type:', store.type);
    const audioUrl = store.url || store.blobUrl;
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = audioUrl;
    store.audio = audio;
    
    audio.addEventListener('timeupdate', () => {
      const vizEl = document.getElementById('dvn-viz-' + msgId);
      const timeEl = document.getElementById('dvn-time-' + msgId);
      if (vizEl && audio.duration) {
        const bars = vizEl.querySelectorAll('.vn-viz-bar');
        const pct = audio.currentTime / audio.duration;
        const activeCount = Math.floor(pct * bars.length);
        bars.forEach((bar, i) => {
          bar.classList.toggle('active', i < activeCount);
        });
      }
      if (timeEl) {
        const cur = deskFormatAudioTime(audio.currentTime);
        const dur = audio.duration ? deskFormatAudioTime(audio.duration) : '--:--';
        timeEl.textContent = cur + ' / ' + dur;
      }
    });
    
    audio.addEventListener('ended', () => {
      if (icon) icon.className = 'fas fa-play';
      const vizEl = document.getElementById('dvn-viz-' + msgId);
      if (vizEl) {
        vizEl.querySelectorAll('.vn-viz-bar').forEach(b => b.classList.remove('active'));
      }
      const timeEl = document.getElementById('dvn-time-' + msgId);
      if (timeEl) timeEl.textContent = deskFormatAudioTime(audio.duration || 0);
    });
    
    audio.addEventListener('error', () => {
      console.error('Desktop audio error for', msgId, audio.error);
      const timeEl = document.getElementById('dvn-time-' + msgId);
      if (!store.retried) {
        store.retried = true;
        console.log('Desktop playback failed, requesting server-side conversion for', msgId);
        if (timeEl) timeEl.textContent = 'Converting...';
        fetch('/api/p2p/audio/convert/' + msgId)
            .then(resp => {
                if (!resp.ok) throw new Error('Convert failed: ' + resp.status);
                return resp.blob();
            })
            .then(blob => {
                const url = URL.createObjectURL(blob);
                audio.src = url;
                store.blobUrl = url;
                audio.play().then(() => {
                    const icon = document.getElementById('dvn-icon-' + msgId);
                    if (icon) icon.className = 'fas fa-pause';
                }).catch(() => { if (timeEl) timeEl.textContent = 'Cannot play'; });
            })
            .catch(() => {
                if (timeEl) timeEl.textContent = 'Cannot play';
            });
        return;
      }
      if (timeEl) timeEl.textContent = 'Cannot play';
    });
  }
  
  const audio = store.audio;
  if (audio.paused) {
    Object.keys(_deskVnStore).forEach(id => {
      if (id !== msgId && _deskVnStore[id].audio && !_deskVnStore[id].audio.paused) {
        _deskVnStore[id].audio.pause();
        const otherIcon = document.getElementById('dvn-icon-' + id);
        if (otherIcon) otherIcon.className = 'fas fa-play';
      }
    });
    audio.play().then(() => {
      if (icon) icon.className = 'fas fa-pause';
    }).catch(err => {
      console.error('Desktop play failed:', err);
      const timeEl = document.getElementById('dvn-time-' + msgId);
      if (timeEl) timeEl.textContent = 'Play failed';
    });
  } else {
    audio.pause();
    if (icon) icon.className = 'fas fa-play';
  }
}

function seekDesktopVoiceNote(event, msgId) {
  const store = _deskVnStore[msgId];
  if (!store || !store.audio || !store.audio.duration) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const pct = x / rect.width;
  store.audio.currentTime = Math.max(0, Math.min(pct, 1)) * store.audio.duration;
}

function deskFormatAudioTime(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m + ':' + s.toString().padStart(2, '0');
}

/**
 * Groups consecutive image-only messages from the same sender.
 */
function _groupConsecutiveDesktopImages(messages) {
  const result = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const mediaType = (msg.media_type || '');
    if (msg.has_media && msg.media_url && mediaType.startsWith('image/')) {
      const group = [{ media_type: mediaType, media_url: msg.media_url }];
      const senderId = msg.sender_id;
      let lastTimestamp = msg.timestamp;
      let allRead = !!msg.read;
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j];
        const nextType = (next.media_type || '');
        if (next.sender_id === senderId && next.has_media && next.media_url && nextType.startsWith('image/')) {
          group.push({ media_type: nextType, media_url: next.media_url });
          lastTimestamp = next.timestamp;
          allRead = allRead && !!next.read;
          j++;
        } else {
          break;
        }
      }
      if (group.length > 1) {
        result.push({ type: 'image-group', images: group, sender_id: senderId, timestamp: lastTimestamp, read: allRead });
      } else {
        result.push({ type: 'single', msg: msg });
      }
      i = j;
    } else {
      result.push({ type: 'single', msg: msg });
      i++;
    }
  }
  return result;
}

function renderDesktopChatMessages() {
  const el = document.getElementById('desktopChatMessages');
  if (_deskChatMessages.length === 0) {
    el.innerHTML = '<div class="empty-state" style="height:100%"><i class="fas fa-comment"></i><p>No messages</p></div>';
    return;
  }
  
  const grouped = _groupConsecutiveDesktopImages(_deskChatMessages);
  
  el.innerHTML = grouped.map(entry => {
    if (entry.type === 'image-group') {
      const isOwn = entry.sender_id === desktopDeviceId;
      const ownClass = isOwn ? 'own' : 'other';
      const time = new Date(entry.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
      const count = entry.images.length;
      const maxShow = 6;
      const visible = entry.images.slice(0, maxShow);
      const remaining = count - maxShow;
      const colsClass = visible.length === 1 ? 'cols-1' : visible.length === 2 ? 'cols-2' : 'cols-3';
      const galleryData = entry.images.map(img => img.media_url);
      const galleryAttr = encodeURIComponent(JSON.stringify(galleryData));
      const imgs = visible.map((img, idx) => {
        const isLast = (idx === visible.length - 1) && remaining > 0;
        if (isLast) {
          return `<div class="img-overlay-wrap" onclick="openDesktopPhotoGallery(this.closest('.img-group'), ${idx})"><img src="${img.media_url}" loading="lazy"><div class="img-overlay-count">+${remaining}</div></div>`;
        }
        return `<img src="${img.media_url}" loading="lazy" onclick="openDesktopPhotoGallery(this.closest('.img-group'), ${idx})">`;
      }).join('');
      const ticks = isOwn ? `<span class="msg-ticks${entry.read ? ' read' : ''}"><i class="fas fa-check-double"></i></span>` : '';
      return `
        <div class="chat-message-desktop ${ownClass}">
          <div class="chat-message-bubble-desktop img-bubble">
            <div class="img-group ${colsClass}" data-gallery="${galleryAttr}">${imgs}</div>
          </div>
          <span class="desk-msg-time">${time}${ticks}</span>
        </div>
      `;
    }
    
    const msg = entry.msg;
    const isOwn = msg.sender_id === desktopDeviceId;
    const time = new Date(msg.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    const ownClass = isOwn ? 'own' : 'other';
    const replyHtml = buildDeskReplyBlock(msg, isOwn);
    
    let mediaContent = '';
    let hideText = false;
    if (msg.has_media && msg.media_url) {
      const mediaType = msg.media_type || '';
      if (mediaType.startsWith('image/')) {
        hideText = true;
        const singleGallery = encodeURIComponent(JSON.stringify([msg.media_url]));
        mediaContent = `<div class="img-group cols-1" data-gallery="${singleGallery}"><img src="${msg.media_url}" loading="lazy" onclick="openDesktopPhotoGallery(this.closest('.img-group'), 0)"></div>`;
      } else if (mediaType.startsWith('video/')) {
        mediaContent = `<video style="max-width: 280px; max-height: 280px; border-radius: 8px; margin-top: 4px; background: #000; display: block;" controls playsinline><source src="${msg.media_url}" type="${mediaType}">Your browser doesn't support HTML5 video.</video>`;
      } else if (mediaType.startsWith('audio/')) {
        const msgId = msg.id || Math.random().toString(36).substr(2, 9);
        _deskVnStore[msgId] = { url: msg.media_url, type: mediaType };
        mediaContent = buildDesktopVoiceNoteHTML(msgId);
      } else {
        const fileName = msg.file_name || 'file';
        mediaContent = `<a href="${msg.media_url}" download="${fileName}" style="display: inline-block; color: #667EEA; text-decoration: underline; margin-top: 4px; font-size: 0.9rem;">📥 Download ${fileName}</a>`;
      }
    }
    
    const textHtml = hideText ? '' : escapeHtml(msg.text);
    const bubbleClass = hideText ? 'chat-message-bubble-desktop img-bubble' : 'chat-message-bubble-desktop';
    const ticks = isOwn ? `<span class="msg-ticks${msg.read ? ' read' : ''}"><i class="fas fa-check-double"></i></span>` : '';
    const fwdHtml = msg.forwarded_from ? '<div class="desk-msg-forwarded"><i class="fas fa-share"></i> Forwarded</div>' : '';
    let editedTag = '';
    if (msg.edited) {
      const editTime = msg.edited_at ? new Date(msg.edited_at * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
      editedTag = `<span class="desk-msg-edited-inline"><i class="fas fa-pencil-alt"></i> edited${editTime ? ' ' + editTime : ''}</span>`;
    }
    const actionBtn = msg.id ? `<button class="msg-action-btn" onclick="_showMsgActions(event, '${msg.id}')"><i class="fas fa-chevron-down"></i></button>` : '';
    const reactionsHtml = _buildReactionsHtml(msg);
    
    return `
      <div class="chat-message-desktop ${ownClass}" data-msg-id="${msg.id || ''}" data-sender-id="${msg.sender_id || ''}">
        <div class="msg-bubble-wrap">
          <div class="${bubbleClass}">${actionBtn}${fwdHtml}${replyHtml}${textHtml}${mediaContent}${editedTag}</div>
          ${reactionsHtml}
        </div>
        <span class="desk-msg-time">${time}${ticks}</span>
      </div>
    `;
  }).join('');
  
  setTimeout(() => {
    el.scrollTop = el.scrollHeight;
  }, 0);
  initDeskReplyListeners();
  initDeskContextMenu();
}

function appendDesktopChatMessages(newMessages) {
  const el = document.getElementById('desktopChatMessages');
  if (!el) return;
  
  const grouped = _groupConsecutiveDesktopImages(newMessages);
  
  const html = grouped.map(entry => {
    if (entry.type === 'image-group') {
      const isOwn = entry.sender_id === desktopDeviceId;
      const ownClass = isOwn ? 'own' : 'other';
      const time = new Date(entry.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
      const count = entry.images.length;
      const maxShow = 6;
      const visible = entry.images.slice(0, maxShow);
      const remaining = count - maxShow;
      const colsClass = visible.length === 1 ? 'cols-1' : visible.length === 2 ? 'cols-2' : 'cols-3';
      const galleryData = entry.images.map(img => img.media_url);
      const galleryAttr = encodeURIComponent(JSON.stringify(galleryData));
      const imgs = visible.map((img, idx) => {
        const isLast = (idx === visible.length - 1) && remaining > 0;
        if (isLast) {
          return `<div class="img-overlay-wrap" onclick="openDesktopPhotoGallery(this.closest('.img-group'), ${idx})"><img src="${img.media_url}" loading="lazy"><div class="img-overlay-count">+${remaining}</div></div>`;
        }
        return `<img src="${img.media_url}" loading="lazy" onclick="openDesktopPhotoGallery(this.closest('.img-group'), ${idx})">`;
      }).join('');
      const ticks = isOwn ? `<span class="msg-ticks${entry.read ? ' read' : ''}"><i class="fas fa-check-double"></i></span>` : '';
      return `
        <div class="chat-message-desktop ${ownClass}">
          <div class="chat-message-bubble-desktop img-bubble">
            <div class="img-group ${colsClass}" data-gallery="${galleryAttr}">${imgs}</div>
          </div>
          <span class="desk-msg-time">${time}${ticks}</span>
        </div>
      `;
    }
    
    const msg = entry.msg;
    const isOwn = msg.sender_id === desktopDeviceId;
    const time = new Date(msg.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    const ownClass = isOwn ? 'own' : 'other';
    const replyHtml = buildDeskReplyBlock(msg, isOwn);
    
    let mediaContent = '';
    let hideText = false;
    if (msg.has_media && msg.media_url) {
      const mediaType = msg.media_type || '';
      if (mediaType.startsWith('image/')) {
        hideText = true;
        const singleGallery = encodeURIComponent(JSON.stringify([msg.media_url]));
        mediaContent = `<div class="img-group cols-1" data-gallery="${singleGallery}"><img src="${msg.media_url}" loading="lazy" onclick="openDesktopPhotoGallery(this.closest('.img-group'), 0)"></div>`;
      } else if (mediaType.startsWith('video/')) {
        mediaContent = `<video style="max-width: 280px; max-height: 280px; border-radius: 8px; margin-top: 4px; background: #000; display: block;" controls playsinline><source src="${msg.media_url}" type="${mediaType}">Your browser doesn't support HTML5 video.</video>`;
      } else if (mediaType.startsWith('audio/')) {
        const msgId = msg.id || Math.random().toString(36).substr(2, 9);
        _deskVnStore[msgId] = { url: msg.media_url, type: mediaType };
        mediaContent = buildDesktopVoiceNoteHTML(msgId);
      } else {
        const fileName = msg.file_name || 'file';
        mediaContent = `<a href="${msg.media_url}" download="${fileName}" style="display: inline-block; color: #667EEA; text-decoration: underline; margin-top: 4px; font-size: 0.9rem;">📥 Download ${fileName}</a>`;
      }
    }
    
    const textHtml = hideText ? '' : escapeHtml(msg.text);
    const bubbleClass = hideText ? 'chat-message-bubble-desktop img-bubble' : 'chat-message-bubble-desktop';
    const ticks = isOwn ? `<span class="msg-ticks${msg.read ? ' read' : ''}"><i class="fas fa-check-double"></i></span>` : '';
    const fwdHtml = msg.forwarded_from ? '<div class="desk-msg-forwarded"><i class="fas fa-share"></i> Forwarded</div>' : '';
    let editedTag = '';
    if (msg.edited) {
      const editTime = msg.edited_at ? new Date(msg.edited_at * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
      editedTag = `<span class="desk-msg-edited-inline"><i class="fas fa-pencil-alt"></i> edited${editTime ? ' ' + editTime : ''}</span>`;
    }
    const actionBtn = msg.id ? `<button class="msg-action-btn" onclick="_showMsgActions(event, '${msg.id}')"><i class="fas fa-chevron-down"></i></button>` : '';
    const reactionsHtml = _buildReactionsHtml(msg);
    
    return `
      <div class="chat-message-desktop ${ownClass}" data-msg-id="${msg.id || ''}" data-sender-id="${msg.sender_id || ''}">
        <div class="msg-bubble-wrap">
          <div class="${bubbleClass}">${actionBtn}${fwdHtml}${replyHtml}${textHtml}${mediaContent}${editedTag}</div>
          ${reactionsHtml}
        </div>
        <span class="desk-msg-time">${time}${ticks}</span>
      </div>
    `;
  }).join('');
  
  // Append only new messages using insertAdjacentHTML to preserve existing DOM
  el.insertAdjacentHTML('beforeend', html);
  
  // Scroll to bottom
  setTimeout(() => {
    el.scrollTop = el.scrollHeight;
  }, 0);
  initDeskContextMenu();
}

async function sendDesktopChatMessage() {
  const input = document.getElementById('desktopChatInput');
  const text = input.value.trim();
  
  if (!_deskChatCurrentConversation || !desktopDeviceId) return;

  // ── Handle EDIT mode ──
  if (_deskEditMsg) {
    if (!text) return;
    try {
      const r = await fetch(`${API_BASE}/p2p/messages/${_deskEditMsg.id}/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ text: text, sender_id: desktopDeviceId })
      });
      if (r.ok) {
        input.value = '';
        cancelDeskEdit();
        // Force full re-render to show edited tag
        _deskChatLastMessageId = null;
        await loadDesktopChatMessages(_deskChatCurrentConversation);
      } else {
        const d = await r.json().catch(() => ({}));
        showNotification(d.error || 'Edit failed', 'error');
      }
    } catch (e) { showNotification('Network error', 'error'); }
    return;
  }

  // ── Handle FORWARD mode ──
  if (_deskForwardMsg) {
    const fwdMsg = _deskForwardMsg;
    const payload = {
      sender_id: desktopDeviceId,
      sender_name: desktopDeviceName,
      recipient_id: _deskChatCurrentConversation,
      text: fwdMsg.text || '',
      forwarded_from: fwdMsg.sender_name || 'Unknown'
    };
    // Forward media if present
    if (fwdMsg.has_media && fwdMsg.media_url) {
      try {
        const mediaRes = await fetch(fwdMsg.media_url);
        const blob = await mediaRes.blob();
        const reader = new FileReader();
        const b64 = await new Promise((resolve) => {
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
        payload.media_data = b64;
        payload.media_type = fwdMsg.media_type || '';
        payload.file_name = fwdMsg.file_name || '';
      } catch (e) { console.warn('Could not forward media:', e); }
    }
    // Add optional text the user typed alongside forward
    if (text && text !== fwdMsg.text) {
      payload.text = text;
    }
    try {
      const r = await fetch(`${API_BASE}/p2p/messages`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      if (r.ok) {
        input.value = '';
        cancelDeskForward();
        loadDesktopChatMessages(_deskChatCurrentConversation);
      }
    } catch (e) { showNotification('Forward failed', 'error'); }
    return;
  }

  // ── Normal send ──
  if (!text) return;
  
  const payload = {
    sender_id: desktopDeviceId,
    sender_name: desktopDeviceName,
    recipient_id: _deskChatCurrentConversation,
    text: text
  };
  if (_deskReplyTo) {
    payload.reply_to = _deskReplyTo.id;
  }
  
  try {
    const r = await fetch(`${API_BASE}/p2p/messages`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    
    if (r.ok) {
      input.value = '';
      cancelDeskReply();
      loadDesktopChatMessages(_deskChatCurrentConversation);
    }
  } catch (e) {
    console.error('Failed to send message:', e);
  }
}

// ── Desktop Reply helpers ────────────────────────────────────
function setDeskReply(msg) {
  _deskReplyTo = { id: msg.id, sender_id: msg.sender_id, sender_name: msg.sender_name || 'Unknown', text: msg.text || '' };
  renderDeskReplyPreview();
  const input = document.getElementById('desktopChatInput');
  if (input) input.focus();
}

function cancelDeskReply() {
  _deskReplyTo = null;
  const bar = document.getElementById('deskReplyPreview');
  if (bar) bar.remove();
}

function renderDeskReplyPreview() {
  const old = document.getElementById('deskReplyPreview');
  if (old) old.remove();
  if (!_deskReplyTo) return;
  
  const isMe = _deskReplyTo.sender_id === desktopDeviceId;
  const name = isMe ? 'You' : _deskReplyTo.sender_name;
  const color = isMe ? '#667EEA' : '#22C55E';
  const preview = _deskReplyTo.text.length > 80 ? _deskReplyTo.text.slice(0, 80) + '...' : (_deskReplyTo.text || '\ud83d\udcce Media');
  
  const bar = document.createElement('div');
  bar.id = 'deskReplyPreview';
  bar.style.cssText = 'padding: 6px 12px 0;';
  bar.innerHTML = `
    <div style="border-left: 3px solid ${color}; padding: 6px 10px; background: rgba(15,23,42,0.8); border-radius: 8px; display: flex; align-items: center; gap: 8px;">
      <div style="flex:1; min-width:0;">
        <div style="font-size:12px; font-weight:700; color:${color}; font-family:Poppins,sans-serif;">${escapeHtml(name)}</div>
        <div style="font-size:12px; color:rgba(255,255,255,0.45); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-family:Poppins,sans-serif;">${escapeHtml(preview)}</div>
      </div>
      <button onclick="cancelDeskReply()" style="background:rgba(255,255,255,0.08); border:none; border-radius:50%; width:24px; height:24px; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
        <i class="fas fa-times" style="color:#94A3B8; font-size:11px;"></i>
      </button>
    </div>
  `;
  
  const inputGroup = document.getElementById('desktopInputGroup');
  if (inputGroup) inputGroup.parentNode.insertBefore(bar, inputGroup);
}

function buildDeskReplyBlock(msg, isOwn) {
  if (!msg.reply_to) return '';
  const r = msg.reply_to;
  const isReplyToSelf = r.sender_id === desktopDeviceId;
  const barColor = isReplyToSelf ? (isOwn ? '#B8C9FF' : '#667EEA') : (isOwn ? '#6EE7B7' : '#22C55E');
  const nameColor = isReplyToSelf ? (isOwn ? '#E0E7FF' : '#667EEA') : (isOwn ? '#6EE7B7' : '#22C55E');
  const name = isReplyToSelf ? 'You' : (r.sender_name || 'Unknown');
  const text = (r.text || '\ud83d\udcce Media').length > 80 ? (r.text || '').slice(0, 80) + '...' : (r.text || '\ud83d\udcce Media');
  const bgColor = isOwn ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.5)';
  const textColor = isOwn ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.4)';
  return `<div style="display:flex; margin-bottom:6px; background:${bgColor}; border-radius:8px; overflow:hidden; cursor:pointer;">
    <div style="width:4px; background:${barColor}; flex-shrink:0; min-height:36px;"></div>
    <div style="padding:4px 8px; min-width:0; flex:1;">
      <div style="font-size:11px; font-weight:700; color:${nameColor}; font-family:Poppins,sans-serif;">${escapeHtml(name)}</div>
      <div style="font-size:12px; color:${textColor}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-family:Poppins,sans-serif;">${escapeHtml(text)}</div>
    </div>
  </div>`;
}

function initDeskReplyListeners() {
  const el = document.getElementById('desktopChatMessages');
  if (!el || el._replyBound) return;
  el._replyBound = true;
  el.addEventListener('dblclick', function(e) {
    const msgEl = e.target.closest('.chat-message-desktop[data-msg-id]');
    if (!msgEl) return;
    const msgId = msgEl.dataset.msgId;
    if (!msgId) return;
    const msg = _deskChatMessages.find(m => m.id === msgId);
    if (msg) setDeskReply(msg);
  });
}

// ── Context Menu (Right-click) for Edit / Forward / Copy / Delete ──
function initDeskContextMenu() {
  const el = document.getElementById('desktopChatMessages');
  if (!el || el._ctxBound) return;
  el._ctxBound = true;

  // Close menu on any click
  document.addEventListener('click', _closeDeskCtx);
  document.addEventListener('contextmenu', function(e) {
    if (!e.target.closest('.desk-chat-ctx')) _closeDeskCtx();
  });

  el.addEventListener('contextmenu', function(e) {
    const msgEl = e.target.closest('.chat-message-desktop[data-msg-id]');
    if (!msgEl) return;
    e.preventDefault();
    const msgId = msgEl.dataset.msgId;
    const msg = _deskChatMessages.find(m => m.id === msgId);
    if (!msg) return;
    const isOwn = msg.sender_id === desktopDeviceId;

    _closeDeskCtx();
    const menu = document.createElement('div');
    menu.className = 'desk-chat-ctx';
    menu.id = 'deskChatCtx';

    // Reply
    menu.innerHTML += `<div class="desk-chat-ctx-item" onclick="_ctxReply('${msgId}')"><i class="fas fa-reply"></i> Reply</div>`;
    // Copy text
    if (msg.text) {
      menu.innerHTML += `<div class="desk-chat-ctx-item" onclick="_ctxCopy('${msgId}')"><i class="fas fa-copy"></i> Copy</div>`;
    }
    // React
    menu.innerHTML += `<div class="desk-chat-ctx-item" onclick="_ctxShowEmojiPicker(event, '${msgId}')"><i class="fas fa-smile"></i> React</div>`;
    // Edit (own text-only messages)
    if (isOwn && msg.text && !msg.has_media) {
      menu.innerHTML += `<div class="desk-chat-ctx-item" onclick="_ctxEdit('${msgId}')"><i class="fas fa-pen"></i> Edit</div>`;
    }
    // Forward
    menu.innerHTML += `<div class="desk-chat-ctx-item" onclick="_ctxForward('${msgId}')"><i class="fas fa-share"></i> Forward</div>`;
    // Delete (own messages)
    if (isOwn) {
      menu.innerHTML += `<div class="desk-chat-ctx-item danger" onclick="_ctxDelete('${msgId}')"><i class="fas fa-trash"></i> Delete</div>`;
    }

    document.body.appendChild(menu);
    // Position near cursor, keep in viewport
    let x = e.clientX, y = e.clientY;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  });
}

function _closeDeskCtx() {
  const m = document.getElementById('deskChatCtx');
  if (m) m.remove();
}

/* ── Hover Action Button handler (WhatsApp-style dropdown) ── */
function _showMsgActions(e, msgId) {
  e.stopPropagation();
  const msg = _deskChatMessages.find(m => m.id === msgId);
  if (!msg) return;
  const isOwn = msg.sender_id === desktopDeviceId;

  _closeDeskCtx();
  const menu = document.createElement('div');
  menu.className = 'desk-chat-ctx';
  menu.id = 'deskChatCtx';

  menu.innerHTML += `<div class="desk-chat-ctx-item" onclick="_ctxReply('${msgId}')"><i class="fas fa-reply"></i> Reply</div>`;
  if (msg.text) {
    menu.innerHTML += `<div class="desk-chat-ctx-item" onclick="_ctxCopy('${msgId}')"><i class="fas fa-copy"></i> Copy</div>`;
  }
  // Emoji React
  menu.innerHTML += `<div class="desk-chat-ctx-item" onclick="_ctxShowEmojiPicker(event, '${msgId}')"><i class="fas fa-smile"></i> React</div>`;
  if (isOwn && msg.text && !msg.has_media) {
    menu.innerHTML += `<div class="desk-chat-ctx-item" onclick="_ctxEdit('${msgId}')"><i class="fas fa-pen"></i> Edit</div>`;
  }
  menu.innerHTML += `<div class="desk-chat-ctx-item" onclick="_ctxForward('${msgId}')"><i class="fas fa-share"></i> Forward</div>`;
  if (isOwn) {
    menu.innerHTML += `<div class="desk-chat-ctx-item danger" onclick="_ctxDelete('${msgId}')"><i class="fas fa-trash"></i> Delete</div>`;
  }

  document.body.appendChild(menu);
  // Position near the button
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  let x = rect.left, y = rect.bottom + 4;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight) y = rect.top - mh - 4;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

/* ── Build reactions HTML below bubble ── */
function _buildReactionsHtml(msg) {
  if (!msg.reactions || Object.keys(msg.reactions).length === 0) return '';
  const counts = {};
  for (const [deviceId, emoji] of Object.entries(msg.reactions)) {
    counts[emoji] = (counts[emoji] || 0) + 1;
  }
  const tags = Object.entries(counts).map(([emoji, count]) => {
    const myReaction = msg.reactions[desktopDeviceId] === emoji ? ' my-reaction' : '';
    return `<span class="msg-reaction-tag${myReaction}" onclick="_toggleReaction('${msg.id}', '${emoji}')">${emoji}${count > 1 ? ' ' + count : ''}</span>`;
  }).join('');
  return `<div class="msg-reactions-row">${tags}</div>`;
}

/* ── Emoji Picker (quick reactions) ── */
const _quickEmojis = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉'];

function _ctxShowEmojiPicker(e, msgId) {
  e.stopPropagation();
  _closeDeskCtx();
  const picker = document.createElement('div');
  picker.className = 'desk-emoji-picker';
  picker.id = 'deskChatCtx';
  picker.innerHTML = _quickEmojis.map(em =>
    `<span class="desk-emoji-opt" onclick="_toggleReaction('${msgId}', '${em}')">${em}</span>`
  ).join('');
  document.body.appendChild(picker);
  // Position near where the menu was
  const x = parseInt(e.clientX) - 80, y = parseInt(e.clientY);
  picker.style.left = Math.max(8, x) + 'px';
  picker.style.top = y + 'px';
}

async function _toggleReaction(msgId, emoji) {
  _closeDeskCtx();
  
  // Optimistic local update — show reaction instantly
  const localMsg = _deskChatMessages.find(m => m.id === msgId);
  if (localMsg) {
    if (!localMsg.reactions) localMsg.reactions = {};
    if (localMsg.reactions[desktopDeviceId] === emoji) {
      delete localMsg.reactions[desktopDeviceId];
    } else {
      localMsg.reactions[desktopDeviceId] = emoji;
    }
    renderDesktopChatMessages();
  }
  
  try {
    const r = await fetch(`${API_BASE}/p2p/messages/${msgId}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: desktopDeviceId, emoji: emoji })
    });
    if (!r.ok) {
      // Revert on failure — force reload
      _deskChatLastMessageId = null;
      await loadDesktopChatMessages(_deskChatCurrentConversation);
    }
  } catch (e) { console.log('React failed', e); }
}

function _ctxReply(msgId) {
  _closeDeskCtx();
  const msg = _deskChatMessages.find(m => m.id === msgId);
  if (msg) setDeskReply(msg);
}

function _ctxCopy(msgId) {
  _closeDeskCtx();
  const msg = _deskChatMessages.find(m => m.id === msgId);
  if (msg && msg.text) {
    navigator.clipboard.writeText(msg.text).then(() => showNotification('Copied', 'success')).catch(() => {});
  }
}

function _ctxEdit(msgId) {
  _closeDeskCtx();
  const msg = _deskChatMessages.find(m => m.id === msgId);
  if (!msg) return;
  cancelDeskReply();
  cancelDeskForward();
  _deskEditMsg = { id: msg.id, text: msg.text };
  const input = document.getElementById('desktopChatInput');
  if (input) { input.value = msg.text; input.focus(); }
  _renderDeskEditPreview();
}

function cancelDeskEdit() {
  _deskEditMsg = null;
  const bar = document.getElementById('deskEditPreview');
  if (bar) bar.remove();
  const input = document.getElementById('desktopChatInput');
  if (input) input.value = '';
}

function _renderDeskEditPreview() {
  const old = document.getElementById('deskEditPreview');
  if (old) old.remove();
  if (!_deskEditMsg) return;
  const bar = document.createElement('div');
  bar.id = 'deskEditPreview';
  bar.style.cssText = 'padding: 6px 12px 0;';
  const preview = _deskEditMsg.text.length > 80 ? _deskEditMsg.text.slice(0, 80) + '...' : _deskEditMsg.text;
  bar.innerHTML = `
    <div style="border-left: 3px solid #F59E0B; padding: 6px 10px; background: rgba(15,23,42,0.8); border-radius: 8px; display: flex; align-items: center; gap: 8px;">
      <i class="fas fa-pen" style="color:#F59E0B; font-size:12px;"></i>
      <div style="flex:1; min-width:0;">
        <div style="font-size:12px; font-weight:700; color:#F59E0B; font-family:Poppins,sans-serif;">Editing message</div>
        <div style="font-size:12px; color:rgba(255,255,255,0.45); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-family:Poppins,sans-serif;">${escapeHtml(preview)}</div>
      </div>
      <button onclick="cancelDeskEdit()" style="background:rgba(255,255,255,0.08); border:none; border-radius:50%; width:24px; height:24px; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
        <i class="fas fa-times" style="color:#94A3B8; font-size:11px;"></i>
      </button>
    </div>
  `;
  const inputGroup = document.getElementById('desktopInputGroup');
  if (inputGroup) inputGroup.parentNode.insertBefore(bar, inputGroup);
}

async function _ctxDelete(msgId) {
  _closeDeskCtx();
  if (!confirm('Delete this message?')) return;
  try {
    await fetch(`${API_BASE}/p2p/messages/${msgId}`, { method: 'DELETE' });
    _deskChatMessages = _deskChatMessages.filter(m => m.id !== msgId);
    const el = document.querySelector(`.chat-message-desktop[data-msg-id="${msgId}"]`);
    if (el) el.remove();
    showNotification('Message deleted', 'success');
  } catch (e) { showNotification('Failed to delete', 'error'); }
}

function _ctxForward(msgId) {
  _closeDeskCtx();
  const msg = _deskChatMessages.find(m => m.id === msgId);
  if (!msg) return;
  cancelDeskReply();
  cancelDeskEdit();
  _deskForwardMsg = msg;
  _renderDeskForwardPreview();
}

function cancelDeskForward() {
  _deskForwardMsg = null;
  const bar = document.getElementById('deskForwardPreview');
  if (bar) bar.remove();
}

function _renderDeskForwardPreview() {
  const old = document.getElementById('deskForwardPreview');
  if (old) old.remove();
  if (!_deskForwardMsg) return;
  const bar = document.createElement('div');
  bar.id = 'deskForwardPreview';
  bar.style.cssText = 'padding: 6px 12px 0;';
  const preview = (_deskForwardMsg.text || '📎 Media').length > 80 ? (_deskForwardMsg.text || '').slice(0, 80) + '...' : (_deskForwardMsg.text || '📎 Media');
  bar.innerHTML = `
    <div style="border-left: 3px solid #22C55E; padding: 6px 10px; background: rgba(15,23,42,0.8); border-radius: 8px; display: flex; align-items: center; gap: 8px;">
      <i class="fas fa-share" style="color:#22C55E; font-size:12px;"></i>
      <div style="flex:1; min-width:0;">
        <div style="font-size:12px; font-weight:700; color:#22C55E; font-family:Poppins,sans-serif;">Forward message</div>
        <div style="font-size:12px; color:rgba(255,255,255,0.45); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-family:Poppins,sans-serif;">${escapeHtml(preview)}</div>
      </div>
      <button onclick="cancelDeskForward()" style="background:rgba(255,255,255,0.08); border:none; border-radius:50%; width:24px; height:24px; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
        <i class="fas fa-times" style="color:#94A3B8; font-size:11px;"></i>
      </button>
    </div>
  `;
  const inputGroup = document.getElementById('desktopInputGroup');
  if (inputGroup) inputGroup.parentNode.insertBefore(bar, inputGroup);
  // Focus input so user can just hit Send (text is optional for forwarding)
  const input = document.getElementById('desktopChatInput');
  if (input) input.focus();
}

function enableDesktopVoiceRecordingButton() {
  const micBtn = document.getElementById('desktopMicBtn');
  if (micBtn) {
    micBtn.disabled = false;
    micBtn.style.opacity = '1';
    micBtn.style.cursor = 'pointer';
    micBtn.title = 'Record voice message';
  }
}

function disableDesktopVoiceRecordingButton(reason = null) {
  const micBtn = document.getElementById('desktopMicBtn');
  if (micBtn && reason) {
    micBtn.disabled = true;
    micBtn.style.opacity = '0.5';
    micBtn.style.cursor = 'not-allowed';
    micBtn.title = reason;
    micBtn.onclick = () => {
      alert(reason + '\n\nYou can:\n1. Check browser permissions\n2. Refresh the page and grant microphone access\n3. Send file attachments instead');
    };
  }
}

async function requestDesktopMicrophonePermission() {
  try {
    // Directly request microphone access (will show browser permission dialog)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // If we got here, permission was granted
    stream.getTracks().forEach(track => track.stop()); // Stop test stream
    desktopMicrophonePermission = 'granted';
    console.log('[Desktop Mic Permission] Permission granted by user');
    return true;
    
  } catch (err) {
    console.warn('[Desktop Mic Permission] Error requesting permission:', err);
    desktopMicrophonePermission = 'denied';
    
    let message = 'Microphone access is denied or unavailable';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      message = 'You denied microphone access';
    } else if (err.name === 'NotFoundError') {
      message = 'No microphone found on this device';
    }
    return false;
  }
}

// Toggle recording: start or stop inline
function toggleDesktopRecording() {
  if (_deskMediaRecorder && _deskMediaRecorder.state === 'recording') {
    // Already recording — send it
    sendDesktopVoiceRecord();
  } else {
    startDesktopVoiceRecord();
  }
}

async function startDesktopVoiceRecord() {
  try {
    console.log('Starting desktop voice record...');
    if (!window.MediaRecorder) {
      throw new Error('MediaRecorder not supported in this browser');
    }
    
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (constraintErr) {
      console.warn('Constraints not supported, trying basic audio:', constraintErr);
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    
    let mimeType = 'audio/webm';
    const supportedTypes = ['audio/mp4','audio/aac','audio/webm;codecs=opus','audio/webm','audio/ogg'];
    for (const type of supportedTypes) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
        mimeType = type;
        _deskRecordingMimeType = type;
        break;
      }
    }
    
    _deskMediaRecorder = new MediaRecorder(stream, { mimeType });
    _deskAudioChunks = [];
    _deskRecordingStartTime = Date.now();
    
    _deskMediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) _deskAudioChunks.push(event.data);
    };
    _deskMediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
      _resetDesktopRecorderUI();
    };
    
    _deskMediaRecorder.start();
    console.log('Recording started with mime type:', mimeType);
    
    // Show inline recorder, hide input group
    const inputGroup = document.getElementById('desktopInputGroup');
    if (inputGroup) inputGroup.style.display = 'none';
    const recorderInline = document.getElementById('desktopRecorderInline');
    if (recorderInline) recorderInline.style.display = 'flex';
    
    // Add recording class to mic button for pulse effect
    const micBtn = document.getElementById('desktopMicBtn');
    if (micBtn) micBtn.classList.add('recording');
    
    _deskRecordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - _deskRecordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      document.getElementById('desktopRecordingTime').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }, 1000);
  } catch (err) {
    console.error('Failed to record audio:', err);
    let msg = 'Unable to access microphone. ';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      msg = 'Microphone permission denied. Please allow microphone access in your browser settings and try again.';
    } else if (err.name === 'NotFoundError') {
      msg = 'No microphone found. Please connect a microphone and try again.';
    } else if (err.name === 'NotReadableError') {
      msg = 'Microphone is in use by another application. Please close other apps and try again.';
    } else if (err.message && err.message.includes('MediaRecorder not supported')) {
      msg = 'Your browser does not support audio recording. Please use Chrome, Edge, or Firefox.';
    } else {
      msg = 'Error: ' + (err.message || 'Unknown error. Please try again.');
    }
    alert(msg);
  }
}

function _resetDesktopRecorderUI() {
  const recorderInline = document.getElementById('desktopRecorderInline');
  if (recorderInline) recorderInline.style.display = 'none';
  const inputGroup = document.getElementById('desktopInputGroup');
  if (inputGroup) inputGroup.style.display = 'flex';
  const timeEl = document.getElementById('desktopRecordingTime');
  if (timeEl) timeEl.textContent = '0:00';
  const micBtn = document.getElementById('desktopMicBtn');
  if (micBtn) micBtn.classList.remove('recording');
}

function cancelDesktopVoiceRecord() {
  if (_deskMediaRecorder && _deskMediaRecorder.state !== 'inactive') {
    _deskMediaRecorder.stop();
    _deskMediaRecorder.stream.getTracks().forEach(track => track.stop());
  }
  if (_deskRecordingTimer) clearInterval(_deskRecordingTimer);
  _deskAudioChunks = [];
  _resetDesktopRecorderUI();
}

async function sendDesktopVoiceRecord() {
  if (_deskRecordingTimer) clearInterval(_deskRecordingTimer);
  
  const duration = Math.floor((Date.now() - _deskRecordingStartTime) / 1000);
  
  const stopPromise = new Promise(resolve => {
    _deskMediaRecorder.onstop = resolve;
  });
  _deskMediaRecorder.stop();
  await stopPromise;
  
  _deskMediaRecorder.stream.getTracks().forEach(track => track.stop());
  
  const audioBlob = new Blob(_deskAudioChunks, { type: _deskRecordingMimeType });
  
  const reader = new FileReader();
  reader.onload = async () => {
    const base64Audio = reader.result.split(',')[1];
    
    await fetch(`${API_BASE}/p2p/messages`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        text: `🎙️ Voice message (${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')})`,
        sender_id: desktopDeviceId,
        sender_name: desktopDeviceName,
        recipient_id: _deskChatCurrentConversation,
        media_type: _deskRecordingMimeType,
        media_data: base64Audio
      })
    }).catch(e => console.error('Failed to send voice:', e));
    
    _deskAudioChunks = [];
    _resetDesktopRecorderUI();
    
    if (_deskChatCurrentConversation) {
      loadDesktopChatMessages(_deskChatCurrentConversation);
    }
  };
  
  reader.readAsDataURL(audioBlob);
}

async function refreshDesktopChatList() {
  await loadDesktopChatList();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Desktop file upload handler
async function handleDesktopFileUpload(event) {
  const files = event.target.files;
  if (!files.length) return;
  
  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) {  // 50MB limit
      console.error('File too large: ' + file.name);
      continue;
    }
    
    const reader = new FileReader();
    reader.onload = async () => {
      const base64Data = reader.result.split(',')[1];
      const fileType = file.type || 'application/octet-stream';
      
      // Send as file message
      await fetch(`${API_BASE}/p2p/messages`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          text: `📎 ${file.name}`,
          sender_id: desktopDeviceId,
          sender_name: desktopDeviceName,
          recipient_id: _deskChatCurrentConversation,
          media_type: fileType,
          media_data: base64Data,
          file_name: file.name,
          file_size: file.size
        })
      }).catch(e => console.error('Failed to send file:', e));
      
      // Refresh messages
      if (_deskChatCurrentConversation) {
        loadDesktopChatMessages(_deskChatCurrentConversation);
      }
    };
    reader.readAsDataURL(file);
  }
  
  // Reset file picker
  event.target.value = '';
}

// Desktop fullscreen photo gallery viewer
function openDesktopPhotoGallery(imgGroupEl, startIndex) {
  let images = [];
  try {
    images = JSON.parse(decodeURIComponent(imgGroupEl.dataset.gallery));
  } catch (e) {
    console.error('Failed to parse gallery data', e);
    return;
  }
  if (!images.length) return;
  
  let currentIndex = startIndex || 0;
  
  const overlay = document.createElement('div');
  overlay.className = 'photo-gallery-overlay';
  
  overlay.innerHTML = `
    <div class="gallery-header">
      <span class="gallery-counter">${currentIndex + 1} / ${images.length}</span>
      <button class="gallery-close-btn" onclick="this.closest('.photo-gallery-overlay').remove()"><i class="fas fa-times"></i></button>
    </div>
    <div class="gallery-body">
      <button class="gallery-nav-btn gallery-prev"><i class="fas fa-chevron-left"></i></button>
      <div class="gallery-img-wrap">
        <img class="gallery-img" src="${images[currentIndex]}">
      </div>
      <button class="gallery-nav-btn gallery-next"><i class="fas fa-chevron-right"></i></button>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  const imgEl = overlay.querySelector('.gallery-img');
  const counterEl = overlay.querySelector('.gallery-counter');
  const prevBtn = overlay.querySelector('.gallery-prev');
  const nextBtn = overlay.querySelector('.gallery-next');
  
  function showImage(idx) {
    if (idx < 0) idx = images.length - 1;
    if (idx >= images.length) idx = 0;
    currentIndex = idx;
    imgEl.src = images[currentIndex];
    counterEl.textContent = (currentIndex + 1) + ' / ' + images.length;
  }
  
  prevBtn.onclick = (e) => { e.stopPropagation(); showImage(currentIndex - 1); };
  nextBtn.onclick = (e) => { e.stopPropagation(); showImage(currentIndex + 1); };
  
  // Swipe support
  let touchStartX = 0;
  let touchStartY = 0;
  overlay.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  overlay.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) showImage(currentIndex + 1);
      else showImage(currentIndex - 1);
    }
  }, { passive: true });
  
  // Click backdrop to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('gallery-body') || e.target.classList.contains('gallery-img-wrap')) {
      overlay.remove();
    }
  });
  
  // Keyboard navigation
  function onKey(e) {
    if (e.key === 'ArrowLeft') showImage(currentIndex - 1);
    else if (e.key === 'ArrowRight') showImage(currentIndex + 1);
    else if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);
  const observer = new MutationObserver(() => {
    if (!document.body.contains(overlay)) {
      document.removeEventListener('keydown', onKey);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });
}

// Initialize chat
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (desktopDeviceId) {
      loadDesktopChatList();
      setInterval(() => {
        if (_deskChatCurrentConversation === null) {
          loadDesktopChatList();
        }
      }, 10000);  // Increased to 10 seconds for stability
    }
  }, 1000);
}, {once: true});

// ═══════════════════════════════════════════════════════════════
// AUTH — Login, Register, Profile, Friends, Requests
// ═══════════════════════════════════════════════════════════════

function _saveAuth(token, user) {
  authToken = token;
  authUser = user;
  localStorage.setItem('lb_auth_token', token);
  localStorage.setItem('lb_auth_user', JSON.stringify(user));
}

function _clearAuth() {
  authToken = null;
  authUser = null;
  authFriends = [];
  authFriendRequests = { incoming: [], outgoing: [] };
  localStorage.removeItem('lb_auth_token');
  localStorage.removeItem('lb_auth_user');
}

function _authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (authToken) h['Authorization'] = 'Bearer ' + authToken;
  return h;
}

async function restoreAuthSession() {
  if (!authToken) { updateAuthUI(); return; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(API_BASE + '/auth/profile', {
      headers: _authHeaders(),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (r.ok) {
      const d = await r.json();
      authUser = d.user;
      authFriends = d.user.friends || [];
      localStorage.setItem('lb_auth_user', JSON.stringify(authUser));
      // Link device
      if (desktopDeviceId) {
        fetch(API_BASE + '/auth/link-device', {
          method: 'POST', headers: _authHeaders(),
          body: JSON.stringify({ device_id: desktopDeviceId })
        }).catch(() => {});
      }
      await loadFriendRequests();
      deskLoadMutedList();
    } else if (r.status === 401) {
      // Token expired or server restarted — clear silently, no notification
      console.log('[Auth] Session token no longer valid, clearing.');
      _clearAuth();
    } else {
      _clearAuth();
    }
  } catch (e) {
    // Network error or timeout — keep local auth data, just skip refresh
    if (e.name !== 'AbortError') console.log('[Auth] Could not reach server:', e.message);
  }
  updateAuthUI();
}

function updateAuthUI() {
  const forms = document.getElementById('authForms');
  const info = document.getElementById('accountInfo');
  const friendsSec = document.getElementById('friendsSection');
  if (!forms || !info) return;

  if (authUser && authToken) {
    forms.style.display = 'none';
    info.style.display = 'block';
    friendsSec.style.display = 'block';
    const privSec = document.getElementById('statusPrivacySection');
    if (privSec) privSec.style.display = 'block';
    document.getElementById('accountName').innerHTML = _esc(authUser.name || '—') + ' ' + vBadge(authUser.id);
    document.getElementById('accountEmail').textContent = authUser.email || '—';
    // Set avatar
    const avatarEl = document.getElementById('profileAvatar');
    if (avatarEl) {
      if (authUser.avatar) {
        avatarEl.innerHTML = `<img src="${authUser.avatar}" alt="Avatar">`;
      } else {
        avatarEl.innerHTML = '<i class="fas fa-user-circle"></i>';
      }
    }
    const ph = document.getElementById('accountPhone');
    if (authUser.phone) { ph.textContent = authUser.phone; ph.style.display = 'block'; }
    else { ph.style.display = 'none'; }
    renderFriendsList();
    renderFriendRequests();
  } else {
    forms.style.display = 'block';
    info.style.display = 'none';
    friendsSec.style.display = 'none';
    const privSec2 = document.getElementById('statusPrivacySection');
    if (privSec2) privSec2.style.display = 'none';
  }
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
  // Clear messages
  document.getElementById('loginMsg').className = 'auth-msg';
  document.getElementById('registerMsg').className = 'auth-msg';
}

function _showAuthMsg(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'auth-msg ' + type;
}

async function doLogin() {
  const identifier = document.getElementById('loginIdentifier').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!identifier || !password) { _showAuthMsg('loginMsg', 'Please fill in all fields', 'error'); return; }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Logging in...';
  try {
    const r = await fetch(API_BASE + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password })
    });
    const d = await r.json();
    if (r.ok && d.token) {
      _saveAuth(d.token, d.user);
      showNotification('Welcome back, ' + d.user.name + '!', 'success');
      // Link device
      if (desktopDeviceId) {
        fetch(API_BASE + '/auth/link-device', {
          method: 'POST', headers: _authHeaders(),
          body: JSON.stringify({ device_id: desktopDeviceId })
        });
      }
      // Fetch full profile with friends
      await restoreAuthSession();
    } else {
      _showAuthMsg('loginMsg', d.error || 'Login failed', 'error');
    }
  } catch (e) {
    _showAuthMsg('loginMsg', 'Network error', 'error');
  }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Login';
}

async function doRegister() {
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  if (!name || (!email && !phone) || !password) {
    _showAuthMsg('registerMsg', 'Name, email/phone, and password required', 'error'); return;
  }
  if (password.length < 4) { _showAuthMsg('registerMsg', 'Password min 4 characters', 'error'); return; }
  const btn = document.getElementById('registerBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Registering...';
  try {
    const r = await fetch(API_BASE + '/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone, password })
    });
    const d = await r.json();
    if (r.ok && d.success) {
      _showAuthMsg('registerMsg', d.message || 'Account created! Please log in.', 'success');
      // Switch to login tab with email pre-filled
      setTimeout(() => {
        switchAuthTabTo('login');
        document.getElementById('loginIdentifier').value = email || phone;
      }, 1000);
    } else {
      _showAuthMsg('registerMsg', d.error || 'Registration failed', 'error');
    }
  } catch (e) {
    _showAuthMsg('registerMsg', 'Network error', 'error');
  }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus"></i> Register';
}

function switchAuthTabTo(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => {
    t.classList.toggle('active', t.textContent.toLowerCase() === tab);
  });
  document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
}

function doLogout() {
  _clearAuth();
  updateAuthUI();
  showNotification('Logged out', 'info');
}

// ── Friends Management ───────────────────────────────────────

async function loadFriendRequests() {
  if (!authToken) return;
  try {
    const r = await fetch(API_BASE + '/auth/friends/requests', { headers: _authHeaders() });
    if (r.ok) {
      authFriendRequests = await r.json();
    }
  } catch (e) { console.warn('Failed to load friend requests:', e); }
}

function renderFriendsList() {
  const el = document.getElementById('friendsList');
  if (!el) return;
  if (!authFriends || authFriends.length === 0) {
    el.innerHTML = '<p class="text-muted" style="font-size:12px">No friends yet. Add someone above!</p>';
    return;
  }
  el.innerHTML = authFriends.map(f => `
    <div class="friend-item">
      <div class="friend-avatar-sm">${(f.name || '?')[0].toUpperCase()}</div>
      <div class="friend-info">
        <div class="name">${_esc(f.name)} ${vBadge(f.id) || vBadge(f.device_id)}</div>
        <div class="email">${_esc(f.email || f.phone || '')}</div>
      </div>
      ${f.online ? '<span class="friend-online-dot" title="Online"></span>' : ''}
      <button class="friend-action-btn remove" onclick="doRemoveFriend('${f.id}')" title="Remove">
        <i class="fas fa-user-minus"></i>
      </button>
    </div>
  `).join('');
}

function renderFriendRequests() {
  const incWrap = document.getElementById('incomingRequestsWrap');
  const outWrap = document.getElementById('outgoingRequestsWrap');
  const incList = document.getElementById('incomingRequestsList');
  const outList = document.getElementById('outgoingRequestsList');
  if (!incWrap || !outWrap) return;

  const inc = authFriendRequests.incoming || [];
  const out = authFriendRequests.outgoing || [];

  if (inc.length > 0) {
    incWrap.style.display = 'block';
    incList.innerHTML = inc.map(r => `
      <div class="friend-item">
        <div class="friend-avatar-sm">${(r.from_name || '?')[0].toUpperCase()}</div>
        <div class="friend-info">
          <div class="name">${_esc(r.from_name)}</div>
          <div class="email">${_esc(r.from_email || '')}</div>
        </div>
        <button class="friend-action-btn accept" onclick="doAcceptRequest('${r.id}')">Accept</button>
        <button class="friend-action-btn reject" onclick="doRejectRequest('${r.id}')">Reject</button>
      </div>
    `).join('');
  } else {
    incWrap.style.display = 'none';
  }

  if (out.length > 0) {
    outWrap.style.display = 'block';
    outList.innerHTML = out.map(r => `
      <div class="friend-item">
        <div class="friend-avatar-sm">${(r.to_name || '?')[0].toUpperCase()}</div>
        <div class="friend-info">
          <div class="name">${_esc(r.to_name)}</div>
          <div class="email">${_esc(r.to_email || '')}</div>
        </div>
        <button class="friend-action-btn reject" onclick="doRejectRequest('${r.id}')" title="Cancel">Cancel</button>
      </div>
    `).join('');
  } else {
    outWrap.style.display = 'none';
  }
}

function _esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

async function doAddFriend() {
  const input = document.getElementById('addFriendInput');
  const identifier = input.value.trim();
  if (!identifier) { _showAuthMsg('addFriendMsg', 'Enter an email or phone number', 'error'); return; }
  try {
    const r = await fetch(API_BASE + '/auth/friends/add', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ identifier })
    });
    const d = await r.json();
    if (r.ok && d.success) {
      _showAuthMsg('addFriendMsg', d.message || 'Friend request sent!', 'success');
      input.value = '';
      // Refresh data
      await restoreAuthSession();
    } else {
      _showAuthMsg('addFriendMsg', d.error || 'Failed to add friend', 'error');
    }
  } catch (e) {
    _showAuthMsg('addFriendMsg', 'Network error', 'error');
  }
}

// ── Contact Synchronisation ──────────────────────────────────

function openContactSync() {
  document.getElementById('contactSyncPanel').style.display = 'block';
}
function closeContactSync() {
  document.getElementById('contactSyncPanel').style.display = 'none';
  document.getElementById('contactSyncResults').innerHTML = '';
}

async function doContactSync() {
  const raw = document.getElementById('contactSyncInput').value.trim();
  if (!raw) { showNotification('Paste some phone numbers or emails first', 'warning'); return; }
  const lines = raw.split(/[\n,;]+/).map(l => l.trim()).filter(Boolean);
  const contacts = lines.map(l => {
    if (l.includes('@')) return { name: '', email: l, phone: '' };
    return { name: '', email: '', phone: l };
  });
  const btn = document.getElementById('contactSyncBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Searching...';
  try {
    const r = await fetch(API_BASE + '/auth/contacts/sync', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ contacts })
    });
    const d = await r.json();
    if (!r.ok) { showNotification(d.error || 'Sync failed', 'error'); return; }
    renderContactSyncResults(d);
  } catch (e) {
    showNotification('Network error during sync', 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-search"></i> Find Friends';
  }
}

function renderContactSyncResults(data) {
  const el = document.getElementById('contactSyncResults');
  const matches = data.matches || [];
  if (matches.length === 0) {
    el.innerHTML = `<p style="font-size:12px;color:var(--text-muted);padding:8px 0">No matches found among ${data.total_contacts} contacts</p>`;
    return;
  }
  let html = `<p style="font-size:12px;margin:8px 0;color:var(--accent)">${matches.length} of ${data.total_contacts} contacts on LocalBeam</p>`;
  const addable = matches.filter(m => !m.already_friend && !m.pending);
  if (addable.length > 1) {
    html += `<button class="btn btn-primary btn-sm" onclick="doContactBulkAdd()" style="margin-bottom:8px;width:100%" id="bulkAddBtn">
      <i class="fas fa-users"></i> Add All (${addable.length})
    </button>`;
  }
  html += matches.map(m => {
    const badge = vBadge(m.user_id);
    const contactLabel = m.contact_name ? `<span style="font-size:10px;color:var(--text-muted)"> (${_esc(m.contact_name)})</span>` : '';
    let actionBtn = '';
    if (m.already_friend) {
      actionBtn = '<span style="color:var(--accent);font-size:11px"><i class="fas fa-check"></i> Friend</span>';
    } else if (m.pending) {
      actionBtn = '<span style="color:var(--text-muted);font-size:11px"><i class="fas fa-clock"></i> Pending</span>';
    } else {
      actionBtn = `<button class="friend-action-btn accept" data-uid="${m.user_id}" onclick="doSyncAdd('${m.user_id}', this)"><i class="fas fa-user-plus"></i></button>`;
    }
    return `<div class="friend-item contact-sync-match">
      <div class="friend-avatar-sm">${(m.name || '?')[0].toUpperCase()}</div>
      <div class="friend-info">
        <div class="name">${_esc(m.name)} ${badge}${contactLabel}</div>
        <div class="email">${_esc(m.email || m.phone || '')}</div>
      </div>
      ${actionBtn}
    </div>`;
  }).join('');
  el.innerHTML = html;
}

async function doSyncAdd(userId, btn) {
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try {
    const r = await fetch(API_BASE + '/auth/contacts/sync-bulk-add', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ user_ids: [userId] })
    });
    const d = await r.json();
    if (r.ok && d.success) {
      btn.outerHTML = '<span style="color:var(--accent);font-size:11px"><i class="fas fa-check"></i> Sent</span>';
      await restoreAuthSession();
    } else {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus"></i>';
      showNotification(d.error || 'Failed', 'error');
    }
  } catch (e) {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus"></i>';
  }
}

async function doContactBulkAdd() {
  const btns = document.querySelectorAll('#contactSyncResults .friend-action-btn.accept[data-uid]');
  const ids = Array.from(btns).map(b => b.dataset.uid);
  if (ids.length === 0) return;
  const bulkBtn = document.getElementById('bulkAddBtn');
  bulkBtn.disabled = true; bulkBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';
  try {
    const r = await fetch(API_BASE + '/auth/contacts/sync-bulk-add', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ user_ids: ids })
    });
    const d = await r.json();
    if (r.ok && d.success) {
      showNotification(`Sent ${d.results.length} friend requests!`, 'success');
      btns.forEach(b => { b.outerHTML = '<span style="color:var(--accent);font-size:11px"><i class="fas fa-check"></i> Sent</span>'; });
      bulkBtn.style.display = 'none';
      await restoreAuthSession();
    }
  } catch (e) {
    showNotification('Network error', 'error');
  }
  bulkBtn.disabled = false; bulkBtn.innerHTML = `<i class="fas fa-users"></i> Add All (${ids.length})`;
}

async function doAcceptRequest(requestId) {
  try {
    const r = await fetch(API_BASE + '/auth/friends/accept', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ request_id: requestId })
    });
    const d = await r.json();
    if (r.ok && d.success) {
      showNotification('Friend request accepted!', 'success');
      await restoreAuthSession();
    } else {
      showNotification(d.error || 'Failed', 'error');
    }
  } catch (e) { showNotification('Network error', 'error'); }
}

async function doRejectRequest(requestId) {
  try {
    const r = await fetch(API_BASE + '/auth/friends/reject', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ request_id: requestId })
    });
    if (r.ok) {
      showNotification('Request removed', 'info');
      await restoreAuthSession();
    }
  } catch (e) { showNotification('Network error', 'error'); }
}

async function doRemoveFriend(friendId) {
  if (!confirm('Remove this friend?')) return;
  try {
    const r = await fetch(API_BASE + '/auth/friends/remove', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ friend_id: friendId })
    });
    if (r.ok) {
      showNotification('Friend removed', 'info');
      await restoreAuthSession();
    }
  } catch (e) { showNotification('Network error', 'error'); }
}

// Poll for friend requests every 30s when logged in
setInterval(async () => {
  if (authToken && currentPage === 'settings') {
    await loadFriendRequests();
    renderFriendRequests();
  }
}, 30000);

// ═══════════════════════════════════════════════════════════════
// STATUS / STORIES — DESKTOP
// ═══════════════════════════════════════════════════════════════

let _deskStatusFeed = [];
let _deskStatusPollTimer = null;
let _deskStatusSelectedBg = '#667eea,#764ba2';
let _deskStatusPendingImg = null;

const DESK_API = window.location.origin + '/api';

function deskStatusInit() {
  const prompt = document.getElementById('deskStatusAuthPrompt');
  const content = document.getElementById('deskStatusContent');
  if (!authToken) {
    prompt.style.display = '';
    content.style.display = 'none';
    return;
  }
  prompt.style.display = 'none';
  content.style.display = '';
  deskStatusLoadFeed();
  if (_deskStatusPollTimer) clearInterval(_deskStatusPollTimer);
  _deskStatusPollTimer = setInterval(() => {
    if (currentPage === 'status' && authToken) deskStatusLoadFeed();
  }, 15000);
}

async function deskStatusLoadFeed() {
  try {
    const r = await fetch(DESK_API + '/status/feed', { headers: _authHeaders() });
    if (!r.ok) return;
    const d = await r.json();
    _deskStatusFeed = d.feed || [];
    deskStatusRender();
  } catch (e) { console.error('[Status] feed error', e); }
}

function _deskTimeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function _deskEsc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function deskStatusRender() {
  const myGroup = _deskStatusFeed.find(g => g.is_mine);
  const others = _deskStatusFeed.filter(g => !g.is_mine);

  // My statuses
  const myCard = document.getElementById('deskMyStatusCard');
  const myList = document.getElementById('deskMyStatusList');
  if (myGroup && myGroup.statuses.length > 0) {
    myCard.style.display = '';
    myList.innerHTML = myGroup.statuses.map((st, si) => {
      const feedIdx = _deskStatusFeed.indexOf(myGroup);
      if (st.has_media || (st.media_type && st.media_type.startsWith('image'))) {
        const url = DESK_API + '/status/media/' + st.id;
        return '<div class="desk-status-thumb" onclick="deskStoryOpen(' + feedIdx + ',' + si + ')">' +
          '<img src="' + url + '" loading="lazy">' +
          '<div class="desk-status-thumb-meta"><span>' + _deskTimeAgo(st.created) + '</span><span><i class="fas fa-eye"></i> ' + (st.view_count || 0) + '</span></div>' +
          '<button class="desk-status-thumb-delete" onclick="event.stopPropagation();deskStatusDelete(\'' + st.id + '\')"><i class="fas fa-trash-alt"></i></button>' +
          '</div>';
      } else {
        const colors = (st.bg_color || '#667eea,#764ba2').split(',');
        const bg = 'linear-gradient(135deg, ' + colors[0] + ', ' + (colors[1] || colors[0]) + ')';
        return '<div class="desk-status-thumb" onclick="deskStoryOpen(' + feedIdx + ',' + si + ')" style="background:' + bg + '">' +
          '<div class="desk-status-thumb-text"><span>' + _deskEsc(st.caption || '') + '</span></div>' +
          '<div class="desk-status-thumb-meta"><span>' + _deskTimeAgo(st.created) + '</span><span><i class="fas fa-eye"></i> ' + (st.view_count || 0) + '</span></div>' +
          '<button class="desk-status-thumb-delete" onclick="event.stopPropagation();deskStatusDelete(\'' + st.id + '\')"><i class="fas fa-trash-alt"></i></button>' +
          '</div>';
      }
    }).join('');
  } else {
    myCard.style.display = 'none';
  }

  // Friends
  const friendWrap = document.getElementById('deskFriendStatusWrap');
  const friendList = document.getElementById('deskFriendStatusList');
  const empty = document.getElementById('deskStatusEmpty');

  if (others.length > 0) {
    friendWrap.style.display = '';
    empty.style.display = 'none';
    friendList.innerHTML = others.map(g => {
      const feedIdx = _deskStatusFeed.indexOf(g);
      const cls = g.all_viewed ? 'viewed' : 'unviewed';
      const cnt = g.statuses.length;
      return '<div class="desk-friend-status-card" onclick="deskStoryOpen(' + feedIdx + ',0)">' +
        '<div class="desk-friend-status-avatar ' + cls + '"><i class="fas fa-user"></i></div>' +
        '<div class="desk-friend-status-info">' +
        '<div class="desk-friend-status-name">' + _deskEsc(g.user_name) + ' ' + vBadge(g.user_id || '') + '</div>' +
        '<div class="desk-friend-status-meta">' + cnt + ' update' + (cnt > 1 ? 's' : '') + ' · ' + _deskTimeAgo(g.latest) + '</div>' +
        '</div></div>';
    }).join('');
  } else {
    friendWrap.style.display = 'none';
    if (!myGroup || myGroup.statuses.length === 0) {
      empty.style.display = '';
    } else {
      empty.style.display = 'none';
    }
  }
}

// ── Posting: Text ──
function deskStatusOpenTextEditor() {
  if (!authToken) return;
  _deskStatusSelectedBg = '#667eea,#764ba2';
  document.querySelectorAll('.dstc-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.dstc-btn').classList.add('active');
  document.getElementById('deskStePreview').style.background = 'linear-gradient(135deg, #667eea, #764ba2)';
  document.getElementById('deskSteInput').value = '';
  document.getElementById('deskStatusTextEditor').style.display = '';
  setTimeout(() => document.getElementById('deskSteInput').focus(), 200);
}

function deskStatusCloseTextEditor() {
  document.getElementById('deskStatusTextEditor').style.display = 'none';
}

function deskStatusPickBg(btn) {
  document.querySelectorAll('.dstc-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _deskStatusSelectedBg = btn.dataset.bg;
  const c = _deskStatusSelectedBg.split(',');
  document.getElementById('deskStePreview').style.background = 'linear-gradient(135deg, ' + c[0] + ', ' + c[1] + ')';
}

async function deskStatusPostText() {
  const text = document.getElementById('deskSteInput').value.trim();
  if (!text) { showNotification('Type something', 'error'); return; }
  const btn = document.querySelector('#deskStatusTextEditor .desk-ste-header button:last-child');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try {
    const r = await fetch(DESK_API + '/status/post', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ caption: text, bg_color: _deskStatusSelectedBg })
    });
    const d = await r.json();
    if (d.success) {
      showNotification('Status posted!', 'success');
      deskStatusCloseTextEditor();
      deskStatusLoadFeed();
    } else { showNotification(d.error || 'Failed', 'error'); }
  } catch (e) { showNotification('Network error', 'error'); }
  btn.innerHTML = '<i class="fas fa-paper-plane"></i> Post';
}

// ── Posting: Image ──
function deskStatusFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const reader = new FileReader();
  reader.onload = function() {
    const base64 = reader.result.split(',')[1];
    _deskStatusPendingImg = { base64: base64, type: file.type || 'image/jpeg' };
    document.getElementById('deskStatusCaptionImg').src = reader.result;
    document.getElementById('deskStatusCaptionText').value = '';
    document.getElementById('deskStatusCaptionDlg').style.display = '';
  };
  reader.readAsDataURL(file);
}

function deskStatusCloseCaptionDlg() {
  document.getElementById('deskStatusCaptionDlg').style.display = 'none';
  _deskStatusPendingImg = null;
}

async function deskStatusPostImage() {
  if (!_deskStatusPendingImg) return;
  const caption = document.getElementById('deskStatusCaptionText').value.trim();
  const btn = document.querySelector('#deskStatusCaptionDlg .desk-ste-header button:last-child');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try {
    const r = await fetch(DESK_API + '/status/post', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({
        media_data: _deskStatusPendingImg.base64,
        media_type: _deskStatusPendingImg.type,
        caption: caption
      })
    });
    const d = await r.json();
    if (d.success) {
      showNotification('Status posted!', 'success');
      deskStatusCloseCaptionDlg();
      deskStatusLoadFeed();
    } else { showNotification(d.error || 'Failed', 'error'); }
  } catch (e) { showNotification('Network error', 'error'); }
  btn.innerHTML = '<i class="fas fa-paper-plane"></i> Post';
}

// ── Delete ──
async function deskStatusDelete(statusId) {
  if (!confirm('Delete this status?')) return;
  try {
    const r = await fetch(DESK_API + '/status/delete', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ status_id: statusId })
    });
    const d = await r.json();
    if (d.success) { showNotification('Deleted', 'success'); deskStatusLoadFeed(); }
    else showNotification(d.error || 'Failed', 'error');
  } catch (e) { showNotification('Network error', 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// STORY VIEWER — DESKTOP (3D Cube)
// ═══════════════════════════════════════════════════════════════

let _dsUserIdx = 0, _dsStoryIdx = 0;
let _dsTimer = null, _dsTimerStart = 0, _dsPaused = false;
const DS_DURATION = 6000;

function deskStoryOpen(feedIdx, storyIdx) {
  _dsUserIdx = feedIdx;
  _dsStoryIdx = storyIdx || 0;
  _dsPaused = false;
  document.getElementById('deskStoryViewer').style.display = '';
  _dsRender();
  _dsBindKeys();
}

function deskStoryClose() {
  document.getElementById('deskStoryViewer').style.display = 'none';
  _dsStopTimer();
  _dsUnbindKeys();
}

function _dsRender() {
  if (_dsUserIdx < 0 || _dsUserIdx >= _deskStatusFeed.length) { deskStoryClose(); return; }
  const group = _deskStatusFeed[_dsUserIdx];
  if (!group || !group.statuses || !group.statuses.length) { deskStoryClose(); return; }
  if (_dsStoryIdx >= group.statuses.length) _dsStoryIdx = 0;

  const container = document.getElementById('deskStoryContainer');
  container.innerHTML = _dsBuildPage(group, _dsStoryIdx);

  // Mark viewed
  const st = group.statuses[_dsStoryIdx];
  if (st && !st.viewed && !group.is_mine) {
    fetch(DESK_API + '/status/view', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ status_id: st.id })
    }).catch(function(){});
    st.viewed = true;
  }

  _dsStartTimer();
  _dsBindLongPress();
}

function _dsBuildPage(group, idx) {
  const statuses = group.statuses;
  const st = statuses[idx];

  // Progress
  var progHtml = '<div class="desk-story-progress">';
  statuses.forEach(function(s, i) {
    var cls = i < idx ? 'done' : (i === idx ? 'active' : '');
    progHtml += '<div class="desk-story-seg ' + cls + '"><div class="desk-story-seg-fill"' + (i === idx ? ' id="dsActiveProgress"' : '') + '></div></div>';
  });
  progHtml += '</div>';

  // Header
  var hdrExtra = group.is_mine ? '<div class="desk-story-hdr-views" onclick="deskShowViewers(\'' + st.id + '\')" style="cursor:pointer" title="Click to see viewers"><i class="fas fa-eye"></i> ' + (st.view_count || 0) + '</div>' : '';
  var hdrHtml = '<div class="desk-story-hdr">' +
    '<div class="desk-story-hdr-ava"><i class="fas fa-user"></i></div>' +
    '<div class="desk-story-hdr-info">' +
    '<div class="desk-story-hdr-name">' + _deskEsc(group.is_mine ? 'My Status' : group.user_name) + '</div>' +
    '<div class="desk-story-hdr-time">' + _deskTimeAgo(st.created) + '</div>' +
    '</div>' + hdrExtra +
    '<button class="desk-story-hdr-close" onclick="deskStoryClose()"><i class="fas fa-times"></i></button>' +
    '</div>';

  // Content
  var bodyHtml = '';
  var _dsIsVid = st.media_type && st.media_type.startsWith('video');
  if (_dsIsVid) {
    var url = DESK_API + '/status/media/' + st.id;
    var cap = st.caption ? '<div class="desk-story-caption"><span>' + _deskEsc(st.caption) + '</span></div>' : '';
    bodyHtml = '<div class="desk-story-body"><video id="dsVideo" src="' + url + '" autoplay playsinline onloadedmetadata="_dsVideoReady(this)" onended="_dsNext()" onerror="this.style.display=\'none\'"></video>' + cap + '</div>';
  } else if (st.has_media || (st.media_type && st.media_type.startsWith('image'))) {
    var url = DESK_API + '/status/media/' + st.id;
    var cap = st.caption ? '<div class="desk-story-caption"><span>' + _deskEsc(st.caption) + '</span></div>' : '';
    bodyHtml = '<div class="desk-story-body"><img src="' + url + '" onerror="this.style.display=\'none\'">' + cap + '</div>';
  } else {
    var colors = (st.bg_color || '#667eea,#764ba2').split(',');
    var bg = 'linear-gradient(135deg, ' + colors[0] + ', ' + (colors[1] || colors[0]) + ')';
    bodyHtml = '<div class="desk-story-body" style="background:' + bg + '">' +
      '<div class="desk-story-text-content"><span>' + _deskEsc(st.caption || '') + '</span></div></div>';
  }

  // Footer — reply, love, share (others' statuses only)
  var footerHtml = group.is_mine ? '' :
    '<div class="desk-story-footer">' +
      '<button class="desk-story-react-btn" onclick="deskStoryToggleLove(this,\'' + st.id + '\')"><i class="far fa-heart"></i></button>' +
      '<div class="desk-story-reply-wrap">' +
        '<textarea class="desk-story-reply-input" placeholder="Reply..." rows="1" onfocus="_dsPause()" onblur="_dsResume()" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();deskStorySendReply(this,\'' + group.user_id + '\')}"></textarea>' +
      '</div>' +
      '<button class="desk-story-react-btn" onclick="deskStoryShare(\'' + st.id + '\')"><i class="fas fa-share"></i></button>' +
    '</div>';

  // Delete + taps
  var delHtml = group.is_mine ? '<button class="desk-story-delete-btn" onclick="deskStoryDelete(\'' + st.id + '\')"><i class="fas fa-trash-alt"></i> Delete</button>' : '';
  var tapHtml = '<div class="desk-story-tap-l" onclick="_dsPrev()"></div><div class="desk-story-tap-r" onclick="_dsNext()"></div>';

  // Nav arrows
  var leftArrow = _dsUserIdx > 0 ? '<button class="desk-story-nav-arrow left" onclick="_dsMoveUser(' + (_dsUserIdx - 1) + ')"><i class="fas fa-chevron-left"></i></button>' : '';
  var rightArrow = _dsUserIdx < _deskStatusFeed.length - 1 ? '<button class="desk-story-nav-arrow right" onclick="_dsMoveUser(' + (_dsUserIdx + 1) + ')"><i class="fas fa-chevron-right"></i></button>' : '';

  var hintHtml = '<div class="desk-story-hint">\u2190 \u2192 navigate \u00b7 Space pause \u00b7 Esc close</div>';

  return '<div class="desk-story-page" id="dsPage">' +
    progHtml + hdrHtml + bodyHtml + footerHtml + delHtml + tapHtml +
    '</div>' + leftArrow + rightArrow + hintHtml;
}

// Timer
function _dsStartTimer() {
  _dsStopTimer();
  if (_dsPaused) return;
  // For video stories, timer is managed by _dsVideoReady
  if (document.getElementById('dsVideo')) return;
  _dsTimerStart = Date.now();
  var el = document.getElementById('dsActiveProgress');
  if (el) el.style.width = '0%';
  _dsTimer = setInterval(function() {
    if (_dsPaused) return;
    var elapsed = Date.now() - _dsTimerStart;
    var pct = Math.min((elapsed / DS_DURATION) * 100, 100);
    if (el) el.style.width = pct + '%';
    if (elapsed >= DS_DURATION) { _dsStopTimer(); _dsNext(); }
  }, 50);
}
function _dsStopTimer() { if (_dsTimer) { clearInterval(_dsTimer); _dsTimer = null; } }

function _dsPause() {
  _dsPaused = true;
  var vid = document.getElementById('dsVideo');
  if (vid) vid.pause();
  var page = document.getElementById('dsPage');
  if (page && !page.querySelector('.desk-story-pause')) {
    var ind = document.createElement('div');
    ind.className = 'desk-story-pause';
    ind.innerHTML = '<i class="fas fa-pause"></i>';
    page.appendChild(ind);
  }
}
function _dsResume() {
  _dsPaused = false;
  var vid = document.getElementById('dsVideo');
  if (vid) vid.play().catch(function(){});
  var el = document.getElementById('dsActiveProgress');
  if (el) {
    var pct = parseFloat(el.style.width) || 0;
    _dsTimerStart = Date.now() - (pct / 100) * DS_DURATION;
  }
  var ind = document.querySelector('.desk-story-pause');
  if (ind) ind.remove();
}

// Navigation (all slides use 3D cube)
function _dsNext() {
  var group = _deskStatusFeed[_dsUserIdx];
  if (!group) { deskStoryClose(); return; }
  if (_dsStoryIdx < group.statuses.length - 1) {
    _dsAnimateSlide('left', _dsUserIdx, _dsStoryIdx + 1);
  } else {
    if (_dsUserIdx + 1 >= _deskStatusFeed.length) { deskStoryClose(); return; }
    _dsAnimateSlide('left', _dsUserIdx + 1, 0);
  }
}
function _dsPrev() {
  if (_dsStoryIdx > 0) {
    _dsAnimateSlide('right', _dsUserIdx, _dsStoryIdx - 1);
  } else if (_dsUserIdx > 0) {
    var g = _deskStatusFeed[_dsUserIdx - 1];
    var lastI = g ? g.statuses.length - 1 : 0;
    _dsAnimateSlide('right', _dsUserIdx - 1, lastI);
  }
}
function _dsMoveUser(idx) {
  if (idx < 0 || idx >= _deskStatusFeed.length) { deskStoryClose(); return; }
  _dsAnimateSlide(idx > _dsUserIdx ? 'left' : 'right', idx, 0);
}

// ── 3D Cube Slide Transition (all story navigations) ──
function _dsAnimateSlide(direction, newUserIdx, newStoryIdx) {
  var container = document.getElementById('deskStoryContainer');
  var curPage = document.getElementById('dsPage');
  if (!curPage) { _dsUserIdx = newUserIdx; _dsStoryIdx = newStoryIdx; _dsRender(); return; }

  _dsStopTimer();
  var curVid = curPage.querySelector('video');
  if (curVid) curVid.pause();

  var newGroup = _deskStatusFeed[newUserIdx];
  if (!newGroup || !newGroup.statuses.length) { deskStoryClose(); return; }
  if (newStoryIdx >= newGroup.statuses.length) newStoryIdx = 0;

  var tempDiv = document.createElement('div');
  tempDiv.innerHTML = _dsBuildPage(newGroup, newStoryIdx);
  var newPage = tempDiv.querySelector('.desk-story-page');
  newPage.id = 'dsPageNew';

  if (direction === 'left') {
    newPage.style.transformOrigin = 'left center';
    newPage.style.transform = 'perspective(1200px) rotateY(90deg)';
    curPage.style.transformOrigin = 'right center';
  } else {
    newPage.style.transformOrigin = 'right center';
    newPage.style.transform = 'perspective(1200px) rotateY(-90deg)';
    curPage.style.transformOrigin = 'left center';
  }
  container.appendChild(newPage);

  var extras = tempDiv.querySelectorAll('.desk-story-nav-arrow, .desk-story-hint');

  requestAnimationFrame(function() {
    curPage.style.transition = 'transform 0.45s cubic-bezier(.4,.0,.2,1)';
    newPage.style.transition = 'transform 0.45s cubic-bezier(.4,.0,.2,1)';
    curPage.style.transform = direction === 'left' ? 'perspective(1200px) rotateY(-90deg)' : 'perspective(1200px) rotateY(90deg)';
    newPage.style.transform = 'perspective(1200px) rotateY(0deg)';

    setTimeout(function() {
      curPage.remove();
      container.querySelectorAll('.desk-story-nav-arrow, .desk-story-hint').forEach(function(el) { el.remove(); });
      newPage.id = 'dsPage';
      newPage.style.transition = '';
      newPage.style.transform = '';
      newPage.style.transformOrigin = '';
      extras.forEach(function(el) { container.appendChild(el); });

      _dsUserIdx = newUserIdx;
      _dsStoryIdx = newStoryIdx;

      var st = newGroup.statuses[newStoryIdx];
      if (st && !st.viewed && !newGroup.is_mine) {
        fetch(DESK_API + '/status/view', {
          method: 'POST', headers: _authHeaders(),
          body: JSON.stringify({ status_id: st.id })
        }).catch(function(){});
        st.viewed = true;
      }
      _dsStartTimer();
      _dsBindLongPress();
    }, 460);
  });
}

// ── Video duration handler ──
function _dsVideoReady(videoEl) {
  if (!videoEl || !videoEl.duration || isNaN(videoEl.duration)) return;
  _dsStopTimer();
  var dur = Math.min(videoEl.duration * 1000, 30000);
  _dsTimerStart = Date.now();
  var el = document.getElementById('dsActiveProgress');
  if (el) el.style.width = '0%';
  _dsTimer = setInterval(function() {
    if (_dsPaused) return;
    var elapsed = Date.now() - _dsTimerStart;
    var pct = Math.min((elapsed / dur) * 100, 100);
    if (el) el.style.width = pct + '%';
    if (elapsed >= dur) { _dsStopTimer(); _dsNext(); }
  }, 50);
}

// ── Love reaction ──
function deskStoryToggleLove(btn, statusId) {
  var icon = btn.querySelector('i');
  if (icon.classList.contains('far')) {
    icon.classList.replace('far', 'fas');
    icon.style.color = '#EF4444';
    btn.classList.add('loved');
    var page = document.getElementById('dsPage');
    if (page) {
      var heart = document.createElement('div');
      heart.className = 'desk-story-love-anim';
      heart.innerHTML = '<i class="fas fa-heart"></i>';
      page.appendChild(heart);
      setTimeout(function() { heart.remove(); }, 1000);
    }
  } else {
    icon.classList.replace('fas', 'far');
    icon.style.color = '';
    btn.classList.remove('loved');
  }
}

// ── Share status ──
function deskStoryShare(statusId) {
  var url = DESK_API + '/status/media/' + statusId;
  if (navigator.share) {
    navigator.share({ title: 'Check this status', url: url }).catch(function(){});
  } else {
    navigator.clipboard.writeText(url).then(function() { showNotification('Link copied!', 'success'); }).catch(function(){});
  }
}

// ── Reply to status ──
function deskStorySendReply(textarea, userId) {
  var text = textarea.value.trim();
  if (!text) return;
  fetch(DESK_API + '/messages/send', {
    method: 'POST', headers: _authHeaders(),
    body: JSON.stringify({ to: userId, text: '\uD83D\uDCF7 Status reply: ' + text })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.success) { showNotification('Reply sent!', 'success'); textarea.value = ''; }
    else showNotification(d.error || 'Failed', 'error');
  }).catch(function() { showNotification('Network error', 'error'); });
  textarea.blur();
  _dsResume();
}

// Long-press to pause
function _dsBindLongPress() {
  var page = document.getElementById('dsPage');
  if (!page) return;
  var lpT = null, didLP = false;
  page.addEventListener('mousedown', function(e) {
    if (e.target.closest('.desk-story-hdr-close') || e.target.closest('.desk-story-delete-btn') || e.target.closest('.desk-story-nav-arrow')) return;
    didLP = false;
    lpT = setTimeout(function() { didLP = true; _dsPause(); }, 400);
  });
  page.addEventListener('mouseup', function() { clearTimeout(lpT); if (didLP) { _dsResume(); didLP = false; } });
}

// Keyboard controls
function _dsKeyHandler(e) {
  if (document.getElementById('deskStoryViewer').style.display === 'none') return;
  if (e.key === 'ArrowRight') _dsNext();
  else if (e.key === 'ArrowLeft') _dsPrev();
  else if (e.key === 'Escape') deskStoryClose();
  else if (e.key === ' ') { e.preventDefault(); _dsPaused ? _dsResume() : _dsPause(); }
}
function _dsBindKeys() { document.addEventListener('keydown', _dsKeyHandler); }
function _dsUnbindKeys() { document.removeEventListener('keydown', _dsKeyHandler); }

// Delete from viewer
async function deskStoryDelete(statusId) {
  if (!confirm('Delete this status?')) return;
  try {
    var r = await fetch(DESK_API + '/status/delete', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ status_id: statusId })
    });
    var d = await r.json();
    if (d.success) {
      showNotification('Deleted', 'success');
      var group = _deskStatusFeed[_dsUserIdx];
      if (group) {
        group.statuses = group.statuses.filter(function(s) { return s.id !== statusId; });
        if (group.statuses.length === 0) deskStoryClose();
        else {
          if (_dsStoryIdx >= group.statuses.length) _dsStoryIdx = group.statuses.length - 1;
          _dsRender();
        }
      }
      deskStatusLoadFeed();
    } else showNotification(d.error || 'Failed', 'error');
  } catch (e) { showNotification('Network error', 'error'); }
}

/* ── Status Viewers Modal ── */
async function deskShowViewers(statusId) {
  _dsStopTimer();
  const modal = document.getElementById('deskStatusViewersModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const list = document.getElementById('deskViewersList');
  const countEl = document.getElementById('deskViewersCount');
  list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary)">Loading...</div>';
  countEl.textContent = '';
  try {
    const r = await fetch(DESK_API + '/status/viewers', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ status_id: statusId })
    });
    const d = await r.json();
    if (d.viewers && d.viewers.length) {
      countEl.textContent = d.count + ' viewer' + (d.count !== 1 ? 's' : '');
      list.innerHTML = d.viewers.map(v =>
        '<div class="desk-viewer-item"><i class="fas fa-user-circle"></i> <span>' + _deskEsc(v.name || v.user_id) + '</span></div>'
      ).join('');
    } else {
      countEl.textContent = '0 viewers';
      list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">No viewers yet</div>';
    }
  } catch (e) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:#ef4444">Failed to load viewers</div>';
  }
}

function deskCloseViewers() {
  const modal = document.getElementById('deskViewersModal');
  if (modal) modal.style.display = 'none';
  _dsStartTimer();
}

/* ── Status Mute (Privacy) ── */
let _deskMutedList = [];

async function deskLoadMutedList() {
  try {
    const r = await fetch(DESK_API + '/status/muted', { headers: _authHeaders() });
    const d = await r.json();
    _deskMutedList = d.muted || [];
  } catch(e) { _deskMutedList = []; }
  deskRenderMuteList();
}

function deskRenderMuteList() {
  const container = document.getElementById('statusMuteList');
  if (!container) return;
  if (!authFriends || !authFriends.length) {
    container.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted)">Add friends first</div>';
    return;
  }
  container.innerHTML = authFriends.map(f => {
    const isMuted = _deskMutedList.includes(f.id || f.user_id);
    const fid = f.id || f.user_id;
    return '<div class="mute-friend-item">' +
      '<div class="mute-friend-name"><i class="fas fa-user-circle"></i> ' + _deskEsc(f.name) + '</div>' +
      '<label class="mute-toggle"><input type="checkbox" ' + (isMuted ? 'checked' : '') +
      ' onchange="deskToggleMute(\'' + fid + '\', this.checked)"><span class="mute-slider"></span></label></div>';
  }).join('');
}

async function deskToggleMute(friendId, mute) {
  try {
    const r = await fetch(DESK_API + '/status/mute', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ friend_id: friendId, mute: mute })
    });
    const d = await r.json();
    if (d.success) {
      if (mute && !_deskMutedList.includes(friendId)) _deskMutedList.push(friendId);
      else if (!mute) _deskMutedList = _deskMutedList.filter(id => id !== friendId);
      showNotification(mute ? 'Friend muted from status' : 'Friend unmuted', 'success');
    }
  } catch(e) { showNotification('Network error', 'error'); }
}

/* ── Profile Update Functions ── */
function toggleNameEdit() {
  const row = document.getElementById('nameEditRow');
  const nameEl = document.getElementById('accountName');
  if (row.style.display === 'none') {
    row.style.display = 'flex';
    const input = document.getElementById('nameEditInput');
    input.value = authUser ? authUser.name : '';
    input.focus();
    nameEl.style.display = 'none';
    document.querySelector('.profile-edit-btn').style.display = 'none';
  } else {
    row.style.display = 'none';
    nameEl.style.display = '';
    document.querySelector('.profile-edit-btn').style.display = '';
  }
}

async function saveProfileName() {
  const input = document.getElementById('nameEditInput');
  const newName = input.value.trim();
  if (!newName) { showNotification('Name cannot be empty', 'error'); return; }
  try {
    const r = await fetch(API_BASE + '/auth/profile/update', {
      method: 'POST', headers: _authHeaders(),
      body: JSON.stringify({ name: newName })
    });
    const d = await r.json();
    if (d.success) {
      authUser.name = d.name;
      localStorage.setItem('lb_auth_user', JSON.stringify(authUser));
      document.getElementById('accountName').textContent = d.name;
      toggleNameEdit();
      showNotification('Name updated!', 'success');
    } else {
      showNotification(d.error || 'Failed', 'error');
    }
  } catch(e) { showNotification('Network error', 'error'); }
}

async function uploadAvatar(input) {
  const file = input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showNotification('Please select an image file', 'error'); return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showNotification('Image must be under 5MB', 'error'); return;
  }
  const formData = new FormData();
  formData.append('avatar', file);
  try {
    showNotification('Uploading...', 'info');
    const r = await fetch(API_BASE + '/auth/profile/avatar', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + authToken },
      body: formData
    });
    const d = await r.json();
    if (d.success) {
      authUser.avatar = d.avatar_url;
      localStorage.setItem('lb_auth_user', JSON.stringify(authUser));
      const avatarEl = document.getElementById('profileAvatar');
      if (avatarEl) avatarEl.innerHTML = `<img src="${d.avatar_url}" alt="Avatar">`;
      showNotification('Profile picture updated!', 'success');
    } else {
      showNotification(d.error || 'Upload failed', 'error');
    }
  } catch(e) { showNotification('Network error', 'error'); }
  input.value = '';
}

/* ══════════════════════════════════════════════════════════════
   EMOJI PICKER – full picker with categories, search, recents
   ══════════════════════════════════════════════════════════════ */
const _emojiCategories = [
  { id:'recent',  icon:'🕐', label:'Recent',          emojis: [] },
  { id:'smileys', icon:'😀', label:'Smileys & People', emojis:[
    '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩',
    '😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🫡',
    '🤐','🤨','😐','😑','😶','🫥','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴',
    '😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐',
    '😕','🫤','😟','🙁','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢',
    '😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀',
    '☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀',
    '😿','😾','🙈','🙉','🙊','💋','💌','💘','💝','💖','💗','💓','💞','💕','💟','❣️',
    '💔','❤️','🧡','💛','💚','💙','💜','🤎','🖤','🤍','💯','💢','💥','💫','💦','💨',
    '🕳️','💣','💬','👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️',
    '🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','🫵','👍','👎','✊','👊',
    '🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵',
    '🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄','🫦','👶','🧒',
    '👦','👧','🧑','👱','👨','🧔','👩','🧓','👴','👵','🙍','🙎','🙅','🙆','💁','🙋',
    '🧏','🙇','🤦','🤷','👮','🕵️','💂','🥷','👷','🫅','🤴','👸','👳','👲','🧕','🤵',
    '👰','🤰','🫃','🫄','🤱','👼','🎅','🤶','🦸','🦹','🧙','🧚','🧛','🧜','🧝','🧞','🧟'
  ]},
  { id:'animals', icon:'🐾', label:'Animals & Nature', emojis:[
    '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐸','🐵',
    '🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗',
    '🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🦂',
    '🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🪸','🐡','🐠','🐟','🐬','🐳',
    '🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬',
    '🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛',
    '🪶','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥',
    '🐁','🐀','🐿️','🦔','🌵','🎄','🌲','🌳','🌴','🪵','🌱','🌿','☘️','🍀','🎍','🪴',
    '🎋','🍃','🍂','🍁','🪺','🪹','🍄','🌾','💐','🌷','🌹','🥀','🌺','🌸','🌼','🌻',
    '🌞','🌝','🌛','🌜','🌚','🌕','🌖','🌗','🌘','🌑','🌒','🌓','🌔','🌙','🌎','🌍','🌏',
    '🪐','💫','⭐','🌟','✨','⚡','☄️','💥','🔥','🌪️','🌈','☀️','🌤️','⛅','🌥️','☁️',
    '🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','💧','💦','🫧','☔','☂️','🌊'
  ]},
  { id:'food', icon:'🍔', label:'Food & Drink', emojis:[
    '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥',
    '🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠',
    '🫘','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖',
    '🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝',
    '🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡',
    '🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜',
    '🍯','🥛','🍼','🫖','☕','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🥃','🍸',
    '🍹','🧉','🍾','🧊','🥄','🍴','🍽️','🥣','🥡','🥢','🧂'
  ]},
  { id:'activities', icon:'⚽', label:'Activities', emojis:[
    '⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍',
    '🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌',
    '🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','🤺','⛹️','🤾','🏌️','🏇','🧘','🏄','🏊','🤽',
    '🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎫','🎟️','🎪','🤹',
    '🎭','🩰','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🪗','🎸','🪕','🎻',
    '🎲','♟️','🎯','🎳','🎮','🕹️','🧩','🪅','🪩','🪆'
  ]},
  { id:'travel', icon:'🚗', label:'Travel & Places', emojis:[
    '🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🦯','🦽',
    '🦼','🛴','🚲','🛵','🏍️','🛺','🚨','🚔','🚍','🚘','🚖','🛞','🚡','🚠','🚟','🚃',
    '🚋','🚞','🚝','🚄','🚅','🚈','🚂','🚆','🚇','🚊','🚉','✈️','🛫','🛬','🛩️','💺',
    '🛰️','🚀','🛸','🚁','🛶','⛵','🚤','🛥️','🛳️','⛴️','🚢','⚓','🪝','⛽','🚧','🚦',
    '🚥','🚏','🗺️','🗿','🗽','🗼','🏰','🏯','🏟️','🎡','🎢','🎠','⛲','⛱️','🏖️','🏝️',
    '🏜️','🌋','⛰️','🏔️','🗻','🏕️','⛺','🛖','🏠','🏡','🏘️','🏚️','🏗️','🏭','🏢','🏬',
    '🏣','🏤','🏥','🏦','🏨','🏪','🏫','🏩','💒','🏛️','⛪','🕌','🕍','🛕','🕋','⛩️',
    '🛤️','🛣️','🗾','🎑','🏞️','🌅','🌄','🌠','🎇','🎆','🌇','🌆','🏙️','🌃','🌌','🌉','🌁'
  ]},
  { id:'objects', icon:'💡', label:'Objects', emojis:[
    '⌚','📱','📲','💻','⌨️','🖥️','🖨️','🖱️','🖲️','🕹️','🗜️','💽','💾','💿','📀','📼',
    '📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🎙️','🎚️','🎛️','🧭',
    '⏱️','⏲️','⏰','🕰️','⌛','⏳','📡','🔋','🪫','🔌','💡','🔦','🕯️','🪔','🧯','🛢️',
    '💸','💵','💴','💶','💷','🪙','💰','💳','💎','⚖️','🪜','🧰','🪛','🔧','🔨','⚒️',
    '🛠️','⛏️','🪚','🔩','⚙️','🪤','🧱','⛓️','🧲','🔫','💣','🧨','🪓','🔪','🗡️','⚔️',
    '🛡️','🚬','⚰️','🪦','⚱️','🏺','🔮','📿','🧿','🪬','💈','⚗️','🔭','🔬','🕳️','🩻',
    '🩹','🩺','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡️','🧹','🪠','🧺','🧻','🚽','🚰',
    '🚿','🛁','🛀','🧼','🪥','🪒','🧽','🪣','🧴','🛎️','🔑','🗝️','🚪','🪑','🛋️','🛏️',
    '🛌','🧸','🪆','🖼️','🪞','🪟','🛍️','🛒','🎁','🎈','🎏','🎀','🪄','🪅','🎊','🎉',
    '🎎','🏮','🎐','🧧','✉️','📩','📨','📧','💌','📥','📤','📦','🏷️','🪧','📪','📫',
    '📬','📭','📮','📯','📜','📃','📄','📑','🧾','📊','📈','📉','🗒️','🗓️','📆','📅',
    '🗑️','📇','🗃️','🗳️','🗄️','📋','📁','📂','🗂️','🗞️','📰','📓','📔','📒','📕','📗',
    '📘','📙','📚','📖','🔖','🧷','🔗','📎','🖇️','📐','📏','🧮','📌','📍','✂️','🖊️',
    '🖋️','✒️','🖌️','🖍️','📝','✏️','🔍','🔎','🔏','🔐','🔒','🔓'
  ]},
  { id:'symbols', icon:'❤️', label:'Symbols', emojis:[
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','❣️','💕','💞','💓',
    '💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐',
    '⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑',
    '☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴',
    '🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯',
    '💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅',
    '🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❇️','✳️','❎','🌐','💠',
    'Ⓜ️','🌀','💤','🏧','🚾','♿','🅿️','🛗','🈳','🈂️','🛂','🛃','🛄','🛅','🚹','🚺',
    '🚼','⚧️','🚻','🚮','🎦','📶','🈁','🔣','ℹ️','🔤','🔡','🔠','🆖','🆗','🆙','🆒',
    '🆕','🆓','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔢','#️⃣','*️⃣',
    '⏏️','▶️','⏸️','⏯️','⏹️','⏺️','⏭️','⏮️','⏩','⏪','⏫','⏬','◀️','🔼','🔽','➡️',
    '⬅️','⬆️','⬇️','↗️','↘️','↙️','↖️','↕️','↔️','↪️','↩️','⤴️','⤵️','🔀','🔁','🔂',
    '🔄','🔃','🎵','🎶','➕','➖','➗','✖️','🟰','♾️','💲','💱','™️','©️','®️','〰️',
    '➰','➿','🔚','🔙','🔛','🔝','🔜','✔️','☑️','🔘','🔴','🟠','🟡','🟢','🔵','🟣',
    '⚫','⚪','🟤','🔺','🔻','🔸','🔹','🔶','🔷','🔳','🔲','▪️','▫️','◾','◽','◼️','◻️',
    '🟥','🟧','🟨','🟩','🟦','🟪','⬛','⬜','🟫','🔈','🔇','🔉','🔊','🔔','🔕','📣',
    '📢','💬','💭','🗯️','♠️','♣️','♥️','♦️','🃏','🎴','🀄','🏁','🚩','🎌','🏴','🏳️'
  ]},
  { id:'flags', icon:'🏁', label:'Flags', emojis:[
    '🇺🇸','🇬🇧','🇨🇦','🇦🇺','🇩🇪','🇫🇷','🇪🇸','🇮🇹','🇧🇷','🇯🇵','🇰🇷','🇨🇳','🇮🇳','🇷🇺','🇲🇽','🇿🇦',
    '🇳🇬','🇪🇬','🇰🇪','🇬🇭','🇹🇿','🇪🇹','🇺🇬','🇸🇳','🇨🇲','🇨🇮','🇲🇦','🇩🇿','🇹🇳','🇱🇾','🇸🇩','🇸🇸',
    '🇦🇷','🇨🇱','🇨🇴','🇵🇪','🇻🇪','🇪🇨','🇧🇴','🇵🇾','🇺🇾','🇨🇷','🇵🇦','🇨🇺','🇩🇴','🇭🇹','🇯🇲','🇹🇹',
    '🇸🇪','🇳🇴','🇫🇮','🇩🇰','🇮🇸','🇳🇱','🇧🇪','🇨🇭','🇦🇹','🇵🇱','🇨🇿','🇭🇺','🇷🇴','🇧🇬','🇬🇷','🇹🇷',
    '🇵🇹','🇮🇪','🇺🇦','🇭🇷','🇸🇰','🇸🇮','🇷🇸','🇱🇹','🇱🇻','🇪🇪','🇬🇪','🇦🇲','🇦🇿','🇰🇿','🇺🇿','🇹🇲',
    '🇸🇦','🇦🇪','🇶🇦','🇰🇼','🇧🇭','🇴🇲','🇾🇪','🇮🇶','🇮🇷','🇸🇾','🇯🇴','🇱🇧','🇮🇱','🇵🇸','🇵🇰','🇧🇩',
    '🇱🇰','🇳🇵','🇲🇲','🇹🇭','🇻🇳','🇰🇭','🇱🇦','🇲🇾','🇸🇬','🇮🇩','🇵🇭','🇹🇼','🇭🇰','🇲🇴','🇲🇳','🇰🇵',
    '🇳🇿','🇫🇯','🇵🇬','🇼🇸','🇹🇴','🇪🇺','🇺🇳'
  ]}
];

/* Recent emojis stored in localStorage */
const _RECENT_KEY = 'emoji_recents';
function _getRecentEmojis() {
  try { return JSON.parse(localStorage.getItem(_RECENT_KEY)) || []; } catch(e) { return []; }
}
function _addRecentEmoji(em) {
  let arr = _getRecentEmojis().filter(e => e !== em);
  arr.unshift(em);
  if (arr.length > 30) arr = arr.slice(0, 30);
  localStorage.setItem(_RECENT_KEY, JSON.stringify(arr));
}

let _emojiPickerOpen = false;

function toggleEmojiPicker() {
  if (_emojiPickerOpen) { closeEmojiPicker(); return; }
  _emojiPickerOpen = true;

  const old = document.getElementById('emojiPickerPanel');
  if (old) old.remove();

  const panel = document.createElement('div');
  panel.id = 'emojiPickerPanel';
  panel.className = 'emoji-picker-panel';

  /* Category tabs */
  const tabs = document.createElement('div');
  tabs.className = 'emoji-picker-tabs';
  _emojiCategories.forEach(cat => {
    const t = document.createElement('button');
    t.className = 'emoji-tab' + (cat.id === 'smileys' ? ' active' : '');
    t.textContent = cat.icon;
    t.title = cat.label;
    t.setAttribute('data-cat', cat.id);
    t.onclick = function() {
      tabs.querySelectorAll('.emoji-tab').forEach(b => b.classList.remove('active'));
      t.classList.add('active');
      _renderEmojiCategory(cat.id, grid, searchInput);
    };
    tabs.appendChild(t);
  });
  panel.appendChild(tabs);

  /* Search */
  const searchWrap = document.createElement('div');
  searchWrap.className = 'emoji-search-wrap';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'emoji-search-input';
  searchInput.placeholder = 'Search emoji';
  searchWrap.innerHTML = '<i class="fas fa-search emoji-search-icon"></i>';
  searchWrap.appendChild(searchInput);
  panel.appendChild(searchWrap);

  /* Grid */
  const grid = document.createElement('div');
  grid.className = 'emoji-picker-grid';
  panel.appendChild(grid);

  /* Render initial category */
  const recents = _getRecentEmojis();
  if (recents.length > 0) {
    _emojiCategories[0].emojis = recents;
    _renderEmojiCategory('recent', grid, searchInput);
    tabs.querySelector('[data-cat="recent"]').classList.add('active');
    tabs.querySelector('[data-cat="smileys"]').classList.remove('active');
  } else {
    _renderEmojiCategory('smileys', grid, searchInput);
  }

  /* Search handler */
  searchInput.addEventListener('input', function() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      const active = tabs.querySelector('.emoji-tab.active');
      _renderEmojiCategory(active ? active.getAttribute('data-cat') : 'smileys', grid, searchInput);
      return;
    }
    let results = [];
    _emojiCategories.slice(1).forEach(cat => {
      cat.emojis.forEach(em => { if (!results.includes(em)) results.push(em); });
    });
    grid.innerHTML = '';
    const label = document.createElement('div');
    label.className = 'emoji-cat-label';
    label.textContent = 'All Emojis';
    grid.appendChild(label);
    const wrap = document.createElement('div');
    wrap.className = 'emoji-cat-grid';
    results.forEach(em => {
      const btn = document.createElement('button');
      btn.className = 'emoji-btn';
      btn.textContent = em;
      btn.onclick = function() { _insertEmoji(em); };
      wrap.appendChild(btn);
    });
    grid.appendChild(wrap);
  });

  /* Position & insert */
  const inputGroup = document.getElementById('desktopInputGroup');
  inputGroup.style.position = 'relative';
  inputGroup.appendChild(panel);

  const toggle = document.getElementById('emojiPickerToggle');
  if (toggle) toggle.classList.add('active');

  setTimeout(() => { document.addEventListener('click', _emojiOutsideClick); }, 50);
}

function _renderEmojiCategory(catId, grid, searchInput) {
  if (searchInput) searchInput.value = '';
  grid.innerHTML = '';
  const cat = _emojiCategories.find(c => c.id === catId);
  if (!cat || cat.emojis.length === 0) {
    grid.innerHTML = '<div style="padding:20px;text-align:center;color:#94A3B8;font-size:13px;">No recent emojis yet</div>';
    return;
  }
  const label = document.createElement('div');
  label.className = 'emoji-cat-label';
  label.textContent = cat.label;
  grid.appendChild(label);
  const wrap = document.createElement('div');
  wrap.className = 'emoji-cat-grid';
  cat.emojis.forEach(em => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = em;
    btn.onclick = function() { _insertEmoji(em); };
    wrap.appendChild(btn);
  });
  grid.appendChild(wrap);
}

function _insertEmoji(emoji) {
  const ta = document.getElementById('desktopChatInput');
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const val = ta.value;
  ta.value = val.slice(0, start) + emoji + val.slice(end);
  const newPos = start + emoji.length;
  ta.selectionStart = ta.selectionEnd = newPos;
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  _addRecentEmoji(emoji);
  _emojiCategories[0].emojis = _getRecentEmojis();
}

function closeEmojiPicker() {
  _emojiPickerOpen = false;
  const panel = document.getElementById('emojiPickerPanel');
  if (panel) panel.remove();
  const toggle = document.getElementById('emojiPickerToggle');
  if (toggle) toggle.classList.remove('active');
  document.removeEventListener('click', _emojiOutsideClick);
}

function _emojiOutsideClick(e) {
  const panel = document.getElementById('emojiPickerPanel');
  const toggle = document.getElementById('emojiPickerToggle');
  if (panel && !panel.contains(e.target) && toggle && !toggle.contains(e.target)) {
    closeEmojiPicker();
  }
}

// ═══════════════════════════════════════════════════════════════
// CALLS — WebRTC Peer-to-Peer
// ═══════════════════════════════════════════════════════════════

// Dynamic audio element for reliable remote call audio
function _ensureRemoteAudio(stream) {
  let el = document.getElementById('_dynRemoteAudio');
  if (!el) {
    el = document.createElement('audio');
    el.id = '_dynRemoteAudio';
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;';
    document.body.appendChild(el);
  }
  if (el.srcObject !== stream) {
    el.srcObject = stream;
  }
  el.volume = 1.0;
  const p = el.play();
  if (p) p.catch(e => {
    console.warn('[Call] Audio autoplay blocked, retry on click:', e);
    document.addEventListener('click', () => { el.play().catch(() => {}); }, { once: true });
  });
  console.log('[Call] Dynamic remote audio element ready');
}
function _cleanupDynAudio() {
  const el = document.getElementById('_dynRemoteAudio');
  if (el) { el.srcObject = null; el.remove(); }
}

const _rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // TURN relay for NAT traversal (cross-network calls)
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ],
  iceCandidatePoolSize: 2,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

let _currentCallId = null;
let _peerConnection = null;
let _localStream = null;
let _callTimerInterval = null;
let _callTimerSeconds = 0;
let _incomingCallData = null;
let _callPollInterval = null;
let _signalPollInterval = null;
let _callTargetDeviceId = null;
let _callIsInitiator = false;
let _deskPendingIceCandidates = [];  // buffer ICE candidates until remote desc is set
let _deskRemoteDescSet = false;

// ── Bot auto-answer call state ──
let _deskBotCallActive = false;
let _deskBotCallId = null;
let _deskBotPeerConnection = null;
let _deskBotSignalPollTimer = null;
let _deskBotAudioCtx = null;
let _deskBotRecognition = null;
let _deskBotSpeaking = false;
let _deskBotCallTargetId = null;
let _deskBotRemoteStream = null;
let _deskBotLocalStream = null;
let _deskBotConversation = [];
let _deskIceTimeout = null;

function _deskForceAudioPlay() {
  ['remoteAudio', 'chatRemoteAudio', '_dynRemoteAudio'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.srcObject) {
      el.muted = false;
      el.volume = 1.0;
      el.play().catch(() => {});
    }
  });
}

// ── Video relay fallback (when WebRTC peer-to-peer fails) ──
let _deskRelayMode = false;
let _deskRelaySendTimer = null;
let _deskRelayRecvTimer = null;
let _deskRelayCanvas = null;
let _deskRelayCallId = null;
let _deskRelayRemoteId = null;
// Audio relay (raw PCM via Web Audio API)
let _deskAudioCtx = null;
let _deskAudioSource = null;
let _deskAudioProcessor = null;
let _deskAudioSendTimer = null;
let _deskAudioRecvTimer = null;
let _deskAudioLastSeq = -1;
let _deskAudioPcmBuffer = [];  // accumulated Int16 samples to send
let _deskAudioPlayCtx = null;  // playback AudioContext
let _deskAudioNextPlayTime = 0;

function _deskStartVideoRelay(callId, myDeviceId, remoteDeviceId) {
  if (_deskRelayMode) return;
  _deskRelayMode = true;
  _deskRelayCallId = callId;
  _deskRelayRemoteId = remoteDeviceId;
  console.log('[VideoRelay] Starting server-side video relay as fallback');

  // Canvas to capture local video frames
  _deskRelayCanvas = document.createElement('canvas');
  _deskRelayCanvas.width = 320;
  _deskRelayCanvas.height = 240;
  const ctx = _deskRelayCanvas.getContext('2d');

  // Send local video frames to server
  const localVid = document.getElementById(_callFromChat ? 'chatLocalVideo' : 'localVideo');
  _deskRelaySendTimer = setInterval(async () => {
    if (!localVid || !localVid.srcObject || !_deskRelayMode) return;
    try {
      ctx.drawImage(localVid, 0, 0, 320, 240);
      const blob = await new Promise(r => _deskRelayCanvas.toBlob(r, 'image/jpeg', 0.5));
      if (!blob) return;
      const fd = new FormData();
      fd.append('call_id', callId);
      fd.append('device_id', myDeviceId);
      fd.append('frame', blob, 'f.jpg');
      fetch(`${API_BASE}/calls/video-frame`, { method: 'POST', body: fd }).catch(() => {});
    } catch(e) {}
  }, 150);

  // Receive remote video frames from server and display
  const remoteVid = document.getElementById(_callFromChat ? 'chatRemoteVideo' : 'remoteVideo');
  let relayImg = document.getElementById('_deskRelayImg');
  if (!relayImg && remoteVid) {
    relayImg = document.createElement('img');
    relayImg.id = '_deskRelayImg';
    relayImg.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;top:0;left:0;z-index:1;';
    remoteVid.parentElement.style.position = 'relative';
    remoteVid.parentElement.appendChild(relayImg);
  }
  _deskRelayRecvTimer = setInterval(async () => {
    if (!_deskRelayMode) return;
    try {
      const res = await fetch(`${API_BASE}/calls/video-frame/${callId}/${remoteDeviceId}?_=${Date.now()}`);
      if (res.ok && res.status === 200) {
        const blob = await res.blob();
        if (relayImg) {
          const old = relayImg.src;
          relayImg.src = URL.createObjectURL(blob);
          relayImg.style.display = 'block';
          if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
        }
      }
    } catch(e) {}
  }, 150);

  // Also start audio relay
  _deskStartAudioRelay(callId, myDeviceId, remoteDeviceId);
}

function _deskStopVideoRelay() {
  _deskRelayMode = false;
  if (_deskRelaySendTimer) { clearInterval(_deskRelaySendTimer); _deskRelaySendTimer = null; }
  if (_deskRelayRecvTimer) { clearInterval(_deskRelayRecvTimer); _deskRelayRecvTimer = null; }
  const relayImg = document.getElementById('_deskRelayImg');
  if (relayImg) { relayImg.remove(); }
  _deskStopAudioRelay();
  if (_deskRelayCallId) {
    fetch(`${API_BASE}/calls/video-relay-stop`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ call_id: _deskRelayCallId })
    }).catch(() => {});
  }
  _deskRelayCallId = null;
  _deskRelayRemoteId = null;
}

function _deskStartAudioRelay(callId, myDeviceId, remoteDeviceId) {
  if (_deskAudioCtx) return;
  console.log('[AudioRelay] Starting PCM audio relay');
  _deskAudioLastSeq = -1;
  _deskAudioPcmBuffer = [];

  if (!_localStream || _localStream.getAudioTracks().length === 0) {
    console.warn('[AudioRelay] No local audio stream available');
    return;
  }

  // Capture: use ScriptProcessorNode to get raw PCM
  _deskAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = _deskAudioCtx.createMediaStreamSource(new MediaStream(_localStream.getAudioTracks()));
  // 4096 samples at 16kHz = 256ms chunks
  _deskAudioProcessor = _deskAudioCtx.createScriptProcessor(4096, 1, 1);
  _deskAudioProcessor.onaudioprocess = (e) => {
    if (!_deskRelayMode) return;
    const float32 = e.inputBuffer.getChannelData(0);
    // Convert Float32 to Int16
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    _deskAudioPcmBuffer.push(int16);
  };
  source.connect(_deskAudioProcessor);
  _deskAudioProcessor.connect(_deskAudioCtx.destination); // required for processing
  _deskAudioSource = source;

  // Send accumulated PCM every 250ms
  _deskAudioSendTimer = setInterval(() => {
    if (_deskAudioPcmBuffer.length === 0 || !_deskRelayMode) return;
    const chunks = _deskAudioPcmBuffer.splice(0);
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const merged = new Int16Array(totalLen);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.length; }
    const blob = new Blob([merged.buffer], { type: 'application/octet-stream' });
    const fd = new FormData();
    fd.append('call_id', callId);
    fd.append('device_id', myDeviceId);
    fd.append('chunk', blob, 'a.pcm');
    fetch(`${API_BASE}/calls/audio-chunk`, { method: 'POST', body: fd }).catch(() => {});
  }, 250);

  // Playback context
  _deskAudioPlayCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  _deskAudioNextPlayTime = 0;

  // Receive and play PCM from remote
  _deskAudioRecvTimer = setInterval(async () => {
    if (!_deskRelayMode) return;
    try {
      const res = await fetch(`${API_BASE}/calls/audio-chunk/${callId}/${remoteDeviceId}?after=${_deskAudioLastSeq}&_=${Date.now()}`);
      const data = await res.json();
      if (data.chunks && data.chunks.length > 0) {
        for (const chunk of data.chunks) {
          if (chunk.seq > _deskAudioLastSeq) {
            _deskAudioLastSeq = chunk.seq;
            const binary = atob(chunk.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            // Convert Int16 PCM back to Float32
            const int16 = new Int16Array(bytes.buffer);
            const numSamples = int16.length;
            const audioBuffer = _deskAudioPlayCtx.createBuffer(1, numSamples, 16000);
            const channelData = audioBuffer.getChannelData(0);
            for (let i = 0; i < numSamples; i++) {
              channelData[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
            }
            const bufferSource = _deskAudioPlayCtx.createBufferSource();
            bufferSource.buffer = audioBuffer;
            bufferSource.connect(_deskAudioPlayCtx.destination);
            // Schedule playback to avoid gaps
            const now = _deskAudioPlayCtx.currentTime;
            if (_deskAudioNextPlayTime < now) _deskAudioNextPlayTime = now;
            bufferSource.start(_deskAudioNextPlayTime);
            _deskAudioNextPlayTime += audioBuffer.duration;
          }
        }
      }
    } catch(e) {}
  }, 200);
}

function _deskStopAudioRelay() {
  if (_deskAudioProcessor) {
    try { _deskAudioProcessor.disconnect(); } catch(e) {}
    _deskAudioProcessor = null;
  }
  if (_deskAudioSource) {
    try { _deskAudioSource.disconnect(); } catch(e) {}
    _deskAudioSource = null;
  }
  if (_deskAudioCtx) {
    try { _deskAudioCtx.close(); } catch(e) {}
    _deskAudioCtx = null;
  }
  if (_deskAudioPlayCtx) {
    try { _deskAudioPlayCtx.close(); } catch(e) {}
    _deskAudioPlayCtx = null;
  }
  if (_deskAudioSendTimer) { clearInterval(_deskAudioSendTimer); _deskAudioSendTimer = null; }
  if (_deskAudioRecvTimer) { clearInterval(_deskAudioRecvTimer); _deskAudioRecvTimer = null; }
  _deskAudioLastSeq = -1;
  _deskAudioPcmBuffer = [];
  _deskAudioNextPlayTime = 0;
}

async function loadCallsPage() {
  await loadCallDevices();
  await loadCallHistory();
  pollIncomingCalls();
}

async function loadCallDevices() {
  try {
    const res = await fetch(`${API_BASE}/p2p/devices`);
    const data = await res.json();
    const devs = Array.isArray(data) ? data : (data.devices || []);
    const list = document.getElementById('callDeviceList');
    const otherDevices = devs.filter(d => (d.id || d.device_id) !== desktopDeviceId);
    if (otherDevices.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fas fa-wifi"></i><p>No devices online</p></div>';
      return;
    }
    list.innerHTML = otherDevices.map(d => {
      const id = d.id || d.device_id;
      const name = d.name || 'Unknown';
      const icon = (d.user_agent || '').toLowerCase().includes('mobile') ? 'fa-mobile-alt' : 'fa-desktop';
      return `<div class="call-device-item">
        <div class="call-device-info">
          <i class="fas ${icon}"></i>
          <span>${escapeHtml(name)} ${vBadge(id)}</span>
          <span class="device-status"><span class="device-dot"></span>Online</span>
        </div>
        <div class="call-device-actions">
          <button class="btn btn-sm btn-call-audio" onclick="startCall('${id}','${escapeHtml(name)}','audio')" title="Audio call">
            <i class="fas fa-phone-alt"></i>
          </button>
          <button class="btn btn-sm btn-call-video" onclick="startCall('${id}','${escapeHtml(name)}','video')" title="Video call">
            <i class="fas fa-video"></i>
          </button>
        </div>
      </div>`;
    }).join('');
  } catch(e) { console.error('loadCallDevices', e); }
}

let _callFromChat = false;
let _videoSwapped = false;
let _currentCallType = 'audio';

function startCallFromChat(callType) {
  if (!_deskChatCurrentConversation) {
    showNotification('No chat conversation open', 'error');
    return;
  }
  _callFromChat = true;
  const name = document.getElementById('desktopChatUserName').textContent || 'User';
  startCallFromChatInline(_deskChatCurrentConversation, name, callType);
}

async function startCallFromChatInline(targetId, targetName, callType) {
  try {
    const res = await fetch(`${API_BASE}/calls/initiate`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        initiator_id: desktopDeviceId,
        initiator_name: desktopDeviceName,
        target_ids: [targetId],
        call_type: callType
      })
    });
    const data = await res.json();
    if (data.call_id) {
      _currentCallId = data.call_id;
      _callTargetDeviceId = targetId;
      _callIsInitiator = true;
      showNotification(`Calling ${targetName}...`, 'info');
      launchWebRTCInChat(data.call_id, callType, targetName, targetId, true);
    } else {
      showNotification(data.error || 'Failed to start call', 'error');
      _callFromChat = false;
    }
  } catch(e) {
    console.error('startCallFromChatInline', e);
    showNotification('Failed to start call', 'error');
    _callFromChat = false;
  }
}

async function launchWebRTCInChat(callId, callType, displayName, remoteDeviceId, isInitiator) {
  _videoSwapped = false;
  _currentCallType = callType;
  const overlay = document.getElementById('chatCallOverlay');
  overlay.style.display = 'flex';
  document.getElementById('chatCallOverlayName').textContent = displayName || 'Calling...';

  const localVideo = document.getElementById('chatLocalVideo');
  const remoteVideo = document.getElementById('chatRemoteVideo');
  const callAvatar = document.getElementById('chatCallAvatarSection');
  const swapBtn = document.getElementById('chatBtnSwapVideo');

  if (callType === 'video') {
    localVideo.style.display = 'block';
    remoteVideo.style.display = 'block';
    if (callAvatar) callAvatar.style.display = 'none';
    if (swapBtn) swapBtn.style.display = '';
  } else {
    localVideo.style.display = 'none';
    remoteVideo.style.display = 'none';
    if (callAvatar) callAvatar.style.display = 'flex';
    document.getElementById('chatCallAvatarName').textContent = displayName || 'Audio Call';
    if (swapBtn) swapBtn.style.display = 'none';
  }

  // Update switch media buttons
  updateSwitchMediaButtons(callType);

  // Timer
  _callTimerSeconds = 0;
  if (_callTimerInterval) clearInterval(_callTimerInterval);
  _callTimerInterval = setInterval(() => {
    _callTimerSeconds++;
    const min = Math.floor(_callTimerSeconds / 60).toString().padStart(2, '0');
    const sec = (_callTimerSeconds % 60).toString().padStart(2, '0');
    document.getElementById('chatCallOverlayTimer').textContent = `${min}:${sec}`;
  }, 1000);

  // Get media
  try {
    _localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' });
    if (localVideo) localVideo.srcObject = _localStream;
  } catch(e) {
    console.error('getUserMedia failed:', e);
    showNotification('Could not access microphone/camera', 'error');
    endCurrentCall();
    return;
  }

  // Create RTCPeerConnection
  _peerConnection = new RTCPeerConnection(_rtcConfig);
  _localStream.getTracks().forEach(track => _peerConnection.addTrack(track, _localStream));

  _peerConnection.ontrack = (event) => {
    console.log('[WebRTC-Chat] Remote track:', event.track.kind, 'readyState:', event.track.readyState);
    const stream = event.streams[0] || new MediaStream([event.track]);
    // Set remote video on both possible video elements (call tab + chat inline)
    ['chatRemoteVideo', 'remoteVideo'].forEach(id => {
      const v = document.getElementById(id);
      if (v) {
        v.srcObject = stream;
        if (_currentCallType === 'video' || event.track.kind === 'video') v.style.display = 'block';
        v.play().catch(() => {});
      }
    });
    // Set remote audio on all audio elements
    ['chatRemoteAudio', 'remoteAudio'].forEach(id => {
      const a = document.getElementById(id);
      if (a) {
        a.srcObject = stream;
        a.play().catch(() => {});
      }
    });
    _ensureRemoteAudio(stream);
    event.track.onunmute = () => {
      console.log('[WebRTC-Chat] Track unmuted:', event.track.kind);
      if (event.track.kind === 'video') {
        ['chatRemoteVideo', 'remoteVideo'].forEach(id => {
          const v = document.getElementById(id);
          if (v && v.srcObject) { v.style.display = 'block'; v.play().catch(() => {}); }
        });
      }
      _deskForceAudioPlay();
    };
  };

  _peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[WebRTC-Chat] Local ICE candidate:', event.candidate.type, event.candidate.protocol, event.candidate.address || '(mdns)');
      fetch(`${API_BASE}/calls/signal`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          from_id: desktopDeviceId, to_id: remoteDeviceId,
          signal_type: 'ice-candidate', call_id: callId,
          payload: event.candidate.toJSON()
        })
      }).catch(e => console.error('ICE signal error:', e));
    } else {
      console.log('[WebRTC-Chat] ICE candidate gathering complete');
    }
  };

  _peerConnection.onicegatheringstatechange = () => {
    if (_peerConnection) console.log('[WebRTC-Chat] ICE gathering state:', _peerConnection.iceGatheringState);
  };

  _peerConnection.oniceconnectionstatechange = () => {
    if (!_peerConnection) return;
    const state = _peerConnection.iceConnectionState;
    console.log('[WebRTC-Chat] ICE connection state:', state);
    if (state === 'connected' || state === 'completed') {
      if (_deskIceTimeout) { clearTimeout(_deskIceTimeout); _deskIceTimeout = null; }
      _deskForceAudioPlay();
      if (_deskRelayMode) _deskStopVideoRelay();
    } else if (state === 'failed') {
      console.log('[WebRTC-Chat] ICE failed — starting video relay fallback');
      if (_currentCallType === 'video' && !_deskRelayMode) {
        _deskStartVideoRelay(callId, desktopDeviceId, remoteDeviceId);
      }
      try { _peerConnection.restartIce(); } catch(e) {
        showNotification('Call connection failed — using relay', 'info');
      }
    } else if (state === 'disconnected') {
      setTimeout(() => {
        if (_peerConnection && _peerConnection.iceConnectionState === 'disconnected') {
          if (_currentCallType === 'video' && !_deskRelayMode) {
            _deskStartVideoRelay(callId, desktopDeviceId, remoteDeviceId);
          }
        }
      }, 3000);
    }
  };

  if (isInitiator) {
    try {
      const offer = await _peerConnection.createOffer();
      await _peerConnection.setLocalDescription(offer);
      await fetch(`${API_BASE}/calls/signal`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          from_id: desktopDeviceId, to_id: remoteDeviceId,
          signal_type: 'offer', call_id: callId,
          payload: { type: offer.type, sdp: offer.sdp }
        })
      });
    } catch(e) {
      console.error('Failed to create/send offer:', e);
      showNotification('Failed to start call', 'error');
      endCurrentCall();
      return;
    }
  }

  // Reset ICE buffer state for this call
  _deskPendingIceCandidates = [];
  _deskRemoteDescSet = false;
  startSignalPolling(callId, remoteDeviceId);

  // Connection timeout — start relay if ICE doesn't connect in 8s, end only after 45s
  if (_deskIceTimeout) clearTimeout(_deskIceTimeout);
  setTimeout(() => {
    if (_peerConnection && _peerConnection.iceConnectionState !== 'connected' && _peerConnection.iceConnectionState !== 'completed') {
      console.log('[WebRTC-Chat] 8s timeout — starting video relay fallback');
      if (_currentCallType === 'video' && !_deskRelayMode) {
        _deskStartVideoRelay(callId, desktopDeviceId, remoteDeviceId);
      }
    }
  }, 8000);
  _deskIceTimeout = setTimeout(() => {
    if (_peerConnection && _peerConnection.iceConnectionState !== 'connected' && _peerConnection.iceConnectionState !== 'completed') {
      if (!_deskRelayMode) {
        showNotification('Call could not connect', 'error');
        endCurrentCall();
      }
    }
  }, 45000);
}

function swapVideos(platform) {
  _videoSwapped = !_videoSwapped;
  if (platform === 'desktop') {
    // Swap both main call page and chat overlay
    ['', 'chat'].forEach(prefix => {
      const remoteId = prefix ? prefix + 'RemoteVideo' : 'remoteVideo';
      const localId = prefix ? prefix + 'LocalVideo' : 'localVideo';
      const remote = document.getElementById(remoteId);
      const local = document.getElementById(localId);
      if (remote && local) {
        if (_videoSwapped) {
          remote.classList.add('call-local-video');
          remote.classList.remove('call-remote-video');
          local.classList.add('call-remote-video');
          local.classList.remove('call-local-video');
        } else {
          remote.classList.remove('call-local-video');
          remote.classList.add('call-remote-video');
          local.classList.remove('call-remote-video');
          local.classList.add('call-local-video');
        }
      }
    });
  } else {
    ['mob', 'mobChat'].forEach(prefix => {
      const remoteId = prefix + 'RemoteVideo';
      const localId = prefix + 'LocalVideo';
      const remote = document.getElementById(remoteId);
      const local = document.getElementById(localId);
      if (remote && local) {
        if (_videoSwapped) {
          remote.classList.add('mob-call-local-video');
          remote.classList.remove('mob-call-remote-video');
          local.classList.add('mob-call-remote-video');
          local.classList.remove('mob-call-local-video');
        } else {
          remote.classList.remove('mob-call-local-video');
          remote.classList.add('mob-call-remote-video');
          local.classList.remove('mob-call-remote-video');
          local.classList.add('mob-call-local-video');
        }
      }
    });
  }
}

async function startCall(targetId, targetName, callType) {
  _callFromChat = false;
  try {
    const res = await fetch(`${API_BASE}/calls/initiate`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        initiator_id: desktopDeviceId,
        initiator_name: desktopDeviceName,
        target_ids: [targetId],
        call_type: callType
      })
    });
    const data = await res.json();
    if (data.call_id) {
      _currentCallId = data.call_id;
      _callTargetDeviceId = targetId;
      _callIsInitiator = true;
      showNotification(`Calling ${targetName}...`, 'info');
      launchWebRTC(data.call_id, callType, targetName, targetId, true);
    } else {
      showNotification(data.error || 'Failed to start call', 'error');
    }
  } catch(e) {
    console.error('startCall', e);
    showNotification('Failed to start call', 'error');
  }
}

async function launchWebRTC(callId, callType, displayName, remoteDeviceId, isInitiator) {
  _videoSwapped = false;
  _currentCallType = callType;
  const container = document.getElementById('callMediaContainer');
  const activeContainer = document.getElementById('callActiveContainer');
  const startSection = document.getElementById('callStartSection');
  const swapBtn = document.getElementById('btnSwapVideo');

  activeContainer.style.display = 'block';
  if (startSection) startSection.style.display = 'none';
  document.getElementById('callActiveName').textContent = displayName || 'Call in progress';

  // Show/hide video elements based on call type
  const localVideo = document.getElementById('localVideo');
  const remoteVideo = document.getElementById('remoteVideo');
  const callAvatar = document.getElementById('callAvatarSection');
  if (callType === 'video') {
    localVideo.style.display = 'block';
    remoteVideo.style.display = 'block';
    if (callAvatar) callAvatar.style.display = 'none';
    if (swapBtn) swapBtn.style.display = '';
  } else {
    localVideo.style.display = 'none';
    remoteVideo.style.display = 'none';
    if (callAvatar) callAvatar.style.display = 'flex';
    document.getElementById('callAvatarName').textContent = displayName || 'Audio Call';
    if (swapBtn) swapBtn.style.display = 'none';
  }

  // Update switch media buttons
  updateSwitchMediaButtons(callType);

  // Start call timer
  _callTimerSeconds = 0;
  if (_callTimerInterval) clearInterval(_callTimerInterval);
  _callTimerInterval = setInterval(() => {
    _callTimerSeconds++;
    const min = Math.floor(_callTimerSeconds / 60).toString().padStart(2, '0');
    const sec = (_callTimerSeconds % 60).toString().padStart(2, '0');
    document.getElementById('callActiveTimer').textContent = `${min}:${sec}`;
  }, 1000);

  // Get media
  try {
    _localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video'
    });
    if (localVideo) localVideo.srcObject = _localStream;
  } catch(e) {
    console.error('getUserMedia failed:', e);
    showNotification('Could not access microphone/camera', 'error');
    endCurrentCall();
    return;
  }

  // Create RTCPeerConnection
  _peerConnection = new RTCPeerConnection(_rtcConfig);

  // Add local tracks
  _localStream.getTracks().forEach(track => {
    _peerConnection.addTrack(track, _localStream);
  });

  // Handle remote stream
  _peerConnection.ontrack = (event) => {
    console.log('[WebRTC] Remote track:', event.track.kind, 'readyState:', event.track.readyState);
    const stream = event.streams[0] || new MediaStream([event.track]);
    // Set remote video on both possible video elements (call tab + chat inline)
    ['remoteVideo', 'chatRemoteVideo'].forEach(id => {
      const v = document.getElementById(id);
      if (v) {
        v.srcObject = stream;
        if (_currentCallType === 'video' || event.track.kind === 'video') v.style.display = 'block';
        v.play().catch(() => {});
      }
    });
    // Set remote audio on all audio elements
    ['remoteAudio', 'chatRemoteAudio'].forEach(id => {
      const a = document.getElementById(id);
      if (a) {
        a.srcObject = stream;
        a.play().catch(() => {});
      }
    });
    _ensureRemoteAudio(stream);
    event.track.onunmute = () => {
      console.log('[WebRTC] Track unmuted:', event.track.kind);
      if (event.track.kind === 'video') {
        ['remoteVideo', 'chatRemoteVideo'].forEach(id => {
          const v = document.getElementById(id);
          if (v && v.srcObject) { v.style.display = 'block'; v.play().catch(() => {}); }
        });
      }
      _deskForceAudioPlay();
    };
  };

  // Handle ICE candidates — send to remote peer
  _peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[WebRTC] Local ICE candidate:', event.candidate.type, event.candidate.protocol, event.candidate.address || '(mdns)');
      fetch(`${API_BASE}/calls/signal`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          from_id: desktopDeviceId,
          to_id: remoteDeviceId,
          signal_type: 'ice-candidate',
          call_id: callId,
          payload: event.candidate.toJSON()
        })
      }).catch(e => console.error('ICE signal error:', e));
    } else {
      console.log('[WebRTC] ICE candidate gathering complete');
    }
  };

  _peerConnection.onicegatheringstatechange = () => {
    if (_peerConnection) console.log('[WebRTC] ICE gathering state:', _peerConnection.iceGatheringState);
  };

  _peerConnection.oniceconnectionstatechange = () => {
    if (!_peerConnection) return;
    const state = _peerConnection.iceConnectionState;
    console.log('[WebRTC] ICE connection state:', state);
    if (state === 'connected' || state === 'completed') {
      if (_deskIceTimeout) { clearTimeout(_deskIceTimeout); _deskIceTimeout = null; }
      _deskForceAudioPlay();
      // Stop video relay if it was running (peer-to-peer connected!)
      if (_deskRelayMode) _deskStopVideoRelay();
    } else if (state === 'failed') {
      console.log('[WebRTC] ICE failed — starting video relay fallback');
      if (_currentCallType === 'video' && !_deskRelayMode) {
        _deskStartVideoRelay(callId, desktopDeviceId, remoteDeviceId);
      }
      try { _peerConnection.restartIce(); } catch(e) {
        showNotification('Call connection failed — using relay', 'info');
      }
    } else if (state === 'disconnected') {
      setTimeout(() => {
        if (_peerConnection && _peerConnection.iceConnectionState === 'disconnected') {
          // Also start relay fallback if disconnected
          if (_currentCallType === 'video' && !_deskRelayMode) {
            _deskStartVideoRelay(callId, desktopDeviceId, remoteDeviceId);
          }
        }
      }, 3000);
    }
  };

  // If initiator, create and send offer
  if (isInitiator) {
    try {
      const offer = await _peerConnection.createOffer();
      await _peerConnection.setLocalDescription(offer);
      await fetch(`${API_BASE}/calls/signal`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          from_id: desktopDeviceId,
          to_id: remoteDeviceId,
          signal_type: 'offer',
          call_id: callId,
          payload: { type: offer.type, sdp: offer.sdp }
        })
      });
      console.log('[WebRTC] Offer sent');
    } catch(e) {
      console.error('Failed to create/send offer:', e);
      showNotification('Failed to start call', 'error');
      endCurrentCall();
      return;
    }
  }

  // Reset ICE buffer state for this call
  _deskPendingIceCandidates = [];
  _deskRemoteDescSet = false;
  // Start polling for WebRTC signals
  startSignalPolling(callId, remoteDeviceId);

  // Connection timeout — start relay if ICE doesn't connect in 8s, end only after 45s
  if (_deskIceTimeout) clearTimeout(_deskIceTimeout);
  // Video relay fallback after 8 seconds of no connection
  setTimeout(() => {
    if (_peerConnection && _peerConnection.iceConnectionState !== 'connected' && _peerConnection.iceConnectionState !== 'completed') {
      console.log('[WebRTC] 8s timeout — starting video relay fallback');
      if (_currentCallType === 'video' && !_deskRelayMode) {
        _deskStartVideoRelay(callId, desktopDeviceId, remoteDeviceId);
      }
    }
  }, 8000);
  // Hard timeout after 45s
  _deskIceTimeout = setTimeout(() => {
    if (_peerConnection && _peerConnection.iceConnectionState !== 'connected' && _peerConnection.iceConnectionState !== 'completed') {
      if (!_deskRelayMode) {
        showNotification('Call could not connect', 'error');
        endCurrentCall();
      }
    }
  }, 45000);
}

/** Flush buffered ICE candidates after remote description is set */
async function _deskFlushIceCandidates() {
  if (!_peerConnection) return;
  const pending = _deskPendingIceCandidates.splice(0);
  console.log('[WebRTC] Flushing', pending.length, 'buffered ICE candidates');
  for (const c of pending) {
    try { await _peerConnection.addIceCandidate(new RTCIceCandidate(c)); }
    catch(e) { console.warn('[WebRTC] Buffered ICE error:', e); }
  }
}

function startSignalPolling(callId, remoteDeviceId) {
  if (_signalPollInterval) clearInterval(_signalPollInterval);
  const _pollSignals = async () => {
    if (!_peerConnection || !_currentCallId) { clearInterval(_signalPollInterval); return; }
    try {
      const res = await fetch(`${API_BASE}/calls/signals/${desktopDeviceId}`);
      const data = await res.json();
      for (const signal of (data.signals || [])) {
        if (signal.call_id !== callId) continue;
        if (signal.type === 'offer' && _peerConnection.signalingState !== 'stable') continue;
        if (signal.type === 'offer') {
          await _peerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
          _deskRemoteDescSet = true;
          await _deskFlushIceCandidates();
          const answer = await _peerConnection.createAnswer();
          await _peerConnection.setLocalDescription(answer);
          await fetch(`${API_BASE}/calls/signal`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              from_id: desktopDeviceId,
              to_id: remoteDeviceId,
              signal_type: 'answer',
              call_id: callId,
              payload: { type: answer.type, sdp: answer.sdp }
            })
          });
          console.log('[WebRTC] Answer sent');
        } else if (signal.type === 'answer') {
          if (_peerConnection.signalingState === 'have-local-offer') {
            await _peerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
            _deskRemoteDescSet = true;
            await _deskFlushIceCandidates();
            console.log('[WebRTC] Answer received + flushed ICE');
          }
        } else if (signal.type === 'ice-candidate') {
          const c = signal.payload;
          console.log('[WebRTC] Remote ICE candidate received:', c.candidate ? c.candidate.split(' ').slice(4,8).join(' ') : '(null)');
          if (_deskRemoteDescSet && _peerConnection.remoteDescription) {
            try { await _peerConnection.addIceCandidate(new RTCIceCandidate(c)); }
            catch(e) { console.warn('[WebRTC] ICE add error:', e); }
          } else {
            _deskPendingIceCandidates.push(c);
            console.log('[WebRTC] Buffered ICE candidate (no remote desc yet), total:', _deskPendingIceCandidates.length);
          }
        } else if (signal.type === 'media-switch') {
          console.log('[WebRTC] Remote side switched to:', signal.payload.callType);
          _currentCallType = signal.payload.callType;
          _applyMediaSwitchUI(signal.payload.callType);
          updateSwitchMediaButtons(signal.payload.callType);
          showNotification(`Call switched to ${signal.payload.callType}`, 'info');
        } else if (signal.type === 'screen-share') {
          console.log('[WebRTC] Remote screen share:', signal.payload.active);
          if (signal.payload.active) {
            // Make remote video visible if this was an audio call
            const rv = document.getElementById(_callFromChat ? 'chatRemoteVideo' : 'remoteVideo');
            if (rv) rv.style.display = 'block';
            const avatar = document.getElementById(_callFromChat ? 'chatCallAvatarSection' : 'callAvatarSection');
            if (avatar) avatar.style.display = 'none';
            showNotification('Remote is sharing their screen', 'info');
          } else {
            if (_currentCallType === 'audio') {
              const rv = document.getElementById(_callFromChat ? 'chatRemoteVideo' : 'remoteVideo');
              if (rv) rv.style.display = 'none';
              const avatar = document.getElementById(_callFromChat ? 'chatCallAvatarSection' : 'callAvatarSection');
              if (avatar) avatar.style.display = 'flex';
            }
            showNotification('Remote stopped screen sharing', 'info');
          }
        } else if (signal.type === 'call-accepted') {
          console.log('[WebRTC] Call accepted by remote');
        } else if (signal.type === 'call-end') {
          console.log('[WebRTC] Remote side ended the call');
          showNotification('Call ended by other party', 'info');
          _currentCallId = null; // prevent sending end again
          endCurrentCall();
          return;
        }
      }
    } catch(e) { console.error('Signal poll error:', e); }
  };
  // Immediate first poll (don't wait 400ms) + fast polling
  _pollSignals();
  _signalPollInterval = setInterval(_pollSignals, 400);
}

function toggleMute() {
  if (!_localStream) return;
  const audioTrack = _localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    const icon = audioTrack.enabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
    const isOff = !audioTrack.enabled;
    // Update all mute buttons (main call page + chat overlay + PiP)
    ['btnToggleMute', 'chatBtnToggleMute', 'pipBtnMute'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) { btn.innerHTML = icon; btn.classList.toggle('active', isOff); }
    });
  }
}

function toggleCamera() {
  if (!_localStream) return;
  const videoTrack = _localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    const icon = videoTrack.enabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
    const isOff = !videoTrack.enabled;
    ['btnToggleCamera', 'chatBtnToggleCamera', 'pipBtnCamera'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) { btn.innerHTML = icon; btn.classList.toggle('active', isOff); }
    });
  }
}

function updateSwitchMediaButtons(callType) {
  const isVideo = callType === 'video';
  const icon = isVideo ? '<i class="fas fa-phone-alt"></i>' : '<i class="fas fa-video"></i>';
  const title = isVideo ? 'Switch to Audio' : 'Switch to Video';
  ['btnSwitchMedia', 'chatBtnSwitchMedia'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) { btn.innerHTML = icon; btn.title = title; }
  });
}

async function switchCallMedia() {
  if (!_peerConnection || !_localStream || !_currentCallId) return;
  const newType = _currentCallType === 'audio' ? 'video' : 'audio';

  try {
    if (newType === 'video') {
      // Switching from audio to video: get video track and add it
      const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const videoTrack = videoStream.getVideoTracks()[0];
      _localStream.addTrack(videoTrack);
      _peerConnection.addTrack(videoTrack, _localStream);
    } else {
      // Switching from video to audio: remove video track
      const videoTrack = _localStream.getVideoTracks()[0];
      if (videoTrack) {
        const sender = _peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) _peerConnection.removeTrack(sender);
        videoTrack.stop();
        _localStream.removeTrack(videoTrack);
      }
    }

    // Renegotiate
    const offer = await _peerConnection.createOffer();
    await _peerConnection.setLocalDescription(offer);
    await fetch(`${API_BASE}/calls/signal`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        from_id: desktopDeviceId,
        to_id: _callTargetDeviceId,
        signal_type: 'offer',
        call_id: _currentCallId,
        payload: { type: offer.type, sdp: offer.sdp }
      })
    });

    // Send media-switch signal so remote updates their UI
    await fetch(`${API_BASE}/calls/signal`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        from_id: desktopDeviceId,
        to_id: _callTargetDeviceId,
        signal_type: 'media-switch',
        call_id: _currentCallId,
        payload: { callType: newType }
      })
    });

    // Update local UI
    _currentCallType = newType;
    _applyMediaSwitchUI(newType);
    updateSwitchMediaButtons(newType);
    showNotification(`Switched to ${newType} call`, 'info');
  } catch(e) {
    console.error('switchCallMedia error:', e);
    showNotification('Failed to switch media', 'error');
  }
}

function _applyMediaSwitchUI(callType) {
  const isVideo = callType === 'video';
  // Update both main call page and chat overlay
  const videoIds = _callFromChat
    ? [['chatLocalVideo', 'chatRemoteVideo', 'chatCallAvatarSection', 'chatBtnSwapVideo']]
    : [['localVideo', 'remoteVideo', 'callAvatarSection', 'btnSwapVideo']];
  // Always update both sets
  [['localVideo', 'remoteVideo', 'callAvatarSection', 'btnSwapVideo'],
   ['chatLocalVideo', 'chatRemoteVideo', 'chatCallAvatarSection', 'chatBtnSwapVideo']].forEach(ids => {
    const [localId, remoteId, avatarId, swapId] = ids;
    const localV = document.getElementById(localId);
    const remoteV = document.getElementById(remoteId);
    const avatar = document.getElementById(avatarId);
    const swapB = document.getElementById(swapId);
    if (localV) {
      localV.style.display = isVideo ? 'block' : 'none';
      if (isVideo) localV.srcObject = _localStream;
    }
    if (remoteV) remoteV.style.display = isVideo ? 'block' : 'none';
    if (avatar) avatar.style.display = isVideo ? 'none' : 'flex';
    if (swapB) swapB.style.display = isVideo ? '' : 'none';
  });
}

/* ═══════════════════════════════════════════════════════════════
   PiP (Picture-in-Picture) Floating Window
   ═════════════════════════════════════════════════════════════ */
let _pipActive = false;
let _pipDragState = null;

function enterPiP() {
  if (!_currentCallId || _pipActive) return;
  _pipActive = true;

  const pipWin = document.getElementById('pipWindow');
  const pipRemote = document.getElementById('pipRemoteVideo');
  const pipLocal = document.getElementById('pipLocalVideo');
  const pipAvatar = document.getElementById('pipAvatar');
  const pipTitle = document.getElementById('pipTitle');

  // Copy streams to PiP
  const srcRemote = document.getElementById(_callFromChat ? 'chatRemoteVideo' : 'remoteVideo');
  const srcLocal = document.getElementById(_callFromChat ? 'chatLocalVideo' : 'localVideo');
  if (srcRemote && srcRemote.srcObject) pipRemote.srcObject = srcRemote.srcObject;
  if (srcLocal && srcLocal.srcObject) pipLocal.srcObject = srcLocal.srcObject;

  // Show avatar or video based on call type
  const isVideo = _currentCallType === 'video';
  pipRemote.style.display = isVideo ? 'block' : 'none';
  pipLocal.style.display = isVideo ? 'block' : 'none';
  pipAvatar.style.display = isVideo ? 'none' : 'flex';
  pipTitle.textContent = _callFromChat ? 'In-call' : 'Call';

  // Sync mute/camera button states
  _syncPipButtons();

  // Hide the main call UI but keep the call alive
  if (_callFromChat) {
    const overlay = document.getElementById('chatCallOverlay');
    if (overlay) overlay.style.display = 'none';
  } else {
    document.getElementById('callActiveContainer').style.display = 'none';
    const startSection = document.getElementById('callStartSection');
    if (startSection) startSection.style.display = '';
  }

  // Show PiP window
  pipWin.style.display = 'block';
  // Position at bottom-right
  pipWin.style.right = '24px';
  pipWin.style.bottom = '24px';
  pipWin.style.left = 'auto';
  pipWin.style.top = 'auto';

  _initPipDrag();
}

function exitPiP() {
  if (!_pipActive) return;
  _pipActive = false;

  const pipWin = document.getElementById('pipWindow');
  pipWin.style.display = 'none';
  // Clear PiP video
  document.getElementById('pipRemoteVideo').srcObject = null;
  document.getElementById('pipLocalVideo').srcObject = null;

  if (!_currentCallId) return; // Call already ended

  // Restore main call UI
  if (_callFromChat) {
    const overlay = document.getElementById('chatCallOverlay');
    if (overlay) {
      overlay.style.display = 'flex';
      const remoteV = document.getElementById('chatRemoteVideo');
      const localV = document.getElementById('chatLocalVideo');
      if (_peerConnection) {
        _peerConnection.getReceivers().forEach(r => {
          if (r.track && r.track.kind === 'video' && remoteV) remoteV.srcObject = new MediaStream([r.track]);
        });
      }
      if (_localStream && localV) localV.srcObject = _localStream;
      _applyMediaSwitchUI(_currentCallType);
    }
    navigateTo('chat');
  } else {
    navigateTo('calls');
    document.getElementById('callActiveContainer').style.display = 'flex';
    const startSection = document.getElementById('callStartSection');
    if (startSection) startSection.style.display = 'none';
    const remoteV = document.getElementById('remoteVideo');
    const localV = document.getElementById('localVideo');
    if (_peerConnection) {
      _peerConnection.getReceivers().forEach(r => {
        if (r.track && r.track.kind === 'video' && remoteV) remoteV.srcObject = new MediaStream([r.track]);
      });
    }
    if (_localStream && localV) localV.srcObject = _localStream;
    _applyMediaSwitchUI(_currentCallType);
  }
}

function _syncPipButtons() {
  if (!_localStream) return;
  const audioTrack = _localStream.getAudioTracks()[0];
  const videoTrack = _localStream.getVideoTracks()[0];
  const muteBtn = document.getElementById('pipBtnMute');
  const camBtn = document.getElementById('pipBtnCamera');
  if (muteBtn) {
    const muted = audioTrack ? !audioTrack.enabled : true;
    muteBtn.innerHTML = muted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
    muteBtn.classList.toggle('active', muted);
  }
  if (camBtn) {
    const camOff = videoTrack ? !videoTrack.enabled : true;
    camBtn.innerHTML = camOff ? '<i class="fas fa-video-slash"></i>' : '<i class="fas fa-video"></i>';
    camBtn.classList.toggle('active', camOff);
  }
}

function hidePiP() {
  _pipActive = false;
  const pipWin = document.getElementById('pipWindow');
  if (pipWin) pipWin.style.display = 'none';
  document.getElementById('pipRemoteVideo').srcObject = null;
  document.getElementById('pipLocalVideo').srcObject = null;
}

function _initPipDrag() {
  const pipWin = document.getElementById('pipWindow');
  const handle = document.getElementById('pipDragHandle');
  let startX, startY, startLeft, startTop;

  function onDown(e) {
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = pipWin.getBoundingClientRect();
    startX = clientX; startY = clientY;
    startLeft = rect.left; startTop = rect.top;
    pipWin.classList.add('pip-dragging');
    pipWin.classList.remove('pip-snapping');
    // Convert to top/left positioning
    pipWin.style.left = rect.left + 'px';
    pipWin.style.top = rect.top + 'px';
    pipWin.style.right = 'auto';
    pipWin.style.bottom = 'auto';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  }

  function onMove(e) {
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - startX;
    const dy = clientY - startY;
    pipWin.style.left = (startLeft + dx) + 'px';
    pipWin.style.top = (startTop + dy) + 'px';
  }

  function onUp() {
    pipWin.classList.remove('pip-dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
    _snapPipToEdge(pipWin);
  }

  handle.addEventListener('mousedown', onDown);
  handle.addEventListener('touchstart', onDown, { passive: false });
}

function _snapPipToEdge(el) {
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 16;

  el.classList.add('pip-snapping');

  // Snap to nearest horizontal edge
  let newLeft;
  if (rect.left + rect.width / 2 < vw / 2) {
    newLeft = margin;
  } else {
    newLeft = vw - rect.width - margin;
  }

  // Clamp vertically
  let newTop = Math.max(margin, Math.min(vh - rect.height - margin, rect.top));

  el.style.left = newLeft + 'px';
  el.style.top = newTop + 'px';
  el.style.right = 'auto';
  el.style.bottom = 'auto';

  setTimeout(() => el.classList.remove('pip-snapping'), 350);
}

/* ═══════════════════════════════════════════════════════════════
   Screen Sharing
   ═════════════════════════════════════════════════════════════ */
let _screenShareStream = null;
let _screenShareActive = false;
let _originalVideoTrack = null;

async function toggleScreenShare() {
  if (_screenShareActive) {
    stopScreenShare();
  } else {
    await startScreenShare();
  }
}

async function startScreenShare() {
  if (!_peerConnection || !_currentCallId) {
    showNotification('No active call', 'error');
    return;
  }

  try {
    _screenShareStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });

    const screenTrack = _screenShareStream.getVideoTracks()[0];
    if (!screenTrack) { showNotification('No screen track', 'error'); return; }

    // Save original camera track
    const videoSender = _peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
    if (videoSender) {
      _originalVideoTrack = videoSender.track;
      await videoSender.replaceTrack(screenTrack);
    } else {
      // No video sender yet (audio call) — add the screen track
      _originalVideoTrack = null;
      _peerConnection.addTrack(screenTrack, _screenShareStream);
    }

    // Show screen share locally
    const localIds = _callFromChat ? ['chatLocalVideo'] : ['localVideo'];
    localIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.srcObject = new MediaStream([screenTrack]); el.style.display = 'block'; }
    });

    _screenShareActive = true;
    _updateScreenShareButtons(true);

    // Signal remote about screen share
    fetch(`${API_BASE}/calls/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: _currentCallId,
        from_id: desktopDeviceId,
        to_id: _callTargetDeviceId,
        signal_type: 'screen-share',
        payload: { active: true }
      })
    }).catch(e => console.error('screen-share signal error:', e));

    // Detect when user stops sharing via browser UI
    screenTrack.onended = () => stopScreenShare();

    showNotification('Screen sharing started', 'info');
  } catch(e) {
    if (e.name === 'NotAllowedError') {
      showNotification('Screen share cancelled', 'info');
    } else {
      console.error('Screen share error:', e);
      showNotification('Failed to share screen', 'error');
    }
  }
}

function stopScreenShare() {
  if (!_screenShareActive) return;

  // Stop screen share tracks
  if (_screenShareStream) {
    _screenShareStream.getTracks().forEach(t => t.stop());
    _screenShareStream = null;
  }

  // Restore original camera track
  if (_peerConnection && _originalVideoTrack) {
    const videoSender = _peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
    if (videoSender) videoSender.replaceTrack(_originalVideoTrack);
  }

  // Restore local video display
  const localIds = _callFromChat ? ['chatLocalVideo'] : ['localVideo'];
  localIds.forEach(id => {
    const el = document.getElementById(id);
    if (el && _localStream) {
      const vt = _localStream.getVideoTracks()[0];
      if (vt) el.srcObject = new MediaStream([vt]);
      else el.style.display = 'none';
    }
  });

  _screenShareActive = false;
  _originalVideoTrack = null;
  _updateScreenShareButtons(false);

  // Signal remote
  if (_currentCallId && _callTargetDeviceId) {
    fetch(`${API_BASE}/calls/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: _currentCallId,
        from_id: desktopDeviceId,
        to_id: _callTargetDeviceId,
        signal_type: 'screen-share',
        payload: { active: false }
      })
    }).catch(e => console.error('screen-share signal error:', e));
  }

  showNotification('Screen sharing stopped', 'info');
}

function _updateScreenShareButtons(active) {
  ['btnScreenShare', 'chatBtnScreenShare'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.classList.toggle('active', active);
      btn.innerHTML = active ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-desktop"></i>';
      btn.title = active ? 'Stop Sharing' : 'Share Screen';
    }
  });
}

function endCurrentCall() {
  // Clear ICE timeout
  if (_deskIceTimeout) { clearTimeout(_deskIceTimeout); _deskIceTimeout = null; }

  // Stop video relay if active
  if (_deskRelayMode) _deskStopVideoRelay();

  // Clean up PiP
  hidePiP();

  // Clean up screen share
  if (_screenShareActive) {
    if (_screenShareStream) { _screenShareStream.getTracks().forEach(t => t.stop()); _screenShareStream = null; }
    _screenShareActive = false;
    _originalVideoTrack = null;
    _updateScreenShareButtons(false);
  }

  if (_currentCallId) {
    fetch(`${API_BASE}/calls/${_currentCallId}/end`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ device_id: desktopDeviceId })
    }).catch(e => console.error('endCall', e));
  }

  if (_signalPollInterval) { clearInterval(_signalPollInterval); _signalPollInterval = null; }
  if (_peerConnection) { _peerConnection.close(); _peerConnection = null; }
  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }
  _cleanupDynAudio();

  _currentCallId = null;
  _callTargetDeviceId = null;
  _callIsInitiator = false;
  _videoSwapped = false;
  _currentCallType = 'audio';
  if (_callTimerInterval) { clearInterval(_callTimerInterval); _callTimerInterval = null; }

  // Hide main call page UI
  document.getElementById('callActiveContainer').style.display = 'none';
  ['localVideo', 'remoteVideo', 'remoteAudio'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.srcObject = null;
  });
  const startSection = document.getElementById('callStartSection');
  if (startSection) startSection.style.display = '';

  // Hide chat overlay UI
  const chatOverlay = document.getElementById('chatCallOverlay');
  if (chatOverlay) chatOverlay.style.display = 'none';
  ['chatLocalVideo', 'chatRemoteVideo', 'chatRemoteAudio'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.srcObject = null;
  });

  // Reset swap classes
  ['remoteVideo', 'chatRemoteVideo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.className = 'call-remote-video'; }
  });
  ['localVideo', 'chatLocalVideo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.className = 'call-local-video'; }
  });

  _callFromChat = false;
  loadCallHistory();
  showNotification('Call ended', 'info');
}

function pollIncomingCalls() {
  if (_callPollInterval) clearInterval(_callPollInterval);
  _callPollInterval = setInterval(async () => {
    if (!desktopDeviceId) return;
    try {
      const res = await fetch(`${API_BASE}/calls/active/${desktopDeviceId}`);
      const data = await res.json();
      const calls = data.calls || [];
      // Find call where we are ringing
      const ringing = calls.find(c => {
        const p = c.participants || {};
        return p[desktopDeviceId] && p[desktopDeviceId].status === 'ringing' && c.initiator_id !== desktopDeviceId;
      });
      if (ringing && !_currentCallId && !_deskGrpCallId) {
        // If delegation is enabled, auto-answer with AI bot
        if (!_deskBotCallActive) {
          try {
            const dRes = await fetch(`${API_BASE}/ai/delegation?owner_id=${desktopDeviceId}`);
            const dData = await dRes.json();
            if (dData.delegation && dData.delegation.enabled) {
              deskBotAnswerCall(ringing);
              return;
            }
          } catch(e) {}
        }
        _incomingCallData = ringing;
        showIncomingCall(ringing);
      } else if (!ringing) {
        hideIncomingCall();
      }
    } catch(e) {}
  }, 3000);
}

function showIncomingCall(call) {
  // In-page banner (Calls page only)
  const banner = document.getElementById('callIncomingBanner');
  if (banner) {
    document.getElementById('callIncomingName').textContent = call.initiator_name || 'Unknown';
    document.getElementById('callIncomingType').textContent = call.type === 'video' ? 'Video' : 'Audio';
    document.getElementById('callIncomingType').className = 'call-type-badge ' + (call.type === 'video' ? 'video' : 'audio');
    banner.style.display = 'flex';
  }
  // Global banner (visible on any page)
  const gb = document.getElementById('globalCallBanner');
  if (gb) {
    document.getElementById('globalCallName').textContent = (call.initiator_name || 'Unknown') + ' is calling...';
    document.getElementById('globalCallType').textContent = call.type === 'video' ? 'Video Call' : 'Audio Call';
    gb.style.display = 'flex';
  }
  // Play notification sound or vibrate effect
  try { new Audio('data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==').play(); } catch(e){}
}

function hideIncomingCall() {
  _incomingCallData = null;
  const banner = document.getElementById('callIncomingBanner');
  if (banner) banner.style.display = 'none';
  const gb = document.getElementById('globalCallBanner');
  if (gb) gb.style.display = 'none';
}

async function answerIncomingCall() {
  if (!_incomingCallData) return;
  const call = _incomingCallData;
  hideIncomingCall();
  try {
    // Group call → use group call join flow
    if (call.group_id) {
      deskJoinGroupCall(call.id, call.type);
      return;
    }
    await fetch(`${API_BASE}/calls/${call.id}/answer`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ device_id: desktopDeviceId })
    });
    _currentCallId = call.id;
    _callTargetDeviceId = call.initiator_id;
    _callIsInitiator = false;
    // Navigate to Calls page to show call
    navigateTo('calls');
    launchWebRTC(call.id, call.type, call.initiator_name, call.initiator_id, false);
  } catch(e) {
    showNotification('Failed to answer call', 'error');
  }
}

async function rejectIncomingCall() {
  if (!_incomingCallData) return;
  try {
    await fetch(`${API_BASE}/calls/${_incomingCallData.id}/reject`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ device_id: desktopDeviceId })
    });
  } catch(e) {}
  hideIncomingCall();
}

// ═══════════════════════════════════════════════════════════════
// AI BOT VOICE CALL ANSWERING (Desktop — Delegation)
// When delegation is enabled, bot auto-answers calls,
// uses SpeechRecognition (STT), DeepSeek AI, and TTS.
// ═══════════════════════════════════════════════════════════════

async function deskBotAnswerCall(call) {
  if (_deskBotCallActive) return;
  _deskBotCallActive = true;
  _deskBotCallId = call.id;
  _deskBotCallTargetId = call.initiator_id;
  _deskBotConversation = [];

  console.log('[BotCall] Auto-answering call from', call.initiator_name);
  showNotification('🤖 Beam AI answering call from ' + (call.initiator_name || 'Unknown'), 'info');

  try {
    // 1. Answer the call on the server
    await fetch(`${API_BASE}/calls/${call.id}/answer`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ device_id: desktopDeviceId })
    });

    // 2. Get REAL microphone — needed for SpeechRecognition AND
    //    relaying TTS audio to caller (speakers → mic → WebRTC)
    try {
      _deskBotLocalStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      console.log('[BotCall] Microphone acquired');
    } catch(micErr) {
      console.warn('[BotCall] Mic access denied, using silent stream:', micErr);
      // Fallback to silent stream if mic not available
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = actx.createOscillator();
      const gain = actx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      const dest = actx.createMediaStreamDestination();
      gain.connect(dest);
      osc.start();
      _deskBotLocalStream = dest.stream;
      _deskBotAudioCtx = actx;
    }

    // 3. Create PeerConnection
    _deskBotPeerConnection = new RTCPeerConnection(_rtcConfig);

    // Add local audio tracks
    _deskBotLocalStream.getTracks().forEach(track => {
      _deskBotPeerConnection.addTrack(track, _deskBotLocalStream);
    });

    // 4. Handle remote stream — play through speakers so we can hear caller
    //    AND so SpeechRecognition (via mic) picks up their voice
    _deskBotPeerConnection.ontrack = (event) => {
      console.log('[BotCall] Remote track received:', event.track.kind);
      _deskBotRemoteStream = event.streams[0];
      // Create a dynamic audio element to play remote audio through speakers
      _deskBotEnsureRemoteAudio(_deskBotRemoteStream);
      // Start speech recognition after a short delay for audio to stabilize
      setTimeout(() => _deskBotStartListening(), 500);
    };

    // 5. ICE candidates
    _deskBotPeerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        fetch(`${API_BASE}/calls/signal`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            from_id: desktopDeviceId,
            to_id: _deskBotCallTargetId,
            signal_type: 'ice-candidate',
            call_id: call.id,
            payload: event.candidate.toJSON()
          })
        }).catch(e => console.error('[BotCall] ICE signal error:', e));
      }
    };

    // 6. Connection state monitoring
    _deskBotPeerConnection.oniceconnectionstatechange = () => {
      const state = _deskBotPeerConnection ? _deskBotPeerConnection.iceConnectionState : 'null';
      console.log('[BotCall] ICE state:', state);
      if (state === 'connected' || state === 'completed') {
        console.log('[BotCall] WebRTC connected — audio flowing');
      }
      if (state === 'disconnected') {
        // Give it a few seconds before giving up
        setTimeout(() => {
          if (_deskBotPeerConnection && _deskBotPeerConnection.iceConnectionState === 'disconnected') {
            console.warn('[BotCall] Still disconnected, ending call');
            deskBotEndCall();
          }
        }, 5000);
      }
      if (state === 'failed') {
        deskBotEndCall();
      }
    };

    // 7. Start signal polling for WebRTC negotiation
    _deskBotStartSignalPolling(call.id, _deskBotCallTargetId);

    // 8. Speak the greeting after WebRTC has time to connect
    setTimeout(() => {
      if (_deskBotCallActive) {
        _deskBotSpeak("Hey! They're not available right now, but I can take a message or help you out. What's up?");
      }
    }, 3000);

  } catch(e) {
    console.error('[BotCall] Failed to answer:', e);
    _deskBotCallActive = false;
    _deskBotCallId = null;
  }
}

/* Play remote call audio through a dynamic <audio> element on speakers */
function _deskBotEnsureRemoteAudio(stream) {
  // Remove old element if present
  let el = document.getElementById('_deskBotRemoteAudio');
  if (el) { el.srcObject = null; el.remove(); }
  el = document.createElement('audio');
  el.id = '_deskBotRemoteAudio';
  el.autoplay = true;
  el.setAttribute('playsinline', '');
  el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;';
  document.body.appendChild(el);
  el.srcObject = stream;
  el.volume = 1.0;
  const p = el.play();
  if (p) p.catch(e => {
    console.warn('[BotCall] Audio autoplay blocked, retry on click:', e);
    document.addEventListener('click', () => { el.play().catch(() => {}); }, { once: true });
  });
  console.log('[BotCall] Remote audio element playing through speakers');
}

function _deskBotCleanupRemoteAudio() {
  const el = document.getElementById('_deskBotRemoteAudio');
  if (el) { el.srcObject = null; el.remove(); }
}

function _deskBotStartSignalPolling(callId, remoteDeviceId) {
  if (_deskBotSignalPollTimer) clearInterval(_deskBotSignalPollTimer);
  _deskBotSignalPollTimer = setInterval(async () => {
    if (!_deskBotPeerConnection || !_deskBotCallId) { clearInterval(_deskBotSignalPollTimer); return; }
    try {
      const res = await fetch(`${API_BASE}/calls/signals/${desktopDeviceId}`);
      const data = await res.json();
      for (const signal of (data.signals || [])) {
        if (signal.call_id !== callId) continue;
        if (signal.type === 'offer') {
          // Only handle offer if we haven't set remote description yet
          if (_deskBotPeerConnection.signalingState === 'stable' || _deskBotPeerConnection.signalingState === 'have-local-offer') {
            await _deskBotPeerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
            const answer = await _deskBotPeerConnection.createAnswer();
            await _deskBotPeerConnection.setLocalDescription(answer);
            await fetch(`${API_BASE}/calls/signal`, {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({
                from_id: desktopDeviceId,
                to_id: remoteDeviceId,
                signal_type: 'answer',
                call_id: callId,
                payload: { type: answer.type, sdp: answer.sdp }
              })
            });
            console.log('[BotCall] Answer sent for offer');
          }
        } else if (signal.type === 'answer') {
          if (_deskBotPeerConnection.signalingState === 'have-local-offer') {
            await _deskBotPeerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
          }
        } else if (signal.type === 'ice-candidate') {
          try {
            await _deskBotPeerConnection.addIceCandidate(new RTCIceCandidate(signal.payload));
          } catch(e) { console.warn('[BotCall] ICE add error:', e); }
        } else if (signal.type === 'call-end') {
          deskBotEndCall();
          return;
        }
      }
    } catch(e) { console.warn('[BotCall] Signal poll error:', e); }
  }, 800);
}

function _deskBotStartListening() {
  // SpeechRecognition uses the device microphone.
  // The caller's audio plays through speakers → mic picks it up → STT
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('[BotCall] SpeechRecognition not supported in this browser');
    return;
  }

  if (_deskBotRecognition) {
    try { _deskBotRecognition.stop(); } catch(e) {}
  }

  _deskBotRecognition = new SpeechRecognition();
  _deskBotRecognition.continuous = true;
  _deskBotRecognition.interimResults = false;
  _deskBotRecognition.lang = 'en-US';
  _deskBotRecognition.maxAlternatives = 1;

  _deskBotRecognition.onresult = async (event) => {
    if (_deskBotSpeaking) return; // Ignore while bot is talking
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        const transcript = event.results[i][0].transcript.trim();
        if (!transcript || transcript.length < 2) continue;
        console.log('[BotCall] Heard:', transcript);
        _deskBotConversation.push({ role: 'caller', text: transcript });
        await _deskBotProcessCallerSpeech(transcript);
      }
    }
  };

  _deskBotRecognition.onerror = (event) => {
    console.warn('[BotCall] STT error:', event.error);
    // Restart on recoverable errors
    if (event.error === 'no-speech' || event.error === 'audio-capture' || event.error === 'network') {
      setTimeout(() => {
        if (_deskBotCallActive && !_deskBotSpeaking) {
          try { _deskBotRecognition.start(); } catch(e) {}
        }
      }, 1500);
    }
  };

  _deskBotRecognition.onend = () => {
    // Auto-restart while call is active
    if (_deskBotCallActive && !_deskBotSpeaking) {
      setTimeout(() => {
        if (_deskBotCallActive && !_deskBotSpeaking && _deskBotRecognition) {
          try { _deskBotRecognition.start(); } catch(e) {}
        }
      }, 300);
    }
  };

  try {
    _deskBotRecognition.start();
    console.log('[BotCall] Speech recognition started (listening via microphone)');
  } catch(e) {
    console.error('[BotCall] Failed to start STT:', e);
  }
}

async function _deskBotProcessCallerSpeech(text) {
  _deskBotSpeaking = true;
  try {
    // Pause STT while generating response
    if (_deskBotRecognition) try { _deskBotRecognition.stop(); } catch(e) {}

    const res = await fetch(`${API_BASE}/ai/voice-reply`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        device_id: desktopDeviceId,
        caller_name: 'Caller',
        text: text,
        conversation: _deskBotConversation.slice(-6), // last 6 turns for context
        tts: true
      })
    });
    const data = await res.json();

    if (data.reply) {
      _deskBotConversation.push({ role: 'bot', text: data.reply });
      // Speak the reply — SpeechSynthesis plays through speakers,
      // mic picks it up and relays to caller via WebRTC
      await _deskBotSpeak(data.reply);

      if (data.flagged) {
        showNotification('⚠️ AI flagged an important call message', 'warning');
        await fetch(`${API_BASE}/p2p/messages`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            sender_id: 'beam-ai-bot',
            sender_name: 'Beam AI',
            recipient_id: desktopDeviceId,
            text: '📞 FLAGGED CALL from caller: "' + text + '"\nAI replied: "' + data.reply + '"',
            ai_delegated: true
          })
        });
      }
    }
  } catch(e) { console.error('[BotCall] Voice reply error:', e); }
  _deskBotSpeaking = false;
  // Resume listening
  if (_deskBotCallActive && _deskBotRecognition) {
    try { _deskBotRecognition.start(); } catch(e) {}
  }
}

function _deskBotSpeak(text) {
  return new Promise(async resolve => {
    try {
      console.log('[BotCall] Fetching Edge Neural TTS for:', text.substring(0, 60) + '...');
      const res = await fetch(`${API_BASE}/ai/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.audio) {
          const mimeType = (data.format === 'wav') ? 'audio/wav' : 'audio/mpeg';
          const audio = new Audio(`data:${mimeType};base64,${data.audio}`);
          audio.onended = () => { console.log('[BotCall] Neural TTS finished'); resolve(); };
          audio.onerror = () => { console.warn('[BotCall] Neural TTS playback error'); resolve(); };
          audio.play();
          // Safety timeout
          setTimeout(() => resolve(), Math.max(text.length * 120, 20000));
          return;
        }
      }
      console.warn('[BotCall] Server TTS failed, skipping');
      resolve();
    } catch(e) {
      console.warn('[BotCall] TTS fetch error:', e);
      resolve();
    }
  });
}

function deskBotEndCall() {
  console.log('[BotCall] Ending bot call');
  if (_deskBotCallId) {
    fetch(`${API_BASE}/calls/${_deskBotCallId}/end`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ device_id: desktopDeviceId })
    }).catch(() => {});
  }
  if (_deskBotSignalPollTimer) { clearInterval(_deskBotSignalPollTimer); _deskBotSignalPollTimer = null; }
  if (_deskBotPeerConnection) { _deskBotPeerConnection.close(); _deskBotPeerConnection = null; }
  if (_deskBotRecognition) { try { _deskBotRecognition.stop(); } catch(e) {} _deskBotRecognition = null; }
  if (_deskBotAudioCtx) { _deskBotAudioCtx.close().catch(() => {}); _deskBotAudioCtx = null; }
  if (_deskBotLocalStream) { _deskBotLocalStream.getTracks().forEach(t => t.stop()); _deskBotLocalStream = null; }
  _deskBotCleanupRemoteAudio();
  // Neural TTS audio stops when Audio element is garbage collected
  _deskBotRemoteStream = null;
  _deskBotCallActive = false;
  _deskBotCallId = null;
  _deskBotCallTargetId = null;
  _deskBotConversation = [];
  _deskBotSpeaking = false;
  showNotification('🤖 Bot call ended', 'info');
  loadCallHistory();
}

async function loadCallHistory() {
  try {
    const res = await fetch(`${API_BASE}/calls/history/${desktopDeviceId}`);
    const data = await res.json();
    const history = data.history || [];
    const list = document.getElementById('callHistoryList');
    if (history.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fas fa-phone-alt"></i><p>No recent calls</p></div>';
      return;
    }
    list.innerHTML = history.map(c => {
      const isOutgoing = c.initiator_id === desktopDeviceId;
      const icon = isOutgoing ? 'fa-phone-alt' : 'fa-phone-volume';
      const dirClass = isOutgoing ? 'outgoing' : 'incoming';
      const otherPart = isOutgoing ? (Object.keys(c.participants || {}).find(k => k !== desktopDeviceId) || '') : (c.initiator_id || '');
      const otherName = isOutgoing ? (otherPart || 'Unknown') : (c.initiator_name || 'Unknown');
      const typeIcon = c.type === 'video' ? 'fa-video' : 'fa-phone-alt';
      const duration = c.ended && c.created ? formatCallDuration(c.ended - c.created) : 'Missed';
      const time = formatTime(c.created);
      return `<div class="call-history-item">
        <div class="call-history-icon ${dirClass}"><i class="fas ${icon}"></i></div>
        <div class="call-history-info">
          <span class="call-history-name">${escapeHtml(otherName)} ${vBadge(otherPart || '')}</span>
          <span class="call-history-meta"><i class="fas ${typeIcon}"></i> ${duration} · ${time}</span>
        </div>
        <div class="call-history-dir">
          <span class="call-dir-badge ${dirClass}">${isOutgoing ? 'Outgoing' : 'Incoming'}</span>
        </div>
      </div>`;
    }).join('');
  } catch(e) { console.error('loadCallHistory', e); }
}

function formatCallDuration(seconds) {
  if (!seconds || seconds < 1) return 'Missed';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}


// ═══════════════════════════════════════════════════════════════
// GROUPS
// ═══════════════════════════════════════════════════════════════

let _currentGroupId = null;
let _currentGroupData = null;
let _groupMsgPollInterval = null;
let _groupMsgLastTs = 0;

async function loadGroupsPage() {
  await loadGroupsList();
}

async function loadGroupsList() {
  try {
    const res = await fetch(`${API_BASE}/groups/list/${desktopDeviceId}`);
    const data = await res.json();
    const groups = data.groups || [];
    const list = document.getElementById('groupsList');
    if (groups.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fas fa-users"></i><p>No groups yet</p></div>';
      return;
    }
    list.innerHTML = groups.map(g => {
      const activeClass = _currentGroupId === g.id ? 'active' : '';
      const preview = g.last_message ? `${g.last_message.sender_name}: ${escapeHtml(g.last_message.text || '📎')}` : 'No messages yet';
      const time = g.last_message ? formatTime(g.last_message.timestamp) : '';
      const avatar = g.avatar ? `<img src="${g.avatar}" class="group-avatar-img">` : `<div class="group-avatar-placeholder"><i class="fas fa-users"></i></div>`;
      return `<div class="group-list-item ${activeClass}" onclick="openGroupChat('${g.id}')">
        <div class="group-list-avatar">${avatar}</div>
        <div class="group-list-info">
          <div class="group-list-name">${escapeHtml(g.name)} ${vBadge(g.id)}</div>
          <div class="group-list-preview">${preview}</div>
        </div>
        <div class="group-list-meta">
          <span class="group-list-time">${time}</span>
          <span class="group-list-count"><i class="fas fa-user"></i> ${g.members_count || 0}</span>
        </div>
      </div>`;
    }).join('');
  } catch(e) { console.error('loadGroupsList', e); }
}

function openCreateGroupModal() {
  document.getElementById('createGroupModal').style.display = 'flex';
  document.getElementById('newGroupName').value = '';
  document.getElementById('newGroupDesc').value = '';
  loadGroupMemberPicker('newGroupDeviceList');
}

function closeCreateGroupModal() {
  document.getElementById('createGroupModal').style.display = 'none';
}

async function loadGroupMemberPicker(containerId) {
  try {
    const res = await fetch(`${API_BASE}/p2p/devices`);
    const data = await res.json();
    const devs = Array.isArray(data) ? data : (data.devices || []);
    const container = document.getElementById(containerId);
    const others = devs.filter(d => (d.id || d.device_id) !== desktopDeviceId);
    if (others.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:12px">No other devices online</p>';
      return;
    }
    container.innerHTML = others.map(d => {
      const id = d.id || d.device_id;
      const name = d.name || 'Unknown';
      return `<label class="group-member-check">
        <input type="checkbox" value="${id}" data-name="${escapeHtml(name)}">
        <span>${escapeHtml(name)}</span>
      </label>`;
    }).join('');
  } catch(e) { console.error('loadGroupMemberPicker', e); }
}

async function createGroup() {
  const name = document.getElementById('newGroupName').value.trim();
  if (!name) { showNotification('Group name is required', 'error'); return; }
  const desc = document.getElementById('newGroupDesc').value.trim();
  const checkboxes = document.querySelectorAll('#newGroupDeviceList input[type=checkbox]:checked');
  const members = Array.from(checkboxes).map(cb => cb.value);

  try {
    const res = await fetch(`${API_BASE}/groups`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        name: name,
        creator_id: desktopDeviceId,
        creator_name: desktopDeviceName,
        members: members,
        description: desc
      })
    });
    const data = await res.json();
    if (data.success) {
      closeCreateGroupModal();
      showNotification('Group created!', 'success');
      await loadGroupsList();
      if (data.group && data.group.id) openGroupChat(data.group.id);
    } else {
      showNotification(data.error || 'Failed to create group', 'error');
    }
  } catch(e) {
    showNotification('Failed to create group', 'error');
  }
}

async function openGroupChat(groupId) {
  _currentGroupId = groupId;
  _groupMsgLastTs = 0;

  // Highlight in sidebar
  document.querySelectorAll('.group-list-item').forEach(el => el.classList.remove('active'));
  const items = document.querySelectorAll('.group-list-item');
  items.forEach(el => { if (el.getAttribute('onclick').includes(groupId)) el.classList.add('active'); });

  document.getElementById('groupsEmptyState').style.display = 'none';
  document.getElementById('groupChatWindow').style.display = 'flex';

  // Load group info
  try {
    const res = await fetch(`${API_BASE}/groups/${groupId}`);
    const data = await res.json();
    _currentGroupData = data.group;
    document.getElementById('groupChatName').textContent = data.group.name || 'Group';
    document.getElementById('groupChatMembers').textContent = (data.group.members || []).length + ' members';
  } catch(e) {}

  await loadGroupMessages(true);
  startGroupMsgPoll();

  // Check for active group call
  deskCheckActiveGroupCall();
}

function closeGroupChat() {
  _currentGroupId = null;
  _currentGroupData = null;
  if (_groupMsgPollInterval) { clearInterval(_groupMsgPollInterval); _groupMsgPollInterval = null; }
  document.getElementById('groupChatWindow').style.display = 'none';
  document.getElementById('groupsEmptyState').style.display = '';
}

async function loadGroupMessages(full) {
  if (!_currentGroupId) return;
  try {
    const after = full ? 0 : _groupMsgLastTs;
    const res = await fetch(`${API_BASE}/groups/${_currentGroupId}/messages?device_id=${desktopDeviceId}&after=${after}`);
    const data = await res.json();
    const msgs = data.messages || [];
    if (msgs.length === 0 && full) {
      document.getElementById('groupMessagesArea').innerHTML = '<div class="empty-state"><i class="fas fa-comments"></i><p>No messages yet. Say something!</p></div>';
      return;
    }
    if (full) {
      document.getElementById('groupMessagesArea').innerHTML = '';
    }
    msgs.forEach(m => {
      if (m.timestamp > _groupMsgLastTs) _groupMsgLastTs = m.timestamp;
      appendGroupMessage(m);
    });
    if (full || msgs.length > 0) {
      const area = document.getElementById('groupMessagesArea');
      area.scrollTop = area.scrollHeight;
    }
  } catch(e) { console.error('loadGroupMessages', e); }
}

function appendGroupMessage(msg) {
  const area = document.getElementById('groupMessagesArea');
  const isMine = msg.sender_id === desktopDeviceId;
  const div = document.createElement('div');
  div.className = 'chat-message-desktop ' + (isMine ? 'own' : 'other');
  div.id = 'grpmsg-' + msg.id;

  const senderLabel = isMine ? '' : `<div class="grp-msg-sender">${escapeHtml(msg.sender_name || 'Unknown')} ${vBadge(msg.sender_id)}</div>`;

  let mediaContent = '';
  let isImgBubble = false;
  if (msg.media_data && msg.media_type) {
    if (msg.media_type.startsWith('image')) {
      isImgBubble = true;
      mediaContent = `<img src="${msg.media_data}" style="max-width:280px;max-height:280px;border-radius:8px;display:block;cursor:pointer;margin-top:4px" onclick="window.open(this.src)">`;
    } else if (msg.media_type.startsWith('audio')) {
      mediaContent = `<audio controls src="${msg.media_data}" style="max-width:100%;margin-top:4px"></audio>`;
    } else if (msg.media_type.startsWith('video')) {
      mediaContent = `<video controls src="${msg.media_data}" style="max-width:280px;max-height:280px;border-radius:8px;margin-top:4px;background:#000;display:block" playsinline></video>`;
    } else {
      mediaContent = `<a href="${msg.media_data}" download="${escapeHtml(msg.file_name || 'file')}" style="display:inline-block;color:#667EEA;text-decoration:underline;margin-top:4px;font-size:0.9rem"><i class="fas fa-file-download"></i> ${escapeHtml(msg.file_name || 'File')}</a>`;
    }
  }

  let replyHtml = '';
  if (msg.reply_to_data) {
    replyHtml = `<div class="grp-reply-preview"><strong>${escapeHtml(msg.reply_to_data.sender_name)}</strong><br>${escapeHtml(msg.reply_to_data.text || '')}</div>`;
  }

  const textHtml = msg.text ? escapeHtml(msg.text) : '';
  let editedTag = '';
  if (msg.edited) editedTag = ' <span style="font-size:9px;opacity:0.6" title="Edited"><i class="fas fa-pen"></i></span>';
  const time = new Date(msg.timestamp * 1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});

  // Reactions
  let reactHtml = '';
  if (msg.reactions && Object.keys(msg.reactions).length > 0) {
    const counts = {};
    Object.values(msg.reactions).forEach(e => { counts[e] = (counts[e]||0)+1; });
    reactHtml = '<div class="grp-reactions">' + Object.entries(counts).map(([em, c]) => {
      const myReact = msg.reactions[desktopDeviceId] === em ? 'my-react' : '';
      return `<span class="grp-reaction-pill ${myReact}" onclick="reactGroupMsg('${msg.id}','${em}')">${em} ${c}</span>`;
    }).join('') + '</div>';
  }

  const bubbleClass = isImgBubble ? 'chat-message-bubble-desktop img-bubble' : 'chat-message-bubble-desktop';
  div.innerHTML = `
    <div class="msg-bubble-wrap">
      <div class="${bubbleClass}">${senderLabel}${replyHtml}${textHtml}${mediaContent}${editedTag}</div>
      ${reactHtml}
    </div>
    <span class="desk-msg-time">${time}</span>
  `;
  area.appendChild(div);
}

function startGroupMsgPoll() {
  if (_groupMsgPollInterval) clearInterval(_groupMsgPollInterval);
  _groupMsgPollInterval = setInterval(() => {
    if (_currentGroupId) loadGroupMessages(false);
  }, 3000);
}

async function sendGroupMessage() {
  if (!_currentGroupId) return;
  const input = document.getElementById('groupChatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  try {
    await fetch(`${API_BASE}/groups/${_currentGroupId}/messages`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        sender_id: desktopDeviceId,
        sender_name: desktopDeviceName,
        text: text
      })
    });
    await loadGroupMessages(false);
  } catch(e) {
    showNotification('Failed to send message', 'error');
  }
}

// ── Group file upload ──
async function handleGroupFileUpload(event) {
  const files = event.target.files;
  if (!files.length || !_currentGroupId) return;
  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) { showNotification('File too large: ' + file.name, 'error'); continue; }
    const reader = new FileReader();
    reader.onload = async () => {
      const base64Data = reader.result.split(',')[1];
      const fileType = file.type || 'application/octet-stream';
      await fetch(`${API_BASE}/groups/${_currentGroupId}/messages`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          sender_id: desktopDeviceId,
          sender_name: desktopDeviceName,
          text: `📎 ${file.name}`,
          media_type: fileType,
          media_data: base64Data,
          file_name: file.name
        })
      }).catch(e => console.error('Failed to send group file:', e));
      await loadGroupMessages(false);
    };
    reader.readAsDataURL(file);
  }
  event.target.value = '';
}

// ── Group emoji picker ──
let _groupEmojiPickerOpen = false;

function toggleGroupEmojiPicker() {
  if (_groupEmojiPickerOpen) { closeGroupEmojiPicker(); return; }
  _groupEmojiPickerOpen = true;
  const old = document.getElementById('groupEmojiPickerPanel');
  if (old) old.remove();

  const panel = document.createElement('div');
  panel.id = 'groupEmojiPickerPanel';
  panel.className = 'emoji-picker-panel';

  const tabs = document.createElement('div');
  tabs.className = 'emoji-picker-tabs';
  _emojiCategories.forEach(cat => {
    const t = document.createElement('button');
    t.className = 'emoji-tab' + (cat.id === 'smileys' ? ' active' : '');
    t.textContent = cat.icon;
    t.title = cat.label;
    t.setAttribute('data-cat', cat.id);
    t.onclick = function() {
      tabs.querySelectorAll('.emoji-tab').forEach(b => b.classList.remove('active'));
      t.classList.add('active');
      _renderEmojiCategory(cat.id, grid, searchInput);
    };
    tabs.appendChild(t);
  });
  panel.appendChild(tabs);

  const searchWrap = document.createElement('div');
  searchWrap.className = 'emoji-search-wrap';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'emoji-search-input';
  searchInput.placeholder = 'Search emoji';
  searchWrap.innerHTML = '<i class="fas fa-search emoji-search-icon"></i>';
  searchWrap.appendChild(searchInput);
  panel.appendChild(searchWrap);

  const grid = document.createElement('div');
  grid.className = 'emoji-picker-grid';
  panel.appendChild(grid);

  const recents = _getRecentEmojis();
  if (recents.length > 0) {
    _emojiCategories[0].emojis = recents;
    _renderEmojiCategory('recent', grid, searchInput);
    const recentTab = tabs.querySelector('[data-cat="recent"]');
    if (recentTab) { recentTab.classList.add('active'); tabs.querySelector('[data-cat="smileys"]').classList.remove('active'); }
  } else {
    _renderEmojiCategory('smileys', grid, searchInput);
  }

  searchInput.addEventListener('input', function() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      const active = tabs.querySelector('.emoji-tab.active');
      _renderEmojiCategory(active ? active.getAttribute('data-cat') : 'smileys', grid, searchInput);
      return;
    }
    let results = [];
    _emojiCategories.slice(1).forEach(cat => { cat.emojis.forEach(em => { if (!results.includes(em)) results.push(em); }); });
    grid.innerHTML = '';
    const label = document.createElement('div'); label.className = 'emoji-cat-label'; label.textContent = 'All Emojis'; grid.appendChild(label);
    const wrap = document.createElement('div'); wrap.className = 'emoji-cat-grid';
    results.forEach(em => {
      const btn = document.createElement('button'); btn.className = 'emoji-btn'; btn.textContent = em;
      btn.onclick = function() { _insertGroupEmoji(em); };
      wrap.appendChild(btn);
    });
    grid.appendChild(wrap);
  });

  // Override emoji click to insert into group input
  grid.addEventListener('click', function(e) {
    if (e.target.classList.contains('emoji-btn')) {
      _insertGroupEmoji(e.target.textContent);
    }
  }, true);

  const inputGroup = document.getElementById('groupInputGroup');
  inputGroup.style.position = 'relative';
  inputGroup.appendChild(panel);

  const toggle = document.getElementById('groupEmojiPickerToggle');
  if (toggle) toggle.classList.add('active');
  setTimeout(() => { document.addEventListener('click', _groupEmojiOutsideClick); }, 50);
}

function _insertGroupEmoji(emoji) {
  const ta = document.getElementById('groupChatInput');
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + emoji.length;
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  _addRecentEmoji(emoji);
}

function closeGroupEmojiPicker() {
  _groupEmojiPickerOpen = false;
  const panel = document.getElementById('groupEmojiPickerPanel');
  if (panel) panel.remove();
  const toggle = document.getElementById('groupEmojiPickerToggle');
  if (toggle) toggle.classList.remove('active');
  document.removeEventListener('click', _groupEmojiOutsideClick);
}

function _groupEmojiOutsideClick(e) {
  const panel = document.getElementById('groupEmojiPickerPanel');
  const toggle = document.getElementById('groupEmojiPickerToggle');
  if (panel && !panel.contains(e.target) && toggle && !toggle.contains(e.target)) {
    closeGroupEmojiPicker();
  }
}

// ── Group voice recording ──
let _grpMediaRecorder = null;
let _grpAudioChunks = [];
let _grpRecordingStartTime = null;
let _grpRecordingTimer = null;
let _grpRecordingMimeType = 'audio/webm';

function toggleGroupRecording() {
  if (_grpMediaRecorder && _grpMediaRecorder.state === 'recording') {
    sendGroupVoiceRecord();
  } else {
    startGroupVoiceRecord();
  }
}

async function startGroupVoiceRecord() {
  try {
    if (!window.MediaRecorder) { alert('MediaRecorder not supported'); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch(e) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    let mimeType = 'audio/webm';
    const types = ['audio/mp4','audio/aac','audio/webm;codecs=opus','audio/webm','audio/ogg'];
    for (const t of types) { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) { mimeType = t; _grpRecordingMimeType = t; break; } }
    _grpMediaRecorder = new MediaRecorder(stream, { mimeType });
    _grpAudioChunks = [];
    _grpRecordingStartTime = Date.now();
    _grpMediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) _grpAudioChunks.push(e.data); };
    _grpMediaRecorder.onerror = () => { _resetGroupRecorderUI(); };
    _grpMediaRecorder.start();
    const inputGroup = document.getElementById('groupInputGroup');
    if (inputGroup) inputGroup.style.display = 'none';
    const recorderInline = document.getElementById('groupRecorderInline');
    if (recorderInline) recorderInline.style.display = 'flex';
    const micBtn = document.getElementById('groupMicBtn');
    if (micBtn) micBtn.classList.add('recording');
    _grpRecordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - _grpRecordingStartTime) / 1000);
      document.getElementById('groupRecordingTime').textContent = `${Math.floor(elapsed/60)}:${(elapsed%60).toString().padStart(2,'0')}`;
    }, 1000);
  } catch(err) {
    let msg = 'Unable to access microphone.';
    if (err.name === 'NotAllowedError') msg = 'Microphone permission denied.';
    else if (err.name === 'NotFoundError') msg = 'No microphone found.';
    alert(msg);
  }
}

function _resetGroupRecorderUI() {
  const rec = document.getElementById('groupRecorderInline');
  if (rec) rec.style.display = 'none';
  const inputGroup = document.getElementById('groupInputGroup');
  if (inputGroup) inputGroup.style.display = 'flex';
  const timeEl = document.getElementById('groupRecordingTime');
  if (timeEl) timeEl.textContent = '0:00';
  const micBtn = document.getElementById('groupMicBtn');
  if (micBtn) micBtn.classList.remove('recording');
}

function cancelGroupVoiceRecord() {
  if (_grpMediaRecorder && _grpMediaRecorder.state !== 'inactive') {
    _grpMediaRecorder.stop();
    _grpMediaRecorder.stream.getTracks().forEach(t => t.stop());
  }
  if (_grpRecordingTimer) clearInterval(_grpRecordingTimer);
  _grpAudioChunks = [];
  _resetGroupRecorderUI();
}

async function sendGroupVoiceRecord() {
  if (_grpRecordingTimer) clearInterval(_grpRecordingTimer);
  const duration = Math.floor((Date.now() - _grpRecordingStartTime) / 1000);
  const stopPromise = new Promise(resolve => { _grpMediaRecorder.onstop = resolve; });
  _grpMediaRecorder.stop();
  await stopPromise;
  _grpMediaRecorder.stream.getTracks().forEach(t => t.stop());
  const audioBlob = new Blob(_grpAudioChunks, { type: _grpRecordingMimeType });
  const reader = new FileReader();
  reader.onload = async () => {
    const base64Audio = reader.result.split(',')[1];
    await fetch(`${API_BASE}/groups/${_currentGroupId}/messages`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        text: `🎙️ Voice message (${Math.floor(duration/60)}:${(duration%60).toString().padStart(2,'0')})`,
        sender_id: desktopDeviceId,
        sender_name: desktopDeviceName,
        media_type: _grpRecordingMimeType,
        media_data: base64Audio
      })
    }).catch(e => console.error('Failed to send group voice:', e));
    _grpAudioChunks = [];
    _resetGroupRecorderUI();
    await loadGroupMessages(false);
  };
  reader.readAsDataURL(audioBlob);
}

async function reactGroupMsg(messageId, emoji) {
  try {
    await fetch(`${API_BASE}/groups/messages/${messageId}/react`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ device_id: desktopDeviceId, emoji: emoji })
    });
    await loadGroupMessages(true);
  } catch(e) {}
}

function openGroupInfoModal() {
  if (!_currentGroupData) return;
  const g = _currentGroupData;
  document.getElementById('groupInfoName').textContent = g.name;
  document.getElementById('groupInfoDesc').textContent = g.description || 'No description';

  const membersList = document.getElementById('groupInfoMembersList');
  membersList.innerHTML = (g.members || []).map(mId => {
    const isAdmin = (g.admins || []).includes(mId);
    const isMe = mId === desktopDeviceId;
    const badge = isAdmin ? '<span class="admin-badge">Admin</span>' : '';
    const label = isMe ? `${mId} (You)` : mId;
    let actions = '';
    if ((g.admins||[]).includes(desktopDeviceId) && !isMe) {
      actions = `<button class="btn-icon btn-xs" onclick="removeGroupMember('${mId}')" title="Remove"><i class="fas fa-times"></i></button>`;
      if (!isAdmin) actions += `<button class="btn-icon btn-xs" onclick="promoteGroupMember('${mId}')" title="Make admin"><i class="fas fa-crown"></i></button>`;
    }
    return `<div class="group-info-member"><span>${escapeHtml(label)} ${badge}</span><div>${actions}</div></div>`;
  }).join('');

  // Show admin actions if I'm admin
  const isAdmin = (g.admins||[]).includes(desktopDeviceId);
  document.getElementById('groupInfoAdminActions').style.display = isAdmin ? '' : 'none';
  if (isAdmin) loadGroupMemberPicker('groupInfoAddMembers');

  // Show delete button only for creator
  const isCreator = g.creator_id === desktopDeviceId;
  document.getElementById('groupInfoDeleteBtn').style.display = isCreator ? '' : 'none';

  document.getElementById('groupInfoModal').style.display = 'flex';
}

function closeGroupInfoModal() {
  document.getElementById('groupInfoModal').style.display = 'none';
}

async function addMembersToGroup() {
  if (!_currentGroupId) return;
  const checkboxes = document.querySelectorAll('#groupInfoAddMembers input[type=checkbox]:checked');
  const members = Array.from(checkboxes).map(cb => cb.value);
  if (members.length === 0) { showNotification('Select members to add', 'error'); return; }
  try {
    await fetch(`${API_BASE}/groups/${_currentGroupId}/members`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ device_id: desktopDeviceId, members: members })
    });
    showNotification('Members added', 'success');
    closeGroupInfoModal();
    openGroupChat(_currentGroupId);
  } catch(e) { showNotification('Failed to add members', 'error'); }
}

async function removeGroupMember(memberId) {
  if (!_currentGroupId) return;
  if (!confirm('Remove this member?')) return;
  try {
    await fetch(`${API_BASE}/groups/${_currentGroupId}/members/${memberId}?device_id=${desktopDeviceId}`, { method: 'DELETE' });
    showNotification('Member removed', 'success');
    closeGroupInfoModal();
    openGroupChat(_currentGroupId);
  } catch(e) { showNotification('Failed to remove member', 'error'); }
}

async function promoteGroupMember(memberId) {
  if (!_currentGroupId) return;
  try {
    await fetch(`${API_BASE}/groups/${_currentGroupId}/admins`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ device_id: desktopDeviceId, target_id: memberId })
    });
    showNotification('Promoted to admin', 'success');
    closeGroupInfoModal();
    openGroupChat(_currentGroupId);
  } catch(e) { showNotification('Failed to promote', 'error'); }
}

async function leaveCurrentGroup() {
  if (!_currentGroupId) return;
  if (!confirm('Leave this group?')) return;
  try {
    await fetch(`${API_BASE}/groups/${_currentGroupId}/members/${desktopDeviceId}?device_id=${desktopDeviceId}`, { method: 'DELETE' });
    showNotification('Left group', 'info');
    closeGroupInfoModal();
    closeGroupChat();
    await loadGroupsList();
  } catch(e) { showNotification('Failed to leave group', 'error'); }
}

async function deleteCurrentGroup() {
  if (!_currentGroupId) return;
  if (!confirm('Are you sure you want to permanently delete this group? This action cannot be undone.')) return;
  try {
    const res = await fetch(`${API_BASE}/groups/${_currentGroupId}?device_id=${desktopDeviceId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showNotification('Group deleted', 'success');
      closeGroupInfoModal();
      closeGroupChat();
      await loadGroupsList();
    } else {
      showNotification(data.error || 'Failed to delete group', 'error');
    }
  } catch(e) { showNotification('Failed to delete group', 'error'); }
}


// ═══════════════════════════════════════════════════════════════
// GROUP CALLS — Desktop (Mesh WebRTC)
// ═══════════════════════════════════════════════════════════════

let _deskGrpCallId = null;
let _deskGrpCallType = 'audio';
let _deskGrpLocalStream = null;
let _deskGrpPeers = {};        // { deviceId: { pc, remoteStream } }
let _deskGrpCallTimer = null;
let _deskGrpCallSecs = 0;
let _deskGrpSignalPoll = null;

async function deskStartGroupCall(callType) {
    if (!_currentGroupId || !_currentGroupData) {
        showNotification('Open a group first', 'error'); return;
    }
    if (_deskGrpCallId) {
        showNotification('Already in a group call', 'info'); return;
    }

    const members = (_currentGroupData.members || []).filter(m => m !== desktopDeviceId);
    if (members.length === 0) {
        showNotification('No other members in this group', 'error'); return;
    }

    try {
        const res = await fetch(API_BASE + '/calls/initiate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                initiator_id: desktopDeviceId,
                initiator_name: desktopDeviceName,
                target_ids: members,
                call_type: callType,
                group_id: _currentGroupId
            })
        });
        const data = await res.json();
        if (!data.call_id) { showNotification(data.error || 'Failed', 'error'); return; }

        _deskGrpCallId = data.call_id;
        _deskGrpCallType = callType;
        await _deskGrpSetupLocal(callType);
        _deskGrpShowOverlay();
        _deskGrpStartSignalPoll();
        _deskGrpAddLocalTile();
        showNotification('Group call started', 'info');
    } catch (e) {
        console.error('[GrpCall] initiate error:', e);
        showNotification('Failed to start group call', 'error');
    }
}

async function deskJoinGroupCall(callId, callType) {
    // If same call, skip; if stale leftover, clean up first
    if (_deskGrpCallId === callId) { showNotification('Already in this call', 'info'); return; }
    if (_deskGrpCallId) { await deskGrpEndCall(); }

    try {
        const res = await fetch(API_BASE + '/calls/' + callId + '/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: desktopDeviceId, device_name: desktopDeviceName })
        });
        const data = await res.json();
        if (!data.success) { showNotification(data.error || 'Failed', 'error'); return; }

        _deskGrpCallId = callId;
        _deskGrpCallType = callType;
        await _deskGrpSetupLocal(callType);
        _deskGrpShowOverlay();
        _deskGrpStartSignalPoll();
        _deskGrpAddLocalTile();

        for (const peerId of (data.connected || [])) {
            if (peerId !== desktopDeviceId) {
                await _deskGrpConnectPeer(peerId, true);
            }
        }
        showNotification('Joined group call', 'info');
    } catch (e) {
        console.error('[GrpCall] join error:', e);
        showNotification('Failed to join', 'error');
    }
}

async function _deskGrpSetupLocal(callType) {
    _deskGrpLocalStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video'
    });
}

function _deskGrpShowOverlay() {
    const overlay = document.getElementById('deskGroupCallOverlay');
    if (overlay) overlay.style.display = 'flex';
    const title = document.getElementById('deskGroupCallTitle');
    if (title) title.textContent = (_currentGroupData ? _currentGroupData.name : 'Group') + ' Call';

    _deskGrpCallSecs = 0;
    if (_deskGrpCallTimer) clearInterval(_deskGrpCallTimer);
    _deskGrpCallTimer = setInterval(() => {
        _deskGrpCallSecs++;
        const m = String(Math.floor(_deskGrpCallSecs / 60)).padStart(2, '0');
        const s = String(_deskGrpCallSecs % 60).padStart(2, '0');
        const el = document.getElementById('deskGroupCallTimer');
        if (el) el.textContent = m + ':' + s;
    }, 1000);
}

function _deskGrpAddLocalTile() {
    const grid = document.getElementById('deskGroupCallGrid');
    if (!grid) return;
    // Remove existing local tile if any
    const old = document.getElementById('deskGrpTile_local');
    if (old) old.remove();
    const tile = document.createElement('div');
    tile.className = 'desk-grp-call-tile';
    tile.id = 'deskGrpTile_local';
    const hasVideo = _deskGrpLocalStream && _deskGrpLocalStream.getVideoTracks().length > 0
        && _deskGrpLocalStream.getVideoTracks()[0].enabled;
    console.log('[GrpCall] Local tile — hasVideo:', hasVideo, 'callType:', _deskGrpCallType);
    if (hasVideo) {
        const vid = document.createElement('video');
        vid.id = 'deskGrpLocalVideo';
        vid.srcObject = _deskGrpLocalStream;
        vid.autoplay = true; vid.playsInline = true; vid.muted = true;
        tile.appendChild(vid);
    } else {
        tile.innerHTML = '<div class="desk-grp-call-tile-avatar"><div class="avatar-circle"><i class="fas fa-user"></i></div></div>';
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'desk-grp-call-tile-name';
    nameEl.textContent = 'You';
    tile.appendChild(nameEl);
    grid.appendChild(tile);
    _deskGrpUpdateGridLayout();
}

function _deskGrpAddRemoteTile(peerId, stream) {
    const grid = document.getElementById('deskGroupCallGrid');
    if (!grid) return;
    const old = document.getElementById('deskGrpTile_' + peerId);
    if (old) old.remove();

    const tile = document.createElement('div');
    tile.className = 'desk-grp-call-tile';
    tile.id = 'deskGrpTile_' + peerId;

    const hasEnabledVideo = stream && stream.getVideoTracks().length > 0
        && stream.getVideoTracks().some(t => t.enabled && !t.muted);
    if (hasEnabledVideo) {
        const vid = document.createElement('video');
        vid.srcObject = stream;
        vid.autoplay = true; vid.playsInline = true;
        tile.appendChild(vid);
        vid.play().catch(e => console.warn('[GrpCall] video play:', e));
    } else {
        tile.innerHTML = '<div class="desk-grp-call-tile-avatar"><div class="avatar-circle"><i class="fas fa-user"></i></div></div>';
    }
    // Always attach a separate hidden <audio> for reliable audio playback
    if (stream) {
        const aud = document.createElement('audio');
        aud.srcObject = stream; aud.autoplay = true;
        aud.style.display = 'none';
        tile.appendChild(aud);
        aud.play().catch(e => console.warn('[GrpCall] audio play:', e));
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'desk-grp-call-tile-name';
    nameEl.textContent = peerId.substring(0, 10);
    tile.appendChild(nameEl);
    grid.appendChild(tile);
    _deskGrpUpdateGridLayout();
}

function _deskGrpRemoveTile(peerId) {
    const tile = document.getElementById('deskGrpTile_' + peerId);
    if (tile) tile.remove();
    _deskGrpUpdateGridLayout();
}

function _deskGrpUpdateGridLayout() {
    const grid = document.getElementById('deskGroupCallGrid');
    if (!grid) return;
    const count = grid.children.length;
    grid.classList.remove('cols-1', 'cols-3');
    if (count <= 1) grid.classList.add('cols-1');
    else if (count >= 3) grid.classList.add('cols-3');
}

async function _deskGrpConnectPeer(peerId, isInitiator) {
    if (_deskGrpPeers[peerId]) return;

    const pc = new RTCPeerConnection(_rtcConfig);
    _deskGrpPeers[peerId] = { pc: pc, remoteStream: null };

    if (_deskGrpLocalStream) {
        _deskGrpLocalStream.getTracks().forEach(t => pc.addTrack(t, _deskGrpLocalStream));
    }

    pc.ontrack = (event) => {
        console.log('[GrpCall] Remote track from', peerId, event.track.kind);
        const peer = _deskGrpPeers[peerId];
        if (peer) {
            peer.remoteStream = event.streams[0];
            _deskGrpAddRemoteTile(peerId, event.streams[0]);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            fetch(API_BASE + '/calls/signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from_id: desktopDeviceId, to_id: peerId,
                    signal_type: 'ice-candidate', call_id: _deskGrpCallId,
                    payload: event.candidate.toJSON()
                })
            }).catch(e => console.error('[GrpCall] ICE signal error:', e));
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log('[GrpCall] ICE state for', peerId, ':', pc.iceConnectionState);
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            _deskGrpDisconnectPeer(peerId);
        }
    };

    if (isInitiator) {
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await fetch(API_BASE + '/calls/signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from_id: desktopDeviceId, to_id: peerId,
                    signal_type: 'offer', call_id: _deskGrpCallId,
                    payload: { type: offer.type, sdp: offer.sdp }
                })
            });
            console.log('[GrpCall] Sent offer to', peerId);
        } catch (e) {
            console.error('[GrpCall] Offer error:', e);
        }
    }
}

function _deskGrpDisconnectPeer(peerId) {
    const peer = _deskGrpPeers[peerId];
    if (peer) {
        if (peer.pc) { try { peer.pc.close(); } catch(e) {} }
        delete _deskGrpPeers[peerId];
    }
    _deskGrpRemoveTile(peerId);
}

function _deskGrpStartSignalPoll() {
    if (_deskGrpSignalPoll) clearInterval(_deskGrpSignalPoll);
    _deskGrpSignalPoll = setInterval(async () => {
        if (!_deskGrpCallId) { clearInterval(_deskGrpSignalPoll); return; }
        try {
            const res = await fetch(API_BASE + '/calls/signals/' + desktopDeviceId);
            const data = await res.json();
            for (const signal of (data.signals || [])) {
                if (signal.call_id !== _deskGrpCallId) continue;
                const fromId = signal.from_id;

                if (signal.type === 'offer') {
                    if (!_deskGrpPeers[fromId]) {
                        await _deskGrpConnectPeer(fromId, false);
                    }
                    const peer = _deskGrpPeers[fromId];
                    if (peer && peer.pc) {
                        await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
                        const answer = await peer.pc.createAnswer();
                        await peer.pc.setLocalDescription(answer);
                        await fetch(API_BASE + '/calls/signal', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                from_id: desktopDeviceId, to_id: fromId,
                                signal_type: 'answer', call_id: _deskGrpCallId,
                                payload: { type: answer.type, sdp: answer.sdp }
                            })
                        });
                        console.log('[GrpCall] Sent answer to', fromId);
                    }
                } else if (signal.type === 'answer') {
                    const peer = _deskGrpPeers[fromId];
                    if (peer && peer.pc && peer.pc.signalingState === 'have-local-offer') {
                        await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
                        console.log('[GrpCall] Answer received from', fromId);
                    }
                } else if (signal.type === 'ice-candidate') {
                    const peer = _deskGrpPeers[fromId];
                    if (peer && peer.pc) {
                        try {
                            await peer.pc.addIceCandidate(new RTCIceCandidate(signal.payload));
                        } catch(e) { console.warn('[GrpCall] ICE error:', e); }
                    }
                } else if (signal.type === 'group-call-join') {
                    console.log('[GrpCall] Peer joined:', fromId);
                    showNotification((signal.from_name || 'Someone') + ' joined the call', 'info');
                    if (!_deskGrpPeers[fromId]) {
                        await _deskGrpConnectPeer(fromId, true);
                    }
                } else if (signal.type === 'group-call-leave') {
                    console.log('[GrpCall] Peer left:', fromId);
                    showNotification('Someone left the call', 'info');
                    _deskGrpDisconnectPeer(fromId);
                } else if (signal.type === 'call-end') {
                    console.log('[GrpCall] Call ended');
                    showNotification('Group call ended', 'info');
                    _deskGrpCallId = null;
                    deskGrpEndCall();
                    return;
                }
            }
        } catch (e) { console.error('[GrpCall] Signal poll error:', e); }
    }, 800);
}

function deskGrpToggleMute() {
    if (!_deskGrpLocalStream) return;
    const track = _deskGrpLocalStream.getAudioTracks()[0];
    if (track) {
        track.enabled = !track.enabled;
        const btn = document.getElementById('deskGrpBtnMute');
        if (btn) {
            btn.innerHTML = track.enabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
            btn.classList.toggle('active', !track.enabled);
        }
    }
}

function deskGrpToggleCamera() {
    if (!_deskGrpLocalStream) return;
    const track = _deskGrpLocalStream.getVideoTracks()[0];
    if (track) {
        track.enabled = !track.enabled;
        const btn = document.getElementById('deskGrpBtnCamera');
        if (btn) {
            btn.innerHTML = track.enabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
            btn.classList.toggle('active', !track.enabled);
        }
        // Update local tile to show/hide video
        _deskGrpAddLocalTile();
    }
}

async function deskGrpEndCall() {
    if (_deskGrpCallId) {
        try {
            await fetch(API_BASE + '/calls/' + _deskGrpCallId + '/leave', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: desktopDeviceId })
            });
        } catch(e) {}
    }

    for (const peerId of Object.keys(_deskGrpPeers)) {
        _deskGrpDisconnectPeer(peerId);
    }
    _deskGrpPeers = {};

    if (_deskGrpLocalStream) {
        _deskGrpLocalStream.getTracks().forEach(t => t.stop());
        _deskGrpLocalStream = null;
    }

    if (_deskGrpSignalPoll) { clearInterval(_deskGrpSignalPoll); _deskGrpSignalPoll = null; }
    if (_deskGrpCallTimer) { clearInterval(_deskGrpCallTimer); _deskGrpCallTimer = null; }

    _deskGrpCallId = null;
    _deskGrpCallSecs = 0;

    const overlay = document.getElementById('deskGroupCallOverlay');
    if (overlay) overlay.style.display = 'none';
    const grid = document.getElementById('deskGroupCallGrid');
    if (grid) grid.innerHTML = '';

    const muteBtn = document.getElementById('deskGrpBtnMute');
    if (muteBtn) { muteBtn.innerHTML = '<i class="fas fa-microphone"></i>'; muteBtn.classList.remove('active'); }
    const camBtn = document.getElementById('deskGrpBtnCamera');
    if (camBtn) { camBtn.innerHTML = '<i class="fas fa-video"></i>'; camBtn.classList.remove('active'); }

    showNotification('Left group call', 'info');
}

async function deskCheckActiveGroupCall() {
    if (!_currentGroupId) return;
    try {
        const res = await fetch(API_BASE + '/calls/group/active/' + _currentGroupId);
        const data = await res.json();
        if (data.active && data.call_id !== _deskGrpCallId) {
            _deskGrpShowJoinBanner(data);
        }
    } catch(e) {}
}

function _deskGrpShowJoinBanner(data) {
    const oldBanner = document.getElementById('deskGrpCallBanner');
    if (oldBanner) oldBanner.remove();

    const panel = document.getElementById('deskGroupChatPanel');
    if (!panel) return;
    const overlay = document.getElementById('deskGroupCallOverlay');

    const banner = document.createElement('div');
    banner.className = 'desk-grp-call-banner';
    banner.id = 'deskGrpCallBanner';
    banner.innerHTML = `
        <div class="desk-grp-call-banner-info">
            <i class="fas fa-phone-alt"></i>
            <span>${(data.connected || []).length} in call</span>
        </div>
        <button class="desk-grp-call-join-btn" onclick="deskJoinGroupCall('${data.call_id}','${data.call_type}')">
            Join
        </button>`;
    if (overlay) overlay.parentNode.insertBefore(banner, overlay);
    else panel.insertBefore(banner, panel.firstChild);
}


// ═══════════════════════════════════════════════════════════════
// BOTS & AUTO-CALLBACK
// ═══════════════════════════════════════════════════════════════

let _editingBotId = null;
let _botChatId = null;
let _botChatHistory = [];

// ═══════════════════════════════════════════════════════════════
// AI ASSISTANT (BEAM AI)
// ═══════════════════════════════════════════════════════════════

let _aiCurrentTool = null;
let _aiDelegationLoaded = false;

async function loadBotsPage() {
  // Load AI panels data
  loadAiTasks();
  loadAiReminders();
  loadAiDelegation();
  // Also load legacy bots
  loadBotsList();
}

/* ── AI Chat ── */

// ─── Pause/Resume state for AI typing ───
let _deskAiTypingPaused = false;
let _deskAiTypingAborted = false;
let _deskAiCurrentTypingBubble = null;

function deskAiTogglePause() {
    _deskAiTypingPaused = !_deskAiTypingPaused;
    const btn = document.getElementById('deskAiPauseBtn');
    if (btn) {
        if (_deskAiTypingPaused) {
            btn.innerHTML = '<i class="fas fa-play"></i>';
            btn.title = 'Resume typing';
            btn.classList.add('paused');
            // Pause audio too
            if (_deskAiCurrentAudio && !_deskAiCurrentAudio.paused) {
                try { _deskAiCurrentAudio.pause(); } catch(e) {}
            }
        } else {
            btn.innerHTML = '<i class="fas fa-pause"></i>';
            btn.title = 'Pause typing';
            btn.classList.remove('paused');
            // Resume audio too
            if (_deskAiCurrentAudio && _deskAiCurrentAudio.paused) {
                try { _deskAiCurrentAudio.play(); } catch(e) {}
            }
        }
    }
}

// ─── Highlight-Ask Popup ───
let _deskAiHighlightPopup = null;
function _deskAiInitHighlightAsk() {
    const area = document.getElementById('aiChatMessages');
    if (!area) return;
    area.addEventListener('mouseup', (e) => {
        const sel = window.getSelection();
        const selectedText = sel.toString().trim();
        if (_deskAiHighlightPopup) { _deskAiHighlightPopup.remove(); _deskAiHighlightPopup = null; }
        if (!selectedText || selectedText.length < 3) return;
        // Only trigger on bot message text
        const bubble = e.target.closest('.ai-msg-bot .ai-msg-bubble, .ai-msg-bot .ai-msg-text');
        if (!bubble) return;
        // Find the full bot message text for context
        const msgText = bubble.closest('.ai-msg-bubble');
        const fullContext = msgText ? msgText.querySelector('.ai-msg-text')?.textContent || '' : '';
        // Create popup near selection
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        const popup = document.createElement('div');
        popup.className = 'ai-highlight-popup';
        popup.innerHTML = `
            <div class="ai-highlight-header"><i class="fas fa-quote-left"></i> "${selectedText.length > 60 ? selectedText.slice(0,57)+'...' : selectedText}"</div>
            <input class="ai-highlight-input" type="text" placeholder="Ask about this..." autofocus>
            <div class="ai-highlight-actions">
                <button class="ai-highlight-btn ask" title="Ask"><i class="fas fa-paper-plane"></i> Ask</button>
                <button class="ai-highlight-btn explain" title="Explain"><i class="fas fa-lightbulb"></i> Explain</button>
                <button class="ai-highlight-btn deeper" title="Go deeper"><i class="fas fa-search-plus"></i> Deeper</button>
                <button class="ai-highlight-btn close" title="Close"><i class="fas fa-times"></i></button>
            </div>`;
        popup.style.position = 'fixed';
        popup.style.left = Math.min(rect.left, window.innerWidth - 340) + 'px';
        popup.style.top = (rect.top - 140) + 'px';
        document.body.appendChild(popup);
        _deskAiHighlightPopup = popup;

        const input = popup.querySelector('.ai-highlight-input');
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && input.value.trim()) {
                _deskAiSendHighlightQuestion(selectedText, input.value.trim(), fullContext);
                popup.remove(); _deskAiHighlightPopup = null;
            }
            if (ev.key === 'Escape') { popup.remove(); _deskAiHighlightPopup = null; }
        });
        popup.querySelector('.ask').onclick = () => {
            const q = input.value.trim() || `Tell me more about: "${selectedText}"`;
            _deskAiSendHighlightQuestion(selectedText, q, fullContext);
            popup.remove(); _deskAiHighlightPopup = null;
        };
        popup.querySelector('.explain').onclick = () => {
            _deskAiSendHighlightQuestion(selectedText, `Explain this in detail: "${selectedText}"`, fullContext);
            popup.remove(); _deskAiHighlightPopup = null;
        };
        popup.querySelector('.deeper').onclick = () => {
            _deskAiSendHighlightQuestion(selectedText, `Go deeper on this topic: "${selectedText}"`, fullContext);
            popup.remove(); _deskAiHighlightPopup = null;
        };
        popup.querySelector('.close').onclick = () => { popup.remove(); _deskAiHighlightPopup = null; };
        setTimeout(() => input.focus(), 50);
    });
    // Close popup on click outside
    document.addEventListener('mousedown', (e) => {
        if (_deskAiHighlightPopup && !_deskAiHighlightPopup.contains(e.target)) {
            _deskAiHighlightPopup.remove(); _deskAiHighlightPopup = null;
        }
    });
}

async function _deskAiSendHighlightQuestion(highlighted, question, contextFrom) {
    const area = document.getElementById('aiChatMessages');
    if (!area) return;
    // Show user bubble with highlight reference
    area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-user">
        <div class="ai-msg-avatar"><i class="fas fa-user"></i></div>
        <div class="ai-msg-bubble">
            <div class="ai-highlight-ref"><i class="fas fa-quote-left"></i> ${escapeHtml(highlighted.length > 100 ? highlighted.slice(0,97)+'...' : highlighted)}</div>
            <div class="ai-msg-text">${escapeHtml(question)}</div>
            <div class="ai-msg-time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
        </div>
    </div>`);
    const typingId = 'typing-' + Date.now();
    area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-bot" id="${typingId}">
        <div class="ai-msg-avatar"><i class="fas fa-brain"></i></div>
        <div class="ai-msg-bubble"><div class="ai-typing"><span></span><span></span><span></span></div></div>
    </div>`);
    area.scrollTop = area.scrollHeight;
    try {
        const res = await fetch(`${API_BASE}/ai/chat`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                owner_id: desktopDeviceId,
                text: question,
                highlighted_text: highlighted,
                context_from: contextFrom
            })
        });
        const data = await res.json();
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();
        const reply = data.reply || 'No response';
        const msgDiv = document.createElement('div');
        msgDiv.className = 'ai-msg ai-msg-bot';
        msgDiv.innerHTML = `<div class="ai-msg-avatar"><i class="fas fa-brain"></i></div><div class="ai-msg-bubble"><div class="ai-msg-text"></div></div>`;
        area.appendChild(msgDiv);
        const textEl = msgDiv.querySelector('.ai-msg-text');
        // Show pause button
        const pauseBtn = document.createElement('button');
        pauseBtn.id = 'deskAiPauseBtn';
        pauseBtn.className = 'ai-pause-btn';
        pauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
        pauseBtn.title = 'Pause typing';
        pauseBtn.onclick = deskAiTogglePause;
        msgDiv.querySelector('.ai-msg-bubble').appendChild(pauseBtn);
        await deskTypeWords(textEl, reply, area, 18);
        pauseBtn.remove();
        const bubble = msgDiv.querySelector('.ai-msg-bubble');
        bubble.insertAdjacentHTML('beforeend', `<div class="ai-msg-time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>`);
        _deskAiAddVoicePlayback(bubble, reply, null, null, false);
        area.scrollTop = area.scrollHeight;
    } catch(e) {
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();
        area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-bot"><div class="ai-msg-avatar"><i class="fas fa-brain"></i></div><div class="ai-msg-bubble"><div class="ai-msg-text" style="color:#EF4444">Connection error.</div></div></div>`);
    }
}

// Initialize highlight-ask on page load
setTimeout(_deskAiInitHighlightAsk, 1000);

// ─── On page load: keep chat clean (AI remembers via server-side history) ───
async function _deskAiLoadHistory() {
    // Don't render old messages — start fresh each time.
    // The backend already passes conversation history to the AI as context.
    // User can click History button to view past chats.
}

// ─── Show past conversation history on demand ───
let _deskAiHistoryVisible = false;
async function deskAiShowHistory() {
    const area = document.getElementById('aiChatMessages');
    if (!area) return;

    if (_deskAiHistoryVisible) {
        area.innerHTML = `<div class="ai-msg ai-msg-bot"><div class="ai-msg-avatar"><i class="fas fa-brain"></i></div><div class="ai-msg-bubble"><div class="ai-msg-text">Hey! I'm <strong>BEAM AI</strong>. Ask me anything — I can search the web, set reminders, analyze files, and much more.</div></div></div>`;
        _deskAiHistoryVisible = false;
        showNotification('History hidden', 'info');
        return;
    }

    if (!desktopDeviceId) { showNotification('Not connected', 'error'); return; }
    try {
        const res = await fetch(`${API_BASE}/ai/chat-history?owner_id=${encodeURIComponent(desktopDeviceId)}&limit=50`);
        const data = await res.json();
        if (!data.success || !data.messages || !data.messages.length) {
            showNotification('No conversation history yet', 'info');
            return;
        }
        area.innerHTML = '';
        area.insertAdjacentHTML('beforeend', `<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:12px;border-bottom:1px solid var(--border);margin-bottom:10px"><i class="fas fa-history" style="margin-right:5px"></i> Past Conversations (${data.messages.length} messages)</div>`);
        for (const msg of data.messages) {
            const isUser = msg.role === 'user';
            const time = msg.timestamp ? new Date(msg.timestamp * 1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
            if (isUser) {
                area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-user" style="opacity:0.7"><div class="ai-msg-avatar"><i class="fas fa-user"></i></div><div class="ai-msg-bubble"><div class="ai-msg-text">${escapeHtml(msg.content)}</div><div class="ai-msg-time">${time}</div></div></div>`);
            } else {
                let html = escapeHtml(msg.content).replace(/\n/g, '<br>');
                html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-bot" style="opacity:0.7"><div class="ai-msg-avatar"><i class="fas fa-brain"></i></div><div class="ai-msg-bubble"><div class="ai-msg-text">${html}</div><div class="ai-msg-time">${time}</div></div></div>`);
            }
        }
        area.insertAdjacentHTML('beforeend', `<div style="text-align:center;padding:12px;color:var(--primary);font-size:12px;border-top:1px solid var(--border);margin-top:10px"><i class="fas fa-comment-dots" style="margin-right:5px"></i> Current Session</div>`);
        area.scrollTop = area.scrollHeight;
        _deskAiHistoryVisible = true;
        showNotification('Showing conversation history', 'info');
    } catch(e) {
        console.log('Could not load AI chat history:', e);
        showNotification('Failed to load history', 'error');
    }
}

/**
 * Word-by-word typing with pause/resume support
 */
function deskTypeWords(bubbleEl, text, scrollContainer, speed = 35) {
    _deskAiTypingPaused = false;
    _deskAiTypingAborted = false;
    _deskAiCurrentTypingBubble = bubbleEl;
    return new Promise(resolve => {
        const words = text.split(/(\s+)/);
        let i = 0;
        bubbleEl.textContent = '';
        const cursor = document.createElement('span');
        cursor.className = 'desk-ai-cursor';
        cursor.textContent = '▊';
        bubbleEl.appendChild(cursor);
        function nextWord() {
            if (_deskAiTypingAborted) {
                if (cursor.parentNode) cursor.remove();
                bubbleEl.textContent = text;
                let html = escapeHtml(text).replace(/\n/g, '<br>');
                html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                bubbleEl.innerHTML = html;
                resolve();
                return;
            }
            if (_deskAiTypingPaused) {
                requestAnimationFrame(() => setTimeout(nextWord, 100));
                return;
            }
            if (i >= words.length) {
                if (cursor.parentNode) cursor.remove();
                let html = bubbleEl.textContent;
                html = escapeHtml(html).replace(/\n/g, '<br>');
                html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                bubbleEl.innerHTML = html;
                _deskAiCurrentTypingBubble = null;
                resolve();
                return;
            }
            cursor.insertAdjacentText('beforebegin', words[i]);
            i++;
            if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
            requestAnimationFrame(() => setTimeout(nextWord, speed));
        }
        nextWord();
    });
}

// ─── AI Chat Custom Voice Note Player ───
function _buildAiVoiceNotePlayer(audioSrc, uid) {
    const id = uid || ('aivn-' + Date.now() + Math.random().toString(36).slice(2,6));
    const barCount = 32;
    let barsHtml = '';
    for (let i = 0; i < barCount; i++) {
        const h = Math.floor(Math.random() * 16) + 4;
        barsHtml += `<div class="ai-vnote-bar" data-h="${h}" style="height:${h}px"></div>`;
    }
    return `<div class="ai-vnote-player" data-vnid="${id}">
        <button class="ai-vnote-play" data-vnid="${id}"><i class="fas fa-play"></i></button>
        <div class="ai-vnote-body">
            <div class="ai-vnote-waveform" data-vnid="${id}">${barsHtml}</div>
            <div class="ai-vnote-meta">
                <span class="ai-vnote-time" data-vnid="${id}">0:00</span>
                <button class="ai-vnote-speed" data-vnid="${id}">1x</button>
            </div>
        </div>
        <audio preload="auto" src="${audioSrc}" data-vnid="${id}" style="display:none"></audio>
    </div>`;
}

function _initAiVoiceNotePlayers() {
    document.querySelectorAll('.ai-vnote-player:not(.inited)').forEach(player => {
        player.classList.add('inited');
        const vnid = player.dataset.vnid;
        const audio = player.querySelector('audio');
        const playBtn = player.querySelector('.ai-vnote-play');
        const waveform = player.querySelector('.ai-vnote-waveform');
        const timeEl = player.querySelector('.ai-vnote-time');
        const speedBtn = player.querySelector('.ai-vnote-speed');
        const bars = waveform.querySelectorAll('.ai-vnote-bar');
        const speeds = [1, 1.5, 2, 0.5];
        let speedIdx = 0;

        function formatT(s) { const m = Math.floor(s/60); const sec = Math.floor(s%60); return m + ':' + (sec<10?'0':'') + sec; }

        audio.addEventListener('loadedmetadata', () => {
            timeEl.textContent = '0:00 / ' + formatT(audio.duration);
        });
        audio.addEventListener('timeupdate', () => {
            if (!audio.duration) return;
            const pct = audio.currentTime / audio.duration;
            const activeN = Math.floor(pct * bars.length);
            bars.forEach((b, i) => {
                b.classList.toggle('active', i < activeN);
                b.style.height = (i < activeN ? b.dataset.h : Math.max(3, parseInt(b.dataset.h)*0.6)) + 'px';
            });
            timeEl.textContent = formatT(audio.currentTime) + ' / ' + formatT(audio.duration);
        });
        audio.addEventListener('ended', () => {
            playBtn.innerHTML = '<i class="fas fa-play"></i>';
            bars.forEach(b => { b.classList.remove('active'); b.style.height = b.dataset.h + 'px'; });
            timeEl.textContent = formatT(audio.duration);
        });

        playBtn.addEventListener('click', () => {
            if (audio.paused) {
                // Pause any other playing AI voice notes
                document.querySelectorAll('.ai-vnote-player audio').forEach(a => { if (a !== audio && !a.paused) { a.pause(); a.currentTime = 0; } });
                document.querySelectorAll('.ai-vnote-play').forEach(b => b.innerHTML = '<i class="fas fa-play"></i>');
                audio.play();
                playBtn.innerHTML = '<i class="fas fa-pause"></i>';
            } else {
                audio.pause();
                playBtn.innerHTML = '<i class="fas fa-play"></i>';
            }
        });

        waveform.addEventListener('click', (e) => {
            if (!audio.duration) return;
            const rect = waveform.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            audio.currentTime = pct * audio.duration;
        });

        speedBtn.addEventListener('click', () => {
            speedIdx = (speedIdx + 1) % speeds.length;
            audio.playbackRate = speeds[speedIdx];
            speedBtn.textContent = speeds[speedIdx] + 'x';
        });
    });
}

// ─── AI Chat Video Player Helper ───
function _buildAiVideoPlayer(videoSrc, poster) {
    const id = 'aivid-' + Date.now() + Math.random().toString(36).slice(2,6);
    return `<div class="ai-video-container" data-vid="${id}">
        <video preload="metadata" src="${videoSrc}" ${poster ? 'poster="'+poster+'"' : ''} data-vid="${id}"></video>
        <div class="ai-video-overlay" data-vid="${id}">
            <div class="ai-video-play-icon"><i class="fas fa-play"></i></div>
        </div>
        <div class="ai-video-controls">
            <button class="ai-video-ctrl-btn ai-vid-playpause" data-vid="${id}"><i class="fas fa-play"></i></button>
            <div class="ai-video-progress" data-vid="${id}"><div class="ai-video-progress-fill"></div></div>
            <span class="ai-video-time" data-vid="${id}">0:00 / 0:00</span>
            <button class="ai-video-ctrl-btn ai-vid-fullscreen" data-vid="${id}"><i class="fas fa-expand"></i></button>
        </div>
    </div>`;
}

function _initAiVideoPlayers() {
    document.querySelectorAll('.ai-video-container:not(.inited)').forEach(container => {
        container.classList.add('inited');
        const video = container.querySelector('video');
        const overlay = container.querySelector('.ai-video-overlay');
        const playPause = container.querySelector('.ai-vid-playpause');
        const progressBar = container.querySelector('.ai-video-progress');
        const progressFill = container.querySelector('.ai-video-progress-fill');
        const timeEl = container.querySelector('.ai-video-time');
        const fsBtn = container.querySelector('.ai-vid-fullscreen');

        function formatT(s) { const m = Math.floor(s/60); const sec = Math.floor(s%60); return m + ':' + (sec<10?'0':'') + sec; }

        function togglePlay() {
            if (video.paused) {
                video.play();
                overlay.classList.add('hidden');
                playPause.innerHTML = '<i class="fas fa-pause"></i>';
            } else {
                video.pause();
                playPause.innerHTML = '<i class="fas fa-play"></i>';
            }
        }

        overlay.addEventListener('click', togglePlay);
        playPause.addEventListener('click', togglePlay);
        video.addEventListener('click', togglePlay);

        video.addEventListener('loadedmetadata', () => {
            timeEl.textContent = '0:00 / ' + formatT(video.duration);
        });
        video.addEventListener('timeupdate', () => {
            if (!video.duration) return;
            const pct = (video.currentTime / video.duration) * 100;
            progressFill.style.width = pct + '%';
            timeEl.textContent = formatT(video.currentTime) + ' / ' + formatT(video.duration);
        });
        video.addEventListener('ended', () => {
            overlay.classList.remove('hidden');
            playPause.innerHTML = '<i class="fas fa-play"></i>';
            progressFill.style.width = '0%';
        });

        progressBar.addEventListener('click', (e) => {
            if (!video.duration) return;
            const rect = progressBar.getBoundingClientRect();
            video.currentTime = ((e.clientX - rect.left) / rect.width) * video.duration;
        });

        fsBtn.addEventListener('click', () => {
            if (video.requestFullscreen) video.requestFullscreen();
            else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
        });
    });
}

// ─── Neural Voice Playback for AI Replies ───
let _deskAiCurrentAudio = null;

function _deskAiAddVoicePlayback(bubbleEl, text, preloadedAudio, audioFormat, autoPlay) {
    if (!bubbleEl || !text) return;
    const btnId = 'ai-voice-' + Date.now() + Math.random().toString(36).slice(2,6);
    const voiceBtn = document.createElement('div');
    voiceBtn.className = 'ai-voice-btn';
    voiceBtn.id = btnId;
    voiceBtn.innerHTML = `<i class="fas fa-volume-up"></i> <span>Listen</span>`;
    voiceBtn.title = 'Listen to AI reply';
    bubbleEl.appendChild(voiceBtn);

    let audioEl = null;
    let isLoading = false;

    async function playAudio() {
        // Stop any currently playing audio
        if (_deskAiCurrentAudio) {
            try { _deskAiCurrentAudio.pause(); _deskAiCurrentAudio.currentTime = 0; } catch(e) {}
            _deskAiCurrentAudio = null;
        }
        // If we already have audio loaded, toggle play
        if (audioEl) {
            if (audioEl.paused) {
                voiceBtn.innerHTML = `<i class="fas fa-pause"></i> <span>Playing...</span>`;
                voiceBtn.classList.add('playing');
                _deskAiCurrentAudio = audioEl;
                audioEl.play();
            } else {
                audioEl.pause(); audioEl.currentTime = 0;
                voiceBtn.innerHTML = `<i class="fas fa-volume-up"></i> <span>Listen</span>`;
                voiceBtn.classList.remove('playing');
            }
            return;
        }

        if (isLoading) return;
        isLoading = true;
        voiceBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> <span>Generating voice...</span>`;
        voiceBtn.classList.add('loading');

        try {
            let b64Audio = preloadedAudio;
            let fmt = audioFormat || 'mp3';

            if (!b64Audio) {
                // Fetch TTS from server
                const res = await fetch(`${API_BASE}/ai/tts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: text })
                });
                if (res.ok) {
                    const data = await res.json();
                    b64Audio = data.audio;
                    fmt = data.format || 'mp3';
                }
            }

            if (b64Audio) {
                const mimeType = fmt === 'wav' ? 'audio/wav' : 'audio/mpeg';
                audioEl = new Audio(`data:${mimeType};base64,${b64Audio}`);
                audioEl.onended = () => {
                    voiceBtn.innerHTML = `<i class="fas fa-volume-up"></i> <span>Listen</span>`;
                    voiceBtn.classList.remove('playing');
                    _deskAiCurrentAudio = null;
                };
                audioEl.onerror = () => {
                    voiceBtn.innerHTML = `<i class="fas fa-volume-up"></i> <span>Listen</span>`;
                    voiceBtn.classList.remove('playing', 'loading');
                    audioEl = null;
                };
                voiceBtn.innerHTML = `<i class="fas fa-pause"></i> <span>Playing...</span>`;
                voiceBtn.classList.remove('loading');
                voiceBtn.classList.add('playing');
                _deskAiCurrentAudio = audioEl;
                audioEl.play();
            } else {
                // Server TTS failed — show error, do NOT fall back to robotic browser voice
                voiceBtn.innerHTML = `<i class="fas fa-exclamation-triangle"></i> <span>Voice unavailable</span>`;
                voiceBtn.classList.remove('loading', 'playing');
                setTimeout(() => {
                    voiceBtn.innerHTML = `<i class="fas fa-volume-up"></i> <span>Retry</span>`;
                    voiceBtn.classList.remove('loading', 'playing');
                }, 3000);
            }
        } catch(e) {
            console.warn('TTS fetch error:', e);
            voiceBtn.innerHTML = `<i class="fas fa-exclamation-triangle"></i> <span>Voice unavailable</span>`;
            voiceBtn.classList.remove('loading', 'playing');
            setTimeout(() => {
                voiceBtn.innerHTML = `<i class="fas fa-volume-up"></i> <span>Retry</span>`;
                voiceBtn.classList.remove('loading', 'playing');
            }, 3000);
        }
        isLoading = false;
    }

    // No browser SpeechSynthesis fallback — we only use Edge Neural TTS

    voiceBtn.onclick = playAudio;

    // Auto-play for voice note conversations
    if (autoPlay && preloadedAudio) {
        setTimeout(() => playAudio(), 300);
    }
}


async function sendAiMessage(overrideText) {
  const input = document.getElementById('aiChatInput');
  const text = overrideText || (input ? input.value.trim() : '');
  if (!text) return;
  if (!overrideText && input) input.value = '';

  const area = document.getElementById('aiChatMessages');
  // Add user message
  area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-user">
    <div class="ai-msg-avatar"><i class="fas fa-user"></i></div>
    <div class="ai-msg-bubble"><div class="ai-msg-text">${escapeHtml(text)}</div>
    <div class="ai-msg-time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div></div>
  </div>`);
  // Show typing indicator
  const typingId = 'typing-' + Date.now();
  area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-bot" id="${typingId}">
    <div class="ai-msg-avatar"><i class="fas fa-brain"></i></div>
    <div class="ai-msg-bubble"><div class="ai-typing"><span></span><span></span><span></span></div></div>
  </div>`);
  area.scrollTop = area.scrollHeight;

  const sendBtn = document.getElementById('aiSendBtn');
  if (sendBtn) sendBtn.disabled = true;

  try {
    // Auto-retry logic — up to 3 attempts with backoff
    let data = null;
    let lastErr = null;
    for (let _attempt = 1; _attempt <= 3; _attempt++) {
      try {
        const res = await fetch(`${API_BASE}/ai/chat`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ owner_id: desktopDeviceId, text })
        });
        if (!res.ok) throw new Error('Server returned ' + res.status);
        data = await res.json();
        if (data.error) throw new Error(data.error);
        break; // success
      } catch (retryErr) {
        lastErr = retryErr;
        console.warn(`AI chat attempt ${_attempt}/3 failed:`, retryErr);
        if (_attempt < 3) await new Promise(r => setTimeout(r, _attempt * 1500));
      }
    }
    if (!data || data.error) throw lastErr || new Error('No response after retries');

    // Remove typing indicator
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    const reply = data.reply || 'No response';

    // Actions badges
    let actionsBadges = '';
    if (data.actions && data.actions.length > 0) {
      for (const a of data.actions) {
        if (a.type === 'task_created') {
          actionsBadges += `<span class="ai-action-badge task"><i class="fas fa-check-circle"></i> Task created: ${escapeHtml(a.task.title)}</span>`;
          loadAiTasks();
        } else if (a.type === 'reminder_created') {
          actionsBadges += `<span class="ai-action-badge reminder"><i class="fas fa-bell"></i> Reminder set: ${escapeHtml(a.reminder.text)}</span>`;
          loadAiReminders();
        }
      }
    }

    // Create message with empty bubble for typing animation
    const msgDiv = document.createElement('div');
    msgDiv.className = 'ai-msg ai-msg-bot';
    msgDiv.innerHTML = `<div class="ai-msg-avatar"><i class="fas fa-brain"></i></div><div class="ai-msg-bubble"><div class="ai-msg-text"></div></div>`;
    area.appendChild(msgDiv);
    const textEl = msgDiv.querySelector('.ai-msg-text');

    // Add pause button during typing
    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'deskAiPauseBtn';
    pauseBtn.className = 'ai-pause-btn';
    pauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
    pauseBtn.title = 'Pause typing';
    pauseBtn.onclick = deskAiTogglePause;
    msgDiv.querySelector('.ai-msg-bubble').appendChild(pauseBtn);

    // Animate reply word by word
    await deskTypeWords(textEl, reply, area, 18);

    // Remove pause button after typing completes
    pauseBtn.remove();

    // Append badges & time after animation
    const bubble = msgDiv.querySelector('.ai-msg-bubble');
    if (actionsBadges) bubble.insertAdjacentHTML('beforeend', '<div style="margin-top:6px">' + actionsBadges + '</div>');
    bubble.insertAdjacentHTML('beforeend', `<div class="ai-msg-time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>`);

    // Add neural voice playback button
    _deskAiAddVoicePlayback(bubble, reply, null, null, false);

    area.scrollTop = area.scrollHeight;
  } catch(e) {
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();
    area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-bot">
      <div class="ai-msg-avatar"><i class="fas fa-brain"></i></div>
      <div class="ai-msg-bubble"><div class="ai-msg-text" style="color:#EF4444">Failed to reach BEAM AI. Check your internet connection.</div></div>
    </div>`);
    area.scrollTop = area.scrollHeight;
  }
  if (sendBtn) sendBtn.disabled = false;
}

function aiSendQuick(text) {
  document.getElementById('aiChatInput').value = text;
  sendAiMessage(text);
}

async function aiClearHistory() {
  if (!confirm('Clear all AI conversation history?')) return;
  try {
    await fetch(`${API_BASE}/ai/clear-history`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ owner_id: desktopDeviceId })
    });
  } catch(e) {}
  const area = document.getElementById('aiChatMessages');
  area.innerHTML = `<div class="ai-msg ai-msg-bot">
    <div class="ai-msg-avatar"><i class="fas fa-robot"></i></div>
    <div class="ai-msg-bubble"><div class="ai-msg-text">Chat cleared! How can I help you?</div></div>
  </div>`;
}

/* ── AI Panels Toggle ── */
function toggleAiPanel(panel) {
  const panels = ['tasks', 'reminders', 'delegation', 'tools'];
  for (const p of panels) {
    const el = document.getElementById('aiPanel' + p.charAt(0).toUpperCase() + p.slice(1));
    if (!el) continue;
    if (p === panel) {
      el.style.display = el.style.display === 'none' ? '' : 'none';
    } else {
      el.style.display = 'none';
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   BEAM AI — Desktop File Upload, Image, Voice Notes, Security
   ═══════════════════════════════════════════════════════════════ */

let _deskAiAttachment = null;
let _deskAiMediaRecorder = null;
let _deskAiAudioChunks = [];
let _deskAiVoiceInterval = null;
let _deskAiVoiceStart = 0;
let _deskAiSpeechRecognition = null;
let _deskAiTranscript = '';

function deskAiPickImage() { document.getElementById('deskAiImageInput')?.click(); }
function deskAiPickDocument() { document.getElementById('deskAiDocInput')?.click(); }
function deskAiPickFile() { document.getElementById('deskAiFileInput')?.click(); }
function deskAiScanDoc() {
    // Open image picker but auto-fill with OCR question
    window._deskAiScanMode = true;
    document.getElementById('deskAiImageInput')?.click();
}

function deskAiOnImage(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    _deskAiAttachment = { file, type: 'image' };
    // If scan mode, auto-send with OCR prompt
    if (window._deskAiScanMode) {
        window._deskAiScanMode = false;
        const scanInput = document.getElementById('aiChatInput');
        if (scanInput && !scanInput.value.trim()) {
            scanInput.value = 'Read and extract all text from this document. Transcribe everything you see accurately.';
        }
        input.value = '';
        sendAiMessage();
        return;
    }
    const reader = new FileReader();
    reader.onload = e => {
        const preview = document.getElementById('deskAiAttachPreview');
        const thumb = document.getElementById('deskAiAttachThumb');
        const name = document.getElementById('deskAiAttachName');
        if (preview) preview.style.display = 'flex';
        if (thumb) thumb.innerHTML = `<img src="${e.target.result}">`;
        if (name) name.textContent = file.name;
    };
    reader.readAsDataURL(file);
    input.value = '';
}

function deskAiOnDoc(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    _deskAiAttachment = { file, type: 'document' };
    const ext = file.name.split('.').pop().toLowerCase();
    const icon = ext === 'pdf' ? 'fa-file-pdf' : ext === 'docx' || ext === 'doc' ? 'fa-file-word' : ext === 'xlsx' ? 'fa-file-excel' : 'fa-file-alt';
    const preview = document.getElementById('deskAiAttachPreview');
    const thumb = document.getElementById('deskAiAttachThumb');
    const name = document.getElementById('deskAiAttachName');
    if (preview) preview.style.display = 'flex';
    if (thumb) thumb.innerHTML = `<i class="fas ${icon}" style="color:#EF4444;font-size:20px"></i>`;
    if (name) name.textContent = file.name;
    input.value = '';
}

function deskAiOnFile(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    _deskAiAttachment = { file, type: 'file' };
    const preview = document.getElementById('deskAiAttachPreview');
    const thumb = document.getElementById('deskAiAttachThumb');
    const name = document.getElementById('deskAiAttachName');
    if (preview) preview.style.display = 'flex';
    if (thumb) thumb.innerHTML = `<i class="fas fa-file" style="font-size:20px"></i>`;
    if (name) name.textContent = file.name;
    input.value = '';
}

function deskAiClearAttach() {
    _deskAiAttachment = null;
    const preview = document.getElementById('deskAiAttachPreview');
    if (preview) preview.style.display = 'none';
}

// Voice note recording
async function deskAiStartVoiceNote() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        _deskAiMediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        _deskAiAudioChunks = [];
        _deskAiMediaRecorder.ondataavailable = e => { if (e.data.size > 0) _deskAiAudioChunks.push(e.data); };
        _deskAiMediaRecorder.start();
        _deskAiVoiceStart = Date.now();

        // Start SpeechRecognition in parallel for live transcription
        _deskAiTranscript = '';
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SR) {
            try {
                _deskAiSpeechRecognition = new SR();
                _deskAiSpeechRecognition.lang = 'en-US';
                _deskAiSpeechRecognition.continuous = true;
                _deskAiSpeechRecognition.interimResults = false;
                _deskAiSpeechRecognition.maxAlternatives = 1;
                _deskAiSpeechRecognition.onresult = (ev) => {
                    for (let i = ev.resultIndex; i < ev.results.length; i++) {
                        if (ev.results[i].isFinal) {
                            _deskAiTranscript += ev.results[i][0].transcript + ' ';
                        }
                    }
                };
                _deskAiSpeechRecognition.onerror = () => {};
                _deskAiSpeechRecognition.onend = () => {
                    // Auto-restart if still recording (browser may stop recognition after silence)
                    if (_deskAiMediaRecorder && _deskAiMediaRecorder.state === 'recording' && _deskAiSpeechRecognition) {
                        try { _deskAiSpeechRecognition.start(); } catch(e) {}
                    }
                };
                _deskAiSpeechRecognition.start();
            } catch(e) { _deskAiSpeechRecognition = null; }
        }

        const voiceBar = document.getElementById('deskAiVoiceBar');
        if (voiceBar) voiceBar.style.display = 'flex';
        _deskAiVoiceInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - _deskAiVoiceStart) / 1000);
            const timer = document.getElementById('deskAiVoiceTimer');
            if (timer) timer.textContent = `${Math.floor(elapsed/60)}:${(elapsed%60).toString().padStart(2,'0')}`;
        }, 1000);
    } catch(e) { showNotification('Microphone access denied', 'error'); }
}

function deskAiCancelVoice() {
    if (_deskAiSpeechRecognition) {
        try { _deskAiSpeechRecognition.onend = null; _deskAiSpeechRecognition.stop(); } catch(e) {}
        _deskAiSpeechRecognition = null;
    }
    _deskAiTranscript = '';
    if (_deskAiMediaRecorder && _deskAiMediaRecorder.state !== 'inactive') {
        _deskAiMediaRecorder.stop();
        _deskAiMediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
    _deskAiMediaRecorder = null; _deskAiAudioChunks = [];
    clearInterval(_deskAiVoiceInterval);
    const voiceBar = document.getElementById('deskAiVoiceBar');
    if (voiceBar) voiceBar.style.display = 'none';
}

function deskAiSendVoice() {
    if (!_deskAiMediaRecorder || _deskAiMediaRecorder.state === 'inactive') return;

    // Stop SpeechRecognition (we'll use server-side transcription instead)
    if (_deskAiSpeechRecognition) {
        try { _deskAiSpeechRecognition.onend = null; _deskAiSpeechRecognition.stop(); } catch(e) {}
        _deskAiSpeechRecognition = null;
    }

    _deskAiMediaRecorder.onstop = async () => {
        const blob = new Blob(_deskAiAudioChunks, { type: 'audio/webm' });
        _deskAiMediaRecorder.stream.getTracks().forEach(t => t.stop());
        _deskAiMediaRecorder = null;
        clearInterval(_deskAiVoiceInterval);
        _deskAiTranscript = '';
        const voiceBar = document.getElementById('deskAiVoiceBar');
        if (voiceBar) voiceBar.style.display = 'none';

        const area = document.getElementById('aiChatMessages');
        if (!area) return;

        // Show audio in user bubble
        const audioUrl = URL.createObjectURL(blob);
        const vnPlayer = _buildAiVoiceNotePlayer(audioUrl);
        area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-user">
            <div class="ai-msg-avatar"><i class="fas fa-user"></i></div>
            <div class="ai-msg-bubble"><div class="ai-msg-text"><i class="fas fa-microphone"></i> Voice Note</div>${vnPlayer}</div></div>`);
        _initAiVoiceNotePlayers();
        area.scrollTop = area.scrollHeight;

        // Typing indicator
        const typingId = 'typing-' + Date.now();
        area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-bot" id="${typingId}">
            <div class="ai-msg-avatar"><i class="fas fa-brain"></i></div>
            <div class="ai-msg-bubble"><div class="ai-typing"><span></span><span></span><span></span></div></div></div>`);
        area.scrollTop = area.scrollHeight;

        try {
            // Always upload audio to server for server-side transcription
            const formData = new FormData();
            formData.append('audio', blob, 'voice_note.webm');
            formData.append('owner_id', desktopDeviceId);

            const res = await fetch(`${API_BASE}/ai/transcribe-audio`, { method: 'POST', body: formData });
            const data = await res.json();

            let reply = '';
            let audioData = null;
            let audioFormat = 'mp3';
            let transcript = null;

            if (data.success) {
                reply = data.reply || 'I received your voice note but could not process it.';
                audioData = data.audio || null;
                audioFormat = data.audio_format || 'mp3';
                transcript = data.transcript || null;
            } else {
                reply = data.error || 'Could not transcribe your voice note. Please try again.';
            }

            const typEl = document.getElementById(typingId);
            if (typEl) typEl.remove();

            // Show transcript if available (under the user bubble)
            if (transcript) {
                const userBubbles = area.querySelectorAll('.ai-msg-user .ai-msg-bubble');
                const lastUserBubble = userBubbles[userBubbles.length - 1];
                if (lastUserBubble) {
                    lastUserBubble.insertAdjacentHTML('beforeend', `<div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:4px;font-style:italic">"${transcript}"</div>`);
                }
            }

            const msgDiv = document.createElement('div');
            msgDiv.className = 'ai-msg ai-msg-bot';
            msgDiv.innerHTML = `<div class="ai-msg-avatar"><i class="fas fa-brain"></i></div><div class="ai-msg-bubble"><div class="ai-msg-text"></div></div>`;
            area.appendChild(msgDiv);
            const textEl = msgDiv.querySelector('.ai-msg-text');

            // Add pause button during typing
            const pauseBtn = document.createElement('button');
            pauseBtn.id = 'deskAiPauseBtn';
            pauseBtn.className = 'ai-pause-btn';
            pauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
            pauseBtn.title = 'Pause typing';
            pauseBtn.onclick = deskAiTogglePause;
            msgDiv.querySelector('.ai-msg-bubble').appendChild(pauseBtn);

            // Start TTS playback while typing — sync text speed to audio duration
            let autoPlayAudio = null;
            let typingSpeed = 18; // default fast typing
            if (audioData) {
                const mimeType = audioFormat === 'wav' ? 'audio/wav' : 'audio/mpeg';
                autoPlayAudio = new Audio(`data:${mimeType};base64,${audioData}`);
                // Wait for audio metadata to get duration, then sync typing speed
                try {
                    await new Promise((res, rej) => {
                        autoPlayAudio.addEventListener('loadedmetadata', () => res(), { once: true });
                        autoPlayAudio.addEventListener('error', () => res(), { once: true });
                        setTimeout(res, 2000); // fallback if metadata never loads
                    });
                    if (autoPlayAudio.duration && isFinite(autoPlayAudio.duration)) {
                        const wordTokens = reply.split(/\s+/).length;
                        // Calculate ms-per-word so text finishes ~when audio ends
                        typingSpeed = Math.max(8, Math.min(80, (autoPlayAudio.duration * 1000) / wordTokens));
                    }
                } catch(e) {}
                try { autoPlayAudio.play(); } catch(e) { console.warn('Auto-play blocked:', e); }
            }

            await deskTypeWords(textEl, reply, area, typingSpeed);

            // Remove pause button after typing completes
            pauseBtn.remove();

            // Add voice playback button (with preloaded audio)
            _deskAiAddVoicePlayback(msgDiv.querySelector('.ai-msg-bubble'), reply, audioData, audioFormat, !autoPlayAudio);
        } catch(e) {
            const typEl = document.getElementById(typingId);
            if (typEl) typEl.remove();
            area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-bot"><div class="ai-msg-avatar"><i class="fas fa-brain"></i></div>
                <div class="ai-msg-bubble"><div class="ai-msg-text" style="color:#EF4444">Failed to process voice note.</div></div></div>`);
        }
        area.scrollTop = area.scrollHeight;
    };
    _deskAiMediaRecorder.stop();
}

// Enhanced sendAiMessage with attachment support
const _origSendAiMessage = sendAiMessage;
sendAiMessage = async function(overrideText) {
    if (_deskAiAttachment) {
        await _deskAiSendFileToAi(_deskAiAttachment, overrideText);
        return;
    }
    return _origSendAiMessage(overrideText);
};

async function _deskAiSendFileToAi(attachment, extraText) {
    const area = document.getElementById('aiChatMessages');
    if (!area) return;
    const input = document.getElementById('aiChatInput');
    const question = extraText || (input ? input.value.trim() : '');
    if (input) input.value = '';
    deskAiClearAttach();

    let userPreview = '';
    if (attachment.type === 'image') {
        const reader = new FileReader();
        const dataUrl = await new Promise(r => { reader.onload = e => r(e.target.result); reader.readAsDataURL(attachment.file); });
        userPreview = `<img class="desk-ai-img-preview" src="${dataUrl}">`;
    } else {
        const ext = attachment.file.name.split('.').pop().toLowerCase();
        const icon = ext === 'pdf' ? 'fa-file-pdf' : ext === 'docx' || ext === 'doc' ? 'fa-file-word' : ext === 'xlsx' ? 'fa-file-excel' : 'fa-file';
        userPreview = `<div class="desk-ai-doc-badge"><i class="fas ${icon}"></i> ${escapeHtml(attachment.file.name)}</div>`;
    }
    area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-user">
        <div class="ai-msg-avatar"><i class="fas fa-user"></i></div>
        <div class="ai-msg-bubble"><div class="ai-msg-text">${userPreview}${question ? '<div style="margin-top:6px">' + escapeHtml(question) + '</div>' : ''}</div></div></div>`);

    const typingId = 'typing-' + Date.now();
    area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-bot" id="${typingId}">
        <div class="ai-msg-avatar"><i class="fas fa-brain"></i></div>
        <div class="ai-msg-bubble"><div class="ai-typing"><span></span><span></span><span></span></div></div></div>`);
    area.scrollTop = area.scrollHeight;

    try {
        const formData = new FormData();
        formData.append('file', attachment.file);
        formData.append('owner_id', desktopDeviceId);
        formData.append('action', 'auto');
        if (question) formData.append('question', question);
        const res = await fetch(`${API_BASE}/ai/process-file`, { method: 'POST', body: formData });
        const data = await res.json();
        const typEl = document.getElementById(typingId); if (typEl) typEl.remove();
        const reply = data.analysis || 'File processed.';
        const secBadge = _deskAiSecurityBadge(data.security);
        const msgDiv = document.createElement('div');
        msgDiv.className = 'ai-msg ai-msg-bot';
        msgDiv.innerHTML = `<div class="ai-msg-avatar"><i class="fas fa-brain"></i></div><div class="ai-msg-bubble"><div class="ai-msg-text"></div></div>`;
        area.appendChild(msgDiv);
        const textEl = msgDiv.querySelector('.ai-msg-text');
        await deskTypeWords(textEl, reply, area, 18);
        if (secBadge) msgDiv.querySelector('.ai-msg-bubble').insertAdjacentHTML('beforeend', secBadge);
    } catch(e) {
        const typEl = document.getElementById(typingId); if (typEl) typEl.remove();
        area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-bot"><div class="ai-msg-avatar"><i class="fas fa-brain"></i></div>
            <div class="ai-msg-bubble"><div class="ai-msg-text" style="color:#EF4444">Error processing file.</div></div></div>`);
    }
    area.scrollTop = area.scrollHeight;
}

function _deskAiSecurityBadge(security) {
    if (!security) return '';
    const lvl = security.level;
    const cls = lvl === 'safe' ? 'safe' : lvl === 'warn' ? 'warn' : 'danger';
    const icon = lvl === 'safe' ? 'fa-shield-alt' : lvl === 'warn' ? 'fa-exclamation-triangle' : 'fa-skull-crossbones';
    const label = lvl === 'safe' ? 'Safe' : lvl === 'warn' ? 'Caution' : 'Threat Detected';
    return `<div class="desk-ai-security-badge ${cls}"><i class="fas ${icon}"></i> ${label}</div>`;
}

/* ── AI Tasks ── */
async function loadAiTasks() {
  const filter = document.getElementById('aiTaskFilter');
  const status = filter ? filter.value : 'pending';
  try {
    const res = await fetch(`${API_BASE}/ai/tasks?owner_id=${desktopDeviceId}&status=${status}`);
    const data = await res.json();
    const tasks = data.tasks || [];
    const list = document.getElementById('aiTasksList');
    if (!list) return;
    if (tasks.length === 0) {
      list.innerHTML = '<div class="empty-state" style="padding:20px 0"><i class="fas fa-tasks"></i><p>No tasks yet. Ask BEAM AI to create one!</p></div>';
      return;
    }
    list.innerHTML = tasks.map(t => {
      const isDone = t.status === 'completed';
      const priorityEmoji = {high: '🔴', medium: '🟡', low: '🟢'}[t.priority] || '⚪';
      const catIcon = {work: 'fa-briefcase', personal: 'fa-home', study: 'fa-book', health: 'fa-heartbeat', finance: 'fa-dollar-sign', other: 'fa-tag'}[t.category] || 'fa-tag';
      return `<div class="ai-task-item priority-${t.priority || 'medium'} ${isDone ? 'completed' : ''}">
        <div class="ai-task-check ${isDone ? 'done' : ''}" onclick="toggleAiTask('${t.id}', ${isDone ? 'false' : 'true'})">${isDone ? '<i class="fas fa-check"></i>' : ''}</div>
        <div class="ai-task-info">
          <div class="ai-task-title" style="${isDone ? 'text-decoration:line-through' : ''}">${priorityEmoji} ${escapeHtml(t.title)}</div>
          <div class="ai-task-meta">
            ${t.due_date ? '<span><i class="fas fa-calendar"></i>' + t.due_date + (t.due_time ? ' ' + t.due_time : '') + '</span>' : ''}
            <span><i class="fas ${catIcon}"></i>${t.category || 'other'}</span>
          </div>
        </div>
        <div class="ai-task-actions">
          <button class="btn-icon btn-xs" onclick="deleteAiTask('${t.id}')" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </div>`;
    }).join('');
  } catch(e) { console.error('loadAiTasks', e); }
}

async function toggleAiTask(taskId, complete) {
  try {
    await fetch(`${API_BASE}/ai/tasks/${taskId}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ status: complete ? 'completed' : 'pending' })
    });
    loadAiTasks();
  } catch(e) {}
}

async function deleteAiTask(taskId) {
  try {
    await fetch(`${API_BASE}/ai/tasks/${taskId}`, { method: 'DELETE' });
    loadAiTasks();
  } catch(e) {}
}

function aiQuickAddTask() {
  const title = prompt('Task title:');
  if (!title) return;
  const dueDate = prompt('Due date (YYYY-MM-DD) or leave empty:', '');
  fetch(`${API_BASE}/ai/tasks`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ owner_id: desktopDeviceId, title, due_date: dueDate || '', priority: 'medium', category: 'other' })
  }).then(() => loadAiTasks()).catch(() => {});
}

/* ── AI Reminders ── */
async function loadAiReminders() {
  try {
    const res = await fetch(`${API_BASE}/ai/reminders?owner_id=${desktopDeviceId}`);
    const data = await res.json();
    const rems = data.reminders || [];
    const list = document.getElementById('aiRemindersList');
    if (!list) return;
    if (rems.length === 0) {
      list.innerHTML = '<div class="empty-state" style="padding:20px 0"><i class="fas fa-bell"></i><p>No reminders. Ask BEAM AI to set one!</p></div>';
      return;
    }
    list.innerHTML = rems.map(r => {
      return `<div class="ai-reminder-item">
        <div class="ai-reminder-icon"><i class="fas fa-bell"></i></div>
        <div class="ai-reminder-info">
          <div class="ai-reminder-text">${escapeHtml(r.text)}</div>
          <div class="ai-reminder-time">${r.remind_at ? '<i class="fas fa-clock"></i> ' + r.remind_at : 'No time set'} ${r.repeat !== 'none' ? '• Repeats ' + r.repeat : ''}</div>
        </div>
        <button class="btn-icon btn-xs" onclick="deleteAiReminder('${r.id}')" title="Delete"><i class="fas fa-trash"></i></button>
      </div>`;
    }).join('');
  } catch(e) { console.error('loadAiReminders', e); }
}

async function deleteAiReminder(remId) {
  try {
    await fetch(`${API_BASE}/ai/reminders/${remId}`, { method: 'DELETE' });
    loadAiReminders();
  } catch(e) {}
}

function aiQuickAddReminder() {
  const text = prompt('Reminder text:');
  if (!text) return;
  const remAt = prompt('When? (YYYY-MM-DD HH:MM) or leave empty:', '');
  fetch(`${API_BASE}/ai/reminders`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ owner_id: desktopDeviceId, text, remind_at: remAt || '', repeat: 'none' })
  }).then(() => loadAiReminders()).catch(() => {});
}

// ─── Reminder Notification Checker ───
let _deskReminderCheckInterval = null;
function deskStartReminderChecker() {
    if (_deskReminderCheckInterval) return;
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    _deskReminderCheckInterval = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}/ai/reminders?owner_id=${desktopDeviceId}`);
            const data = await res.json();
            const rems = data.reminders || [];
            const now = new Date();
            for (const r of rems) {
                if (!r.remind_at) continue;
                const remTime = new Date(r.remind_at.replace(' ', 'T'));
                if (isNaN(remTime.getTime())) continue;
                const diff = (remTime - now) / 1000;
                if (diff <= 0 && diff > -60) {
                    if ('Notification' in window && Notification.permission === 'granted') {
                        new Notification('BEAM AI Reminder', { body: r.text, tag: r.id });
                    }
                    showToast('⏰ Reminder: ' + r.text, 'info');
                    if (r.repeat === 'none') {
                        fetch(`${API_BASE}/ai/reminders/${r.id}`, { method: 'DELETE' });
                    }
                }
            }
        } catch(e) {}
    }, 30000);
}
setTimeout(deskStartReminderChecker, 5000);

/* ── AI Delegation ── */
async function loadAiDelegation() {
  // Only load once — never overwrite the user's in-progress edits
  if (_aiDelegationLoaded) return;
  try {
    const res = await fetch(`${API_BASE}/ai/delegation?owner_id=${desktopDeviceId}`);
    const data = await res.json();
    const d = data.delegation || {};
    const toggle = document.getElementById('aiDelegationToggle');
    const style = document.getElementById('aiDelegationStyle');
    const rules = document.getElementById('aiDelegationRules');
    if (toggle) toggle.checked = d.enabled || false;
    if (style) style.value = d.style || 'professional';
    if (rules) rules.value = d.rules || '';
    _aiDelegationLoaded = true;
  } catch(e) {}
}

async function updateDelegation() {
  if (!_aiDelegationLoaded) return;
  const enabled = document.getElementById('aiDelegationToggle').checked;
  const style = document.getElementById('aiDelegationStyle').value;
  const rules = document.getElementById('aiDelegationRules').value;
  try {
    await fetch(`${API_BASE}/ai/delegation`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ owner_id: desktopDeviceId, enabled, style, rules })
    });
    showNotification(enabled ? 'Chat delegation enabled — BEAM AI will reply on your behalf' : 'Chat delegation disabled', 'info');
  } catch(e) {}
}

function saveDelegationRules() {
  updateDelegation();
  showNotification('Custom rules saved ✓', 'info');
}

/* ── AI Chat Delegation in P2P ── */
async function aiTryDelegateReply(senderId, senderName, text) {
  // Check if delegation is enabled for us
  try {
    const res = await fetch(`${API_BASE}/ai/delegation?owner_id=${desktopDeviceId}`);
    const data = await res.json();
    if (!data.delegation || !data.delegation.enabled) return null;

    // Generate a reply
    const replyRes = await fetch(`${API_BASE}/ai/delegate-reply`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        owner_id: desktopDeviceId,
        sender_id: senderId,
        sender_name: senderName,
        text: text
      })
    });
    const replyData = await replyRes.json();
    if (replyData.success) {
      // Send the AI-generated reply as the owner
      await fetch(`${API_BASE}/p2p/messages`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          sender_id: desktopDeviceId,
          sender_name: desktopDeviceName + ' 🤖',
          recipient_id: senderId,
          text: replyData.reply
        })
      });
      // If flagged, show a notification
      if (replyData.flagged) {
        showNotification(`⚠️ BEAM AI flagged a message from ${senderName} for your review`, 'warning');
      }
      return replyData.reply;
    }
  } catch(e) { console.error('aiTryDelegateReply error:', e); }
  return null;
}

/* ── AI Tools ── */
function openAiTool(type) {
  _aiCurrentTool = type;
  const inline = document.getElementById('aiToolInline');
  const textarea = document.getElementById('aiToolText');
  const btn = document.getElementById('aiToolSubmitBtn');
  if (!inline) return;

  const labels = {
    'summarize': { placeholder: 'Paste text to summarize...', btn: '<i class="fas fa-magic"></i> Summarize' },
    'study': { placeholder: 'Paste study material / textbook content...', btn: '<i class="fas fa-graduation-cap"></i> Generate Study Notes' },
    'document': { placeholder: 'Paste document content to analyze...', btn: '<i class="fas fa-file-invoice"></i> Analyze Document' },
    'conversation': { placeholder: 'Paste chat conversation to summarize...', btn: '<i class="fas fa-comments"></i> Summarize Chat' }
  };
  const l = labels[type] || labels['summarize'];
  textarea.placeholder = l.placeholder;
  textarea.value = '';
  btn.innerHTML = l.btn;
  inline.style.display = '';
}

async function submitAiTool() {
  const text = document.getElementById('aiToolText').value.trim();
  if (!text) { showNotification('Enter some text to analyze', 'error'); return; }

  const typeMap = {
    'summarize': 'general',
    'study': 'study_notes',
    'document': 'document',
    'conversation': 'conversation'
  };

  const btn = document.getElementById('aiToolSubmitBtn');
  const origHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/ai/summarize`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ owner_id: desktopDeviceId, text, type: typeMap[_aiCurrentTool] || 'general' })
    });
    const data = await res.json();
    document.getElementById('aiToolInline').style.display = 'none';

    // Show result in the chat
    const area = document.getElementById('aiChatMessages');
    let resultHtml = escapeHtml(data.summary || 'No result').replace(/\n/g, '<br>');
    resultHtml = resultHtml.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    area.insertAdjacentHTML('beforeend', `<div class="ai-msg ai-msg-bot">
      <div class="ai-msg-avatar"><i class="fas fa-robot"></i></div>
      <div class="ai-msg-bubble"><div class="ai-msg-text">${resultHtml}</div>
      <div class="ai-msg-time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div></div>
    </div>`);
    area.scrollTop = area.scrollHeight;
  } catch(e) {
    showNotification('Failed to process', 'error');
  }
  btn.innerHTML = origHtml;
  btn.disabled = false;
}

async function loadBotsList() {
  try {
    const list = document.getElementById('botsList');
    if (!list) return; // Legacy bots container removed
    const res = await fetch(`${API_BASE}/bots/list?owner_id=${desktopDeviceId}`);
    if (bots.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fas fa-robot"></i><p>No bots created yet</p></div>';
      return;
    }
    list.innerHTML = bots.map(b => {
      const isOwner = b.owner_id === desktopDeviceId;
      const cbBadge = b.callback_enabled ? '<span class="bot-cb-badge"><i class="fas fa-bell"></i> Callback</span>' : '';
      const ownerActions = isOwner ? `
        <button class="btn-icon btn-xs" onclick="editBot('${b.id}')" title="Edit"><i class="fas fa-pen"></i></button>
        <button class="btn-icon btn-xs" onclick="deleteBot('${b.id}')" title="Delete"><i class="fas fa-trash"></i></button>
      ` : '';
      return `<div class="bot-list-item">
        <div class="bot-list-icon"><i class="fas fa-robot"></i></div>
        <div class="bot-list-info">
          <div class="bot-list-name">${escapeHtml(b.name)} ${cbBadge}</div>
          <div class="bot-list-desc">${escapeHtml(b.description || 'No description')}</div>
          <div class="bot-list-meta">${b.commands_count || 0} commands</div>
        </div>
        <div class="bot-list-actions">
          <button class="btn btn-sm" onclick="openBotChat('${b.id}','${escapeHtml(b.name)}')" title="Chat"><i class="fas fa-comment-dots"></i> Chat</button>
          ${ownerActions}
        </div>
      </div>`;
    }).join('');
  } catch(e) { console.error('loadBotsList', e); }
}

async function loadCallbacksList() {
  try {
    const res = await fetch(`${API_BASE}/bots/callbacks/${desktopDeviceId}`);
    const data = await res.json();
    const cbs = data.callbacks || [];
    const list = document.getElementById('callbacksList');
    if (!list) return;
    if (cbs.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fas fa-bell-slash"></i><p>No pending callbacks</p></div>';
      return;
    }
    list.innerHTML = cbs.map(cb => {
      const statusIcon = cb.status === 'pending' ? 'fa-clock' : 'fa-check-circle';
      const statusClass = cb.status === 'pending' ? 'pending' : 'sent';
      const executeBtn = cb.status === 'pending' ? `<button class="btn btn-primary btn-sm" onclick="executeCallback('${cb.id}')"><i class="fas fa-phone-alt"></i> Execute</button>` : '';
      return `<div class="callback-item">
        <div class="callback-icon ${statusClass}"><i class="fas ${statusIcon}"></i></div>
        <div class="callback-info">
          <div class="callback-name">${escapeHtml(cb.bot_name)} → ${escapeHtml(cb.target_name)}</div>
          <div class="callback-msg">${escapeHtml(cb.original_message || '')}</div>
          <div class="callback-time">${formatTime(cb.created)}</div>
        </div>
        <div class="callback-actions">${executeBtn}</div>
      </div>`;
    }).join('');
  } catch(e) { console.error('loadCallbacksList', e); }
}

async function executeCallback(callbackId) {
  try {
    const res = await fetch(`${API_BASE}/bots/callbacks/${callbackId}/execute`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'}
    });
    const data = await res.json();
    if (data.success) {
      showNotification('Callback executed', 'success');
      await loadCallbacksList();
    } else {
      showNotification(data.error || 'Failed', 'error');
    }
  } catch(e) { showNotification('Failed to execute callback', 'error'); }
}

function openCreateBotModal() {
  _editingBotId = null;
  document.getElementById('botModalTitle').textContent = 'Create Bot';
  document.getElementById('botFormSubmitBtn').innerHTML = '<i class="fas fa-robot"></i> Create Bot';
  document.getElementById('botFormName').value = '';
  document.getElementById('botFormDesc').value = '';
  document.getElementById('botFormAutoReply').value = 'Thanks for your message! We\'ll get back to you shortly.';
  document.getElementById('botFormCommands').value = '';
  document.getElementById('botFormCallback').checked = false;
  document.getElementById('botFormCallbackMsg').value = '';
  document.getElementById('botCallbackMsgWrap').style.display = 'none';
  document.getElementById('createBotModal').style.display = 'flex';

  document.getElementById('botFormCallback').onchange = function() {
    document.getElementById('botCallbackMsgWrap').style.display = this.checked ? '' : 'none';
  };
}

function closeCreateBotModal() {
  document.getElementById('createBotModal').style.display = 'none';
  _editingBotId = null;
}

async function editBot(botId) {
  try {
    const res = await fetch(`${API_BASE}/bots/${botId}`);
    const data = await res.json();
    const bot = data.bot;
    _editingBotId = botId;
    document.getElementById('botModalTitle').textContent = 'Edit Bot';
    document.getElementById('botFormSubmitBtn').innerHTML = '<i class="fas fa-save"></i> Save';
    document.getElementById('botFormName').value = bot.name || '';
    document.getElementById('botFormDesc').value = bot.description || '';
    document.getElementById('botFormAutoReply').value = bot.auto_reply || '';
    // Convert commands object to text
    const cmds = bot.commands || {};
    document.getElementById('botFormCommands').value = Object.entries(cmds).map(([k,v]) => `${k} = ${v}`).join('\n');
    document.getElementById('botFormCallback').checked = bot.callback_enabled || false;
    document.getElementById('botFormCallbackMsg').value = bot.callback_message || '';
    document.getElementById('botCallbackMsgWrap').style.display = bot.callback_enabled ? '' : 'none';
    document.getElementById('createBotModal').style.display = 'flex';

    document.getElementById('botFormCallback').onchange = function() {
      document.getElementById('botCallbackMsgWrap').style.display = this.checked ? '' : 'none';
    };
  } catch(e) { showNotification('Failed to load bot', 'error'); }
}

async function submitBotForm() {
  const name = document.getElementById('botFormName').value.trim();
  if (!name) { showNotification('Bot name is required', 'error'); return; }

  // Parse commands
  const cmdText = document.getElementById('botFormCommands').value;
  const commands = {};
  cmdText.split('\n').forEach(line => {
    const match = line.match(/^(\/\S+)\s*=\s*(.+)$/);
    if (match) commands[match[1].toLowerCase()] = match[2].trim();
  });

  const payload = {
    name: name,
    owner_id: desktopDeviceId,
    description: document.getElementById('botFormDesc').value.trim(),
    auto_reply: document.getElementById('botFormAutoReply').value.trim(),
    commands: commands,
    callback_enabled: document.getElementById('botFormCallback').checked,
    callback_message: document.getElementById('botFormCallbackMsg').value.trim()
  };

  try {
    const url = _editingBotId ? `${API_BASE}/bots/${_editingBotId}` : `${API_BASE}/bots`;
    const method = _editingBotId ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method: method,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      closeCreateBotModal();
      showNotification(_editingBotId ? 'Bot updated!' : 'Bot created!', 'success');
      await loadBotsList();
    } else {
      showNotification(data.error || 'Failed', 'error');
    }
  } catch(e) { showNotification('Failed to save bot', 'error'); }
}

async function deleteBot(botId) {
  if (!confirm('Delete this bot?')) return;
  try {
    await fetch(`${API_BASE}/bots/${botId}?owner_id=${desktopDeviceId}`, { method: 'DELETE' });
    showNotification('Bot deleted', 'info');
    await loadBotsList();
  } catch(e) { showNotification('Failed to delete bot', 'error'); }
}

function openBotChat(botId, botName) {
  _botChatId = botId;
  _botChatHistory = [];
  const sec = document.getElementById('botChatSection');
  if (!sec) return;
  sec.style.display = '';
  document.getElementById('botChatName').textContent = botName + ' 🤖';
  document.getElementById('botChatMessages').innerHTML = `<div class="bot-msg bot-msg-received"><span class="bot-msg-text">Hi! I'm ${escapeHtml(botName)}. Send me a message or type /help.</span></div>`;
  document.getElementById('botChatInput').value = '';
  document.getElementById('botChatInput').focus();
  sec.scrollIntoView({behavior:'smooth'});
}

function closeBotChat() {
  _botChatId = null;
  const sec = document.getElementById('botChatSection');
  if (sec) sec.style.display = 'none';
}

async function sendBotMessage() {
  if (!_botChatId) return;
  const input = document.getElementById('botChatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  // Show user message
  const msgArea = document.getElementById('botChatMessages');
  msgArea.innerHTML += `<div class="bot-msg bot-msg-sent"><span class="bot-msg-text">${escapeHtml(text)}</span></div>`;
  msgArea.scrollTop = msgArea.scrollHeight;

  try {
    const res = await fetch(`${API_BASE}/bots/${_botChatId}/message`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        device_id: desktopDeviceId,
        device_name: desktopDeviceName,
        text: text
      })
    });
    const data = await res.json();
    if (data.reply) {
      msgArea.innerHTML += `<div class="bot-msg bot-msg-received"><span class="bot-msg-text">${escapeHtml(data.reply)}</span></div>`;
      if (data.callback_scheduled) {
        msgArea.innerHTML += `<div class="bot-msg bot-msg-system"><i class="fas fa-bell"></i> Callback scheduled</div>`;
        loadCallbacksList();
      }
      msgArea.scrollTop = msgArea.scrollHeight;
    }
  } catch(e) {
    msgArea.innerHTML += `<div class="bot-msg bot-msg-system">Failed to get response</div>`;
  }
}

// ═══════════════════════════════════════════════════════════════
// VERIFICATION (Blue Tick) — Premium users get it automatically
// ═══════════════════════════════════════════════════════════════
let _verifiedSet = new Set();   // cached set of verified user/device IDs
let _verifiedLoaded = false;

const _BLUE_TICK = '<i class="fas fa-circle-check verified-badge" title="Verified"></i>';

/** Return badge HTML if id is verified, else '' */
function vBadge(id) {
  return _verifiedSet.has(id) ? _BLUE_TICK : '';
}

/** Fetch full verified list and cache it */
function refreshVerifiedList() {
  fetch(`${API_BASE}/verify/list`)
    .then(r => r.json())
    .then(data => {
      _verifiedSet = new Set(data.verified_users || []);
      _verifiedLoaded = true;
    })
    .catch(() => {});
}

// Refresh on load and every 30 seconds
refreshVerifiedList();
setInterval(refreshVerifiedList, 30000);

async function checkVerified(userId) {
  try {
    const res = await fetch(`${API_BASE}/verify/status/${userId}`);
    const data = await res.json();
    return data.verified || false;
  } catch(e) { return false; }
}

async function grantVerification() {
  if (!desktopDeviceId) return;
  try {
    await fetch(`${API_BASE}/verify/grant`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ user_id: desktopDeviceId })
    });
    _verifiedSet.add(desktopDeviceId);
    showNotification('Verification badge granted!', 'success');
  } catch(e) { showNotification('Failed to verify', 'error'); }
}

// Add Enter key handling for group chat
document.addEventListener('DOMContentLoaded', function() {
  const groupInput = document.getElementById('groupChatInput');
  if (groupInput) {
    groupInput.addEventListener('keypress', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGroupMessage(); }
    });
  }
  // Load AI chat history on page load
  setTimeout(() => { if (typeof _deskAiLoadHistory === 'function') _deskAiLoadHistory(); }, 1500);
});

/* ── Theme init on load ── */
(function() {
  const saved = localStorage.getItem('theme') || 'dark';
  _setTheme(saved);
  const sel = document.getElementById('themeSelect');
  if (sel) sel.value = saved;
  // Listen for OS theme change when in auto mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
    if (localStorage.getItem('theme') === 'auto') _setTheme('auto');
  });
})();

/* ═══════════════════════════════════════════════════════════════
   SUBSCRIPTION / PREMIUM — Desktop
   ═══════════════════════════════════════════════════════════════ */
let _subData = null;  // cached subscription status

function loadSubscriptionPage() {
  const did = desktopDeviceId || localStorage.getItem('desktopDeviceId') || '';
  if (!did) return;
  fetch(`/api/subscription/status/${did}`)
    .then(r => r.json())
    .then(data => {
      _subData = data;
      _renderSubPage(data);
    })
    .catch(e => console.warn('Sub status error:', e));
}

function _renderSubPage(data) {
  const isPrem = data.is_premium;
  const badge = document.getElementById('subStatusBadge');
  const planName = document.getElementById('subPlanName');
  const planExpiry = document.getElementById('subPlanExpiry');
  const currentPlan = document.getElementById('subCurrentPlan');
  const upgradeSection = document.getElementById('subUpgradeSection');
  const manageSection = document.getElementById('subManageSection');
  const planIcon = currentPlan ? currentPlan.querySelector('.sub-plan-icon i') : null;

  if (isPrem) {
    if (badge) { badge.textContent = 'Premium'; badge.classList.add('premium-active'); }
    if (planName) planName.textContent = 'Premium Plan';
    if (planExpiry) {
      const exp = new Date(data.expires * 1000);
      planExpiry.textContent = 'Expires: ' + exp.toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'});
    }
    if (currentPlan) currentPlan.classList.add('is-premium');
    if (planIcon) planIcon.className = 'fas fa-crown';
    if (upgradeSection) upgradeSection.style.display = 'none';
    if (manageSection) manageSection.style.display = 'block';
  } else {
    if (badge) { badge.textContent = 'Free Plan'; badge.classList.remove('premium-active'); }
    if (planName) planName.textContent = 'Free Plan';
    if (planExpiry) planExpiry.textContent = 'Upgrade to unlock premium features';
    if (currentPlan) currentPlan.classList.remove('is-premium');
    if (planIcon) planIcon.className = 'fas fa-user';
    if (upgradeSection) upgradeSection.style.display = 'block';
    if (manageSection) manageSection.style.display = 'none';
  }
}

function startStripeCheckout() {
  const did = desktopDeviceId || localStorage.getItem('desktopDeviceId') || '';
  const email = prompt('Enter your email for receipt:');
  if (!email) return;
  const btn = document.querySelector('.stripe-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...'; }

  fetch('/api/subscription/stripe/create-checkout', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      device_id: did,
      email: email,
      success_url: window.location.origin + '/desktop?sub_success=1',
      cancel_url: window.location.origin + '/desktop?sub_cancel=1'
    })
  })
  .then(r => r.json())
  .then(data => {
    if (data.checkout_url) {
      window.location.href = data.checkout_url;
    } else {
      alert('Error: ' + (data.error || 'Could not create checkout session'));
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fab fa-cc-stripe"></i> Pay with Stripe (Card)'; }
    }
  })
  .catch(e => {
    alert('Network error. Please try again.');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fab fa-cc-stripe"></i> Pay with Stripe (Card)'; }
  });
}

function startPaystackCheckout() {
  const did = desktopDeviceId || localStorage.getItem('desktopDeviceId') || '';
  const email = prompt('Enter your email for receipt:');
  if (!email) return;
  const btn = document.querySelector('.paystack-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...'; }

  fetch('/api/subscription/paystack/initialize', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      device_id: did,
      email: email,
      callback_url: window.location.origin + '/desktop?paystack_ref=1'
    })
  })
  .then(r => r.json())
  .then(data => {
    if (data.authorization_url) {
      // Save reference for verification after redirect
      localStorage.setItem('_paystack_ref', data.reference);
      window.location.href = data.authorization_url;
    } else {
      alert('Error: ' + (data.error || 'Could not initialize payment'));
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-credit-card"></i> Pay with Paystack (₦)'; }
    }
  })
  .catch(e => {
    alert('Network error. Please try again.');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-credit-card"></i> Pay with Paystack (₦)'; }
  });
}

function cancelSubscription() {
  if (!confirm('Are you sure you want to cancel your Premium subscription?')) return;
  const did = desktopDeviceId || localStorage.getItem('desktopDeviceId') || '';
  fetch('/api/subscription/cancel', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ device_id: did })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      alert('Subscription cancelled. You can still use premium features until the end of your billing period.');
      loadSubscriptionPage();
    } else {
      alert('Error: ' + (data.error || 'Could not cancel'));
    }
  })
  .catch(() => alert('Network error'));
}

function startFreeTrial() {
  const did = desktopDeviceId || localStorage.getItem('desktopDeviceId') || '';
  if (!did) { alert('Device not registered yet. Please wait and try again.'); return; }
  if (!confirm('Start your 7-day free Premium trial?')) return;
  const btn = document.querySelector('.trial-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Activating...'; }
  fetch('/api/subscription/free-trial', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ device_id: did })
  })
  .then(r => r.json())
  .then(data => {
    if (data.is_premium) {
      alert('\ud83c\udf89 Free trial activated! You have 7 days of Premium access.');
      loadSubscriptionPage();
    } else {
      alert('Error: ' + (data.error || 'Could not activate trial'));
    }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-gift"></i> Start 7-Day Free Trial'; }
  })
  .catch(e => {
    alert('Network error. Please try again.');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-gift"></i> Start 7-Day Free Trial'; }
  });
}

// Handle redirect back from Stripe/Paystack
(function _checkSubRedirect() {
  const params = new URLSearchParams(window.location.search);

  // Stripe success
  const sessionId = params.get('session_id');
  if (sessionId || params.get('sub_success')) {
    const did = desktopDeviceId || localStorage.getItem('desktopDeviceId') || '';
    if (sessionId) {
      fetch('/api/subscription/stripe/verify', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ session_id: sessionId, device_id: did })
      })
      .then(r => r.json())
      .then(data => {
        if (data.is_premium) {
          alert('🎉 Welcome to Premium! All features are now unlocked.');
          // Clean URL
          window.history.replaceState({}, '', window.location.pathname);
          navigateTo('subscription');
        }
      })
      .catch(() => {});
    }
  }

  // Paystack verify
  const ref = params.get('reference') || params.get('trxref');
  if (ref || params.get('paystack_ref')) {
    const savedRef = ref || localStorage.getItem('_paystack_ref');
    if (savedRef) {
      fetch(`/api/subscription/paystack/verify/${savedRef}`)
        .then(r => r.json())
        .then(data => {
          if (data.is_premium) {
            alert('🎉 Welcome to Premium! All features are now unlocked.');
            localStorage.removeItem('_paystack_ref');
            window.history.replaceState({}, '', window.location.pathname);
            navigateTo('subscription');
          }
        })
        .catch(() => {});
    }
  }

  if (params.get('sub_cancel')) {
    window.history.replaceState({}, '', window.location.pathname);
  }
})();

// Check premium status globally (for gating UI elements)
function checkPremiumStatus(callback) {
  const did = desktopDeviceId || localStorage.getItem('desktopDeviceId') || '';
  if (!did) { if (callback) callback(false); return; }
  fetch(`/api/subscription/status/${did}`)
    .then(r => r.json())
    .then(data => {
      _subData = data;
      if (callback) callback(data.is_premium);
    })
    .catch(() => { if (callback) callback(false); });
}


// ═══════════════════════════════════════════════════════════════════
// "HEY BEAM" WAKE WORD — Voice Activation System (Desktop)
// ═══════════════════════════════════════════════════════════════════
let _deskWakeWordActive = false;
let _deskWakeWordRecognition = null;
let _deskWakeWordRestartTimer = null;
let _deskWakeWordSilenceCtx = null;

function _deskPlayWakeChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const playTone = (freq, start, dur) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.3, ctx.currentTime + start);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + start + dur);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(ctx.currentTime + start);
            osc.stop(ctx.currentTime + start + dur);
        };
        playTone(587.33, 0, 0.15);
        playTone(880, 0.12, 0.2);
    } catch(e) { console.warn('[Wake Word] Chime failed:', e); }
}

function _deskWakeWordMatchesBeam(text) {
    const t = text.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const keywords = [
        'hey beam', 'hay beam', 'hey beem', 'hey been', 'hey bea',
        'hey bem', 'he beam', 'hey beab', 'hey bean', 'hey beep',
        'hey bee', 'hey bim', 'hey bam', 'hey bain', 'hey being',
        'a beam', 'hey beat', 'hey bead', 'hey beams', 'hey be'
    ];
    for (const kw of keywords) { if (t.includes(kw)) return true; }
    if (/\b(hey|hay|a|he)\s+be\w*/i.test(t)) return true;
    return false;
}

function deskToggleWakeWord() {
    if (_deskWakeWordActive) {
        _deskStopWakeWord();
    } else {
        _deskStartWakeWord();
    }
}

function _deskStartWakeWord() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        showNotification('Voice activation not supported. Use Chrome or Edge.', 'error');
        return;
    }

    _deskWakeWordActive = true;

    const btn = document.getElementById('deskWakeWordBtn');
    if (btn) btn.classList.add('active');
    const indicator = document.getElementById('deskWakeWordIndicator');
    if (indicator) {
        indicator.style.display = 'flex';
        const span = indicator.querySelector('span');
        if (span) span.textContent = 'Listening for "Hey Beam"...';
    }

    localStorage.setItem('deskWakeWordEnabled', 'true');
    _deskWakeWordListen();
    showNotification('Hey Beam activated! Say "Hey Beam" anytime.', 'success');
    console.log('[Wake Word] Desktop listener started');
}

function _deskStopWakeWord() {
    _deskWakeWordActive = false;
    if (_deskWakeWordRestartTimer) { clearTimeout(_deskWakeWordRestartTimer); _deskWakeWordRestartTimer = null; }
    if (_deskWakeWordRecognition) {
        try { _deskWakeWordRecognition.onend = null; _deskWakeWordRecognition.onerror = null; _deskWakeWordRecognition.abort(); } catch(e) {}
        _deskWakeWordRecognition = null;
    }
    if (_deskWakeWordSilenceCtx) { try { _deskWakeWordSilenceCtx.close(); } catch(e) {} _deskWakeWordSilenceCtx = null; }

    const btn = document.getElementById('deskWakeWordBtn');
    if (btn) btn.classList.remove('active');
    const indicator = document.getElementById('deskWakeWordIndicator');
    if (indicator) indicator.style.display = 'none';

    localStorage.setItem('deskWakeWordEnabled', 'false');
    console.log('[Wake Word] Desktop listener stopped');
}

function _deskWakeWordListen() {
    if (!_deskWakeWordActive) return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 5;
    _deskWakeWordRecognition = recognition;

    let detected = false;

    recognition.onresult = (event) => {
        if (detected) return;
        for (let i = event.resultIndex; i < event.results.length; i++) {
            for (let j = 0; j < event.results[i].length; j++) {
                const alt = event.results[i][j].transcript;
                console.log('[Wake Word] Heard:', JSON.stringify(alt));
                if (_deskWakeWordMatchesBeam(alt)) {
                    detected = true;
                    console.log('[Wake Word] >>> "Hey Beam" DETECTED! <<<');

                    try { recognition.onend = null; recognition.onerror = null; recognition.abort(); } catch(e) {}
                    _deskWakeWordRecognition = null;

                    _deskPlayWakeChime();

                    const indicator = document.getElementById('deskWakeWordIndicator');
                    if (indicator) {
                        indicator.classList.add('activated');
                        const span = indicator.querySelector('span');
                        if (span) span.textContent = 'Beam activated! Speak now...';
                        setTimeout(() => {
                            indicator.classList.remove('activated');
                            if (span) span.textContent = 'Listening for "Hey Beam"...';
                        }, 4000);
                    }

                    // Navigate to bots page (where BEAM AI lives)
                    const botsPage = document.getElementById('page-bots');
                    if (botsPage && !botsPage.classList.contains('active')) {
                        navigateTo('bots');
                    }

                    setTimeout(() => { _deskWakeWordAutoRecord(); }, 500);
                    return;
                }
            }
        }
    };

    recognition.onerror = (event) => {
        console.log('[Wake Word] SR error:', event.error);
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            showNotification('Mic blocked. Enable mic for "Hey Beam".', 'error');
            _deskStopWakeWord();
            return;
        }
    };

    recognition.onend = () => {
        if (!_deskWakeWordActive || detected) return;
        _deskWakeWordRestartTimer = setTimeout(() => {
            if (_deskWakeWordActive) _deskWakeWordListen();
        }, 250);
    };

    try {
        recognition.start();
        console.log('[Wake Word] Desktop SR listening cycle started');
    } catch(e) {
        console.warn('[Wake Word] SR start failed:', e.message);
        _deskWakeWordRestartTimer = setTimeout(() => {
            if (_deskWakeWordActive) _deskWakeWordListen();
        }, 2000);
    }
}

function _deskWakeWordAutoRecord() {
    if (!_deskWakeWordActive) { _deskWakeWordListen(); return; }

    console.log('[Wake Word] Starting auto-record...');

    // Use the existing voice note start function — handles MediaRecorder + UI
    deskAiStartVoiceNote().then(() => {
        console.log('[Wake Word] Voice recording started, adding silence detection...');

        setTimeout(() => {
            if (!_deskAiMediaRecorder || _deskAiMediaRecorder.state !== 'recording') {
                console.warn('[Wake Word] Recorder not active, restarting listener');
                if (_deskWakeWordActive) _deskWakeWordListen();
                return;
            }

            try {
                const stream = _deskAiMediaRecorder.stream;
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                _deskWakeWordSilenceCtx = audioCtx;
                const source = audioCtx.createMediaStreamSource(stream);
                const analyser = audioCtx.createAnalyser();
                analyser.fftSize = 512;
                source.connect(analyser);
                const dataArray = new Uint8Array(analyser.frequencyBinCount);

                let silenceStart = null;
                let sent = false;
                const SILENCE_THRESHOLD = 15;
                const SILENCE_DURATION = 2200;
                const MIN_RECORD_TIME = 1500;
                const recordStart = Date.now();

                function checkSilence() {
                    if (sent) return;
                    if (!_deskAiMediaRecorder || _deskAiMediaRecorder.state !== 'recording') return;

                    analyser.getByteFrequencyData(dataArray);
                    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

                    if (avg < SILENCE_THRESHOLD) {
                        if (!silenceStart) silenceStart = Date.now();
                        if (Date.now() - silenceStart > SILENCE_DURATION && Date.now() - recordStart > MIN_RECORD_TIME) {
                            sent = true;
                            console.log('[Wake Word] Silence detected → auto-sending voice note');
                            try { audioCtx.close(); } catch(e) {}
                            _deskWakeWordSilenceCtx = null;
                            deskAiSendVoice();
                            setTimeout(() => {
                                if (_deskWakeWordActive) {
                                    console.log('[Wake Word] Restarting listener after send');
                                    _deskWakeWordListen();
                                }
                            }, 4000);
                            return;
                        }
                    } else {
                        silenceStart = null;
                    }
                    requestAnimationFrame(checkSilence);
                }
                requestAnimationFrame(checkSilence);

                // Safety: max 60 seconds
                setTimeout(() => {
                    if (!sent && _deskAiMediaRecorder && _deskAiMediaRecorder.state === 'recording') {
                        sent = true;
                        console.log('[Wake Word] Max time reached, auto-sending');
                        try { audioCtx.close(); } catch(e) {}
                        _deskWakeWordSilenceCtx = null;
                        deskAiSendVoice();
                        setTimeout(() => { if (_deskWakeWordActive) _deskWakeWordListen(); }, 4000);
                    }
                }, 60000);

            } catch(e) {
                console.warn('[Wake Word] Silence detection setup failed:', e);
            }
        }, 800);

    }).catch(e => {
        console.warn('[Wake Word] Auto-record failed:', e);
        showNotification('Could not start recording', 'error');
        if (_deskWakeWordActive) setTimeout(() => _deskWakeWordListen(), 2000);
    });
}

// Auto-restore wake word on page load if previously enabled
setTimeout(() => {
    if (localStorage.getItem('deskWakeWordEnabled') === 'true') {
        _deskStartWakeWord();
    }
}, 3000);

// ═══════════════════════════════════════════════════════════════
//   SCROLL-TO-BOTTOM BUTTONS
// ═══════════════════════════════════════════════════════════════
(function() {
    function setupScrollBtn(containerId, btnId) {
        const container = document.getElementById(containerId);
        const btn = document.getElementById(btnId);
        if (!container || !btn) return;
        container.addEventListener('scroll', () => {
            const gap = container.scrollHeight - container.scrollTop - container.clientHeight;
            btn.style.display = gap > 120 ? 'flex' : 'none';
        });
    }
    setTimeout(() => {
        setupScrollBtn('desktopChatMessages', 'deskChatScrollBtn');
        setupScrollBtn('aiChatMessages', 'deskAiScrollBtn');
    }, 500);
})();