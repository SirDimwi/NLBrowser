require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const { createClient } = require('./client');

const app = express();
const EXPORT_PATH = path.join(__dirname, 'nexus_export.json');

// ── Usage tracking (Upstash Redis) ───────────────────────────────────────────

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCmd(...args) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const json = await res.json();
    return json.result;
  } catch { return null; }
}

async function redisPipeline(commands) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    return await res.json();
  } catch { return null; }
}

function dateKey(offsetDays = 0) {
  return new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
}

const TTL = 35 * 24 * 60 * 60;

async function recordUsage(userId) {
  if (!userId) return;
  const d = dateKey();
  await redisPipeline([
    ['SADD',   `usage:${d}`, String(userId)],
    ['EXPIRE', `usage:${d}`, TTL],
    // first-seen for retention (NX = only set if not exists, no expiry)
    ['SET', `user:first_seen:${userId}`, d, 'NX'],
  ]);
}

async function recordAuthFailure() {
  const d = dateKey();
  await redisPipeline([
    ['INCR',   `metric:auth:fail:${d}`],
    ['EXPIRE', `metric:auth:fail:${d}`, TTL],
  ]);
}

async function recordAuthSuccess() {
  const d = dateKey();
  await redisPipeline([
    ['INCR',   `metric:auth:ok:${d}`],
    ['EXPIRE', `metric:auth:ok:${d}`, TTL],
  ]);
}

// Called from /track endpoint with validated event payloads
async function recordEvent(event, userId) {
  const d = dateKey();
  if (event.type === 'view') {
    const v = ['cards','columns','table'].includes(event.view) ? event.view : null;
    if (v) await redisCmd('INCR', `metric:view:${v}`);
  } else if (event.type === 'planner_add') {
    await redisPipeline([
      ['INCR',   'metric:planner:adds'],
      ['SADD',   `metric:planner:users:${d}`, String(userId)],
      ['EXPIRE', `metric:planner:users:${d}`, TTL],
    ]);
  } else if (event.type === 'session_end') {
    const secs = Math.min(Math.round(event.duration / 1000), 86400);
    await redisPipeline([
      ['INCRBYFLOAT', 'metric:session:total_secs', secs],
      ['INCR',        'metric:session:count'],
      ...(event.bounce ? [['INCR', `metric:bounce:${d}`], ['EXPIRE', `metric:bounce:${d}`, TTL]] : []),
      ...(!event.bounce ? [['INCR', `metric:sessions:${d}`], ['EXPIRE', `metric:sessions:${d}`, TTL]] : []),
    ]);
  }
}

async function computeStats() {
  const days = Array.from({ length: 30 }, (_, i) => dateKey(i));
  const today = days[0];

  const cmds = [
    // 0–29: DAU per day
    ...days.map(d => ['SCARD', `usage:${d}`]),
    // 30: MAU union
    ['SUNION', ...days.map(d => `usage:${d}`)],
    // 31: today's planner users
    ['SCARD', `metric:planner:users:${today}`],
    // 32–34: view counts
    ['GET', 'metric:view:cards'],
    ['GET', 'metric:view:columns'],
    ['GET', 'metric:view:table'],
    // 35–36: session duration totals
    ['GET', 'metric:session:total_secs'],
    ['GET', 'metric:session:count'],
    // 37–38: auth success/fail today
    ['GET', `metric:auth:ok:${today}`],
    ['GET', `metric:auth:fail:${today}`],
    // 39: planner adds all-time
    ['GET', 'metric:planner:adds'],
    // 40–42: bounce & session counts today + yesterday
    ['GET', `metric:bounce:${today}`],
    ['GET', `metric:sessions:${today}`],
    // 43–45: retention lookups — get MAU user list to check first-seen
    // (handled separately below after we have the MAU list)
  ];

  const r = await redisPipeline(cmds);
  if (!r) return { dau: 0, mau: 0, daily: {} };

  const daily = {};
  days.forEach((d, i) => {
    const count = r[i]?.result ?? 0;
    if (count > 0) daily[d] = count;
  });

  const mauList = r[30]?.result ?? [];

  // Retention: for each MAU user check first_seen date
  let d1 = 0, d7 = 0, d30 = 0;
  if (mauList.length > 0) {
    const fsKeys = mauList.map(uid => ['GET', `user:first_seen:${uid}`]);
    const todayUsers = new Set(r[0]?.result ? undefined : []); // active today
    // Re-fetch today's active set for retention
    const [todaySet, firstSeens] = await Promise.all([
      redisCmd('SMEMBERS', `usage:${today}`),
      redisPipeline(fsKeys),
    ]);
    const activeToday = new Set(todaySet ?? []);
    const day1ago  = dateKey(1);
    const day7ago  = dateKey(7);
    const day30ago = dateKey(30);
    mauList.forEach((uid, i) => {
      const fs = firstSeens?.[i]?.result;
      if (!fs || !activeToday.has(uid)) return;
      if (fs === day1ago)  d1++;
      if (fs <= day7ago && fs > dateKey(8))  d7++;
      if (fs <= day30ago && fs > dateKey(31)) d30++;
    });
  }

  const sessionCount = parseInt(r[36]?.result ?? 0);
  const avgSession = sessionCount > 0
    ? Math.round(parseFloat(r[35]?.result ?? 0) / sessionCount)
    : 0;

  const bounceCount   = parseInt(r[40]?.result ?? 0);
  const sessionsDone  = parseInt(r[41]?.result ?? 0);
  const totalSessions = bounceCount + sessionsDone;
  const bounceRate    = totalSessions > 0 ? Math.round(bounceCount / totalSessions * 100) : null;

  return {
    dau: daily[today] ?? 0,
    mau: mauList.length,
    daily,
    views: {
      cards:   parseInt(r[32]?.result ?? 0),
      columns: parseInt(r[33]?.result ?? 0),
      table:   parseInt(r[34]?.result ?? 0),
    },
    planner: {
      totalAdds:   parseInt(r[39]?.result ?? 0),
      usersToday:  r[31]?.result ?? 0,
    },
    session: {
      avgDurationSecs: avgSession,
      bounceRate,
    },
    auth: {
      successToday: parseInt(r[37]?.result ?? 0),
      failToday:    parseInt(r[38]?.result ?? 0),
    },
    retention: { d1, d7, d30 },
  };
}

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

app.use(express.json());
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
  if (!payload) { recordAuthFailure(); return res.redirect('/?error=invalid_token'); }

  // Check expiry
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    recordAuthFailure();
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

  req.session.startTime = Date.now();
  req.session.apiCallCount = 0;
  recordUsage(payload.userId);
  recordAuthSuccess();
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
  const userId = req.session.user?.userId;
  const start  = req.session.startTime;
  const calls  = req.session.apiCallCount ?? 0;
  req.session.destroy();
  if (userId && start) {
    recordEvent({ type: 'session_end', duration: Date.now() - start, bounce: calls <= 1 }, userId);
  }
  res.json({ ok: true });
});

app.post('/track', requireAuth, async (req, res) => {
  const { type, view } = req.body ?? {};
  const userId = req.session.user?.userId;
  if (type === 'view' && view) {
    await recordEvent({ type: 'view', view }, userId);
  } else if (type === 'planner_add') {
    await recordEvent({ type: 'planner_add' }, userId);
  }
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
  req.session.apiCallCount = (req.session.apiCallCount ?? 0) + 1;
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

// ── Suggestion box ────────────────────────────────────────────────────────────

const SLUR_FILTER = [
  'nigger','nigga','faggot','fag','chink','spic','kike','wetback',
  'tranny','retard','cunt','dyke','gook','beaner','cracker',
].map(w => new RegExp(`\\b${w}s?\\b`, 'i'));

function isFlagged(text) {
  return SLUR_FILTER.some(re => re.test(text));
}

app.post('/suggest', requireAuth, async (req, res) => {
  const text = (req.body?.text ?? '').trim();
  if (!text || text.length > 500) return res.status(400).json({ error: 'Invalid suggestion' });

  const entry = JSON.stringify({
    text,
    user: req.session.user?.username ?? 'unknown',
    userId: req.session.user?.userId,
    at: new Date().toISOString(),
  });

  const list = isFlagged(text) ? 'suggestions:trash' : 'suggestions:inbox';
  await redisCmd('LPUSH', list, entry);
  res.json({ ok: true });
});

app.get('/suggestions', async (req, res) => {
  const key = process.env.STATS_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: 'Unauthorized' });
  const [inbox, trash] = await Promise.all([
    redisCmd('LRANGE', 'suggestions:inbox', 0, -1),
    redisCmd('LRANGE', 'suggestions:trash', 0, -1),
  ]);
  const parse = list => (list ?? []).map(s => { try { return JSON.parse(s); } catch { return { text: s }; } });
  res.json({ inbox: parse(inbox), trash: parse(trash) });
});

app.get('/stats', async (req, res) => {
  const key = process.env.STATS_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await computeStats());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus Legacy Dashboard → http://localhost:${PORT}`));
