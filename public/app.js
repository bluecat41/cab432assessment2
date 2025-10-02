// public/app.js
let token = null;
let currentPoll = null; // track active status poll so we can cancel on logout

const loginBtn    = document.getElementById('loginBtn');
const logoutBtn   = document.getElementById('logoutBtn');
const uploadForm  = document.getElementById('uploadForm');
const statusBox   = document.getElementById('status');
const statusText  = document.getElementById('statusText');
const progressBar = document.getElementById('progressBar');
const errorP      = document.getElementById('error');
const downloadBtn = document.getElementById('downloadBtn');
const authMsg     = document.getElementById('authMsg');

const registerBtn = document.getElementById('registerBtn');
const registerMsg = document.getElementById('registerMsg');

const authSection    = document.getElementById('auth');
const uploadSection  = document.getElementById('upload');
const historySection = document.getElementById('history');

// ---------- Helpers ----------
function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '-';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, num = Number(bytes);
  while (num >= 1024 && i < units.length - 1) { num /= 1024; i++; }
  const precise = num < 10 && i > 0 ? 1 : 0;
  return `${num.toFixed(precise)} ${units[i]}`;
}

function formatDate(value) {
  if (!value) return '-';
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (isNaN(d)) return '-';
  const pad = n => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function resetStatusUI() {
  // hide/clear the status area (the "done / Download" bar)
  statusBox.classList.add('hidden');
  statusText.textContent = '';
  progressBar.value = 0;
  errorP.textContent = '';
  downloadBtn.classList.add('hidden');
  downloadBtn.onclick = null;
  // stop any ongoing polling
  if (currentPoll) {
    clearInterval(currentPoll);
    currentPoll = null;
  }
}

function clearHistoryUI() {
  const tbody = document.querySelector('#videoTable tbody');
  if (tbody) tbody.innerHTML = '';
  historySection.classList.add('hidden');
}
// -----------------------------

function setAuthUI(loggedIn) {
  if (loggedIn) {
    authSection.classList.add('hidden');
    uploadSection.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
    // keep the table for this user; just reset the status UI
    resetStatusUI();
  } else {
    authSection.classList.remove('hidden');
    uploadSection.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    historySection.classList.add('hidden');
    token = null;
    // on logout, hide status and clear the table to avoid showing previous user's data
    resetStatusUI();
    clearHistoryUI();
  }
}

async function api(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  return fetch(path, opts);
}

async function loadHistory() {
  const resp = await api('/api/transcode/list');
  if (!resp.ok) return;

  const videos = await resp.json();
  const tbody = document.querySelector('#videoTable tbody');
  tbody.innerHTML = '';

  videos.forEach(v => {
    const size = v.sizeBytes ?? v.originalSizeBytes ?? v.inputSizeBytes;
    const uploaded = v.uploadedAt ?? v.createdAt ?? v.startedAt;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${v.originalFilename || '-'}</td>
      <td>${(v.width || '?')}x${(v.height || '?')}</td>
      <td>${v.codec || '-'}</td>
      <td>${v.duration ? Math.round(v.duration) + 's' : '-'}</td>
      <td>${formatBytes(size)}</td>
      <td>${formatDate(uploaded)}</td>
      <td>${v.status || '-'}</td>
      <td>${v.progress != null ? v.progress + '%' : (v.status === 'done' ? '100%' : '0%')}</td>
      <td>${
        v.status === 'done'
          ? `<button class="dl-btn" data-id="${v.id}" title="Download">⬇</button>`
          : '-'
      }</td>
    `;
    tbody.appendChild(tr);
  });

  historySection.classList.remove('hidden');
}

document.getElementById('history').addEventListener('click', async (e) => {
  if (e.target.classList.contains('dl-btn')) {
    const id = e.target.getAttribute('data-id');
    try {
      const r = await api(`/api/transcode/presign-download/${id}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Failed to presign download');
      const a = document.createElement('a');
      a.href = j.downloadUrl;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      alert(err.message);
    }
  }
});

loginBtn.addEventListener('click', async () => {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Login failed');
    token = data.idToken || data.token; // prefer ID token (has email)
    authMsg.textContent = '✅ Logged in';
    setAuthUI(true);          // resets status UI, keeps table visible
    await loadHistory();      // fetch and show this user's historical videos
  } catch (err) {
    authMsg.textContent = '❌ ' + err.message;
  }
});

logoutBtn.addEventListener('click', () => {
  token = null;
  authMsg.textContent = 'Logged out';
  // hide/clear the status area and clear table for privacy
  resetStatusUI();
  clearHistoryUI();
  setAuthUI(false);
});

registerBtn.addEventListener('click', async () => {
  const username = document.getElementById('regUsername').value;
  const password = document.getElementById('regPassword').value;
  const email    = document.getElementById('regEmail').value;
  if (!username || !password || !email) {
    registerMsg.textContent = '❌ Enter username, password, email';
    return;
  }
  try {
    const resp = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Registration failed');
    const where = data.codeDelivery?.Destination ? ` → ${data.codeDelivery.Destination}` : '';
    registerMsg.textContent = '✅ Registered. Check your email for a code' + where;
  } catch (err) {
    registerMsg.textContent = '❌ ' + err.message;
  }
});

function uploadWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream'); // must match presign
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && typeof onProgress === 'function') {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload  = () => (xhr.status >= 200 && xhr.status < 300)
      ? resolve()
      : reject(new Error('S3 upload failed: ' + xhr.status));
    xhr.onerror = () => reject(new Error('S3 upload network error'));
    xhr.send(file);
  });
}

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById('video');
  const formatEl  = document.getElementById('format');
  const chosenFmt = formatEl ? formatEl.value : 'mp4';
  if (!fileInput.files.length) return;

  const file = fileInput.files[0];

  statusBox.classList.remove('hidden');
  statusText.textContent = 'Requesting upload URL...';
  progressBar.value = 0;
  errorP.textContent = '';
  downloadBtn.classList.add('hidden');
  downloadBtn.onclick = null;

  // If another poll is running (previous user/session), stop it
  if (currentPoll) {
    clearInterval(currentPoll);
    currentPoll = null;
  }

  try {
    // 1) Request presigned PUT
    const pre = await api('/api/s3/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || 'application/octet-stream'
      })
    });
    const p = await pre.json();
    if (!pre.ok) throw new Error(p.error || 'Failed to get presigned URL');

    // 2) Upload directly to S3 with progress
    statusText.textContent = 'Uploading to S3...';
    await uploadWithProgress(p.uploadUrl, file, (pct) => {
      progressBar.value = pct;
    });

    // 3) Start transcode from S3 object (include size & upload time)
    statusText.textContent = 'Queuing transcode...';
    const startResp = await api('/api/transcode/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        s3Key: p.key,
        originalFilename: file.name,
        format: chosenFmt,
        originalSizeBytes: file.size,
        uploadedAt: new Date().toISOString()
      })
    });
    const start = await startResp.json();
    if (!startResp.ok) throw new Error(start.error || 'Failed to start transcode');
    const { id } = start;

    // 4) Poll status
    currentPoll = setInterval(async () => {
      const r = await api(`/api/transcode/status/${id}`);
      const s = await r.json();
      if (!r.ok) {
        clearInterval(currentPoll);
        currentPoll = null;
        throw new Error(s.error || 'Status failed');
      }
      statusText.textContent = s.status;
      progressBar.value = s.progress || 0;

      if (s.status === 'done') {
        clearInterval(currentPoll);
        currentPoll = null;
        downloadBtn.classList.remove('hidden');
        downloadBtn.onclick = async () => {
          const d = await api(`/api/transcode/presign-download/${id}`);
          const j = await d.json();
          if (!d.ok) return alert(j.error || 'Download failed');
          const a = document.createElement('a');
          a.href = j.downloadUrl;
          a.download = ''; // ignored cross-origin, but server header now forces download
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
        };
        await loadHistory();
      }
      if (s.status === 'error') {
        clearInterval(currentPoll);
        currentPoll = null;
        errorP.textContent = s.error || 'Transcode error';
      }
    }, 1500);
  } catch (err) {
    errorP.textContent = err.message;
  }
});
