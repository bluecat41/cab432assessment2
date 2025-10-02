// public/app.js
let token = null;

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

function setAuthUI(loggedIn) {
  if (loggedIn) {
    authSection.classList.add('hidden');
    uploadSection.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
  } else {
    authSection.classList.remove('hidden');
    uploadSection.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    historySection.classList.add('hidden');
    token = null;
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
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${v.originalFilename || '-'}</td>
      <td>${(v.width || '?')}x${(v.height || '?')}</td>
      <td>${v.codec || '-'}</td>
      <td>${v.duration ? Math.round(v.duration) + 's' : '-'}</td>
      <td>${v.ownerEmail || v.ownerKey || '-'}</td>
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
    setAuthUI(true);
    await loadHistory();
  } catch (err) {
    authMsg.textContent = '❌ ' + err.message;
  }
});

logoutBtn.addEventListener('click', () => {
  token = null;
  authMsg.textContent = 'Logged out';
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
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream'); // <-- add this
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

  try {
    // 1) Request presigned PUT
    const pre = await api('/api/s3/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/octet-stream' })
    });
    const p = await pre.json();
    if (!pre.ok) throw new Error(p.error || 'Failed to get presigned URL');

    // 2) Upload directly to S3 with progress
    statusText.textContent = 'Uploading to S3...';
    await uploadWithProgress(p.uploadUrl, file, (pct) => {
      progressBar.value = pct;
    });

    // 3) Start transcode from S3 object
    statusText.textContent = 'Queuing transcode...';
    const startResp = await api('/api/transcode/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        s3Key: p.key,
        originalFilename: file.name,
        format: chosenFmt
      })
    });
    const start = await startResp.json();
    if (!startResp.ok) throw new Error(start.error || 'Failed to start transcode');
    const { id } = start;

    // 4) Poll status
    const poll = setInterval(async () => {
      const r = await api(`/api/transcode/status/${id}`);
      const s = await r.json();
      if (!r.ok) { clearInterval(poll); throw new Error(s.error || 'Status failed'); }
      statusText.textContent = s.status;
      progressBar.value = s.progress || 0;

      if (s.status === 'done') {
        clearInterval(poll);
        downloadBtn.classList.remove('hidden');
        downloadBtn.onclick = async () => {
          const d = await api(`/api/transcode/presign-download/${id}`);
          const j = await d.json();
          if (!d.ok) return alert(j.error || 'Download failed');
          window.location.href = j.downloadUrl;
        };
        await loadHistory();
      }
      if (s.status === 'error') {
        clearInterval(poll);
        errorP.textContent = s.error || 'Transcode error';
      }
    }, 1500);
  } catch (err) {
    errorP.textContent = err.message;
  }
});
