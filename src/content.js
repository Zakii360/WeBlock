(() => {
  'use strict';

  if (!globalThis.chrome?.runtime?.id) return;

  const BASE_STYLE_ID = 'weblock-base-style';
  const FILTER_STYLE_ID = 'weblock-filter-style';
  const QUICK_HIDE_SELECTOR = [
    '[data-ad-slot]',
    '[data-ad-client]',
    'ins.adsbygoogle',
    '.adsbygoogle',
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]',
    '[aria-label="Advertisement"]',
    '[aria-label="advertisement"]',
    '[aria-label="Sponsored"]',
    '[data-testid="ad"]',
    '[data-testid="sponsored"]'
  ].join(',');

  const hostname = location.hostname.toLowerCase();
  let enabled = true;
  let pausedForSite = false;
  let observer = null;
  let rootObserver = null;
  let baseStyle = null;
  let filterStyle = null;
  let lastCss = '';

  function domainMatches(host, domain) {
    if (domain === '*') return true;
    if (domain.startsWith('*.')) {
      const suffix = domain.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    if (!domain.includes('*')) return host === domain || host.endsWith(`.${domain}`);
    const escaped = domain.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+');
    return new RegExp(`^${escaped}$`, 'i').test(host);
  }

  function ruleMatchesHost(rule) {
    const domains = Array.isArray(rule.domains) ? rule.domains : [];
    const excluded = Array.isArray(rule.excludedDomains) ? rule.excludedDomains : [];
    if (domains.length && !domains.some((domain) => domainMatches(hostname, domain))) return false;
    if (excluded.some((domain) => domainMatches(hostname, domain))) return false;
    return true;
  }

  function getCosmeticCss() {
    const data = globalThis.WeBlockCosmeticData || {};
    const hideRules = Array.isArray(data.hide) ? data.hide : [];
    const exceptions = Array.isArray(data.exceptions) ? data.exceptions : [];
    const exceptionSelectors = new Set(
      exceptions.filter(ruleMatchesHost).map((rule) => rule.selector)
    );

    const selectors = [];
    const seen = new Set();
    for (const rule of hideRules) {
      if (!rule || typeof rule.selector !== 'string' || !ruleMatchesHost(rule)) continue;
      const selector = rule.selector.trim();
      if (!selector || selector.length > 600 || seen.has(selector) || exceptionSelectors.has(selector)) continue;
      if (/[{}<>\u0000-\u001f]/.test(selector) || selector.includes('</style')) continue;
      seen.add(selector);
      selectors.push(`${selector}{display:none!important;visibility:hidden!important;}`);
    }
    return selectors.join('\n');
  }

  function ensureStyles() {
    const root = document.documentElement;
    if (!root) return false;

    if (!baseStyle) {
      baseStyle = document.createElement('link');
      baseStyle.id = BASE_STYLE_ID;
      baseStyle.rel = 'stylesheet';
      baseStyle.href = chrome.runtime.getURL('cosmetic.css');
      baseStyle.disabled = !enabled || pausedForSite;
      root.appendChild(baseStyle);
    }

    if (!filterStyle) {
      filterStyle = document.createElement('style');
      filterStyle.id = FILTER_STYLE_ID;
      filterStyle.type = 'text/css';
      filterStyle.textContent = getCosmeticCss();
      lastCss = filterStyle.textContent;
      filterStyle.disabled = !enabled || pausedForSite;
      root.appendChild(filterStyle);
    }

    return true;
  }

  function markAdNodes(root) {
    if (!root || !enabled || pausedForSite) return;

    try {
      if (root.nodeType === Node.ELEMENT_NODE && root.matches(QUICK_HIDE_SELECTOR)) {
        root.setAttribute('data-weblock-hidden', '1');
      }
      if (typeof root.querySelectorAll === 'function') {
        const nodes = root.querySelectorAll(QUICK_HIDE_SELECTOR);
        for (const node of nodes) node.setAttribute('data-weblock-hidden', '1');
      }
    } catch {
      // A site can mutate its DOM while the observer is processing it.
    }
  }

  function startObserver() {
    if (observer || !document.documentElement || !enabled || pausedForSite) return;
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) markAdNodes(node);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
  }

  function applyState() {
    if (!ensureStyles()) {
      if (!rootObserver) {
        rootObserver = new MutationObserver(() => {
          if (document.documentElement && ensureStyles()) {
            rootObserver.disconnect();
            rootObserver = null;
            applyState();
          }
        });
        rootObserver.observe(document, { childList: true, subtree: true });
      }
      return;
    }

    const shouldApply = enabled && !pausedForSite;
    baseStyle.disabled = !shouldApply;
    filterStyle.disabled = !shouldApply;

    const nextCss = getCosmeticCss();
    if (nextCss !== lastCss) {
      filterStyle.textContent = nextCss;
      lastCss = nextCss;
    }

    if (shouldApply) {
      markAdNodes(document.documentElement);
      startObserver();
    } else {
      stopObserver();
    }
  }

  async function readState() {
    const values = await chrome.storage.local.get({ enabled: true, whitelistDomains: [] });
    enabled = Boolean(values.enabled);
    const domains = Array.isArray(values.whitelistDomains) ? values.whitelistDomains : [];
    pausedForSite = domains.some((domain) => domainMatches(hostname, String(domain).toLowerCase()));
    applyState();
  }

  readState().catch(() => applyState());

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!changes.enabled && !changes.whitelistDomains) return;
    readState().catch(() => applyState());
  });
})();
