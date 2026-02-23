// Wireless File Transfer - Main JavaScript
let allFilesData = [];
let fastBaseUrl = null;  // e.g. "http://192.168.1.5:5002" — raw socket fast server

document.addEventListener('DOMContentLoaded', function() {
    // Initialize the app
    loadServerInfo();
    loadFiles();
    
    // Set up auto-refresh every 30 seconds
    setInterval(loadFiles, 30000);
    
    // Set up event listeners
    document.getElementById('clipboardText').addEventListener('input', function() {
        localStorage.setItem('clipboardCache', this.value);
    });
    
    // Load cached clipboard text
    const cachedText = localStorage.getItem('clipboardCache');
    if (cachedText) {
        document.getElementById('clipboardText').value = cachedText;
    }
});

// Load server information
async function loadServerInfo() {
    try {
        const response = await fetch('/api/info');
        const data = await response.json();

        document.getElementById('sharedDir').textContent = data.directory || 'Not set';

        // Build fast-server base URL for direct LAN downloads (no internet needed)
        if (data.ip && data.fast_port) {
            fastBaseUrl = `http://${data.ip}:${data.fast_port}`;
        } else {
            fastBaseUrl = null;
        }
    } catch (error) {
        console.error('Failed to load server info:', error);
        document.getElementById('sharedDir').textContent = 'Error loading';
    }
}

// Load files from server
async function loadFiles() {
    const fileList = document.getElementById('fileList');
    fileList.innerHTML = '<tr><td colspan="4" class="loading">Loading files...</td></tr>';
    
    try {
        const response = await fetch('/api/files');
        const data = await response.json();
        
        if (data.error) {
            fileList.innerHTML = `<tr><td colspan="4" class="loading">Error: ${data.error}</td></tr>`;
            return;
        }
        
        if (data.files.length === 0) {
            fileList.innerHTML = '<tr><td colspan="4" class="loading">No files found in shared directory</td></tr>';
            updateStats(0, 0);
            return;
        }
        
        allFilesData = data.files;
        renderFiles(data.files);
        updateStats(data.files.length, data.files.reduce((s, f) => s + f.size, 0));
        
    } catch (error) {
        console.error('Failed to load files:', error);
        fileList.innerHTML = '<tr><td colspan="4" class="loading">Failed to load files. Check server connection.</td></tr>';
    }
}

// Render a list of file objects into the table
function renderFiles(files) {
    const fileList = document.getElementById('fileList');
    if (files.length === 0) {
        fileList.innerHTML = '<tr><td colspan="4" class="loading">No matching files found</td></tr>';
        return;
    }

    let html = '';
    files.forEach(file => {
        const sizeFormatted = formatFileSize(file.size);
        const dateFormatted = new Date(file.modified * 1000).toLocaleString();
        html += `
            <tr>
                <td>
                    <i class="fas fa-file${getFileIcon(file.name)}"></i>
                    ${escapeHtml(file.name)}
                </td>
                <td><span class="file-size">${sizeFormatted}</span></td>
                <td><span class="file-date">${dateFormatted}</span></td>
                <td>
                    <div class="file-actions">
                        <button class="action-btn" title="Download" onclick="downloadFile('${encodeURIComponent(file.name)}')">
                            <i class="fas fa-download"></i>
                        </button>
                        <button class="action-btn" title="Share Link" onclick="shareFileLink('${encodeURIComponent(file.name)}')">
                            <i class="fas fa-share-alt"></i>
                        </button>
                        <button class="action-btn" title="Get Info" onclick="showFileInfo('${encodeURIComponent(file.name)}', ${file.size})">
                            <i class="fas fa-info-circle"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    });
    fileList.innerHTML = html;
}

// Filter displayed files by search input
function filterFiles() {
    const query = document.getElementById('fileSearch').value.toLowerCase().trim();
    if (!query) {
        renderFiles(allFilesData);
        updateStats(allFilesData.length, allFilesData.reduce((s, f) => s + f.size, 0));
        return;
    }
    const filtered = allFilesData.filter(f => f.name.toLowerCase().includes(query));
    renderFiles(filtered);
    updateStats(filtered.length, filtered.reduce((s, f) => s + f.size, 0));
}

// Update statistics display
function updateStats(fileCount, totalSize) {
    document.getElementById('fileCount').textContent = fileCount;
    document.getElementById('totalSize').textContent = formatFileSize(totalSize);
    
    // Update transfer count from localStorage
    const transferCount = localStorage.getItem('transferCount') || 0;
    document.getElementById('transferCount').textContent = transferCount;
}

// Format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Get appropriate file icon
function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    
    if (ext === 'apk') {
        return '-android';
    } else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
        return '-image';
    } else if (['mp4', 'avi', 'mov', 'mkv', 'wmv'].includes(ext)) {
        return '-video';
    } else if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) {
        return '-audio';
    } else if (['pdf', 'doc', 'docx', 'txt', 'rtf'].includes(ext)) {
        return '-pdf';
    } else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
        return '-archive';
    } else {
        return '';
    }
}

// Copy server URL to clipboard
function copyUrl() {
    const url = document.getElementById('serverUrl').textContent;
    
    navigator.clipboard.writeText(url).then(() => {
        showNotification('URL copied to clipboard!');
    }).catch(err => {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = url;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showNotification('URL copied to clipboard!');
    });
}

// Change shared directory
async function changeDirectory() {
    // In a real app, this would open a directory picker
    // For this demo, we'll prompt for a path
    const path = prompt('Enter the full path to the directory you want to share:');
    
    if (!path) return;
    
    try {
        const response = await fetch('/api/set_directory', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ directory: path })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification(`Directory changed to: ${path}`);
            document.getElementById('sharedDir').textContent = path;
            loadFiles();
        } else {
            showNotification(`Error: ${data.error}`, 'error');
        }
    } catch (error) {
        showNotification('Failed to change directory', 'error');
    }
}

// Download a file — goes through raw-socket fast server (LAN only, no internet)
function downloadFile(filename) {
    let transferCount = parseInt(localStorage.getItem('transferCount') || 0);
    localStorage.setItem('transferCount', transferCount + 1);
    document.getElementById('transferCount').textContent = transferCount + 1;

    // Use fast transfer server if available, otherwise fall back to Flask
    const url = fastBaseUrl
        ? `${fastBaseUrl}/${filename}`
        : `/api/download/${filename}`;
    window.open(url, '_blank');
    showNotification(`Downloading ${decodeURIComponent(filename)}...`);
}

// Share file link — always uses fast server URL so recipient only needs LAN
function shareFileLink(filename) {
    const url = fastBaseUrl
        ? `${fastBaseUrl}/${filename}`
        : `${window.location.origin}/api/download/${filename}`;

    if (navigator.share) {
        navigator.share({
            title: `Download ${decodeURIComponent(filename)}`,
            text: 'Download this file from my laptop over Wi-Fi',
            url: url
        });
    } else {
        navigator.clipboard.writeText(url).then(() => {
            showNotification('Download link copied to clipboard!');
        });
    }
}

// Show file information
function showFileInfo(filename, size) {
    alert(`File: ${decodeURIComponent(filename)}\nSize: ${formatFileSize(size)}\n\nRight-click the download button to save with a different name.`);
}

// Refresh files
function refreshFiles() {
    showNotification('Refreshing file list...');
    loadFiles();
}

// Upload file from desktop
function uploadFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = handleFileUpload;
    input.click();
}

// Handle file upload
async function handleFileUpload(event) {
    const files = event.target.files;
    if (!files.length) return;

    showNotification(`Uploading ${files.length} file(s)...`, 'info');

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < files.length; i++) {
        const formData = new FormData();
        formData.append('file', files[i]);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            const data = await response.json();

            if (data.success) {
                successCount++;
            } else {
                errorCount++;
                console.error(`Upload failed for ${files[i].name}: ${data.error}`);
            }
        } catch (error) {
            errorCount++;
            console.error(`Upload error for ${files[i].name}:`, error);
        }
    }

    if (successCount > 0) {
        showNotification(`Successfully uploaded ${successCount} file(s)!`);
        loadFiles();
    }
    if (errorCount > 0) {
        showNotification(`${errorCount} file(s) failed to upload.`, 'error');
    }
}

// Start quick transfer
function startQuickTransfer(type) {
    const types = {
        'photos': 'Send photos from your phone to laptop',
        'documents': 'Send documents from your phone to laptop',
        'music': 'Send music files from your phone to laptop',
        'videos': 'Send videos from your phone to laptop'
    };
    
    showNotification(types[type] + ' - Open the server URL on your phone to upload.', 'info');
}

// Share clipboard to phone
async function shareClipboard() {
    const text = document.getElementById('clipboardText').value.trim();
    
    if (!text) {
        showNotification('Please enter some text to share', 'warning');
        return;
    }
    
    try {
        const response = await fetch('/api/clipboard', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: text })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification('Text shared to phone clipboard!');
        } else {
            showNotification(`Failed to share: ${data.error}`, 'error');
        }
    } catch (error) {
        showNotification('Failed to share clipboard', 'error');
    }
}

// Show instructions modal
function showInstructions() {
    document.getElementById('instructionsModal').style.display = 'flex';
}

// Show about modal
function showAbout() {
    document.getElementById('aboutModal').style.display = 'flex';
}

// Close modal
function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
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

// Utility: Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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