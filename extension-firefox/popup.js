const UNIVERSES = ['s0', 's1', 's2', 's3', 's4'];

const statusRow  = document.getElementById('status-row');
const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const userInfo   = document.getElementById('user-info');
const openBtn    = document.getElementById('open-btn');
const logoutBtn  = document.getElementById('logout-btn');

function setStatus(ok, text) {
  statusRow.className = `status-row ${ok ? 'status-ok' : 'status-err'}`;
  statusDot.className = `status-dot ${ok ? 'dot-ok' : 'dot-err'}`;
  statusText.textContent = text;
}

async function findToken() {
  for (const universe of UNIVERSES) {
    const cookie = await chrome.cookies.get({
      url: `https://${universe}.nexuslegacy.space`,
      name: 'nexus_token',
    });
    if (cookie?.value) return { token: cookie.value, universe };
  }
  return null;
}

function decodeJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch {
    return null;
  }
}

async function init() {
  const result = await findToken();

  if (!result) {
    setStatus(false, 'Not logged in to Nexus Legacy');
    openBtn.textContent = 'Go to Nexus Legacy';
    openBtn.disabled = false;
    openBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://s0.nexuslegacy.space' });
    });
    return;
  }

  const { token, universe } = result;
  const payload = decodeJwt(token);
  const expired = payload?.exp && Date.now() / 1000 > payload.exp;

  if (expired) {
    setStatus(false, 'Session expired — please log in again');
    openBtn.textContent = 'Go to Nexus Legacy';
    openBtn.disabled = false;
    openBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: `https://${universe}.nexuslegacy.space` });
    });
    return;
  }

  setStatus(true, 'Logged in to Nexus Legacy');

  if (payload) {
    userInfo.style.display = 'block';
    const exp = new Date(payload.exp * 1000);
    const strong = document.createElement('strong');
    strong.textContent = payload.username;
    const line1 = document.createTextNode(` · ${payload.race} · ${payload.leaderType}`);
    const br = document.createElement('br');
    const line2 = document.createTextNode(`Universe: ${universe.toUpperCase()} | Expires: ${exp.toLocaleDateString()}`);
    userInfo.replaceChildren(strong, line1, br, line2);
  }

  openBtn.disabled = false;
  openBtn.textContent = 'Open Dashboard';
  openBtn.addEventListener('click', () => {
    const url = `${DASHBOARD_URL}/auth?token=${encodeURIComponent(token)}`;
    chrome.tabs.create({ url });
    window.close();
  });

  logoutBtn.style.display = 'block';
  logoutBtn.addEventListener('click', async () => {
    await fetch(`${DASHBOARD_URL}/logout`, { method: 'POST', credentials: 'include' });
    logoutBtn.style.display = 'none';
    setStatus(false, 'Logged out of dashboard');
  });
}

init();
