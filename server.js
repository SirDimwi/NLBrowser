require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('./client');

const app = express();
const EXPORT_PATH    = path.join(__dirname, 'nexus_export.json');
const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'views', 'dashboard.html'), 'utf8');

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

// Anonymous tier: everyone. HLL — no identifier is recoverable.
async function recordUsageAnon(id) {
  if (!id) return;
  const d = dateKey();
  await redisPipeline([
    ['PFADD',  `usage:hll:${d}`, String(id)],
    ['EXPIRE', `usage:hll:${d}`, TTL],
  ]);
}

// Identified tier: consented logged-in users only. Called from /consent.
async function recordUsageIdentified(userId) {
  if (!userId) return;
  const d = dateKey();
  await redisPipeline([
    ['SADD',   `usage:${d}`, String(userId)],
    ['EXPIRE', `usage:${d}`, TTL],
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
    const cmds = [['INCR', 'metric:planner:adds']];
    if (userId) {
      cmds.push(['PFADD',  `planner:hll:${d}`, String(userId)]);
      cmds.push(['EXPIRE', `planner:hll:${d}`, TTL]);
    }
    await redisPipeline(cmds);
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

  // Merge 30 daily HLLs into a short-lived key for MAU count
  const mauKey = `usage:hll:mau:${today}`;
  await redisPipeline([
    ['PFMERGE', mauKey, ...days.map(d => `usage:hll:${d}`)],
    ['EXPIRE',  mauKey, 3600],
  ]);

  const cmds = [
    // 0–29: DAU per day (anonymous HLL)
    ...days.map(d => ['PFCOUNT', `usage:hll:${d}`]),
    // 30: MAU (merged HLL)
    ['PFCOUNT', mauKey],
    // 31: today's planner unique users (HLL)
    ['PFCOUNT', `planner:hll:${today}`],
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
    // 40–41: bounce & session counts today
    ['GET', `metric:bounce:${today}`],
    ['GET', `metric:sessions:${today}`],
    // 42: identified-tier actives today (consented users only — for retention)
    ['SMEMBERS', `usage:${today}`],
  ];

  const r = await redisPipeline(cmds);
  if (!r) return { dau: 0, mau: 0, daily: {} };

  const daily = {};
  days.forEach((d, i) => {
    const count = r[i]?.result ?? 0;
    if (count > 0) daily[d] = count;
  });

  const mau = r[30]?.result ?? 0;
  const sessionCount = parseInt(r[36]?.result ?? 0);
  const avgSession = sessionCount > 0
    ? Math.round(parseFloat(r[35]?.result ?? 0) / sessionCount)
    : 0;
  const bounceCount   = parseInt(r[40]?.result ?? 0);
  const sessionsDone  = parseInt(r[41]?.result ?? 0);
  const totalSessions = bounceCount + sessionsDone;
  const bounceRate    = totalSessions > 0 ? Math.round(bounceCount / totalSessions * 100) : null;

  // Retention: identified tier only — consented users active today
  let d1 = 0, d7 = 0, d30 = 0;
  const consentedToday = r[42]?.result ?? [];
  if (consentedToday.length > 0) {
    const fsKeys = consentedToday.map(uid => ['GET', `user:first_seen:${uid}`]);
    const firstSeens = await redisPipeline(fsKeys);
    const day1ago  = dateKey(1);
    const day7ago  = dateKey(7);
    const day30ago = dateKey(30);
    consentedToday.forEach((uid, i) => {
      const fs = firstSeens?.[i]?.result;
      if (!fs) return;
      if (fs === day1ago)  d1++;
      if (fs <= day7ago  && fs > dateKey(8))  d7++;
      if (fs <= day30ago && fs > dateKey(31)) d30++;
    });
  }

  return {
    dau: daily[today] ?? 0,
    mau,
    daily,
    views: {
      cards:   parseInt(r[32]?.result ?? 0),
      columns: parseInt(r[33]?.result ?? 0),
      table:   parseInt(r[34]?.result ?? 0),
    },
    planner: {
      totalAdds:  parseInt(r[39]?.result ?? 0),
      usersToday: r[31]?.result ?? 0,
    },
    session: {
      avgDurationSecs: avgSession,
      bounceRate,
    },
    auth: {
      successToday: parseInt(r[37]?.result ?? 0),
      failToday:    parseInt(r[38]?.result ?? 0),
    },
    retention: { d1, d7, d30, basis: 'consented users' },
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
  recordUsageAnon(payload.userId);
  recordAuthSuccess();
  res.redirect('/');
});

app.post('/auth/manual', async (req, res) => {
  const token = (req.body.token || '').trim();
  if (!token) return res.status(400).json({ error: 'No token provided.' });

  const payload = decodeJwt(token);
  if (!payload) { recordAuthFailure(); return res.status(400).json({ error: 'Invalid token. Make sure you copied the full nexus_token cookie value.' }); }

  if (payload.exp && Date.now() / 1000 > payload.exp) {
    recordAuthFailure();
    return res.status(400).json({ error: 'Token has expired. Log in to Nexus Legacy again to get a fresh token.' });
  }

  const universeKey = payload.universeKey || 's0';
  const { api, get } = createClient(token, universeKey);
  const planetId = await discoverPlanetId(api, get);
  if (!planetId) { recordAuthFailure(); return res.status(400).json({ error: 'Could not connect to Nexus Legacy API. Check that your token is current.' }); }

  req.session.token = token;
  req.session.user = { userId: payload.userId, username: payload.username, race: payload.race, leaderType: payload.leaderType, universeKey, planetId, exp: payload.exp };
  req.session.startTime = Date.now();
  req.session.apiCallCount = 0;
  recordUsageAnon(payload.userId);
  recordAuthSuccess();
  res.json({ ok: true });
});

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
  const track  = req.body?.trackSession !== false;
  req.session.destroy();
  if (track && userId && start) {
    recordEvent({ type: 'session_end', duration: Date.now() - start, bounce: calls <= 1 }, userId);
  }
  res.json({ ok: true });
});

app.post('/consent', async (req, res) => {
  const userId = req.session.user?.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  req.session.consent = true;
  await recordUsageIdentified(userId);
  res.json({ ok: true });
});

app.post('/track', async (req, res) => {
  const { type, view, anonId, duration, bounce } = req.body ?? {};
  const userId = req.session.user?.userId;
  const safeAnonId = typeof anonId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(anonId) ? anonId : null;
  const effectiveId = userId ?? safeAnonId;

  if (type === 'view' && view) {
    await recordEvent({ type: 'view', view }, effectiveId);
  } else if (type === 'planner_add') {
    await recordEvent({ type: 'planner_add' }, effectiveId);
  } else if (type === 'guest_boot' && safeAnonId && !userId) {
    await recordUsageAnon(safeAnonId);
  } else if (type === 'session_end' && typeof duration === 'number') {
    await recordEvent({ type: 'session_end', duration, bounce: !!bounce }, effectiveId);
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

app.get('/data/planets', requireAuth, async (req, res) => {
  try {
    const data = await req.apiGet('/api/planets');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/data/set-planet', requireAuth, (req, res) => {
  const { planetId } = req.body;
  if (!planetId) return res.status(400).json({ error: 'planetId required' });
  req.session.user.planetId = planetId;
  res.json({ ok: true, planetId });
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

    const filename = `nexus-export-${snapshot.exportedAt.slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug endpoints ───────────────────────────────────────────────────────────

app.get('/debug/speed-effects', requireAuth, async (req, res) => {
  try {
    const planetId = req.session.user?.planetId;
    const [resData, planetData] = await Promise.all([
      req.api.research(),
      planetId ? req.api.planet(planetId) : Promise.resolve(null),
    ]);

    const research = resData.research || [];
    const speedResearch = research
      .filter(r => (r.effects || []).some(e => /speed|time/i.test(e.type)))
      .map(r => ({
        key: r.key, name: r.name, branch: r.branch, category: r.category,
        level: r.level, maxLevel: r.maxLevel,
        effects: (r.effects || []).filter(e => /speed|time/i.test(e.type)),
      }));

    const allEffectTypes = [...new Set(
      research.flatMap(r => (r.effects || []).map(e => e.type))
    )].sort();

    const rawBuildings = Array.isArray(planetData?.buildings) ? planetData.buildings
      : Array.isArray(planetData?.planet?.buildings) ? planetData.planet.buildings : [];
    const speedBuildings = rawBuildings
      .filter(b => /speed|lab|construct/i.test(b.definition?.key || '') || b.definition?.buildSpeedBonus || b.definition?.researchSpeedBonus)
      .map(b => ({
        key: b.definition?.key, name: b.definition?.name, level: b.level,
        definition: b.definition,
      }));

    const p = planetData?.planet?.planet || planetData?.planet || planetData || {};

    res.json({
      buildSpeedMult: p.buildSpeedMult ?? null,
      allResearchEffectTypes: allEffectTypes,
      speedResearch,
      speedBuildings,
      rawBuildingKeys: rawBuildings.map(b => b.definition?.key).filter(Boolean),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Guest catalogue ───────────────────────────────────────────────────────────

let catalogueCache = null;
app.get('/catalogue', (req, res) => {
  if (!catalogueCache) {
    const p = path.join(__dirname, 'public', 'catalogue.json');
    if (!fs.existsSync(p)) return res.status(503).json({ error: 'Catalogue not available' });
    catalogueCache = fs.readFileSync(p, 'utf8');
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(catalogueCache);
});

// ── Share links ───────────────────────────────────────────────────────────────

// 9 random bytes → 12-char base64url slug. SET NX ensures uniqueness; retry on collision.
async function mintSlug(payload) {
  for (let i = 0; i < 5; i++) {
    const slug = crypto.randomBytes(9).toString('base64url');
    const result = await redisCmd('SET', `share:${slug}`, payload, 'NX');
    if (result === 'OK') return slug;
  }
  return null;
}

// Accept both legacy 10-char content-hash slugs and new 12-char random slugs.
const SLUG_RE = /^[A-Za-z0-9_-]{6,16}$/;

app.post('/share', requireAuth, async (req, res) => {
  const raw = req.body?.payload;
  if (!raw || typeof raw !== 'object') return res.status(400).json({ error: 'Invalid payload' });

  const n = String(raw.n || 'Plan').slice(0, 80);
  const r = (Array.isArray(raw.r) ? raw.r : []).filter(e => Array.isArray(e) && typeof e[0]==='string' && typeof e[1]==='number').slice(0, 500);
  const b = (Array.isArray(raw.b) ? raw.b : []).filter(e => Array.isArray(e) && typeof e[0]==='string' && typeof e[1]==='number').slice(0, 500);

  if (!r.length && !b.length) return res.status(400).json({ error: 'Plan is empty' });

  const payload = JSON.stringify({ v: 1, n, r, b });
  if (payload.length > 50_000) return res.status(413).json({ error: 'Plan too large' });

  const slug = await mintSlug(payload);
  if (!slug) return res.status(500).json({ error: 'Could not mint a unique slug' });

  res.json({ slug });
});

app.get('/share/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid link' });
  const data = await redisCmd('GET', `share:${slug}`);
  if (!data) return res.status(404).json({ error: 'Shared plan not found' });
  try {
    res.json(JSON.parse(data));
  } catch {
    res.status(500).json({ error: 'Corrupt plan data' });
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

app.post('/suggest', async (req, res) => {
  const text = (req.body?.text ?? '').trim();
  if (!text || text.length > 500) return res.status(400).json({ error: 'Invalid suggestion' });

  const anon = req.body?.anonymous === true;
  const entry = JSON.stringify({
    text,
    user:   anon ? 'anonymous' : (req.session.user?.username ?? 'unknown'),
    userId: anon ? null : req.session.user?.userId,
    at: new Date().toISOString(),
  });

  const list = isFlagged(text) ? 'suggestions:trash' : 'suggestions:inbox';
  await redisCmd('LPUSH', list, entry);
  res.json({ ok: true });
});

app.get('/suggestions', async (req, res) => {
  const key = process.env.STATS_KEY;
  if (!key && process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'Not configured' });
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
  if (!key && process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'Not configured' });
  if (key && req.query.key !== key) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await computeStats());
});

app.get('/dashboard', (req, res) => {
  const key = process.env.STATS_KEY;
  if (!key && process.env.NODE_ENV === 'production') return res.status(403).send('Forbidden');
  if (key && req.query.key !== key) return res.status(401).send('Unauthorized');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(DASHBOARD_HTML);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`NL Browser → http://localhost:${PORT}`);
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.warn('⚠  Redis: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — telemetry disabled');
  } else {
    const pong = await redisCmd('PING');
    if (pong === 'PONG') {
      console.log('✓  Redis: connected to Upstash');
    } else {
      console.error('✗  Redis: connection failed — check credentials');
    }
  }
});
