'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'filter-lists');
const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

const SOURCES = [
  {
    file: 'easylist.txt',
    urls: [
      'https://easylist-downloads.adblockplus.org/easylist.txt',
      'https://easylist.to/easylist/easylist.txt'
    ]
  },
  {
    file: 'easyprivacy.txt',
    urls: [
      'https://easylist-downloads.adblockplus.org/easyprivacy.txt',
      'https://easylist.to/easylist/easyprivacy.txt'
    ]
  },
  {
    file: 'ubo-filters.txt',
    urls: [
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
      'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/filters.txt'
    ]
  },
  {
    file: 'ubo-annoyances-others.txt',
    urls: [
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-others.txt',
      'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/annoyances-others.txt'
    ]
  },
  {
    file: 'ubo-annoyances-cookies.txt',
    urls: [
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-cookies.txt',
      'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/annoyances-cookies.txt'
    ]
  },
  {
    file: 'ubo-quick-fixes.txt',
    urls: [
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt',
      'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/quick-fixes.txt'
    ]
  },
  {
    file: 'ubo-unbreak.txt',
    urls: [
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
      'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/unbreak.txt'
    ]
  }
];

async function download(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'WeBlock-FilterListBuilder/1.0 (+https://github.com/)',
      Accept: 'text/plain, */*;q=0.8'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_BYTES) {
    throw new Error(`Response is too large (${declaredLength} bytes)`);
  }

  const text = await response.text();
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_BYTES) {
    throw new Error(`Response is too large (${size} bytes)`);
  }

  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim() + '\n';
  const meaningfulLines = normalized
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('!') && !line.trim().startsWith('['));

  if (size < 500 || meaningfulLines.length < 5) {
    throw new Error(`Response did not look like a filter list (${size} bytes)`);
  }

  return normalized;
}

async function fetchSource(source) {
  const errors = [];

  for (const url of source.urls) {
    try {
      process.stdout.write(`Fetching ${source.file} from ${url} ... `);
      const content = await download(url);
      const destination = path.join(OUTPUT_DIR, source.file);
      const temporary = `${destination}.tmp`;
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, destination);
      console.log(`${Buffer.byteLength(content, 'utf8').toLocaleString()} bytes`);
      return;
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
      console.log(`failed (${error.message})`);
    }
  }

  throw new Error(`Could not update ${source.file}. Tried all mirrors:\n${errors.join('\n')}`);
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const results = await Promise.allSettled(SOURCES.map(fetchSource));
  const failures = results.filter((result) => result.status === 'rejected');

  if (failures.length) {
    for (const failure of failures) {
      console.error(`\n${failure.reason.message}`);
    }
    throw new Error(`${failures.length} filter list(s) failed to download. Existing files were left untouched for those lists.`);
  }

  console.log(`\nUpdated ${SOURCES.length} filter lists.`);
}

main().catch((error) => {
  console.error(`\nFilter-list update failed: ${error.message}`);
  process.exitCode = 1;
});
