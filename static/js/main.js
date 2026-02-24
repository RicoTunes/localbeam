// LocalBeam  Flutter Desktop Web App JS
let allFilesData = [];
let fastBaseUrl = null;
let _xferPollTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    loadServerInfo();
    loadFiles();
    setInterval(loadFiles, 30000);
    // Start transfer feed polling
    setInterval(pollTransfers, 2000);

    const cached = localStorage.getItem('clipboardCache');
    if (cached) document.getElementById('clipboardText').value = cached;

    document.getElementById('clipboardText').addEventListener('input', function() {
        localStorage.setItem('clipboardCache', this.value);
    });
});

/*  Server info  */
async function loadServerInfo() {
    try {
        const r = await fetch('/api/info');
        const d = await r.json();

        const dir = d.directory || 'Not set';
        const ip  = d.ip || '';

        set('sharedDir',  dir);
        set('settingDir', dir);
        set('settingIp',  ip);

        if (d.ip && d.fast_port) fastBaseUrl = `http://${d.ip}:${d.fast_port}`;

    } catch(e) {
        set('sharedDir',  'Error loading');
        set('settingDir', 'Error loading');
    }
}

/*  File list  */
async function loadFiles() {
    const el = document.getElementById('fileList');
    el.innerHTML = '<div class="file-empty"><i class="fas fa-spinner fa-spin"></i> Loading</div>';

    try {
        const r = await fetch('/api/files');
        const d = await r.json();
        if (d.error) { el.innerHTML = `<div class="file-empty">Error: ${d.error}</div>`; return; }
        if (!d.files || d.files.length === 0) {
            el.innerHTML = '<div class="file-empty">No files found in shared directory</div>';
            updateStats(0, 0); return;
        }
        allFilesData = d.files;
        renderFiles(d.files);
        updateStats(d.files.length, d.files.reduce((s,f) => s + f.size, 0));
        renderRecent(d.files.slice(0, 5));
    } catch(e) {
        el.innerHTML = '<div class="file-empty">Failed to load files</div>';
    }
}

function renderFiles(files) {
    const el = document.getElementById('fileList');
    if (!files.length) {
        el.innerHTML = '<div class="file-empty">No matching files found</div>';
        updateCount(0); return;
    }
    el.innerHTML = files.map(f => {
        const size = fmtSize(f.size);
        const date = new Date(f.modified * 1000).toLocaleDateString();
        const enc  = encodeURIComponent(f.name);
        return `
        <div class="file-row">
            <div class="file-name-cell">
                <div class="file-icon-bubble ${iconClass(f.name)}">
                    <i class="${iconFA(f.name)}"></i>
                </div>
                <span class="file-name-text" title="${esc(f.name)}">${esc(f.name)}</span>
            </div>
            <span class="file-size-cell">${size}</span>
            <span class="file-date-cell">${date}</span>
            <div class="file-actions-cell">
                <button class="act-btn dl" title="Download" onclick="downloadFile('${enc}')">
                    <i class="fas fa-download"></i>
                </button>
                <button class="act-btn" title="Copy link" onclick="shareFileLink('${enc}')">
                    <i class="fas fa-link"></i>
                </button>
            </div>
        </div>`;
    }).join('');
    updateCount(files.length);
}

function renderRecent(files) {
    const el = document.getElementById('recentList');
    if (!el || !files.length) return;
    el.innerHTML = files.map(f => `
        <li>
            <i class="${iconFA(f.name)}"></i>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span>
            <span style="color:var(--text-dim);font-size:11px">${fmtSize(f.size)}</span>
        </li>`).join('');
}

/*  Filter  */
function filterFiles() {
    const q = document.getElementById('fileSearch').value.toLowerCase().trim();
    if (!q) { renderFiles(allFilesData); updateStats(allFilesData.length, allFilesData.reduce((s,f)=>s+f.size,0)); return; }
    const filtered = allFilesData.filter(f => f.name.toLowerCase().includes(q));
    renderFiles(filtered);
    updateStats(filtered.length, filtered.reduce((s,f)=>s+f.size,0));
}

/*  Stats  */
function updateStats(count, bytes) {
    set('fileCount',    count);
    set('totalSize',    fmtSize(bytes));
    set('transferCount', localStorage.getItem('transferCount') || 0);
}

function updateCount(n) {
    const el = document.getElementById('searchCount');
    if (el) el.textContent = n + ' files';
}

/*  Actions  */
function downloadFile(enc) {
    let tc = parseInt(localStorage.getItem('transferCount') || 0) + 1;
    localStorage.setItem('transferCount', tc);
    set('transferCount', tc);
    const url = fastBaseUrl ? `${fastBaseUrl}/${enc}` : `/api/download/${enc}`;
    window.open(url, '_blank');
    showToast(`Downloading ${decodeURIComponent(enc)}`);
}

function shareFileLink(enc) {
    const url = fastBaseUrl ? `${fastBaseUrl}/${enc}` : `${location.origin}/api/download/${enc}`;
    navigator.clipboard.writeText(url).then(() => showToast('Link copied!')).catch(() => showToast('Could not copy'));
}

function copyUrl() {
    const url = document.getElementById('serverUrl').textContent.trim();
    navigator.clipboard.writeText(url).then(() => showToast('URL copied!')).catch(() => showToast('Copy failed'));
}

async function changeDirectory() {
    const path = prompt('Enter the full path to share:');
    if (!path) return;
    try {
        const r = await fetch('/api/set_directory', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({directory: path})
        });
        const d = await r.json();
        if (d.success) { showToast('Directory changed'); set('sharedDir', path); set('settingDir', path); loadFiles(); }
        else showToast('Error: ' + d.error);
    } catch(e) { showToast('Failed to change directory'); }
}

function refreshFiles() { showToast('Refreshing'); loadFiles(); }

function uploadFile() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    inp.onchange = handleFileUpload; inp.click();
}

async function handleFileUpload(event) {
    const files = event.target.files;
    if (!files.length) return;
    showToast(`Uploading ${files.length} file(s)`);
    let ok = 0, fail = 0;
    for (const file of files) {
        const fd = new FormData(); fd.append('file', file);
        try {
            const r = await fetch('/api/upload', {method:'POST', body:fd});
            const d = await r.json();
            if (d.success) ok++; else fail++;
        } catch(e) { fail++; }
    }
    if (ok)   { showToast(`Uploaded ${ok} file(s)!`); loadFiles(); }
    if (fail) showToast(`${fail} upload(s) failed`);
}

function startQuickTransfer(type) {
    showToast('Open the server URL on your phone  Upload');
}

async function shareClipboard() {
    const text = document.getElementById('clipboardText').value.trim();
    if (!text) { showToast('Enter some text first'); return; }
    try {
        const r = await fetch('/api/clipboard', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({text})
        });
        const d = await r.json();
        if (d.success) showToast('Shared to phone!'); else showToast('Error: ' + d.error);
    } catch(e) { showToast('Failed to share'); }
}

/*  Compat stubs (modals replaced by toasts)  */
function showInstructions() { showToast('Same Wi-Fi  Scan QR  Browse & download'); }
function showAbout()        { showToast('Python + Flask server  Flutter Android client  LAN only'); }
function closeModal(id)     {}

/*  Toast  */
let toastTimer;
function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// Legacy alias
function showNotification(msg) { showToast(msg); }

/*  Helpers  */
function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function fmtSize(b) {
    if (!b) return '0 B';
    const k = 1024, u = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k,i)).toFixed(1)) + ' ' + u[i];
}

function iconClass(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'apk') return 'fi-apk';
    if (['jpg','jpeg','png','gif','bmp','webp','heic','svg'].includes(ext)) return 'fi-image';
    if (['mp4','mkv','avi','mov','wmv','flv','webm'].includes(ext)) return 'fi-video';
    if (['mp3','wav','aac','flac','ogg','m4a'].includes(ext)) return 'fi-audio';
    if (['pdf','doc','docx','xls','xlsx','ppt','pptx','txt'].includes(ext)) return 'fi-doc';
    if (['zip','rar','7z','tar','gz'].includes(ext)) return 'fi-archive';
    return 'fi-default';
}

function iconFA(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'apk') return 'fab fa-android';
    if (['jpg','jpeg','png','gif','bmp','webp','heic','svg'].includes(ext)) return 'fas fa-image';
    if (['mp4','mkv','avi','mov','wmv','flv','webm'].includes(ext)) return 'fas fa-film';
    if (['mp3','wav','aac','flac','ogg','m4a'].includes(ext)) return 'fas fa-music';
    if (['pdf','doc','docx','xls','xlsx','ppt','pptx','txt'].includes(ext)) return 'fas fa-file-alt';
    if (['zip','rar','7z','tar','gz'].includes(ext)) return 'fas fa-file-archive';
    return 'fas fa-file';
}

/* ── Transfer Live Feed ─────────────────────────────────────── */

async function pollTransfers() {
    try {
        const r = await fetch('/api/transfers');
        if (!r.ok) return;
        const d = await r.json();
        const transfers = d.transfers || [];
        renderTransferFeed(transfers);

        // Update badge in nav rail
        const badge = document.getElementById('xferConnBadge');
        if (badge) {
            const active = transfers.filter(t => t.status === 'active').length;
            badge.textContent = active > 0 ? active : '';
            badge.style.display = active > 0 ? 'flex' : 'none';
        }
    } catch (_) { /* server not ready yet */ }
}

function renderTransferFeed(transfers) {
    const el = document.getElementById('transferFeed');
    if (!el) return;

    if (!transfers.length) {
        el.innerHTML = '<div class="xfer-empty"><i class="fas fa-exchange-alt"></i><span>No active transfers</span></div>';
        return;
    }

    el.innerHTML = transfers.map(t => {
        const pct = t.size > 0 ? Math.min(100, Math.round(t.sent * 100 / t.size)) : 0;
        const statusLabel = t.status === 'active' ? 'Receiving'
                          : t.status === 'paused' ? 'Paused'
                          : 'Done';
        return `<div class="xfer-row" id="xfer-${t.id}">
  <div class="xfer-icon"><i class="${iconFA(t.name)}"></i></div>
  <div class="xfer-info">
    <div class="xfer-name" title="${esc(t.name)}">${esc(t.name)}</div>
    <div class="xfer-prog-wrap"><div class="xfer-prog-bar" style="width:${pct}%"></div></div>
    <div class="xfer-meta">
      <span>${pct}%</span>
      <span>${fmtSize(t.sent)} / ${fmtSize(t.size)}</span>
      <span>${esc(t.client_ip)}</span>
    </div>
  </div>
  <div class="xfer-actions">
    ${t.status === 'active'  ? `<button class="act-btn" onclick="pauseTransfer('${t.id}')" title="Pause"><i class="fas fa-pause"></i></button>` : ''}
    ${t.status === 'paused'  ? `<button class="act-btn" onclick="resumeTransfer('${t.id}')" title="Resume"><i class="fas fa-play"></i></button>` : ''}
    <button class="act-btn danger" onclick="cancelTransfer('${t.id}')" title="Cancel"><i class="fas fa-times"></i></button>
  </div>
  <div class="xfer-status-dot ${t.status}" title="${statusLabel}"></div>
</div>`;
    }).join('');
}

async function pauseTransfer(tid) {
    await fetch(`/api/transfers/${tid}/pause`, { method: 'POST' });
    pollTransfers();
}
async function resumeTransfer(tid) {
    await fetch(`/api/transfers/${tid}/resume`, { method: 'POST' });
    pollTransfers();
}
async function cancelTransfer(tid) {
    await fetch(`/api/transfers/${tid}/cancel`, { method: 'POST' });
    pollTransfers();
}
