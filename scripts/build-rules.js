'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { convertFilter } = require('@eyeo/abp2dnr');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'src');
const FILTER_DIR = path.join(ROOT, 'filter-lists');
const DIST_DIR = path.join(ROOT, 'dist');

// Chrome guarantees an aggregate minimum of 30,000 enabled static rules per
// extension. We cap WeBlock at that guaranteed baseline rather than assuming
// that optional shared quota will always be available.
const MAX_TOTAL_STATIC_RULES = 30_000;
const RULES_PER_RULESET = 7_500;
const SOURCE_RULE_BUDGETS = {
  'easylist.txt': 10_000,
  'easyprivacy.txt': 5_000,
  'ubo-filters.txt': 8_000,
  'ubo-annoyances-others.txt': 3_000,
  'ubo-annoyances-cookies.txt': 2_000,
  'ubo-quick-fixes.txt': 1_000,
  'ubo-unbreak.txt': 1_000
};
const MAX_COSMETIC_RULES = 12_000;
const MAX_COSMETIC_EXCEPTIONS = 4_000;

const FILTER_FILES = [
  'easylist.txt',
  'easyprivacy.txt',
  'ubo-filters.txt',
  'ubo-annoyances-others.txt',
  'ubo-annoyances-cookies.txt',
  'ubo-quick-fixes.txt',
  'ubo-unbreak.txt'
];

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function isCosmeticLine(line) {
  return line.includes('##') || line.includes('#@#') || line.includes('#?#') || line.includes('#$#') || line.includes('#%#');
}

function parseCosmeticLine(line) {
  let delimiter = null;
  let type = null;

  for (const candidate of ['#@#', '##']) {
    const index = line.indexOf(candidate);
    if (index >= 0 && (delimiter === null || index < delimiter.index)) {
      delimiter = { index, token: candidate };
      type = candidate === '#@#' ? 'exception' : 'hide';
    }
  }

  if (!delimiter) return null;

  const domainPart = line.slice(0, delimiter.index).trim();
  const selector = line.slice(delimiter.index + delimiter.token.length).trim();

  // Procedural cosmetic syntax and scriptlet syntax are intentionally not
  // treated as plain CSS. They need a dedicated engine and must not be emitted
  // as arbitrary executable code.
  if (!selector || selector.length > 600 || /^\+js\(/i.test(selector) || /:has-text\(|:matches-css\(|:xpath\(|:remove\(|:style\(/i.test(selector)) {
    return null;
  }
  if (/[{}<>\u0000-\u001f]/.test(selector) || selector.includes('</style')) {
    return null;
  }

  const domains = [];
  const excludedDomains = [];
  if (domainPart) {
    for (const rawDomain of domainPart.split(',')) {
      const entry = rawDomain.trim().toLowerCase();
      if (!entry) continue;
      const excluded = entry.startsWith('~');
      const domain = (excluded ? entry.slice(1) : entry).replace(/^\.+|\.+$/g, '');
      if (domain !== '*' && !/^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|\*)\.)*(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|\*)$/.test(domain)) {
        continue;
      }
      (excluded ? excludedDomains : domains).push(domain);
    }
  }

  if (domainPart && domains.length === 0 && excludedDomains.length === 0) return null;

  return {
    type,
    domains: [...new Set(domains)],
    excludedDomains: [...new Set(excludedDomains)],
    selector
  };
}

function isCandidateNetworkFilter(line) {
  if (!line || line.startsWith('!') || line.startsWith('[')) return false;
  if (isCosmeticLine(line)) return false;
  if (line.startsWith('##') || line.startsWith('#')) return false;
  return true;
}

function isValidDnrRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
  if (!rule.action || !['block', 'allow', 'allowAllRequests', 'upgradeScheme', 'redirect'].includes(rule.action.type)) return false;
  if (!rule.condition || typeof rule.condition !== 'object' || Array.isArray(rule.condition)) return false;
  if (!Number.isInteger(rule.priority) || rule.priority < 1) rule.priority = 1;
  return true;
}

async function ensureFilterLists() {
  await fs.mkdir(FILTER_DIR, { recursive: true });
  const missing = [];
  for (const file of FILTER_FILES) {
    try {
      const stat = await fs.stat(path.join(FILTER_DIR, file));
      if (!stat.isFile() || stat.size < 100) missing.push(file);
    } catch {
      missing.push(file);
    }
  }

  if (missing.length) {
    console.log(`Missing filter lists (${missing.join(', ')}); fetching upstream copies...`);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fetch-lists.js')], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env
    });
    if (result.status !== 0) {
      throw new Error('Filter-list download failed. Run "npm run fetch:lists" and retry the build.');
    }
  }
}

async function loadFilterLines() {
  const all = [];
  for (const file of FILTER_FILES) {
    const fullPath = path.join(FILTER_DIR, file);
    const text = await fs.readFile(fullPath, 'utf8');
    all.push({ file, lines: text.replace(/^\uFEFF/, '').split(/\r?\n/) });
  }
  return all;
}

async function main() {
  await ensureFilterLists();
  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(DIST_DIR, { recursive: true });
  await fs.cp(SOURCE_DIR, DIST_DIR, { recursive: true });

  const sources = await loadFilterLines();
  const seenNetworkRules = new Set();
  const networkRules = [];
  const seenCosmetics = new Set();
  const cosmetics = { hide: [], exceptions: [] };
  let sourceLines = 0;
  let cosmeticSkipped = 0;
  let networkSkipped = 0;
  let conversionErrors = 0;

  // Extract cosmetic selectors in a separate pass so a full network-rule
  // budget cannot accidentally starve later lists of cosmetic filters.
  for (const source of sources) {
    for (const rawLine of source.lines) {
      sourceLines += 1;
      const line = rawLine.trim();
      if (!line || !isCosmeticLine(line)) continue;

      const parsed = parseCosmeticLine(line);
      if (!parsed) {
        cosmeticSkipped += 1;
        continue;
      }

      const key = stableStringify(parsed);
      if (seenCosmetics.has(key)) continue;
      seenCosmetics.add(key);

      if (parsed.type === 'hide' && cosmetics.hide.length < MAX_COSMETIC_RULES) {
        cosmetics.hide.push({ domains: parsed.domains, excludedDomains: parsed.excludedDomains, selector: parsed.selector });
      } else if (parsed.type === 'exception' && cosmetics.exceptions.length < MAX_COSMETIC_EXCEPTIONS) {
        cosmetics.exceptions.push({ domains: parsed.domains, excludedDomains: parsed.excludedDomains, selector: parsed.selector });
      } else {
        cosmeticSkipped += 1;
      }
    }
  }

  for (const source of sources) {
    console.log(`\nProcessing ${source.file}...`);
    let convertedInSource = 0;
    const sourceBudget = SOURCE_RULE_BUDGETS[source.file] || 0;

    for (const rawLine of source.lines) {
      const line = rawLine.trim();
      if (!isCandidateNetworkFilter(line)) continue;
      if (networkRules.length >= MAX_TOTAL_STATIC_RULES || convertedInSource >= sourceBudget) break;

      try {
        const converted = await convertFilter(line);
        if (!Array.isArray(converted) || converted.length === 0) {
          networkSkipped += 1;
          continue;
        }

        for (const candidate of converted) {
          if (!isValidDnrRule(candidate)) {
            networkSkipped += 1;
            continue;
          }
          const normalized = { ...candidate };
          delete normalized.id;
          const key = stableStringify(normalized);
          if (seenNetworkRules.has(key)) continue;
          seenNetworkRules.add(key);
          if (networkRules.length >= MAX_TOTAL_STATIC_RULES || convertedInSource >= sourceBudget) break;
          networkRules.push(normalized);
          convertedInSource += 1;
        }
      } catch {
        conversionErrors += 1;
      }
    }

    console.log(`  Added ${convertedInSource.toLocaleString()} network rules (source budget: ${sourceBudget.toLocaleString()})`);
  }

  if (networkRules.length === 0) {
    throw new Error('No valid network rules were compiled. Check the downloaded filter lists and converter dependency.');
  }

  const ruleResources = [];
  let nextId = 1;
  let setNumber = 1;
  for (let offset = 0; offset < networkRules.length; offset += RULES_PER_RULESET) {
    const chunk = networkRules.slice(offset, offset + RULES_PER_RULESET).map((rule) => ({
      ...rule,
      id: nextId++
    }));

    const fileName = `rules-${String(setNumber).padStart(2, '0')}.json`;
    await fs.writeFile(path.join(DIST_DIR, fileName), `${JSON.stringify(chunk)}\n`, 'utf8');
    ruleResources.push({
      id: `weblock_rules_${String(setNumber).padStart(2, '0')}`,
      enabled: true,
      path: fileName
    });
    setNumber += 1;
  }

  const cosmeticData = {
    version: 1,
    generatedAt: new Date().toISOString(),
    hide: cosmetics.hide,
    exceptions: cosmetics.exceptions
  };
  const cosmeticJs = `/* Generated by scripts/build-rules.js. Do not edit by hand. */\nglobalThis.WeBlockCosmeticData = ${JSON.stringify(cosmeticData)};\n`;
  await fs.writeFile(path.join(DIST_DIR, 'cosmetic-data.js'), cosmeticJs, 'utf8');

  const manifestPath = path.join(DIST_DIR, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.declarative_net_request = { rule_resources: ruleResources };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const summary = {
    buildVersion: manifest.version,
    builtAt: new Date().toISOString(),
    sourceFiles: FILTER_FILES,
    sourceLines,
    staticNetworkRules: networkRules.length,
    staticRulesets: ruleResources.length,
    rulesPerRuleset: RULES_PER_RULESET,
    cosmeticHideRules: cosmetics.hide.length,
    cosmeticExceptions: cosmetics.exceptions.length,
    cosmeticRulesSkipped: cosmeticSkipped,
    networkRulesSkipped: networkSkipped,
    conversionErrors,
    sourceRuleBudgets: SOURCE_RULE_BUDGETS
  };
  await fs.writeFile(path.join(DIST_DIR, 'build-info.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log('\nWeBlock build complete.');
  console.log(`  Static network rules: ${networkRules.length.toLocaleString()}`);
  console.log(`  Static rulesets: ${ruleResources.length}`);
  console.log(`  Cosmetic hide rules: ${cosmetics.hide.length.toLocaleString()}`);
  console.log(`  Cosmetic exceptions: ${cosmetics.exceptions.length.toLocaleString()}`);
  console.log(`  Unsupported/invalid cosmetic filters skipped: ${cosmeticSkipped.toLocaleString()}`);
  console.log(`  Unsupported/invalid network filters skipped: ${networkSkipped.toLocaleString()}`);
  console.log(`  Converter errors skipped: ${conversionErrors.toLocaleString()}`);
  console.log(`  Output: ${DIST_DIR}`);
}

main().catch((error) => {
  console.error(`\nBuild failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
