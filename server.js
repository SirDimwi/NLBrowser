require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const { createClient } = require('./client');

const app = express();
const EXPORT_PATH = path.join(__dirname, 'nexus_export.json');

// ── Sessions ──────────────────────────────────────────────────────────────────

app.set('trust proxy', 1); // required for secure cookies behind Railway's proxy

app.use(session({
  secret: process.env.SESSION_SECRET || 'nexus-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

app.use(express.static('public'));

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.token) return res.status(401).json({ error: 'Not authenticated' });
  const { api, get } = createClient(req.session.token, req.session.user?.universeKey || 's0');
  req.api = api;
  req.apiGet = get;
  next();
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
}

async function discoverPlanetId(api, get) {
  // Try missions (has sourcePlanetId)
  try {
    const data = await api.missions();
    const m = (data.missions || []).find(m => m.sourcePlanetId);
    if (m) return m.sourcePlanetId;
  } catch {}

  // Try incoming fleets (also has sourcePlanetId)
  try {
    const data = await api.incoming();
    const f = (data.incoming || []).find(f => f.targetPlanetId);
    if (f) return f.targetPlanetId;
  } catch {}

  // Try /api/planets list
  try {
    const data = await get('/api/planets');
    const home = (data.planets || []).find(p => p.isHomeworld) || data.planets?.[0];
    if (home) return home.id;
  } catch {}

  // Try stationed garrisons
  try {
    const data = await api.stationedGarrisons();
    const g = (data.garrisons || []).find(g => g.sourcePlanetId);
    if (g) return g.sourcePlanetId;
  } catch {}

  return null;
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

app.get('/auth', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect('/?error=missing_token');

  const payload = decodeJwt(token);
  if (!payload) return res.redirect('/?error=invalid_token');

  // Check expiry
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    return res.redirect('/?error=token_expired');
  }

  const universeKey = payload.universeKey || 's0';
  const { api, get } = createClient(token, universeKey);
  const planetId = await discoverPlanetId(api, get);

  req.session.token = token;
  req.session.user = {
    userId:      payload.userId,
    username:    payload.username,
    race:        payload.race,
    leaderType:  payload.leaderType,
    universeKey,
    planetId,
    exp:         payload.exp,
  };

  res.redirect('/');
});

// Dev shortcut: auto-login from .env token (localhost only)
app.get('/dev-login', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).send('Forbidden');
  const raw = process.env.NEXUS_COOKIE || '';
  const token = raw.replace(/^nexus_token=/, '');
  if (!token) return res.status(400).send('No NEXUS_COOKIE in .env');
  const payload = decodeJwt(token);
  if (!payload) return res.status(400).send('Invalid token');
  const { api, get } = createClient(token, payload.universeKey || 's0');
  const planetId = await discoverPlanetId(api, get);
  req.session.token = token;
  req.session.user = { userId: payload.userId, username: payload.username, race: payload.race, leaderType: payload.leaderType, universeKey: payload.universeKey || 's0', planetId, exp: payload.exp };
  res.redirect('/');
});

app.get('/me', (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  const { token, ...safe } = req.session; // never send token to client
  res.json({ authenticated: true, user: req.session.user });
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── API proxy routes ──────────────────────────────────────────────────────────

const routes = {
  missions:              (api) => api.missions(),
  incoming:              (api) => api.incoming(),
  reports:               (api) => api.reports(),
  'survey-reports':      (api) => api.surveyReports(),
  'spy-reports':         (api) => api.spyReports(),
  'expedition-reports':  (api) => api.expeditionReports(),
  'patrol-reports':      (api) => api.patrolReports(),
  'field-scan-reports':  (api) => api.fieldScanReports(),
  'pirate-camps':        (api) => api.pirateCamps(),
  'pirate-reports':      (api) => api.pirateReports(),
  'system-debris':       (api) => api.systemDebris(),
  wormholes:             (api) => api.wormholes(),
  'wormhole-runs':       (api) => api.wormholeRuns(),
  'mining-reports':      (api) => api.miningReports(),
  'stationed-garrisons': (api) => api.stationedGarrisons(),
  'survey-cooldowns':    (api) => api.surveyCooldowns(),
  research:              (api) => api.research(),
  outposts:              (api) => api.outposts(),
  directives:            (api) => api.directives(),
  'galaxy-arms':         (api) => api.galaxyArms(),
  'market-hubs':         (api) => api.marketHubs(),
  'alliance-chat':       (api) => api.allianceChat(),
  'unread-messages':     (api) => api.unreadMessages(),
};

app.post('/data/discover-planet', requireAuth, async (req, res) => {
  const planetId = await discoverPlanetId(req.api, req.apiGet);
  if (!planetId) return res.status(404).json({ error: 'Could not determine planet ID' });
  req.session.user.planetId = planetId;
  res.json({ planetId });
});

app.get('/data/:endpoint', requireAuth, async (req, res) => {
  const fn = routes[req.params.endpoint];
  if (!fn) return res.status(404).json({ error: 'Unknown endpoint' });
  try {
    res.json(await fn(req.api));
  } catch (e) {
    const status = e.response?.status || 500;
    res.status(status).json({ error: e.message });
  }
});

app.get('/data/planet/:id', requireAuth, async (req, res) => {
  try { res.json(await req.api.planet(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/data/planet/:id/fleet', requireAuth, async (req, res) => {
  try { res.json(await req.api.planetFleet(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Export ────────────────────────────────────────────────────────────────────

app.post('/export', requireAuth, async (req, res) => {
  const planetId = req.session.user?.planetId;
  if (!planetId) return res.status(400).json({ error: 'Planet ID unknown — try refreshing the dashboard first' });

  try {
    const api = req.api;
    const [planet, missions, incoming, garrisons, cooldowns, research, market,
           surveyReports, spyReports, expeditionReports, miningReports, pirateReports,
           outposts, directives, wormholes] = await Promise.all([
      api.planet(planetId), api.missions(), api.incoming(),
      api.stationedGarrisons(), api.surveyCooldowns(), api.research(), api.marketHubs(),
      api.surveyReports(), api.spyReports(), api.expeditionReports(),
      api.miningReports(), api.pirateReports(),
      api.outposts(), api.directives(), api.wormholes(),
    ]);

    const snapshot = {
      exportedAt: new Date().toISOString(),
      player: req.session.user,
      planet, missions, incoming, garrisons, cooldowns, research, market,
      surveyReports, spyReports, expeditionReports, miningReports, pirateReports,
      outposts, directives, wormholes,
    };

    fs.writeFileSync(EXPORT_PATH, JSON.stringify(snapshot, null, 2));
    res.json({ ok: true, path: EXPORT_PATH, exportedAt: snapshot.exportedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus Legacy Dashboard → http://localhost:${PORT}`));
