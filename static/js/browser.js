// File Browser JavaScript
let currentPath = '';
let rootDir = '';           // initial shared directory (back-button boundary)
let currentFiles = [];
let currentDirectories = [];
let currentSort = { field: 'name', ascending: true };
let currentPage = 1;
let itemsPerPage = 20;
let fastBaseUrl = null;  // raw-socket fast transfer server base URL

// E2EE State
let e2eeEnabled = false;
let browserPublicKey = null;

// Voice recording state
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = 0;
let recordingTimer = null;
let recordingMimeType = 'audio/webm';
let microphonePermission = 'prompt'; // 'prompt', 'granted', or 'denied'

// ── Reply State ──────────────────────────────────────────────
let _chatReplyTo = null; // { id, sender_id, sender_name, text }

// ── Auth State ───────────────────────────────────────────────
let mobAuthToken = localStorage.getItem('lb_auth_token') || null;
let mobAuthUser  = JSON.parse(localStorage.getItem('lb_auth_user') || 'null');
let mobAuthFriends = [];
let mobFriendRequests = { incoming: [], outgoing: [] };

// ── Verification Badge (Mobile) ─────────────────────────────
let _mobVerifiedSet = new Set();
let _mobVerifiedLoaded = false;
const _MOB_BLUE_TICK = '<i class="fas fa-circle-check verified-badge" title="Verified"></i>';
function mobVBadge(id) { return id && _mobVerifiedSet.has(id) ? _MOB_BLUE_TICK : ''; }

async function mobRefreshVerifiedList() {
  try {
    const r = await fetch(MOB_API + '/verify/list');
    if (r.ok) {
      const d = await r.json();
      _mobVerifiedSet = new Set(d.verified || []);
      _mobVerifiedLoaded = true;
    }
  } catch (e) { /* silent */ }
}
setInterval(mobRefreshVerifiedList, 30000);
setTimeout(mobRefreshVerifiedList, 800);

function detectiOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function requestMicrophonePermission() {
    // iOS cannot use microphone in browsers, skip
    if (detectiOS()) return;
    
    try {
        // Directly request microphone access (will show browser permission dialog)
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // If we got here, permission was granted
        stream.getTracks().forEach(track => track.stop()); // Stop test stream
        microphonePermission = 'granted';
        enableVoiceRecordingButton();
        console.log('[Mic Permission] Permission granted by user');
        return true;
        
    } catch (err) {
        console.warn('[Mic Permission] Error requesting permission:', err);
        microphonePermission = 'denied';
        
        let message = 'Microphone access is denied or unavailable';
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            message = 'You denied microphone access';
        } else if (err.name === 'NotFoundError') {
            message = 'No microphone found on this device';
        }
        disableVoiceRecordingButton(message);
        return false;
    }
}

function enableVoiceRecordingButton() {
    const micBtn = document.querySelector('[onclick="startVoiceRecord()"]');
    if (micBtn) {
        micBtn.disabled = false;
        micBtn.style.opacity = '1';
        micBtn.style.cursor = 'pointer';
        micBtn.title = 'Record voice message';
        micBtn.onclick = startVoiceRecord; // Reset to original function
    }
}

function disableVoiceRecordingButton(reason = null) {
    const micBtn = document.querySelector('[onclick="startVoiceRecord()"]');
    if (micBtn) {
        micBtn.disabled = true;
        micBtn.style.opacity = '0.5';
        micBtn.style.cursor = 'not-allowed';
        
        if (detectiOS()) {
            // iOS specific message
            micBtn.title = 'Voice recording not supported on iOS browsers. This is a limitation of Safari and Chrome on iPhone/iPad.';
            micBtn.onclick = () => {
                alert('Voice recording is not available on iOS Safari or Chrome due to browser limitations. You can:\n\n1. Use a different device\n2. Send file attachments instead\n3. Try WebRTC apps that support recording');
            };
        } else if (reason) {
            // Generic microphone denied message
            micBtn.title = reason;
            micBtn.onclick = () => {
                alert(reason + '\n\nYou can:\n1. Check browser permissions\n2. Refresh the page and grant microphone access\n3. Send file attachments instead');
            };
        }
    }
}

document.addEventListener('DOMContentLoaded', function() {
    // Fetch server info: fast transfer port + shared directory to start in
    fetchServerInfo(true);
    
    // Restore auth session
    mobRestoreAuth();
    
    // Initialize P2P (needed for device ID, call polling, etc.)
    p2pInit();
    
    // Set up event listeners
    document.getElementById('searchInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            performSearch();
        }
    });

    // Enter to send chat message
    const chatInputEl = document.getElementById('chatInput');
    if (chatInputEl) {
        chatInputEl.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
        // Auto-grow textarea with smart scrollbar
        chatInputEl.addEventListener('input', function() {
            this.style.height = 'auto';
            const h = Math.min(this.scrollHeight, 80);
            this.style.height = h + 'px';
            if (this.scrollHeight > 80) {
                this.classList.add('has-scroll');
            } else {
                this.classList.remove('has-scroll');
            }
            // Signal typing
            _emitTyping();
        });
    }
});

// Fetch server info (shared directory, fast port, etc.)
// Returns true if the shared directory changed on the server
async function fetchServerInfo(navigateToRoot) {
    try {
        const r = await fetch('/api/info?_t=' + Date.now());
        const data = await r.json();
        if (data.ip && data.fast_port) {
            fastBaseUrl = `http://${data.ip}:${data.fast_port}`;
        }
        const newRoot = data.directory || '';
        const rootChanged = rootDir !== '' && rootDir !== newRoot;
        rootDir = newRoot;
        if (navigateToRoot || rootChanged) {
            loadDirectory(rootDir);
            loadQuickAccess(rootDir || null);
        }
        return rootChanged;
    } catch(e) {
        if (navigateToRoot) {
            loadDirectory('');
            loadQuickAccess(null);
        }
        return false;
    }
}

// Load directory contents
async function loadDirectory(path) {
    const browserContent = document.getElementById('browserContent');
    browserContent.innerHTML = '<div class="loading"><div class="loading-spinner"></div>Loading files...</div>';
    
    try {
        const cacheBust = '_t=' + Date.now();
        const url = path
            ? `/api/browse?path=${encodeURIComponent(path)}&${cacheBust}`
            : `/api/browse?${cacheBust}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.error) {
            browserContent.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Error: ${data.error}</p></div>`;
            return;
        }
        
        currentPath = data.current_dir;
        currentFiles = data.files || [];
        currentDirectories = data.directories || [];
        
        // Update breadcrumb
        updateBreadcrumb(data.current_dir, data.parent_dir);
        
        // Update stats
        updateStats(currentDirectories.length, currentFiles.length, calculateTotalSize(currentFiles));
        
        // Display contents
        displayBrowserContents();
        
    } catch (error) {
        console.error('Failed to load directory:', error);
        browserContent.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load directory. Check server connection.</p></div>`;
    }
}

// Load quick access folders
async function loadQuickAccess(sharedDir) {
    const quickAccess = document.getElementById('quickAccess');
    
    try {
        const response = await fetch('/api/special_dirs?_t=' + Date.now());
        const data = await response.json();
        
        // Prepend a pinned "Shared Folder" shortcut at the top
        let html = '';
        if (sharedDir) {
            html += `
                <div class="quick-access-item quick-access-pinned" onclick="loadDirectory('${sharedDir.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')"
                     title="Shared folder">
                    <i class="fas fa-share-alt"></i>
                    <div class="item-name">Shared</div>
                </div>
            `;
        }

        if (data.special_dirs && data.special_dirs.length > 0) {
            data.special_dirs.forEach(dir => {
                const icon = getDirIcon(dir.icon);
                html += `
                    <div class="quick-access-item" onclick="navigateTo('${encodeURIComponent(dir.path)}')" title="${escapeHtml(dir.path)}">
                        <i class="fas fa-${icon}"></i>
                        <div class="item-name">${escapeHtml(dir.name)}</div>
                    </div>
                `;
            });
        }
        
        quickAccess.innerHTML = html || '<div class="empty-state">No quick access folders found</div>';
    } catch (error) {
        console.error('Failed to load quick access:', error);
        quickAccess.innerHTML = '<div class="empty-state">Failed to load quick access</div>';
    }
}

// Display browser contents
function displayBrowserContents() {
    const browserContent = document.getElementById('browserContent');
    
    if (currentDirectories.length === 0 && currentFiles.length === 0) {
        browserContent.innerHTML = '<div class="empty-state"><i class="fas fa-folder-open"></i><p>This folder is empty</p></div>';
        updatePagination();
        return;
    }
    
    // Combine directories and files
    let allItems = [
        ...currentDirectories.map(dir => ({ ...dir, type: 'directory' })),
        ...currentFiles.map(file => ({ ...file, type: 'file' }))
    ];
    
    // Sort items
    allItems.sort((a, b) => {
        // Directories always first
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        
        // Then sort by selected field
        let aValue = a[currentSort.field];
        let bValue = b[currentSort.field];
        
        if (currentSort.field === 'name') {
            aValue = a.name.toLowerCase();
            bValue = b.name.toLowerCase();
        } else if (currentSort.field === 'size') {
            aValue = a.size || 0;
            bValue = b.size || 0;
        } else if (currentSort.field === 'modified') {
            aValue = a.modified || 0;
            bValue = b.modified || 0;
        }
        
        if (aValue < bValue) return currentSort.ascending ? -1 : 1;
        if (aValue > bValue) return currentSort.ascending ? 1 : -1;
        return 0;
    });
    
    // Pagination
    const totalPages = Math.ceil(allItems.length / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, allItems.length);
    const pageItems = allItems.slice(startIndex, endIndex);
    
    // Generate HTML
    let html = '';
    
    pageItems.forEach(item => {
        if (item.type === 'directory') {
            html += createDirectoryItem(item);
        } else {
            html += createFileItem(item);
        }
    });
    
    browserContent.innerHTML = html;
    updatePagination(totalPages);
    updateSortIcons();
}

// Create directory item HTML
function createDirectoryItem(dir) {
    return `
        <div class="browser-item folder" onclick="navigateTo('${encodeURIComponent(dir.path)}')">
            <div class="item-icon-wrap"><i class="fas fa-folder"></i></div>
            <div class="item-meta">
                <div class="name-row">
                    <span class="item-name-text">${escapeHtml(dir.name)}</span>
                </div>
                <div class="item-sub"><span>Folder</span></div>
            </div>
            <div class="item-actions">
                <button class="action-icon open" title="Open" onclick="event.stopPropagation(); navigateTo('${encodeURIComponent(dir.path)}')">
                    <i class="fas fa-folder-open"></i>
                </button>
            </div>
        </div>
    `;
}

// Create file item HTML
function createFileItem(file) {
    const fileClass = getFileClass(file.extension);
    const fileIcon = getFileIcon(file.extension);
    const sizeFormatted = formatFileSize(file.size);
    const dateFormatted = formatDateShort(file.modified);
    const badge = getFileTypeBadge(file.extension);
    const ext = file.extension.toLowerCase();
    const isImage = ['.jpg','.jpeg','.png','.gif','.bmp','.webp'].includes(ext);
    const isVideo = ['.mp4','.avi','.mov','.mkv','.wmv'].includes(ext);
    const isAudio = ['.mp3','.wav','.flac','.aac','.ogg'].includes(ext);
    const isPreviewable = isImage || isVideo || isAudio;

    const clickAction = isPreviewable
        ? `openPreview('${encodeURIComponent(file.path)}','${escapeHtml(file.name)}','${ext}')`
        : `showFileInfo('${encodeURIComponent(file.path)}','${escapeHtml(file.name)}',${file.size},'${file.extension}')`;

    let iconHtml;
    if (isImage) {
        const previewUrl = `/api/preview?path=${encodeURIComponent(file.path)}`;
        iconHtml = `<div class="item-icon-wrap thumb-wrap"><img class="item-thumb" src="${previewUrl}" loading="lazy" onerror="this.parentElement.classList.remove('thumb-wrap');this.nextElementSibling.style.display='';this.remove()"><i class="fas fa-${fileIcon}" style="display:none"></i></div>`;
    } else if (isVideo || isAudio) {
        iconHtml = `<div class="item-icon-wrap"><i class="fas fa-${fileIcon}"></i><span class="play-badge"><i class="fas fa-play"></i></span></div>`;
    } else {
        iconHtml = `<div class="item-icon-wrap"><i class="fas fa-${fileIcon}"></i></div>`;
    }

    return `
        <div class="browser-item file ${fileClass}" onclick="${clickAction}">
            ${iconHtml}
            <div class="item-meta">
                <div class="name-row">
                    <span class="item-name-text">${escapeHtml(file.name)}</span>
                    ${badge}
                </div>
                <div class="item-sub">
                    <span>${sizeFormatted}</span>
                    <span>${dateFormatted}</span>
                </div>
            </div>
            <div class="item-actions">
                <button class="action-icon download" title="Download" onclick="event.stopPropagation(); downloadFile('${encodeURIComponent(file.path)}', '${escapeHtml(file.name)}', ${file.size})">
                    <i class="fas fa-download"></i>
                </button>
                <button class="action-icon info" title="Info" onclick="event.stopPropagation(); showFileInfo('${encodeURIComponent(file.path)}', '${escapeHtml(file.name)}', ${file.size}, '${file.extension}')">
                    <i class="fas fa-info-circle"></i>
                </button>
            </div>
        </div>
    `;
}

// ── File preview modal ──────────────────────────────────────────
function openPreview(filepath, filename, ext) {
    const rawPath = decodeURIComponent(filepath);
    const url = `/api/preview?path=${encodeURIComponent(rawPath)}`;
    
    // Use custom players for video and audio
    if (['.mp4','.avi','.mov','.mkv','.wmv','.webm'].includes(ext)) {
        openVideoPlayer(url, filename);
        return;
    } else if (['.mp3','.wav','.flac','.aac','.ogg','.m4a'].includes(ext)) {
        openAudioPlayer(url, filename);
        return;
    }
    
    // For images and other files, use default preview modal
    const modal = document.getElementById('previewModal');
    const body = document.getElementById('previewBody');
    const title = document.getElementById('previewTitle');
    const footer = document.getElementById('previewFooter');
    title.textContent = filename;

    if (['.jpg','.jpeg','.png','.gif','.bmp','.webp'].includes(ext)) {
        body.innerHTML = `<img src="${url}" class="preview-img" alt="${escapeHtml(filename)}">`;
    }

    footer.innerHTML = `<button class="btn preview-dl-btn" onclick="downloadFile('${filepath}','${escapeHtml(filename)}',0)"><i class="fas fa-download"></i> Download</button>`;
    modal.style.display = 'flex';
}

function closePreview() {
    const modal = document.getElementById('previewModal');
    const body = document.getElementById('previewBody');
    const vid = body.querySelector('video');
    const aud = body.querySelector('audio');
    if (vid) vid.pause();
    if (aud) aud.pause();
    body.innerHTML = '';
    modal.style.display = 'none';
}

// Short date formatter for item sub-line
function formatDateShort(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp * 1000);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Navigate to directory
function navigateTo(path) {
    currentPage = 1;
    loadDirectory(path);
}

// Go up to parent directory
function goUp() {
    // Normalize paths for comparison (handle mixed / and \\ separators)
    const norm = p => p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!currentPath || norm(currentPath) === norm(rootDir)) {
        window.location.href = '/';
        return;
    }
    const parts = norm(currentPath).split('/');
    parts.pop();
    const parent = parts.join('/') || rootDir;
    navigateTo(parent);
}

// Go to home directory
function goToHomeDir() {
    navigateTo('');
}

// Go to main home page
function goToHome() {
    window.location.href = '/';
}

// Refresh browser — also re-fetch server info to pick up directory changes
function refreshBrowser() {
    fetchServerInfo(false).then(rootChanged => {
        // Only reload current path if the root didn't change
        // (if root changed, fetchServerInfo already navigated to the new root)
        if (!rootChanged) {
            loadDirectory(currentPath);
        }
    });
}

// Update breadcrumb
function updateBreadcrumb(currentDir, parentDir) {
    const breadcrumb = document.getElementById('breadcrumb');
    const pathDisplay = document.getElementById('pathDisplay');
    
    // Simple path display
    pathDisplay.textContent = currentDir || 'Home Directory';
    
    // Optional: Create clickable breadcrumb trail
    // For now, just show the current path
}

// Update statistics
function updateStats(dirCount, fileCount, totalSize) {
    document.getElementById('dirCount').textContent = dirCount;
    document.getElementById('fileCount').textContent = fileCount;
    document.getElementById('totalSize').textContent = formatFileSize(totalSize);
    const badge = document.getElementById('itemCountBadge');
    if (badge) {
        const total = dirCount + fileCount;
        badge.textContent = total > 0 ? `${total} item${total !== 1 ? 's' : ''}` : '';
    }
}

// Calculate total size of files
function calculateTotalSize(files) {
    return files.reduce((total, file) => total + (file.size || 0), 0);
}

// Sort by field
function sortBy(field) {
    if (currentSort.field === field) {
        currentSort.ascending = !currentSort.ascending;
    } else {
        currentSort.field = field;
        currentSort.ascending = true;
    }
    displayBrowserContents();
}

// Update sort icons
function updateSortIcons() {
    // Reset all icons and button states
    ['Name', 'Size', 'Modified'].forEach(f => {
        const icon = document.getElementById('sort' + f);
        if (icon) icon.className = 'fas fa-sort';
    });
    ['sbName', 'sbSize', 'sbMod'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.remove('active');
    });

    // Set active sort icon
    const activeIcon = document.getElementById(`sort${capitalizeFirst(currentSort.field)}`);
    if (activeIcon) {
        activeIcon.className = currentSort.ascending ? 'fas fa-sort-up' : 'fas fa-sort-down';
    }
    // Highlight active sort button
    const btnMap = { name: 'sbName', size: 'sbSize', modified: 'sbMod' };
    const activeBtn = document.getElementById(btnMap[currentSort.field]);
    if (activeBtn) activeBtn.classList.add('active');
}

// Update pagination
function updatePagination(totalPages = 1) {
    const pageInfo = document.getElementById('pageInfo');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    
    pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
}

// Previous page
function previousPage() {
    if (currentPage > 1) {
        currentPage--;
        displayBrowserContents();
    }
}

// Next page
function nextPage() {
    const totalItems = currentDirectories.length + currentFiles.length;
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    
    if (currentPage < totalPages) {
        currentPage++;
        displayBrowserContents();
    }
}

// Search files
function performSearch() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase().trim();
    
    if (!searchTerm) {
        displayBrowserContents();
        return;
    }
    
    const browserContent = document.getElementById('browserContent');
    const allItems = [
        ...currentDirectories.map(dir => ({ ...dir, type: 'directory' })),
        ...currentFiles.map(file => ({ ...file, type: 'file' }))
    ];
    
    const filteredItems = allItems.filter(item => 
        item.name.toLowerCase().includes(searchTerm)
    );
    
    if (filteredItems.length === 0) {
        browserContent.innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><p>No files or folders found matching "${escapeHtml(searchTerm)}"</p></div>`;
        updatePagination(1);
        return;
    }
    
    // Display filtered results
    let html = '';
    filteredItems.forEach(item => {
        if (item.type === 'directory') {
            html += createDirectoryItem(item);
        } else {
            html += createFileItem(item);
        }
    });
    
    browserContent.innerHTML = html;
    updatePagination(1);
}

// Show file information
function showFileInfo(filepath, filename, size, extension) {
    const fileInfo = document.getElementById('fileInfo');
    const sizeFormatted = formatFileSize(size);
    const fileIcon = getFileIcon(extension);

    fileInfo.innerHTML = `
        <div class="file-details active">
            <div class="file-detail-item">
                <span class="file-detail-label">Name</span>
                <span class="file-detail-value">${escapeHtml(filename)}</span>
            </div>
            <div class="file-detail-item">
                <span class="file-detail-label">Type</span>
                <span class="file-detail-value">${extension ? extension.toUpperCase() : 'Unknown'} &nbsp;<i class="fas fa-${fileIcon}"></i></span>
            </div>
            <div class="file-detail-item">
                <span class="file-detail-label">Size</span>
                <span class="file-detail-value">${sizeFormatted}</span>
            </div>
            <div style="display:flex;gap:8px;margin-top:12px;">
                <button class="btn" style="flex:1;" onclick="downloadFile('${encodeURIComponent(filepath)}', '${escapeHtml(filename)}', ${size})">
                    <i class="fas fa-download"></i> Download
                </button>
                <button class="btn btn-secondary" style="flex:1;" onclick="shareFile('${encodeURIComponent(filepath)}', '${escapeHtml(filename)}')">
                    <i class="fas fa-share"></i> Share
                </button>
            </div>
        </div>
    `;
}
// ── File Download ─────────────────────────────────────────────────────────
// Priority:
//  1. Fast server (port 5002) — raw TCP, no Python GIL, kernel streams
//     straight to phone disk via window.open (fastest possible)
//  2. Flask /api/dl — fallback when fast server unavailable

function downloadFile(filepath, filename, fileSize) {
    let transferCount = parseInt(localStorage.getItem('transferCount') || 0);
    localStorage.setItem('transferCount', transferCount + 1);

    const rawPath = decodeURIComponent(filepath);

    // Show animated download overlay
    _showDlOverlay(filename);

    // Always use same-origin HTTPS endpoint — avoids mixed-content blocks
    // that hide downloads on Android when the page is served over HTTPS.
    const url = `/api/dl?path=${encodeURIComponent(rawPath)}`;

    // Use an anchor click with download attribute for reliable file saves
    setTimeout(() => {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Auto-dismiss overlay after 3 s
        setTimeout(_hideDlOverlay, 3000);
    }, 120);
}

function _showDlOverlay(filename) {
    const overlay = document.getElementById('dlOverlay');
    const nameEl  = document.getElementById('dlFilename');
    if (!overlay) return;
    if (nameEl) nameEl.textContent = filename;
    overlay.style.display = 'flex';
}
function _hideDlOverlay() {
    const overlay = document.getElementById('dlOverlay');
    if (overlay) overlay.style.display = 'none';
}

// Share file — prefer fast server (port 5002) then fall back to Flask
function shareFile(filepath, filename) {
    const rawPath = decodeURIComponent(filepath);
    const url = fastBaseUrl
        ? `${fastBaseUrl}/?path=${encodeURIComponent(rawPath)}`
        : `${window.location.origin}/api/dl?path=${encodeURIComponent(rawPath)}`;

    if (navigator.share) {
        navigator.share({
            title: `Download ${filename}`,
            text: 'Download this file from my laptop over Wi-Fi',
            url: url
        });
    } else {
        navigator.clipboard.writeText(url).then(() => {
            showNotification('Download link copied to clipboard!');
        });
    }
}

// Helper functions
function getFileClass(extension) {
    const ext = extension.toLowerCase();
    if (ext === '.apk') return 'apk';
    if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext)) return 'image';
    if (['.mp4', '.avi', '.mov', '.mkv', '.wmv'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.flac', '.aac', '.ogg'].includes(ext)) return 'audio';
    if (['.pdf', '.doc', '.docx', '.txt', '.rtf'].includes(ext)) return 'document';
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) return 'archive';
    return '';
}

function getFileIcon(extension) {
    const ext = extension.toLowerCase();
    if (ext === '.apk') return 'android';
    if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext)) return 'file-image';
    if (['.mp4', '.avi', '.mov', '.mkv', '.wmv'].includes(ext)) return 'file-video';
    if (['.mp3', '.wav', '.flac', '.aac', '.ogg'].includes(ext)) return 'file-audio';
    if (['.pdf'].includes(ext)) return 'file-pdf';
    if (['.doc', '.docx'].includes(ext)) return 'file-word';
    if (['.txt', '.rtf'].includes(ext)) return 'file-alt';
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) return 'file-archive';
    return 'file';
}

function getFileTypeBadge(extension) {
    if (!extension) return '';
    const ext = extension.toLowerCase();
    if (ext === '.apk') return '<span class="item-badge badge-apk">APK</span>';
    if (['.jpg','.jpeg','.png','.gif','.bmp','.webp'].includes(ext)) return '<span class="item-badge badge-image">IMG</span>';
    if (['.mp4','.avi','.mov','.mkv','.wmv'].includes(ext)) return '<span class="item-badge badge-video">VID</span>';
    if (['.mp3','.wav','.flac','.aac','.ogg'].includes(ext)) return '<span class="item-badge badge-audio">AUD</span>';
    if (['.pdf'].includes(ext)) return '<span class="item-badge badge-pdf">PDF</span>';
    if (['.zip','.rar','.7z','.tar','.gz'].includes(ext)) return '<span class="item-badge badge-archive">ZIP</span>';
    if (['.doc','.docx','.txt','.xls','.xlsx','.ppt','.pptx'].includes(ext)) return '<span class="item-badge badge-document">DOC</span>';
    return '';
}

function getDirIcon(iconName) {
    const icons = {
        'desktop': 'desktop',
        'download': 'download',
        'folder': 'folder',
        'image': 'images',
        'music': 'music',
        'video': 'video',
        'android': 'android'
    };
    return icons[iconName] || 'folder';
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function capitalizeFirst(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Show notification
function showNotification(message, type = 'success') {
    // Remove existing notification
    const existing = document.querySelector('.notification');
    if (existing) existing.remove();
    
    // Create notification
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <span>${message}</span>
        <button onclick="this.parentElement.remove()">&times;</button>
    `;
    
    // Add styles
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'error' ? '#f8d7da' : type === 'warning' ? '#fff3cd' : '#d1ecf1'};
        color: ${type === 'error' ? '#721c24' : type === 'warning' ? '#856404' : '#0c5460'};
        padding: 15px 20px;
        border-radius: 8px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-width: 300px;
        max-width: 400px;
        animation: slideIn 0.3s ease;
    `;
    
    // Add button styles
    notification.querySelector('button').style.cssText = `
        background: none;
        border: none;
        font-size: 20px;
        cursor: pointer;
        margin-left: 15px;
        color: inherit;
    `;
    
    document.body.appendChild(notification);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        if (notification.parentElement) {
            notification.remove();
        }
    }, 5000);
    
    // Add CSS animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
    `;
    document.head.appendChild(style);
}

// Modal functions
function showHelp() {
    document.getElementById('helpModal').style.display = 'flex';
}

function showAbout() {
    document.getElementById('aboutModal').style.display = 'flex';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

// Close modals when clicking outside
window.onclick = function(event) {
    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => {
        if (event.target === modal) {
            modal.style.display = 'none';
        }
    });
};

// ══════════════════════════════════════════════════════════════════
//  PHONE-TO-PHONE  SHARING
// ══════════════════════════════════════════════════════════════════

let _p2pDeviceId = localStorage.getItem('p2p_device_id') || '';
let _p2pName = localStorage.getItem('p2p_device_name') || '';
let _p2pPollTimer = null;
let _p2pLastFileCount = 0;
let _p2pSelectMode = false;
let _p2pSelected = new Set();
let _p2pExpiryWarned = new Set();  // file IDs already warned about

// ── Auto-open Share or Chat tab if URL has ?tab=share or ?tab=chat ───────────────────
(function() {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab');
    if (tabParam === 'share' || tabParam === 'chat') {
        // Defer until DOM is ready
        const _tryOpen = () => {
            const btnIndex = tabParam === 'share' ? 1 : 2;  // share=2nd tab, chat=3rd tab
            const btn = document.querySelector(`.btm-tab:nth-child(${btnIndex})`);
            if (btn) switchView(tabParam, btn);
            else setTimeout(_tryOpen, 100);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _tryOpen);
        else _tryOpen();
    }
})();

// ── View switching ──────────────────────────────────────────────
function switchView(view, btn) {
    // Auto-PiP: if in a call on the calls page and navigating away, show PiP
    const currentView = document.querySelector('.view.active');
    const currentViewId = currentView ? currentView.id.replace('view-', '') : '';
    if (_mobCurrentCallId && !_mobPipActive && !_mobCallFromChat && currentViewId === 'calls' && view !== 'calls') {
      mobEnterPiP();
    }

    // Track previous view for back navigation
    const prevView = document.querySelector('.view.active');
    if (prevView) window._mobPrevView = prevView.id.replace('view-', '');

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.btm-tab').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');
    if (btn) btn.classList.add('active');

    // Full-screen AI mode: hide app bar + bottom nav
    if (view === 'bots') {
        document.body.classList.add('ai-fullscreen');
    } else {
        document.body.classList.remove('ai-fullscreen');
    }

    const title = document.getElementById('viewTitle');
    const pathEl = document.getElementById('pathDisplay');
    const upBtn = document.getElementById('btnGoUp');

    if (view === 'share') {
        title.textContent = 'Share';
        pathEl.textContent = 'Phone-to-Phone';
        upBtn.style.display = 'none';
        p2pInit();
    } else if (view === 'chat') {
        title.textContent = 'Messages';
        pathEl.textContent = 'Chat with connected devices';
        upBtn.style.display = 'none';
        p2pInit();
    } else if (view === 'calls') {
        title.textContent = 'Calls';
        pathEl.textContent = 'Voice & Video';
        upBtn.style.display = 'none';
        p2pInit();
        mobInitCalls();
    } else if (view === 'groups') {
        title.textContent = 'Groups';
        pathEl.textContent = 'Private Groups';
        upBtn.style.display = 'none';
        p2pInit();
        mobInitGroups();
    } else if (view === 'bots') {
        title.textContent = 'Bots';
        pathEl.textContent = 'Automation';
        upBtn.style.display = 'none';
        p2pInit();
        mobInitBots();
    } else if (view === 'account') {
        title.textContent = 'Account';
        pathEl.textContent = mobAuthUser ? mobAuthUser.name : 'Login or Register';
        upBtn.style.display = 'none';
        mobUpdateAuthUI();
    } else if (view === 'status') {
        title.textContent = 'Status';
        pathEl.textContent = 'Stories & Updates';
        upBtn.style.display = 'none';
        statusInit();
    } else if (view === 'subscription') {
        title.textContent = 'Premium';
        pathEl.textContent = 'Subscription & Plans';
        upBtn.style.display = 'none';
        mobLoadSubscriptionPage();
    } else {
        title.textContent = 'Files';
        pathEl.textContent = currentPath || 'Loading';
        upBtn.style.display = currentPath ? '' : 'none';
    }
}

// ── P2P Init ────────────────────────────────────────────────────
async function p2pInit() {
    if (!_p2pDeviceId) {
        // Initialize E2EE in background (non-blocking)
        initBrowserE2EEAsync();
        await p2pRegister(_p2pName);
    } else {
        await p2pRegister(_p2pName);
    }
    p2pStartPolling();
    _loadP2PQR();
    _renderHistory();
}

// ═══════════════════════════════════════════════════════════════
// E2EE BROWSER SUPPORT
// ═══════════════════════════════════════════════════════════════

// Non-blocking async initialization (runs in background)
function initBrowserE2EEAsync() {
    setTimeout(async () => {
        try {
            await initBrowserE2EE();
        } catch (err) {
            console.error('[E2EE] Browser async init failed:', err);
        }
    }, 200);
}

async function initBrowserE2EE() {
    try {
        if (!window.LocalBeamCrypto || !LocalBeamCrypto.isSupported()) {
            console.warn('[E2EE] WebCrypto not supported');
            e2eeEnabled = false;
            return;
        }
        
        const result = await LocalBeamCrypto.init();
        browserPublicKey = result.publicKey;
        e2eeEnabled = true;
        console.log('[E2EE] Browser crypto initialized');
    } catch (err) {
        console.error('[E2EE] Init failed:', err);
        e2eeEnabled = false;
    }
}

async function fetchPeerKeyForDevice(deviceId) {
    try {
        if (LocalBeamCrypto.hasKeyFor(deviceId)) return true;
        
        const r = await fetch('/api/p2p/key/' + deviceId);
        if (!r.ok) return false;
        
        const data = await r.json();
        return await LocalBeamCrypto.importPeerKey(deviceId, data.public_key);
    } catch (err) {
        console.error('[E2EE] Key fetch failed:', err);
        return false;
    }
}

async function p2pRegister(name) {
    try {
        const body = { 
            device_id: _p2pDeviceId || undefined, 
            name: name || undefined,
            public_key: browserPublicKey || ''  // Include E2EE public key
        };
        const r = await fetch('/api/p2p/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const d = await r.json();
        _p2pDeviceId = d.device_id;
        _p2pName = d.name;
        localStorage.setItem('p2p_device_id', _p2pDeviceId);
        localStorage.setItem('p2p_device_name', _p2pName);
        document.getElementById('p2pMyName').textContent = _p2pName;
        document.getElementById('p2pMyId').textContent = 'ID: ' + _p2pDeviceId + (d.e2ee ? ' 🔒' : '');
    } catch (e) {
        console.error('P2P register error:', e);
    }
}

function p2pStartPolling() {
    if (_p2pPollTimer) return;
    _p2pPoll();
    _p2pPollTimer = setInterval(_p2pPoll, 3000);
}

let _onlineAvailable = true;

function toggleOnlineStatus(isOnline) {
    _onlineAvailable = isOnline;
    const statusText = document.getElementById('onlineStatusText');
    if (statusText) {
        if (isOnline) {
            statusText.textContent = 'Receiving messages & files';
            statusText.classList.add('active');
        } else {
            statusText.textContent = 'Paused — not receiving';
            statusText.classList.remove('active');
        }
    }
    if (isOnline) {
        // Re-register and resume polling
        p2pStartPolling();
        if (_chatCurrentConversation) {
            loadChatMessages(_chatCurrentConversation);
        }
    } else {
        // Unregister (go invisible) and stop polling
        if (_p2pPollTimer) { clearInterval(_p2pPollTimer); _p2pPollTimer = null; }
        if (_chatPollTimer) { clearInterval(_chatPollTimer); _chatPollTimer = null; }
        if (_typingPollTimer) { clearInterval(_typingPollTimer); _typingPollTimer = null; }
        // Remove from device list
        fetch('/api/p2p/unregister', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: _p2pDeviceId })
        }).catch(() => {});
    }
}

async function _p2pPoll() {
    if (!_onlineAvailable) return;
    // Heartbeat
    try {
        fetch('/api/p2p/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: _p2pDeviceId, name: _p2pName })
        });
    } catch (_) {}

    // Load devices
    try {
        const r = await fetch('/api/p2p/devices?_t=' + Date.now());
        const d = await r.json();
        _renderDevices(d.devices || []);
    } catch (_) {}

    // Load shared files
    try {
        const r = await fetch('/api/p2p/files?_t=' + Date.now());
        const d = await r.json();
        _renderP2PFiles(d.files || []);
        _checkExpiryWarnings(d.files || []);
        // Update badge
        const count = (d.files || []).length;
        const badge = document.getElementById('p2pBadge');
        if (count > 0 && count !== _p2pLastFileCount) {
            badge.textContent = count;
            badge.style.display = '';
        }
        if (count === 0) badge.style.display = 'none';
        _p2pLastFileCount = count;
    } catch (_) {}
}

// ── Render devices ──────────────────────────────────────────────
function _renderDevices(devices) {
    const el = document.getElementById('p2pDeviceList');
    const countEl = document.getElementById('p2pDeviceCount');
    const others = devices.filter(d => d.id !== _p2pDeviceId);
    countEl.textContent = others.length;

    if (others.length === 0) {
        el.innerHTML = '<div class="p2p-empty"><i class="fas fa-search"></i> No other devices connected</div>';
        return;
    }
    el.innerHTML = others.map(d => {
        const icon = d.user_agent.includes('iPhone') ? 'fa-apple-alt' :
                     d.user_agent.includes('Android') ? 'fa-android' : 'fa-mobile-alt';
        const ago = Math.round((Date.now()/1000 - d.last_seen));
        const status = ago < 10 ? 'Online' : `${ago}s ago`;
        return `
            <div class="p2p-device-row">
                <div class="p2p-device-icon"><i class="fas ${icon}"></i></div>
                <div class="p2p-device-info">
                    <span class="p2p-device-name">${escapeHtml(d.name)} ${mobVBadge(d.id)}</span>
                    <span class="p2p-device-status">${status}</span>
                </div>
                <button class="p2p-disconnect-btn" onclick="p2pDisconnectDevice('${d.id}', '${escapeHtml(d.name)}')">
                    <i class="fas fa-times"></i>
                </button>
                <div class="p2p-device-dot ${ago < 10 ? 'online' : ''}"></div>
            </div>
        `;
    }).join('');
}

function p2pDisconnectDevice(deviceId, deviceName) {
    if (!confirm(`Disconnect from ${deviceName}?`)) return;
    fetch(`/api/p2p/disconnect/${deviceId}`, {method: 'POST'})
        .then(r => r.json())
        .then(d => {
            if (d.status === 'disconnected') {
                _loadP2PDevices();
            }
        })
        .catch(e => console.error('Disconnect failed:', e));
}

// ── Render shared files (with thumbnails, expiry, multi-select) ─
function _renderP2PFiles(files) {
    const el = document.getElementById('p2pFileList');
    const countEl = document.getElementById('p2pFileCount');
    countEl.textContent = files.length;

    if (files.length === 0) {
        el.innerHTML = '<div class="p2p-empty"><i class="fas fa-inbox"></i> No files shared yet</div>';
        return;
    }
    el.innerHTML = files.map(f => {
        const size = formatFileSize(f.size);
        const isMine = f.sender_id === _p2pDeviceId;
        const sender = isMine ? 'You' : escapeHtml(f.sender_name);
        const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
        const icon = getFileIcon(ext);
        const ago = _timeAgo(f.ts);
        const isImage = ['.jpg','.jpeg','.png','.gif','.bmp','.webp'].includes(ext);
        const isMedia = isImage || ['.mp4','.avi','.mov','.mkv','.wmv','.mp3','.wav','.flac','.aac','.ogg'].includes(ext);
        const expiryMin = Math.max(0, Math.ceil((f.expires_in || 0) / 60));
        const expiryClass = expiryMin <= 10 ? 'expiry-warn' : expiryMin <= 30 ? 'expiry-mid' : '';
        const checked = _p2pSelected.has(f.id) ? 'checked' : '';

        let iconHtml;
        if (isImage) {
            iconHtml = `<div class="p2p-file-icon thumb-wrap"><img class="p2p-thumb" src="/api/p2p/preview/${f.id}" loading="lazy" onerror="this.parentElement.classList.remove('thumb-wrap');this.nextElementSibling.style.display='';this.remove()"><i class="fas fa-${icon}" style="display:none"></i></div>`;
        } else {
            iconHtml = `<div class="p2p-file-icon"><i class="fas fa-${icon}"></i></div>`;
        }

        return `
            <div class="p2p-file-row ${_p2pSelectMode ? 'selectable' : ''}" ${isMedia && !_p2pSelectMode ? `onclick="openP2PPreview('${f.id}','${escapeHtml(f.name)}','${ext}')"` : ''}>
                ${_p2pSelectMode ? `<label class="p2p-check"><input type="checkbox" ${checked} onchange="p2pToggleFile('${f.id}')"><span class="p2p-checkmark"></span></label>` : ''}
                ${iconHtml}
                <div class="p2p-file-info">
                    <span class="p2p-file-name">${escapeHtml(f.name)}</span>
                    <span class="p2p-file-sub">${size} · from ${sender} · ${ago}</span>
                    <span class="p2p-file-expiry ${expiryClass}"><i class="fas fa-clock"></i> ${expiryMin}m left</span>
                </div>
                <div class="p2p-file-actions">
                    <button class="p2p-dl-btn" onclick="event.stopPropagation();p2pDownload('${f.id}','${escapeHtml(f.name)}',${f.size})" title="Download">
                        <i class="fas fa-download"></i>
                    </button>
                    ${isMine ? `<button class="p2p-del-btn" onclick="event.stopPropagation();p2pDelete('${f.id}')" title="Remove">
                        <i class="fas fa-trash"></i>
                    </button>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

// ── P2P file preview ────────────────────────────────────────────
function openP2PPreview(fileId, filename, ext) {
    const url = `/api/p2p/preview/${fileId}`;
    const modal = document.getElementById('previewModal');
    const body = document.getElementById('previewBody');
    const title = document.getElementById('previewTitle');
    const footer = document.getElementById('previewFooter');
    title.textContent = filename;

    if (['.jpg','.jpeg','.png','.gif','.bmp','.webp'].includes(ext)) {
        body.innerHTML = `<img src="${url}" class="preview-img" alt="${escapeHtml(filename)}">`;
    } else if (['.mp4','.avi','.mov','.mkv','.wmv'].includes(ext)) {
        body.innerHTML = `<video src="${url}" class="preview-video" controls autoplay playsinline></video>`;
    } else if (['.mp3','.wav','.flac','.aac','.ogg'].includes(ext)) {
        body.innerHTML = `<div class="preview-audio-wrap"><i class="fas fa-music preview-audio-icon"></i><audio src="${url}" class="preview-audio" controls autoplay></audio></div>`;
    }

    footer.innerHTML = `<button class="btn preview-dl-btn" onclick="p2pDownload('${fileId}','${escapeHtml(filename)}',0)"><i class="fas fa-download"></i> Download</button>`;
    modal.style.display = 'flex';
}

// ── Auto-cleanup expiry warnings ────────────────────────────────
function _checkExpiryWarnings(files) {
    files.forEach(f => {
        const min = Math.ceil((f.expires_in || 0) / 60);
        if (min <= 10 && min > 0 && !_p2pExpiryWarned.has(f.id)) {
            _p2pExpiryWarned.add(f.id);
            showNotification(`"${f.name}" expires in ${min} min — download now!`, 'warning');
        }
    });
}

function _timeAgo(ts) {
    const s = Math.round(Date.now()/1000 - ts);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s/60) + 'm ago';
    return Math.round(s/3600) + 'h ago';
}

// ── Multi-select & batch download ───────────────────────────────
function p2pToggleSelect() {
    _p2pSelectMode = !_p2pSelectMode;
    _p2pSelected.clear();
    const bar = document.getElementById('p2pSelectBar');
    bar.style.display = _p2pSelectMode ? 'flex' : 'none';
    document.getElementById('p2pSelCount').textContent = '0';
    _p2pPoll(); // re-render
}

function p2pToggleFile(fileId) {
    if (_p2pSelected.has(fileId)) _p2pSelected.delete(fileId);
    else _p2pSelected.add(fileId);
    document.getElementById('p2pSelCount').textContent = _p2pSelected.size;
}

async function p2pBatchDownload() {
    const ids = Array.from(_p2pSelected);
    for (const fid of ids) {
        // Find filename from the rendered list
        const row = document.querySelector(`[onclick*="${fid}"]`);
        const nameEl = row ? row.querySelector('.p2p-file-name') : null;
        const fname = nameEl ? nameEl.textContent : 'file';
        await p2pDownload(fid, fname, 0);
    }
    _p2pSelectMode = false;
    _p2pSelected.clear();
    document.getElementById('p2pSelectBar').style.display = 'none';
    _p2pPoll();
}

// ── QR Code for Share tab ───────────────────────────────────────
let _qrLoaded = false;
async function _loadP2PQR() {
    if (_qrLoaded) return;
    // Retry up to 3 times
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const r = await fetch('/api/p2p/qr?_t=' + Date.now());
            if (!r.ok) throw new Error(r.status);
            const d = await r.json();
            const el = document.getElementById('p2pQRImg');
            if (el && d.qr) { el.src = d.qr; el.style.display = ''; }
            const urlEl = document.getElementById('p2pQRUrl');
            if (urlEl && d.url) urlEl.textContent = d.url;
            _qrLoaded = true;
            return;
        } catch (_) {
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
        }
    }
}

function toggleQR() {
    const card = document.getElementById('p2pQRCard');
    const icon = document.getElementById('qrToggleIcon');
    card.classList.toggle('collapsed');
    icon.className = card.classList.contains('collapsed') ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
}

// ── Rename device ───────────────────────────────────────────────
function p2pRename() {
    const name = prompt('Enter your device name:', _p2pName);
    if (name && name.trim()) {
        _p2pName = name.trim();
        localStorage.setItem('p2p_device_name', _p2pName);
        p2pRegister(_p2pName);
    }
}

// ── Send files ──────────────────────────────────────────────────
function p2pSelectFiles() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.onchange = (e) => p2pUploadFiles(e.target.files);
    inp.click();
}

async function p2pUploadFiles(files) {
    if (!files || !files.length) return;
    const progWrap = document.getElementById('p2pUploadProgress');
    const progName = document.getElementById('p2pUploadName');
    const progFill = document.getElementById('p2pUploadFill');
    const progSub  = document.getElementById('p2pUploadSub');
    progWrap.style.display = '';

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        progName.textContent = `Sending ${file.name} (${i+1}/${files.length})`;
        progFill.style.width = '0%';
        progSub.textContent = formatFileSize(file.size);

        try {
            await _p2pUploadOne(file, (pct) => {
                progFill.style.width = pct + '%';
                progSub.textContent = `${pct}% · ${formatFileSize(file.size)}`;
            });
            // Record in history
            _addHistory({ name: file.name, size: file.size, type: 'sent' });
        } catch (e) {
            showNotification('Failed to send ' + file.name, 'error');
        }
    }
    progName.textContent = 'All files sent!';
    progFill.style.width = '100%';
    progSub.textContent = '';
    setTimeout(() => { progWrap.style.display = 'none'; }, 2000);
    _p2pPoll();
    _renderHistory();
}

function _p2pUploadOne(file, onProgress) {
    return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('device_id', _p2pDeviceId);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/p2p/send');
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                onProgress(Math.round(e.loaded / e.total * 100));
            }
        };
        xhr.onload = () => {
            if (xhr.status === 200) resolve(JSON.parse(xhr.responseText));
            else reject(new Error(xhr.statusText));
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(fd);
    });
}

// ── Download shared file (with real progress) ───────────────────
function p2pDownload(fileId, filename, fileSize) {
    closePreview(); // close preview modal if open
    const progWrap = document.getElementById('p2pDlProgress');
    const progName = document.getElementById('p2pDlName');
    const progFill = document.getElementById('p2pDlFill');
    const progSub  = document.getElementById('p2pDlSub');

    progWrap.style.display = '';
    progName.textContent = `Downloading ${filename}`;
    progFill.style.width = '0%';
    progSub.textContent = 'Starting…';

    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/api/p2p/download/${fileId}`);
    xhr.responseType = 'blob';

    xhr.onprogress = (e) => {
        if (e.lengthComputable) {
            const pct = Math.round(e.loaded / e.total * 100);
            progFill.style.width = pct + '%';
            progSub.textContent = `${pct}% · ${formatFileSize(e.loaded)} / ${formatFileSize(e.total)}`;
        }
    };

    xhr.onload = () => {
        if (xhr.status === 200) {
            // Trigger browser file save
            const url = URL.createObjectURL(xhr.response);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);

            progName.textContent = 'Download complete!';
            progFill.style.width = '100%';
            progSub.textContent = formatFileSize(xhr.response.size);
            setTimeout(() => { progWrap.style.display = 'none'; }, 2500);

            // Record in history
            _addHistory({ name: filename, size: xhr.response.size || fileSize, type: 'received' });
            _renderHistory();
        } else {
            showNotification('Download failed', 'error');
            progWrap.style.display = 'none';
        }
    };

    xhr.onerror = () => {
        showNotification('Download failed — network error', 'error');
        progWrap.style.display = 'none';
    };

    xhr.send();
}

// ── Delete shared file ──────────────────────────────────────────
async function p2pDelete(fileId) {
    try {
        await fetch(`/api/p2p/delete/${fileId}`, { method: 'POST' });
        _p2pPoll();
    } catch (_) {}
}

// ── Transfer History (localStorage) ─────────────────────────────
function _addHistory(entry) {
    let history = JSON.parse(localStorage.getItem('p2p_history') || '[]');
    history.unshift({ ...entry, time: Date.now() });
    if (history.length > 50) history = history.slice(0, 50);
    localStorage.setItem('p2p_history', JSON.stringify(history));
}

function _renderHistory() {
    const el = document.getElementById('p2pHistory');
    if (!el) return;
    const history = JSON.parse(localStorage.getItem('p2p_history') || '[]');
    if (history.length === 0) {
        el.innerHTML = '<div class="p2p-empty"><i class="fas fa-history"></i> No transfer history</div>';
        return;
    }
    el.innerHTML = history.slice(0, 20).map(h => {
        const icon = h.type === 'sent' ? 'fa-arrow-up' : 'fa-arrow-down';
        const color = h.type === 'sent' ? '#667EEA' : '#4ADE80';
        const ago = _timeAgo(h.time / 1000);
        return `
            <div class="p2p-history-row">
                <div class="p2p-history-icon" style="color:${color}"><i class="fas ${icon}"></i></div>
                <div class="p2p-file-info">
                    <span class="p2p-file-name">${escapeHtml(h.name)}</span>
                    <span class="p2p-file-sub">${formatFileSize(h.size)} · ${h.type} · ${ago}</span>
                </div>
            </div>
        `;
    }).join('');
}

function p2pClearHistory() {
    localStorage.removeItem('p2p_history');
    _renderHistory();
}

// ═══════════════════════════════════════════════════════════
// CUSTOM MEDIA PLAYERS
// ═══════════════════════════════════════════════════════════

let currentVideoFile = null;
let currentAudioFile = null;

// OPEN VIDEO PLAYER
function openVideoPlayer(fileUrl, fileName) {
    currentVideoFile = {url: fileUrl, name: fileName};
    const video = document.getElementById('customVideoElement');
    const modal = document.getElementById('videoPlayerModal');
    
    // Remove old event listeners by cloning
    const newVideo = video.cloneNode(true);
    video.parentNode.replaceChild(newVideo, video);
    
    newVideo.src = fileUrl;
    modal.style.display = 'flex';
    
    // Reset play button
    const playBtn = document.querySelector('.video-player-wrap .btn-control');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-pause"></i>';
    
    newVideo.addEventListener('loadedmetadata', () => {
        document.getElementById('duration').textContent = formatTime(newVideo.duration);
    });
    
    newVideo.addEventListener('timeupdate', () => {
        const progress = (newVideo.currentTime / newVideo.duration) * 100 || 0;
        document.getElementById('videoProgress').value = progress;
        document.getElementById('currentTime').textContent = formatTime(newVideo.currentTime);
    });
    
    newVideo.addEventListener('ended', () => {
        const playBtn = document.querySelector('.video-player-wrap .btn-control');
        if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
    });
    
    document.getElementById('videoProgress').oninput = (e) => {
        newVideo.currentTime = (e.target.value / 100) * newVideo.duration;
    };
    
    document.getElementById('videoVolume').oninput = (e) => {
        newVideo.volume = e.target.value / 100;
    };
    
    newVideo.play().catch(e => console.log('Video autoplay blocked'));
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
    document.getElementById('customVideoElement').currentTime -= 10;
}

function forwardVideo() {
    document.getElementById('customVideoElement').currentTime += 10;
}

function toggleVideoMute() {
    const video = document.getElementById('customVideoElement');
    const btn = document.querySelector('.volume-container .btn-control');
    if (video.muted) {
        video.muted = false;
        btn.innerHTML = '<i class="fas fa-volume-up"></i>';
    } else {
        video.muted = true;
        btn.innerHTML = '<i class="fas fa-volume-mute"></i>';
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

// OPEN AUDIO PLAYER
let audioVisualizerInterval = null;

function openAudioPlayer(fileUrl, fileName) {
    currentAudioFile = {url: fileUrl, name: fileName};
    const audio = document.getElementById('customAudioElement');
    const modal = document.getElementById('audioPlayerModal');
    
    // Remove old event listeners by cloning
    const newAudio = audio.cloneNode(true);
    audio.parentNode.replaceChild(newAudio, audio);
    
    newAudio.src = fileUrl;
    modal.style.display = 'flex';
    document.getElementById('audioName').textContent = fileName;
    
    // Reset play button
    const playBtn = document.querySelector('.btn-play-large');
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-pause"></i>';
    
    newAudio.addEventListener('loadedmetadata', () => {
        document.getElementById('audioDuration').textContent = formatTime(newAudio.duration);
    });
    
    newAudio.addEventListener('timeupdate', () => {
        const progress = (newAudio.currentTime / newAudio.duration) * 100 || 0;
        document.getElementById('audioProgress').value = progress;
        document.getElementById('audioCurrentTime').textContent = formatTime(newAudio.currentTime);
    });
    
    newAudio.addEventListener('play', () => {
        startAudioVisualizer();
        const playBtn = document.querySelector('.btn-play-large');
        if (playBtn) playBtn.innerHTML = '<i class="fas fa-pause"></i>';
    });
    
    newAudio.addEventListener('pause', () => {
        stopAudioVisualizer();
        const playBtn = document.querySelector('.btn-play-large');
        if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
    });
    
    newAudio.addEventListener('ended', () => {
        stopAudioVisualizer();
        const playBtn = document.querySelector('.btn-play-large');
        if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
    });
    
    document.getElementById('audioProgress').oninput = (e) => {
        newAudio.currentTime = (e.target.value / 100) * newAudio.duration;
    };
    
    document.getElementById('audioVolume').oninput = (e) => {
        newAudio.volume = e.target.value / 100;
    };
    
    newAudio.play().catch(e => console.log('Audio autoplay blocked'));
}

function startAudioVisualizer() {
    const bars = document.querySelectorAll('.vis-bar');
    bars.forEach(bar => bar.style.animationPlayState = 'running');
}

function stopAudioVisualizer() {
    const bars = document.querySelectorAll('.vis-bar');
    bars.forEach(bar => bar.style.animationPlayState = 'paused');
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
    document.getElementById('customAudioElement').currentTime -= 5;
}

function forwardAudio() {
    document.getElementById('customAudioElement').currentTime += 5;
}

function toggleAudioMute() {
    const audio = document.getElementById('customAudioElement');
    const btn = document.querySelector('.audio-controls .volume-container .btn-control');
    if (audio.muted) {
        audio.muted = false;
        btn.innerHTML = '<i class="fas fa-volume-up"></i>';
    } else {
        audio.muted = true;
        btn.innerHTML = '<i class="fas fa-volume-mute"></i>';
    }
}

function changeAudioSpeed() {
    const speed = parseFloat(document.getElementById('audioSpeed').value);
    document.getElementById('customAudioElement').playbackRate = speed;
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════
// TRANSFER REQUESTS
// ═════════════════════════════════════════════════════════════

let currentTransferRequest = null;

// Poll for incoming transfer requests 
setInterval(() => {
    if (_p2pMyId) {
        checkIncomingRequests();
    }
}, 3000);

async function checkIncomingRequests() {
    try {
        const r = await fetch(`/api/p2p/incoming-requests?device_id=${_p2pMyId}`);
        const data = await r.json();
        if (data.requests && data.requests.length > 0) {
            showTransferRequest(data.requests[0]);
        }
    } catch (e) {
        // Silent fail
    }
}

function showTransferRequest(request) {
    currentTransferRequest = request;
    document.getElementById('requestFileName').textContent = request.name;
    document.getElementById('requestFileSize').textContent = formatFileSize(request.size);
    document.getElementById('requestFromSender').textContent = `From: ${request.sender_name || 'Unknown Device'}`;
    document.getElementById('transferRequestModal').style.display = 'flex';
}

function closeTransferRequest() {
    document.getElementById('transferRequestModal').style.display = 'none';
    currentTransferRequest = null;
}

async function acceptCurrentRequest() {
    if (!currentTransferRequest) return;
    
    try {
        const r = await fetch('/api/p2p/accept-transfer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({request_id: currentTransferRequest.id})
        });
        
        if (r.ok) {
            closeTransferRequest();
            _addHistory(currentTransferRequest.name, currentTransferRequest.size, 'received');
            _poll();  // Refresh files list
        }
    } catch (e) {
        console.error('Error accepting transfer:', e);
    }
}

async function rejectCurrentRequest() {
    if (!currentTransferRequest) return;
    
    try {
        const r = await fetch('/api/p2p/reject-transfer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({request_id: currentTransferRequest.id})
        });
        
        if (r.ok) {
            closeTransferRequest();
            _poll();
        }
    } catch (e) {
        console.error('Error rejecting transfer:', e);
    }
}

// ═══════════════════════════════════════════════════════════
// CHAT MESSENGER
// ═══════════════════════════════════════════════════════════

let _chatConversations = {};  // device_id -> { device_id, name, last_message, timestamp }
let _chatCurrentConversation = null;
let _chatMessages = [];
let _chatLastMessageId = null;  // Track last loaded message to only append new ones
let _chatPollTimer = null;
let _typingPollTimer = null;
let _lastTypingEmit = 0;

// Emit typing signal (throttled to once per 2.5 seconds)
function _emitTyping() {
    if (!_chatCurrentConversation || !_p2pDeviceId) return;
    const now = Date.now();
    if (now - _lastTypingEmit < 2500) return;
    _lastTypingEmit = now;
    fetch('/api/p2p/typing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender_id: _p2pDeviceId, recipient_id: _chatCurrentConversation })
    }).catch(() => {});
}

// Poll for typing status of the other user
async function _pollTyping() {
    if (!_chatCurrentConversation || !_p2pDeviceId) return;
    try {
        const r = await fetch(`/api/p2p/typing/${_p2pDeviceId}`);
        const data = await r.json();
        const indicator = document.getElementById('typingIndicator');
        const statusEl = document.getElementById('chatUserStatus');
        if (data.typing && data.typing.length > 0) {
            if (indicator) indicator.classList.add('active');
            if (statusEl) statusEl.style.display = 'none';
        } else {
            if (indicator) indicator.classList.remove('active');
            if (statusEl) statusEl.style.display = '';
        }
    } catch (e) {}
}

async function loadChatList() {
    try {
        const r = await fetch(`/api/p2p/messages?device_id=${_p2pDeviceId}`);
        const data = await r.json();
        
        // Build conversation map from messages
        const convMap = {};
        for (const msg of data.messages || []) {
            const otherDevice = msg.sender_id === _p2pDeviceId ? msg.recipient_id : msg.sender_id;
            const otherName = msg.sender_id === _p2pDeviceId ? msg.sender_name : msg.sender_name;
            if (!convMap[otherDevice]) {
                convMap[otherDevice] = {
                    device_id: otherDevice,
                    name: otherName,
                    last_message: msg.text,
                    timestamp: msg.timestamp,
                    unreadCount: (!msg.read && msg.recipient_id === _p2pDeviceId) ? 1 : 0
                };
            } else {
                if (msg.timestamp > convMap[otherDevice].timestamp) {
                    convMap[otherDevice].last_message = msg.text;
                    convMap[otherDevice].timestamp = msg.timestamp;
                }
                if (!msg.read && msg.recipient_id === _p2pDeviceId) {
                    convMap[otherDevice].unreadCount = (convMap[otherDevice].unreadCount || 0) + 1;
                }
            }
        }
        
        // Add connected devices that aren't in conversations yet
        try {
            const devicesResp = await fetch('/api/p2p/devices');
            const devicesData = await devicesResp.json();
            const devices = devicesData.devices || [];
            
            for (const device of devices) {
                const deviceId = device.id || device.device_id;
                if (deviceId !== _p2pDeviceId && !convMap[deviceId]) {
                    // Add as new conversation starter
                    convMap[deviceId] = {
                        device_id: deviceId,
                        name: device.name || 'Unknown Device',
                        last_message: 'Tap to start chatting',
                        timestamp: 0,
                        unreadCount: 0,
                        isNew: true
                    };
                }
            }
        } catch (e) {
            console.error('Failed to load devices for chat:', e);
        }
        
        _chatConversations = convMap;
        renderChatList();
        
        // Update badge — total unread messages
        const totalUnread = Object.values(convMap).reduce((sum, c) => sum + (c.unreadCount || 0), 0);
        const badge = document.getElementById('chatBadge');
        if (badge) {
            badge.textContent = totalUnread;
            badge.style.display = totalUnread > 0 ? 'flex' : 'none';
        }
    } catch (e) {
        console.error('Failed to load chat list:', e);
    }
}

function renderChatList() {
    const el = document.getElementById('chatConversations');
    const convs = Object.values(_chatConversations).sort((a, b) => {
        // Existing conversations (with messages) first
        if (a.isNew && !b.isNew) return 1;
        if (!a.isNew && b.isNew) return -1;
        // Then sort by timestamp
        return b.timestamp - a.timestamp;
    });
    
    if (convs.length === 0) {
        el.innerHTML = '<div class="chat-empty"><i class="fas fa-inbox"></i> No conversations yet<br><small>Connect a device to start</small></div>';
        return;
    }
    
    el.innerHTML = convs.map(c => {
        const avatar = (c.name || 'U').charAt(0).toUpperCase();
        const preview = c.isNew ? 'Start conversation' : (c.last_message || '').substring(0, 40);
        const ago = c.isNew ? '' : _timeAgo(c.timestamp);
        const hasUnread = c.unreadCount > 0;
        
        const unreadBadge = hasUnread ? `<span class="chat-conv-unread-count">${c.unreadCount}</span>` : '';
        const newTag = c.isNew ? ' <span style="font-size:0.65rem;color:#667EEA;font-weight:700;background:rgba(102,126,234,0.15);padding:1px 6px;border-radius:4px">NEW</span>' : '';
        const timeClass = hasUnread ? 'chat-conv-time has-unread' : 'chat-conv-time';
        
        return `
            <div class="chat-conversation-item" onclick="openChatConversation('${c.device_id}', '${escapeHtml(c.name)}')">
                <div class="chat-conv-avatar">${avatar}</div>
                <div class="chat-conv-body">
                    <div class="chat-conv-top-row">
                        <div class="chat-conv-name">${escapeHtml(c.name)} ${mobVBadge(c.device_id)}${newTag}</div>
                        ${ago ? `<span class="${timeClass}">${ago}</span>` : ''}
                    </div>
                    <div class="chat-conv-bottom-row">
                        <div class="chat-conv-preview">${preview}</div>
                        ${unreadBadge}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

async function openChatConversation(deviceId, deviceName) {
    closeSidebar();  // Close the hamburger menu
    _chatCurrentConversation = deviceId;
    document.getElementById('chatListPanel').style.display = 'none';
    document.getElementById('chatWindowPanel').style.display = 'flex';
    document.getElementById('chatWindowName').textContent = deviceName;
    
    // Check if delegation is active and show/hide badge
    _updateChatDelegationBadge();
    
    await loadChatMessages(deviceId);
    
    // Start polling for new messages (increased to 12 seconds to allow video playback)
    if (_chatPollTimer) clearInterval(_chatPollTimer);
    _chatPollTimer = setInterval(() => loadChatMessages(deviceId), 12000);
    
    // Start polling for typing indicator
    if (_typingPollTimer) clearInterval(_typingPollTimer);
    _typingPollTimer = setInterval(_pollTyping, 2000);
}

async function loadChatMessages(deviceId) {
    try {
        const r = await fetch(`/api/p2p/messages?device_id=${_p2pDeviceId}&with=${deviceId}`);
        const data = await r.json();
        const allMessages = data.messages || [];
        
        // On first load or if we have messages already
        if (_chatLastMessageId === null) {
            // First load - render all messages
            _chatMessages = allMessages;
            if (allMessages.length > 0) {
                _chatLastMessageId = allMessages[allMessages.length - 1].id;
            }
            renderChatMessages();
        } else if (allMessages.length > _chatMessages.length) {
            // New messages arrived - only append them
            const oldCount = _chatMessages.length;
            _chatMessages = allMessages;
            const newMessages = allMessages.slice(oldCount);
            appendChatMessages(newMessages);
            _chatLastMessageId = allMessages[allMessages.length - 1].id;
            // BEAM AI delegation: auto-reply to incoming text messages
            for (const nm of newMessages) {
                if (nm.sender_id !== _p2pDeviceId && nm.text && !nm.has_media) {
                    mobAiTryDelegateReply(nm.sender_id, nm.sender_name || 'Someone', nm.text);
                }
            }
        }
        
        // Mark unread messages as read
        for (const msg of allMessages) {
            if (!msg.read && msg.recipient_id === _p2pDeviceId) {
                fetch(`/api/p2p/messages/${msg.id}/read`, {method: 'POST'}).catch(e => console.error(e));
            }
        }
    } catch (e) {
        console.error('Failed to load messages:', e);
    }
}

// Voice note audio data store (msgId -> {b64, type, blobUrl, audio})
const _vnStore = {};

// Convert base64 audio to blob URL for playback
function b64toBlobUrl(b64Data, contentType) {
    try {
        const byteChars = atob(b64Data);
        const byteArrays = [];
        for (let i = 0; i < byteChars.length; i += 512) {
            const slice = byteChars.slice(i, i + 512);
            const bytes = new Uint8Array(slice.length);
            for (let j = 0; j < slice.length; j++) bytes[j] = slice.charCodeAt(j);
            byteArrays.push(bytes);
        }
        const blob = new Blob(byteArrays, contentType ? { type: contentType } : undefined);
        return URL.createObjectURL(blob);
    } catch (e) {
        console.error('b64toBlobUrl error:', e);
        return `data:${contentType};base64,${b64Data}`;
    }
}

// Build voice note player HTML for a message
function buildVoiceNoteHTML(msgId) {
    const barCount = 28;
    let barsHtml = '';
    for (let i = 0; i < barCount; i++) {
        const h = Math.floor(Math.random() * 18) + 4;
        barsHtml += `<div class="vn-viz-bar" data-h="${h}" style="height:${h}px;"></div>`;
    }
    return `<br><div class="voice-note-player" style="display:flex;align-items:center;gap:10px;margin-top:8px;padding:8px 12px;background:rgba(255,255,255,0.1);border-radius:20px;min-width:0;max-width:100%;">` +
        `<button onclick="toggleVoiceNote('${msgId}')" style="width:36px;height:36px;border-radius:50%;border:none;background:#667EEA;color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fas fa-play" id="vn-icon-${msgId}"></i></button>` +
        `<div class="vn-visualizer" id="vn-viz-${msgId}" onclick="seekVoiceNote(event,'${msgId}')">${barsHtml}</div>` +
        `<span id="vn-time-${msgId}" style="font-size:0.7rem;color:rgba(255,255,255,0.6);flex-shrink:0;min-width:35px;text-align:right;">0:00</span>` +
        `</div>`;
}

// Toggle voice note play/pause — creates audio on first tap (user gesture required on mobile)
function toggleVoiceNote(msgId) {
    const store = _vnStore[msgId];
    if (!store) { console.error('No voice data for', msgId); return; }
    
    const icon = document.getElementById('vn-icon-' + msgId);
    
    // Create Audio on first tap (inside user gesture handler — required for mobile)
    if (!store.audio) {
        console.log('Creating audio for voice note', msgId, 'type:', store.type);
        
        // Use URL endpoint instead of base64 blob
        const audioUrl = store.url || store.blobUrl;
        const audio = new Audio();
        audio.preload = 'auto';
        audio.src = audioUrl;
        store.audio = audio;
        
        audio.addEventListener('timeupdate', () => {
            const vizEl = document.getElementById('vn-viz-' + msgId);
            const timeEl = document.getElementById('vn-time-' + msgId);
            if (vizEl && audio.duration) {
                const bars = vizEl.querySelectorAll('.vn-viz-bar');
                const pct = audio.currentTime / audio.duration;
                const activeCount = Math.floor(pct * bars.length);
                bars.forEach((bar, i) => {
                    bar.classList.toggle('active', i < activeCount);
                });
            }
            if (timeEl) {
                const cur = formatAudioTime(audio.currentTime);
                const dur = audio.duration ? formatAudioTime(audio.duration) : '--:--';
                timeEl.textContent = cur + ' / ' + dur;
            }
        });
        
        audio.addEventListener('ended', () => {
            if (icon) icon.className = 'fas fa-play';
            const vizEl = document.getElementById('vn-viz-' + msgId);
            if (vizEl) {
                vizEl.querySelectorAll('.vn-viz-bar').forEach(b => b.classList.remove('active'));
            }
            const timeEl = document.getElementById('vn-time-' + msgId);
            if (timeEl) timeEl.textContent = formatAudioTime(audio.duration || 0);
        });
        
        audio.addEventListener('error', (e) => {
            console.error('Audio error for', msgId, audio.error);
            const timeEl = document.getElementById('vn-time-' + msgId);
            // If webm/ogg failed, ask server to convert to mp4 (iOS can't decode webm)
            if (!store.retried) {
                store.retried = true;
                console.log('Playback failed, requesting server-side conversion for', msgId);
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
                            const icon = document.getElementById('vn-icon-' + msgId);
                            if (icon) icon.className = 'fas fa-pause';
                        }).catch(err => {
                            console.error('Converted audio still failed:', err);
                            if (timeEl) timeEl.textContent = 'Cannot play';
                        });
                    })
                    .catch(err => {
                        console.error('Server conversion failed:', err);
                        if (timeEl) timeEl.textContent = 'Cannot play';
                    });
                return;
            }
            if (timeEl) timeEl.textContent = 'Cannot play';
        });
    }
    
    const audio = store.audio;
    if (audio.paused) {
        // Pause any other playing voice notes
        Object.keys(_vnStore).forEach(id => {
            if (id !== msgId && _vnStore[id].audio && !_vnStore[id].audio.paused) {
                _vnStore[id].audio.pause();
                const otherIcon = document.getElementById('vn-icon-' + id);
                if (otherIcon) otherIcon.className = 'fas fa-play';
            }
        });
        audio.play().then(() => {
            if (icon) icon.className = 'fas fa-pause';
        }).catch(err => {
            console.error('Play failed:', err);
            const timeEl = document.getElementById('vn-time-' + msgId);
            if (timeEl) timeEl.textContent = 'Play failed';
        });
    } else {
        audio.pause();
        if (icon) icon.className = 'fas fa-play';
    }
}

function seekVoiceNote(event, msgId) {
    const store = _vnStore[msgId];
    if (!store || !store.audio || !store.audio.duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || (event.touches && event.touches[0].clientX) || 0;
    const pct = (x - rect.left) / rect.width;
    store.audio.currentTime = Math.max(0, Math.min(pct, 1)) * store.audio.duration;
}

function formatAudioTime(secs) {
    if (!secs || isNaN(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return m + ':' + s.toString().padStart(2, '0');
}

/**
 * Groups consecutive image-only messages from the same sender into batches.
 * Non-image messages, or images from a different sender, break the streak.
 * Returns an array of { type: 'image-group', images: [...], sender_id, timestamp }
 * or { type: 'single', msg: {...} }
 */
function _groupConsecutiveImages(messages) {
    const result = [];
    let i = 0;
    while (i < messages.length) {
        const msg = messages[i];
        const mediaType = (msg.media_type || '');
        // Check if this message is an image-only message
        if (msg.has_media && msg.media_url && mediaType.startsWith('image/')) {
            // Collect consecutive images from the same sender
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
                // Single image, still use grouped rendering for consistency
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

function renderChatMessages() {
    const el = document.getElementById('chatMessages');
    if (_chatMessages.length === 0) {
        el.innerHTML = '<div class="chat-empty"><i class="fas fa-comment"></i> No messages yet</div>';
        return;
    }
    
    // Group consecutive image-only messages from the same sender
    const grouped = _groupConsecutiveImages(_chatMessages);
    
    el.innerHTML = grouped.map(entry => {
        if (entry.type === 'image-group') {
            const isOwn = entry.sender_id === _p2pDeviceId;
            const ownClass = isOwn ? 'own' : 'other';
            const time = new Date(entry.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
            const lastImg = entry.images[entry.images.length - 1];
            const lastIdx = _chatMessages.indexOf(lastImg);
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
                    return `<div class="img-overlay-wrap" onclick="openPhotoGallery(this.closest('.img-group'), ${idx})"><img src="${img.media_url}" loading="lazy"><div class="img-overlay-count">+${remaining}</div></div>`;
                }
                return `<img src="${img.media_url}" loading="lazy" onclick="openPhotoGallery(this.closest('.img-group'), ${idx})">`;
            }).join('');
            const ticks = isOwn ? `<span class="msg-ticks${entry.read ? ' read' : ''}"><i class="fas fa-check-double"></i></span>` : '';
            return `
                <div class="chat-message ${ownClass}" data-msg-idx="${lastIdx}">
                    <div>
                        <div class="chat-message-bubble img-bubble">
                            <div class="img-group ${colsClass}" data-gallery="${galleryAttr}">${imgs}</div>
                        </div>
                        <div class="chat-message-time">${time}${ticks}</div>
                    </div>
                </div>
            `;
        }
        
        // Normal single message
        const msg = entry.msg;
        const msgIdx = _chatMessages.indexOf(msg);
        const isOwn = msg.sender_id === _p2pDeviceId;
        const time = new Date(msg.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        const ownClass = isOwn ? 'own' : 'other';
        const replyHtml = buildReplyBlock(msg, isOwn);
        
        let hideText = false;
        let mediaHtml = '';
        if (msg.has_media && msg.media_url) {
            const mediaType = msg.media_type || '';
            if (mediaType.startsWith('image/')) {
                hideText = true;
                const singleGallery = encodeURIComponent(JSON.stringify([msg.media_url]));
                mediaHtml = `<div class="img-group cols-1" data-gallery="${singleGallery}"><img src="${msg.media_url}" loading="lazy" onclick="openPhotoGallery(this.closest('.img-group'), 0)"></div>`;
            } else if (mediaType.startsWith('video/')) {
                mediaHtml = `<video style="max-width:100%;max-height:250px;border-radius:8px;margin-top:4px;background:#000;" controls playsinline><source src="${msg.media_url}" type="${mediaType}"></video>`;
            } else if (mediaType.startsWith('audio/')) {
                const msgId = msg.id || Math.random().toString(36).substr(2, 9);
                _vnStore[msgId] = { url: msg.media_url, type: mediaType };
                mediaHtml = buildVoiceNoteHTML(msgId);
            } else {
                const fileName = msg.file_name || 'file';
                mediaHtml = `<a href="${msg.media_url}" download="${fileName}" style="color:#667EEA;text-decoration:underline;font-size:0.85rem;display:inline-block;margin-top:4px;">📥 Download ${fileName}</a>`;
            }
        }
        const textHtml = hideText ? '' : escapeHtml(msg.text);
        const bubbleClass = hideText ? 'chat-message-bubble img-bubble' : 'chat-message-bubble';
        const botBadge = msg.ai_delegated ? '<span class="ai-delegated-badge"><i class="fas fa-robot"></i> Beam AI</span>' : '';
        const content = `<div class="${bubbleClass}">${botBadge}${replyHtml}${textHtml}${mediaHtml}</div>`;
        const ticks = isOwn ? `<span class="msg-ticks${msg.read ? ' read' : ''}"><i class="fas fa-check-double"></i></span>` : '';
        
        return `
            <div class="chat-message ${ownClass}${msg.ai_delegated ? ' ai-delegated' : ''}" data-msg-idx="${msgIdx}">
                <div>
                    ${content}
                    <div class="chat-message-time">${time}${ticks}</div>
                </div>
            </div>
        `;
    }).join('');
    
    // Scroll to bottom
    setTimeout(() => {
        el.scrollTop = el.scrollHeight;
    }, 0);
    initChatSwipeToReply();
}

function appendChatMessages(newMessages) {
    const el = document.getElementById('chatMessages');
    
    // Group consecutive images in the new batch too
    const grouped = _groupConsecutiveImages(newMessages);
    
    const html = grouped.map(entry => {
        if (entry.type === 'image-group') {
            const isOwn = entry.sender_id === _p2pDeviceId;
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
                    return `<div class="img-overlay-wrap" onclick="openPhotoGallery(this.closest('.img-group'), ${idx})"><img src="${img.media_url}" loading="lazy"><div class="img-overlay-count">+${remaining}</div></div>`;
                }
                return `<img src="${img.media_url}" loading="lazy" onclick="openPhotoGallery(this.closest('.img-group'), ${idx})">`;
            }).join('');
            const ticks = isOwn ? `<span class="msg-ticks${entry.read ? ' read' : ''}"><i class="fas fa-check-double"></i></span>` : '';
            const lastImg = entry.images[entry.images.length - 1];
            const lastIdx = _chatMessages.indexOf(lastImg);
            return `
                <div class="chat-message ${ownClass}" data-msg-idx="${lastIdx}">
                    <div>
                        <div class="chat-message-bubble img-bubble">
                            <div class="img-group ${colsClass}" data-gallery="${galleryAttr}">${imgs}</div>
                        </div>
                        <div class="chat-message-time">${time}${ticks}</div>
                    </div>
                </div>
            `;
        }
        
        const msg = entry.msg;
        const msgIdx = _chatMessages.indexOf(msg);
        const isOwn = msg.sender_id === _p2pDeviceId;
        const time = new Date(msg.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        const ownClass = isOwn ? 'own' : 'other';
        const replyHtml = buildReplyBlock(msg, isOwn);
        
        let hideText = false;
        let mediaHtml = '';
        if (msg.has_media && msg.media_url) {
            const mediaType = msg.media_type || '';
            if (mediaType.startsWith('image/')) {
                hideText = true;
                const singleGallery = encodeURIComponent(JSON.stringify([msg.media_url]));
                mediaHtml = `<div class="img-group cols-1" data-gallery="${singleGallery}"><img src="${msg.media_url}" loading="lazy" onclick="openPhotoGallery(this.closest('.img-group'), 0)"></div>`;
            } else if (mediaType.startsWith('video/')) {
                mediaHtml = `<video style="max-width:100%;max-height:250px;border-radius:8px;margin-top:4px;background:#000;" controls playsinline><source src="${msg.media_url}" type="${mediaType}"></video>`;
            } else if (mediaType.startsWith('audio/')) {
                const msgId = msg.id || Math.random().toString(36).substr(2, 9);
                _vnStore[msgId] = { url: msg.media_url, type: mediaType };
                mediaHtml = buildVoiceNoteHTML(msgId);
            } else {
                const fileName = msg.file_name || 'file';
                mediaHtml = `<a href="${msg.media_url}" download="${fileName}" style="color:#667EEA;text-decoration:underline;font-size:0.85rem;display:inline-block;margin-top:4px;">📥 Download ${fileName}</a>`;
            }
        }
        const textHtml = hideText ? '' : escapeHtml(msg.text);
        const bubbleClass = hideText ? 'chat-message-bubble img-bubble' : 'chat-message-bubble';
        const botBadge = msg.ai_delegated ? '<span class="ai-delegated-badge"><i class="fas fa-robot"></i> Beam AI</span>' : '';
        const content = `<div class="${bubbleClass}">${botBadge}${replyHtml}${textHtml}${mediaHtml}</div>`;
        const ticks = isOwn ? `<span class="msg-ticks${msg.read ? ' read' : ''}"><i class="fas fa-check-double"></i></span>` : '';
        
        return `
            <div class="chat-message ${ownClass}${msg.ai_delegated ? ' ai-delegated' : ''}" data-msg-idx="${msgIdx}">
                <div>
                    ${content}
                    <div class="chat-message-time">${time}${ticks}</div>
                </div>
            </div>
        `;
    }).join('');
    
    // Append new messages to the end
    el.insertAdjacentHTML('beforeend', html);
    
    // Attach swipe-to-reply on new elements
    initChatSwipeToReply();
    
    // Scroll to bottom
    setTimeout(() => {
        el.scrollTop = el.scrollHeight;
    }, 0);
}

function openPhotoGallery(imgGroupEl, startIndex) {
    // Get all image URLs from the data-gallery attribute
    let images = [];
    try {
        images = JSON.parse(decodeURIComponent(imgGroupEl.dataset.gallery));
    } catch (e) {
        console.error('Failed to parse gallery data', e);
        return;
    }
    if (!images.length) return;
    
    let currentIndex = startIndex || 0;
    
    // Build overlay
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
    
    // Swipe support for mobile
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
    // Clean up on removal
    const observer = new MutationObserver(() => {
        if (!document.body.contains(overlay)) {
            document.removeEventListener('keydown', onKey);
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true });
}

function closeChatWindow() {
    if (_chatPollTimer) clearInterval(_chatPollTimer);
    if (_typingPollTimer) clearInterval(_typingPollTimer);
    _chatCurrentConversation = null;
    _chatLastMessageId = null;
    _chatMessages = [];
    document.getElementById('chatListPanel').style.display = 'flex';
    document.getElementById('chatWindowPanel').style.display = 'none';
    document.getElementById('chatMessages').innerHTML = '';
    const ti = document.getElementById('typingIndicator');
    if (ti) ti.classList.remove('active');
    loadChatList();  // Refresh list
}

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    
    if (!text || !_chatCurrentConversation) return;
    
    const payload = {
        sender_id: _p2pDeviceId,
        sender_name: _p2pName || 'Mobile Device',
        recipient_id: _chatCurrentConversation,
        text: text
    };
    if (_chatReplyTo) {
        payload.reply_to = _chatReplyTo.id;
    }
    
    try {
        const r = await fetch('/api/p2p/messages', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        
        if (r.ok) {
            input.value = '';
            input.style.height = 'auto';
            cancelChatReply();
            loadChatMessages(_chatCurrentConversation);
        }
    } catch (e) {
        console.error('Failed to send message:', e);
    }
}

// ── Reply helpers ────────────────────────────────────────────
function setChatReply(msg) {
    _chatReplyTo = { id: msg.id, sender_id: msg.sender_id, sender_name: msg.sender_name || 'Unknown', text: msg.text || '' };
    renderChatReplyPreview();
    const input = document.getElementById('chatInput');
    if (input) input.focus();
}

function cancelChatReply() {
    _chatReplyTo = null;
    const bar = document.getElementById('chatReplyPreview');
    if (bar) bar.remove();
}

function renderChatReplyPreview() {
    // Remove old preview
    const old = document.getElementById('chatReplyPreview');
    if (old) old.remove();
    if (!_chatReplyTo) return;
    
    const isMe = _chatReplyTo.sender_id === _p2pDeviceId;
    const name = isMe ? 'You' : _chatReplyTo.sender_name;
    const color = isMe ? '#667EEA' : '#22C55E';
    const preview = _chatReplyTo.text.length > 60 ? _chatReplyTo.text.slice(0, 60) + '...' : (_chatReplyTo.text || '📎 Media');
    
    const bar = document.createElement('div');
    bar.id = 'chatReplyPreview';
    bar.className = 'chat-reply-preview';
    bar.innerHTML = `
        <div class="reply-preview-bar" style="border-left: 3px solid ${color}; padding: 6px 10px; background: rgba(15,23,42,0.8); border-radius: 8px; display: flex; align-items: center; gap: 8px;">
            <div style="flex:1; min-width:0;">
                <div style="font-size:12px; font-weight:700; color:${color};">${escapeHtml(name)}</div>
                <div style="font-size:12px; color:rgba(255,255,255,0.45); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(preview)}</div>
            </div>
            <button onclick="cancelChatReply()" style="background:rgba(255,255,255,0.08); border:none; border-radius:50%; width:24px; height:24px; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                <i class="fas fa-times" style="color:#94A3B8; font-size:11px;"></i>
            </button>
        </div>
    `;
    
    const inputArea = document.querySelector('.chat-input-area');
    if (inputArea) inputArea.insertBefore(bar, inputArea.firstChild);
}

function buildReplyBlock(msg, isOwn) {
    if (!msg.reply_to) return '';
    const r = msg.reply_to;
    const isReplyToSelf = r.sender_id === _p2pDeviceId;
    // Use lighter colors when inside own bubble (gradient bg)
    const barColor = isReplyToSelf ? (isOwn ? '#B8C9FF' : '#667EEA') : (isOwn ? '#6EE7B7' : '#22C55E');
    const nameColor = isReplyToSelf ? (isOwn ? '#E0E7FF' : '#667EEA') : (isOwn ? '#6EE7B7' : '#22C55E');
    const name = isReplyToSelf ? 'You' : (r.sender_name || 'Unknown');
    const text = (r.text || '📎 Media').length > 80 ? (r.text || '').slice(0, 80) + '...' : (r.text || '📎 Media');
    const bgColor = isOwn ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.5)';
    const textColor = isOwn ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.4)';
    return `<div class="reply-block" style="display:flex; margin-bottom:6px; background:${bgColor}; border-radius:8px; overflow:hidden;">
        <div style="width:4px; background:${barColor}; flex-shrink:0; min-height:36px;"></div>
        <div style="padding:4px 8px; min-width:0; flex:1;">
            <div style="font-size:11px; font-weight:700; color:${nameColor};">${escapeHtml(name)}</div>
            <div style="font-size:12px; color:${textColor}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(text)}</div>
        </div>
    </div>`;
}

function initChatSwipeToReply() {
    const el = document.getElementById('chatMessages');
    if (!el || el._swipeBound) return;
    el._swipeBound = true;
    
    let startX = 0, startY = 0, swiping = false, swipeEl = null;
    
    // Touch events (mobile)
    el.addEventListener('touchstart', function(e) {
        const msgEl = e.target.closest('.chat-message');
        if (!msgEl) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        swiping = false;
        swipeEl = msgEl;
    }, { passive: true });
    
    el.addEventListener('touchmove', function(e) {
        if (!swipeEl) return;
        const dx = e.touches[0].clientX - startX;
        const dy = Math.abs(e.touches[0].clientY - startY);
        if (dy > 30) { swipeEl.style.transition = 'transform 0.2s ease'; swipeEl.style.transform = ''; swipeEl = null; return; }
        if (dx > 15) swiping = true;
        if (swiping) {
            const offset = Math.min(Math.max(dx, 0), 80);
            swipeEl.style.transform = `translateX(${offset}px)`;
            swipeEl.style.transition = 'none';
        }
    }, { passive: true });
    
    el.addEventListener('touchend', function(e) {
        if (!swipeEl) return;
        const dx = e.changedTouches[0].clientX - startX;
        swipeEl.style.transition = 'transform 0.2s ease';
        swipeEl.style.transform = '';
        if (swiping && dx > 50) {
            _triggerReplyFromEl(swipeEl);
        }
        swipeEl = null;
        swiping = false;
    }, { passive: true });
    
    // Mouse drag events (desktop browsers)
    let mouseDown = false, mouseSwipeEl = null, mouseStartX = 0, mouseStartY = 0, mouseSwiping = false;
    
    el.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return; // left click only
        const msgEl = e.target.closest('.chat-message');
        if (!msgEl) return;
        mouseDown = true;
        mouseSwipeEl = msgEl;
        mouseStartX = e.clientX;
        mouseStartY = e.clientY;
        mouseSwiping = false;
    });
    
    el.addEventListener('mousemove', function(e) {
        if (!mouseDown || !mouseSwipeEl) return;
        const dx = e.clientX - mouseStartX;
        const dy = Math.abs(e.clientY - mouseStartY);
        if (dy > 30) { mouseSwipeEl.style.transition = 'transform 0.2s ease'; mouseSwipeEl.style.transform = ''; mouseDown = false; mouseSwipeEl = null; return; }
        if (dx > 15) mouseSwiping = true;
        if (mouseSwiping) {
            const offset = Math.min(Math.max(dx, 0), 80);
            mouseSwipeEl.style.transform = `translateX(${offset}px)`;
            mouseSwipeEl.style.transition = 'none';
            e.preventDefault();
        }
    });
    
    document.addEventListener('mouseup', function(e) {
        if (!mouseDown || !mouseSwipeEl) { mouseDown = false; mouseSwipeEl = null; return; }
        const dx = e.clientX - mouseStartX;
        mouseSwipeEl.style.transition = 'transform 0.2s ease';
        mouseSwipeEl.style.transform = '';
        if (mouseSwiping && dx > 50) {
            _triggerReplyFromEl(mouseSwipeEl);
        }
        mouseDown = false;
        mouseSwipeEl = null;
        mouseSwiping = false;
    });
    
    // Double-click to reply (fallback)
    el.addEventListener('dblclick', function(e) {
        const msgEl = e.target.closest('.chat-message');
        if (msgEl) _triggerReplyFromEl(msgEl);
    });
}

function _triggerReplyFromEl(msgEl) {
    const msgIdx = msgEl.dataset.msgIdx;
    if (msgIdx !== undefined && msgIdx !== '-1' && _chatMessages[parseInt(msgIdx)]) {
        setChatReply(_chatMessages[parseInt(msgIdx)]);
    }
}

async function refreshChatList() {
    await loadChatList();
}

// Auto-load chat list when switching to chat view
function initChatView() {
    loadChatList();
    // Poll for new messages periodically (increased to 10 seconds for stability)
    setInterval(() => {
        if (_chatCurrentConversation === null) {
            loadChatList();
        }
    }, 10000);
}

function closeChatView() {
    // Stop all polling timers
    if (_chatPollTimer) clearInterval(_chatPollTimer);
    _chatCurrentConversation = null;
    
    // Hide chat panels
    const container = document.getElementById('chatContainer');
    if (container) {
        container.style.display = 'none';
    }
    
    // Show files tab instead
    const filesTab = document.querySelector('.btm-tab');
    switchView('files', filesTab);
}

// Sidebar menu functions
function openSidebar() {
    const menu = document.getElementById('sidebarMenu');
    if (menu) {
        menu.classList.add('open');
    }
}

function closeSidebar() {
    const menu = document.getElementById('sidebarMenu');
    if (menu) {
        menu.classList.remove('open');
    }
}

function openSidebarView(view) {
    const viewMap = {
        'share': 0,
        'chat': 1,
        'calls': 2,
        'groups': 3,
        'account': 4,
        'files': -1,
        'status': -2,
        'bots': -3,
        'subscription': -4
    };
    
    const tabIndex = viewMap[view];
    if (tabIndex !== undefined && tabIndex >= 0) {
        const tabs = document.querySelectorAll('.btm-tab');
        if (tabs[tabIndex]) {
            switchView(view, tabs[tabIndex]);
        }
    } else {
        // Views not in the bottom bar — switch directly
        switchView(view, null);
    }
    
    closeSidebar();
}

// Close sidebar when clicking outside
document.addEventListener('DOMContentLoaded', function() {
    const sidebar = document.getElementById('sidebarMenu');
    if (sidebar) {
        sidebar.addEventListener('click', function(e) {
            if (e.target === sidebar) {
                closeSidebar();
            }
        });
    }
}, {once: true});

// ═══════════════════════════════════════════════════════════
// VOICE RECORDING FUNCTIONALITY
// ═══════════════════════════════════════════════════════════

async function startVoiceRecord() {
    try {
        console.log('=== VOICE RECORD START ===');
        const isIOS = detectiOS();
        console.log('Device: iOS?', isIOS);
        console.log('User Agent:', navigator.userAgent);
        console.log('mediaDevices:', !!navigator.mediaDevices);
        console.log('getUserMedia:', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
        console.log('MediaRecorder:', !!window.MediaRecorder);
        
        // Step 1: Check if we have getUserMedia at all
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.error('getUserMedia not available');
            alert('Microphone API not available on this device');
            return;
        }
        
        console.log('Step 1: getUserMedia available ✓');
        
        // Step 2: Request microphone - THIS should trigger the permission prompt
        console.log('Requesting microphone access...');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('Step 2: Microphone permission granted ✓');
        console.log('Stream:', stream);
        console.log('Tracks:', stream.getTracks().length);
        
        // Step 3: Check if MediaRecorder exists
        if (!window.MediaRecorder) {
            console.error('MediaRecorder not available');
            stream.getTracks().forEach(track => track.stop());
            alert('MediaRecorder not supported on this device');
            return;
        }
        
        console.log('Step 3: MediaRecorder available ✓');
        
        // Step 4: Create MediaRecorder with best supported MIME type
        try {
            // Find the best supported audio format
            const preferredTypes = [
                'audio/mp4',           // iOS Safari, Chrome
                'audio/aac',           // iOS Safari fallback
                'audio/webm;codecs=opus', // Chrome/Firefox
                'audio/webm',          // Chrome/Firefox fallback
                'audio/ogg;codecs=opus', // Firefox
                'audio/ogg',           // Firefox fallback
            ];
            
            let bestMime = '';
            for (const type of preferredTypes) {
                if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
                    bestMime = type;
                    console.log('Found supported mime type:', type);
                    break;
                }
            }
            
            if (bestMime) {
                mediaRecorder = new MediaRecorder(stream, { mimeType: bestMime });
            } else {
                mediaRecorder = new MediaRecorder(stream);
            }
            
            // Get the actual MIME type being used
            recordingMimeType = mediaRecorder.mimeType || bestMime || 'audio/mp4';
            console.log('Step 4: MediaRecorder created ✓ with mime:', recordingMimeType);
        } catch (meErr) {
            console.error('Failed to create MediaRecorder with preferred type, trying default:', meErr);
            try {
                mediaRecorder = new MediaRecorder(stream);
                recordingMimeType = mediaRecorder.mimeType || 'audio/mp4';
                console.log('Step 4: MediaRecorder created with default mime:', recordingMimeType);
            } catch (meErr2) {
                console.error('Failed to create MediaRecorder:', meErr2);
                stream.getTracks().forEach(track => track.stop());
                alert('Failed to initialize recorder: ' + meErr2.message);
                return;
            }
        }
        
        // Step 5: Setup event handlers and start recording
        audioChunks = [];
        recordingStartTime = Date.now();
        
        mediaRecorder.ondataavailable = (event) => {
            console.log('Data available:', event.data.size, 'bytes');
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };
        
        mediaRecorder.onerror = (event) => {
            console.error('MediaRecorder error:', event.error);
            alert('Recording error: ' + event.error);
        };
        
        mediaRecorder.onstart = () => {
            console.log('Recording started');
        };
        
        mediaRecorder.onstop = () => {
            console.log('Recording stopped, total chunks:', audioChunks.length);
        };
        
        mediaRecorder.start();
        console.log('Step 5: Recording started ✓');
        
        // Step 6: Show UI and timer
        document.getElementById('voiceRecorderOverlay').style.display = 'flex';
        
        recordingTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
            const mins = Math.floor(elapsed / 60);
            const secs = elapsed % 60;
            document.getElementById('recordingTime').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        }, 1000);
        
        console.log('=== RECORDING ACTIVE ===');
        alert('Recording started! Tap Cancel or Send when done.');
        
    } catch (err) {
        console.error('=== VOICE RECORD ERROR ===');
        console.error('Error:', err);
        console.error('Error name:', err.name);
        console.error('Error message:', err.message);
        console.error('Error code:', err.code);
        console.error('Stack:', err.stack);
        
        let msg = '';
        
        if (err.name === 'NotAllowedError') {
            msg = '❌ Microphone permission denied.\n\nGo to Settings → Safari → Microphone and enable it.';
        } else if (err.name === 'PermissionDeniedError') {
            msg = '❌ You denied microphone permission.\n\nGo to Settings and allow microphone access.';
        } else if (err.name === 'NotFoundError') {
            msg = '❌ No microphone found on this device.';
        } else if (err.name === 'NotReadableError') {
            msg = '❌ Microphone is being used by another app.\n\nClose other apps and try again.';
        } else if (err.name === 'SecurityError') {
            msg = '❌ Security error. Try using Safari instead.';
        } else if (err.name === 'TypeError') {
            msg = '❌ Audio recording not supported.\n\nTry Safari or update your browser.';
        } else {
            msg = '❌ Error: ' + (err.message || 'Unknown error');
        }
        
        console.error('Showing alert:', msg);
        alert(msg);
    }
}

function cancelVoiceRecord() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    if (recordingTimer) clearInterval(recordingTimer);
    audioChunks = [];
    document.getElementById('voiceRecorderOverlay').style.display = 'none';
}

async function sendVoiceRecord() {
    if (recordingTimer) clearInterval(recordingTimer);
    
    // Capture duration NOW before any async processing
    const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
    
    // Set up onstop promise BEFORE calling stop() to avoid race condition
    const stopPromise = new Promise(resolve => {
        mediaRecorder.onstop = resolve;
    });
    
    // Now stop the recorder
    mediaRecorder.stop();
    
    // Wait for recording to complete and final data chunk
    await stopPromise;
    
    // NOW stop the stream tracks (after all data is captured)
    mediaRecorder.stream.getTracks().forEach(track => track.stop());
    
    // Create audio blob with the actual mime type used
    const audioBlob = new Blob(audioChunks, { type: recordingMimeType });
    
    // Convert to base64
    const reader = new FileReader();
    reader.onload = async () => {
        const base64Audio = reader.result.split(',')[1];
        
        // Send as special message with the actual mime type
        await fetch('/api/p2p/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: `🎙️ Voice message (${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')})`,
                sender_id: _p2pDeviceId,
                sender_name: _p2pName,
                recipient_id: _chatCurrentConversation,
                media_type: recordingMimeType,
                media_data: base64Audio
            })
        }).catch(e => console.error('Failed to send voice:', e));
        
        // Reset UI
        audioChunks = [];
        document.getElementById('voiceRecorderOverlay').style.display = 'none';
        document.getElementById('recordingTime').textContent = '0:00';
        
        // Refresh messages
        if (_chatCurrentConversation) {
            loadChatMessages(_chatCurrentConversation);
        }
    };
    reader.readAsDataURL(audioBlob);
}

// ═══════════════════════════════════════════════════════════
// FILE UPLOAD FUNCTIONALITY
// ═══════════════════════════════════════════════════════════

async function handleFileUpload(event) {
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
            await fetch('/api/p2p/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: `📎 ${file.name}`,
                    sender_id: _p2pDeviceId,
                    sender_name: _p2pName,
                    recipient_id: _chatCurrentConversation,
                    media_type: fileType,
                    media_data: base64Data,
                    file_name: file.name,
                    file_size: file.size
                })
            }).catch(e => console.error('Failed to send file:', e));
            
            // Refresh messages
            if (_chatCurrentConversation) {
                loadChatMessages(_chatCurrentConversation);
            }
        };
        reader.readAsDataURL(file);
    }
    
    // Reset file picker
    event.target.value = '';
}

// Call this when app starts
document.addEventListener('DOMContentLoaded', function() {
    setTimeout(initChatView, 1000);
}, {once: true});

// ═══════════════════════════════════════════════════════════════
// AUTH — Mobile Login, Register, Profile, Friends, Requests
// ═══════════════════════════════════════════════════════════════

const MOB_API = window.location.origin + '/api';

function _mobSaveAuth(token, user) {
    mobAuthToken = token;
    mobAuthUser = user;
    localStorage.setItem('lb_auth_token', token);
    localStorage.setItem('lb_auth_user', JSON.stringify(user));
}

function _mobClearAuth() {
    mobAuthToken = null;
    mobAuthUser = null;
    mobAuthFriends = [];
    mobFriendRequests = { incoming: [], outgoing: [] };
    localStorage.removeItem('lb_auth_token');
    localStorage.removeItem('lb_auth_user');
}

function _mobAuthHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (mobAuthToken) h['Authorization'] = 'Bearer ' + mobAuthToken;
    return h;
}

function _mobEsc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
}

function _mobShowMsg(id, msg, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.className = 'mob-auth-msg ' + type;
}

function mobShowToast(msg, type) {
    // reuse existing showNotification if defined
    if (typeof showNotification === 'function') { showNotification(msg, type); return; }
    alert(msg);
}

async function mobRestoreAuth() {
    if (!mobAuthToken) { mobUpdateAuthUI(); return; }
    try {
        const r = await fetch(MOB_API + '/auth/profile', { headers: _mobAuthHeaders() });
        if (r.ok) {
            const d = await r.json();
            mobAuthUser = d.user;
            mobAuthFriends = d.user.friends || [];
            localStorage.setItem('lb_auth_user', JSON.stringify(mobAuthUser));
            // Link device
            const devId = localStorage.getItem('p2p_device_id');
            if (devId) {
                fetch(MOB_API + '/auth/link-device', {
                    method: 'POST', headers: _mobAuthHeaders(),
                    body: JSON.stringify({ device_id: devId })
                });
            }
            await mobLoadFriendRequests();
        } else {
            _mobClearAuth();
        }
    } catch (e) {
        console.warn('Auth restore failed:', e);
    }
    mobUpdateAuthUI();
}

function mobUpdateAuthUI() {
    const forms = document.getElementById('mobAuthForms');
    const info = document.getElementById('mobAccountInfo');
    if (!forms || !info) return;

    if (mobAuthUser && mobAuthToken) {
        forms.style.display = 'none';
        info.style.display = 'block';
        document.getElementById('mobAccountName').innerHTML = _mobEsc(mobAuthUser.name || '—') + ' ' + mobVBadge(mobAuthUser.id);
        document.getElementById('mobAccountEmail').textContent = mobAuthUser.email || mobAuthUser.phone || '—';
        mobRenderFriendsList();
        mobRenderFriendRequests();
        // Update badge
        const badge = document.getElementById('friendReqBadge');
        const pendCount = (mobFriendRequests.incoming || []).length;
        if (badge) {
            badge.textContent = pendCount;
            badge.style.display = pendCount > 0 ? '' : 'none';
        }
    } else {
        forms.style.display = 'block';
        info.style.display = 'none';
        const badge = document.getElementById('friendReqBadge');
        if (badge) badge.style.display = 'none';
    }
}

function mobSwitchAuthTab(tab) {
    document.querySelectorAll('.mob-auth-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById('mobLoginForm').style.display = tab === 'login' ? 'block' : 'none';
    document.getElementById('mobRegForm').style.display = tab === 'register' ? 'block' : 'none';
    document.getElementById('mobLoginMsg').className = 'mob-auth-msg';
    document.getElementById('mobRegMsg').className = 'mob-auth-msg';
}

async function mobDoLogin() {
    const identifier = document.getElementById('mobLoginId').value.trim();
    const password = document.getElementById('mobLoginPw').value;
    if (!identifier || !password) { _mobShowMsg('mobLoginMsg', 'Fill in all fields', 'error'); return; }
    const btn = document.getElementById('mobLoginBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Logging in...';
    try {
        const r = await fetch(MOB_API + '/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, password })
        });
        const d = await r.json();
        if (r.ok && d.token) {
            _mobSaveAuth(d.token, d.user);
            mobShowToast('Welcome, ' + d.user.name + '!', 'success');
            const devId = localStorage.getItem('p2p_device_id');
            if (devId) {
                fetch(MOB_API + '/auth/link-device', {
                    method: 'POST', headers: _mobAuthHeaders(),
                    body: JSON.stringify({ device_id: devId })
                });
            }
            await mobRestoreAuth();
        } else {
            _mobShowMsg('mobLoginMsg', d.error || 'Login failed', 'error');
        }
    } catch (e) {
        _mobShowMsg('mobLoginMsg', 'Network error', 'error');
    }
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Login';
}

async function mobDoRegister() {
    const name = document.getElementById('mobRegName').value.trim();
    const email = document.getElementById('mobRegEmail').value.trim();
    const phone = document.getElementById('mobRegPhone').value.trim();
    const password = document.getElementById('mobRegPw').value;
    if (!name || (!email && !phone) || !password) {
        _mobShowMsg('mobRegMsg', 'Name, email/phone, and password required', 'error'); return;
    }
    if (password.length < 4) { _mobShowMsg('mobRegMsg', 'Password min 4 characters', 'error'); return; }
    const btn = document.getElementById('mobRegBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Registering...';
    try {
        const r = await fetch(MOB_API + '/auth/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, phone, password })
        });
        const d = await r.json();
        if (r.ok && d.success) {
            _mobShowMsg('mobRegMsg', d.message || 'Account created! Please log in.', 'success');
            setTimeout(() => {
                document.querySelectorAll('.mob-auth-tab').forEach(t => {
                    t.classList.toggle('active', t.textContent.toLowerCase() === 'login');
                });
                document.getElementById('mobLoginForm').style.display = 'block';
                document.getElementById('mobRegForm').style.display = 'none';
                document.getElementById('mobLoginId').value = email || phone;
            }, 1000);
        } else {
            _mobShowMsg('mobRegMsg', d.error || 'Registration failed', 'error');
        }
    } catch (e) {
        _mobShowMsg('mobRegMsg', 'Network error', 'error');
    }
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus"></i> Register';
}

function mobDoLogout() {
    _mobClearAuth();
    mobUpdateAuthUI();
    mobShowToast('Logged out', 'info');
}

// ── Friends ──────────────────────────────────────────────────

async function mobLoadFriendRequests() {
    if (!mobAuthToken) return;
    try {
        const r = await fetch(MOB_API + '/auth/friends/requests', { headers: _mobAuthHeaders() });
        if (r.ok) mobFriendRequests = await r.json();
    } catch (e) { console.warn('Failed to load friend requests:', e); }
}

function mobRenderFriendsList() {
    const el = document.getElementById('mobFriendsList');
    if (!el) return;
    if (!mobAuthFriends || mobAuthFriends.length === 0) {
        el.innerHTML = '<p class="mob-muted">No friends yet</p>';
        return;
    }
    el.innerHTML = mobAuthFriends.map(f => `
        <div class="mob-friend-item">
            <div class="mob-friend-avatar">${(f.name || '?')[0].toUpperCase()}</div>
            <div class="mob-friend-info">
                <div class="name">${_mobEsc(f.name)} ${mobVBadge(f.id) || mobVBadge(f.device_id)}</div>
                <div class="email">${_mobEsc(f.email || f.phone || '')}</div>
            </div>
            <div class="mob-friend-actions">
                <button class="mob-friend-btn remove" onclick="mobRemoveFriend('${f.id}')"><i class="fas fa-user-minus"></i></button>
            </div>
        </div>
    `).join('');
}

function mobRenderFriendRequests() {
    const incWrap = document.getElementById('mobIncomingWrap');
    const outWrap = document.getElementById('mobOutgoingWrap');
    const incList = document.getElementById('mobIncomingList');
    const outList = document.getElementById('mobOutgoingList');
    if (!incWrap) return;

    const inc = mobFriendRequests.incoming || [];
    const out = mobFriendRequests.outgoing || [];

    if (inc.length > 0) {
        incWrap.style.display = 'block';
        incList.innerHTML = inc.map(r => `
            <div class="mob-friend-item">
                <div class="mob-friend-avatar">${(r.from_name || '?')[0].toUpperCase()}</div>
                <div class="mob-friend-info">
                    <div class="name">${_mobEsc(r.from_name)}</div>
                    <div class="email">${_mobEsc(r.from_email || '')}</div>
                </div>
                <div class="mob-friend-actions">
                    <button class="mob-friend-btn accept" onclick="mobAcceptRequest('${r.id}')">Accept</button>
                    <button class="mob-friend-btn reject" onclick="mobRejectRequest('${r.id}')">Reject</button>
                </div>
            </div>
        `).join('');
    } else {
        incWrap.style.display = 'none';
    }

    if (out.length > 0) {
        outWrap.style.display = 'block';
        outList.innerHTML = out.map(r => `
            <div class="mob-friend-item">
                <div class="mob-friend-avatar">${(r.to_name || '?')[0].toUpperCase()}</div>
                <div class="mob-friend-info">
                    <div class="name">${_mobEsc(r.to_name)}</div>
                    <div class="email">${_mobEsc(r.to_email || '')}</div>
                </div>
                <div class="mob-friend-actions">
                    <button class="mob-friend-btn reject" onclick="mobRejectRequest('${r.id}')">Cancel</button>
                </div>
            </div>
        `).join('');
    } else {
        outWrap.style.display = 'none';
    }
}

async function mobDoAddFriend() {
    const input = document.getElementById('mobAddFriendInput');
    const identifier = input.value.trim();
    if (!identifier) { _mobShowMsg('mobAddFriendMsg', 'Enter email or phone', 'error'); return; }
    try {
        const r = await fetch(MOB_API + '/auth/friends/add', {
            method: 'POST', headers: _mobAuthHeaders(),
            body: JSON.stringify({ identifier })
        });
        const d = await r.json();
        if (r.ok && d.success) {
            _mobShowMsg('mobAddFriendMsg', d.message || 'Request sent!', 'success');
            input.value = '';
            await mobRestoreAuth();
        } else {
            _mobShowMsg('mobAddFriendMsg', d.error || 'Failed', 'error');
        }
    } catch (e) { _mobShowMsg('mobAddFriendMsg', 'Network error', 'error'); }
}

// ── Contact Synchronisation (Mobile) ─────────────────────────

function mobOpenContactSync() {
  document.getElementById('mobContactSyncPanel').style.display = 'block';
  document.getElementById('mobContactSyncTrigger').style.display = 'none';
  // Try Contact Picker API (Chrome Android)
  if ('contacts' in navigator && 'ContactsManager' in window) {
    _mobTryContactPicker();
  }
}
function mobCloseContactSync() {
  document.getElementById('mobContactSyncPanel').style.display = 'none';
  document.getElementById('mobContactSyncTrigger').style.display = '';
  document.getElementById('mobContactSyncResults').innerHTML = '';
}

async function _mobTryContactPicker() {
  try {
    const props = await navigator.contacts.getProperties();
    const supported = props.filter(p => ['email', 'tel', 'name'].includes(p));
    const contacts = await navigator.contacts.select(supported, { multiple: true });
    if (contacts && contacts.length) {
      const lines = [];
      contacts.forEach(c => {
        (c.tel || []).forEach(t => lines.push(t));
        (c.email || []).forEach(e => lines.push(e));
      });
      document.getElementById('mobContactSyncInput').value = lines.join('\n');
      mobDoContactSync();  // auto-search
    }
  } catch (e) {
    console.log('Contact Picker not available or denied:', e);
  }
}

async function mobDoContactSync() {
  const raw = document.getElementById('mobContactSyncInput').value.trim();
  if (!raw) { mobShowToast('Paste phone numbers or emails', 'warning'); return; }
  const lines = raw.split(/[\n,;]+/).map(l => l.trim()).filter(Boolean);
  const contacts = lines.map(l => {
    if (l.includes('@')) return { name: '', email: l, phone: '' };
    return { name: '', email: '', phone: l };
  });
  const btn = document.getElementById('mobContactSyncBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try {
    const r = await fetch(MOB_API + '/auth/contacts/sync', {
      method: 'POST', headers: _mobAuthHeaders(),
      body: JSON.stringify({ contacts })
    });
    const d = await r.json();
    if (!r.ok) { mobShowToast(d.error || 'Sync failed', 'error'); return; }
    mobRenderContactSyncResults(d);
  } catch (e) {
    mobShowToast('Network error', 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-search"></i> Find';
  }
}

function mobRenderContactSyncResults(data) {
  const el = document.getElementById('mobContactSyncResults');
  const matches = data.matches || [];
  if (matches.length === 0) {
    el.innerHTML = `<p class="mob-muted" style="font-size:12px">No matches found among ${data.total_contacts} contacts</p>`;
    return;
  }
  let html = `<p style="font-size:12px;margin:6px 0;color:var(--mob-accent,#4F46E5)">${matches.length} of ${data.total_contacts} contacts on LocalBeam</p>`;
  const addable = matches.filter(m => !m.already_friend && !m.pending);
  if (addable.length > 1) {
    html += `<button class="mob-btn mob-btn-primary" onclick="mobContactBulkAdd()" style="width:100%;margin-bottom:8px" id="mobBulkAddBtn">
      <i class="fas fa-users"></i> Add All (${addable.length})
    </button>`;
  }
  html += matches.map(m => {
    const contactLabel = m.contact_name ? `<span style="font-size:10px;color:var(--mob-muted-text,#999)"> (${_mobEsc(m.contact_name)})</span>` : '';
    let actionBtn = '';
    if (m.already_friend) {
      actionBtn = '<span style="color:var(--mob-accent,#4F46E5);font-size:11px"><i class="fas fa-check"></i> Friend</span>';
    } else if (m.pending) {
      actionBtn = '<span style="color:var(--mob-muted-text,#999);font-size:11px"><i class="fas fa-clock"></i> Pending</span>';
    } else {
      actionBtn = `<button class="mob-friend-btn accept mob-sync-add" data-uid="${m.user_id}" onclick="mobSyncAdd('${m.user_id}',this)"><i class="fas fa-user-plus"></i></button>`;
    }
    return `<div class="mob-friend-item mob-sync-match">
      <div class="mob-friend-avatar">${(m.name || '?')[0].toUpperCase()}</div>
      <div class="mob-friend-info">
        <div class="name">${_mobEsc(m.name)}${contactLabel}</div>
        <div class="email">${_mobEsc(m.email || m.phone || '')}</div>
      </div>
      <div class="mob-friend-actions">${actionBtn}</div>
    </div>`;
  }).join('');
  el.innerHTML = html;
}

async function mobSyncAdd(userId, btn) {
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try {
    const r = await fetch(MOB_API + '/auth/contacts/sync-bulk-add', {
      method: 'POST', headers: _mobAuthHeaders(),
      body: JSON.stringify({ user_ids: [userId] })
    });
    const d = await r.json();
    if (r.ok && d.success) {
      btn.outerHTML = '<span style="color:var(--mob-accent,#4F46E5);font-size:11px"><i class="fas fa-check"></i> Sent</span>';
      await mobRestoreAuth();
    } else {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus"></i>';
    }
  } catch (e) {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus"></i>';
  }
}

async function mobContactBulkAdd() {
  const btns = document.querySelectorAll('#mobContactSyncResults .mob-sync-add[data-uid]');
  const ids = Array.from(btns).map(b => b.dataset.uid);
  if (ids.length === 0) return;
  const bulkBtn = document.getElementById('mobBulkAddBtn');
  bulkBtn.disabled = true; bulkBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';
  try {
    const r = await fetch(MOB_API + '/auth/contacts/sync-bulk-add', {
      method: 'POST', headers: _mobAuthHeaders(),
      body: JSON.stringify({ user_ids: ids })
    });
    const d = await r.json();
    if (r.ok && d.success) {
      mobShowToast(`Sent ${d.results.length} friend requests!`, 'success');
      btns.forEach(b => { b.outerHTML = '<span style="color:var(--mob-accent,#4F46E5);font-size:11px"><i class="fas fa-check"></i> Sent</span>'; });
      bulkBtn.style.display = 'none';
      await mobRestoreAuth();
    }
  } catch (e) {
    mobShowToast('Network error', 'error');
  }
  bulkBtn.disabled = false; bulkBtn.innerHTML = `<i class="fas fa-users"></i> Add All (${ids.length})`;
}

async function mobAcceptRequest(reqId) {
    try {
        const r = await fetch(MOB_API + '/auth/friends/accept', {
            method: 'POST', headers: _mobAuthHeaders(),
            body: JSON.stringify({ request_id: reqId })
        });
        if (r.ok) {
            mobShowToast('Friend request accepted!', 'success');
            await mobRestoreAuth();
        }
    } catch (e) { mobShowToast('Network error', 'error'); }
}

async function mobRejectRequest(reqId) {
    try {
        const r = await fetch(MOB_API + '/auth/friends/reject', {
            method: 'POST', headers: _mobAuthHeaders(),
            body: JSON.stringify({ request_id: reqId })
        });
        if (r.ok) {
            mobShowToast('Request removed', 'info');
            await mobRestoreAuth();
        }
    } catch (e) { mobShowToast('Network error', 'error'); }
}

async function mobRemoveFriend(friendId) {
    if (!confirm('Remove this friend?')) return;
    try {
        const r = await fetch(MOB_API + '/auth/friends/remove', {
            method: 'POST', headers: _mobAuthHeaders(),
            body: JSON.stringify({ friend_id: friendId })
        });
        if (r.ok) {
            mobShowToast('Friend removed', 'info');
            await mobRestoreAuth();
        }
    } catch (e) { mobShowToast('Network error', 'error'); }
}

// Poll friend requests every 30 seconds
setInterval(async () => {
    if (mobAuthToken) {
        await mobLoadFriendRequests();
        const badge = document.getElementById('friendReqBadge');
        const cnt = (mobFriendRequests.incoming || []).length;
        if (badge) {
            badge.textContent = cnt;
            badge.style.display = cnt > 0 ? '' : 'none';
        }
    }
}, 30000);

// ═══════════════════════════════════════════════════════════════
// STATUS / STORIES SYSTEM
// ═══════════════════════════════════════════════════════════════

let _statusFeed = [];
let _statusPollTimer = null;
let _statusSelectedBg = '#667eea,#764ba2';
let _statusPendingImageData = null; // { base64, type }

function statusInit() {
    const authPrompt = document.getElementById('statusAuthPrompt');
    const content = document.getElementById('statusContent');
    const fab = document.getElementById('statusFab');
    if (!mobAuthToken) {
        authPrompt.style.display = '';
        content.style.display = 'none';
        fab.style.display = 'none';
        return;
    }
    authPrompt.style.display = 'none';
    content.style.display = '';
    fab.style.display = '';
    statusLoadFeed();
    // Start polling every 15s
    if (_statusPollTimer) clearInterval(_statusPollTimer);
    _statusPollTimer = setInterval(() => {
        const view = document.getElementById('view-status');
        if (view && view.classList.contains('active') && mobAuthToken) {
            statusLoadFeed();
        }
    }, 15000);
}

async function statusLoadFeed() {
    try {
        const r = await fetch(MOB_API + '/status/feed', { headers: _mobAuthHeaders() });
        if (!r.ok) return;
        const d = await r.json();
        _statusFeed = d.feed || [];
        statusRenderFeed();
    } catch (e) { console.error('[Status] feed error', e); }
}

function statusRenderFeed() {
    // Update my status row
    const myGroup = _statusFeed.find(g => g.is_mine);
    const myAvatar = document.getElementById('statusMyAvatar');
    const mySub = document.getElementById('statusMySub');
    if (myGroup && myGroup.statuses.length > 0) {
        const circle = myAvatar.querySelector('.status-avatar-circle');
        circle.className = 'status-avatar-circle status-has-story';
        mySub.textContent = myGroup.statuses.length + ' update' + (myGroup.statuses.length > 1 ? 's' : '') + ' · ' + _statusTimeAgo(myGroup.latest);
    } else {
        const circle = myAvatar.querySelector('.status-avatar-circle');
        circle.className = 'status-avatar-circle status-no-story';
        mySub.textContent = 'Tap to add status update';
    }

    // Render other users
    const otherGroups = _statusFeed.filter(g => !g.is_mine);
    const list = document.getElementById('statusFeedList');
    const label = document.getElementById('statusRecentLabel');
    const empty = document.getElementById('statusEmptyState');

    if (otherGroups.length === 0) {
        label.style.display = 'none';
        list.innerHTML = '';
        empty.style.display = (!myGroup || myGroup.statuses.length === 0) ? '' : 'none';
        return;
    }

    label.style.display = '';
    empty.style.display = 'none';

    list.innerHTML = otherGroups.map((g, gi) => {
        const viewedClass = g.all_viewed ? 'viewed' : 'unviewed';
        const count = g.statuses.length;
        const time = _statusTimeAgo(g.latest);
        // Find feed index (including mine) to pass to viewer
        const feedIdx = _statusFeed.indexOf(g);
        return `
            <div class="status-feed-item" onclick="statusOpenViewer(${feedIdx})">
                <div class="status-feed-avatar ${viewedClass}">
                    <i class="fas fa-user"></i>
                </div>
                <div class="status-feed-info">
                    <span class="status-feed-name">${_mobEsc(g.user_name)} ${mobVBadge(g.user_id || '')}</span>
                    <span class="status-feed-meta">${count} update${count > 1 ? 's' : ''} · ${time}</span>
                </div>
            </div>
        `;
    }).join('');
}

function _statusTimeAgo(ts) {
    const diff = Math.floor(Date.now() / 1000 - ts);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
}

// ── My Status Row Click ──
function statusMyRowClick() {
    if (!mobAuthToken) return;
    const myGroup = _statusFeed.find(g => g.is_mine);
    if (myGroup && myGroup.statuses.length > 0) {
        // View my own stories
        const feedIdx = _statusFeed.indexOf(myGroup);
        statusOpenViewer(feedIdx);
    } else {
        // No stories, open post sheet
        statusShowPostSheet();
    }
}

// ── Post Sheet ──
function statusShowPostSheet() {
    if (!mobAuthToken) return;
    document.getElementById('statusPostSheet').style.display = '';
}
function statusClosePostSheet() {
    document.getElementById('statusPostSheet').style.display = 'none';
}

function statusPickImage() {
    statusClosePostSheet();
    document.getElementById('statusFileInput').click();
}
function statusPickCamera() {
    statusClosePostSheet();
    document.getElementById('statusCameraInput').click();
}

function statusHandleFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { mobShowToast('File too large (max 50MB)', 'error'); return; }
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = function() {
        const base64 = reader.result.split(',')[1];
        _statusPendingImageData = { base64, type: file.type || 'image/jpeg' };
        const isVideo = file.type && file.type.startsWith('video');
        const imgEl = document.getElementById('statusCaptionImg');
        const vidEl = document.getElementById('statusCaptionVid');
        if (isVideo) {
            imgEl.style.display = 'none';
            if (vidEl) { vidEl.style.display = ''; vidEl.src = reader.result; }
        } else {
            if (vidEl) { vidEl.style.display = 'none'; vidEl.src = ''; }
            imgEl.style.display = '';
            imgEl.src = reader.result;
        }
        document.getElementById('statusCaptionText').value = '';
        document.getElementById('statusCaptionDialog').style.display = '';
    };
    reader.readAsDataURL(file);
}

function statusCloseCaptionDialog() {
    document.getElementById('statusCaptionDialog').style.display = 'none';
    _statusPendingImageData = null;
}

async function statusPostImage() {
    if (!_statusPendingImageData) return;
    const caption = document.getElementById('statusCaptionText').value.trim();
    const btn = document.querySelector('.status-cd-header button:last-child');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    try {
        const r = await fetch(MOB_API + '/status/post', {
            method: 'POST', headers: _mobAuthHeaders(),
            body: JSON.stringify({
                media_data: _statusPendingImageData.base64,
                media_type: _statusPendingImageData.type,
                caption: caption
            })
        });
        const d = await r.json();
        if (d.success) {
            mobShowToast('Status posted!', 'success');
            statusCloseCaptionDialog();
            statusLoadFeed();
        } else {
            mobShowToast(d.error || 'Failed', 'error');
        }
    } catch (e) { mobShowToast('Network error', 'error'); }
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Post';
}

// ── Text Editor ──
function statusOpenTextEditor() {
    statusClosePostSheet();
    _statusSelectedBg = '#667eea,#764ba2';
    document.querySelectorAll('.stc-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.stc-btn').classList.add('active');
    const preview = document.getElementById('statusTePreview');
    preview.style.background = 'linear-gradient(135deg, #667eea, #764ba2)';
    document.getElementById('statusTeInput').value = '';
    document.getElementById('statusTextEditor').style.display = '';
    setTimeout(() => document.getElementById('statusTeInput').focus(), 200);
}
function statusCloseTextEditor() {
    document.getElementById('statusTextEditor').style.display = 'none';
}

function statusPickBg(btn) {
    document.querySelectorAll('.stc-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _statusSelectedBg = btn.dataset.bg;
    const colors = _statusSelectedBg.split(',');
    document.getElementById('statusTePreview').style.background =
        `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`;
}

async function statusPostText() {
    const text = document.getElementById('statusTeInput').value.trim();
    if (!text) { mobShowToast('Type something', 'error'); return; }
    const btn = document.querySelector('.status-te-header button:last-child');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    try {
        const r = await fetch(MOB_API + '/status/post', {
            method: 'POST', headers: _mobAuthHeaders(),
            body: JSON.stringify({ caption: text, bg_color: _statusSelectedBg })
        });
        const d = await r.json();
        if (d.success) {
            mobShowToast('Status posted!', 'success');
            statusCloseTextEditor();
            statusLoadFeed();
        } else {
            mobShowToast(d.error || 'Failed', 'error');
        }
    } catch (e) { mobShowToast('Network error', 'error'); }
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Post';
}

// ═══════════════════════════════════════════════════════════════
// STORY VIEWER — 3D Cube Transitions
// ═══════════════════════════════════════════════════════════════

let _storyCurrentUserIdx = 0;
let _storyCurrentStoryIdx = 0;
let _storyTimer = null;
let _storyTimerStart = 0;
let _storyPaused = false;
let _storyLongPressTimer = null;
const STORY_DURATION = 6000; // 6 seconds per story

function statusOpenViewer(feedIdx) {
    _storyCurrentUserIdx = feedIdx;
    _storyCurrentStoryIdx = 0;
    _storyPaused = false;
    document.getElementById('storyViewer').style.display = '';
    document.body.style.overflow = 'hidden';
    _storyRenderCurrentUser();
    _storyInitSwipe();
}

function statusCloseViewer() {
    document.getElementById('storyViewer').style.display = 'none';
    document.body.style.overflow = '';
    _storyStopTimer();
    _storyPaused = false;
}

function _storyRenderCurrentUser() {
    if (_storyCurrentUserIdx < 0 || _storyCurrentUserIdx >= _statusFeed.length) {
        statusCloseViewer();
        return;
    }
    const group = _statusFeed[_storyCurrentUserIdx];
    const statuses = group.statuses;
    if (!statuses || statuses.length === 0) {
        statusCloseViewer();
        return;
    }
    if (_storyCurrentStoryIdx >= statuses.length) _storyCurrentStoryIdx = 0;

    const container = document.getElementById('storyViewerContainer');
    container.innerHTML = _storyBuildPage(group, _storyCurrentStoryIdx);

    // Mark viewed
    const st = statuses[_storyCurrentStoryIdx];
    if (st && !st.viewed && !group.is_mine) {
        fetch(MOB_API + '/status/view', {
            method: 'POST', headers: _mobAuthHeaders(),
            body: JSON.stringify({ status_id: st.id })
        }).catch(() => {});
        st.viewed = true;
    }

    _storyStartTimer();
    _storyBindTaps();
}

function _storyBuildPage(group, storyIdx) {
    const statuses = group.statuses;
    const st = statuses[storyIdx];

    // Progress bars
    let progressHtml = '<div class="story-progress-bar">';
    statuses.forEach((s, i) => {
        let cls = '';
        if (i < storyIdx) cls = 'done';
        else if (i === storyIdx) cls = 'active';
        progressHtml += `<div class="story-progress-seg ${cls}"><div class="story-progress-fill" ${i === storyIdx ? 'id="storyActiveProgress"' : ''}></div></div>`;
    });
    progressHtml += '</div>';

    // Header
    const time = _statusTimeAgo(st.created);
    let headerExtra = '';
    if (group.is_mine) {
        headerExtra = `<div class="story-header-views"><i class="fas fa-eye"></i> ${st.view_count || 0}</div>`;
    }
    const headerHtml = `
        <div class="story-header">
            <div class="story-header-avatar"><i class="fas fa-user"></i></div>
            <div class="story-header-info">
                <div class="story-header-name">${_mobEsc(group.is_mine ? 'My Status' : group.user_name)}</div>
                <div class="story-header-time">${time}</div>
            </div>
            ${headerExtra}
            <button class="story-header-close" onclick="statusCloseViewer()"><i class="fas fa-times"></i></button>
        </div>
    `;

    // Content
    let contentHtml = '';
    const _isVid = st.media_type && st.media_type.startsWith('video');
    if (_isVid) {
        const mediaUrl = MOB_API + '/status/media/' + st.id;
        let captionBlock = '';
        if (st.caption) {
            captionBlock = `<div class="story-caption"><span>${_mobEsc(st.caption)}</span></div>`;
        }
        contentHtml = `
            <div class="story-content">
                <video id="storyVideo" src="${mediaUrl}" autoplay playsinline webkit-playsinline
                       onloadedmetadata="_storyVideoReady(this)"
                       onended="_storyNext()" onerror="this.style.display='none'"></video>
                ${captionBlock}
            </div>
        `;
    } else if (st.has_media || (st.media_type && st.media_type.startsWith('image'))) {
        const mediaUrl = MOB_API + '/status/media/' + st.id;
        let captionBlock = '';
        if (st.caption) {
            captionBlock = `<div class="story-caption"><span>${_mobEsc(st.caption)}</span></div>`;
        }
        contentHtml = `
            <div class="story-content">
                <img src="${mediaUrl}" alt="Status" onerror="this.style.display='none'">
                ${captionBlock}
            </div>
        `;
    } else {
        // Text status
        const bgColors = (st.bg_color || '#667eea,#764ba2').split(',');
        const bgGrad = `linear-gradient(135deg, ${bgColors[0]}, ${bgColors[1] || bgColors[0]})`;
        contentHtml = `
            <div class="story-content" style="background: ${bgGrad}">
                <div class="story-text-content">
                    <span>${_mobEsc(st.caption || '')}</span>
                </div>
            </div>
        `;
    }

    // Footer — reply, love, share (only on others' statuses)
    const footerHtml = group.is_mine ? '' : `
        <div class="story-footer">
            <button class="story-react-btn story-love-btn" onclick="storyToggleLove(this,'${st.id}')">
                <i class="far fa-heart"></i>
            </button>
            <div class="story-reply-wrap">
                <textarea class="story-reply-input" placeholder="Reply..." rows="1"
                    onfocus="_storyPause()" onblur="_storyResume()"
                    onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();storySendReply(this,'${group.user_id}')}"></textarea>
            </div>
            <button class="story-react-btn story-share-btn" onclick="storyShareStatus('${st.id}')">
                <i class="fas fa-share"></i>
            </button>
        </div>
    `;

    // Delete button for own statuses
    let deleteHtml = '';
    if (group.is_mine) {
        deleteHtml = `<button class="story-delete-btn" onclick="statusDeleteStory('${st.id}')"><i class="fas fa-trash-alt"></i> Delete</button>`;
    }

    // Tap zones
    const tapHtml = `
        <div class="story-tap-left" onclick="_storyTapLeft(event)"></div>
        <div class="story-tap-right" onclick="_storyTapRight(event)"></div>
    `;

    // Dim overlay for transitions
    const dimHtml = '<div class="story-dim-overlay" id="storyDimOverlay"></div>';

    return `
        <div class="story-page" id="storyPage">
            ${progressHtml}
            ${headerHtml}
            ${contentHtml}
            ${footerHtml}
            ${deleteHtml}
            ${tapHtml}
            ${dimHtml}
        </div>
    `;
}

// ── Timer ──
function _storyStartTimer() {
    _storyStopTimer();
    if (_storyPaused) return;
    // For video stories, timer is managed by _storyVideoReady
    if (document.getElementById('storyVideo')) return;
    _storyTimerStart = Date.now();
    const progressEl = document.getElementById('storyActiveProgress');
    if (progressEl) progressEl.style.width = '0%';

    _storyTimer = setInterval(() => {
        if (_storyPaused) return;
        const elapsed = Date.now() - _storyTimerStart;
        const pct = Math.min((elapsed / STORY_DURATION) * 100, 100);
        if (progressEl) progressEl.style.width = pct + '%';
        if (elapsed >= STORY_DURATION) {
            _storyStopTimer();
            _storyNext();
        }
    }, 50);
}

function _storyStopTimer() {
    if (_storyTimer) { clearInterval(_storyTimer); _storyTimer = null; }
}

function _storyPause() {
    _storyPaused = true;
    // Pause video if playing
    const vid = document.getElementById('storyVideo');
    if (vid) vid.pause();
    // Show pause indicator
    const page = document.getElementById('storyPage');
    if (page && !page.querySelector('.story-pause-indicator')) {
        const ind = document.createElement('div');
        ind.className = 'story-pause-indicator';
        ind.innerHTML = '<i class="fas fa-pause"></i>';
        page.appendChild(ind);
    }
}

function _storyResume() {
    _storyPaused = false;
    // Resume video if any
    const vid = document.getElementById('storyVideo');
    if (vid) vid.play().catch(() => {});
    // Adjust timer start to account for pause
    const progressEl = document.getElementById('storyActiveProgress');
    if (progressEl) {
        const currentPct = parseFloat(progressEl.style.width) || 0;
        const elapsed = (currentPct / 100) * STORY_DURATION;
        _storyTimerStart = Date.now() - elapsed;
    }
    // Remove pause indicator
    const ind = document.querySelector('.story-pause-indicator');
    if (ind) ind.remove();
}

// ── Navigation (all slides use 3D cube effect) ──
function _storyNext() {
    const group = _statusFeed[_storyCurrentUserIdx];
    if (!group) { statusCloseViewer(); return; }
    if (_storyCurrentStoryIdx < group.statuses.length - 1) {
        _storyAnimateSlide('left', _storyCurrentUserIdx, _storyCurrentStoryIdx + 1);
    } else {
        if (_storyCurrentUserIdx + 1 >= _statusFeed.length) { statusCloseViewer(); return; }
        _storyAnimateSlide('left', _storyCurrentUserIdx + 1, 0);
    }
}

function _storyPrev() {
    if (_storyCurrentStoryIdx > 0) {
        _storyAnimateSlide('right', _storyCurrentUserIdx, _storyCurrentStoryIdx - 1);
    } else if (_storyCurrentUserIdx > 0) {
        const prevGroup = _statusFeed[_storyCurrentUserIdx - 1];
        const lastIdx = prevGroup ? prevGroup.statuses.length - 1 : 0;
        _storyAnimateSlide('right', _storyCurrentUserIdx - 1, lastIdx);
    }
}

function _storyMoveToUser(newIdx) {
    if (newIdx < 0 || newIdx >= _statusFeed.length) {
        statusCloseViewer();
        return;
    }
    _storyAnimateSlide(newIdx > _storyCurrentUserIdx ? 'left' : 'right', newIdx, 0);
}

// ── Tap Handlers ──
function _storyTapLeft(e) {
    e.stopPropagation();
    _storyPrev();
}
function _storyTapRight(e) {
    e.stopPropagation();
    _storyNext();
}

// ── Long Press (pause) ──
function _storyBindTaps() {
    const page = document.getElementById('storyPage');
    if (!page) return;

    // Long-press to pause
    let lpTimeout = null;
    let didLongPress = false;

    page.addEventListener('touchstart', function(e) {
        didLongPress = false;
        lpTimeout = setTimeout(() => {
            didLongPress = true;
            _storyPause();
        }, 400);
    }, { passive: true });

    page.addEventListener('touchend', function(e) {
        clearTimeout(lpTimeout);
        if (didLongPress) {
            _storyResume();
            didLongPress = false;
        }
    }, { passive: true });

    page.addEventListener('touchmove', function(e) {
        clearTimeout(lpTimeout);
    }, { passive: true });

    // Mouse long-press for desktop browsers
    page.addEventListener('mousedown', function(e) {
        if (e.target.closest('.story-header-close') || e.target.closest('.story-delete-btn')) return;
        didLongPress = false;
        lpTimeout = setTimeout(() => {
            didLongPress = true;
            _storyPause();
        }, 400);
    });
    page.addEventListener('mouseup', function(e) {
        clearTimeout(lpTimeout);
        if (didLongPress) {
            _storyResume();
            didLongPress = false;
        }
    });
}

// ── 3D Cube Slide Transition (all story navigations) ──
function _storyAnimateSlide(direction, newUserIdx, newStoryIdx) {
    const container = document.getElementById('storyViewerContainer');
    const currentPage = document.getElementById('storyPage');
    if (!currentPage) {
        _storyCurrentUserIdx = newUserIdx;
        _storyCurrentStoryIdx = newStoryIdx;
        _storyRenderCurrentUser();
        return;
    }

    _storyStopTimer();
    // Stop any playing video
    const curVid = currentPage.querySelector('video');
    if (curVid) curVid.pause();

    const newGroup = _statusFeed[newUserIdx];
    if (!newGroup || !newGroup.statuses.length) { statusCloseViewer(); return; }
    if (newStoryIdx >= newGroup.statuses.length) newStoryIdx = 0;

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = _storyBuildPage(newGroup, newStoryIdx);
    const newPage = tempDiv.firstElementChild;
    newPage.id = 'storyPageNew';

    // Position new page off-screen with cube rotation
    if (direction === 'left') {
        newPage.style.transformOrigin = 'left center';
        newPage.style.transform = 'perspective(1200px) rotateY(90deg)';
        currentPage.style.transformOrigin = 'right center';
    } else {
        newPage.style.transformOrigin = 'right center';
        newPage.style.transform = 'perspective(1200px) rotateY(-90deg)';
        currentPage.style.transformOrigin = 'left center';
    }

    container.appendChild(newPage);

    // Animate cube rotation
    requestAnimationFrame(() => {
        currentPage.style.transition = 'transform 0.45s cubic-bezier(.4,.0,.2,1)';
        newPage.style.transition = 'transform 0.45s cubic-bezier(.4,.0,.2,1)';

        if (direction === 'left') {
            currentPage.style.transform = 'perspective(1200px) rotateY(-90deg)';
        } else {
            currentPage.style.transform = 'perspective(1200px) rotateY(90deg)';
        }
        newPage.style.transform = 'perspective(1200px) rotateY(0deg)';

        setTimeout(() => {
            currentPage.remove();
            newPage.id = 'storyPage';
            newPage.style.transition = '';
            newPage.style.transform = '';
            newPage.style.transformOrigin = '';

            _storyCurrentUserIdx = newUserIdx;
            _storyCurrentStoryIdx = newStoryIdx;

            // Mark viewed
            const st = newGroup.statuses[newStoryIdx];
            if (st && !st.viewed && !newGroup.is_mine) {
                fetch(MOB_API + '/status/view', {
                    method: 'POST', headers: _mobAuthHeaders(),
                    body: JSON.stringify({ status_id: st.id })
                }).catch(() => {});
                st.viewed = true;
            }

            _storyStartTimer();
            _storyBindTaps();
        }, 460);
    });
}

// ── Video duration handler ──
function _storyVideoReady(videoEl) {
    if (!videoEl || !videoEl.duration || isNaN(videoEl.duration)) return;
    _storyStopTimer();
    const dur = Math.min(videoEl.duration * 1000, 30000); // cap 30s
    _storyTimerStart = Date.now();
    const progressEl = document.getElementById('storyActiveProgress');
    if (progressEl) progressEl.style.width = '0%';
    _storyTimer = setInterval(() => {
        if (_storyPaused) return;
        const elapsed = Date.now() - _storyTimerStart;
        const pct = Math.min((elapsed / dur) * 100, 100);
        if (progressEl) progressEl.style.width = pct + '%';
        if (elapsed >= dur) { _storyStopTimer(); _storyNext(); }
    }, 50);
}

// ── Love reaction ──
function storyToggleLove(btn, statusId) {
    const icon = btn.querySelector('i');
    if (icon.classList.contains('far')) {
        icon.classList.replace('far', 'fas');
        icon.style.color = '#EF4444';
        btn.classList.add('loved');
        // Show floating heart animation
        const page = document.getElementById('storyPage');
        if (page) {
            const heart = document.createElement('div');
            heart.className = 'story-love-anim';
            heart.innerHTML = '<i class="fas fa-heart"></i>';
            page.appendChild(heart);
            setTimeout(() => heart.remove(), 1000);
        }
    } else {
        icon.classList.replace('fas', 'far');
        icon.style.color = '';
        btn.classList.remove('loved');
    }
}

// ── Share status ──
function storyShareStatus(statusId) {
    const url = MOB_API + '/status/media/' + statusId;
    if (navigator.share) {
        navigator.share({ title: 'Check this status', url: url }).catch(() => {});
    } else {
        navigator.clipboard.writeText(url).then(() => mobShowToast('Link copied!', 'success')).catch(() => {});
    }
}

// ── Reply to status ──
function storySendReply(textarea, userId) {
    const text = textarea.value.trim();
    if (!text) return;
    fetch(MOB_API + '/messages/send', {
        method: 'POST', headers: _mobAuthHeaders(),
        body: JSON.stringify({ to: userId, text: '\uD83D\uDCF7 Status reply: ' + text })
    }).then(r => r.json()).then(d => {
        if (d.success) { mobShowToast('Reply sent!', 'success'); textarea.value = ''; }
        else mobShowToast(d.error || 'Failed', 'error');
    }).catch(() => mobShowToast('Network error', 'error'));
    textarea.blur();
    _storyResume();
}

// ── Swipe between users ──
function _storyInitSwipe() {
    const viewer = document.getElementById('storyViewer');
    if (viewer._swipeBound) return;
    viewer._swipeBound = true;

    let startX = 0, startY = 0, swiping = false;

    viewer.addEventListener('touchstart', function(e) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        swiping = false;
    }, { passive: true });

    viewer.addEventListener('touchmove', function(e) {
        const dx = e.touches[0].clientX - startX;
        const dy = Math.abs(e.touches[0].clientY - startY);
        if (dy > 40) return;
        if (Math.abs(dx) > 40) swiping = true;
    }, { passive: true });

    viewer.addEventListener('touchend', function(e) {
        if (!swiping) return;
        const dx = e.changedTouches[0].clientX - startX;
        if (dx < -60) {
            // Swipe left → next user
            _storyMoveToUser(_storyCurrentUserIdx + 1);
        } else if (dx > 60) {
            // Swipe right → previous user
            _storyMoveToUser(_storyCurrentUserIdx - 1);
        }
        swiping = false;
    }, { passive: true });
}

// ── Delete ──
async function statusDeleteStory(statusId) {
    if (!confirm('Delete this status?')) return;
    try {
        const r = await fetch(MOB_API + '/status/delete', {
            method: 'POST', headers: _mobAuthHeaders(),
            body: JSON.stringify({ status_id: statusId })
        });
        const d = await r.json();
        if (d.success) {
            mobShowToast('Deleted', 'success');
            // Remove from local feed
            const group = _statusFeed[_storyCurrentUserIdx];
            if (group) {
                group.statuses = group.statuses.filter(s => s.id !== statusId);
                if (group.statuses.length === 0) {
                    statusCloseViewer();
                } else {
                    if (_storyCurrentStoryIdx >= group.statuses.length) {
                        _storyCurrentStoryIdx = group.statuses.length - 1;
                    }
                    _storyRenderCurrentUser();
                }
            }
            statusLoadFeed(); // Refresh full feed
        } else {
            mobShowToast(d.error || 'Failed', 'error');
        }
    } catch (e) { mobShowToast('Network error', 'error'); }
}


// ═══════════════════════════════════════════════════════════════
// CALLS — WebRTC Peer-to-Peer — Mobile Browser
// ═══════════════════════════════════════════════════════════════

// Dynamic audio element for reliable remote call audio on mobile
function _mobEnsureRemoteAudio(stream) {
    let el = document.getElementById('_mobDynRemoteAudio');
    if (!el) {
        el = document.createElement('audio');
        el.id = '_mobDynRemoteAudio';
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
        console.warn('[Call] Audio autoplay blocked, will retry:', e);
        const resume = () => { el.play().catch(() => {}); };
        document.addEventListener('touchstart', resume, { once: true });
        document.addEventListener('click', resume, { once: true });
    });
    console.log('[Call] Dynamic remote audio element ready');
}
function _mobCleanupDynAudio() {
    const el = document.getElementById('_mobDynRemoteAudio');
    if (el) { el.srcObject = null; el.remove(); }
}

const _mobRtcConfig = {
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

let _mobCurrentCallId = null;
let _mobPeerConnection = null;
let _mobLocalStream = null;
let _mobCallTimer = null;
let _mobCallSecs = 0;
let _mobIncomingCall = null;
let _mobCallPollTimer = null;
let _mobSignalPollTimer = null;
let _mobCallTargetId = null;
let _mobIceTimeout = null;
let _mobPendingIceCandidates = [];  // buffer ICE candidates until remote desc is set
let _mobRemoteDescSet = false;

function _mobForceAudioPlay() {
    ['mobRemoteAudio', 'mobChatRemoteAudio', '_mobDynRemoteAudio'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.srcObject) {
            el.muted = false;
            el.volume = 1.0;
            el.play().catch(() => {});
        }
    });
}

// ── Video relay fallback (when WebRTC peer-to-peer fails) ──
let _mobRelayMode = false;
let _mobRelaySendTimer = null;
let _mobRelayRecvTimer = null;
let _mobRelayCanvas = null;
let _mobRelayCallId = null;
let _mobRelayRemoteId = null;
// Audio relay (raw PCM via Web Audio API)
let _mobAudioCtx = null;
let _mobAudioSource = null;
let _mobAudioProcessor = null;
let _mobAudioSendTimer = null;
let _mobAudioRecvTimer = null;
let _mobAudioLastSeq = -1;
let _mobAudioPcmBuffer = [];
let _mobAudioPlayCtx = null;
let _mobAudioNextPlayTime = 0;

function _mobStartVideoRelay(callId, myDeviceId, remoteDeviceId) {
    if (_mobRelayMode) return;
    _mobRelayMode = true;
    _mobRelayCallId = callId;
    _mobRelayRemoteId = remoteDeviceId;
    console.log('[VideoRelay] Starting server-side video relay as fallback');

    _mobRelayCanvas = document.createElement('canvas');
    _mobRelayCanvas.width = 320;
    _mobRelayCanvas.height = 240;
    const ctx = _mobRelayCanvas.getContext('2d');

    const localVid = document.getElementById(_mobCallFromChat ? 'mobChatLocalVideo' : 'mobLocalVideo');
    _mobRelaySendTimer = setInterval(async () => {
        if (!localVid || !localVid.srcObject || !_mobRelayMode) return;
        try {
            ctx.drawImage(localVid, 0, 0, 320, 240);
            const blob = await new Promise(r => _mobRelayCanvas.toBlob(r, 'image/jpeg', 0.5));
            if (!blob) return;
            const fd = new FormData();
            fd.append('call_id', callId);
            fd.append('device_id', myDeviceId);
            fd.append('frame', blob, 'f.jpg');
            fetch('/api/calls/video-frame', { method: 'POST', body: fd }).catch(() => {});
        } catch(e) {}
    }, 150);

    const remoteVid = document.getElementById(_mobCallFromChat ? 'mobChatRemoteVideo' : 'mobRemoteVideo');
    let relayImg = document.getElementById('_mobRelayImg');
    if (!relayImg && remoteVid) {
        relayImg = document.createElement('img');
        relayImg.id = '_mobRelayImg';
        relayImg.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;top:0;left:0;z-index:1;';
        remoteVid.parentElement.style.position = 'relative';
        remoteVid.parentElement.appendChild(relayImg);
    }
    _mobRelayRecvTimer = setInterval(async () => {
        if (!_mobRelayMode) return;
        try {
            const res = await fetch('/api/calls/video-frame/' + callId + '/' + remoteDeviceId + '?_=' + Date.now());
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
    _mobStartAudioRelay(callId, myDeviceId, remoteDeviceId);
}

function _mobStopVideoRelay() {
    _mobRelayMode = false;
    if (_mobRelaySendTimer) { clearInterval(_mobRelaySendTimer); _mobRelaySendTimer = null; }
    if (_mobRelayRecvTimer) { clearInterval(_mobRelayRecvTimer); _mobRelayRecvTimer = null; }
    const relayImg = document.getElementById('_mobRelayImg');
    if (relayImg) { relayImg.remove(); }
    _mobStopAudioRelay();
    if (_mobRelayCallId) {
        fetch('/api/calls/video-relay-stop', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ call_id: _mobRelayCallId })
        }).catch(() => {});
    }
    _mobRelayCallId = null;
    _mobRelayRemoteId = null;
}

function _mobStartAudioRelay(callId, myDeviceId, remoteDeviceId) {
    if (_mobAudioCtx) return;
    console.log('[AudioRelay] Starting PCM audio relay');
    _mobAudioLastSeq = -1;
    _mobAudioPcmBuffer = [];

    if (!_mobLocalStream || _mobLocalStream.getAudioTracks().length === 0) {
        console.warn('[AudioRelay] No local audio stream available');
        return;
    }

    // Capture: use ScriptProcessorNode to get raw PCM
    _mobAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = _mobAudioCtx.createMediaStreamSource(new MediaStream(_mobLocalStream.getAudioTracks()));
    _mobAudioProcessor = _mobAudioCtx.createScriptProcessor(4096, 1, 1);
    _mobAudioProcessor.onaudioprocess = (e) => {
        if (!_mobRelayMode) return;
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
            let s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        _mobAudioPcmBuffer.push(int16);
    };
    source.connect(_mobAudioProcessor);
    _mobAudioProcessor.connect(_mobAudioCtx.destination);
    _mobAudioSource = source;

    // Send accumulated PCM every 250ms
    _mobAudioSendTimer = setInterval(() => {
        if (_mobAudioPcmBuffer.length === 0 || !_mobRelayMode) return;
        const chunks = _mobAudioPcmBuffer.splice(0);
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
        fetch('/api/calls/audio-chunk', { method: 'POST', body: fd }).catch(() => {});
    }, 250);

    // Playback context
    _mobAudioPlayCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    _mobAudioNextPlayTime = 0;

    // Receive and play PCM from remote
    _mobAudioRecvTimer = setInterval(async () => {
        if (!_mobRelayMode) return;
        try {
            const res = await fetch('/api/calls/audio-chunk/' + callId + '/' + remoteDeviceId + '?after=' + _mobAudioLastSeq + '&_=' + Date.now());
            const data = await res.json();
            if (data.chunks && data.chunks.length > 0) {
                for (const chunk of data.chunks) {
                    if (chunk.seq > _mobAudioLastSeq) {
                        _mobAudioLastSeq = chunk.seq;
                        const binary = atob(chunk.data);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                        const int16 = new Int16Array(bytes.buffer);
                        const numSamples = int16.length;
                        const audioBuffer = _mobAudioPlayCtx.createBuffer(1, numSamples, 16000);
                        const channelData = audioBuffer.getChannelData(0);
                        for (let i = 0; i < numSamples; i++) {
                            channelData[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
                        }
                        const bufferSource = _mobAudioPlayCtx.createBufferSource();
                        bufferSource.buffer = audioBuffer;
                        bufferSource.connect(_mobAudioPlayCtx.destination);
                        const now = _mobAudioPlayCtx.currentTime;
                        if (_mobAudioNextPlayTime < now) _mobAudioNextPlayTime = now;
                        bufferSource.start(_mobAudioNextPlayTime);
                        _mobAudioNextPlayTime += audioBuffer.duration;
                    }
                }
            }
        } catch(e) {}
    }, 200);
}

function _mobStopAudioRelay() {
    if (_mobAudioProcessor) {
        try { _mobAudioProcessor.disconnect(); } catch(e) {}
        _mobAudioProcessor = null;
    }
    if (_mobAudioSource) {
        try { _mobAudioSource.disconnect(); } catch(e) {}
        _mobAudioSource = null;
    }
    if (_mobAudioCtx) {
        try { _mobAudioCtx.close(); } catch(e) {}
        _mobAudioCtx = null;
    }
    if (_mobAudioPlayCtx) {
        try { _mobAudioPlayCtx.close(); } catch(e) {}
        _mobAudioPlayCtx = null;
    }
    if (_mobAudioSendTimer) { clearInterval(_mobAudioSendTimer); _mobAudioSendTimer = null; }
    if (_mobAudioRecvTimer) { clearInterval(_mobAudioRecvTimer); _mobAudioRecvTimer = null; }
    _mobAudioLastSeq = -1;
    _mobAudioPcmBuffer = [];
    _mobAudioNextPlayTime = 0;
}

function mobInitCalls() {
    mobLoadCallDevices();
    mobLoadCallHistory();
    mobStartCallPolling();
}

// Global call polling — runs regardless of which tab is active
function mobStartCallPolling() {
    if (_mobCallPollTimer) clearInterval(_mobCallPollTimer);
    _mobCallPollTimer = setInterval(mobPollIncomingCalls, 3000);
}

async function mobPollIncomingCalls() {
    if (!_p2pDeviceId) return;
    try {
        const res = await fetch('/api/calls/active/' + _p2pDeviceId);
        const data = await res.json();
        const calls = data.calls || [];
        const ringing = calls.find(c => {
            const p = c.participants || {};
            return p[_p2pDeviceId] && p[_p2pDeviceId].status === 'ringing' && c.initiator_id !== _p2pDeviceId;
        });
        if (ringing && !_mobCurrentCallId && !_mobGrpCallId) {
            // Check if delegation is enabled — auto-answer with AI
            if (!_mobBotCallActive) {
                try {
                    const dRes = await fetch('/api/ai/delegation?device_id=' + _p2pDeviceId);
                    const dData = await dRes.json();
                    if (dData.delegation && dData.delegation.enabled) {
                        mobBotAnswerCall(ringing);
                        return;
                    }
                } catch(e) {}
            }
            _mobIncomingCall = ringing;
            mobShowIncomingCall(ringing);
        } else if (!ringing && _mobIncomingCall) {
            mobHideIncomingCall();
        }
    } catch(e) {}
}

function mobShowIncomingCall(call) {
    _mobIncomingCall = call;
    // Show global banner (appears on any tab)
    const banner = document.getElementById('mobGlobalCallBanner');
    if (banner) {
        document.getElementById('mobGlobalCallName').textContent = call.initiator_name || 'Unknown';
        document.getElementById('mobGlobalCallType').textContent = (call.type === 'video' ? 'Video' : 'Audio') + ' Call';
        banner.style.display = 'flex';
    }
    // Also show in-page banner if on calls tab
    const inPage = document.getElementById('mobCallIncomingBanner');
    if (inPage) {
        document.getElementById('mobCallIncomingName').textContent = call.initiator_name || 'Unknown';
        document.getElementById('mobCallIncomingType').textContent = call.type === 'video' ? 'Video' : 'Audio';
        document.getElementById('mobCallIncomingType').className = 'mob-call-type-badge ' + (call.type === 'video' ? 'video' : 'audio');
        inPage.style.display = 'flex';
    }
    // Vibrate
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
}

function mobHideIncomingCall() {
    _mobIncomingCall = null;
    const banner = document.getElementById('mobGlobalCallBanner');
    if (banner) banner.style.display = 'none';
    const inPage = document.getElementById('mobCallIncomingBanner');
    if (inPage) inPage.style.display = 'none';
    if (navigator.vibrate) navigator.vibrate(0);
}

async function mobAnswerCall() {
    if (!_mobIncomingCall) return;
    const call = _mobIncomingCall;
    mobHideIncomingCall();
    try {
        // Group call → use group call join flow
        if (call.group_id) {
            mobJoinGroupCall(call.id, call.type);
            return;
        }
        await fetch('/api/calls/' + call.id + '/answer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ device_id: _p2pDeviceId })
        });
        _mobCurrentCallId = call.id;
        _mobCallTargetId = call.initiator_id;
        // Switch to calls tab
        const callsBtn = document.querySelector('.btm-tab:nth-child(3)');
        if (callsBtn) switchView('calls', callsBtn);
        mobLaunchWebRTC(call.id, call.type, call.initiator_name, call.initiator_id, false);
    } catch(e) {
        mobShowToast('Failed to answer', 'error');
    }
}

async function mobRejectCall() {
    if (!_mobIncomingCall) return;
    try {
        await fetch('/api/calls/' + _mobIncomingCall.id + '/reject', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ device_id: _p2pDeviceId })
        });
    } catch(e) {}
    mobHideIncomingCall();
}

async function mobLoadCallDevices() {
    try {
        const res = await fetch('/api/p2p/devices');
        const data = await res.json();
        const devs = Array.isArray(data) ? data : (data.devices || []);
        const list = document.getElementById('mobCallDeviceList');
        if (!list) return;
        const others = devs.filter(d => (d.id || d.device_id) !== _p2pDeviceId);
        if (others.length === 0) {
            list.innerHTML = '<div class="mob-empty"><i class="fas fa-wifi"></i> No devices online</div>';
            return;
        }
        list.innerHTML = others.map(d => {
            const id = d.id || d.device_id;
            const name = d.name || 'Unknown';
            const icon = (d.user_agent || '').toLowerCase().includes('mobile') ? 'fa-mobile-alt' : 'fa-desktop';
            return `<div class="mob-call-device-item">
                <div class="mob-call-device-info">
                    <i class="fas ${icon}"></i>
                    <span>${escapeHtml(name)} ${mobVBadge(id)}</span>
                </div>
                <div class="mob-call-device-btns">
                    <button class="mob-call-action-btn audio" onclick="mobStartCall('${id}','${escapeHtml(name)}','audio')" title="Audio">
                        <i class="fas fa-phone-alt"></i>
                    </button>
                    <button class="mob-call-action-btn video" onclick="mobStartCall('${id}','${escapeHtml(name)}','video')" title="Video">
                        <i class="fas fa-video"></i>
                    </button>
                </div>
            </div>`;
        }).join('');
    } catch(e) { console.error('mobLoadCallDevices', e); }
}

let _mobCallFromChat = false;
let _mobVideoSwapped = false;
let _mobCurrentCallType = 'audio';

function startCallFromChat(callType) {
    if (!_chatCurrentConversation) {
        showToast('No chat conversation open');
        return;
    }
    _mobCallFromChat = true;
    const name = document.getElementById('chatWindowName').textContent || 'User';
    mobStartCallFromChatInline(_chatCurrentConversation, name, callType);
}

async function mobStartCallFromChatInline(targetId, targetName, callType) {
    try {
        const res = await fetch('/api/calls/initiate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                initiator_id: _p2pDeviceId,
                initiator_name: _p2pName,
                target_ids: [targetId],
                call_type: callType
            })
        });
        const data = await res.json();
        if (data.call_id) {
            _mobCurrentCallId = data.call_id;
            _mobCallTargetId = targetId;
            mobShowToast('Calling ' + targetName + '...', 'info');
            mobLaunchWebRTCInChat(data.call_id, callType, targetName, targetId, true);
        } else {
            mobShowToast(data.error || 'Failed', 'error');
            _mobCallFromChat = false;
        }
    } catch(e) {
        mobShowToast('Call failed', 'error');
        _mobCallFromChat = false;
    }
}

async function mobLaunchWebRTCInChat(callId, callType, displayName, remoteDeviceId, isInitiator) {
    _mobVideoSwapped = false;
    _mobCurrentCallType = callType;
    const overlay = document.getElementById('mobChatCallOverlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    document.getElementById('mobChatCallOverlayName').textContent = displayName || 'Calling...';

    const localVideo = document.getElementById('mobChatLocalVideo');
    const remoteVideo = document.getElementById('mobChatRemoteVideo');
    const callAvatar = document.getElementById('mobChatCallAvatarSection');
    const swapBtn = document.getElementById('mobChatBtnSwapVideo');

    if (callType === 'video') {
        if (localVideo) localVideo.style.display = 'block';
        if (remoteVideo) remoteVideo.style.display = 'block';
        if (callAvatar) callAvatar.style.display = 'none';
        if (swapBtn) swapBtn.style.display = '';
    } else {
        if (localVideo) localVideo.style.display = 'none';
        if (remoteVideo) remoteVideo.style.display = 'none';
        if (callAvatar) callAvatar.style.display = 'flex';
        const avatarName = document.getElementById('mobChatCallAvatarName');
        if (avatarName) avatarName.textContent = displayName || 'Audio Call';
        if (swapBtn) swapBtn.style.display = 'none';
    }

    // Update switch media buttons
    mobUpdateSwitchMediaButtons(callType);

    _mobCallSecs = 0;
    if (_mobCallTimer) clearInterval(_mobCallTimer);
    _mobCallTimer = setInterval(() => {
        _mobCallSecs++;
        const m = String(Math.floor(_mobCallSecs / 60)).padStart(2, '0');
        const s = String(_mobCallSecs % 60).padStart(2, '0');
        document.getElementById('mobChatCallOverlayTimer').textContent = m + ':' + s;
    }, 1000);

    try {
        _mobLocalStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: callType === 'video'
        });
        if (localVideo) localVideo.srcObject = _mobLocalStream;
    } catch(e) {
        console.error('[WebRTC] getUserMedia failed:', e);
        mobShowToast('Could not access mic/camera', 'error');
        mobEndCall();
        return;
    }

    _mobPeerConnection = new RTCPeerConnection(_mobRtcConfig);
    _mobLocalStream.getTracks().forEach(track => _mobPeerConnection.addTrack(track, _mobLocalStream));

    _mobPeerConnection.ontrack = (event) => {
        console.log('[WebRTC] Remote track:', event.track.kind, 'readyState:', event.track.readyState);
        const stream = event.streams[0] || new MediaStream([event.track]);
        if (remoteVideo) {
            remoteVideo.srcObject = stream;
            remoteVideo.play().catch(() => {});
        }
        const remoteAudio = document.getElementById('mobChatRemoteAudio');
        if (remoteAudio) {
            remoteAudio.srcObject = stream;
            remoteAudio.play().catch(() => {});
        }
        _mobEnsureRemoteAudio(stream);
        event.track.onunmute = () => {
            console.log('[WebRTC] Track unmuted:', event.track.kind);
            _mobForceAudioPlay();
        };
    };

    _mobPeerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('[WebRTC-Chat] Local ICE candidate:', event.candidate.type, event.candidate.protocol, event.candidate.address || '(mdns)');
            fetch('/api/calls/signal', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    from_id: _p2pDeviceId, to_id: remoteDeviceId,
                    signal_type: 'ice-candidate', call_id: callId,
                    payload: event.candidate.toJSON()
                })
            }).catch(e => console.error('ICE signal error:', e));
        } else {
            console.log('[WebRTC-Chat] ICE candidate gathering complete');
        }
    };

    _mobPeerConnection.onicegatheringstatechange = () => {
        if (_mobPeerConnection) console.log('[WebRTC-Chat] ICE gathering state:', _mobPeerConnection.iceGatheringState);
    };

    _mobPeerConnection.oniceconnectionstatechange = () => {
        if (!_mobPeerConnection) return;
        const state = _mobPeerConnection.iceConnectionState;
        console.log('[WebRTC-Chat] ICE connection state:', state);
        if (state === 'connected' || state === 'completed') {
            if (_mobIceTimeout) { clearTimeout(_mobIceTimeout); _mobIceTimeout = null; }
            _mobForceAudioPlay();
            if (_mobRelayMode) _mobStopVideoRelay();
        } else if (state === 'failed') {
            console.log('[WebRTC-Chat] ICE failed — starting video relay fallback');
            if (_mobCurrentCallType === 'video' && !_mobRelayMode) {
                _mobStartVideoRelay(callId, _p2pDeviceId, remoteDeviceId);
            }
            try { _mobPeerConnection.restartIce(); } catch(e) {
                mobShowToast('Using relay mode', 'info');
            }
        } else if (state === 'disconnected') {
            setTimeout(() => {
                if (_mobPeerConnection && _mobPeerConnection.iceConnectionState === 'disconnected') {
                    if (_mobCurrentCallType === 'video' && !_mobRelayMode) {
                        _mobStartVideoRelay(callId, _p2pDeviceId, remoteDeviceId);
                    }
                }
            }, 3000);
        }
    };

    if (isInitiator) {
        try {
            const offer = await _mobPeerConnection.createOffer();
            await _mobPeerConnection.setLocalDescription(offer);
            await fetch('/api/calls/signal', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    from_id: _p2pDeviceId, to_id: remoteDeviceId,
                    signal_type: 'offer', call_id: callId,
                    payload: { type: offer.type, sdp: offer.sdp }
                })
            });
        } catch(e) {
            console.error('Failed to create/send offer:', e);
            mobShowToast('Call setup failed', 'error');
            mobEndCall();
            return;
        }
    }

    mobStartSignalPolling(callId, remoteDeviceId);

    // Video relay fallback after 8 seconds of no connection
    setTimeout(() => {
        if (_mobPeerConnection && _mobPeerConnection.iceConnectionState !== 'connected' && _mobPeerConnection.iceConnectionState !== 'completed') {
            console.log('[WebRTC-Chat] 8s timeout — starting video relay fallback');
            if (_mobCurrentCallType === 'video' && !_mobRelayMode) {
                _mobStartVideoRelay(callId, _p2pDeviceId, remoteDeviceId);
            }
        }
    }, 8000);
    if (_mobIceTimeout) clearTimeout(_mobIceTimeout);
    _mobIceTimeout = setTimeout(() => {
        if (_mobPeerConnection && _mobPeerConnection.iceConnectionState !== 'connected' && _mobPeerConnection.iceConnectionState !== 'completed') {
            if (!_mobRelayMode) {
                mobShowToast('Call could not connect', 'error');
                mobEndCall();
            }
        }
    }, 45000);
}

function swapVideos(platform) {
    _mobVideoSwapped = !_mobVideoSwapped;
    if (platform === 'mobile') {
        ['mob', 'mobChat'].forEach(prefix => {
            const remoteId = prefix + 'RemoteVideo';
            const localId = prefix + 'LocalVideo';
            const remote = document.getElementById(remoteId);
            const local = document.getElementById(localId);
            if (remote && local) {
                if (_mobVideoSwapped) {
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

async function mobStartCall(targetId, targetName, callType) {
    _mobCallFromChat = false;
    try {
        const res = await fetch('/api/calls/initiate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                initiator_id: _p2pDeviceId,
                initiator_name: _p2pName,
                target_ids: [targetId],
                call_type: callType
            })
        });
        const data = await res.json();
        if (data.call_id) {
            _mobCurrentCallId = data.call_id;
            _mobCallTargetId = targetId;
            mobShowToast('Calling ' + targetName + '...', 'info');
            mobLaunchWebRTC(data.call_id, callType, targetName, targetId, true);
        } else {
            mobShowToast(data.error || 'Failed', 'error');
        }
    } catch(e) { mobShowToast('Call failed', 'error'); }
}

async function mobLaunchWebRTC(callId, callType, displayName, remoteDeviceId, isInitiator) {
    _mobVideoSwapped = false;
    _mobCurrentCallType = callType;
    const container = document.getElementById('mobCallMediaContainer');
    const activeEl = document.getElementById('mobCallActiveContainer');
    const startEl = document.getElementById('mobCallStartSection');
    const swapBtn = document.getElementById('mobBtnSwapVideo');

    if (!activeEl) return;
    activeEl.style.display = 'block';
    if (startEl) startEl.style.display = 'none';
    document.getElementById('mobCallActiveName').textContent = displayName || 'Call';

    // Show/hide video based on call type
    const localVideo = document.getElementById('mobLocalVideo');
    const remoteVideo = document.getElementById('mobRemoteVideo');
    const callAvatar = document.getElementById('mobCallAvatarSection');
    if (callType === 'video') {
        if (localVideo) localVideo.style.display = 'block';
        if (remoteVideo) remoteVideo.style.display = 'block';
        if (callAvatar) callAvatar.style.display = 'none';
        if (swapBtn) swapBtn.style.display = '';
    } else {
        if (localVideo) localVideo.style.display = 'none';
        if (remoteVideo) remoteVideo.style.display = 'none';
        if (callAvatar) callAvatar.style.display = 'flex';
        const avatarName = document.getElementById('mobCallAvatarName');
        if (avatarName) avatarName.textContent = displayName || 'Audio Call';
        if (swapBtn) swapBtn.style.display = 'none';
    }

    // Update switch media buttons
    mobUpdateSwitchMediaButtons(callType);

    // Timer
    _mobCallSecs = 0;
    if (_mobCallTimer) clearInterval(_mobCallTimer);
    _mobCallTimer = setInterval(() => {
        _mobCallSecs++;
        const m = String(Math.floor(_mobCallSecs / 60)).padStart(2, '0');
        const s = String(_mobCallSecs % 60).padStart(2, '0');
        document.getElementById('mobCallTimer').textContent = m + ':' + s;
    }, 1000);

    // Get media
    try {
        _mobLocalStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: callType === 'video'
        });
        if (localVideo) localVideo.srcObject = _mobLocalStream;
    } catch(e) {
        console.error('[WebRTC] getUserMedia failed:', e);
        mobShowToast('Could not access mic/camera', 'error');
        mobEndCall();
        return;
    }

    // Reset ICE candidate buffer
    _mobPendingIceCandidates = [];
    _mobRemoteDescSet = false;

    // Create RTCPeerConnection
    _mobPeerConnection = new RTCPeerConnection(_mobRtcConfig);

    // Add local tracks
    _mobLocalStream.getTracks().forEach(track => {
        _mobPeerConnection.addTrack(track, _mobLocalStream);
    });

    // Handle remote stream — force display on ALL possible video elements
    _mobPeerConnection.ontrack = (event) => {
        console.log('[WebRTC] Remote track received:', event.track.kind, 'readyState:', event.track.readyState);
        const stream = event.streams[0] || new MediaStream([event.track]);
        // Set remote video on both possible video elements (call tab + chat inline)
        ['mobRemoteVideo', 'mobChatRemoteVideo'].forEach(id => {
            const v = document.getElementById(id);
            if (v) {
                v.srcObject = stream;
                if (_mobCurrentCallType === 'video' || event.track.kind === 'video') v.style.display = 'block';
                v.play().catch(() => {});
            }
        });
        // Set remote audio on all audio elements
        ['mobRemoteAudio', 'mobChatRemoteAudio'].forEach(id => {
            const a = document.getElementById(id);
            if (a) {
                a.srcObject = stream;
                a.play().catch(() => {});
            }
        });
        _mobEnsureRemoteAudio(stream);
        event.track.onunmute = () => {
            console.log('[WebRTC] Track unmuted:', event.track.kind);
            // Re-force video display on unmute
            if (event.track.kind === 'video') {
                ['mobRemoteVideo', 'mobChatRemoteVideo'].forEach(id => {
                    const v = document.getElementById(id);
                    if (v && v.srcObject) { v.style.display = 'block'; v.play().catch(() => {}); }
                });
            }
            _mobForceAudioPlay();
        };
    };

    // ICE candidates
    _mobPeerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('[WebRTC] Local ICE candidate:', event.candidate.type, event.candidate.protocol, event.candidate.address || '(mdns)');
            fetch('/api/calls/signal', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    from_id: _p2pDeviceId,
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

    _mobPeerConnection.onicegatheringstatechange = () => {
        if (_mobPeerConnection) console.log('[WebRTC] ICE gathering state:', _mobPeerConnection.iceGatheringState);
    };

    _mobPeerConnection.oniceconnectionstatechange = () => {
        if (!_mobPeerConnection) return;
        const state = _mobPeerConnection.iceConnectionState;
        console.log('[WebRTC] ICE connection state:', state);
        if (state === 'connected' || state === 'completed') {
            if (_mobIceTimeout) { clearTimeout(_mobIceTimeout); _mobIceTimeout = null; }
            _mobForceAudioPlay();
            if (_mobRelayMode) _mobStopVideoRelay();
        } else if (state === 'failed') {
            console.log('[WebRTC] ICE failed — starting video relay fallback');
            if (_mobCurrentCallType === 'video' && !_mobRelayMode) {
                _mobStartVideoRelay(callId, _p2pDeviceId, remoteDeviceId);
            }
            try { _mobPeerConnection.restartIce(); } catch(e) {
                mobShowToast('Using relay mode', 'info');
            }
        } else if (state === 'disconnected') {
            setTimeout(() => {
                if (_mobPeerConnection && _mobPeerConnection.iceConnectionState === 'disconnected') {
                    if (_mobCurrentCallType === 'video' && !_mobRelayMode) {
                        _mobStartVideoRelay(callId, _p2pDeviceId, remoteDeviceId);
                    }
                }
            }, 3000);
        }
    };

    // If initiator, create & send offer
    if (isInitiator) {
        try {
            const offer = await _mobPeerConnection.createOffer();
            await _mobPeerConnection.setLocalDescription(offer);
            await fetch('/api/calls/signal', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    from_id: _p2pDeviceId,
                    to_id: remoteDeviceId,
                    signal_type: 'offer',
                    call_id: callId,
                    payload: { type: offer.type, sdp: offer.sdp }
                })
            });
            console.log('[WebRTC] Offer sent');
        } catch(e) {
            console.error('Failed to create/send offer:', e);
            mobShowToast('Call setup failed', 'error');
            mobEndCall();
            return;
        }
    }

    // Start polling for signals — immediate first poll
    mobStartSignalPolling(callId, remoteDeviceId);

    // Video relay fallback after 8 seconds of no connection
    setTimeout(() => {
        if (_mobPeerConnection && _mobPeerConnection.iceConnectionState !== 'connected' && _mobPeerConnection.iceConnectionState !== 'completed') {
            console.log('[WebRTC] 8s timeout — starting video relay fallback');
            if (_mobCurrentCallType === 'video' && !_mobRelayMode) {
                _mobStartVideoRelay(callId, _p2pDeviceId, remoteDeviceId);
            }
        }
    }, 8000);
    // Hard timeout after 45s
    if (_mobIceTimeout) clearTimeout(_mobIceTimeout);
    _mobIceTimeout = setTimeout(() => {
        if (_mobPeerConnection && _mobPeerConnection.iceConnectionState !== 'connected' && _mobPeerConnection.iceConnectionState !== 'completed') {
            if (!_mobRelayMode) {
                mobShowToast('Call could not connect', 'error');
                mobEndCall();
            }
        }
    }, 45000);
}

/** Flush buffered ICE candidates after remote description is set */
async function _mobFlushIceCandidates() {
    if (!_mobPeerConnection) return;
    const pending = _mobPendingIceCandidates.splice(0);
    console.log('[WebRTC] Flushing', pending.length, 'buffered ICE candidates');
    for (const c of pending) {
        try { await _mobPeerConnection.addIceCandidate(new RTCIceCandidate(c)); }
        catch(e) { console.warn('[WebRTC] Buffered ICE error:', e); }
    }
}

function mobStartSignalPolling(callId, remoteDeviceId) {
    if (_mobSignalPollTimer) clearInterval(_mobSignalPollTimer);
    const _pollSignals = async () => {
        if (!_mobPeerConnection || !_mobCurrentCallId) { clearInterval(_mobSignalPollTimer); return; }
        try {
            const res = await fetch('/api/calls/signals/' + _p2pDeviceId);
            const data = await res.json();
            for (const signal of (data.signals || [])) {
                if (signal.call_id !== callId) continue;
                if (signal.type === 'offer' && _mobPeerConnection.signalingState !== 'stable') continue;
                if (signal.type === 'offer') {
                    await _mobPeerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
                    _mobRemoteDescSet = true;
                    await _mobFlushIceCandidates();
                    const answer = await _mobPeerConnection.createAnswer();
                    await _mobPeerConnection.setLocalDescription(answer);
                    await fetch('/api/calls/signal', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            from_id: _p2pDeviceId,
                            to_id: remoteDeviceId,
                            signal_type: 'answer',
                            call_id: callId,
                            payload: { type: answer.type, sdp: answer.sdp }
                        })
                    });
                    console.log('[WebRTC] Answer sent');
                } else if (signal.type === 'answer') {
                    if (_mobPeerConnection.signalingState === 'have-local-offer') {
                        await _mobPeerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
                        _mobRemoteDescSet = true;
                        await _mobFlushIceCandidates();
                        console.log('[WebRTC] Answer received + flushed ICE');
                    }
                } else if (signal.type === 'ice-candidate') {
                    const c = signal.payload;
                    console.log('[WebRTC] Remote ICE candidate received:', c.candidate ? c.candidate.split(' ').slice(4,8).join(' ') : '(null)');
                    if (_mobRemoteDescSet && _mobPeerConnection.remoteDescription) {
                        try { await _mobPeerConnection.addIceCandidate(new RTCIceCandidate(c)); }
                        catch(e) { console.warn('[WebRTC] ICE add error:', e); }
                    } else {
                        _mobPendingIceCandidates.push(c);
                        console.log('[WebRTC] Buffered ICE candidate (no remote desc yet), total:', _mobPendingIceCandidates.length);
                    }
                } else if (signal.type === 'media-switch') {
                    console.log('[WebRTC] Remote side switched to:', signal.payload.callType);
                    _mobCurrentCallType = signal.payload.callType;
                    _mobApplyMediaSwitchUI(signal.payload.callType);
                    mobUpdateSwitchMediaButtons(signal.payload.callType);
                    mobShowToast('Call switched to ' + signal.payload.callType, 'info');
                } else if (signal.type === 'screen-share') {
                    console.log('[WebRTC] Remote screen share:', signal.payload.active);
                    if (signal.payload.active) {
                        // Make remote video visible if it was an audio call
                        ['mobRemoteVideo', 'mobChatRemoteVideo'].forEach(vid => {
                            const el = document.getElementById(vid);
                            if (el) el.style.display = 'block';
                        });
                        // Hide avatar during screen share
                        ['mobCallAvatarSection', 'mobChatCallAvatarSection'].forEach(id => {
                            const el = document.getElementById(id);
                            if (el) el.style.display = 'none';
                        });
                        mobShowToast('Remote is sharing their screen', 'info');
                    } else {
                        // Restore audio-call UI if we were in audio mode
                        if (_mobCurrentCallType === 'audio') {
                            ['mobRemoteVideo', 'mobChatRemoteVideo'].forEach(vid => {
                                const el = document.getElementById(vid);
                                if (el) el.style.display = 'none';
                            });
                            ['mobCallAvatarSection', 'mobChatCallAvatarSection'].forEach(id => {
                                const el = document.getElementById(id);
                                if (el) el.style.display = 'flex';
                            });
                        }
                        mobShowToast('Remote stopped screen sharing', 'info');
                    }
                } else if (signal.type === 'call-accepted') {
                    console.log('[WebRTC] Call accepted by remote');
                } else if (signal.type === 'call-end') {
                    console.log('[WebRTC] Remote side ended the call');
                    mobShowToast('Call ended by other party', 'info');
                    _mobCurrentCallId = null; // prevent sending end again
                    mobEndCall();
                    return;
                }
            }
        } catch(e) { console.error('Signal poll error:', e); }
    };
    // Immediate first poll (don't wait 400ms) + fast polling
    _pollSignals();
    _mobSignalPollTimer = setInterval(_pollSignals, 400);
}

function mobToggleMute() {
    if (!_mobLocalStream) return;
    const audioTrack = _mobLocalStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        const icon = audioTrack.enabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
        const isOff = !audioTrack.enabled;
        ['mobBtnToggleMute', 'mobChatBtnToggleMute', 'mobPipBtnMute'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) { btn.innerHTML = icon; btn.classList.toggle('active', isOff); }
        });
    }
}

function mobToggleCamera() {
    if (!_mobLocalStream) return;
    const videoTrack = _mobLocalStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        const icon = videoTrack.enabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
        const isOff = !videoTrack.enabled;
        ['mobBtnToggleCamera', 'mobChatBtnToggleCamera', 'mobPipBtnCamera'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) { btn.innerHTML = icon; btn.classList.toggle('active', isOff); }
        });
    }
}

function mobUpdateSwitchMediaButtons(callType) {
    const isVideo = callType === 'video';
    const icon = isVideo ? '<i class="fas fa-phone-alt"></i>' : '<i class="fas fa-video"></i>';
    const title = isVideo ? 'Switch to Audio' : 'Switch to Video';
    ['mobBtnSwitchMedia', 'mobChatBtnSwitchMedia'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) { btn.innerHTML = icon; btn.title = title; }
    });
}

async function mobSwitchCallMedia() {
    if (!_mobPeerConnection || !_mobLocalStream || !_mobCurrentCallId) return;
    const newType = _mobCurrentCallType === 'audio' ? 'video' : 'audio';

    try {
        if (newType === 'video') {
            // Switching from audio to video: get video track and add it
            const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
            const videoTrack = videoStream.getVideoTracks()[0];
            _mobLocalStream.addTrack(videoTrack);
            _mobPeerConnection.addTrack(videoTrack, _mobLocalStream);
        } else {
            // Switching from video to audio: remove video track
            const videoTrack = _mobLocalStream.getVideoTracks()[0];
            if (videoTrack) {
                const sender = _mobPeerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) _mobPeerConnection.removeTrack(sender);
                videoTrack.stop();
                _mobLocalStream.removeTrack(videoTrack);
            }
        }

        // Renegotiate
        const offer = await _mobPeerConnection.createOffer();
        await _mobPeerConnection.setLocalDescription(offer);
        await fetch('/api/calls/signal', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                from_id: _p2pDeviceId,
                to_id: _mobCallTargetId,
                signal_type: 'offer',
                call_id: _mobCurrentCallId,
                payload: { type: offer.type, sdp: offer.sdp }
            })
        });

        // Send media-switch signal so remote updates their UI
        await fetch('/api/calls/signal', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                from_id: _p2pDeviceId,
                to_id: _mobCallTargetId,
                signal_type: 'media-switch',
                call_id: _mobCurrentCallId,
                payload: { callType: newType }
            })
        });

        // Update local UI
        _mobCurrentCallType = newType;
        _mobApplyMediaSwitchUI(newType);
        mobUpdateSwitchMediaButtons(newType);
        mobShowToast('Switched to ' + newType + ' call', 'info');
    } catch(e) {
        console.error('mobSwitchCallMedia error:', e);
        mobShowToast('Failed to switch media', 'error');
    }
}

function _mobApplyMediaSwitchUI(callType) {
    const isVideo = callType === 'video';
    [['mobLocalVideo', 'mobRemoteVideo', 'mobCallAvatarSection', 'mobBtnSwapVideo'],
     ['mobChatLocalVideo', 'mobChatRemoteVideo', 'mobChatCallAvatarSection', 'mobChatBtnSwapVideo']].forEach(ids => {
        const [localId, remoteId, avatarId, swapId] = ids;
        const localV = document.getElementById(localId);
        const remoteV = document.getElementById(remoteId);
        const avatar = document.getElementById(avatarId);
        const swapB = document.getElementById(swapId);
        if (localV) {
            localV.style.display = isVideo ? 'block' : 'none';
            if (isVideo) localV.srcObject = _mobLocalStream;
        }
        if (remoteV) remoteV.style.display = isVideo ? 'block' : 'none';
        if (avatar) avatar.style.display = isVideo ? 'none' : 'flex';
        if (swapB) swapB.style.display = isVideo ? '' : 'none';
    });
}

function mobEndCall() {
    // Clear ICE timeout
    if (_mobIceTimeout) { clearTimeout(_mobIceTimeout); _mobIceTimeout = null; }

    // Stop video relay if active
    if (_mobRelayMode) _mobStopVideoRelay();

    // Also end any bot call in progress
    if (_mobBotCallActive) { mobBotEndCall(); }

    // Clean up PiP
    mobHidePiP();

    // Clean up screen share
    if (_mobScreenShareActive) {
        if (_mobScreenShareStream) { _mobScreenShareStream.getTracks().forEach(t => t.stop()); _mobScreenShareStream = null; }
        _mobScreenShareActive = false;
        _mobOriginalVideoTrack = null;
        _mobUpdateScreenShareButtons(false);
    }

    if (_mobCurrentCallId) {
        fetch('/api/calls/' + _mobCurrentCallId + '/end', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ device_id: _p2pDeviceId })
        }).catch(()=>{});
    }

    if (_mobSignalPollTimer) { clearInterval(_mobSignalPollTimer); _mobSignalPollTimer = null; }
    if (_mobPeerConnection) { _mobPeerConnection.close(); _mobPeerConnection = null; }
    if (_mobLocalStream) { _mobLocalStream.getTracks().forEach(t => t.stop()); _mobLocalStream = null; }
    _mobCleanupDynAudio();

    _mobCurrentCallId = null;
    _mobCallTargetId = null;
    _mobVideoSwapped = false;
    _mobCurrentCallType = 'audio';
    if (_mobCallTimer) { clearInterval(_mobCallTimer); _mobCallTimer = null; }

    // Hide main call page UI
    const activeEl = document.getElementById('mobCallActiveContainer');
    if (activeEl) activeEl.style.display = 'none';
    ['mobLocalVideo', 'mobRemoteVideo', 'mobRemoteAudio'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.srcObject = null;
    });
    const startEl = document.getElementById('mobCallStartSection');
    if (startEl) startEl.style.display = '';

    // Hide chat overlay UI
    const chatOverlay = document.getElementById('mobChatCallOverlay');
    if (chatOverlay) chatOverlay.style.display = 'none';
    ['mobChatLocalVideo', 'mobChatRemoteVideo', 'mobChatRemoteAudio'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.srcObject = null;
    });

    // Reset swap classes
    ['mobRemoteVideo', 'mobChatRemoteVideo'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.className = 'mob-call-remote-video'; }
    });
    ['mobLocalVideo', 'mobChatLocalVideo'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.className = 'mob-call-local-video'; }
    });

    _mobCallFromChat = false;
    mobShowToast('Call ended', 'info');
    mobLoadCallHistory();
}

// ═══════════════════════════════════════════════════════════════
// AI BOT VOICE CALL ANSWERING (Delegation)
// When delegation is enabled, the bot auto-answers calls,
// uses Speech Recognition (STT) to hear the caller,
// DeepSeek AI to generate response, and TTS to speak back.
// ═══════════════════════════════════════════════════════════════

let _mobBotCallActive = false;
let _mobBotCallId = null;
let _mobBotPeerConnection = null;
let _mobBotSignalPollTimer = null;
let _mobBotAudioCtx = null;
let _mobBotRecognition = null;
let _mobBotSpeaking = false;
let _mobBotCallTargetId = null;
let _mobBotRemoteStream = null;
let _mobBotLocalStream = null;
let _mobBotConversation = [];

async function mobBotAnswerCall(call) {
    if (_mobBotCallActive) return;
    _mobBotCallActive = true;
    _mobBotCallId = call.id;
    _mobBotCallTargetId = call.initiator_id;
    _mobBotConversation = [];
    
    console.log('[BotCall] Auto-answering call from', call.initiator_name);
    mobShowToast('🤖 Beam AI answering call from ' + (call.initiator_name || 'Unknown'), 'info');
    
    try {
        // 1. Answer the call on the server
        await fetch('/api/calls/' + call.id + '/answer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ device_id: _p2pDeviceId })
        });
        
        // 2. Get REAL microphone — required for SpeechRecognition AND
        //    relaying TTS audio to caller (speakers → mic → WebRTC)
        try {
            _mobBotLocalStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            console.log('[BotCall] Microphone acquired');
        } catch(micErr) {
            console.warn('[BotCall] Mic access denied, using silent stream:', micErr);
            const actx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = actx.createOscillator();
            const gain = actx.createGain();
            gain.gain.value = 0;
            osc.connect(gain);
            const dest = actx.createMediaStreamDestination();
            gain.connect(dest);
            osc.start();
            _mobBotLocalStream = dest.stream;
            _mobBotAudioCtx = actx;
        }
        
        // 3. Create PeerConnection
        _mobBotPeerConnection = new RTCPeerConnection(_mobRtcConfig);
        
        // Add local audio tracks
        _mobBotLocalStream.getTracks().forEach(track => {
            _mobBotPeerConnection.addTrack(track, _mobBotLocalStream);
        });
        
        // 4. Handle remote stream — play through speakers so caller audio is audible
        //    AND SpeechRecognition (via mic) can pick up the caller's voice
        _mobBotPeerConnection.ontrack = (event) => {
            console.log('[BotCall] Remote track received:', event.track.kind);
            _mobBotRemoteStream = event.streams[0];
            // Play remote audio through speakers using dynamic audio element
            _mobBotEnsureRemoteAudio(_mobBotRemoteStream);
            // Start speech recognition after short delay
            setTimeout(() => _mobBotStartListening(), 500);
        };
        
        // 5. ICE candidates
        _mobBotPeerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                fetch('/api/calls/signal', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        from_id: _p2pDeviceId,
                        to_id: _mobBotCallTargetId,
                        signal_type: 'ice-candidate',
                        call_id: call.id,
                        payload: event.candidate.toJSON()
                    })
                }).catch(e => console.error('[BotCall] ICE signal error:', e));
            }
        };
        
        // 6. Connection state monitoring
        _mobBotPeerConnection.oniceconnectionstatechange = () => {
            const state = _mobBotPeerConnection ? _mobBotPeerConnection.iceConnectionState : 'null';
            console.log('[BotCall] ICE state:', state);
            if (state === 'connected' || state === 'completed') {
                console.log('[BotCall] WebRTC connected — audio flowing');
            }
            if (state === 'disconnected') {
                setTimeout(() => {
                    if (_mobBotPeerConnection && _mobBotPeerConnection.iceConnectionState === 'disconnected') {
                        console.warn('[BotCall] Still disconnected, ending call');
                        mobBotEndCall();
                    }
                }, 5000);
            }
            if (state === 'failed') {
                mobBotEndCall();
            }
        };
        
        // 7. Start signal polling for WebRTC negotiation
        _mobBotStartSignalPolling(call.id, _mobBotCallTargetId);
        
        // 8. Speak greeting after WebRTC has time to connect
        setTimeout(() => {
            if (_mobBotCallActive) {
                _mobBotSpeak("Hey! They're not available right now, but I can take a message or help you out. What's up?");
            }
        }, 3000);
        
    } catch(e) {
        console.error('[BotCall] Failed to answer:', e);
        _mobBotCallActive = false;
        _mobBotCallId = null;
    }
}

/* Play remote call audio through a dynamic <audio> element on speakers */
function _mobBotEnsureRemoteAudio(stream) {
    let el = document.getElementById('_mobBotRemoteAudio');
    if (el) { el.srcObject = null; el.remove(); }
    el = document.createElement('audio');
    el.id = '_mobBotRemoteAudio';
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;';
    document.body.appendChild(el);
    el.srcObject = stream;
    el.volume = 1.0;
    const p = el.play();
    if (p) p.catch(e => {
        console.warn('[BotCall] Audio autoplay blocked, retry on touch:', e);
        const resume = () => { el.play().catch(() => {}); };
        document.addEventListener('touchstart', resume, { once: true });
        document.addEventListener('click', resume, { once: true });
    });
    console.log('[BotCall] Remote audio element playing through speakers');
}

function _mobBotCleanupRemoteAudio() {
    const el = document.getElementById('_mobBotRemoteAudio');
    if (el) { el.srcObject = null; el.remove(); }
}

function _mobBotStartSignalPolling(callId, remoteDeviceId) {
    if (_mobBotSignalPollTimer) clearInterval(_mobBotSignalPollTimer);
    _mobBotSignalPollTimer = setInterval(async () => {
        if (!_mobBotPeerConnection || !_mobBotCallId) { clearInterval(_mobBotSignalPollTimer); return; }
        try {
            const res = await fetch('/api/calls/signals/' + _p2pDeviceId);
            const data = await res.json();
            for (const signal of (data.signals || [])) {
                if (signal.call_id !== callId) continue;
                if (signal.type === 'offer') {
                    if (_mobBotPeerConnection.signalingState === 'stable' || _mobBotPeerConnection.signalingState === 'have-local-offer') {
                        await _mobBotPeerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
                        const answer = await _mobBotPeerConnection.createAnswer();
                        await _mobBotPeerConnection.setLocalDescription(answer);
                        await fetch('/api/calls/signal', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({
                                from_id: _p2pDeviceId,
                                to_id: remoteDeviceId,
                                signal_type: 'answer',
                                call_id: callId,
                                payload: { type: answer.type, sdp: answer.sdp }
                            })
                        });
                        console.log('[BotCall] Answer sent for offer');
                    }
                } else if (signal.type === 'answer') {
                    if (_mobBotPeerConnection.signalingState === 'have-local-offer') {
                        await _mobBotPeerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
                    }
                } else if (signal.type === 'ice-candidate') {
                    try {
                        await _mobBotPeerConnection.addIceCandidate(new RTCIceCandidate(signal.payload));
                    } catch(e) { console.warn('[BotCall] ICE add error:', e); }
                } else if (signal.type === 'call-end') {
                    mobBotEndCall();
                    return;
                }
            }
        } catch(e) { console.warn('[BotCall] Signal poll error:', e); }
    }, 800);
}

function _mobBotStartListening() {
    // SpeechRecognition uses the device microphone.
    // The caller's audio plays through speakers → mic picks it up → STT
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn('[BotCall] SpeechRecognition not supported in this browser');
        return;
    }
    
    if (_mobBotRecognition) {
        try { _mobBotRecognition.stop(); } catch(e) {}
    }
    
    _mobBotRecognition = new SpeechRecognition();
    _mobBotRecognition.continuous = true;
    _mobBotRecognition.interimResults = false;
    _mobBotRecognition.lang = 'en-US';
    _mobBotRecognition.maxAlternatives = 1;
    
    _mobBotRecognition.onresult = async (event) => {
        if (_mobBotSpeaking) return;
        for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
                const transcript = event.results[i][0].transcript.trim();
                if (!transcript || transcript.length < 2) continue;
                console.log('[BotCall] Heard:', transcript);
                _mobBotConversation.push({ role: 'caller', text: transcript });
                await _mobBotProcessCallerSpeech(transcript);
            }
        }
    };
    
    _mobBotRecognition.onerror = (event) => {
        console.warn('[BotCall] STT error:', event.error);
        if (event.error === 'no-speech' || event.error === 'audio-capture' || event.error === 'network') {
            setTimeout(() => {
                if (_mobBotCallActive && !_mobBotSpeaking) {
                    try { _mobBotRecognition.start(); } catch(e) {}
                }
            }, 1500);
        }
    };
    
    _mobBotRecognition.onend = () => {
        if (_mobBotCallActive && !_mobBotSpeaking) {
            setTimeout(() => {
                if (_mobBotCallActive && !_mobBotSpeaking && _mobBotRecognition) {
                    try { _mobBotRecognition.start(); } catch(e) {}
                }
            }, 300);
        }
    };
    
    try {
        _mobBotRecognition.start();
        console.log('[BotCall] Speech recognition started (listening via microphone)');
    } catch(e) {
        console.error('[BotCall] Failed to start STT:', e);
    }
}

async function _mobBotProcessCallerSpeech(text) {
    _mobBotSpeaking = true;
    try {
        if (_mobBotRecognition) try { _mobBotRecognition.stop(); } catch(e) {}
        
        const res = await fetch('/api/ai/voice-reply', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                device_id: _p2pDeviceId,
                caller_name: 'Caller',
                text: text,
                conversation: _mobBotConversation.slice(-6),
                tts: true
            })
        });
        const data = await res.json();
        
        if (data.reply) {
            _mobBotConversation.push({ role: 'bot', text: data.reply });
            // Speak the reply — SpeechSynthesis plays through speakers,
            // mic picks it up and relays to caller via WebRTC
            await _mobBotSpeak(data.reply);
            
            if (data.flagged) {
                mobShowToast('⚠️ AI flagged an important call message', 'warning');
                await fetch('/api/p2p/messages', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        sender_id: 'beam-ai-bot',
                        sender_name: 'Beam AI',
                        recipient_id: _p2pDeviceId,
                        text: '📞 FLAGGED CALL from caller: "' + text + '"\nAI replied: "' + data.reply + '"',
                        ai_delegated: true
                    })
                });
            }
        }
    } catch(e) {
        console.error('[BotCall] Voice reply error:', e);
    }
    _mobBotSpeaking = false;
    if (_mobBotCallActive && _mobBotRecognition) {
        try { _mobBotRecognition.start(); } catch(e) {}
    }
}

function _mobBotSpeak(text) {
    return new Promise(async resolve => {
        try {
            console.log('[BotCall] Fetching Edge Neural TTS for:', text.substring(0, 60) + '...');
            const res = await fetch('/api/ai/tts', {
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

function mobBotEndCall() {
    console.log('[BotCall] Ending bot call');
    
    if (_mobBotCallId) {
        fetch('/api/calls/' + _mobBotCallId + '/end', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ device_id: _p2pDeviceId })
        }).catch(() => {});
    }
    
    if (_mobBotSignalPollTimer) { clearInterval(_mobBotSignalPollTimer); _mobBotSignalPollTimer = null; }
    if (_mobBotPeerConnection) { _mobBotPeerConnection.close(); _mobBotPeerConnection = null; }
    if (_mobBotRecognition) { try { _mobBotRecognition.stop(); } catch(e) {} _mobBotRecognition = null; }
    if (_mobBotAudioCtx) { _mobBotAudioCtx.close().catch(() => {}); _mobBotAudioCtx = null; }
    if (_mobBotLocalStream) { _mobBotLocalStream.getTracks().forEach(t => t.stop()); _mobBotLocalStream = null; }
    _mobBotCleanupRemoteAudio();
    // Neural TTS audio stops when Audio element is garbage collected
    _mobBotRemoteStream = null;
    _mobBotCallActive = false;
    _mobBotCallId = null;
    _mobBotCallTargetId = null;
    _mobBotConversation = [];
    _mobBotSpeaking = false;
    
    mobShowToast('🤖 Bot call ended', 'info');
    mobLoadCallHistory();
}

async function mobLoadCallHistory() {
    try {
        const res = await fetch('/api/calls/history/' + _p2pDeviceId);
        const data = await res.json();
        const history = data.history || [];
        const list = document.getElementById('mobCallHistoryList');
        if (!list) return;
        if (history.length === 0) {
            list.innerHTML = '<div class="mob-empty"><i class="fas fa-phone-alt"></i> No recent calls</div>';
            return;
        }
        list.innerHTML = history.slice(0, 20).map(c => {
            const isOut = c.initiator_id === _p2pDeviceId;
            const icon = isOut ? 'fa-phone-alt' : 'fa-phone-volume';
            const dirCls = isOut ? 'outgoing' : 'incoming';
            const otherName = isOut ? (Object.keys(c.participants || {}).find(k => k !== _p2pDeviceId) || 'Unknown') : (c.initiator_name || 'Unknown');
            const typeIcon = c.type === 'video' ? 'fa-video' : 'fa-phone-alt';
            const dur = c.ended && c.created ? _fmtCallDur(c.ended - c.created) : 'Missed';
            return `<div class="mob-call-history-item">
                <div class="mob-call-history-icon ${dirCls}"><i class="fas ${icon}"></i></div>
                <div class="mob-call-history-info">
                    <span class="mob-call-history-name">${escapeHtml(otherName)} ${mobVBadge(otherName)}</span>
                    <span class="mob-call-history-meta"><i class="fas ${typeIcon}"></i> ${dur}</span>
                </div>
                <span class="mob-call-dir-badge ${dirCls}">${isOut ? 'Out' : 'In'}</span>
            </div>`;
        }).join('');
    } catch(e) {}
}

function _fmtCallDur(s) {
    if (!s || s < 1) return 'Missed';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m ? m + 'm ' + sec + 's' : sec + 's';
}

// Start global polling when page loads (for any tab)
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => { if (_p2pDeviceId) mobStartCallPolling(); }, 3000);
    // Load AI chat history
    setTimeout(() => { if (typeof _mobAiLoadHistory === 'function') _mobAiLoadHistory(); }, 2000);
});


/* ═══════════════════════════════════════════════════════════════
   Mobile PiP (Picture-in-Picture) Floating Window
   ═════════════════════════════════════════════════════════════ */
let _mobPipActive = false;

function mobEnterPiP() {
  if (!_mobCurrentCallId || _mobPipActive) return;
  _mobPipActive = true;

  const pipWin = document.getElementById('mobPipWindow');
  const pipRemote = document.getElementById('mobPipRemoteVideo');
  const pipLocal = document.getElementById('mobPipLocalVideo');
  const pipAvatar = document.getElementById('mobPipAvatar');
  const pipTitle = document.getElementById('mobPipTitle');

  // Copy streams to PiP
  const srcRemote = document.getElementById(_mobCallFromChat ? 'mobChatRemoteVideo' : 'mobRemoteVideo');
  const srcLocal = document.getElementById(_mobCallFromChat ? 'mobChatLocalVideo' : 'mobLocalVideo');
  if (srcRemote && srcRemote.srcObject) pipRemote.srcObject = srcRemote.srcObject;
  if (srcLocal && srcLocal.srcObject) pipLocal.srcObject = srcLocal.srcObject;

  // Show avatar or video based on call type
  const isVideo = _mobCurrentCallType === 'video';
  pipRemote.style.display = isVideo ? 'block' : 'none';
  pipLocal.style.display = isVideo ? 'block' : 'none';
  pipAvatar.style.display = isVideo ? 'none' : 'flex';
  pipTitle.textContent = _mobCallFromChat ? 'In-call' : 'Call';

  _mobSyncPipButtons();

  // Hide main call UI but keep call alive
  if (_mobCallFromChat) {
    const overlay = document.getElementById('mobChatCallOverlay');
    if (overlay) overlay.style.display = 'none';
  } else {
    const activeEl = document.getElementById('mobCallActiveContainer');
    if (activeEl) activeEl.style.display = 'none';
    const startEl = document.getElementById('mobCallStartSection');
    if (startEl) startEl.style.display = '';
  }

  // Show PiP window at bottom-right
  pipWin.style.display = 'block';
  pipWin.style.right = '12px';
  pipWin.style.bottom = '70px';
  pipWin.style.left = 'auto';
  pipWin.style.top = 'auto';

  _mobInitPipDrag();
}

function mobExitPiP() {
  if (!_mobPipActive) return;
  _mobPipActive = false;

  const pipWin = document.getElementById('mobPipWindow');
  pipWin.style.display = 'none';
  document.getElementById('mobPipRemoteVideo').srcObject = null;
  document.getElementById('mobPipLocalVideo').srcObject = null;

  if (!_mobCurrentCallId) return; // Call already ended

  // Restore main call UI
  if (_mobCallFromChat) {
    const overlay = document.getElementById('mobChatCallOverlay');
    if (overlay) {
      overlay.style.display = 'flex';
      const remoteV = document.getElementById('mobChatRemoteVideo');
      const localV = document.getElementById('mobChatLocalVideo');
      if (_mobPeerConnection) {
        _mobPeerConnection.getReceivers().forEach(r => {
          if (r.track && r.track.kind === 'video' && remoteV) remoteV.srcObject = new MediaStream([r.track]);
        });
      }
      if (_mobLocalStream && localV) localV.srcObject = _mobLocalStream;
      _mobApplyMediaSwitchUI(_mobCurrentCallType);
    }
    switchView('chat');
  } else {
    switchView('calls');
    const activeEl = document.getElementById('mobCallActiveContainer');
    if (activeEl) activeEl.style.display = 'block';
    const startEl = document.getElementById('mobCallStartSection');
    if (startEl) startEl.style.display = 'none';
    const remoteV = document.getElementById('mobRemoteVideo');
    const localV = document.getElementById('mobLocalVideo');
    if (_mobPeerConnection) {
      _mobPeerConnection.getReceivers().forEach(r => {
        if (r.track && r.track.kind === 'video' && remoteV) remoteV.srcObject = new MediaStream([r.track]);
      });
    }
    if (_mobLocalStream && localV) localV.srcObject = _mobLocalStream;
    _mobApplyMediaSwitchUI(_mobCurrentCallType);
  }
}

function _mobSyncPipButtons() {
  if (!_mobLocalStream) return;
  const audioTrack = _mobLocalStream.getAudioTracks()[0];
  const videoTrack = _mobLocalStream.getVideoTracks()[0];
  const muteBtn = document.getElementById('mobPipBtnMute');
  const camBtn = document.getElementById('mobPipBtnCamera');
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

function mobHidePiP() {
  _mobPipActive = false;
  const pipWin = document.getElementById('mobPipWindow');
  if (pipWin) pipWin.style.display = 'none';
  const pr = document.getElementById('mobPipRemoteVideo');
  const pl = document.getElementById('mobPipLocalVideo');
  if (pr) pr.srcObject = null;
  if (pl) pl.srcObject = null;
}

function _mobInitPipDrag() {
  const pipWin = document.getElementById('mobPipWindow');
  const handle = document.getElementById('mobPipDragHandle');
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
    _mobSnapPipToEdge(pipWin);
  }

  handle.addEventListener('mousedown', onDown);
  handle.addEventListener('touchstart', onDown, { passive: false });
}

function _mobSnapPipToEdge(el) {
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;

  el.classList.add('pip-snapping');

  let newLeft;
  if (rect.left + rect.width / 2 < vw / 2) {
    newLeft = margin;
  } else {
    newLeft = vw - rect.width - margin;
  }

  let newTop = Math.max(margin, Math.min(vh - rect.height - 70, rect.top));

  el.style.left = newLeft + 'px';
  el.style.top = newTop + 'px';
  el.style.right = 'auto';
  el.style.bottom = 'auto';

  setTimeout(() => el.classList.remove('pip-snapping'), 350);
}


/* ═══════════════════════════════════════════════════════════════
   Mobile Screen Sharing
   ═════════════════════════════════════════════════════════════ */
let _mobScreenShareStream = null;
let _mobScreenShareActive = false;
let _mobOriginalVideoTrack = null;

async function mobToggleScreenShare() {
  if (_mobScreenShareActive) {
    mobStopScreenShare();
  } else {
    await mobStartScreenShare();
  }
}

async function mobStartScreenShare() {
  if (!_mobPeerConnection || !_mobCurrentCallId) {
    mobShowToast('No active call', 'error');
    return;
  }

  // Secure context check
  if (typeof window.isSecureContext !== 'undefined' && !window.isSecureContext) {
    mobShowToast('Screen sharing requires HTTPS', 'error');
    return;
  }

  // Check getDisplayMedia availability (not supported on all mobile browsers)
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    mobShowToast('Screen sharing not supported on this device/browser', 'error');
    console.warn('[ScreenShare] getDisplayMedia not available. mediaDevices:', !!navigator.mediaDevices);
    return;
  }

  try {
    console.log('[ScreenShare] Requesting screen capture...');
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e1) {
      if (e1.name === 'NotAllowedError' || e1.name === 'AbortError') throw e1;
      // Fallback: try minimal constraints
      console.warn('[ScreenShare] Retrying with minimal constraints:', e1.name, e1.message);
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    }
    _mobScreenShareStream = stream;
    console.log('[ScreenShare] Got stream, tracks:', stream.getTracks().length);

    const screenTrack = _mobScreenShareStream.getVideoTracks()[0];
    if (!screenTrack) { mobShowToast('No screen track obtained', 'error'); return; }
    console.log('[ScreenShare] Screen track:', screenTrack.label, screenTrack.readyState);

    // Save original camera track and replace/add
    const senders = _mobPeerConnection.getSenders();
    console.log('[ScreenShare] Senders:', senders.map(s => s.track ? s.track.kind : 'null'));
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    if (videoSender) {
      _mobOriginalVideoTrack = videoSender.track;
      await videoSender.replaceTrack(screenTrack);
    } else {
      // Audio-only call: no video sender — add track and renegotiate
      _mobOriginalVideoTrack = null;
      _mobPeerConnection.addTrack(screenTrack, _mobScreenShareStream);
      // Trigger renegotiation so the remote side gets the new video track
      try {
        const offer = await _mobPeerConnection.createOffer();
        await _mobPeerConnection.setLocalDescription(offer);
        await fetch('/api/calls/signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from_id: _p2pDeviceId, to_id: _mobCallTargetId,
            signal_type: 'offer', call_id: _mobCurrentCallId,
            payload: { type: offer.type, sdp: offer.sdp }
          })
        });
        console.log('[ScreenShare] Renegotiation offer sent for audio→screen');
      } catch(re) {
        console.error('[ScreenShare] Renegotiation failed:', re);
      }
    }

    // Show screen share locally in both views
    ['mobLocalVideo', 'mobChatLocalVideo'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.srcObject = new MediaStream([screenTrack]); el.style.display = 'block'; }
    });

    _mobScreenShareActive = true;
    _mobUpdateScreenShareButtons(true);

    // Signal remote about screen share
    fetch('/api/calls/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: _mobCurrentCallId,
        from_id: _p2pDeviceId,
        to_id: _mobCallTargetId,
        signal_type: 'screen-share',
        payload: { active: true }
      })
    }).catch(e => console.error('screen-share signal error:', e));

    // Detect when user stops sharing via browser UI
    screenTrack.onended = () => mobStopScreenShare();

    mobShowToast('Screen sharing started', 'info');
  } catch(e) {
    if (e.name === 'NotAllowedError') {
      mobShowToast('Screen share cancelled', 'info');
    } else {
      console.error('[ScreenShare] Error:', e);
      mobShowToast('Failed to share screen: ' + (e.message || e.name || 'unknown'), 'error');
    }
  }
}

function mobStopScreenShare() {
  if (!_mobScreenShareActive) return;

  if (_mobScreenShareStream) {
    _mobScreenShareStream.getTracks().forEach(t => t.stop());
    _mobScreenShareStream = null;
  }

  // Restore original camera track
  if (_mobPeerConnection && _mobOriginalVideoTrack) {
    const videoSender = _mobPeerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
    if (videoSender) videoSender.replaceTrack(_mobOriginalVideoTrack);
  }

  // Restore local video display in both views
  ['mobLocalVideo', 'mobChatLocalVideo'].forEach(id => {
    const el = document.getElementById(id);
    if (el && _mobLocalStream) {
      const vt = _mobLocalStream.getVideoTracks()[0];
      if (vt) { el.srcObject = new MediaStream([vt]); }
      else { el.style.display = _mobCurrentCallType === 'video' ? 'block' : 'none'; }
    }
  });

  _mobScreenShareActive = false;
  _mobOriginalVideoTrack = null;
  _mobUpdateScreenShareButtons(false);

  // Signal remote
  if (_mobCurrentCallId && _mobCallTargetId) {
    fetch('/api/calls/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: _mobCurrentCallId,
        from_id: _p2pDeviceId,
        to_id: _mobCallTargetId,
        signal_type: 'screen-share',
        payload: { active: false }
      })
    }).catch(e => console.error('screen-share signal error:', e));
  }

  mobShowToast('Screen sharing stopped', 'info');
}

function _mobUpdateScreenShareButtons(active) {
  ['mobBtnScreenShare', 'mobChatBtnScreenShare'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.classList.toggle('active', active);
      btn.innerHTML = active ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-desktop"></i>';
      btn.title = active ? 'Stop Sharing' : 'Share Screen';
    }
  });
}


// ═══════════════════════════════════════════════════════════════
// GROUPS — Mobile Browser
// ═══════════════════════════════════════════════════════════════

let _mobCurrentGroupId = null;
let _mobCurrentGroupData = null;
let _mobGroupMsgPoll = null;
let _mobGroupMsgLastTs = 0;

function mobInitGroups() {
    mobLoadGroupsList();
}

async function mobLoadGroupsList() {
    if (!_p2pDeviceId) return;
    try {
        const res = await fetch('/api/groups/list/' + _p2pDeviceId);
        const data = await res.json();
        const groups = data.groups || [];
        const list = document.getElementById('mobGroupsList');
        if (!list) return;
        if (groups.length === 0) {
            list.innerHTML = '<div class="mob-empty"><i class="fas fa-users"></i> No groups yet</div>';
            return;
        }
        list.innerHTML = groups.map(g => {
            const memberCount = (g.members || []).length;
            return `<div class="mob-group-item" onclick="mobOpenGroupChat('${g.id}')">
                <div class="mob-group-avatar"><i class="fas fa-users"></i></div>
                <div class="mob-group-item-info">
                    <span class="mob-group-name">${escapeHtml(g.name)} ${mobVBadge(g.id)}</span>
                    <span class="mob-group-sub">${memberCount} member${memberCount !== 1 ? 's' : ''}</span>
                </div>
                <i class="fas fa-chevron-right" style="color:var(--text-muted,#94A3B8)"></i>
            </div>`;
        }).join('');
    } catch(e) { console.error('mobLoadGroupsList', e); }
}

async function mobOpenGroupChat(groupId) {
    _mobCurrentGroupId = groupId;
    _mobGroupMsgLastTs = 0;
    document.getElementById('mobGroupsListPanel').style.display = 'none';
    document.getElementById('mobGroupChatPanel').style.display = 'flex';

    try {
        const res = await fetch('/api/groups/' + groupId);
        const g = await res.json();
        _mobCurrentGroupData = g;
        document.getElementById('mobGroupChatName').textContent = g.name || 'Group';
        document.getElementById('mobGroupChatMembers').textContent = (g.members || []).length + ' members';
    } catch(e) {}

    document.getElementById('mobGroupMessages').innerHTML = '';
    mobLoadGroupMessages();
    if (_mobGroupMsgPoll) clearInterval(_mobGroupMsgPoll);
    _mobGroupMsgPoll = setInterval(mobLoadGroupMessages, 5000);

    // Check for active group call
    mobCheckActiveGroupCall();
}

function mobCloseGroupChat() {
    _mobCurrentGroupId = null;
    if (_mobGroupMsgPoll) { clearInterval(_mobGroupMsgPoll); _mobGroupMsgPoll = null; }
    document.getElementById('mobGroupChatPanel').style.display = 'none';
    document.getElementById('mobGroupsListPanel').style.display = '';
    mobLoadGroupsList();
}

async function mobLoadGroupMessages() {
    if (!_mobCurrentGroupId) return;
    try {
        const res = await fetch('/api/groups/' + _mobCurrentGroupId + '/messages?since=' + _mobGroupMsgLastTs);
        const data = await res.json();
        const msgs = data.messages || [];
        const area = document.getElementById('mobGroupMessages');

        if (msgs.length === 0 && _mobGroupMsgLastTs === 0) {
            area.innerHTML = '<div class="mob-empty" style="padding:40px 0"><i class="fas fa-comments"></i> No messages yet</div>';
            return;
        }
        if (msgs.length === 0) return;

        if (area.querySelector('.mob-empty')) area.innerHTML = '';
        _mobGroupMsgLastTs = Math.max(...msgs.map(m => m.timestamp || 0));

        msgs.forEach(m => {
            const isMine = m.sender_id === _p2pDeviceId;
            const div = document.createElement('div');
            div.className = 'mob-group-msg ' + (isMine ? 'mine' : 'theirs');
            let content = '';
            if (!isMine) content += `<div class="mob-group-msg-sender">${escapeHtml(m.sender_name || 'Unknown')} ${mobVBadge(m.sender_id)}</div>`;
            if (m.media_data && m.media_type) {
                if (m.media_type.startsWith('image/')) {
                    content += `<img src="${m.media_data}" class="mob-group-msg-img" onclick="window.open(this.src)">`;
                } else if (m.media_type.startsWith('audio')) {
                    content += `<audio controls src="${m.media_data}" style="max-width:100%;border-radius:8px"></audio>`;
                } else if (m.media_type.startsWith('video')) {
                    content += `<video controls src="${m.media_data}" style="max-width:100%;border-radius:8px"></video>`;
                } else {
                    content += `<div style="padding:6px 0"><i class="fas fa-file"></i> ${escapeHtml(m.file_name || 'File')}</div>`;
                }
            }
            if (m.text) content += `<div class="mob-group-msg-text">${escapeHtml(m.text)}</div>`;
            const time = new Date(m.timestamp * 1000);
            const tStr = time.getHours().toString().padStart(2,'0') + ':' + time.getMinutes().toString().padStart(2,'0');
            content += `<div class="mob-group-msg-time">${tStr}</div>`;
            div.innerHTML = content;
            area.appendChild(div);
        });
        area.scrollTop = area.scrollHeight;
    } catch(e) { console.error('mobLoadGroupMessages', e); }
}

async function mobSendGroupMessage() {
    const input = document.getElementById('mobGroupInput');
    const text = (input.value || '').trim();
    if (!text || !_mobCurrentGroupId) return;
    input.value = '';
    try {
        await fetch('/api/groups/' + _mobCurrentGroupId + '/messages', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ sender_id: _p2pDeviceId, sender_name: _p2pName, text: text })
        });
        mobLoadGroupMessages();
    } catch(e) { mobShowToast('Failed to send', 'error'); }
}

// ── Mobile group file upload ──
async function mobHandleGroupFileUpload(event) {
    const files = event.target.files;
    if (!files.length || !_mobCurrentGroupId) return;
    for (const file of files) {
        if (file.size > 50 * 1024 * 1024) { mobShowToast('File too large: ' + file.name, 'error'); continue; }
        const reader = new FileReader();
        reader.onload = async () => {
            const base64Data = reader.result.split(',')[1];
            const fileType = file.type || 'application/octet-stream';
            await fetch('/api/groups/' + _mobCurrentGroupId + '/messages', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    sender_id: _p2pDeviceId,
                    sender_name: _p2pName,
                    text: `📎 ${file.name}`,
                    media_type: fileType,
                    media_data: base64Data,
                    file_name: file.name
                })
            }).catch(e => console.error('Failed to send group file:', e));
            mobLoadGroupMessages();
        };
        reader.readAsDataURL(file);
    }
    event.target.value = '';
}

// ── Mobile group voice recording ──
let _mobGrpMediaRecorder = null;
let _mobGrpAudioChunks = [];
let _mobGrpRecordingStartTime = null;
let _mobGrpRecordingTimer = null;
let _mobGrpRecordingMimeType = 'audio/webm';

async function mobStartGroupVoiceRecord() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('Microphone API not available'); return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!window.MediaRecorder) { stream.getTracks().forEach(t => t.stop()); alert('MediaRecorder not supported'); return; }
        const types = ['audio/mp4','audio/aac','audio/webm;codecs=opus','audio/webm','audio/ogg'];
        let bestMime = '';
        for (const t of types) { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) { bestMime = t; break; } }
        _mobGrpRecordingMimeType = bestMime || 'audio/webm';
        _mobGrpMediaRecorder = bestMime ? new MediaRecorder(stream, { mimeType: bestMime }) : new MediaRecorder(stream);
        _mobGrpAudioChunks = [];
        _mobGrpRecordingStartTime = Date.now();
        _mobGrpMediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) _mobGrpAudioChunks.push(e.data); };
        _mobGrpMediaRecorder.onerror = () => { document.getElementById('mobGroupVoiceRecorderOverlay').style.display = 'none'; };
        _mobGrpMediaRecorder.start();
        document.getElementById('mobGroupVoiceRecorderOverlay').style.display = 'flex';
        _mobGrpRecordingTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - _mobGrpRecordingStartTime) / 1000);
            document.getElementById('mobGroupRecordingTime').textContent = `${Math.floor(elapsed/60)}:${(elapsed%60).toString().padStart(2,'0')}`;
        }, 1000);
    } catch(err) {
        let msg = 'Unable to access microphone.';
        if (err.name === 'NotAllowedError') msg = 'Microphone permission denied.';
        else if (err.name === 'NotFoundError') msg = 'No microphone found.';
        alert(msg);
    }
}

function mobCancelGroupVoiceRecord() {
    if (_mobGrpMediaRecorder && _mobGrpMediaRecorder.state !== 'inactive') {
        _mobGrpMediaRecorder.stop();
        _mobGrpMediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
    if (_mobGrpRecordingTimer) clearInterval(_mobGrpRecordingTimer);
    _mobGrpAudioChunks = [];
    document.getElementById('mobGroupVoiceRecorderOverlay').style.display = 'none';
    document.getElementById('mobGroupRecordingTime').textContent = '0:00';
}

async function mobSendGroupVoiceRecord() {
    if (_mobGrpRecordingTimer) clearInterval(_mobGrpRecordingTimer);
    const duration = Math.floor((Date.now() - _mobGrpRecordingStartTime) / 1000);
    const stopPromise = new Promise(resolve => { _mobGrpMediaRecorder.onstop = resolve; });
    _mobGrpMediaRecorder.stop();
    await stopPromise;
    _mobGrpMediaRecorder.stream.getTracks().forEach(t => t.stop());
    const audioBlob = new Blob(_mobGrpAudioChunks, { type: _mobGrpRecordingMimeType });
    const reader = new FileReader();
    reader.onload = async () => {
        const base64Audio = reader.result.split(',')[1];
        await fetch('/api/groups/' + _mobCurrentGroupId + '/messages', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                text: `🎙️ Voice message (${Math.floor(duration/60)}:${(duration%60).toString().padStart(2,'0')})`,
                sender_id: _p2pDeviceId,
                sender_name: _p2pName,
                media_type: _mobGrpRecordingMimeType,
                media_data: base64Audio
            })
        }).catch(e => console.error('Failed to send group voice:', e));
        _mobGrpAudioChunks = [];
        document.getElementById('mobGroupVoiceRecorderOverlay').style.display = 'none';
        document.getElementById('mobGroupRecordingTime').textContent = '0:00';
        mobLoadGroupMessages();
    };
    reader.readAsDataURL(audioBlob);
}

function mobOpenCreateGroup() {
    document.getElementById('mobCreateGroupModal').style.display = 'flex';
    mobLoadGroupDevicePicker();
}
function mobCloseCreateGroup() { document.getElementById('mobCreateGroupModal').style.display = 'none'; }

async function mobLoadGroupDevicePicker() {
    try {
        const res = await fetch('/api/p2p/devices');
        const data = await res.json();
        const devs = Array.isArray(data) ? data : (data.devices || []);
        const others = devs.filter(d => (d.id || d.device_id) !== _p2pDeviceId);
        const el = document.getElementById('mobNewGroupDevices');
        if (!el) return;
        if (others.length === 0) { el.innerHTML = '<div class="mob-muted">No devices online</div>'; return; }
        el.innerHTML = others.map(d => {
            const id = d.id || d.device_id;
            const name = d.name || 'Unknown';
            return `<label class="mob-member-pick-item">
                <input type="checkbox" value="${id}" data-name="${escapeHtml(name)}">
                <span><i class="fas fa-user"></i> ${escapeHtml(name)}</span>
            </label>`;
        }).join('');
    } catch(e) {}
}

async function mobCreateGroup() {
    const name = (document.getElementById('mobNewGroupName').value || '').trim();
    if (!name) { mobShowToast('Enter group name', 'error'); return; }
    const desc = (document.getElementById('mobNewGroupDesc').value || '').trim();
    const checks = document.querySelectorAll('#mobNewGroupDevices input[type="checkbox"]:checked');
    const members = [_p2pDeviceId];
    checks.forEach(c => members.push(c.value));
    try {
        const res = await fetch('/api/groups', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name, description: desc, creator_id: _p2pDeviceId, members })
        });
        const data = await res.json();
        if (data.success) { mobShowToast('Group created!', 'success'); mobCloseCreateGroup(); mobLoadGroupsList(); }
        else { mobShowToast(data.error || 'Failed', 'error'); }
    } catch(e) { mobShowToast('Failed', 'error'); }
}

function mobOpenGroupInfo() {
    if (!_mobCurrentGroupData) return;
    const g = _mobCurrentGroupData;
    document.getElementById('mobGroupInfoName').textContent = g.name || 'Group';
    document.getElementById('mobGroupInfoDesc').textContent = g.description || '';
    const el = document.getElementById('mobGroupInfoMembers');
    el.innerHTML = (g.members || []).map(m => {
        const isAdmin = (g.admins || []).includes(m);
        return `<div class="mob-group-member-item"><i class="fas fa-user"></i> <span>${escapeHtml(m)}</span>${isAdmin ? ' <span class="mob-admin-badge">Admin</span>' : ''}</div>`;
    }).join('');
    // Show delete button only for creator
    const isCreator = g.creator_id === _p2pDeviceId;
    document.getElementById('mobGroupInfoDeleteBtn').style.display = isCreator ? '' : 'none';
    document.getElementById('mobGroupInfoModal').style.display = 'flex';
}
function mobCloseGroupInfo() { document.getElementById('mobGroupInfoModal').style.display = 'none'; }

async function mobLeaveGroup() {
    if (!_mobCurrentGroupId || !confirm('Leave this group?')) return;
    try {
        await fetch('/api/groups/' + _mobCurrentGroupId + '/members/' + _p2pDeviceId, { method: 'DELETE' });
        mobShowToast('Left group', 'success');
        mobCloseGroupInfo(); mobCloseGroupChat();
    } catch(e) { mobShowToast('Failed', 'error'); }
}

async function mobDeleteGroup() {
    if (!_mobCurrentGroupId || !confirm('Are you sure you want to permanently delete this group? This cannot be undone.')) return;
    try {
        const res = await fetch('/api/groups/' + _mobCurrentGroupId + '?device_id=' + _p2pDeviceId, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            mobShowToast('Group deleted', 'success');
            mobCloseGroupInfo(); mobCloseGroupChat();
            mobLoadGroupsList();
        } else {
            mobShowToast(data.error || 'Failed to delete group', 'error');
        }
    } catch(e) { mobShowToast('Failed to delete group', 'error'); }
}


// ═══════════════════════════════════════════════════════════════
// GROUP CALLS — Mobile Browser (Mesh WebRTC)
// ═══════════════════════════════════════════════════════════════

let _mobGrpCallId = null;
let _mobGrpCallType = 'audio';
let _mobGrpLocalStream = null;
let _mobGrpPeers = {};        // { deviceId: { pc, remoteStream } }
let _mobGrpCallTimer = null;
let _mobGrpCallSecs = 0;
let _mobGrpSignalPoll = null;

async function mobStartGroupCall(callType) {
    if (!_mobCurrentGroupId || !_mobCurrentGroupData) {
        mobShowToast('Open a group first', 'error'); return;
    }
    if (_mobGrpCallId) {
        mobShowToast('Already in a group call', 'info'); return;
    }

    const members = (_mobCurrentGroupData.members || []).filter(m => m !== _p2pDeviceId);
    if (members.length === 0) {
        mobShowToast('No other members in this group', 'error'); return;
    }

    try {
        const res = await fetch('/api/calls/initiate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                initiator_id: _p2pDeviceId,
                initiator_name: _p2pName,
                target_ids: members,
                call_type: callType,
                group_id: _mobCurrentGroupId
            })
        });
        const data = await res.json();
        if (!data.call_id) { mobShowToast(data.error || 'Failed', 'error'); return; }

        _mobGrpCallId = data.call_id;
        _mobGrpCallType = callType;
        await _mobGrpSetupLocal(callType);
        _mobGrpShowOverlay();
        _mobGrpStartSignalPoll();
        _mobGrpAddLocalTile();
        mobShowToast('Group call started', 'info');
    } catch (e) {
        console.error('[GrpCall] initiate error:', e);
        mobShowToast('Failed to start group call', 'error');
    }
}

async function mobJoinGroupCall(callId, callType) {
    // If same call, skip; if stale leftover, clean up first
    if (_mobGrpCallId === callId) { mobShowToast('Already in this call', 'info'); return; }
    if (_mobGrpCallId) { await mobGrpEndCall(); }

    try {
        const res = await fetch('/api/calls/' + callId + '/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: _p2pDeviceId, device_name: _p2pName })
        });
        const data = await res.json();
        if (!data.success) { mobShowToast(data.error || 'Failed', 'error'); return; }

        _mobGrpCallId = callId;
        _mobGrpCallType = callType;
        await _mobGrpSetupLocal(callType);
        _mobGrpShowOverlay();
        _mobGrpStartSignalPoll();
        _mobGrpAddLocalTile();

        // Create peer connections to all already-connected members
        for (const peerId of (data.connected || [])) {
            if (peerId !== _p2pDeviceId) {
                await _mobGrpConnectPeer(peerId, true);
            }
        }
        mobShowToast('Joined group call', 'info');
    } catch (e) {
        console.error('[GrpCall] join error:', e);
        mobShowToast('Failed to join', 'error');
    }
}

async function _mobGrpSetupLocal(callType) {
    _mobGrpLocalStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video'
    });
}

function _mobGrpShowOverlay() {
    const overlay = document.getElementById('mobGroupCallOverlay');
    if (overlay) overlay.style.display = 'flex';
    const title = document.getElementById('mobGroupCallTitle');
    if (title) title.textContent = (_mobCurrentGroupData ? _mobCurrentGroupData.name : 'Group') + ' Call';

    _mobGrpCallSecs = 0;
    if (_mobGrpCallTimer) clearInterval(_mobGrpCallTimer);
    _mobGrpCallTimer = setInterval(() => {
        _mobGrpCallSecs++;
        const m = String(Math.floor(_mobGrpCallSecs / 60)).padStart(2, '0');
        const s = String(_mobGrpCallSecs % 60).padStart(2, '0');
        const el = document.getElementById('mobGroupCallTimer');
        if (el) el.textContent = m + ':' + s;
    }, 1000);
}

function _mobGrpAddLocalTile() {
    const grid = document.getElementById('mobGroupCallGrid');
    if (!grid) return;
    // Remove existing local tile if any
    const old = document.getElementById('mobGrpTile_local');
    if (old) old.remove();
    const tile = document.createElement('div');
    tile.className = 'mob-grp-call-tile';
    tile.id = 'mobGrpTile_local';
    const hasVideo = _mobGrpLocalStream && _mobGrpLocalStream.getVideoTracks().length > 0
        && _mobGrpLocalStream.getVideoTracks()[0].enabled;
    console.log('[GrpCall] Local tile — hasVideo:', hasVideo, 'callType:', _mobGrpCallType);
    if (hasVideo) {
        const vid = document.createElement('video');
        vid.id = 'mobGrpLocalVideo';
        vid.srcObject = _mobGrpLocalStream;
        vid.autoplay = true; vid.playsInline = true; vid.muted = true;
        tile.appendChild(vid);
    } else {
        tile.innerHTML = '<div class="mob-grp-call-tile-avatar"><div class="avatar-circle"><i class="fas fa-user"></i></div></div>';
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'mob-grp-call-tile-name';
    nameEl.textContent = 'You';
    tile.appendChild(nameEl);
    grid.appendChild(tile);
    _mobGrpUpdateGridLayout();
}

function _mobGrpAddRemoteTile(peerId, stream) {
    const grid = document.getElementById('mobGroupCallGrid');
    if (!grid) return;
    // Remove existing tile
    const old = document.getElementById('mobGrpTile_' + peerId);
    if (old) old.remove();

    const tile = document.createElement('div');
    tile.className = 'mob-grp-call-tile';
    tile.id = 'mobGrpTile_' + peerId;

    const hasEnabledVideo = stream && stream.getVideoTracks().length > 0
        && stream.getVideoTracks().some(t => t.enabled && !t.muted);
    if (hasEnabledVideo) {
        const vid = document.createElement('video');
        vid.srcObject = stream;
        vid.autoplay = true; vid.playsInline = true;
        tile.appendChild(vid);
        vid.play().catch(e => console.warn('[GrpCall] video play:', e));
    } else {
        tile.innerHTML = '<div class="mob-grp-call-tile-avatar"><div class="avatar-circle"><i class="fas fa-user"></i></div></div>';
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
    nameEl.className = 'mob-grp-call-tile-name';
    nameEl.textContent = peerId.substring(0, 10);
    tile.appendChild(nameEl);
    grid.appendChild(tile);
    _mobGrpUpdateGridLayout();
}

function _mobGrpRemoveTile(peerId) {
    const tile = document.getElementById('mobGrpTile_' + peerId);
    if (tile) tile.remove();
    _mobGrpUpdateGridLayout();
}

function _mobGrpUpdateGridLayout() {
    const grid = document.getElementById('mobGroupCallGrid');
    if (!grid) return;
    const count = grid.children.length;
    grid.classList.remove('cols-1', 'cols-3');
    if (count <= 1) grid.classList.add('cols-1');
    else if (count >= 3) grid.classList.add('cols-3');
}

async function _mobGrpConnectPeer(peerId, isInitiator) {
    if (_mobGrpPeers[peerId]) return; // already connected

    const pc = new RTCPeerConnection(_mobRtcConfig);
    _mobGrpPeers[peerId] = { pc: pc, remoteStream: null };

    // Add local tracks
    if (_mobGrpLocalStream) {
        _mobGrpLocalStream.getTracks().forEach(t => pc.addTrack(t, _mobGrpLocalStream));
    }

    // Handle remote stream
    pc.ontrack = (event) => {
        console.log('[GrpCall] Remote track from', peerId, event.track.kind);
        const peer = _mobGrpPeers[peerId];
        if (peer) {
            peer.remoteStream = event.streams[0];
            _mobGrpAddRemoteTile(peerId, event.streams[0]);
        }
    };

    // ICE
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            fetch('/api/calls/signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from_id: _p2pDeviceId, to_id: peerId,
                    signal_type: 'ice-candidate', call_id: _mobGrpCallId,
                    payload: event.candidate.toJSON()
                })
            }).catch(e => console.error('[GrpCall] ICE signal error:', e));
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log('[GrpCall] ICE state for', peerId, ':', pc.iceConnectionState);
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            _mobGrpDisconnectPeer(peerId);
        }
    };

    // If we're the initiator, create and send offer
    if (isInitiator) {
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await fetch('/api/calls/signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from_id: _p2pDeviceId, to_id: peerId,
                    signal_type: 'offer', call_id: _mobGrpCallId,
                    payload: { type: offer.type, sdp: offer.sdp }
                })
            });
            console.log('[GrpCall] Sent offer to', peerId);
        } catch (e) {
            console.error('[GrpCall] Offer error:', e);
        }
    }
}

function _mobGrpDisconnectPeer(peerId) {
    const peer = _mobGrpPeers[peerId];
    if (peer) {
        if (peer.pc) { try { peer.pc.close(); } catch(e) {} }
        delete _mobGrpPeers[peerId];
    }
    _mobGrpRemoveTile(peerId);
}

function _mobGrpStartSignalPoll() {
    if (_mobGrpSignalPoll) clearInterval(_mobGrpSignalPoll);
    _mobGrpSignalPoll = setInterval(async () => {
        if (!_mobGrpCallId) { clearInterval(_mobGrpSignalPoll); return; }
        try {
            const res = await fetch('/api/calls/signals/' + _p2pDeviceId);
            const data = await res.json();
            for (const signal of (data.signals || [])) {
                if (signal.call_id !== _mobGrpCallId) continue;
                const fromId = signal.from_id;

                if (signal.type === 'offer') {
                    // Incoming offer from a peer — create connection and answer
                    if (!_mobGrpPeers[fromId]) {
                        await _mobGrpConnectPeer(fromId, false);
                    }
                    const peer = _mobGrpPeers[fromId];
                    if (peer && peer.pc) {
                        await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
                        const answer = await peer.pc.createAnswer();
                        await peer.pc.setLocalDescription(answer);
                        await fetch('/api/calls/signal', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                from_id: _p2pDeviceId, to_id: fromId,
                                signal_type: 'answer', call_id: _mobGrpCallId,
                                payload: { type: answer.type, sdp: answer.sdp }
                            })
                        });
                        console.log('[GrpCall] Sent answer to', fromId);
                    }
                } else if (signal.type === 'answer') {
                    const peer = _mobGrpPeers[fromId];
                    if (peer && peer.pc && peer.pc.signalingState === 'have-local-offer') {
                        await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
                        console.log('[GrpCall] Answer received from', fromId);
                    }
                } else if (signal.type === 'ice-candidate') {
                    const peer = _mobGrpPeers[fromId];
                    if (peer && peer.pc) {
                        try {
                            await peer.pc.addIceCandidate(new RTCIceCandidate(signal.payload));
                        } catch(e) { console.warn('[GrpCall] ICE error:', e); }
                    }
                } else if (signal.type === 'group-call-join') {
                    console.log('[GrpCall] Peer joined:', fromId);
                    mobShowToast((signal.from_name || 'Someone') + ' joined the call', 'info');
                    // The new peer will send us an offer, or we send them one
                    if (!_mobGrpPeers[fromId]) {
                        await _mobGrpConnectPeer(fromId, true);
                    }
                } else if (signal.type === 'group-call-leave') {
                    console.log('[GrpCall] Peer left:', fromId);
                    mobShowToast('Someone left the call', 'info');
                    _mobGrpDisconnectPeer(fromId);
                } else if (signal.type === 'call-end') {
                    console.log('[GrpCall] Call ended');
                    mobShowToast('Group call ended', 'info');
                    _mobGrpCallId = null;
                    mobGrpEndCall();
                    return;
                }
            }
        } catch (e) { console.error('[GrpCall] Signal poll error:', e); }
    }, 800);
}

function mobGrpToggleMute() {
    if (!_mobGrpLocalStream) return;
    const track = _mobGrpLocalStream.getAudioTracks()[0];
    if (track) {
        track.enabled = !track.enabled;
        const btn = document.getElementById('mobGrpBtnMute');
        if (btn) {
            btn.innerHTML = track.enabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
            btn.classList.toggle('active', !track.enabled);
        }
    }
}

function mobGrpToggleCamera() {
    if (!_mobGrpLocalStream) return;
    const track = _mobGrpLocalStream.getVideoTracks()[0];
    if (track) {
        track.enabled = !track.enabled;
        const btn = document.getElementById('mobGrpBtnCamera');
        if (btn) {
            btn.innerHTML = track.enabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
            btn.classList.toggle('active', !track.enabled);
        }
        // Update local tile to show/hide video
        _mobGrpAddLocalTile();
    }
}

async function mobGrpEndCall() {
    // Leave the call
    if (_mobGrpCallId) {
        try {
            await fetch('/api/calls/' + _mobGrpCallId + '/leave', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: _p2pDeviceId })
            });
        } catch(e) {}
    }

    // Close all peer connections
    for (const peerId of Object.keys(_mobGrpPeers)) {
        _mobGrpDisconnectPeer(peerId);
    }
    _mobGrpPeers = {};

    // Stop local stream
    if (_mobGrpLocalStream) {
        _mobGrpLocalStream.getTracks().forEach(t => t.stop());
        _mobGrpLocalStream = null;
    }

    // Stop signal polling
    if (_mobGrpSignalPoll) { clearInterval(_mobGrpSignalPoll); _mobGrpSignalPoll = null; }
    if (_mobGrpCallTimer) { clearInterval(_mobGrpCallTimer); _mobGrpCallTimer = null; }

    _mobGrpCallId = null;
    _mobGrpCallSecs = 0;

    // Hide overlay
    const overlay = document.getElementById('mobGroupCallOverlay');
    if (overlay) overlay.style.display = 'none';
    const grid = document.getElementById('mobGroupCallGrid');
    if (grid) grid.innerHTML = '';

    // Reset buttons
    const muteBtn = document.getElementById('mobGrpBtnMute');
    if (muteBtn) { muteBtn.innerHTML = '<i class="fas fa-microphone"></i>'; muteBtn.classList.remove('active'); }
    const camBtn = document.getElementById('mobGrpBtnCamera');
    if (camBtn) { camBtn.innerHTML = '<i class="fas fa-video"></i>'; camBtn.classList.remove('active'); }

    mobShowToast('Left group call', 'info');
}

// Check for active group call when opening group chat
async function mobCheckActiveGroupCall() {
    if (!_mobCurrentGroupId) return;
    try {
        const res = await fetch('/api/calls/group/active/' + _mobCurrentGroupId);
        const data = await res.json();
        if (data.active && data.call_id !== _mobGrpCallId) {
            // Show "join call" banner
            _mobGrpShowJoinBanner(data);
        }
    } catch(e) {}
}

function _mobGrpShowJoinBanner(data) {
    // Remove old banner
    const oldBanner = document.getElementById('mobGrpCallBanner');
    if (oldBanner) oldBanner.remove();

    const panel = document.getElementById('mobGroupChatPanel');
    if (!panel) return;
    const overlay = document.getElementById('mobGroupCallOverlay');

    const banner = document.createElement('div');
    banner.className = 'mob-grp-call-banner';
    banner.id = 'mobGrpCallBanner';
    banner.innerHTML = `
        <div class="mob-grp-call-banner-info">
            <i class="fas fa-phone-alt"></i>
            <span>${(data.connected || []).length} in call</span>
        </div>
        <button class="mob-grp-call-join-btn" onclick="mobJoinGroupCall('${data.call_id}','${data.call_type}')">
            Join
        </button>`;
    // Insert before the overlay or messages
    if (overlay) overlay.parentNode.insertBefore(banner, overlay);
    else panel.insertBefore(banner, panel.querySelector('.mob-group-messages'));
}


// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// BEAM AI — Mobile Browser
// ═══════════════════════════════════════════════════════════════

let _mobAiToolType = null;

/* Back button — return to previous view (default: share) */
function mobAiGoBack() {
    const prev = window._mobPrevView || 'share';
    const tabMap = { share: 0, chat: 1, calls: 2, groups: 3, account: 4 };
    const idx = tabMap[prev];
    const tabs = document.querySelectorAll('.btm-tab');
    if (idx !== undefined && tabs[idx]) {
        switchView(prev, tabs[idx]);
    } else {
        switchView('share', tabs[0]);
    }
}

function mobInitBots() {
    mobLoadBotsList();
    mobLoadAiTasks();
    mobLoadAiReminders();
    mobLoadAiDelegation();
}

// ─── Mobile Pause/Resume state for AI typing ───
let _mobAiTypingPaused = false;
let _mobAiTypingAborted = false;

function mobAiTogglePause() {
    _mobAiTypingPaused = !_mobAiTypingPaused;
    const btn = document.getElementById('mobAiPauseBtn');
    if (btn) {
        if (_mobAiTypingPaused) {
            btn.innerHTML = '<i class="fas fa-play"></i>';
            btn.title = 'Resume';
            btn.classList.add('paused');
            // Pause audio too
            if (_mobAiCurrentAudio && !_mobAiCurrentAudio.paused) {
                try { _mobAiCurrentAudio.pause(); } catch(e) {}
            }
        } else {
            btn.innerHTML = '<i class="fas fa-pause"></i>';
            btn.title = 'Pause';
            btn.classList.remove('paused');
            // Resume audio too
            if (_mobAiCurrentAudio && _mobAiCurrentAudio.paused) {
                try { _mobAiCurrentAudio.play(); } catch(e) {}
            }
        }
    }
}

// ─── Mobile Highlight-Ask Popup ───
let _mobAiHighlightPopup = null;
function _mobAiInitHighlightAsk() {
    const area = document.getElementById('mobAiChatMessages');
    if (!area) return;
    area.addEventListener('mouseup', _mobHandleHighlightEvent);
    area.addEventListener('touchend', (e) => setTimeout(() => _mobHandleHighlightEvent(e), 200));
}

function _mobHandleHighlightEvent(e) {
    const sel = window.getSelection();
    const selectedText = sel.toString().trim();
    if (_mobAiHighlightPopup) { _mobAiHighlightPopup.remove(); _mobAiHighlightPopup = null; }
    if (!selectedText || selectedText.length < 3) return;
    const bubble = e.target.closest('.mob-ai-msg.bot .mob-ai-bubble');
    if (!bubble) return;
    const fullContext = bubble.textContent || '';
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const popup = document.createElement('div');
    popup.className = 'mob-ai-highlight-popup';
    popup.innerHTML = `
        <div class="mob-ai-hl-header"><i class="fas fa-quote-left"></i> "${selectedText.length > 50 ? selectedText.slice(0,47)+'...' : selectedText}"</div>
        <input class="mob-ai-hl-input" type="text" placeholder="Ask about this...">
        <div class="mob-ai-hl-actions">
            <button class="mob-ai-hl-btn ask"><i class="fas fa-paper-plane"></i></button>
            <button class="mob-ai-hl-btn explain"><i class="fas fa-lightbulb"></i></button>
            <button class="mob-ai-hl-btn deeper"><i class="fas fa-search-plus"></i></button>
            <button class="mob-ai-hl-btn close"><i class="fas fa-times"></i></button>
        </div>`;
    popup.style.position = 'fixed';
    popup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 300)) + 'px';
    popup.style.top = Math.max(8, rect.top - 130) + 'px';
    document.body.appendChild(popup);
    _mobAiHighlightPopup = popup;

    const input = popup.querySelector('.mob-ai-hl-input');
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && input.value.trim()) {
            _mobAiSendHighlightQuestion(selectedText, input.value.trim(), fullContext);
            popup.remove(); _mobAiHighlightPopup = null;
        }
        if (ev.key === 'Escape') { popup.remove(); _mobAiHighlightPopup = null; }
    });
    popup.querySelector('.ask').onclick = () => {
        const q = input.value.trim() || `Tell me more about: "${selectedText}"`;
        _mobAiSendHighlightQuestion(selectedText, q, fullContext);
        popup.remove(); _mobAiHighlightPopup = null;
    };
    popup.querySelector('.explain').onclick = () => {
        _mobAiSendHighlightQuestion(selectedText, `Explain this in detail: "${selectedText}"`, fullContext);
        popup.remove(); _mobAiHighlightPopup = null;
    };
    popup.querySelector('.deeper').onclick = () => {
        _mobAiSendHighlightQuestion(selectedText, `Go deeper on this topic: "${selectedText}"`, fullContext);
        popup.remove(); _mobAiHighlightPopup = null;
    };
    popup.querySelector('.close').onclick = () => { popup.remove(); _mobAiHighlightPopup = null; };
}

async function _mobAiSendHighlightQuestion(highlighted, question, contextFrom) {
    const area = document.getElementById('mobAiChatMessages');
    if (!area) return;
    area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg user">
        <div class="mob-ai-avatar"><i class="fas fa-user"></i></div>
        <div class="mob-ai-bubble">
            <div class="mob-ai-highlight-ref"><i class="fas fa-quote-left"></i> ${escapeHtml(highlighted.length > 80 ? highlighted.slice(0,77)+'...' : highlighted)}</div>
            ${escapeHtml(question)}
        </div></div>`);
    const typingId = 'mob-ai-typing-' + Date.now();
    area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg bot" id="${typingId}">
        <div class="mob-ai-avatar"><i class="fas fa-robot"></i></div>
        <div class="mob-ai-bubble"><div class="mob-ai-typing"><span></span><span></span><span></span></div></div></div>`);
    area.scrollTop = area.scrollHeight;
    try {
        const res = await fetch('/api/ai/chat', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ device_id: _p2pDeviceId, device_name: _p2pName, message: question, highlighted_text: highlighted, context_from: contextFrom })
        });
        const data = await res.json();
        const typEl = document.getElementById(typingId);
        if (typEl) typEl.remove();
        const reply = data.reply || 'No response';
        const msgDiv = document.createElement('div');
        msgDiv.className = 'mob-ai-msg bot';
        msgDiv.innerHTML = `<div class="mob-ai-avatar"><i class="fas fa-robot"></i></div><div class="mob-ai-bubble"></div>`;
        area.appendChild(msgDiv);
        const bubble = msgDiv.querySelector('.mob-ai-bubble');
        const pauseBtn = document.createElement('button');
        pauseBtn.id = 'mobAiPauseBtn';
        pauseBtn.className = 'mob-ai-pause-btn';
        pauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
        pauseBtn.onclick = mobAiTogglePause;
        bubble.appendChild(pauseBtn);
        await mobTypeWords(bubble, reply, area, 20);
        pauseBtn.remove();
        _mobAiAddVoicePlayback(bubble, reply);
        area.scrollTop = area.scrollHeight;
    } catch(e) {
        const typEl = document.getElementById(typingId);
        if (typEl) typEl.remove();
        area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg bot"><div class="mob-ai-avatar"><i class="fas fa-robot"></i></div><div class="mob-ai-bubble" style="color:#EF4444">Connection error.</div></div>`);
    }
}

setTimeout(_mobAiInitHighlightAsk, 1000);

// ─── On page load: keep chat clean (AI remembers via server-side history) ───
async function _mobAiLoadHistory() {
    // Don't render old messages — start fresh each time.
    // The backend already passes conversation history to the AI as context,
    // so it remembers everything. User can tap History button to view past chats.
}

// ─── Show past conversation history on demand ───
let _mobAiHistoryVisible = false;
async function mobAiShowHistory() {
    const area = document.getElementById('mobAiChatMessages');
    if (!area) return;

    // Toggle: if history is showing, clear it back to welcome
    if (_mobAiHistoryVisible) {
        area.innerHTML = `<div class="mob-ai-msg bot"><div class="mob-ai-avatar"><i class="fas fa-brain"></i></div><div class="mob-ai-bubble">Hey! I'm <strong>BEAM AI</strong>. Ask me anything — I can search the web, set reminders, analyze files, and much more.</div></div>`;
        _mobAiHistoryVisible = false;
        mobShowToast('History hidden', 'info');
        return;
    }

    if (!_p2pDeviceId) { mobShowToast('Not connected', 'error'); return; }
    try {
        const res = await fetch(`/api/ai/chat-history?device_id=${encodeURIComponent(_p2pDeviceId)}&limit=50`);
        const data = await res.json();
        if (!data.success || !data.messages || !data.messages.length) {
            mobShowToast('No conversation history yet', 'info');
            return;
        }
        // Show a divider then render history above current messages
        const currentHTML = area.innerHTML;
        area.innerHTML = '';
        // History header
        area.insertAdjacentHTML('beforeend', `<div style="text-align:center;padding:10px;color:#64748B;font-size:11px;border-bottom:1px solid rgba(100,116,139,0.2);margin-bottom:8px"><i class="fas fa-history" style="margin-right:4px"></i> Past Conversations (${data.messages.length} messages)</div>`);
        for (const msg of data.messages) {
            const isUser = msg.role === 'user';
            const time = msg.timestamp ? new Date(msg.timestamp * 1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
            if (isUser) {
                area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg user" style="opacity:0.7"><div class="mob-ai-avatar"><i class="fas fa-user"></i></div><div class="mob-ai-bubble">${escapeHtml(msg.content)}<div style="font-size:9px;color:#64748B;margin-top:3px">${time}</div></div></div>`);
            } else {
                let html = escapeHtml(msg.content).replace(/\n/g, '<br>');
                html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg bot" style="opacity:0.7"><div class="mob-ai-avatar"><i class="fas fa-robot"></i></div><div class="mob-ai-bubble">${html}<div style="font-size:9px;color:#64748B;margin-top:3px">${time}</div></div></div>`);
            }
        }
        // Divider before current session
        area.insertAdjacentHTML('beforeend', `<div style="text-align:center;padding:10px;color:#667EEA;font-size:11px;border-top:1px solid rgba(100,116,139,0.2);margin-top:8px"><i class="fas fa-comment-dots" style="margin-right:4px"></i> Current Session</div>`);
        area.scrollTop = area.scrollHeight;
        _mobAiHistoryVisible = true;
        mobShowToast('Showing conversation history', 'success');
    } catch(e) {
        console.log('Could not load AI chat history:', e);
        mobShowToast('Failed to load history', 'error');
    }
}

/**
 * Word-by-word typing with pause/resume support (mobile)
 */
function mobTypeWords(bubbleEl, text, scrollContainer, speed = 40) {
    _mobAiTypingPaused = false;
    _mobAiTypingAborted = false;
    return new Promise(resolve => {
        const words = text.split(/(\s+)/);
        let i = 0;
        // Preserve any existing children (like pause button)
        const existingChildren = Array.from(bubbleEl.childNodes).filter(n => n.nodeType === 1 && n.classList && n.classList.contains('mob-ai-pause-btn'));
        bubbleEl.textContent = '';
        existingChildren.forEach(c => bubbleEl.appendChild(c));
        const cursor = document.createElement('span');
        cursor.className = 'mob-ai-cursor';
        cursor.textContent = '▊';
        bubbleEl.insertBefore(cursor, existingChildren[0] || null);
        function nextWord() {
            if (_mobAiTypingAborted) {
                if (cursor.parentNode) cursor.remove();
                // Set final text preserving existing buttons
                const btns = Array.from(bubbleEl.childNodes).filter(n => n.nodeType === 1 && n.classList && (n.classList.contains('mob-ai-pause-btn') || n.classList.contains('ai-voice-btn')));
                let html = escapeHtml(text).replace(/\n/g, '<br>');
                html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                bubbleEl.innerHTML = html;
                btns.forEach(b => bubbleEl.appendChild(b));
                resolve();
                return;
            }
            if (_mobAiTypingPaused) {
                requestAnimationFrame(() => setTimeout(nextWord, 100));
                return;
            }
            if (i >= words.length) {
                if (cursor.parentNode) cursor.remove();
                // Apply markdown formatting to final text
                const btns = Array.from(bubbleEl.childNodes).filter(n => n.nodeType === 1 && n.classList && (n.classList.contains('mob-ai-pause-btn') || n.classList.contains('ai-voice-btn')));
                let html = escapeHtml(bubbleEl.textContent).replace(/\n/g, '<br>');
                html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                bubbleEl.innerHTML = html;
                btns.forEach(b => bubbleEl.appendChild(b));
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

// ─── Mobile AI Neural Voice Playback (Listen Button) ───
let _mobAiCurrentAudio = null;

function _mobAiAddVoicePlayback(bubbleEl, text, preloadedAudio, audioFormat, autoPlay) {
    if (!bubbleEl || !text) return;
    const btnId = 'mob-ai-voice-' + Date.now() + Math.random().toString(36).slice(2,6);
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
        if (_mobAiCurrentAudio) {
            try { _mobAiCurrentAudio.pause(); _mobAiCurrentAudio.currentTime = 0; } catch(e) {}
            _mobAiCurrentAudio = null;
        }
        // If we already have audio loaded, toggle play
        if (audioEl) {
            if (audioEl.paused) {
                voiceBtn.innerHTML = `<i class="fas fa-pause"></i> <span>Playing...</span>`;
                voiceBtn.classList.add('playing');
                _mobAiCurrentAudio = audioEl;
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
                const res = await fetch('/api/ai/tts', {
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
                    _mobAiCurrentAudio = null;
                };
                audioEl.onerror = () => {
                    voiceBtn.innerHTML = `<i class="fas fa-volume-up"></i> <span>Listen</span>`;
                    voiceBtn.classList.remove('playing', 'loading');
                    audioEl = null;
                };
                voiceBtn.innerHTML = `<i class="fas fa-pause"></i> <span>Playing...</span>`;
                voiceBtn.classList.remove('loading');
                voiceBtn.classList.add('playing');
                _mobAiCurrentAudio = audioEl;
                audioEl.play();
            } else {
                voiceBtn.innerHTML = `<i class="fas fa-exclamation-triangle"></i> <span>Voice unavailable</span>`;
                voiceBtn.classList.remove('loading', 'playing');
                setTimeout(() => {
                    voiceBtn.innerHTML = `<i class="fas fa-volume-up"></i> <span>Retry</span>`;
                    voiceBtn.classList.remove('loading', 'playing');
                }, 3000);
            }
        } catch(e) {
            voiceBtn.innerHTML = `<i class="fas fa-exclamation-triangle"></i> <span>Voice unavailable</span>`;
            voiceBtn.classList.remove('loading', 'playing');
            setTimeout(() => {
                voiceBtn.innerHTML = `<i class="fas fa-volume-up"></i> <span>Retry</span>`;
                voiceBtn.classList.remove('loading', 'playing');
            }, 3000);
        }
        isLoading = false;
    }

    voiceBtn.onclick = playAudio;

    // Auto-play if requested (for voice conversations)
    if (autoPlay && preloadedAudio) {
        playAudio();
    }
}

// ─── Mobile AI Custom Voice Note Player ───
function _buildMobAiVoiceNotePlayer(audioSrc, uid) {
    const id = uid || ('mobvn-' + Date.now() + Math.random().toString(36).slice(2,6));
    const barCount = 28;
    let barsHtml = '';
    for (let i = 0; i < barCount; i++) {
        const h = Math.floor(Math.random() * 14) + 3;
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

function _initMobAiVoiceNotePlayers() {
    document.querySelectorAll('.ai-vnote-player:not(.inited)').forEach(player => {
        player.classList.add('inited');
        const audio = player.querySelector('audio');
        const playBtn = player.querySelector('.ai-vnote-play');
        const waveform = player.querySelector('.ai-vnote-waveform');
        const timeEl = player.querySelector('.ai-vnote-time');
        const speedBtn = player.querySelector('.ai-vnote-speed');
        const bars = waveform.querySelectorAll('.ai-vnote-bar');
        const speeds = [1, 1.5, 2, 0.5];
        let speedIdx = 0;

        function formatT(s) { const m = Math.floor(s/60); const sec = Math.floor(s%60); return m + ':' + (sec<10?'0':'') + sec; }

        audio.addEventListener('loadedmetadata', () => { timeEl.textContent = '0:00 / ' + formatT(audio.duration); });
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
            audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
        });

        speedBtn.addEventListener('click', () => {
            speedIdx = (speedIdx + 1) % speeds.length;
            audio.playbackRate = speeds[speedIdx];
            speedBtn.textContent = speeds[speedIdx] + 'x';
        });
    });
}

async function mobSendAiMessage(overrideText) {
    const input = document.getElementById('mobAiChatInput');
    const text = overrideText || (input ? input.value : '').trim();
    if (!text) return;
    if (input && !overrideText) input.value = '';
    const area = document.getElementById('mobAiChatMessages');
    if (!area) return;
    // User bubble
    area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg user">
        <div class="mob-ai-avatar"><i class="fas fa-user"></i></div>
        <div class="mob-ai-bubble">${escapeHtml(text)}</div></div>`);
    // Typing indicator
    const typingId = 'mob-ai-typing-' + Date.now();
    area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg bot" id="${typingId}">
        <div class="mob-ai-avatar"><i class="fas fa-robot"></i></div>
        <div class="mob-ai-bubble"><div class="mob-ai-typing"><span></span><span></span><span></span></div></div></div>`);
    area.scrollTop = area.scrollHeight;
    const btn = document.getElementById('mobAiSendBtn');
    if (btn) btn.disabled = true;
    try {
        // Auto-retry logic — up to 3 attempts with backoff
        let data = null;
        let lastErr = null;
        for (let _attempt = 1; _attempt <= 3; _attempt++) {
            try {
                const res = await fetch('/api/ai/chat', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ device_id: _p2pDeviceId, device_name: _p2pName, message: text })
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
        const typEl = document.getElementById(typingId);
        if (typEl) typEl.remove();
        let reply = data.reply || 'Sorry, I could not process that.';
        let badges = '';
        if (data.actions && data.actions.length) {
            data.actions.forEach(a => {
                if (a.action === 'create_task') badges += `<span class="mob-ai-action-badge task"><i class="fas fa-check-circle"></i> Task created</span>`;
                if (a.action === 'create_reminder') badges += `<span class="mob-ai-action-badge reminder"><i class="fas fa-bell"></i> Reminder set</span>`;
            });
            mobLoadAiTasks();
            mobLoadAiReminders();
        }
        // Create bot message container with empty bubble for animation
        const msgDiv = document.createElement('div');
        msgDiv.className = 'mob-ai-msg bot';
        msgDiv.innerHTML = `<div class="mob-ai-avatar"><i class="fas fa-robot"></i></div><div class="mob-ai-bubble"></div>`;
        area.appendChild(msgDiv);
        const bubble = msgDiv.querySelector('.mob-ai-bubble');
        // Add pause button during typing
        const pauseBtn = document.createElement('button');
        pauseBtn.id = 'mobAiPauseBtn';
        pauseBtn.className = 'mob-ai-pause-btn';
        pauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
        pauseBtn.title = 'Pause typing';
        pauseBtn.onclick = mobAiTogglePause;
        bubble.appendChild(pauseBtn);
        // Animate reply word by word
        await mobTypeWords(bubble, reply, area, 20);
        // Remove pause button after done
        pauseBtn.remove();
        // Add neural voice Listen button
        _mobAiAddVoicePlayback(bubble, reply);
        // Append badges after animation
        if (badges) {
            bubble.insertAdjacentHTML('beforeend', '<div style="margin-top:6px">' + badges + '</div>');
        }
    } catch(e) {
        const typEl = document.getElementById(typingId);
        if (typEl) typEl.remove();
        area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg bot">
            <div class="mob-ai-avatar"><i class="fas fa-robot"></i></div>
            <div class="mob-ai-bubble" style="color:#EF4444">Connection error. Try again.</div></div>`);
    }
    if (btn) btn.disabled = false;
    area.scrollTop = area.scrollHeight;
}

function mobAiQuick(text) { mobSendAiMessage(text); }

async function mobAiClearHistory() {
    if (!confirm('Clear AI conversation history?')) return;
    try {
        await fetch('/api/ai/clear-history', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ device_id: _p2pDeviceId })
        });
        const area = document.getElementById('mobAiChatMessages');
        if (area) area.innerHTML = `<div class="mob-ai-msg bot">
            <div class="mob-ai-avatar"><i class="fas fa-robot"></i></div>
            <div class="mob-ai-bubble">History cleared! How can I help?</div></div>`;
        mobShowToast('History cleared', 'success');
    } catch(e) { mobShowToast('Failed', 'error'); }
}

function mobToggleAiPanel(panel) {
    const panels = { tools: 'mobAiToolsPanel', delegation: 'mobAiDelegationPanel' };
    const el = document.getElementById(panels[panel]);
    if (!el) return;
    el.style.display = el.style.display === 'none' ? '' : 'none';
}

/* ═══════════════════════════════════════════════════════════════
   BEAM AI — File Upload, Image Analysis, Voice Notes, Security
   ═══════════════════════════════════════════════════════════════ */

// Current attachment state
let _mobAiAttachment = null; // { file, type: 'image'|'document'|'file'|'audio', preview }
let _mobAiMediaRecorder = null;
let _mobAiAudioChunks = [];
let _mobAiVoiceInterval = null;
let _mobAiVoiceStart = 0;
let _mobAiSpeechRecognition = null;
let _mobAiTranscript = '';

function mobAiShowAttachMenu() {
    const menu = document.getElementById('mobAiAttachMenu');
    if (!menu) return;
    menu.style.display = menu.style.display === 'none' ? '' : 'none';
}

function mobAiPickImage() {
    document.getElementById('mobAiAttachMenu') && (document.getElementById('mobAiAttachMenu').style.display = 'none');
    document.getElementById('mobAiImageInput')?.click();
}
function mobAiTakePhoto() {
    document.getElementById('mobAiAttachMenu') && (document.getElementById('mobAiAttachMenu').style.display = 'none');
    document.getElementById('mobAiCameraInput')?.click();
}
function mobAiScanDocument() {
    document.getElementById('mobAiAttachMenu') && (document.getElementById('mobAiAttachMenu').style.display = 'none');
    // Use camera input but set a flag so we auto-ask to read/extract text
    window._mobAiScanMode = true;
    document.getElementById('mobAiCameraInput')?.click();
}
function mobAiPickDocument() {
    document.getElementById('mobAiAttachMenu') && (document.getElementById('mobAiAttachMenu').style.display = 'none');
    document.getElementById('mobAiDocInput')?.click();
}
function mobAiPickFile() {
    document.getElementById('mobAiAttachMenu') && (document.getElementById('mobAiAttachMenu').style.display = 'none');
    document.getElementById('mobAiFileInput')?.click();
}

function mobAiOnImage(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    _mobAiAttachment = { file, type: 'image' };
    // If scan mode, auto-send immediately with OCR question
    if (window._mobAiScanMode) {
        window._mobAiScanMode = false;
        const scanInput = document.getElementById('mobAiChatInput');
        if (scanInput && !scanInput.value.trim()) {
            scanInput.value = 'Read and extract all text from this document. Transcribe everything you see accurately.';
        }
        input.value = '';
        mobSendAiMessage();
        return;
    }
    const reader = new FileReader();
    reader.onload = e => {
        const preview = document.getElementById('mobAiAttachPreview');
        const thumb = document.getElementById('mobAiAttachThumb');
        const name = document.getElementById('mobAiAttachName');
        if (preview) preview.style.display = 'flex';
        if (thumb) thumb.innerHTML = `<img src="${e.target.result}">`;
        if (name) name.textContent = file.name;
    };
    reader.readAsDataURL(file);
    input.value = '';
}

function mobAiOnDoc(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    _mobAiAttachment = { file, type: 'document' };
    const preview = document.getElementById('mobAiAttachPreview');
    const thumb = document.getElementById('mobAiAttachThumb');
    const name = document.getElementById('mobAiAttachName');
    const ext = file.name.split('.').pop().toLowerCase();
    const icon = ext === 'pdf' ? 'fa-file-pdf' : ext === 'docx' || ext === 'doc' ? 'fa-file-word' : ext === 'xlsx' ? 'fa-file-excel' : 'fa-file-alt';
    if (preview) preview.style.display = 'flex';
    if (thumb) thumb.innerHTML = `<i class="fas ${icon}" style="color:#EF4444;font-size:20px"></i>`;
    if (name) name.textContent = file.name;
    input.value = '';
}

function mobAiOnFile(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    _mobAiAttachment = { file, type: 'file' };
    const preview = document.getElementById('mobAiAttachPreview');
    const thumb = document.getElementById('mobAiAttachThumb');
    const name = document.getElementById('mobAiAttachName');
    if (preview) preview.style.display = 'flex';
    if (thumb) thumb.innerHTML = `<i class="fas fa-file" style="font-size:20px"></i>`;
    if (name) name.textContent = file.name;
    input.value = '';
}

function mobAiClearAttach() {
    _mobAiAttachment = null;
    const preview = document.getElementById('mobAiAttachPreview');
    if (preview) preview.style.display = 'none';
}

// ─── Voice Note Recording ───
async function mobAiStartVoiceNote() {
    document.getElementById('mobAiAttachMenu') && (document.getElementById('mobAiAttachMenu').style.display = 'none');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        _mobAiMediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        _mobAiAudioChunks = [];
        _mobAiMediaRecorder.ondataavailable = e => { if (e.data.size > 0) _mobAiAudioChunks.push(e.data); };
        _mobAiMediaRecorder.start();
        _mobAiVoiceStart = Date.now();

        // Start SpeechRecognition in parallel for live transcription
        _mobAiTranscript = '';
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SR) {
            try {
                _mobAiSpeechRecognition = new SR();
                _mobAiSpeechRecognition.lang = 'en-US';
                _mobAiSpeechRecognition.continuous = true;
                _mobAiSpeechRecognition.interimResults = false;
                _mobAiSpeechRecognition.maxAlternatives = 1;
                _mobAiSpeechRecognition.onresult = (ev) => {
                    for (let i = ev.resultIndex; i < ev.results.length; i++) {
                        if (ev.results[i].isFinal) {
                            _mobAiTranscript += ev.results[i][0].transcript + ' ';
                        }
                    }
                };
                _mobAiSpeechRecognition.onerror = () => {};
                _mobAiSpeechRecognition.onend = () => {
                    // Auto-restart if still recording (browser may stop recognition after silence)
                    if (_mobAiMediaRecorder && _mobAiMediaRecorder.state === 'recording' && _mobAiSpeechRecognition) {
                        try { _mobAiSpeechRecognition.start(); } catch(e) {}
                    }
                };
                _mobAiSpeechRecognition.start();
            } catch(e) { _mobAiSpeechRecognition = null; }
        }

        // Show voice bar, hide input bar
        const voiceBar = document.getElementById('mobAiVoiceBar');
        const inputBar = document.getElementById('mobAiInputBar');
        if (voiceBar) voiceBar.style.display = 'flex';
        if (inputBar) inputBar.style.display = 'none';

        // Timer
        _mobAiVoiceInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - _mobAiVoiceStart) / 1000);
            const min = Math.floor(elapsed / 60);
            const sec = elapsed % 60;
            const timer = document.getElementById('mobAiVoiceTimer');
            if (timer) timer.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
        }, 1000);
    } catch (e) {
        mobShowToast('Microphone access denied', 'error');
    }
}

function mobAiCancelVoice() {
    if (_mobAiSpeechRecognition) {
        try { _mobAiSpeechRecognition.onend = null; _mobAiSpeechRecognition.stop(); } catch(e) {}
        _mobAiSpeechRecognition = null;
    }
    _mobAiTranscript = '';
    if (_mobAiMediaRecorder && _mobAiMediaRecorder.state !== 'inactive') {
        _mobAiMediaRecorder.stop();
        _mobAiMediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
    _mobAiMediaRecorder = null;
    _mobAiAudioChunks = [];
    clearInterval(_mobAiVoiceInterval);
    const voiceBar = document.getElementById('mobAiVoiceBar');
    const inputBar = document.getElementById('mobAiInputBar');
    if (voiceBar) voiceBar.style.display = 'none';
    if (inputBar) inputBar.style.display = 'flex';
}

function mobAiSendVoice() {
    if (!_mobAiMediaRecorder || _mobAiMediaRecorder.state === 'inactive') return;

    // Stop SpeechRecognition (we'll use server-side transcription instead)
    if (_mobAiSpeechRecognition) {
        try { _mobAiSpeechRecognition.onend = null; _mobAiSpeechRecognition.stop(); } catch(e) {}
        _mobAiSpeechRecognition = null;
    }

    _mobAiMediaRecorder.onstop = async () => {
        const blob = new Blob(_mobAiAudioChunks, { type: 'audio/webm' });
        _mobAiMediaRecorder.stream.getTracks().forEach(t => t.stop());
        _mobAiMediaRecorder = null;
        clearInterval(_mobAiVoiceInterval);
        _mobAiTranscript = '';
        const voiceBar = document.getElementById('mobAiVoiceBar');
        const inputBar = document.getElementById('mobAiInputBar');
        if (voiceBar) voiceBar.style.display = 'none';
        if (inputBar) inputBar.style.display = 'flex';

        const area = document.getElementById('mobAiChatMessages');
        if (!area) return;

        // Show audio in user bubble
        const audioUrl = URL.createObjectURL(blob);
        const vnPlayer = _buildMobAiVoiceNotePlayer(audioUrl);
        area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg user">
            <div class="mob-ai-avatar"><i class="fas fa-user"></i></div>
            <div class="mob-ai-bubble"><div style="font-size:11px;color:rgba(255,255,255,0.7);margin-bottom:4px"><i class="fas fa-microphone"></i> Voice Note</div>${vnPlayer}</div></div>`);
        _initMobAiVoiceNotePlayers();
        area.scrollTop = area.scrollHeight;

        // Typing indicator
        const typingId = 'mob-ai-typing-' + Date.now();
        area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg bot" id="${typingId}">
            <div class="mob-ai-avatar"><i class="fas fa-brain"></i></div>
            <div class="mob-ai-bubble"><div class="mob-ai-typing"><span></span><span></span><span></span></div></div></div>`);
        area.scrollTop = area.scrollHeight;

        try {
            // Always upload audio to server for server-side transcription
            const formData = new FormData();
            formData.append('audio', blob, 'voice_note.webm');
            formData.append('owner_id', _p2pDeviceId);

            const res = await fetch('/api/ai/transcribe-audio', { method: 'POST', body: formData });
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
                const userBubbles = area.querySelectorAll('.mob-ai-msg.user .mob-ai-bubble');
                const lastUserBubble = userBubbles[userBubbles.length - 1];
                if (lastUserBubble) {
                    lastUserBubble.insertAdjacentHTML('beforeend', `<div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:4px;font-style:italic">"${transcript}"</div>`);
                }
            }

            const msgDiv = document.createElement('div');
            msgDiv.className = 'mob-ai-msg bot';
            msgDiv.innerHTML = `<div class="mob-ai-avatar"><i class="fas fa-brain"></i></div><div class="mob-ai-bubble"></div>`;
            area.appendChild(msgDiv);
            const bubble = msgDiv.querySelector('.mob-ai-bubble');

            // Add pause button during typing
            const pauseBtn = document.createElement('button');
            pauseBtn.id = 'mobAiPauseBtn';
            pauseBtn.className = 'mob-ai-pause-btn';
            pauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
            pauseBtn.title = 'Pause typing';
            pauseBtn.onclick = mobAiTogglePause;
            bubble.appendChild(pauseBtn);

            // Start TTS playback while typing — sync text speed to audio duration
            let autoPlayAudio = null;
            let typingSpeed = 20; // default fast typing
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
                        typingSpeed = Math.max(8, Math.min(80, (autoPlayAudio.duration * 1000) / wordTokens));
                    }
                } catch(e) {}
                try { autoPlayAudio.play(); } catch(e) { console.warn('Auto-play blocked:', e); }
            }

            await mobTypeWords(bubble, reply, area, typingSpeed);

            // Remove pause button after typing completes
            pauseBtn.remove();

            // Add voice playback button (with preloaded audio, auto-play only if not already playing)
            _mobAiAddVoicePlayback(bubble, reply, audioData, audioFormat, !autoPlayAudio);
        } catch(e) {
            const typEl = document.getElementById(typingId);
            if (typEl) typEl.remove();
            area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg bot"><div class="mob-ai-avatar"><i class="fas fa-brain"></i></div><div class="mob-ai-bubble" style="color:#EF4444">Failed to process voice note.</div></div>`);
        }
        area.scrollTop = area.scrollHeight;
    };
    _mobAiMediaRecorder.stop();
}

// ─── Send AI Message (enhanced with attachments) ───
// Override the send to check for attachments first
const _origMobSendAiMessage = mobSendAiMessage;
async function mobSendAiMessageEnhanced(overrideText) {
    if (_mobAiAttachment) {
        await _mobAiSendFileToAi(_mobAiAttachment, overrideText);
        return;
    }
    return _origMobSendAiMessage(overrideText);
}
// Rebind
mobSendAiMessage = mobSendAiMessageEnhanced;

async function _mobAiSendFileToAi(attachment, extraText) {
    const area = document.getElementById('mobAiChatMessages');
    if (!area) return;
    const input = document.getElementById('mobAiChatInput');
    const question = extraText || (input ? input.value : '').trim();
    if (input) input.value = '';
    mobAiClearAttach();

    // Show user bubble with preview
    let userPreview = '';
    if (attachment.type === 'image') {
        const reader = new FileReader();
        const dataUrl = await new Promise(r => { reader.onload = e => r(e.target.result); reader.readAsDataURL(attachment.file); });
        userPreview = `<img class="mob-ai-img-preview" src="${dataUrl}">`;
    } else {
        const ext = attachment.file.name.split('.').pop().toLowerCase();
        const icon = ext === 'pdf' ? 'fa-file-pdf' : ext === 'docx' || ext === 'doc' ? 'fa-file-word' : ext === 'xlsx' ? 'fa-file-excel' : 'fa-file';
        userPreview = `<div class="mob-ai-doc-badge"><i class="fas ${icon}"></i> ${escapeHtml(attachment.file.name)}</div>`;
    }
    area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg user">
        <div class="mob-ai-avatar"><i class="fas fa-user"></i></div>
        <div class="mob-ai-bubble">${userPreview}${question ? '<div style="margin-top:6px">' + escapeHtml(question) + '</div>' : ''}</div></div>`);

    // Typing indicator
    const typingId = 'mob-ai-typing-' + Date.now();
    area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg bot" id="${typingId}">
        <div class="mob-ai-avatar"><i class="fas fa-brain"></i></div>
        <div class="mob-ai-bubble"><div class="mob-ai-typing"><span></span><span></span><span></span></div></div></div>`);
    area.scrollTop = area.scrollHeight;

    try {
        const formData = new FormData();
        formData.append('file', attachment.file);
        formData.append('owner_id', _p2pDeviceId);
        formData.append('action', 'auto');
        if (question) formData.append('question', question);

        const res = await fetch('/api/ai/process-file', { method: 'POST', body: formData });
        const data = await res.json();
        const typEl = document.getElementById(typingId);
        if (typEl) typEl.remove();

        const reply = data.analysis || data.error || 'File received but could not be processed.';
        const secBadge = _mobAiSecurityBadge(data.security);

        const msgDiv = document.createElement('div');
        msgDiv.className = 'mob-ai-msg bot';
        msgDiv.innerHTML = `<div class="mob-ai-avatar"><i class="fas fa-brain"></i></div><div class="mob-ai-bubble"></div>`;
        area.appendChild(msgDiv);
        const bubble = msgDiv.querySelector('.mob-ai-bubble');
        await mobTypeWords(bubble, reply, area, 20);
        if (secBadge) bubble.insertAdjacentHTML('beforeend', secBadge);
    } catch(e) {
        const typEl = document.getElementById(typingId);
        if (typEl) typEl.remove();
        area.insertAdjacentHTML('beforeend', `<div class="mob-ai-msg bot"><div class="mob-ai-avatar"><i class="fas fa-brain"></i></div><div class="mob-ai-bubble" style="color:#EF4444">Connection error processing file.</div></div>`);
    }
    area.scrollTop = area.scrollHeight;
}

function _mobAiSecurityBadge(security) {
    if (!security) return '';
    const lvl = security.level;
    const cls = lvl === 'safe' ? 'safe' : lvl === 'warn' ? 'warn' : 'danger';
    const icon = lvl === 'safe' ? 'fa-shield-alt' : lvl === 'warn' ? 'fa-exclamation-triangle' : 'fa-skull-crossbones';
    const label = lvl === 'safe' ? 'Safe' : lvl === 'warn' ? 'Caution' : 'Threat Detected';
    return `<div class="mob-ai-security-badge ${cls}"><i class="fas ${icon}"></i> ${label}</div>`;
}

// Tasks
async function mobLoadAiTasks() {
    try {
        const res = await fetch('/api/ai/tasks?device_id=' + _p2pDeviceId);
        const data = await res.json();
        const tasks = data.tasks || [];
        const list = document.getElementById('mobAiTasksList');
        if (!list) return;
        if (tasks.length === 0) { list.innerHTML = '<div class="mob-empty" style="font-size:12px"><i class="fas fa-tasks"></i> No tasks</div>'; return; }
        list.innerHTML = tasks.map(t => {
            const pri = t.priority || 'medium';
            const done = t.status === 'completed';
            return `<div class="mob-ai-task-item priority-${pri} ${done ? 'completed' : ''}">
                <div class="mob-ai-task-check ${done ? 'done' : ''}" onclick="mobToggleAiTask('${t.id}',${!done})"><i class="fas fa-check"></i></div>
                <div style="flex:1">
                    <div class="mob-ai-task-title">${escapeHtml(t.title)}</div>
                    ${t.due ? '<div class="mob-ai-task-due"><i class="fas fa-clock"></i> '+escapeHtml(t.due)+'</div>' : ''}
                </div>
                <button class="mob-ai-task-del" onclick="mobDeleteAiTask('${t.id}')"><i class="fas fa-times"></i></button>
            </div>`;
        }).join('');
    } catch(e) {}
}

async function mobToggleAiTask(taskId, complete) {
    try {
        await fetch('/api/ai/tasks/' + taskId, {
            method: 'PUT', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ device_id: _p2pDeviceId, status: complete ? 'completed' : 'active' })
        });
        mobLoadAiTasks();
    } catch(e) {}
}

async function mobDeleteAiTask(taskId) {
    try {
        await fetch('/api/ai/tasks/' + taskId + '?device_id=' + _p2pDeviceId, { method: 'DELETE' });
        mobLoadAiTasks();
    } catch(e) {}
}

function mobAiQuickAddTask() {
    const title = prompt('Task title:');
    if (!title) return;
    fetch('/api/ai/tasks', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ device_id: _p2pDeviceId, title, priority: 'medium' })
    }).then(() => { mobLoadAiTasks(); mobShowToast('Task added', 'success'); }).catch(() => {});
}

// Reminders
async function mobLoadAiReminders() {
    try {
        const res = await fetch('/api/ai/reminders?device_id=' + _p2pDeviceId);
        const data = await res.json();
        const rems = data.reminders || [];
        const list = document.getElementById('mobAiRemindersList');
        if (!list) return;
        if (rems.length === 0) { list.innerHTML = '<div class="mob-empty" style="font-size:12px"><i class="fas fa-bell-slash"></i> No reminders</div>'; return; }
        list.innerHTML = rems.map(r => `<div class="mob-ai-reminder-item">
            <div style="flex:1">
                <div class="mob-ai-reminder-text">${escapeHtml(r.text)}</div>
                ${r.time ? '<div class="mob-ai-reminder-time"><i class="fas fa-clock"></i> '+escapeHtml(r.time)+'</div>' : ''}
            </div>
            <button class="mob-ai-task-del" onclick="mobDeleteAiReminder('${r.id}')"><i class="fas fa-times"></i></button>
        </div>`).join('');
    } catch(e) {}
}

async function mobDeleteAiReminder(remId) {
    try {
        await fetch('/api/ai/reminders/' + remId + '?device_id=' + _p2pDeviceId, { method: 'DELETE' });
        mobLoadAiReminders();
    } catch(e) {}
}

function mobAiQuickAddReminder() {
    const text = prompt('Reminder:');
    if (!text) return;
    const time = prompt('When? (e.g. 3:00 PM, tomorrow)');
    fetch('/api/ai/reminders', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ device_id: _p2pDeviceId, text, time: time || '' })
    }).then(() => { mobLoadAiReminders(); mobShowToast('Reminder set', 'success'); }).catch(() => {});
}

// ─── Reminder Notification Checker ───
let _mobReminderCheckInterval = null;
function mobStartReminderChecker() {
    if (_mobReminderCheckInterval) return;
    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    _mobReminderCheckInterval = setInterval(async () => {
        try {
            const res = await fetch('/api/ai/reminders?device_id=' + _p2pDeviceId);
            const data = await res.json();
            const rems = data.reminders || [];
            const now = new Date();
            for (const r of rems) {
                if (!r.remind_at) continue;
                const remTime = new Date(r.remind_at.replace(' ', 'T'));
                if (isNaN(remTime.getTime())) continue;
                // Fire if within 60s window
                const diff = (remTime - now) / 1000;
                if (diff <= 0 && diff > -60) {
                    // Show notification
                    if ('Notification' in window && Notification.permission === 'granted') {
                        new Notification('BEAM AI Reminder', { body: r.text, icon: '/static/fonts/logo.png', tag: r.id });
                    }
                    // Also show toast
                    mobShowToast('⏰ Reminder: ' + r.text, 'info');
                    // Auto-delete fired reminder (unless recurring)
                    if (r.repeat === 'none') {
                        fetch('/api/ai/reminders/' + r.id + '?device_id=' + _p2pDeviceId, { method: 'DELETE' });
                    }
                }
            }
        } catch(e) {}
    }, 30000); // Check every 30 seconds
}
// Start checker when page loads
setTimeout(mobStartReminderChecker, 5000);

// Delegation
let _mobDelegLoaded = false;
async function mobLoadAiDelegation() {
    // Only load from server once — never overwrite user's in-progress edits
    if (_mobDelegLoaded) return;
    try {
        const res = await fetch('/api/ai/delegation?device_id=' + _p2pDeviceId);
        const data = await res.json();
        const d = data.delegation || {};
        const toggle = document.getElementById('mobAiDelegToggle');
        const style = document.getElementById('mobAiDelegStyle');
        const rules = document.getElementById('mobAiDelegRules');
        if (toggle) toggle.checked = !!d.enabled;
        if (style) style.value = d.style || 'professional';
        if (rules) rules.value = d.rules || '';
        _mobDelegLoaded = true;
    } catch(e) {}
}

// Save toggle & style immediately (not rules — those use the Done button)
async function mobUpdateDelegation() {
    const enabled = document.getElementById('mobAiDelegToggle')?.checked || false;
    const style = document.getElementById('mobAiDelegStyle')?.value || 'professional';
    const rules = document.getElementById('mobAiDelegRules')?.value || '';
    try {
        await fetch('/api/ai/delegation', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ device_id: _p2pDeviceId, enabled, style, rules })
        });
        mobShowToast(enabled ? 'Delegation enabled' : 'Delegation disabled', 'success');
    } catch(e) {}
}

// Explicit save for the rules textarea — user presses Done
function mobSaveDelegationRules() {
    const rules = document.getElementById('mobAiDelegRules');
    if (rules) rules.blur(); // dismiss keyboard on mobile
    mobUpdateDelegation();
    mobShowToast('Custom rules saved ✓', 'success');
}

// Show/hide delegation badge in chat header
async function _updateChatDelegationBadge() {
    const badge = document.getElementById('chatDelegationBadge');
    if (!badge) return;
    try {
        const res = await fetch('/api/ai/delegation?device_id=' + _p2pDeviceId);
        const d = await res.json();
        badge.style.display = (d.delegation && d.delegation.enabled) ? 'flex' : 'none';
    } catch(e) { badge.style.display = 'none'; }
}

// Delegation auto-reply hook for mobile chat
async function mobAiTryDelegateReply(senderId, senderName, text) {
    try {
        const res = await fetch('/api/ai/delegation?device_id=' + _p2pDeviceId);
        const d = await res.json();
        if (!d.delegation || !d.delegation.enabled) return;
        const res2 = await fetch('/api/ai/delegate-reply', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ device_id: _p2pDeviceId, device_name: _p2pName, sender_name: senderName, sender_message: text, sender_id: senderId })
        });
        const data = await res2.json();
        if (data.reply) {
            // Send the AI reply via REST P2P as the owner
            await fetch('/api/p2p/messages', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    sender_id: _p2pDeviceId,
                    sender_name: _p2pName,
                    recipient_id: senderId,
                    text: data.reply,
                    ai_delegated: true
                })
            });
            if (data.flagged) {
                mobShowToast('⚠️ AI flagged a sensitive message from ' + senderName, 'warning');
            }
        }
    } catch(e) { console.error('Delegation reply error:', e); }
}


// Legacy BOTS — Mobile Browser
// ═══════════════════════════════════════════════════════════════

async function mobLoadBotsList() {
    try {
        const res = await fetch('/api/bots/list?owner_id=' + _p2pDeviceId);
        const data = await res.json();
        const bots = data.bots || [];
        const list = document.getElementById('mobBotsList');
        if (!list) return;
        if (bots.length === 0) { list.innerHTML = '<div class="mob-empty"><i class="fas fa-robot"></i> No bots yet</div>'; return; }
        list.innerHTML = bots.map(b => `<div class="mob-bot-item">
            <div class="mob-bot-item-info">
                <div class="mob-bot-avatar"><i class="fas fa-robot"></i></div>
                <div>
                    <span class="mob-bot-name">${escapeHtml(b.name)} ${mobVBadge(b.id)}</span>
                    <span class="mob-bot-desc">${escapeHtml(b.description || '')}</span>
                </div>
            </div>
            <div class="mob-bot-item-actions">
                <button class="mob-icon-btn" onclick="mobOpenBotChat('${b.id}','${escapeHtml(b.name)}')" title="Chat"><i class="fas fa-comment-dots"></i></button>
                <button class="mob-icon-btn" onclick="mobEditBot('${b.id}')" title="Edit"><i class="fas fa-pen"></i></button>
                <button class="mob-icon-btn" style="color:#EF4444" onclick="mobDeleteBot('${b.id}')" title="Delete"><i class="fas fa-trash"></i></button>
            </div>
        </div>`).join('');
    } catch(e) {}
}

async function mobLoadCallbacksList() {
    try {
        const res = await fetch('/api/bots/callbacks/' + _p2pDeviceId);
        const data = await res.json();
        const cbs = data.callbacks || [];
        const list = document.getElementById('mobCallbacksList');
        if (!list) return;
        if (cbs.length === 0) { list.innerHTML = '<div class="mob-empty"><i class="fas fa-bell-slash"></i> No callbacks</div>'; return; }
        list.innerHTML = cbs.map(c => `<div class="mob-callback-item">
            <i class="fas fa-bell" style="color:#F59E0B"></i>
            <div><span>${escapeHtml(c.message || 'Callback')}</span><span class="mob-muted"> ${c.status}</span></div>
        </div>`).join('');
    } catch(e) {}
}

function mobOpenCreateBot() {
    _mobBotEditId = null;
    document.getElementById('mobBotModalTitle').textContent = 'Create Bot';
    document.getElementById('mobBotName').value = '';
    document.getElementById('mobBotDesc').value = '';
    document.getElementById('mobBotAutoReply').value = 'Thanks for your message!';
    document.getElementById('mobBotCommands').value = '';
    document.getElementById('mobBotSubmitBtn').innerHTML = '<i class="fas fa-robot"></i> Create';
    document.getElementById('mobCreateBotModal').style.display = 'flex';
}
function mobCloseCreateBot() { document.getElementById('mobCreateBotModal').style.display = 'none'; }

async function mobSubmitBot() {
    const name = (document.getElementById('mobBotName').value || '').trim();
    if (!name) { mobShowToast('Enter bot name', 'error'); return; }
    const desc = (document.getElementById('mobBotDesc').value || '').trim();
    const autoReply = (document.getElementById('mobBotAutoReply').value || '').trim();
    const cmdsText = (document.getElementById('mobBotCommands').value || '').trim();
    const commands = {};
    cmdsText.split('\n').forEach(line => {
        const match = line.match(/^\/(\w+)\s*=\s*(.+)/);
        if (match) commands['/' + match[1]] = match[2].trim();
    });
    const payload = { name, description: desc, owner_id: _p2pDeviceId, auto_reply: autoReply, commands };
    try {
        const url = _mobBotEditId ? '/api/bots/' + _mobBotEditId : '/api/bots';
        const method = _mobBotEditId ? 'PUT' : 'POST';
        const res = await fetch(url, { method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
        const data = await res.json();
        if (data.id || data.success) { mobShowToast(_mobBotEditId ? 'Updated!' : 'Created!', 'success'); mobCloseCreateBot(); mobLoadBotsList(); }
        else { mobShowToast(data.error || 'Failed', 'error'); }
    } catch(e) { mobShowToast('Failed', 'error'); }
}

async function mobEditBot(botId) {
    try {
        const res = await fetch('/api/bots/' + botId);
        const b = await res.json();
        _mobBotEditId = botId;
        document.getElementById('mobBotModalTitle').textContent = 'Edit Bot';
        document.getElementById('mobBotName').value = b.name || '';
        document.getElementById('mobBotDesc').value = b.description || '';
        document.getElementById('mobBotAutoReply').value = b.auto_reply || '';
        const cmds = b.commands || {};
        document.getElementById('mobBotCommands').value = Object.entries(cmds).map(([k,v]) => k + ' = ' + v).join('\n');
        document.getElementById('mobBotSubmitBtn').innerHTML = '<i class="fas fa-save"></i> Save';
        document.getElementById('mobCreateBotModal').style.display = 'flex';
    } catch(e) { mobShowToast('Failed to load', 'error'); }
}

async function mobDeleteBot(botId) {
    if (!confirm('Delete this bot?')) return;
    try { await fetch('/api/bots/' + botId, { method: 'DELETE' }); mobShowToast('Deleted', 'success'); mobLoadBotsList(); }
    catch(e) { mobShowToast('Failed', 'error'); }
}

function mobOpenBotChat(botId, botName) {
    _mobCurrentBotId = botId;
    document.getElementById('mobBotChatName').textContent = botName;
    document.getElementById('mobBotChatMessages').innerHTML = '<div class="mob-empty" style="padding:20px 0"><i class="fas fa-robot"></i> Chat with ' + escapeHtml(botName) + '</div>';
    document.getElementById('mobBotChatSection').style.display = '';
    document.getElementById('mobBotChatInput').value = '';
}
function mobCloseBotChat() { _mobCurrentBotId = null; document.getElementById('mobBotChatSection').style.display = 'none'; }

async function mobSendBotMessage() {
    const input = document.getElementById('mobBotChatInput');
    const text = (input.value || '').trim();
    if (!text || !_mobCurrentBotId) return;
    input.value = '';
    const area = document.getElementById('mobBotChatMessages');
    if (area.querySelector('.mob-empty')) area.innerHTML = '';
    area.innerHTML += `<div class="mob-bot-msg mine"><div class="mob-bot-msg-text">${escapeHtml(text)}</div></div>`;
    // Show typing indicator while waiting for AI response
    const typingId = 'mob-bot-typing-' + Date.now();
    area.innerHTML += `<div class="mob-bot-msg bot" id="${typingId}">
        <div class="mob-bot-msg-text"><div class="mob-ai-typing"><span></span><span></span><span></span></div></div></div>`;
    area.scrollTop = area.scrollHeight;
    try {
        const res = await fetch('/api/bots/' + _mobCurrentBotId + '/message', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ device_id: _p2pDeviceId, device_name: _p2pName, text })
        });
        const data = await res.json();
        const typEl = document.getElementById(typingId);
        if (typEl) typEl.remove();
        const reply = data.reply || data.response || 'No response';
        // Create bot message container for word-by-word animation
        const msgDiv = document.createElement('div');
        msgDiv.className = 'mob-bot-msg bot';
        msgDiv.innerHTML = `<div class="mob-bot-msg-text"></div>`;
        area.appendChild(msgDiv);
        const bubble = msgDiv.querySelector('.mob-bot-msg-text');
        await mobTypeWords(bubble, reply, area, 20);
    } catch(e) {
        const typEl = document.getElementById(typingId);
        if (typEl) typEl.remove();
        area.innerHTML += `<div class="mob-bot-msg bot"><div class="mob-bot-msg-text" style="color:#EF4444">Error</div></div>`;
    }
    area.scrollTop = area.scrollHeight;
}

/* ═══════════════════════════════════════════════════════════════
   SUBSCRIPTION / PREMIUM — Mobile
   ═══════════════════════════════════════════════════════════════ */
let _mobSubData = null;

function mobLoadSubscriptionPage() {
  const did = _p2pDeviceId || localStorage.getItem('p2p_device_id') || '';
  if (!did) return;
  fetch(`/api/subscription/status/${did}`)
    .then(r => r.json())
    .then(data => {
      _mobSubData = data;
      _mobRenderSubPage(data);
    })
    .catch(e => console.warn('Sub status error:', e));
}

function _mobRenderSubPage(data) {
  const isPrem = data.is_premium;
  const planName = document.getElementById('mobSubPlanName');
  const planExpiry = document.getElementById('mobSubPlanExpiry');
  const currentPlan = document.getElementById('mobSubCurrentPlan');
  const upgradeSection = document.getElementById('mobSubUpgradeSection');
  const manageSection = document.getElementById('mobSubManageSection');
  const planIcon = currentPlan ? currentPlan.querySelector('.mob-sub-icon i') : null;

  if (isPrem) {
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
    if (planName) planName.textContent = 'Free Plan';
    if (planExpiry) planExpiry.textContent = 'Upgrade to unlock premium features';
    if (currentPlan) currentPlan.classList.remove('is-premium');
    if (planIcon) planIcon.className = 'fas fa-user';
    if (upgradeSection) upgradeSection.style.display = 'block';
    if (manageSection) manageSection.style.display = 'none';
  }
}

function mobStartStripeCheckout() {
  const did = _p2pDeviceId || localStorage.getItem('p2p_device_id') || '';
  const email = prompt('Enter your email for receipt:');
  if (!email) return;
  const btn = document.querySelector('.mob-sub-pay-btn.stripe-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...'; }

  fetch('/api/subscription/stripe/create-checkout', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      device_id: did,
      email: email,
      success_url: window.location.origin + '/browser?sub_success=1',
      cancel_url: window.location.origin + '/browser?sub_cancel=1'
    })
  })
  .then(r => r.json())
  .then(data => {
    if (data.checkout_url) {
      window.location.href = data.checkout_url;
    } else {
      alert('Error: ' + (data.error || 'Could not create checkout'));
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fab fa-cc-stripe"></i> Pay with Stripe (Card)'; }
    }
  })
  .catch(e => {
    alert('Network error. Please try again.');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fab fa-cc-stripe"></i> Pay with Stripe (Card)'; }
  });
}

function mobStartPaystackCheckout() {
  const did = _p2pDeviceId || localStorage.getItem('p2p_device_id') || '';
  const email = prompt('Enter your email for receipt:');
  if (!email) return;
  const btn = document.querySelector('.mob-sub-pay-btn.paystack-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...'; }

  fetch('/api/subscription/paystack/initialize', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      device_id: did,
      email: email,
      callback_url: window.location.origin + '/browser?paystack_ref=1'
    })
  })
  .then(r => r.json())
  .then(data => {
    if (data.authorization_url) {
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

function mobCancelSubscription() {
  if (!confirm('Are you sure you want to cancel your Premium subscription?')) return;
  const did = _p2pDeviceId || localStorage.getItem('p2p_device_id') || '';
  fetch('/api/subscription/cancel', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ device_id: did })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      alert('Subscription cancelled.');
      mobLoadSubscriptionPage();
    } else {
      alert('Error: ' + (data.error || 'Could not cancel'));
    }
  })
  .catch(() => alert('Network error'));
}

function mobStartFreeTrial() {
  const did = _p2pDeviceId || localStorage.getItem('p2p_device_id') || '';
  if (!did) { mobShowToast('Device not registered yet', 'error'); return; }
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
      mobLoadSubscriptionPage();
    } else {
      alert('Error: ' + (data.error || 'Could not activate trial'));
    }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-gift"></i> Start 7-Day Free Trial'; }
  })
  .catch(e => {
    alert('Network error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-gift"></i> Start 7-Day Free Trial'; }
  });
}

// Handle redirect back from Stripe/Paystack (mobile)
(function _mobCheckSubRedirect() {
  const params = new URLSearchParams(window.location.search);

  const sessionId = params.get('session_id');
  if (sessionId || params.get('sub_success')) {
    const did = _p2pDeviceId || localStorage.getItem('p2p_device_id') || '';
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
          window.history.replaceState({}, '', window.location.pathname);
          openSidebarView('subscription');
        }
      })
      .catch(() => {});
    }
  }

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
            openSidebarView('subscription');
          }
        })
        .catch(() => {});
    }
  }

  if (params.get('sub_cancel')) {
    window.history.replaceState({}, '', window.location.pathname);
  }
})();


// ═══════════════════════════════════════════════════════════════════
// "HEY BEAM" WAKE WORD — Voice Activation System (Mobile)
// ═══════════════════════════════════════════════════════════════════
let _mobWakeWordActive = false;
let _mobWakeWordRecognition = null;
let _mobWakeWordRestartTimer = null;
let _mobWakeWordSilenceCtx = null;

function _mobPlayWakeChime() {
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

function mobToggleWakeWord() {
    if (_mobWakeWordActive) {
        _mobStopWakeWord();
    } else {
        _mobStartWakeWord();
    }
}

function _mobStartWakeWord() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        mobShowToast('Voice activation not supported. Use Chrome.', 'error');
        return;
    }

    _mobWakeWordActive = true;

    const btn = document.getElementById('mobWakeWordBtn');
    if (btn) btn.classList.add('active');
    const indicator = document.getElementById('mobWakeWordIndicator');
    if (indicator) {
        indicator.style.display = 'flex';
        const span = indicator.querySelector('span');
        if (span) span.textContent = 'Listening for "Hey Beam"...';
    }

    localStorage.setItem('mobWakeWordEnabled', 'true');
    _mobWakeWordListen();
    mobShowToast('Hey Beam activated! Say "Hey Beam" anytime.', 'success');
    console.log('[Wake Word] Started');
}

function _mobStopWakeWord() {
    _mobWakeWordActive = false;
    if (_mobWakeWordRestartTimer) { clearTimeout(_mobWakeWordRestartTimer); _mobWakeWordRestartTimer = null; }
    if (_mobWakeWordRecognition) {
        try { _mobWakeWordRecognition.onend = null; _mobWakeWordRecognition.onerror = null; _mobWakeWordRecognition.abort(); } catch(e) {}
        _mobWakeWordRecognition = null;
    }
    if (_mobWakeWordSilenceCtx) { try { _mobWakeWordSilenceCtx.close(); } catch(e) {} _mobWakeWordSilenceCtx = null; }

    const btn = document.getElementById('mobWakeWordBtn');
    if (btn) btn.classList.remove('active');
    const indicator = document.getElementById('mobWakeWordIndicator');
    if (indicator) indicator.style.display = 'none';

    localStorage.setItem('mobWakeWordEnabled', 'false');
    console.log('[Wake Word] Stopped');
}

function _mobWakeWordMatchesBeam(text) {
    const t = text.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    // Direct keyword matches (common mis-hearings)
    const keywords = [
        'hey beam', 'hay beam', 'hey beem', 'hey been', 'hey bea',
        'hey bem', 'he beam', 'hey beab', 'hey bean', 'hey beep',
        'hey bee', 'hey bim', 'hey bam', 'hey bain', 'hey being',
        'a beam', 'hey beat', 'hey bead', 'hey beams', 'hey being',
        'hey b', 'hey be'
    ];
    for (const kw of keywords) {
        if (t.includes(kw)) return true;
    }
    // Fuzzy: any word starting with "be" after "hey"/"hay"/"a"/"he"
    if (/\b(hey|hay|a|he)\s+be\w*/i.test(t)) return true;
    return false;
}

function _mobWakeWordListen() {
    if (!_mobWakeWordActive) return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.continuous = false;       // More reliable on mobile
    recognition.interimResults = true;    // Detect wake word faster from partials
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 5;
    _mobWakeWordRecognition = recognition;

    let detected = false;

    recognition.onresult = (event) => {
        if (detected) return;
        const indicator = document.getElementById('mobWakeWordIndicator');
        const span = indicator ? indicator.querySelector('span') : null;
        for (let i = event.resultIndex; i < event.results.length; i++) {
            for (let j = 0; j < event.results[i].length; j++) {
                const alt = event.results[i][j].transcript;
                console.log('[Wake Word] Heard:', JSON.stringify(alt));
                // Show what was heard on the indicator
                if (span) span.textContent = '🎤 "' + alt.substring(0, 30) + '"';
                if (_mobWakeWordMatchesBeam(alt)) {
                    detected = true;
                    console.log('[Wake Word] >>> "Hey Beam" DETECTED! <<<');

                    // Stop wake word recognition immediately
                    try { recognition.onend = null; recognition.onerror = null; recognition.abort(); } catch(e) {}
                    _mobWakeWordRecognition = null;

                    // Play chime
                    _mobPlayWakeChime();

                    // Flash indicator
                    const indicator = document.getElementById('mobWakeWordIndicator');
                    if (indicator) {
                        indicator.classList.add('activated');
                        const span = indicator.querySelector('span');
                        if (span) span.textContent = 'Beam activated! Speak now...';
                        setTimeout(() => {
                            indicator.classList.remove('activated');
                            if (span) span.textContent = 'Listening for "Hey Beam"...';
                        }, 4000);
                    }

                    // Navigate to BEAM AI (it's inside view-bots)
                    const botsView = document.getElementById('view-bots');
                    if (botsView && !botsView.classList.contains('active')) {
                        switchView('bots', null);
                        // Also highlight the bots tab if it exists
                        const tabs = document.querySelectorAll('.btm-tab');
                        tabs.forEach(t => t.classList.remove('active'));
                    }

                    // Start recording after small delay (let chime play + view switch)
                    setTimeout(() => { _mobWakeWordAutoRecord(); }, 500);
                    return;
                }
            }
        }
    };

    recognition.onerror = (event) => {
        console.log('[Wake Word] SR error:', event.error);
        const indicator = document.getElementById('mobWakeWordIndicator');
        const span = indicator ? indicator.querySelector('span') : null;
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            mobShowToast('Mic blocked. Enable mic for "Hey Beam".', 'error');
            _mobStopWakeWord();
            return;
        }
        if (span) span.textContent = 'Restarting... (' + event.error + ')';
        // no-speech, aborted, network → let onend restart
    };

    recognition.onend = () => {
        if (!_mobWakeWordActive || detected) return;
        const indicator = document.getElementById('mobWakeWordIndicator');
        const span = indicator ? indicator.querySelector('span') : null;
        if (span) span.textContent = 'Listening for "Hey Beam"...';
        // Auto-restart (mobile stops after each phrase)
        _mobWakeWordRestartTimer = setTimeout(() => {
            if (_mobWakeWordActive) _mobWakeWordListen();
        }, 250);
    };

    try {
        recognition.start();
        console.log('[Wake Word] SR listening cycle started');
        const indicator = document.getElementById('mobWakeWordIndicator');
        const span = indicator ? indicator.querySelector('span') : null;
        if (span) span.textContent = 'Listening for "Hey Beam"...';
    } catch(e) {
        console.warn('[Wake Word] SR start failed:', e.message);
        // Retry after delay
        _mobWakeWordRestartTimer = setTimeout(() => {
            if (_mobWakeWordActive) _mobWakeWordListen();
        }, 2000);
    }
}

function _mobWakeWordAutoRecord() {
    if (!_mobWakeWordActive) { _mobWakeWordListen(); return; }

    console.log('[Wake Word] Starting auto-record...');

    // Use the existing voice note function — it handles MediaRecorder + UI properly
    mobAiStartVoiceNote().then(() => {
        console.log('[Wake Word] Voice recording started, adding silence detection...');

        // Give the recorder a moment to start
        setTimeout(() => {
            if (!_mobAiMediaRecorder || _mobAiMediaRecorder.state !== 'recording') {
                console.warn('[Wake Word] Recorder not active, restarting listener');
                if (_mobWakeWordActive) _mobWakeWordListen();
                return;
            }

            // Attach silence detection to the active stream
            try {
                const stream = _mobAiMediaRecorder.stream;
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                _mobWakeWordSilenceCtx = audioCtx;
                const source = audioCtx.createMediaStreamSource(stream);
                const analyser = audioCtx.createAnalyser();
                analyser.fftSize = 512;
                source.connect(analyser);
                const dataArray = new Uint8Array(analyser.frequencyBinCount);

                let silenceStart = null;
                let sent = false;
                const SILENCE_THRESHOLD = 15;
                const SILENCE_DURATION = 2200;   // 2.2s of silence → auto-send
                const MIN_RECORD_TIME = 1500;    // At least 1.5s recording
                const recordStart = Date.now();

                function checkSilence() {
                    if (sent) return;
                    if (!_mobAiMediaRecorder || _mobAiMediaRecorder.state !== 'recording') return;

                    analyser.getByteFrequencyData(dataArray);
                    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

                    if (avg < SILENCE_THRESHOLD) {
                        if (!silenceStart) silenceStart = Date.now();
                        if (Date.now() - silenceStart > SILENCE_DURATION && Date.now() - recordStart > MIN_RECORD_TIME) {
                            sent = true;
                            console.log('[Wake Word] Silence detected → auto-sending voice note');
                            try { audioCtx.close(); } catch(e) {}
                            _mobWakeWordSilenceCtx = null;
                            mobAiSendVoice();
                            // Restart wake word listener after response processing
                            setTimeout(() => {
                                if (_mobWakeWordActive) {
                                    console.log('[Wake Word] Restarting listener after send');
                                    _mobWakeWordListen();
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
                    if (!sent && _mobAiMediaRecorder && _mobAiMediaRecorder.state === 'recording') {
                        sent = true;
                        console.log('[Wake Word] Max time reached, auto-sending');
                        try { audioCtx.close(); } catch(e) {}
                        _mobWakeWordSilenceCtx = null;
                        mobAiSendVoice();
                        setTimeout(() => { if (_mobWakeWordActive) _mobWakeWordListen(); }, 4000);
                    }
                }, 60000);

            } catch(e) {
                console.warn('[Wake Word] Silence detection setup failed:', e);
                // Recording is still active, user can manually send
            }
        }, 800);

    }).catch(e => {
        console.warn('[Wake Word] Auto-record failed:', e);
        mobShowToast('Could not start recording', 'error');
        if (_mobWakeWordActive) setTimeout(() => _mobWakeWordListen(), 2000);
    });
}

// Auto-restore wake word on page load if previously enabled
setTimeout(() => {
    if (localStorage.getItem('mobWakeWordEnabled') === 'true') {
        _mobStartWakeWord();
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
    // Wait for DOM
    setTimeout(() => {
        setupScrollBtn('chatMessages', 'mobChatScrollBtn');
        setupScrollBtn('mobAiChatMessages', 'mobAiScrollBtn');
    }, 500);
})();