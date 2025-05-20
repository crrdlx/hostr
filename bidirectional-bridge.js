// bidirectional-bridge.js v0.1.38 Snaps+Longform
import 'dotenv/config';
import { SimplePool, finalizeEvent, getPublicKey } from 'nostr-tools';
import { Client, PrivateKey } from '@hiveio/dhive';
import WebSocket from 'ws';
import fs from 'fs';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Version constant
const VERSION = '0.1.38';

// Set global WebSocket for nostr-tools
global.WebSocket = WebSocket;

// Load credentials
const HIVE_USERNAME = process.env.HIVE_USERNAME;
const HIVE_POSTING_KEY = process.env.HIVE_POSTING_KEY;
const NOSTR_PUBLIC_KEY = process.env.NOSTR_PUBLIC_KEY;
const NOSTR_PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY;

console.log(`Starting bidirectional bridge with Snaps and longform integration for Hive user: ${HIVE_USERNAME}, Nostr pubkey: ${NOSTR_PUBLIC_KEY}`);

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
  'wss://nostr-pub.wellorder.net',
  'wss://offchain.pub',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://purplepag.es',
];
const pool = new SimplePool();

// Rate limiting and queue variables
const TWO_MINUTES_MS = 2 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SNAPS_PER_DAY = 10;
const MAX_LONGFORM_PER_DAY = 5;
let lastHivePostTime = 0; // For top-level posts (if any)
let dailySnapCount = 0;
let dailyLongformCount = 0;
let lastSnapDay = new Date().toDateString();
let nostrToHiveQueue = [];
let hiveToNostrQueue = [];
let nostrToHivePosting = false;
let hiveToNostrPosting = false;
let activeContainer = { permlink: null, created: null };
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
    console.log('[Bridge] 📅 Reset daily Snap and longform counts');
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
  result = result.replace(/!\[([^\]]*?)\]\(([^)]+)\)/g, '$2');
  result = result.replace(/!\[([^\]]*?)\]/g, '');
  result = result.replace(/!\[([^\]]*?)?/g, '');
  result = result.replace(/^#{1,6}\s*(.*)$/gm, '$1');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');
  result = result.replace(/```[^`]*```/g, '');
  result = result.replace(/`([^`]+)`/g, '$1');
  result = result.replace(/^>\s*(.*)$/gm, '$1');
  result = result.replace(/^[-*]\s*(.*)$/gm, '$1');
  result = result.replace(/^\d+\.\s*(.*)$/gm, '$1');
  result = result.replace(/^[-*_]{3,}\s*$/gm, '');
  result = result.replace(/\n\s*\n/g, '\n').trim();
  return result;
}

function isCrossPost(content) {
  const regex = /auto\s*cross-post\s*(?:from\s*(?:hive|nostr)\s*)?via\s*hostr\s*(?:v[\d.]+)?\s*(?:\((?:br|lf)\))?|view\s*the\s*original\s*(?:post|article)\s*over\s*on\s*\[?nostr\]?|originally\s*posted\s*on\s*hive\s*at\s*https:\/\/(peakd|hive)\.com/i;
  return regex.test(content);
}

function createNostrLink(eventId) {
  return `https://njump.me/${eventId}`;
}

function createHiveLink(author, permlink) {
  return `https://peakd.com/@${author}/${permlink}`;
}

// --- Container Detection ---

async function getActiveContainer() {
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
    if (!activeContainer.permlink || postTime > new Date(activeContainer.created + 'Z').getTime()) {
      activeContainer = { permlink: post.permlink, created: post.created };
      console.log(`[Bridge] [Nostr→Hive] 📌 Updated active Snap container: ${post.permlink}, created=${post.created}`);
    }
    return activeContainer.permlink;
  } catch (error) {
    console.error('[Bridge] [Nostr→Hive] ❌ Error fetching Snap container:', error.message);
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
  if (dailySnapCount >= MAX_SNAPS_PER_DAY && dailyLongformCount >= MAX_LONGFORM_PER_DAY) {
    console.log(`[Bridge] [Nostr→Hive] ⏳ Daily limits reached (Snaps: ${MAX_SNAPS_PER_DAY}, Longform: ${MAX_LONGFORM_PER_DAY}), waiting until tomorrow...`);
    setTimeout(processNostrToHiveQueue, 24 * 60 * 60 * 1000);
    return;
  }

  nostrToHivePosting = true;
  const post = nostrToHiveQueue.shift();

  try {
    if (post.kind === 1) {
      if (dailySnapCount >= MAX_SNAPS_PER_DAY) {
        console.log(`[Bridge] [Nostr→Hive] ⏳ Daily Snap limit (${MAX_SNAPS_PER_DAY}) reached, skipping kind 1...`);
        nostrToHiveQueue.unshift(post);
        return;
      }
      const containerPermlink = await getActiveContainer();
      if (!containerPermlink) {
        nostrToHiveQueue.unshift(post);
        console.log('[Bridge] [Nostr→Hive] ⏳ No active Snap container, retrying in 2 minutes...');
        setTimeout(processNostrToHiveQueue, TWO_MINUTES_MS);
        return;
      }
      const result = await postToHive(post.content, post.eventId, containerPermlink);
      processedNostrEvents.add([post.eventId, Date.now()]);
      writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
      dailySnapCount++;
      console.log(`[Bridge] [Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items remaining, Snaps today: ${dailySnapCount}/${MAX_SNAPS_PER_DAY}, Longform today: ${dailyLongformCount}/${MAX_LONGFORM_PER_DAY}`);
    } else if (post.kind === 30023) {
      if (dailyLongformCount >= MAX_LONGFORM_PER_DAY) {
        console.log(`[Bridge] [Nostr→Hive] ⏳ Daily longform limit (${MAX_LONGFORM_PER_DAY}) reached, skipping kind 30023...`);
        nostrToHiveQueue.unshift(post);
        return;
      }
      const result = await postLongformToHive(post.content, post.eventId);
      processedNostrEvents.add([post.eventId, Date.now()]);
      writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
      dailyLongformCount++;
      console.log(`[Bridge] [Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items remaining, Snaps today: ${dailySnapCount}/${MAX_SNAPS_PER_DAY}, Longform today: ${dailyLongformCount}/${MAX_LONGFORM_PER_DAY}`);
    }
  } catch (error) {
    if (error.message?.includes('ECONNRESET') || error.message?.includes('rate limit')) {
      nostrToHiveQueue.unshift(post);
      console.log('[Bridge] [Nostr→Hive] ⏱️ Network or rate limit error, retrying in 2 minutes...');
      setTimeout(processNostrToHiveQueue, TWO_MINUTES_MS);
    } else {
      console.error('[Bridge] [Nostr→Hive] ❌ Error posting to Hive:', error.message);
    }
  } finally {
    nostrToHivePosting = false;
    if (nostrToHiveQueue.length > 0) {
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
    console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping unsupported event: kind=${event.kind}, id=${event.id}, content="${event.content.substring(0, 30)}..."`);
    return;
  }
  if (event.kind === 1 && event.tags.some(tag => tag[0] === 'e' || tag[0] === 'p')) {
    console.log(`[Bridge] [Nostr→Hive] ⏭️ Skipping kind 1 comment: id=${event.id}, age=${Math.floor(age/60)}m${age%60}s, content="${event.content.substring(0, 30)}..."`);
    return;
  }
  const post = { content: event.content, eventId: event.id, kind: event.kind };
  if (!nostrToHiveQueue.some(item => item.eventId === event.id)) {
    nostrToHiveQueue.push(post);
    console.log(`[Bridge] [Nostr→Hive] 📥 Added to queue (kind=${event.kind}): id=${event.id}, age=${Math.floor(age/60)}m${age%60}s, content="${event.content.substring(0, 30)}..."`);
    console.log(`[Bridge] [Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items waiting`);
    processNostrToHiveQueue();
  }
}

async function postToHive(content, eventId, containerPermlink) {
  console.log(`[Bridge] [Nostr→Hive] 📤 Attempting to post Snap to Hive: content="${content.substring(0, 30)}..."`);
  const permlink = `hostr-snap-${Math.random().toString(36).substring(2)}`;
  const nostrLink = createNostrLink(eventId);
  const body = `${content}\n\nView the original post over on [Nostr](${nostrLink})\nAuto cross-post via Hostr v${VERSION} (br) at https://github.com/crrdlx/hostr`;
  const jsonMetadata = JSON.stringify({ 
    tags: ['hostr', 'hostr-snap'], 
    app: 'hostr-snaps/1.0' 
  });

  const commentOp = {
    parent_author: 'peak.snaps',
    parent_permlink: containerPermlink,
    author: HIVE_USERNAME,
    permlink,
    title: '',
    body,
    json_metadata: jsonMetadata,
  };

  try {
    const result = await hiveClient.broadcast.comment(
      commentOp,
      PrivateKey.fromString(HIVE_POSTING_KEY)
    );
    console.log(`[Bridge] [Nostr→Hive] ✅ Posted Snap to Hive: ${result.id}, Permlink: ${permlink}, Container: ${containerPermlink}, Nostr Link: ${nostrLink}`);
    return result;
  } catch (error) {
    console.error('[Bridge] [Nostr→Hive] ❌ Error posting Snap to Hive:', error.message);
    throw error;
  }
}

async function postLongformToHive(content, eventId) {
  console.log(`[Bridge] [Nostr→Hive] 📤 Attempting to post longform to Hive: content="${content.substring(0, 30)}..."`);
  const permlink = `hostr-longform-${Math.random().toString(36).substring(2)}`;
  const nostrLink = createNostrLink(eventId);
  const body = `${content}\n\nView the original post over on [Nostr](${nostrLink})\nAuto cross-post via Hostr v${VERSION} (lf) at https://github.com/crrdlx/hostr`;
  const jsonMetadata = JSON.stringify({ 
    tags: ['hostr', 'hostr-longform'], 
    app: 'hostr-longform/1.0' 
  });

  const postOp = {
    parent_author: '',
    parent_permlink: 'hostr',
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
    console.log(`[Bridge] [Nostr→Hive] ✅ Posted longform to Hive: ${result.id}, Permlink: ${permlink}, Nostr Link: ${nostrLink}`);
    return result;
  } catch (error) {
    console.error('[Bridge] [Nostr→Hive] ❌ Error posting longform to Hive:', error.message);
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

async function pollHive() {
  try {
    console.log('[Bridge] [Hive→Nostr] 🔍 Checking for new Hive posts...');
    const posts = await fetchRecentHivePosts();
    console.log(`[Bridge] [Hive→Nostr] ℹ️ Found ${posts.length} posts`);
    const sortedPosts = [...posts].sort((a, b) => 
      new Date(a.created + 'Z').getTime() - new Date(b.created + 'Z').getTime()
    );
    let newPostsFound = 0;

    for (const post of sortedPosts) {
      console.log(`[Bridge] [Hive→Nostr] ℹ️ Processing post: author=${post.author}, title="${post.title}", permlink=${post.permlink}, created=${post.created}, parent_author=${post.parent_author || ''}`);
      if (post.author !== HIVE_USERNAME) {
        console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping post from ${post.author} (not ${HIVE_USERNAME})`);
        continue;
      }
      if (post.parent_author) {
        console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping comment: "${post.title || 'Untitled'}" (Permlink: ${post.permlink})`);
        continue;
      }
      if (!post.body) {
        console.log(`[Bridge] [Hive→Nostr] ⚠️ Skipping post with missing body: "${post.title || 'Untitled'}" (Permlink: ${post.permlink})`);
        continue;
      }
      if (isCrossPost(post.body)) {
        console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping Nostr-originated post: "${post.title}" (Permlink: ${post.permlink}), body="${post.body}"`);
        continue;
      }
      if (isRecentPost(post)) {
        console.log(`[Bridge] [Hive→Nostr] 📝 Found recent Hive post: "${post.title}"`);
        queueHiveToNostr(post);
        newPostsFound++;
      }
    }

    if (newPostsFound === 0) {
      console.log('[Bridge] [Hive→Nostr] 📭 No new posts found');
    }
  } catch (error) {
    console.error('[Bridge] [Hive→Nostr] ❌ Error polling Hive:', error.message);
  }
  setTimeout(pollHive, TWO_MINUTES_MS);
}

async function fetchRecentHivePosts() {
  try {
    const query = {
      tag: HIVE_USERNAME,
      limit: 10,
      truncate_body: 0,
    };
    console.log(`[Bridge] [Hive→Nostr] 🔍 Fetching posts with query: ${JSON.stringify(query)}`);
    const posts = await hiveClient.database.getDiscussions('blog', query);
    console.log(`[Bridge] [Hive→Nostr] ℹ️ API returned ${posts.length} posts: ${JSON.stringify(posts.map(p => ({ author: p.author, permlink: p.permlink, title: p.title, created: p.created })))}`);
    return posts;
  } catch (error) {
    console.error('[Bridge] [Hive→Nostr] ❌ Error fetching Hive posts:', error.message);
    return [];
  }
}

function isRecentPost(post) {
  const postTime = new Date(post.created + 'Z').getTime();
  const now = Date.now();
  const age = now - postTime;
  const isRecent = age < (5 * 60 * 1000);
  if (!isRecent) {
    const minutes = Math.floor(age / 60000);
    const seconds = Math.floor((age % 60000) / 1000);
    console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping old post (${minutes}m ${seconds}s old): "${post.title}"`);
  }
  return isRecent;
}

async function processHiveToNostrQueue() {
  if (hiveToNostrPosting || hiveToNostrQueue.length === 0) {
    return;
  }

  hiveToNostrPosting = true;
  const post = hiveToNostrQueue.shift();

  try {
    await postToNostr(post);
    processedHivePermlinks.add([post.permlink, Date.now()]);
    writeJsonFileSync(PROCESSED_PERMLINKS_FILE, [...processedHivePermlinks]);
    console.log(`[Bridge] [Hive→Nostr] 📊 Queue status: ${hiveToNostrQueue.length} items remaining`);
  } catch (error) {
    console.error('[Bridge] [Hive→Nostr] ❌ Error processing post:', error.message);
    hiveToNostrQueue.unshift(post);
    setTimeout(processHiveToNostrQueue, TWO_MINUTES_MS);
  } finally {
    hiveToNostrPosting = false;
    if (hiveToNostrQueue.length > 0) {
      setTimeout(processHiveToNostrQueue, 100);
    }
  }
}

function queueHiveToNostr(post) {
  if (isCrossPost(post.body)) {
    console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping Nostr-originated post: "${post.title}" (Permlink: ${post.permlink}), body="${post.body}"`);
    return;
  }
  console.log(`[Bridge] [Hive→Nostr] ℹ️ Checking permlink: ${post.permlink}, processed size: ${processedHivePermlinks.size}`);
  if (processedHivePermlinks.has(post.permlink) || [...processedHivePermlinks].some(([permlink]) => permlink === post.permlink)) {
    console.log(`[Bridge] [Hive→Nostr] ⏭️ Skipping already processed post: "${post.title}" (Permlink: ${post.permlink})`);
    return;
  }
  console.log(`[Bridge] [Hive→Nostr] ℹ️ Raw post body length: ${post.body.length} chars`);
  const cleanedBody = cleanContent(post.body);
  console.log(`[Bridge] [Hive→Nostr] ℹ️ Cleaned post body length: ${cleanedBody.length} chars`);
  const plainBody = stripMarkdown(cleanedBody);
  console.log(`[Bridge] [Hive→Nostr] ℹ️ Plain post body length: ${plainBody.length} chars`);
  let content = plainBody;
  const hiveLink = createHiveLink(post.author, post.permlink);
  const footer = `\n\nAuto cross-post via Hostr v${VERSION} (br) at https://hostr-home.vercel.app`;
  const isTruncated = content.length > 380;
  if (isTruncated) {
    console.log(`[Bridge] [Hive→Nostr] ✂️ Truncating content from ${content.length} to 380 chars`);
    const suffix = `... read original post in full:\n${hiveLink}`;
    content = content.substring(0, 380 - suffix.length) + suffix;
  }
  content += `\n\nOriginally posted on Hive at ${hiveLink}${footer}`;
  const postData = { content, permlink: post.permlink };
  if (!hiveToNostrQueue.some(item => item.permlink === post.permlink)) {
    hiveToNostrQueue.push(postData);
    console.log(`[Bridge] [Hive→Nostr] 📥 Added to queue: "${post.title}" (Permlink: ${post.permlink})`);
    console.log(`[Bridge] [Hive→Nostr] 📊 Queue status: ${hiveToNostrQueue.length} items waiting`);
    processHiveToNostrQueue();
  }
}

async function postToNostr(post) {
  console.log(`[Bridge] [Hive→Nostr] 📤 Attempting to post to Nostr: "${post.content.substring(0, 30)}..."`);
  const tags = [['t', 'hostr']];
  const event = {
    kind: 1,
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
        console.warn(`[Bridge] [Hinostr] ⚠️ Failed to publish to relay ${relay}: ${error.message || 'Unknown error'}`);
      }
    }
    if (successfulRelays.length < 3) {
      throw new Error(`Failed to publish to at least 3 relays; successful: ${successfulRelays.join(', ')}`);
    }
    console.log(`[Bridge] [Hive→Nostr] ✅ Published to Nostr, event ID: ${signedEvent.id}, kind=1, relays: ${successfulRelays.join(', ')}`);
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
async function start() {
  console.log(`[Bridge] ℹ️ Loaded environment: HIVE_USERNAME=${HIVE_USERNAME}, NOSTR_PUBLIC_KEY=${NOSTR_PUBLIC_KEY}`);
  cleanProcessedEntries();
  try {
    await Promise.all([listenToNostr(), pollHive()]);
    keepAlive();
  } catch (err) {
    console.error('[Bridge] ❌ Error in bridge initialization:', err.message);
    setTimeout(start, TWO_MINUTES_MS);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`[Bridge] 👋 Shutting down... Nostr→Hive: ${nostrToHiveQueue.length}, Hive→Nostr: ${hiveToNostrQueue.length} items in queues`);
  pool.close(relays);
  process.exit(0);
});

// Run the script
start().catch((err) => {
  console.error('[Bridge] ❌ Error starting bridge:', err.message);
  process.exit(1);
});

// bidirectional-bridge.js v0.1.38 Snaps+Longform