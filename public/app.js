let token = null;

// ---- Auth elements ----
const regEmail     = document.getElementById('regEmail');
const regUsername  = document.getElementById('regUsername');
const regPassword  = document.getElementById('regPassword');
const registerBtn  = document.getElementById('registerBtn');
const registerMsg  = document.getElementById('registerMsg');

const confirmUser  = document.getElementById('confirmUser');
const confirmCode  = document.getElementById('confirmCode');
const confirmBtn   = document.getElementById('confirmBtn');
const confirmMsg   = document.getElementById('confirmMsg');

const usernameEl   = document.getElementById('username');
const passwordEl   = document.getElementById('password');
const loginBtn     = document.getElementById('loginBtn');
const authMsg      = document.getElementById('authMsg');
const logoutBtn    = document.getElementById('logoutBtn');

// ---- Sections ----
const authSection    = document.getElementById('auth');
const uploadSection  = document.getElementById('upload');
const historySection = document.getElementById('history');

// ---- Upload/status elements ----
const uploadForm   = document.getElementById('uploadForm');
const statusBox    = document.getElementById('status');
const statusText   = document.getElementById('statusText');
const progressBar  = document.getElementById('progressBar');
const errorP       = document.getElementById('error');
const downloadBtn  = document.getElementById('downloadBtn');

// ---- Helpers ----
function setAuthInputsHidden(hidden) {
  [regEmail, regUsername, regPassword, registerBtn,
   confirmUser, confirmCode, confirmBtn,
   usernameEl, passwordEl, loginBtn].forEach(el => el.classList.toggle('hidden', hidden));
}

function onLoggedInUI() {
  authSection.classList.add('hidden');
  logoutBtn.classList.remove('hidden');
  authMsg.textContent = '✅ Logged in';
  uploadSection.classList.remove('hidden');
  historySection.classList.remove('hidden');
}

function onLoggedOutUI() {
  token = null;
  setAuthInputsHidden(false);
  authSection.classList.remove('hidden');
  logoutBtn.classList.add('hidden');
  authMsg.textContent = 'Logged out';
  uploadSection.classList.add('hidden');
  historySection.classList.add('hidden');
  statusBox.classList.add('hidden');
  downloadBtn.classList.add('hidden');
  errorP.textContent = '';
  progressBar.value = 0;
}

async function downloadWithAuth(id, ext = 'mp4') {
  const r = await fetch(`/api/transcode/download/${id}`, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || 'Download failed');
  }

  let filename = `video-${id}.${ext}`;
  const disp = r.headers.get('Content-Disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?("?)([^";]+)\1/i.exec(disp);
  if (m && m[2]) filename = decodeURIComponent(m[2]);

  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function fmtSize(bytes) {
  if (typeof bytes !== 'number') return '-';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
function fmtDate(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// ---- Load history for the authenticated user (server enforces the user) ----
async function loadHistory() {
  const resp = await fetch('/api/transcode/list', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const videos = await resp.json().catch(() => []);
  const tbody = document.querySelector('#videoTable tbody');
  tbody.innerHTML = '';

  (Array.isArray(videos) ? videos : []).forEach(v => {
    const id   = v.videoId || v.id || '';
    const fmt  = v.outputFormat || v.format || 'mp4';
    const w    = v.width || '?';
    const h    = v.height || '?';
    const dur  = v.duration ? Math.round(v.duration) + 's' : '-';
    const size = fmtSize(v.fileSize);
    const upAt = fmtDate(v.startedAt || v.createdAt || v.uploadedAt);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${v.originalFilename || ''}">${v.originalFilename || '-'}</td>
      <td>${w}x${h}</td>
      <td>${v.codec || '-'}</td>
      <td>${dur}</td>
      <td>${fmt}</td>
      <td>${size}</td>
      <td>${upAt}</td>
      <td>${v.status || '-'}</td>
      <td>${typeof v.progress === 'number' ? v.progress : 0}%</td>
      <td>${
        v.status === 'done'
          ? `<button class="dl-btn" data-id="${id}" data-ext="${fmt}">⬇</button>`
          : '-'
      }</td>
      <td><button class="meta-btn" data-meta='${encodeURIComponent(JSON.stringify(v))}'>Details</button></td>
    `;
    tbody.appendChild(tr);
  });

  historySection.classList.remove('hidden');
}

// ---- Table actions (download + quick metadata view) ----
document.getElementById('history').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.classList.contains('dl-btn')) {
    const vid = t.getAttribute('data-id');
    const ext = t.getAttribute('data-ext') || 'mp4';
    try { await downloadWithAuth(vid, ext); } catch (err) { alert(err.message); }
    return;
  }
  if (t.classList.contains('meta-btn')) {
    try {
      const raw = t.getAttribute('data-meta') || '';
      const obj = JSON.parse(decodeURIComponent(raw));
      alert(JSON.stringify(obj, null, 2)); // simple quick view
    } catch (err) {
      alert('Could not parse metadata: ' + err.message);
    }
  }
});

// ---- Auth flows ----
registerBtn.addEventListener('click', async () => {
  const username = regUsername.value.trim();
  const password = regPassword.value.trim();
  const email    = regEmail.value.trim();
  if (!username || !password || !email) {
    registerMsg.textContent = '❌ Please enter email, username and password';
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
    registerMsg.textContent = '✅ Registered. Please check your email for the confirmation code.';
  } catch (err) {
    registerMsg.textContent = '❌ ' + err.message;
  }
});

confirmBtn.addEventListener('click', async () => {
  const username = confirmUser.value.trim();
  const code     = confirmCode.value.trim();
  if (!username || !code) {
    confirmMsg.textContent = '❌ Please enter username and code';
    return;
  }
  try {
    const resp = await fetch('/api/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, code })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Confirmation failed');
    confirmMsg.textContent = '✅ Account confirmed. You can now log in.';
  } catch (err) {
    confirmMsg.textContent = '❌ ' + err.message;
  }
});

loginBtn.addEventListener('click', async () => {
  const username = usernameEl.value.trim();
  const password = passwordEl.value.trim();
  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Login failed');
    token = data.token || data.idToken || data.accessToken;
    if (!token) throw new Error('No token returned from server');
    onLoggedInUI();
    await loadHistory();
  } catch (err) {
    authMsg.textContent = '❌ ' + err.message;
  }
});

logoutBtn.addEventListener('click', () => {
  onLoggedOutUI();
});

// ---- Upload flow ----
uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!token) {
    errorP.textContent = 'Please log in first.';
    return;
  }
  const fileInput   = document.getElementById('video');
  const formatEl    = document.getElementById('format');
  const chosenFormat= formatEl ? formatEl.value : 'mp4';
  if (!fileInput.files.length) return;

  statusBox.classList.remove('hidden');
  statusText.textContent = 'Uploading...';
  progressBar.value = 0;
  errorP.textContent = '';
  downloadBtn.classList.add('hidden');
  downloadBtn.onclick = null;

  const data = new FormData();
  data.append('video', fileInput.files[0]);
  data.append('format', chosenFormat);

  const resp = await fetch('/api/transcode', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: data
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    errorP.textContent = body.error || 'Upload failed';
    return;
  }

  const { id, outputFormat } = body;
  let extHint = outputFormat || chosenFormat || 'mp4';

  const poll = setInterval(async () => {
    const r = await fetch(`/api/transcode/status/${id}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    const s = await r.json().catch(() => ({}));
    statusText.textContent = s.status || 'processing';
    progressBar.value = s.progress || 0;

    if (s.status === 'done') {
      clearInterval(poll);
      const ext = s.outputFormat || extHint || 'mp4';
      downloadBtn.classList.remove('hidden');
      downloadBtn.onclick = async () => {
        try { await downloadWithAuth(id, ext); }
        catch (err) { errorP.textContent = err.message; }
      };
      await loadHistory();
    }
    if (s.status === 'error') {
      clearInterval(poll);
      errorP.textContent = s.error || 'Unknown error during transcode';
    }
  }, 1500);
});

// ---- Initial UI ----
onLoggedOutUI();
