'use strict';

const elements = {
  powerToggle: document.getElementById('power-toggle'),
  powerDescription: document.getElementById('power-description'),
  siteHost: document.getElementById('site-host'),
  siteToggle: document.getElementById('site-toggle'),
  pageCount: document.getElementById('page-count'),
  totalCount: document.getElementById('total-count'),
  counterNote: document.getElementById('counter-note'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  updatedText: document.getElementById('updated-text'),
  errorMessage: document.getElementById('error-message')
};

let currentTabId = null;
let currentHost = null;
let currentState = null;
let busy = false;

function setError(message = '') {
  elements.errorMessage.textContent = message;
  elements.errorMessage.hidden = !message;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatUpdatedAt(timestamp) {
  if (!timestamp) return 'Filter sync pending';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Filter sync pending';
  return `Synced ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function render(state) {
  currentState = state;
  const enabled = Boolean(state.enabled);
  elements.powerToggle.setAttribute('aria-checked', String(enabled));
  elements.powerDescription.textContent = enabled
    ? 'WeBlock is protecting this browser.'
    : 'Ad and tracker blocking is paused.';

  elements.statusDot.classList.toggle('off', !enabled);
  elements.statusText.textContent = enabled ? 'Protection is on' : 'Protection is off';

  elements.siteHost.textContent = currentHost || 'This tab cannot be filtered';
  elements.siteToggle.disabled = !currentHost || busy;
  elements.siteToggle.textContent = state.whitelisted ? 'Resume' : 'Pause';
  elements.siteToggle.setAttribute('aria-pressed', String(Boolean(state.whitelisted)));

  elements.pageCount.textContent = state.counterAvailable ? formatNumber(state.tabBlocked) : '—';
  elements.totalCount.textContent = state.counterAvailable ? formatNumber(state.totalBlocked) : '—';
  elements.counterNote.textContent = state.counterAvailable
    ? 'Live blocked-request counters for this unpacked build.'
    : 'Exact request counters are only exposed by Chrome in unpacked developer builds.';
  elements.updatedText.textContent = formatUpdatedAt(state.liveRulesUpdatedAt);
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || response.error) throw new Error(response?.error || 'WeBlock did not respond.');
  return response;
}

async function refresh() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  currentTabId = Number.isInteger(tab?.id) ? tab.id : null;
  currentHost = null;

  try {
    const url = new URL(tab?.url || '');
    if (url.protocol === 'http:' || url.protocol === 'https:') currentHost = url.hostname.toLowerCase();
  } catch {
    currentHost = null;
  }

  const state = await send({
    type: 'get-state',
    host: currentHost,
    tabId: currentTabId
  });
  render(state);
}

async function runAction(action) {
  if (busy) return;
  busy = true;
  elements.powerToggle.disabled = true;
  elements.siteToggle.disabled = true;
  setError();

  try {
    await action();
    await refresh();
  } catch (error) {
    setError(error.message || 'Something went wrong.');
  } finally {
    busy = false;
    elements.powerToggle.disabled = false;
    elements.siteToggle.disabled = !currentHost;
    if (currentState) render(currentState);
  }
}

elements.powerToggle.addEventListener('click', () => {
  if (!currentState) return;
  runAction(() => send({ type: 'set-enabled', enabled: !currentState.enabled }));
});

elements.siteToggle.addEventListener('click', () => {
  if (!currentHost || !currentState) return;
  runAction(() => send({
    type: 'set-whitelist',
    host: currentHost,
    whitelisted: !currentState.whitelisted
  }));
});

refresh().catch((error) => {
  elements.statusDot.classList.add('off');
  elements.statusText.textContent = 'Could not load status';
  setError(error.message || 'Open a normal website and try again.');
});
