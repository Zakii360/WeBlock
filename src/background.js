'use strict';

const DEFAULTS = {
  enabled: true,
  whitelistDomains: [],
  liveRules: [],
  liveRulesUpdatedAt: 0,
  totalBlocked: 0
};

const LIVE_RULE_MIN_ID = 1;
const LIVE_RULE_MAX_ID = 5_000;
const WHITELIST_RULE_MIN_ID = 10_001;
const MAX_WHITELISTED_SITES = 2_000;
const LIVE_REFRESH_ALARM = 'weblock-filter-list-refresh';
const LIVE_LIST_URLS = [
  'https://easylist-downloads.adblockplus.org/easylist.txt',
  'https://easylist.to/easylist/easylist.txt'
];

let totalBlocked = 0;
let counterWriteQueue = Promise.resolve();

function normalizeHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!host || host.length > 253 || host.includes('/') || host.includes(':')) return null;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) return null;
  return host;
}

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

async function readSettings() {
  const values = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...values };
}

async function ensureDefaults() {
  const values = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (typeof values[key] === 'undefined') missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  const state = await readSettings();
  totalBlocked = Number(state.totalBlocked) || 0;
}

async function applyStaticRulesets(enabled) {
  const manifest = chrome.runtime.getManifest();
  const ids = (manifest.declarative_net_request?.rule_resources || []).map((item) => item.id);
  if (!ids.length) return;

  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enabled ? ids : [],
    disableRulesetIds: enabled ? [] : ids
  });
}

function stableRuleId(key, used) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let id = (hash >>> 0) % LIVE_RULE_MAX_ID + LIVE_RULE_MIN_ID;
  while (used.has(id)) {
    id = id >= LIVE_RULE_MAX_ID ? LIVE_RULE_MIN_ID : id + 1;
  }
  used.add(id);
  return id;
}

function parseLightweightRules(filterText) {
  const allowDomains = new Set();
  const blockDomains = new Set();
  const domainPattern = /^(?:\|\|)([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\^$/i;

  for (const rawLine of filterText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('!') || line.startsWith('[') || line.includes('$')) continue;

    if (line.startsWith('@@')) {
      const match = line.slice(2).match(domainPattern);
      if (match) {
        const domain = normalizeHost(match[1]);
        if (domain) allowDomains.add(domain);
      }
      continue;
    }

    const match = line.match(domainPattern);
    if (match) {
      const domain = normalizeHost(match[1]);
      if (domain) blockDomains.add(domain);
    }
  }

  // Exceptions are kept ahead of blocks and receive a higher priority.
  // The parser deliberately handles only exact domain rules; unsupported ABP
  // syntax remains covered by the compiled static rulesets.
  const candidates = [
    ...[...allowDomains].sort().map((domain) => ({ domain, action: 'allow', priority: 2 })),
    ...[...blockDomains].filter((domain) => !allowDomains.has(domain)).sort().map((domain) => ({ domain, action: 'block', priority: 1 }))
  ].slice(0, LIVE_RULE_MAX_ID);

  const used = new Set();
  return candidates.map((item) => ({
    id: stableRuleId(`${item.action}:${item.domain}`, used),
    priority: item.priority,
    action: { type: item.action },
    condition: { urlFilter: `||${item.domain}^` }
  }));
}

function sameRule(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function applyLiveRules(rules, enabled) {
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  const currentLive = current.filter((rule) => rule.id >= LIVE_RULE_MIN_ID && rule.id <= LIVE_RULE_MAX_ID);
  const desired = enabled ? rules : [];
  const desiredById = new Map(desired.map((rule) => [rule.id, rule]));
  const currentById = new Map(currentLive.map((rule) => [rule.id, rule]));

  const removeRuleIds = [];
  const addRules = [];

  for (const currentRule of currentLive) {
    const nextRule = desiredById.get(currentRule.id);
    if (!nextRule || !sameRule(currentRule, nextRule)) removeRuleIds.push(currentRule.id);
  }

  for (const nextRule of desired) {
    const currentRule = currentById.get(nextRule.id);
    if (!currentRule || !sameRule(currentRule, nextRule)) addRules.push(nextRule);
  }

  if (removeRuleIds.length || addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
}

async function applyWhitelistRules(domains) {
  const normalized = [...new Set(domains.map(normalizeHost).filter(Boolean))].slice(0, MAX_WHITELISTED_SITES);
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  const currentWhitelist = current.filter((rule) => rule.id >= WHITELIST_RULE_MIN_ID && rule.id < WHITELIST_RULE_MIN_ID + MAX_WHITELISTED_SITES);
  const removeRuleIds = currentWhitelist.map((rule) => rule.id);
  const addRules = normalized.map((domain, index) => ({
    id: WHITELIST_RULE_MIN_ID + index,
    priority: 1_000_000,
    action: { type: 'allowAllRequests' },
    condition: {
      requestDomains: [domain],
      resourceTypes: ['main_frame']
    }
  }));

  if (removeRuleIds.length || addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
  return normalized;
}

async function refreshLightweightRules() {
  const initialState = await readSettings();
  if (!initialState.enabled) return false;

  const errors = [];
  let filterText = null;

  for (const url of LIVE_LIST_URLS) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(45_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const candidate = await response.text();
      if (candidate.length < 500 || candidate.length > 15 * 1024 * 1024) {
        throw new Error('Unexpected filter-list size');
      }
      filterText = candidate;
      break;
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }

  if (filterText === null) {
    console.warn('[WeBlock] Live list refresh failed; keeping the last good rules.', errors.join(' | '));
    return false;
  }

  const rules = parseLightweightRules(filterText);
  if (!rules.length) {
    console.warn('[WeBlock] Live list had no supported domain rules; keeping the last good rules.');
    return false;
  }

  const state = await readSettings();
  await chrome.storage.local.set({ liveRules: rules, liveRulesUpdatedAt: Date.now() });
  await applyLiveRules(rules, state.enabled);
  console.info(`[WeBlock] Refreshed ${rules.length} lightweight rules.`);
  return true;
}

async function syncAllRules() {
  const state = await readSettings();
  await applyStaticRulesets(Boolean(state.enabled));
  await applyLiveRules(Array.isArray(state.liveRules) ? state.liveRules : [], Boolean(state.enabled));
  const normalized = await applyWhitelistRules(Array.isArray(state.whitelistDomains) ? state.whitelistDomains : []);
  if (normalized.length !== (state.whitelistDomains || []).length) {
    await chrome.storage.local.set({ whitelistDomains: normalized });
  }
}

async function setEnabled(enabled) {
  const next = Boolean(enabled);
  await chrome.storage.local.set({ enabled: next });
  await applyStaticRulesets(next);
  const state = await readSettings();
  await applyLiveRules(state.liveRules || [], next);
  if (next && Date.now() - Number(state.liveRulesUpdatedAt || 0) > 23 * 60 * 60 * 1_000) {
    refreshLightweightRules().catch((error) => console.warn('[WeBlock] Live refresh after enabling failed:', error));
  }
  return next;
}

async function setSiteWhitelist(host, shouldWhitelist) {
  const domain = normalizeHost(host);
  if (!domain) throw new Error('This page does not have a supported website address.');
  const state = await readSettings();
  let domains = Array.isArray(state.whitelistDomains) ? state.whitelistDomains.map(normalizeHost).filter(Boolean) : [];

  if (shouldWhitelist) {
    if (!domains.some((item) => hostMatches(domain, item))) domains = [...new Set([...domains, domain])];
  } else {
    // Remove any stored parent-domain entry that currently pauses this host,
    // not just an exact subdomain match.
    domains = domains.filter((item) => !hostMatches(domain, item));
  }

  if (domains.length > MAX_WHITELISTED_SITES) {
    throw new Error(`WeBlock supports up to ${MAX_WHITELISTED_SITES.toLocaleString()} paused sites.`);
  }

  const normalized = await applyWhitelistRules(domains);
  await chrome.storage.local.set({ whitelistDomains: normalized });
  return normalized;
}

async function readCounterState(tabId) {
  const [local, session] = await Promise.all([
    chrome.storage.local.get({ totalBlocked: 0 }),
    chrome.storage.session.get({ tabBlocked: {} })
  ]);
  const tabBlocked = session.tabBlocked || {};
  return {
    totalBlocked: Number(local.totalBlocked) || 0,
    tabBlocked: Number(tabBlocked[String(tabId)] || 0),
    counterAvailable: Boolean(chrome.declarativeNetRequest.onRuleMatchedDebug)
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await ensureDefaults();
    await syncAllRules();
    chrome.alarms.create(LIVE_REFRESH_ALARM, { periodInMinutes: 1_440 });
    await refreshLightweightRules();
  } catch (error) {
    console.error('[WeBlock] Installation setup failed:', error);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await ensureDefaults();
    await syncAllRules();
    chrome.alarms.create(LIVE_REFRESH_ALARM, { periodInMinutes: 1_440 });
    const state = await readSettings();
    if (Date.now() - Number(state.liveRulesUpdatedAt || 0) > 23 * 60 * 60 * 1_000) {
      await refreshLightweightRules();
    }
  } catch (error) {
    console.error('[WeBlock] Startup sync failed:', error);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== LIVE_REFRESH_ALARM) return;
  refreshLightweightRules().catch((error) => console.warn('[WeBlock] Scheduled refresh failed:', error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== 'string') throw new Error('Invalid request.');

    if (message.type === 'get-state') {
      const host = normalizeHost(message.host);
      const state = await readSettings();
      const counts = await readCounterState(Number(message.tabId));
      return {
        enabled: Boolean(state.enabled),
        whitelisted: host ? (state.whitelistDomains || []).some((domain) => hostMatches(host, domain)) : false,
        host,
        whitelistDomains: state.whitelistDomains || [],
        liveRulesUpdatedAt: state.liveRulesUpdatedAt || 0,
        ...counts
      };
    }

    if (message.type === 'set-enabled') {
      return { enabled: await setEnabled(message.enabled) };
    }

    if (message.type === 'set-whitelist') {
      const domains = await setSiteWhitelist(message.host, Boolean(message.whitelisted));
      return { whitelistDomains: domains, whitelisted: domains.includes(normalizeHost(message.host)) };
    }

    throw new Error('Unknown request.');
  })().then(sendResponse).catch((error) => sendResponse({ error: error.message || 'WeBlock could not complete that action.' }));
  return true;
});

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    if (info?.rule?.action?.type !== 'block') return;
    const tabId = info.request?.tabId;
    if (!Number.isInteger(tabId) || tabId < 0) return;

    counterWriteQueue = counterWriteQueue.then(async () => {
      // Read the persisted total for every increment because MV3 service workers
      // can be suspended and restarted between blocked requests.
      const [local, session] = await Promise.all([
        chrome.storage.local.get({ totalBlocked: 0 }),
        chrome.storage.session.get({ tabBlocked: {} })
      ]);
      const nextTotal = (Number(local.totalBlocked) || 0) + 1;
      const tabBlocked = session.tabBlocked || {};
      tabBlocked[String(tabId)] = (Number(tabBlocked[String(tabId)]) || 0) + 1;
      totalBlocked = nextTotal;
      await Promise.all([
        chrome.storage.local.set({ totalBlocked: nextTotal }),
        chrome.storage.session.set({ tabBlocked })
      ]);
      await chrome.action.setBadgeBackgroundColor({ color: '#a8e66b', tabId });
      await chrome.action.setBadgeText({ text: String(tabBlocked[String(tabId)]), tabId });
    }).catch((error) => console.warn('[WeBlock] Counter update failed:', error));
  });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await chrome.storage.session.get({ tabBlocked: {} });
  const tabBlocked = session.tabBlocked || {};
  delete tabBlocked[String(tabId)];
  await chrome.storage.session.set({ tabBlocked });
});

ensureDefaults().catch((error) => console.error('[WeBlock] Could not initialize settings:', error));
