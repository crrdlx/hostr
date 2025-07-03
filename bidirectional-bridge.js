const { SimplePool, finalizeEvent, getPublicKey } = require('nostr-tools');
const { Client, PrivateKey } = require('@hiveio/dhive');
const fs = require('fs');
const { writeFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const WebSocket = require('ws');
require('dotenv').config();

// Logging setup
const logStream = fs.createWriteStream('/tmp/hostr-bridge.log', { flags: 'a' });
const originalConsoleLog = console.log;
console.log = (...args) => {
  const message = `${new Date().toISOString()} ${args.join(' ')}`;
  logStream.write(message + '\n');
  originalConsoleLog(message);
};
console.log('Debug: Starting bidirectional-bridge.cjs v0.1.75');
console.log('Debug: Node.js version:', process.version);
console.log('Debug: Logging initialized');

// Version constant
const VERSION = '0.1.75';

// Set global WebSocket for nostr-tools
global.WebSocket = WebSocket;

// Load credentials
const HIVE_USERNAME = process.env.HIVE_USERNAME;
const HIVE_POSTING_KEY = process.env.HIVE_POSTING_KEY;
const NOSTR_PUBLIC_KEY = process.env.NOSTR_PUBLIC_KEY;
const NOSTR_PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY;

console.log(`Starting bidirectional bridge with Snaps, Waves, and Longform for Hive user: ${HIVE_USERNAME}, Nostr pubkey: ${NOSTR_PUBLIC_KEY}`);

if (!HIVE_USERNAME || !HIVE_POSTING_KEY || !NOSTR_PUBLIC_KEY || !NOSTR_PRIVATE_KEY) {
  throw new Error('Missing required environment variables in .env file');
}

// Hive setup
const hiveClient = new Client('https://api.hive.blog');

// Nostr setup
const relays = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://nostr.wine',
  'wss://relay.nostr.band',
  'wss://nostr.mom',
  'wss://offchain.pub',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://purplepag.es',
];
const pool = new SimplePool();

// Rate limiting and queue variables
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWO_MINUTES_MS = 2 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SHORTFORM_PER_DAY = 12;
const MAX_LONGFORM_PER_DAY = 2;
let lastHivePostTime = 0;
let dailySnapCount = 0;
let dailyLongformCount = 0;
let lastSnapDay = new Date().toDateString();
let nostrToHiveQueue = [];
let hiveToNostrQueue = [];
let nostrToHivePosting = false;
let hiveToNostrPosting = false;
let activeSnapContainer = { permlink: null, created: null };
let activeWavesContainer = { permlink: null, created: null };
let lastFrontEnd = 'snaps';
const frontEnds = ['snaps', 'waves'];
let frontEndIndex = 0;
const PROCESSED_PERMLINKS_FILE = 'processed_permlinks_shortform.json';
const PROCESSED_EVENTS_FILE = 'processed_nostr_events_shortform.json';
let processedHivePermlinks = new Set(fs.existsSync(PROCESSED_PERMLINKS_FILE) ? JSON.parse(fs.readFileSync(PROCESSED_PERMLINKS_FILE)) : []);
let processedNostrEvents = new Set(fs.existsSync(PROCESSED_EVENTS_FILE) ? JSON.parse(fs.readFileSync(PROCESSED_EVENTS_FILE)) : []);

// Atomic file write
function writeJsonFileSync(filePath, data) {
  const tempFile = join(tmpdir(), `temp-${Date.now()}-${Math.random().toString(36).substring(2)}.json`);
  try {
    writeFileSync(tempFile, JSON.stringify(data));
    fs.renameSync(tempFile, filePath);
  } catch (err) {
    console.error(`[Bridge] ❌ Error writing to ${filePath}:`, err.message);
    throw err;
  }
}

// Clean up old processed entries
function cleanProcessedEntries() {
  const now = Date.now();
  processedHivePermlinks = new Set([...processedHivePermlinks].filter(entry => {
    const [permlink, timestamp] = Array.isArray(entry) ? entry : [entry, now];
    return now - (timestamp || now) < SEVEN_DAYS_MS;
  }).map(entry => Array.isArray(entry) ? entry : [entry, now]));
  processedNostrEvents = new Set([...processedNostrEvents].filter(entry => {
    const [eventId, timestamp] = Array.isArray(entry) ? entry : [eventId, now];
    return now - (timestamp || now) < SEVEN_DAYS_MS;
  }).map(entry => Array.isArray(entry) ? entry : [eventId, now]));
  writeJsonFileSync(PROCESSED_PERMLINKS_FILE, [...processedHivePermlinks]);
  writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
}

// Reset daily counts
function resetDailyCounts() {
  const today = new Date().toDateString();
  if (today !== lastSnapDay) {
    dailySnapCount = 0;
    dailyLongformCount = 0;
    lastSnapDay = today;
    console.log('[Bridge] 📅 Reset daily Shortform and longform counts');
  }
}

// --- Utility Functions ---

function cleanContent(content) {
  let cleaned = content.replace(/<[^>]+>/g, '');
  cleaned = cleaned.replace(/posted via.*d\.buzz.*$/i, '');
  cleaned = cleaned.replace(/\s*\n\s*/g, '\n').trim();
  return cleaned;
}

function stripMarkdown(content) {
  let result = content;
  // Images
  result = result.replace(/!\[([^\]]*?)\]\(([^)]+)\)/g, '$2');
  result = result.replace(/!\[([^\]]*?)\]/g, '');
  result = result.replace(/!\[([^\]]*?)?/g, '');
  // Headings
  result = result.replace(/^#{1,6}\s*(.*)$/gm, '$1');
  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');
  // Bold and italic
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');
  // Code blocks and inline code
  result = result.replace(/```[^`]*```/g, '');
  result = result.replace(/`([^`]+)`/g, '$1');
  // Blockquotes
  result = result.replace(/^>\s*(.*)$/gm, '$1');
  // Lists
  result = result.replace(/^[-*]\s*(.*)$/gm, '$1');
  result = result.replace(/^\d+\.\s*(.*)$/gm, '$1');
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}\s*$/gm, '');
  // Tables
  result = result.replace(/^\|.*\|$/gm, (match) => {
    return match.replace(/\|/g, ' ').trim();
  });
  result = result.replace(/^-+\|-+$/gm, '');
  // Nested lists
  result = result.replace(/^\s*[-*]\s*(.*)$/gm, '$1');
  // Clean up extra newlines and trim
  result = result.replace(/\n\s*\n/g, '\n').trim();
  return result;
}

function isCrossPost(content) {
  const regex = /auto\s*cross-post\s*(?:from\s*(?:hive|nostr)\s*)?via\s*hostr\s*(?:v[\d.]+)?\s*(?:\((?:br|lf)\))?|view\s*the\s*original\s*(?:post|article)\s*over\s*on\s*\[?nostr\]?|originally\s*posted\s*on\s*hive\s*at\s*https:\/\/(peakd|hive|ecency)\.com/i;
  return regex.test(content);
}

function createNostrLink(eventId) {
  return `https://njump.me/${eventId}`;
}

function createHiveLink(author, permlink) {
  return `https://peakd.com/@${author}/${permlink}`;
}

function generateTitle(content, tags) {
  const titleTag = tags?.find(tag => tag[0] === 'title' && tag[1]);
  if (titleTag) {
    return titleTag[1].substring(0, 80);
  }
  const cleanContent = content.replace(/^#\s*/gm, '').trim();
  return cleanContent.substring(0, 80) || 'Untitled Nostr Article';
}

// --- Container Detection ---

async function getActiveSnapContainer() {
  try {
    const query = {
      tag: 'peak.snaps',
      limit: 1,
    };
    const [post] = await hiveClient.database.getDiscussions('blog', query);
    if (!post || post.author !== 'peak.snaps') {
      console.log('[Bridge] [Nostr→Hive] ⚠️ No valid Snap container found');
      return null;
    }
    const postTime = new Date(post.created + 'Z').getTime();
    if (!activeSnapContainer.permlink || postTime > new Date(activeSnapContainer.created + 'Z').getTime()) {
      activeSnapContainer = { permlink: post.permlink, created: post.created };
      console.log(`[Bridge] [Nostr→Hive] 📖 Updated active Snap container: ${post.permlink}, created=${post.created}`);
    }
    return activeSnapContainer.permlink;
  } catch (error) {
    console.error('[Bridge] [Nostr→Hive] ❌ Error fetching Snap container:', error.message);
    return null;
  }
}

async function getActiveWavesContainer() {
  try {
    const query = {
      tag: 'ecency.waves',
      limit: 1,
    };
    const [post] = await hiveClient.database.getDiscussions('blog', query);
    if (!post || post.author !== 'ecency.waves') {
      console.log('[Bridge] [Nostr→Hive] ⚠️ No valid Waves container found');
      return null;
    }
    const postTime = new Date(post.created + 'Z').getTime();
    if (!activeWavesContainer.permlink || postTime > new Date(activeWavesContainer.created + 'Z').getTime()) {
      activeWavesContainer = { permlink: post.permlink, created: post.created };
      console.log(`[Bridge] [Nostr→Hive] 📖 Updated active Waves container: ${post.permlink}, created=${post.created}`);
    }
    return activeWavesContainer.permlink;
  } catch (error) {
    console.error('[Bridge] [Nostr→Hive] ❌ Error fetching Waves container:', error.message);
    return null;
  }
}

// --- Nostr-to-Hive Functions ---

function isRecentEvent(event) {
  const now = Math.floor(Date.now() / 1000);
  const age = now - event.created_at;
  const isRecent = age < (5 * 60);
  if (!isRecent) {
    console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping old event (${Math.floor(age/60)}m ${age%60}s old): kind=${event.kind}, content="${event.content.substring(0, 30)}..."`);
  }
  return isRecent;
}

async function processNostrToHiveQueue() {
  if (nostrToHivePosting || nostrToHiveQueue.length === 0) {
    return;
  }

  resetDailyCounts();
  if (dailySnapCount >= MAX_SHORTFORM_PER_DAY && dailyLongformCount >= MAX_LONGFORM_PER_DAY) {
    console.log(`[Bridge] [Nostr→Hive] ⏳ Daily limits reached (Snaps: ${MAX_SHORTFORM_PER_DAY}, Longform: ${MAX_LONGFORM_PER_DAY}), waiting until tomorrow...`);
    setTimeout(processNostrToHiveQueue, 24 * 60 * 60 * 1000);
    return;
  }

  const now = Date.now();
  if (now - lastHivePostTime < FIVE_MINUTES_MS && lastHivePostTime !== 0) {
    const waitTime = FIVE_MINUTES_MS - (now - lastHivePostTime);
    console.log(`[Bridge] [Nostr→Hive] ⏳ Waiting ${Math.ceil(waitTime/1000)} seconds before posting due to Hive rate limit...`);
    setTimeout(processNostrToHiveQueue, waitTime);
    return;
  }

  nostrToHivePosting = true;
  const post = nostrToHiveQueue.shift();

  try {
    if (post.kind === 1) {
      const charCount = post.content.length;
      console.log(`[DEBUG] Nostr note content (${charCount} chars): "${post.content.substring(0, 50)}${charCount > 50 ? '...' : ''}"`);

      if (charCount >= 485) {
        // Top-level Hive post logic
        const result = await postToHiveAsTopLevel(post);
        processedNostrEvents.add([post.eventId, Date.now()]);
        writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
        dailyLongformCount++;
        lastHivePostTime = Date.now();
        console.log(`[Bridge] [Nostr→Hive] ✅ Posted as top-level Hive post (over 485 chars, ${charCount} chars)`);
        console.log(`[Bridge] [Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items remaining, Snaps today: ${dailySnapCount}/${MAX_SHORTFORM_PER_DAY}, Longform today: ${dailyLongformCount}/${MAX_LONGFORM_PER_DAY}`);
      } else {
        if (dailySnapCount >= MAX_SHORTFORM_PER_DAY) {
          console.log(`[Bridge] [Nostr→Hive] ⏳ Snap limit (${MAX_SHORTFORM_PER_DAY}) reached, skipping kind 1...`);
          nostrToHiveQueue.unshift(post);
          setTimeout(processNostrToHiveQueue, TWO_MINUTES_MS);
          return;
        }
        // --- Alternation logic ---
        let frontEnd = frontEnds[frontEndIndex];
        let containerPermlink = null;
        if (frontEnd === 'snaps') {
          containerPermlink = await getActiveSnapContainer();
        } else if (frontEnd === 'waves') {
          containerPermlink = await getActiveWavesContainer();
        }
        // If container not found, don't advance index, just retry later
        if (!containerPermlink) {
          nostrToHiveQueue.unshift(post);
          console.log(`[Bridge] [Nostr→Hive] ⏳ No active ${frontEnd} container, retrying in 2 minutes...`);
          setTimeout(processNostrToHiveQueue, TWO_MINUTES_MS);
          return;
        }
        // Advance index for next alternation
        const nextFrontEnd = frontEnds[(frontEndIndex + 1) % frontEnds.length];
        console.log(`[Bridge] [Nostr→Hive] Posted to: ${frontEnd}. Next will be: ${nextFrontEnd}`);
        frontEndIndex = (frontEndIndex + 1) % frontEnds.length;
        lastFrontEnd = frontEnd;

        const result = await postToHive(post.content, post.eventId, containerPermlink, frontEnd);
        processedNostrEvents.add([post.eventId, Date.now()]);
        writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
        dailySnapCount++;
        lastHivePostTime = Date.now();
        console.log(`[Bridge] [Nostr→Hive] ✅ Switched to front-end: ${lastFrontEnd}, event ${post.eventId}`);
        console.log(`[Bridge] [Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items remaining, Snaps today: ${dailySnapCount}/${MAX_SHORTFORM_PER_DAY}, Longform today: ${dailyLongformCount}/${MAX_LONGFORM_PER_DAY}, Posted to: ${frontEnd}`);
      }
    } else if (post.kind === 30023) {
      if (dailyLongformCount >= MAX_LONGFORM_PER_DAY) {
        console.log(`[Bridge] [Nostr→Hive] ⏳ Daily longform limit (${MAX_LONGFORM_PER_DAY}) reached, skipping kind 30023...`);
        nostrToHiveQueue.unshift(post);
        setTimeout(processNostrToHiveQueue, TWO_MINUTES_MS);
        return;
      }
      console.log(`[Bridge] [Nostr→Hive] ℹ️ Processing event ${post.eventId}, kind=30023`);
      const result = await postLongformToHive(post.content, post.eventId, post.tags);
      processedNostrEvents.add([post.eventId, Date.now()]);
      writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
      dailyLongformCount++;
      lastHivePostTime = Date.now();
      console.log(`[Bridge] [Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items remaining, Snaps today: ${dailySnapCount}/${MAX_SHORTFORM_PER_DAY}, Longform today: ${dailyLongformCount}/${MAX_LONGFORM_PER_DAY}`);
    }
  } catch (error) {
    console.error(`[Bridge] [Nostr→Hive] ❌ Error processing event ${post.eventId}:`, error.message);
    if (error.message?.includes('You may only post once every 5 minutes') || error.message?.includes('rate limit')) {
      nostrToHiveQueue.unshift(post);
      console.log(`[Bridge] [Nostr→Hive] ⏱️ Rate limit hit, requeuing event ${post.eventId} for retry after cooldown`);
      setTimeout(processNostrToHiveQueue, FIVE_MINUTES_MS);
    } else if (error.message?.includes('ECONNRESET')) {
      nostrToHiveQueue.unshift(post);
      console.log(`[Bridge] [Nostr→Hive] ⏱️ Network error, requeuing event ${post.eventId} for retry after cooldown`);
      setTimeout(processNostrToHiveQueue, FIVE_MINUTES_MS);
    } else {
      processedNostrEvents.add([post.eventId, Date.now()]);
      writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
      console.log(`[Bridge] [Nostr→Hive] ⚠️ Non-retryable error, marking event ${post.eventId} as processed to prevent retries`);
    }
  } finally {
    nostrToHivePosting = false;
    if (nostrToHiveQueue.length > 0) {
      console.log(`[Bridge] [Nostr→Hive] ℹ️ Scheduling next queue processing`);
      setTimeout(processNostrToHiveQueue, 100);
    }
  }
}

function queueNostrToHive(event) {
  const now = Math.floor(Date.now() / 1000);
  const age = now - event.created_at;
  if (processedNostrEvents.has(event.id) || [...processedNostrEvents].some(([id]) => id === event.id)) {
    console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping already processed event: kind=${event.kind}, id=${event.id}, age=${Math.floor(age/60)}m${age%60}s, content="${event.content.substring(0, 30)}..."`);
    return;
  }
  if (isCrossPost(event.content)) {
    console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping Hive-originated event: kind=${event.kind}, id=${event.id}, content="${event.content}"`);
    return;
  }
  if (event.kind !== 1 && event.kind !== 30023) {
    console.log(`[Bridge] [Nostr→Hive] ⏸️ Skipping unsupported event: kind=${event.kind}, id=${event.id}, content="${event.content.substring(0, 30)}..."`);
    return;
  }
  if (event.kind === 1 && event.tags.some(tag => tag[0] === 'e' || tag[0] === 'p')) {
    console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping kind 1 comment: id=${event.id}, age=${Math.floor(age/60)}m ${age%60}s, content="${event.content.substring(0, 30)}..."`);
    return;
  }
  // Check for .hostr keyword to skip the post for both kind 1 and 30023
  if (event.content.includes('.hostr')) {
    console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping event due to .hostr keyword: kind=${event.kind}, id=${event.id}, age=${Math.floor(age/60)}m${age%60}s, content="${event.content.substring(0, 30)}..."`);
    return;
  }
  const post = { content: event.content, eventId: event.id, kind: event.kind, tags: event.tags };
  if (!nostrToHiveQueue.some(item => item.eventId === event.id)) {
    nostrToHiveQueue.push(post);
    console.log(`[Bridge] [Nostr→Hive] 📖 Added to queue: kind=${event.kind}, id=${event.id}, age=${Math.floor(age/60)}m${age%60}s, content="${event.content.substring(0, 30)}..."`);
    console.log(`[Bridge] [Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items waiting`);
    setTimeout(processNostrToHiveQueue, 0);
  }
}

async function postToHive(content, eventId, containerPermlink, frontEnd) {
  console.log(`[Bridge] [Nostr→Hive] 📤 Attempting to post to Hive ${frontEnd}: content="${content.substring(0, 30)}..."`);
  const permlink = `hostr-${frontEnd}-${Math.random().toString(36).substring(2)}`;
  const nostrLink = createNostrLink(eventId);
  // Detect and separate image URLs
  const imageRegex = /(https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp))/gi;
  const images = content.match(imageRegex) || [];
  let textContent = content;
  images.forEach(image => {
    textContent = textContent.replace(image, '').trim();
  });
  const imageSection = images.length > 0 ? `\n\n${images.join('\n')}` : '';
  const body = `${textContent}${imageSection}\n\nBridged via [Hostr](https://github.com/crrdlx/hostr), view [original on Nostr](${nostrLink}).`;
  const jsonMetadata = JSON.stringify({ 
    tags: ['hostr', `hostr-${frontEnd}`], 
    app: `hostr-${frontEnd}/1.0` 
  });

  const postOp = {
    parent_author: frontEnd === 'snaps' ? 'peak.snaps' : 'ecency.waves',
    parent_permlink: containerPermlink,
    author: HIVE_USERNAME,
    permlink,
    title: '',
    body,
    json_metadata: jsonMetadata,
  };

  try {
    const result = await hiveClient.broadcast.comment(
      postOp,
      PrivateKey.fromString(HIVE_POSTING_KEY)
    );
    console.log(`[Bridge] [Nostr→Hive] ✅ Posted to Hive ${frontEnd}: ${result.id}, Permlink: ${permlink}, Container: ${containerPermlink}, Nostr Link: ${nostrLink}`);
    return result;
  } catch (error) {
    console.error(`[Bridge] [Nostr→Hive] ❌ Error posting to Hive ${frontEnd}:`, error.message);
    throw error;
  }
}

async function postLongformToHive(content, eventId, tags) {
  console.log(`[Bridge] [Nostr→Hive] 📤 Attempting to post longform to Hive: content="${content.substring(0, 30)}..."`);
  const permlink = `hostr-longform-${Math.random().toString(36).substring(2)}`;
  const title = generateTitle(content, tags);
  const nostrLink = createNostrLink(eventId);
  const body = `${content}\n\nBridged via [Hostr](https://github.com/crrdlx/hostr), view [original on Nostr](${nostrLink}).`;
  const jsonMetadata = JSON.stringify({
    tags: ['hostr', 'longform'],
    app: 'hostr-longform/1.0'
  });

  const postOp = {
    parent_author: '',
    parent_permlink: 'hostr',
    author: HIVE_USERNAME,
    permlink,
    title,
    body,
    json_metadata: jsonMetadata,
  };

  try {
    const result = await hiveClient.broadcast.comment(
      postOp,
      PrivateKey.fromString(HIVE_POSTING_KEY)
    );
    console.log(`[Bridge] [Nostr→Hive] ✅ Posted longform to Hive: ${result.id}, Permlink: ${permlink}, Title: "${title}", Nostr Link: ${nostrLink}`);
    return result;
  } catch (error) {
    console.error('[Bridge] [Nostr→Hive] ❌ Error posting longform to Hive:', error.message);
    throw error;
  }
}

async function postToHiveAsTopLevel(post) {
  console.log(`[Bridge] [Nostr→Hive] 📤 Attempting to post top-level to Hive: content="${post.content.substring(0, 30)}..."`);
  const title = generateTitle(post.content, post.tags);
  const permlink = `hostr-top-${Math.random().toString(36).substring(2)}`;
  const nostrLink = createNostrLink(post.eventId);
  const body = `${post.content}\n\nBridged via [Hostr](https://github.com/crrdlx/hostr), view [original on Nostr](${nostrLink}).`;
  const jsonMetadata = JSON.stringify({
    tags: ['hostr', 'longform'],
    app: 'hostr-longform/1.0'
  });

  const postOp = {
    parent_author: '',
    parent_permlink: 'hostr',
    author: HIVE_USERNAME,
    permlink,
    title,
    body,
    json_metadata: jsonMetadata,
  };

  try {
    const result = await hiveClient.broadcast.comment(
      postOp,
      PrivateKey.fromString(HIVE_POSTING_KEY)
    );
    console.log(`[Bridge] [Nostr→Hive] ✅ Posted as top-level Hive post: ${result.id}, Permlink: ${permlink}, Title: "${title}", Nostr Link: ${nostrLink}`);
    processedNostrEvents.add([post.eventId, Date.now()]);
    writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
    return result;
  } catch (error) {
    console.error('[Bridge] [Nostr→Hive] ❌ Error posting as top-level Hive post:', error.message);
    throw error;
  }
}

async function listenToNostr() {
  const now = Math.floor(Date.now() / 1000);
  const connectedRelays = [];
  for (const relay of relays) {
    try {
      await pool.ensureRelay(relay);
      connectedRelays.push(relay);
      console.log(`[Bridge] [Nostr→Hive] 🔌 Connected to relay: ${relay}`);
    } catch (err) {
      console.warn(`[Bridge] [Nostr→Hive] ⚠️ Failed to connect to relay ${relay}: ${err.message || 'Unknown error'}`);
    }
  }
  if (connectedRelays.length === 0) {
    console.error('[Bridge] [Nostr→Hive] ❌ No relays connected, retrying in 2 minutes');
    setTimeout(listenToNostr, TWO_MINUTES_MS);
    return;
  }
  const since = now - (5 * 60);
  const filter = { kinds: [1, 30023], authors: [NOSTR_PUBLIC_KEY], since };
  console.log(`[Bridge] [Nostr→Hive] 🕒 Processing events after ${new Date(since * 1000).toISOString()}`);
  console.log(`[Bridge] [Nostr→Hive] 🔍 Subscribing with filter: ${JSON.stringify(filter)}`);

  try {
    const sub = pool.subscribeMany(connectedRelays, [filter], {
      onevent: (event) => {
        console.log(`[Bridge] [Nostr→Hive] 📝 New Nostr event: kind=${event.kind}, id=${event.id}, pubkey=${event.pubkey}, content="${event.content.substring(0, 30)}..."`);
        if (isRecentEvent(event)) {
          queueNostrToHive(event);
        }
      },
      oneose: () => console.log('[Bridge] [Nostr→Hive] 📦 End of stored events, listening for new ones'),
      onerror: (err) => {
        if (err.message?.includes('no active subscription')) {
          console.warn('[Bridge] [Nostr→Hive] ⚠️ Subscription closed by relay, refreshing...');
          setTimeout(listenToNostr, 1000);
        } else {
          console.error('[Bridge] [Nostr→Hive] ❌ Subscription error:', err.message || err);
          setTimeout(listenToNostr, TWO_MINUTES_MS);
        }
      },
    });
    setTimeout(() => {
      sub.close();
      console.log('[Bridge] [Nostr→Hive] 🔄 Subscription closed, refreshing...');
      setTimeout(listenToNostr, 1000);
    }, 60 * 1000);
    console.log('[Bridge] [Nostr→Hive] 🎧 Listening for Nostr events...');
  } catch (err) {
    console.error('[Bridge] [Nostr→Hive] ❌ Error subscribing to Nostr events:', err.message);
    setTimeout(listenToNostr, TWO_MINUTES_MS);
  }
}

// --- Hive-to-Nostr Functions ---

async function fetchRecentHivePosts() {
  try {
    const posts = await hiveClient.database.call('get_discussions_by_author', [HIVE_USERNAME, '', 10]);
    return posts;
  } catch (error) {
    console.error('[Bridge] [Hive→Nostr] ❌ Error fetching Hive posts:', error.message);
    return [];
  }
}

async function processHiveToNostrQueue() {
  if (hiveToNostrPosting || hiveToNostrQueue.length === 0) {
    return;
  }

  hiveToNostrPosting = true;
  const post = hiveToNostrQueue.shift();

  try {
    console.log(`[Bridge] [Hive→Nostr] ℹ️ Processing post: permlink=${post.permlink}`);
    await postToNostr(post);
    processedHivePermlinks.add([post.permlink, Date.now()]);
    writeJsonFileSync(PROCESSED_PERMLINKS_FILE, [...processedHivePermlinks]);
    console.log(`[Bridge] [Hive→Nostr] 📊 Queue status: ${hiveToNostrQueue.length} items remaining`);
  } catch (error) {
    console.error(`[Bridge] [Hive→Nostr] ❌ Error processing post ${post.permlink}:`, error.message);
    hiveToNostrQueue.unshift(post);
    setTimeout(processHiveToNostrQueue, TWO_MINUTES_MS);
  } finally {
    hiveToNostrPosting = false;
    if (hiveToNostrQueue.length > 0) {
      console.log(`[Bridge] [Hive→Nostr] ℹ️ Scheduling next queue processing`);
      setTimeout(processHiveToNostrQueue, 100);
    }
  }
}

function queueHiveToNostr(post) {
  if (isCrossPost(post.body)) {
    console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping Nostr-originated post: "${post.title}" (Permlink: ${post.permlink})`);
    return;
  }
  console.log(`[Bridge] [Hive→Nostr] ℹ Checking permlink: ${post.permlink}, processed size: ${processedHivePermlinks.size}`);
  if (processedHivePermlinks.has(post.permlink) || [...processedHivePermlinks].some(([permlink]) => permlink === post.permlink)) {
    console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping already processed post: "${post.title}" (Permlink: ${post.permlink})`);
    return;
  }
  console.log(`[Bridge] [Hive→Nostr] ℹ Raw post title: "${post.title || ''}", Length: ${post.title?.length || 0} chars`);
  console.log(`[Bridge] [Hive→Nostr] ℹ Raw post body length: ${post.body.length} chars`);
  const rawContent = post.title ? `${post.title}\n${post.body}` : post.body;
  console.log(`[Bridge] [Hive→Nostr] ℹ Combined raw content length: ${rawContent.length} chars`);
  const cleanedBody = cleanContent(rawContent);
  console.log(`[Bridge] [Hive→Nostr] ℹ Cleaned post body length: ${cleanedBody.length} chars`);
  const plainBody = stripMarkdown(cleanedBody);
  console.log(`[Bridge] [Hive→Nostr] ℹ Plain text body length: ${plainBody.length} chars`);
  let content = plainBody;
  const hiveLink = createHiveLink(post.author, post.permlink);
  const footerBase = `\n\nBridged via Hostr at https://hostr-home.vercel.app`;
  let isLongform = post.parent_author === '';
  let summary = isLongform ? content.substring(0, 280) : '';
  let suffix = '';
  if (!isLongform) {
    const maxContentLength = 380 - footerBase.length - 24;
    const isTruncated = content.length > maxContentLength;
    if (isTruncated) {
      suffix = `\n\n... read more in the [original on Hive](${hiveLink})`;
      content = content.substring(0, 380 - suffix.length - footerBase.length - 3) + '...' + suffix;
      console.log(`[Bridge] [Hive→Nostr] ✂️ Truncated content to ${content.length} chars with suffix: "${suffix}"`);
    } else {
      content += `\n\nBridged via [Hostr](https://github.com/crrdlx/hostr), view [original on Hive](${hiveLink})`;
      console.log(`[Bridge] [Hive→Nostr] ℹ Added non-truncated footer: "Bridged via [Hostr](https://github.com/crrdlx/hostr), view [original on Hive](${hiveLink})"`);
    }
    content += footerBase;
  } else {
    content += `\n\nBridged via [Hostr](https://github.com/crrdlx/hostr), view [original on Hive](${hiveLink})${footerBase}`;
  }
  console.log(`[Bridge] [Hive→Nostr] ℹ Final content length: ${content.length} chars`);
  const postData = { 
    content, 
    permlink: post.permlink, 
    title: post.title || 'Untitled', 
    summary,
    isLongform 
  };
  if (!hiveToNostrQueue.some(item => item.permlink === post.permlink)) {
    hiveToNostrQueue.push(postData);
    console.log(`[Bridge] [Hive→Nostr] 📥 Added to queue: "${post.title}" (Permlink: ${post.permlink}, Kind: ${isLongform ? '30023' : '1'})`);
    console.log(`[Bridge] [Hive→Nostr] 📊 Queue status: ${hiveToNostrQueue.length} items waiting`);
    setTimeout(processHiveToNostrQueue, 0);
  }
}

async function postToNostr(post) {
  console.log(`[Bridge] [Hive→Nostr] 📤 Attempting to post to Nostr: "${post.content.substring(0, 30)}..."`);
  const tags = post.isLongform 
    ? [
        ['t', 'hostr'],
        ['t', 'longform'],
        ['title', post.title],
        ['summary', post.summary || post.content.substring(0, 280)],
        ['hive-permlink', post.permlink]
      ]
    : [['t', 'hostr']];
  const event = {
    kind: post.isLongform ? 30023 : 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: post.content,
    pubkey: getPublicKey(NOSTR_PRIVATE_KEY),
  };

  try {
    const signedEvent = finalizeEvent(event, Buffer.from(NOSTR_PRIVATE_KEY, 'hex'));
    const successfulRelays = [];
    for (const relay of relays) {
      try {
        await pool.publish([relay], signedEvent);
        successfulRelays.push(relay);
        console.log(`[Bridge] [Hive→Nostr] ✅ Published to relay: ${relay}`);
      } catch (error) {
        console.warn(`[Bridge] [Hive→Nostr] ⚠️ Failed to publish to relay ${relay}: ${error.message || 'Unknown error'}`);
      }
    }
    if (successfulRelays.length < 2) {
      throw new Error(`Failed to publish to at least 2 relays; successful: ${successfulRelays.join(', ')}`);
    }
    console.log(`[Bridge] [Hive→Nostr] ✅ Published to Nostr, event ID: ${signedEvent.id}, kind=${post.isLongform ? 30023 : 1}, relays: ${successfulRelays.join(', ')}`);
    return signedEvent;
  } catch (error) {
    console.error('[Bridge] [Hive→Nostr] ❌ Error posting to Nostr:', error.message);
    throw error;
  }
}

// Keep process alive
function keepAlive() {
  setInterval(() => {
    console.log('[Bridge] 🕒 Heartbeat: Still listening for events...');
  }, 60 * 1000);
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Bridge] ⚠️ Unhandled promise rejection:', reason.message || reason, reason.stack || '');
  console.log('[Bridge] 🔄 Restarting bridge due to unhandled rejection...');
  setTimeout(start, 5000);
});

// Initialization
function start() {
  console.log(`[Bridge] ℹ️ Loaded environment: HIVE_USERNAME=${HIVE_USERNAME}, NOSTR_PUBLIC_KEY=${NOSTR_PUBLIC_KEY}`);
  cleanProcessedEntries();
  try {
    Promise.all([listenToNostr(), pollHive()]).catch((err) => {
      console.error('[Bridge] ❌ Error in bridge:', err.message);
      setTimeout(start, TWO_MINUTES_MS);
    });
    keepAlive();
  } catch (err) {
    console.error('[Bridge] ❌ Error starting bridge:', err.message);
    setTimeout(start, TWO_MINUTES_MS);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`[Bridge] 👋 Shutting down... Nostr→Hive: ${nostrToHiveQueue.length}, Hive→Nostr: ${hiveToNostrQueue.length} items in queues`);
  console.log('[Bridge] ℹ️ Skipping Nostr pool close due to library issue');
  process.exit(0);
});

// Run the script
start();

// bidirectional-bridge.cjs v0.1.75 Snaps+Waves+Longform
async function pollHive() {
  try {
    console.log('[Bridge] [Hive→Nostr] 🔍 Checking for new Hive posts...');
    const posts = await fetchRecentHivePosts();
    console.log(`[Bridge] [Hive→Nostr] ℹ️ Found ${posts.length} posts`);
    
    for (const post of posts) {
      console.log(`[Bridge] [Hive→Nostr] ℹ️ Processing post: author=${post.author}, permlink=${post.permlink}, created=${post.created}, parent_author=${post.parent_author || ''}, parent_permlink=${post.parent_permlink}`);
      
      // Skip if not from our user
      if (post.author !== HIVE_USERNAME) {
        console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping post from ${post.author} (not ${HIVE_USERNAME})`);
        continue;
      }

      // Skip if missing body
      if (!post.body) {
        console.log(`[Bridge] [Hive→Nostr] ⚠️ Skipping post with missing body: "${post.title || 'Untitled'}" (Permlink: ${post.permlink})`);
        continue;
      }

      // Skip if it's a cross-post
      if (isCrossPost(post.body)) {
        console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping Nostr-originated post: "${post.title}" (Permlink: ${post.permlink})`);
        continue;
      }

      // Skip if contains .hostr keyword
      if (post.body.includes('.hostr') || (post.title && post.title.includes('.hostr'))) {
        console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping post due to .hostr keyword: "${post.title}" (Permlink: ${post.permlink})`);
        continue;
      }

      // Check if it's a recent post
      const postTime = new Date(post.created + 'Z').getTime();
      const now = Date.now();
      const age = now - postTime;
      if (age >= FIVE_MINUTES_MS) {
        console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping old post (${Math.floor(age/60000)}m ${Math.floor((age%60000)/1000)}s old): "${post.title || 'Untitled'}"`);
        continue;
      }

      // Queue the post for processing
      queueHiveToNostr(post);
    }
  } catch (error) {
    console.error('[Bridge] [Hive→Nostr] ❌ Error polling Hive:', error.message);
  }
  
  // Schedule next poll
  setTimeout(pollHive, TWO_MINUTES_MS);
}
// bidirectional-bridge.cjs v0.1.75 Snaps+Waves+Longform
