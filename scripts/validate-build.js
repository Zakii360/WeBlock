'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid or unreadable JSON at ${path.relative(ROOT, filePath)}: ${error.message}`);
  }
}

function checkFile(relativePath, base = DIST) {
  const fullPath = path.join(base, relativePath);
  assert(fs.existsSync(fullPath) && fs.statSync(fullPath).isFile(), `Missing file: ${path.relative(ROOT, fullPath)}`);
}

function main() {
  assert(fs.existsSync(DIST), 'dist/ does not exist. Run "npm run build" first.');

  const manifest = readJson(path.join(DIST, 'manifest.json'));
  assert(manifest.manifest_version === 3, 'The extension must use Manifest V3.');
  assert(manifest.name === 'WeBlock', 'Unexpected extension name.');
  assert(Array.isArray(manifest.declarative_net_request?.rule_resources), 'Manifest is missing generated DNR rulesets.');
  assert(manifest.declarative_net_request.rule_resources.length > 0, 'No DNR rulesets were generated.');
  assert(manifest.declarative_net_request.rule_resources.length <= 50, 'Too many enabled static rulesets.');

  for (const relativePath of Object.values(manifest.icons || {})) checkFile(relativePath);
  checkFile(manifest.background.service_worker);
  checkFile(manifest.action.default_popup);

  for (const scriptGroup of manifest.content_scripts || []) {
    for (const script of scriptGroup.js || []) checkFile(script);
    for (const css of scriptGroup.css || []) checkFile(css);
  }

  for (const resourceGroup of manifest.web_accessible_resources || []) {
    for (const resource of resourceGroup.resources || []) checkFile(resource);
  }

  let totalRules = 0;
  for (const ruleset of manifest.declarative_net_request.rule_resources) {
    checkFile(ruleset.path);
    const rules = readJson(path.join(DIST, ruleset.path));
    assert(Array.isArray(rules), `${ruleset.path} must contain a JSON array.`);
    assert(rules.length <= 30_000, `${ruleset.path} exceeds the 30,000 rule per-file guardrail.`);

    const ids = new Set();
    for (const rule of rules) {
      assert(Number.isInteger(rule.id) && rule.id > 0, `${ruleset.path} contains a rule with an invalid id.`);
      assert(!ids.has(rule.id), `${ruleset.path} contains duplicate rule id ${rule.id}.`);
      ids.add(rule.id);
      assert(Number.isInteger(rule.priority) && rule.priority >= 1, `${ruleset.path} contains an invalid priority.`);
      assert(rule.action && typeof rule.action.type === 'string', `${ruleset.path} contains a rule without an action.`);
      assert(rule.condition && typeof rule.condition === 'object', `${ruleset.path} contains a rule without a condition.`);
    }
    totalRules += rules.length;
  }

  assert(totalRules > 0, 'The generated static rulesets are empty.');
  assert(totalRules <= 30_000, `Static rule total (${totalRules}) exceeds WeBlock's guaranteed-baseline cap.`);
  checkFile('cosmetic-data.js');
  checkFile('cosmetic.css');
  checkFile('content.js');
  checkFile('scriptlets.js');
  const buildInfo = readJson(path.join(DIST, 'build-info.json'));
  assert(buildInfo.staticNetworkRules === totalRules, 'build-info.json does not match the compiled rule count.');

  console.log('WeBlock build validation passed.');
  console.log(`  ${manifest.declarative_net_request.rule_resources.length} static ruleset(s)`);
  console.log(`  ${totalRules.toLocaleString()} static network rule(s)`);
  console.log(`  ${Number(buildInfo.cosmeticHideRules || 0).toLocaleString()} cosmetic hide rule(s)`);
}

try {
  main();
} catch (error) {
  console.error(`Validation failed: ${error.message}`);
  process.exitCode = 1;
}
