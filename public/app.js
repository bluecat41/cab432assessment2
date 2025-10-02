// public/app.js
let token = null;
let currentPoll = null; // track active status poll so we can cancel on logout

// Keep last login creds so we can "resend" MFA code by retrying /login
let lastLogin = { username: null, password: null };

// MFA state
let mfaSession = null;
let mfaChallengeName = null;
let mfaUsername = null;

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

// Confirm UI (account confirmation)
const confirmBtn  = document.getElementById('confirmBtn');
const resendBtn   = document.getElementById('resendBtn');   // optional
const confirmMsg  = document.getElementById('confirmMsg');  // optional

// MFA UI
const mfaSection   = document.getElementById('mfa');
const mfaMsg       = document.getElementById('mfaMsg');
const mfaCodeInput = document.getElementById('mfaCode');
const mfaSubmitBtn = document.getElementById('mfaSubmitBtn');
const mfaResendBtn = document.getElementById('mfaResendBtn');

const welcomeBox  = document.getElementById('welcomeBox');  // optional
const welcomeName = document.getElementById('welcomeName'); // optional

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
  statusBox.classList.add('hidden');
  statusText.textContent = '';
  progressBar.value = 0;
  errorP.textContent = '';
  downloadBtn.classList.add('hidden');
  downloadBtn.onclick = null;
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

function clearAuthMessages() {
  authMsg.textContent = '';
  registerMsg.textContent = '';
  if (confirmMsg) confirmMsg.textContent = '';
}

function setWelcome(name) {
  if (name && welcomeName && welcomeBox) {
    welcomeName.textContent = name;
    welcomeBox.classList.remove('hidden');
  } else if (name) {
    authMsg.textContent = `✅ Welcome, ${name}`;
  }
}

function clearWelcome() {
  if (welcomeName) welcomeName.textContent = '';
  if (welcomeBox) welcomeBox.classList.add('hidden');
}

function showMfaUI(message) {
  if (mfaMsg && message) mfaMsg.textContent = message;
  if (mfaSection) mfaSection.classList.remove('hidden');
  if (mfaCodeInput) {
    mfaCodeInput.value = '';
    mfaCodeInput.focus();
  }
}

function hideMfaUI() {
  if (mfaSection) mfaSection.classList.add('hidden');
  if (mfaMsg) mfaMsg.textContent = '';
  if (mfaCodeInput) mfaCodeInput.value = '';
  // clear state
  mfaSession = null;
  mfaChallengeName = null;
  mfaUsername = null;
}
// -----------------------------

function setAuthUI(loggedIn) {
  if (loggedIn) {
    authSection.classList.add('hidden');
    uploadSection.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
    resetStatusUI();
  } else {
    authSection.classList.remove('hidden');
    uploadSection.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    historySection.classList.add('hidden');
    token = null;
    resetStatusUI();
    clearHistoryUI();
    clearAuthMessages();
    clearWelcome();
    hideMfaUI();
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

// Fetch /api/me and show welcome
async function showWelcomeFromMe() {
  try {
    const resp = await api('/api/me');
    if (!resp.ok) return;
    const data = await resp.json();
    const name = (data?.user?.username || data?.user?.email || '').trim();
    if (name) setWelcome(name);
  } catch {
    // ignore
  }
}

// --------- Auth flows ---------
loginBtn.addEventListener('click', async () => {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  lastLogin = { username, password }; // so we can resend a new OTP

  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Login failed');

    // Tokens right away?
    if (data.idToken || data.token) {
      token = data.idToken || data.token;
      setAuthUI(true);
      await showWelcomeFromMe();
      await loadHistory();
      return;
    }

    // MFA required (EMAIL_OTP preferred/auto-selected)
    if (data.mfaRequired && data.session && data.challengeName) {
      mfaSession = data.session;
      mfaChallengeName = data.challengeName; // 'EMAIL_OTP'
      mfaUsername = username;

      const where = data?.parameters?.CODE_DELIVERY_DESTINATION || 'your email';
      showMfaUI(`We sent a one-time code to ${where}. Enter it below.`);
      return;
    }

    throw new Error('Unexpected login response.');
  } catch (err) {
    authMsg.textContent = '❌ ' + err.message;
  }
});

// Verify MFA code
mfaSubmitBtn?.addEventListener('click', async () => {
  const code = mfaCodeInput?.value?.trim();
  if (!mfaUsername || !mfaSession || !mfaChallengeName) {
    if (mfaMsg) mfaMsg.textContent = 'Session expired. Please log in again.';
    return;
  }
  if (!code) {
    if (mfaMsg) mfaMsg.textContent = 'Enter the 6-digit code from your email.';
    mfaCodeInput?.focus();
    return;
  }

  try {
    const rr = await fetch('/api/mfa/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: mfaUsername,
        code,
        session: mfaSession,
        challengeName: mfaChallengeName // 'EMAIL_OTP'
      })
    });
    const rj = await rr.json();
    if (!rr.ok) throw new Error(rj.error || 'MFA verification failed');

    token = rj.idToken || rj.token;
    hideMfaUI();
    setAuthUI(true);
    await showWelcomeFromMe();
    await loadHistory();
  } catch (err) {
    if (mfaMsg) mfaMsg.textContent = '❌ ' + err.message;
  }
});

// Resend MFA code (re-runs /login, which triggers a new EMAIL_OTP)
mfaResendBtn?.addEventListener('click', async () => {
  if (!lastLogin?.username || !lastLogin?.password) {
    if (mfaMsg) mfaMsg.textContent = 'Enter your username and password again to resend the code.';
    return;
  }
  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastLogin)
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not resend code');

    if (data.mfaRequired && data.session && data.challengeName) {
      mfaSession = data.session;
      mfaChallengeName = data.challengeName;
      mfaUsername = lastLogin.username;
      const where = data?.parameters?.CODE_DELIVERY_DESTINATION || 'your email';
      showMfaUI(`We sent a new code to ${where}.`);
    } else {
      // If tokens came back (pool might have changed), complete login
      if (data.idToken || data.token) {
        token = data.idToken || data.token;
        hideMfaUI();
        setAuthUI(true);
        await showWelcomeFromMe();
        await loadHistory();
        return;
      }
      throw new Error('Unexpected response while resending code.');
    }
  } catch (err) {
    if (mfaMsg) mfaMsg.textContent = '❌ ' + err.message;
  }
});

logoutBtn.addEventListener('click', () => {
  token = null;
  authMsg.textContent = 'Logged out';
  resetStatusUI();
  clearHistoryUI();
  clearWelcome();
  hideMfaUI();
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
    const where = data.codeDelivery?.destination ? ` → ${data.codeDelivery.destination}` : '';
    registerMsg.textContent = '✅ Registered. Check your email for a code' + where;

    const confirmUsernameEl = document.getElementById('confirmUsername');
    if (confirmUsernameEl && !confirmUsernameEl.value) confirmUsernameEl.value = username;
  } catch (err) {
    registerMsg.textContent = '❌ ' + err.message;
  }
});

// Account confirmation (post-signup email code)
confirmBtn?.addEventListener('click', async () => {
  const username =
    document.getElementById('confirmUsername')?.value?.trim() ||
    document.getElementById('regUsername')?.value?.trim() ||
    document.getElementById('username')?.value?.trim() ||
    '';
  const code = document.getElementById('confirmCode')?.value?.trim();

  if (!username || !code) {
    if (confirmMsg) confirmMsg.textContent = '❌ Enter your username and the code from the email.';
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

    if (confirmMsg) confirmMsg.textContent = '✅ Confirmed! You can now log in.';
    const loginU = document.getElementById('username');
    if (loginU) loginU.value = username;
    document.getElementById('password')?.focus();
  } catch (err) {
    if (confirmMsg) confirmMsg.textContent = '❌ ' + err.message;
  }
});

// --------- Upload flow ---------
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

  if (currentPoll) {
    clearInterval(currentPoll);
    currentPoll = null;
  }

  try {
    // 1) Presigned PUT
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

    // 2) Upload
    statusText.textContent = 'Uploading to S3...';
    await uploadWithProgress(p.uploadUrl, file, (pct) => {
      progressBar.value = pct;
    });

    // 3) Start transcode
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
          a.download = ''; // ignored cross-origin, server forces Content-Disposition
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
