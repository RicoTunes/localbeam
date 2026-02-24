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
    fetch('/api/info').then(r => r.json()).then(data => {
        if (data.ip && data.fast_port) {
            fastBaseUrl = `http://${data.ip}:${data.fast_port}`;
        }
        // Start browser in the shared folder, not the user's home directory
        rootDir = data.directory || '';
        loadDirectory(rootDir);
        loadQuickAccess(rootDir || null);
    }).catch(() => {
        loadDirectory('');
        loadQuickAccess(null);
    });
    
    // Set up event listeners
    document.getElementById('searchInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            performSearch();
        }
    });
});

// Load directory contents
async function loadDirectory(path) {
    const browserContent = document.getElementById('browserContent');
    browserContent.innerHTML = '<div class="loading"><div class="loading-spinner"></div>Loading files...</div>';
    
    try {
        const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse';
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
        const response = await fetch('/api/special_dirs');
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

    return `
        <div class="browser-item file ${fileClass}" onclick="showFileInfo('${encodeURIComponent(file.path)}', '${escapeHtml(file.name)}', ${file.size}, '${file.extension}')">
            <div class="item-icon-wrap"><i class="fas fa-${fileIcon}"></i></div>
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

// Refresh browser
function refreshBrowser() {
    loadDirectory(currentPath);
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