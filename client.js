const axios = require('axios');

function createClient(token, universeKey = 's0') {
  const BASE = `https://${universeKey}.nexuslegacy.space`;

  const http = axios.create({
    baseURL: BASE,
    headers: {
      cookie: `nexus_token=${token}`,
      accept: 'application/json, text/plain, */*',
      referer: `${BASE}/fleet`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      dnt: '1',
    },
  });

  async function get(path) {
    const res = await http.get(path);
    return res.data;
  }

  const api = {
    missions:             () => get('/api/fleet/missions'),
    incoming:             () => get('/api/fleet/incoming'),
    reports:              () => get('/api/fleet/reports'),
    surveyReports:        () => get('/api/fleet/survey-reports'),
    spyReports:           () => get('/api/fleet/spy-reports'),
    expeditionReports:    () => get('/api/fleet/expedition-reports'),
    patrolReports:        () => get('/api/fleet/patrol-reports'),
    fieldScanReports:     () => get('/api/fleet/field-scan-reports'),
    pirateCamps:          () => get('/api/fleet/pirate-camps'),
    pirateReports:        () => get('/api/fleet/pirate-reports'),
    systemDebris:         () => get('/api/fleet/system-debris'),
    wormholes:            () => get('/api/fleet/wormholes'),
    wormholeRuns:         () => get('/api/fleet/wormhole-runs'),
    miningReports:        () => get('/api/fleet/mining-reports'),
    colonizationReports:  () => get('/api/fleet/colonization-reports'),
    mineReports:          () => get('/api/fleet/mine-reports'),
    cyberReports:         () => get('/api/fleet/cyber-reports'),
    stationedGarrisons:   () => get('/api/fleet/stationed-garrisons'),
    surveyCooldowns:      () => get('/api/fleet/survey-cooldowns'),
    research:             () => get('/api/research'),
    outposts:             () => get('/api/outposts'),
    directives:           () => get('/api/directives'),
    galaxyArms:           () => get('/api/galaxy/arms'),
    galaxyColonyStatus:   () => get('/api/galaxy/colony-status'),
    moonColonyStatus:     () => get('/api/moons/colony-status'),
    marketHubs:           () => get('/api/market/hubs'),
    allianceChat:         () => get('/api/alliances/chat'),
    unreadMessages:       () => get('/api/messages/unread-count'),
    planet:         (id)  => get(`/api/planets/${id}`),
    planetFleet:    (id)  => get(`/api/planets/${id}/fleet`),
    planetShipyard: (id)  => get(`/api/planets/${id}/shipyard`),
  };

  return { api, get };
}

module.exports = { createClient };
