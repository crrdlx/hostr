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
console.log('Debug: Starting bidirectional-bridge.cjs v0.1.88');
console.log('Debug: Node.js version:', process.version);
console.log('Debug: Logging initialized');

// Version constant
const VERSION = '0.1.88';

// Auto-restart configuration
const LISTENING_LOG_INTERVAL_MS = 15 * 60 * 1000; // Log "listening" every 15 minutes
const RESTART_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_RESTART_ATTEMPTS = 3;
let restartAttempts = 0;
let lastActivity = Date.now();
let scheduledRestart = null;

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
  
  // Images - convert to direct URLs
  result = result.replace(/!\[([^\]]*?)\]\(([^)]+)\)/g, '$2'); // ![alt](url) -> url
  result = result.replace(/!\[([^\]]*?)\]/g, ''); // ![alt] -> empty
  result = result.replace(/!\[([^\]]*?)?/g, ''); // ![alt -> empty
  
  // Headers
  result = result.replace(/^#{1,6}\s*(.*)$/gm, '$1'); // # Header -> Header
  
  // Links - keep the URL
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2'); // [text](url) -> url
  
  // Bold and italic
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1'); // **bold** -> bold
  result = result.replace(/__([^_]+)__/g, '$1'); // __bold__ -> bold
  result = result.replace(/\*([^*]+)\*/g, '$1'); // *italic* -> italic
  result = result.replace(/_([^_]+)_/g, '$1'); // _italic_ -> italic
  
  // Strikethrough
  result = result.replace(/~~([^~]+)~~/g, '$1'); // ~~strikethrough~~ -> strikethrough
  
  // Code blocks and inline code
  result = result.replace(/```[\s\S]*?```/g, ''); // ```code block``` -> empty
  result = result.replace(/`([^`]+)`/g, '$1'); // `inline code` -> inline code
  
  // Blockquotes
  result = result.replace(/^>\s*(.*)$/gm, '$1'); // > quote -> quote
  
  // Lists
  result = result.replace(/^[-*+]\s*(.*)$/gm, '$1'); // - item -> item
  result = result.replace(/^\d+\.\s*(.*)$/gm, '$1'); // 1. item -> item
  
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}\s*$/gm, ''); // --- -> empty
  
  // Tables - convert to simple text
  result = result.replace(/^\|.*\|$/gm, (match) => {
    return match.replace(/\|/g, ' ').trim();
  });
  result = result.replace(/^-+\|-+$/gm, ''); // Remove table separators
  
  // Nested lists with indentation
  result = result.replace(/^\s*[-*+]\s*(.*)$/gm, '$1'); //   - item -> item
  result = result.replace(/^\s*\d+\.\s*(.*)$/gm, '$1'); //   1. item -> item
  
  // Remove HTML tags (in case any slip through)
  result = result.replace(/<[^>]+>/g, '');
  
  // Clean up multiple newlines and spaces
  result = result.replace(/\n\s*\n/g, '\n'); // Multiple newlines -> single
  result = result.replace(/[ \t]+/g, ' '); // Multiple spaces -> single
  result = result.replace(/\n\s+/g, '\n'); // Remove leading spaces after newlines
  
  return result.trim();
}

function isCrossPost(hivePost) {
  // Check for marker in body
  if (/id:\s*[0-9a-fA-F]{5}/.test(hivePost.body)) {
    return true;
  }
  // Optionally, check json_metadata
  if (hivePost.json_metadata && hivePost.json_metadata.nostr_bridge_id) {
    return true;
  }
  return false;
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
    console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping old event (${Math.floor(age/60)}m ${age%60}s old): kind=${event.kind}, content="${event.content.split(' ').slice(0, 3).join(' ')}..."`);
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
      // Prevent bounce-back of h2n-bridged notes
      if (post.content.includes("Bridged via Hostr")) {
        console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping Nostr kind 1 note that originated from Hive (detected Hostr footer)`);
        return;
      }
      const charCount = post.content.length;
      console.log(`[Bridge] [Nostr→Hive] ℹ️ Processing post: id=${post.eventId}, content="${post.content.split(' ').slice(0, 3).join(' ')}..." (${charCount} chars), kind=${post.kind}, created=${new Date(post.created_at * 1000).toISOString()}`);

      if (charCount >= 485) {
        // Top-level Hive post logic
        const result = await postToHiveAsTopLevel(post);
        processedNostrEvents.add([post.eventId, Date.now()]);
        writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
        dailyLongformCount++;
        lastHivePostTime = Date.now();
        console.log(`[Bridge] [Nostr→Hive] ✅ Posted as top-level Hive post: ${result.id}, permlink=${post.permlink}, content="${post.content.split(' ').slice(0, 3).join(' ')}..." (${charCount} chars)`);
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
        console.log(`[Bridge] [Nostr→Hive] ℹ️ Posting to: ${frontEnd}. Next will be: ${nextFrontEnd}`);
        frontEndIndex = (frontEndIndex + 1) % frontEnds.length;
        lastFrontEnd = frontEnd;

        const result = await postToHive(post.content, post.eventId, containerPermlink, frontEnd);
        processedNostrEvents.add([post.eventId, Date.now()]);
        writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
        dailySnapCount++;
        lastHivePostTime = Date.now();
        console.log(`[Bridge] [Nostr→Hive] ✅ Posted to Hive ${frontEnd}: ${result.id}, permlink=${post.permlink}, content="${post.content.split(' ').slice(0, 3).join(' ')}..."`);
        console.log(`[Bridge] [Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items remaining, Snaps today: ${dailySnapCount}/${MAX_SHORTFORM_PER_DAY}, Longform today: ${dailyLongformCount}/${MAX_LONGFORM_PER_DAY}`);
      }
    } else if (post.kind === 30023) {
      if (dailyLongformCount >= MAX_LONGFORM_PER_DAY) {
        console.log(`[Bridge] [Nostr→Hive] ⏳ Daily longform limit (${MAX_LONGFORM_PER_DAY}) reached, skipping kind 30023...`);
        nostrToHiveQueue.unshift(post);
        setTimeout(processNostrToHiveQueue, TWO_MINUTES_MS);
        return;
      }
      console.log(`[Bridge] [Nostr→Hive] ℹ️ Processing event ${post.eventId}, kind=30023, content="${post.content.split(' ').slice(0, 3).join(' ')}..."`);
      const result = await postLongformToHive(post.content, post.eventId, post.tags);
      processedNostrEvents.add([post.eventId, Date.now()]);
      writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
      dailyLongformCount++;
      lastHivePostTime = Date.now();
      console.log(`[Bridge] [Nostr→Hive] ✅ Posted longform to Hive: ${result.id}, permlink=${post.permlink}, content="${post.content.split(' ').slice(0, 3).join(' ')}...", title="${post.title}"`);
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
    console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping already processed event: kind=${event.kind}, id=${event.id}, age=${Math.floor(age/60)}m${age%60}s, content="${event.content.split(' ').slice(0, 3).join(' ')}..."`);
    return;
  }
  if (event.kind !== 1 && event.kind !== 30023) {
    console.log(`[Bridge] [Nostr→Hive] ⏸️ Skipping unsupported event: kind=${event.kind}, id=${event.id}, content="${event.content.split(' ').slice(0, 3).join(' ')}..."`);
    return;
  }
  // Skip kind 1 events with any 'e' tag to prevent bridging replies
  if (event.kind === 1 && event.tags.some(tag => tag[0] === 'e')) {
    console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping kind 1 reply (has e-tag): id=${event.id}, age=${Math.floor(age/60)}m ${age%60}s, content="${event.content.split(' ').slice(0, 3).join(' ')}...", tags=${JSON.stringify(event.tags)}`);
    return;
  }
  // Check for .hostr keyword to skip the post for both kind 1 and 30023
  if (event.content.includes('.hostr')) {
    console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping event due to .hostr keyword: kind=${event.kind}, id=${event.id}, age=${Math.floor(age/60)}m${age%60}s, content="${event.content.split(' ').slice(0, 3).join(' ')}..."`);
    return;
  }
  const post = { content: event.content, eventId: event.id, kind: event.kind, tags: event.tags, created_at: event.created_at };
  if (!nostrToHiveQueue.some(item => item.eventId === event.id)) {
    nostrToHiveQueue.push(post);
    console.log(`[Bridge] [Nostr→Hive] 📖 Added to queue: kind=${event.kind}, id=${event.id}, age=${Math.floor(age/60)}m${age%60}s, content="${event.content.split(' ').slice(0, 3).join(' ')}..."`);
    console.log(`[Bridge] [Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items waiting`);
    setTimeout(processNostrToHiveQueue, 0);
  }
}

async function postToHive(content, eventId, containerPermlink, frontEnd) {
  console.log(`[Bridge] [Nostr→Hive] 📤 Attempting to post to Hive ${frontEnd}: content="${content.split(' ').slice(0, 3).join(' ')}..."`);
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
  const nostrEventId = eventId ? String(eventId).slice(0, 5) : 'none';
  const body = `${textContent}${imageSection}\n\nBridged via [Hostr](https://github.com/crrdlx/hostr), view [original on Nostr](${nostrLink}). id: ${nostrEventId}`;
  const jsonMetadata = JSON.stringify({ 
    tags: ['hostr', `hostr-${frontEnd}`], 
    app: `hostr-${frontEnd}/1.0`,
    nostr_bridge_id: nostrEventId
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
    console.log(`[Bridge] [Nostr→Hive] ✅ Posted to Hive ${frontEnd}: ${result.id}, permlink=${permlink}, content="${content.split(' ').slice(0, 3).join(' ')}..."`);
    return result;
  } catch (error) {
    console.error(`[Bridge] [Nostr→Hive] ❌ Error posting to Hive ${frontEnd}:`, error.message);
    throw error;
  }
}

async function postLongformToHive(content, eventId, tags) {
  console.log(`[Bridge] [Nostr→Hive] 📤 Attempting to post longform to Hive: content="${content.split(' ').slice(0, 3).join(' ')}..."`);
  const permlink = `hostr-longform-${Math.random().toString(36).substring(2)}`;
  const title = generateTitle(content, tags);
  const nostrLink = createNostrLink(eventId);
  const nostrEventId = eventId ? String(eventId).slice(0, 5) : 'none';
  const body = `${content}\n\nBridged via [Hostr](https://github.com/crrdlx/hostr), view [original on Nostr](${nostrLink}). id: ${nostrEventId}`;
  const jsonMetadata = JSON.stringify({
    tags: ['hostr', 'longform'],
    app: 'hostr-longform/1.0',
    nostr_bridge_id: nostrEventId
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
    console.log(`[Bridge] [Nostr→Hive] ✅ Posted longform to Hive: ${result.id}, permlink=${permlink}, title="${title}", content="${content.split(' ').slice(0, 3).join(' ')}..."`);
    return result;
  } catch (error) {
    console.error('[Bridge] [Nostr→Hive] ❌ Error posting longform to Hive:', error.message);
    throw error;
  }
}

async function postToHiveAsTopLevel(post) {
  console.log(`[Bridge] [Nostr→Hive] 📤 Attempting to post top-level to Hive: content="${post.content.split(' ').slice(0, 3).join(' ')}..."`);
  const title = generateTitle(post.content, post.tags);
  const permlink = `hostr-top-${Math.random().toString(36).substring(2)}`;
  const nostrLink = createNostrLink(post.eventId);
  const nostrEventId = post.eventId ? String(post.eventId).slice(0, 5) : 'none';
  const body = `${post.content}\n\nBridged via [Hostr](https://github.com/crrdlx/hostr), view [original on Nostr](${nostrLink}). id: ${nostrEventId}`;
  const jsonMetadata = JSON.stringify({
    tags: ['hostr', 'longform'],
    app: 'hostr-longform/1.0',
    nostr_bridge_id: nostrEventId
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
    console.log(`[Bridge] [Nostr→Hive] ✅ Posted as top-level Hive post: ${result.id}, permlink=${permlink}, title="${title}", content="${post.content.split(' ').slice(0, 3).join(' ')}..."`);
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
        console.log(`[Bridge] [Nostr→Hive] 📝 New Nostr event: kind=${event.kind}, id=${event.id}, pubkey=${event.pubkey}, content="${event.content.split(' ').slice(0, 3).join(' ')}..."`);
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
    const posts = await hiveClient.call('condenser_api', 'get_discussions_by_blog', [{ tag: HIVE_USERNAME, limit: 10 }]);
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
    console.log(`[Bridge] [Hive→Nostr] ℹ️ Processing post: permlink=${post.permlink}, content="${post.content.split(' ').slice(0, 3).join(' ')}..."`);
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
  if (isCrossPost(post)) {
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
  
  // Determine if this is a longform post (top-level, not Actifit/d.buzz)
  let isActifitOrDbuzz = false;
  try {
    const meta = typeof post.json_metadata === 'string'
      ? JSON.parse(post.json_metadata)
      : post.json_metadata;
    const app = (meta && meta.app) ? meta.app.toLowerCase() : '';
    if (app.includes('actifit') || app.includes('dbuzz') || app.includes('d.buzz')) {
      isActifitOrDbuzz = true;
    }
  } catch (e) {
    // ignore parse errors
  }

  const isLongform = post.parent_author === '' && !isActifitOrDbuzz;
  
  // Always post as kind 1, but with different footers based on content type
  const maxContentLength = 380; // Leave room for footer
  const isTruncated = content.length > maxContentLength;
  
  if (isTruncated) {
    content = content.substring(0, maxContentLength - 50) + '...'; // Leave room for footer
    console.log(`[Bridge] [Hive→Nostr] ✂️ Truncated content to ${content.length} chars`);
  }
  
  // Add appropriate footer based on content type
  if (isLongform) {
    content += `\n\nBridged via Hostr at https://hostr-home.vercel.app. This is a long form post, read the full article at ${hiveLink}`;
  } else {
    content += `\n\nBridged via Hostr at https://hostr-home.vercel.app. Read the original at ${hiveLink}`;
  }
  
  console.log(`[Bridge] [Hive→Nostr] ℹ Final content length: ${content.length} chars`);
  const postData = { 
    content, 
    permlink: post.permlink, 
    title: post.title || 'Untitled'
  };
  if (!hiveToNostrQueue.some(item => item.permlink === post.permlink)) {
    hiveToNostrQueue.push(postData);
    console.log(`[Bridge] [Hive→Nostr] 📥 Added to queue: "${post.title}" (Permlink: ${post.permlink}, Kind: 1, content="${content.split(' ').slice(0, 3).join(' ')}...")`);
    console.log(`[Bridge] [Hive→Nostr] 📊 Queue status: ${hiveToNostrQueue.length} items waiting`);
    setTimeout(processHiveToNostrQueue, 0);
  }
}

async function postToNostr(post) {
  console.log(`[Bridge] [Hive→Nostr] 📤 Attempting to post to Nostr: "${post.content.split(' ').slice(0, 3).join(' ')}..."`);
  const tags = [['t', 'hostr']]; // Only hostr tag, no longform tag
  const event = {
    kind: 1, // Always kind 1
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
    console.log(`[Bridge] [Hive→Nostr] ✅ Published to Nostr, event ID: ${signedEvent.id}, kind=1, content="${post.content.split(' ').slice(0, 3).join(' ')}...", relays: ${successfulRelays.join(', ')}`);
    return signedEvent;
  } catch (error) {
    console.error('[Bridge] [Hive→Nostr] ❌ Error posting to Nostr:', error.message);
    throw error;
  }
}

// Periodic listening log
function logListening() {
  console.log('[Bridge] ℹ️ Listening for new Nostr and Hive events');
  lastActivity = Date.now(); // Update activity timestamp
  setTimeout(logListening, LISTENING_LOG_INTERVAL_MS);
}

// Keep process alive
function keepAlive() {
  setInterval(() => {
    console.log('[Bridge] 🕒 Heartbeat: Still listening for events...');
    lastActivity = Date.now();
  }, 60 * 1000);
}

// Health monitoring
function startHealthMonitoring() {
  setInterval(() => {
    const now = Date.now();
    if (now - lastActivity > HEALTH_CHECK_INTERVAL_MS) {
      console.log('[Bridge] ⚠️ No recent activity, restarting...');
      gracefulRestart('no_activity');
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

// Schedule periodic restart
function schedulePeriodicRestart() {
  if (scheduledRestart) {
    clearTimeout(scheduledRestart);
  }
  scheduledRestart = setTimeout(() => {
    console.log('[Bridge] 🔄 Scheduled restart triggered');
    gracefulRestart('scheduled');
  }, RESTART_INTERVAL_MS);
}

// Graceful restart
function gracefulRestart(reason) {
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.error(`[Bridge] ❌ Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached, exiting...`);
    process.exit(1);
  }
  restartAttempts++;
  console.log(`[Bridge] 🔄 Attempting restart (${restartAttempts}/${MAX_RESTART_ATTEMPTS}) due to: ${reason}`);
  setTimeout(start, 5000);
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Bridge] ⚠️ Unhandled promise rejection:', reason.message || reason, reason.stack || '');
  console.log('[Bridge] 🔄 Restarting bridge due to unhandled rejection...');
  gracefulRestart('unhandled_rejection');
});

// Initialization
function start() {
  console.log(`[Bridge] 🚀 Starting bidirectional bridge v${VERSION}`);
  cleanProcessedEntries();
  try {
    Promise.all([listenToNostr(), pollHive()]).catch((err) => {
      console.error('[Bridge] ❌ Error in bridge:', err.message);
      gracefulRestart('initialization_error');
    });
    keepAlive();
    startHealthMonitoring();
    schedulePeriodicRestart();
    logListening();
  } catch (err) {
    console.error('[Bridge] ❌ Error starting bridge:', err.message);
    gracefulRestart('startup_error');
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

async function pollHive() {
  try {
    console.log('[Bridge] [Hive→Nostr] 🔍 Checking for new Hive posts...');
    lastActivity = Date.now(); // Update activity timestamp
    const posts = await fetchRecentHivePosts();
    console.log(`[Bridge] [Hive→Nostr] ℹ️ Found ${posts.length} posts`);
    
    for (const post of posts) {
      console.log(`[Bridge] [Hive→Nostr] ℹ️ Processing post: author=${post.author}, permlink=${post.permlink}, created=${post.created}, parent_author=${post.parent_author || ''}, parent_permlink=${post.parent_permlink}, content="${post.body.split(' ').slice(0, 3).join(' ')}..."`);
      
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
      if (isCrossPost(post)) {
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

// bidirectional-bridge.cjs v0.1.88 Snaps+Waves+Longform; hive-to-nostr (h2n) goes to nostr as short form (kind 1) truncated notes, no n2h bounceback
// Fixed duplicate posting issue for kind 1 notes ≥485 chars by ensuring processedNostrEvents is updated in postToHiveAsTopLevel
// Fixed isLongform and summary undefined in queueHiveToNostr
// Added periodic "listening for new events" log every 15 minutes
// Corrected typo in processNostrToHiveQueue error log ('ap limit' → 'Snap limit')
// Added consistent error handling for rate limits and network errors across all N2H posting paths
// Updated postToHive to place image URLs above the footer for Snaps/Waves posts
// Fixed regex syntax in stripMarkdown function to resolve SyntaxError: Unexpected token '^'
// Added nostr-bridge-id to kind 30023 posts in postLongformToHive to prevent H2N bounce-back
// Updated queueNostrToHive to only skip kind 1 posts with any 'e' tag to prevent bridging replies
// Enhanced logging to show first three words of content in all processing steps
// Added auto-restart functionality with:
// - External monitoring scripts (auto-restart.sh/auto-restart.ps1)
// - Internal restart logic (bidirectional-bridge.cjs)
// - Health monitoring
// - Graceful shutdowns
// - Multiple restart triggers
// - Restart configuration file
// - Troubleshooting guidance
// - Customization options