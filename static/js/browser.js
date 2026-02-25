// File Browser JavaScript
let currentPath = '';
let rootDir = '';           // initial shared directory (back-button boundary)
let currentFiles = [];
let currentDirectories = [];
let currentSort = { field: 'name', ascending: true };
let currentPage = 1;
let itemsPerPage = 20;
let fastBaseUrl = null;  // raw-socket fast transfer server base URL

document.addEventListener('DOMContentLoaded', function() {
    // Fetch server info: fast transfer port + shared directory to start in
    fetchServerInfo(true);
    
    // Set up event listeners
    document.getElementById('searchInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            performSearch();
        }
    });
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

    const url = fastBaseUrl
        ? `${fastBaseUrl}/?path=${encodeURIComponent(rawPath)}`
        : `/api/dl?path=${encodeURIComponent(rawPath)}`;

    // Small delay so overlay renders before browser opens the download tab
    setTimeout(() => {
        window.open(url, '_blank');
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

// ── Auto-open Share tab if URL has ?tab=share ───────────────────
(function() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('tab') === 'share') {
        // Defer until DOM is ready
        const _tryOpen = () => {
            const btn = document.querySelector('.btm-tab:nth-child(2)');
            if (btn) switchView('share', btn);
            else setTimeout(_tryOpen, 100);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _tryOpen);
        else _tryOpen();
    }
})();

// ── View switching ──────────────────────────────────────────────
function switchView(view, btn) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.btm-tab').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');
    if (btn) btn.classList.add('active');

    const title = document.getElementById('viewTitle');
    const pathEl = document.getElementById('pathDisplay');
    const upBtn = document.getElementById('btnGoUp');

    if (view === 'share') {
        title.textContent = 'Share';
        pathEl.textContent = 'Phone-to-Phone';
        upBtn.style.visibility = 'hidden';
        p2pInit();
    } else {
        title.textContent = 'Files';
        pathEl.textContent = currentPath || 'Loading';
        upBtn.style.visibility = '';
    }
}

// ── P2P Init ────────────────────────────────────────────────────
async function p2pInit() {
    if (!_p2pDeviceId) {
        await p2pRegister(_p2pName);
    } else {
        await p2pRegister(_p2pName);
    }
    p2pStartPolling();
    _loadP2PQR();
    _renderHistory();
}

async function p2pRegister(name) {
    try {
        const body = { device_id: _p2pDeviceId || undefined, name: name || undefined };
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
        document.getElementById('p2pMyId').textContent = 'ID: ' + _p2pDeviceId;
    } catch (e) {
        console.error('P2P register error:', e);
    }
}

function p2pStartPolling() {
    if (_p2pPollTimer) return;
    _p2pPoll();
    _p2pPollTimer = setInterval(_p2pPoll, 3000);
}

async function _p2pPoll() {
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
                    <span class="p2p-device-name">${escapeHtml(d.name)}</span>
                    <span class="p2p-device-status">${status}</span>
                </div>
                <div class="p2p-device-dot ${ago < 10 ? 'online' : ''}"></div>
            </div>
        `;
    }).join('');
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
    try {
        const r = await fetch('/api/p2p/qr?_t=' + Date.now());
        const d = await r.json();
        const el = document.getElementById('p2pQRImg');
        if (el) { el.src = d.qr; el.style.display = ''; }
        const urlEl = document.getElementById('p2pQRUrl');
        if (urlEl) urlEl.textContent = d.url;
        _qrLoaded = true;
    } catch (_) {}
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