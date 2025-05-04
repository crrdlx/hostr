// Nostr-to-Hive: listens for kind 30023 (long form) then posts to Hive.
// Hive-to-Nostr: listens for a Hive post, posts as kind 1 on Nostr, truncating at 380 characters with a link back to original Hive post.
import 'dotenv/config';
import { SimplePool, finalizeEvent, getPublicKey } from 'nostr-tools';
import { Client, PrivateKey } from '@hiveio/dhive';
import WebSocket from 'ws';
import fs from 'fs';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Version constant
const VERSION = '0.0.13';

// Set global WebSocket for nostr-tools
global.WebSocket = WebSocket;

// Load credentials
const HIVE_USERNAME = process.env.HIVE_USERNAME;
const HIVE_POSTING_KEY = process.env.HIVE_POSTING_KEY;
const NOSTR_PUBLIC_KEY = process.env.NOSTR_PUBLIC_KEY;
const NOSTR_PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY;

console.log(`Starting bidirectional bridge for Hive user: ${HIVE_USERNAME}, Nostr pubkey: ${NOSTR_PUBLIC_KEY}`);

if (!HIVE_USERNAME || !HIVE_POSTING_KEY || !NOSTR_PUBLIC_KEY || !NOSTR_PRIVATE_KEY) {
  throw new Error('Missing required environment variables in .env file');
}

// Hive setup
const hiveClient = new Client('https://api.hive.blog');

// Nostr setup
const relays = [
  'wss://nostr.wine',
  'wss://relay.nostr.band',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr-pub.wellorder.net',
  'wss://offchain.pub',
  'wss://relay.snort.social',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://purplepag.es',
];
const pool = new SimplePool();

// Rate limiting and queue variables
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWO_MINUTES_MS = 2 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
let lastHivePostTime = 0;
let nostrToHiveQueue = [];
let hiveToNostrQueue = [];
let nostrToHivePosting = false;
let hiveToNostrPosting = false;
const PROCESSED_PERMLINKS_FILE = 'processed_permlinks.json';
const PROCESSED_EVENTS_FILE = 'processed_nostr_events.json';
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

// --- Utility Functions ---

function cleanContent(content) {
  let cleaned = content.replace(/<[^>]+>/g, '');
  cleaned = cleaned.replace(/posted via.*d\.buzz.*$/i, '');
  cleaned = cleaned.replace(/\s*\n\s*/g, '\n').trim();
  return cleaned;
}

// --- Nostr-to-Hive Functions ---

function generateTitle(content, tags) {
  const titleTag = tags.find(tag => tag[0] === 'title' && tag[1]);
  if (titleTag) {
    return titleTag[1].substring(0, 80);
  }
  const cleanContent = content.replace(/^#\s*/gm, '').trim();
  return cleanContent.substring(0, 80) || 'Untitled Nostr Article';
}

function createNostrLink(eventId) {
  return `https://njump.me/${eventId}`;
}

function isRecentEvent(event) {
  const now = Math.floor(Date.now() / 1000);
  const age = now - event.created_at;
  const isRecent = age < (5 * 60);
  if (!isRecent) {
    console.log(`[Nostr→Hive] ⏭️ Skipping old event (${Math.floor(age/60)}m ${age%60}s old): kind=${event.kind}, content="${event.content.substring(0, 30)}..."`);
  }
  return isRecent;
}

async function processNostrToHiveQueue() {
  if (nostrToHivePosting || nostrToHiveQueue.length === 0) {
    return;
  }

  const now = Date.now();
  if (now - lastHivePostTime < FIVE_MINUTES_MS && lastHivePostTime !== 0) {
    const waitTime = FIVE_MINUTES_MS - (now - lastHivePostTime);
    console.log(`[Nostr→Hive] ⏳ Waiting ${Math.ceil(waitTime/1000)} seconds before posting...`);
    setTimeout(processNostrToHiveQueue, waitTime);
    return;
  }

  nostrToHivePosting = true;
  const post = nostrToHiveQueue.shift();

  try {
    const result = await postToHive(post.content, post.eventId, post.tags, post.kind);
    processedNostrEvents.add([post.eventId, Date.now()]);
    writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
    lastHivePostTime = Date.now();
    console.log(`[Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items remaining`);
  } catch (error) {
    if (error.message?.includes('You may only post once every 5 minutes')) {
      nostrToHiveQueue.unshift(post);
      console.log('[Nostr→Hive] ⏱️ Rate limit hit, will try again after cooldown');
      setTimeout(processNostrToHiveQueue, FIVE_MINUTES_MS);
    } else {
      console.error('[Nostr→Hive] ❌ Error posting to Hive:', error.message);
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
    console.log(`[Nostr→Hive] ⏭️ Skipping already processed event: kind=${event.kind}, id=${event.id}, age=${Math.floor(age/60)}m${age%60}s, content="${event.content.substring(0, 30)}..."`);
    return;
  }
  if (event.content.includes('Auto cross-post from Hive via Hostr')) {
    console.log(`[Nostr→Hive] ⏭️ Skipping Hive-originated event: kind=${event.kind}, id=${event.id}, content="${event.content.substring(0, 30)}..."`);
    return;
  }
  const isReply = event.tags.some(tag => tag[0] === 'e' || tag[0] === 'p');
  if (isReply) {
    console.log(`[Nostr→Hive] ⏭️ Skipping reply event: kind=${event.kind}, id=${event.id}, content="${event.content.substring(0, 30)}..."`);
    return;
  }
  const post = { content: event.content, eventId: event.id, tags: event.tags, kind: event.kind };
  if (!nostrToHiveQueue.some(item => item.eventId === event.id)) {
    nostrToHiveQueue.push(post);
    console.log(`[Nostr→Hive] 📥 Added to queue: kind=${event.kind}, id=${event.id}, age=${Math.floor(age/60)}m${age%60}s, content="${event.content.substring(0, 30)}..."`);
    console.log(`[Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items waiting`);
    processNostrToHiveQueue();
  }
}

async function postToHive(content, eventId, tags, kind) {
  console.log(`[Nostr→Hive] 📤 Attempting to post to Hive: kind=${kind}, content="${content.substring(0, 30)}..."`);
  const permlink = Math.random().toString(36).substring(2);
  const title = generateTitle(content, tags);
  const nostrLink = createNostrLink(eventId);
  const body = `${content}\n\n---\n\n*This article originated on [Nostr](${nostrLink})*\n\nAuto cross-post via Hostr v${VERSION} at https://github.com/crrdlx/hostr`;
  const jsonMetadata = JSON.stringify({ 
    tags: ['hostr'], 
    app: 'hostr-bridge/1.0' 
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
    console.log(`[Nostr→Hive] ✅ Posted to Hive: ${result.id}, Permlink: ${permlink}, Title: "${title}"`);
    return result;
  } catch (error) {
    console.error('[Nostr→Hive] ❌ Error posting to Hive:', error.message);
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
      console.log(`[Nostr→Hive] 🔌 Connected to relay: ${relay}`);
    } catch (err) {
      console.warn(`[Nostr→Hive] ⚠️ Failed to connect to relay ${relay}: ${err.message || 'Unknown error'}`);
    }
  }
  if (connectedRelays.length === 0) {
    console.error('[Nostr→Hive] ❌ No relays connected, continuing to poll Hive');
    setTimeout(listenToNostr, TWO_MINUTES_MS);
    return;
  }
  const since = now - (5 * 60);
  const filter = { kinds: [30023], authors: [NOSTR_PUBLIC_KEY], since };
  console.log(`[Nostr→Hive] 🕒 Processing events after ${new Date(since * 1000).toISOString()}`);
  console.log(`[Nostr→Hive] 🔍 Subscribing with filter: ${JSON.stringify(filter)}`);

  try {
    const sub = pool.subscribeMany(connectedRelays, [filter], {
      onevent: (event) => {
        console.log(`[Nostr→Hive] 📝 New Nostr event: kind=${event.kind}, id=${event.id}, pubkey=${event.pubkey}, content="${event.content.substring(0, 30)}..."`);
        if (isRecentEvent(event)) {
          queueNostrToHive(event);
        }
      },
      oneose: () => console.log('[Nostr→Hive] 📦 End of stored events, listening for new ones'),
      onerror: (err) => {
        if (err.message?.includes('no active subscription')) {
          console.warn('[Nostr→Hive] ⚠️ Subscription closed by relay, refreshing...');
          setTimeout(listenToNostr, 1000);
        } else {
          console.error('[Nostr→Hive] ❌ Subscription error:', err.message || err);
        }
      },
    });
    setTimeout(() => {
      sub.close();
      console.log('[Nostr→Hive] 🔄 Subscription closed, refreshing...');
      setTimeout(listenToNostr, 1000);
    }, 60 * 1000);
    console.log('[Nostr→Hive] 🎧 Listening for Nostr events...');
  } catch (err) {
    console.error('[Nostr→Hive] ❌ Error subscribing to Nostr events:', err.message);
    setTimeout(listenToNostr, TWO_MINUTES_MS);
  }
}

// --- Hive-to-Nostr Functions ---

async function pollHive() {
  try {
    console.log('[Hive→Nostr] 🔍 Checking for new Hive notes...');
    const posts = await fetchRecentHivePosts();
    const sortedPosts = [...posts].sort((a, b) => 
      new Date(a.created + 'Z').getTime() - new Date(b.created + 'Z').getTime()
    );
    let newPostsFound = 0;

    for (const post of sortedPosts) {
      console.log(`[Hive→Nostr] ℹ️ Processing post: author=${post.author}, title="${post.title}", permlink=${post.permlink}, created=${post.created}, parent_author=${post.parent_author || ''}`);
      if (post.author !== HIVE_USERNAME) {
        console.log(`[Hive→Nostr] ⏭️ Skipping note from ${post.author} (not ${HIVE_USERNAME})`);
        continue;
      }
      if (post.parent_author) {
        console.log(`[Hive→Nostr] ⏭️ Skipping comment: "${post.title || 'Untitled'}" (Permlink: ${post.permlink})`);
        continue;
      }
      if (!post.body) {
        console.log(`[Hive→Nostr] ⚠️ Skipping post with missing body: "${post.title || 'Untitled'}" (Permlink: ${post.permlink})`);
        continue;
      }
      const bodyLower = post.body.toLowerCase();
      if (bodyLower.includes('originated on [nostr]') || bodyLower.includes('originated on nostr') || bodyLower.includes('read full note')) {
        console.log(`[Hive→Nostr] ⏭️ Skipping Nostr-originated or truncated note: "${post.title}" (Permlink: ${post.permlink})`);
        continue;
      }
      if (isRecentPost(post)) {
        console.log(`[Hive→Nostr] 📝 Found recent Hive note: "${post.title}"`);
        queueHiveToNostr(post);
        newPostsFound++;
      }
    }

    if (newPostsFound === 0) {
      console.log('[Hive→Nostr] 📭 No new notes found');
    }
  } catch (error) {
    console.error('[Hive→Nostr] ❌ Error polling Hive:', error.message);
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
    console.log(`[Hive→Nostr] 🔍 Fetching posts with query: ${JSON.stringify(query)}`);
    const posts = await hiveClient.database.getDiscussions('blog', query);
    console.log(`[Hive→Nostr] ℹ️ API returned ${posts.length} posts: ${JSON.stringify(posts.map(p => ({ author: p.author, permlink: p.permlink, created: p.created })))}`);
    return posts;
  } catch (error) {
    console.error('[Hive→Nostr] ❌ Error fetching Hive posts:', error.message);
    return [];
  }
}

function isRecentPost(post) {
  const postTime = new Date(post.created + 'Z').getTime();
  const now = Date.now();
  const age = now - postTime;
  const isRecent = age < FIVE_MINUTES_MS;
  if (!isRecent) {
    const minutes = Math.floor(age / 60000);
    const seconds = Math.floor((age % 60000) / 1000);
    console.log(`[Hive→Nostr] ⏭️ Skipping old note (${minutes}m ${seconds}s old): "${post.title}"`);
  }
  return isRecent;
}

function createHiveLink(permlink) {
  return `https://hive.blog/@${HIVE_USERNAME}/${permlink}`;
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
    console.log(`[Hive→Nostr] 📊 Queue status: ${hiveToNostrQueue.length} items remaining`);
  } catch (error) {
    console.error('[Hive→Nostr] ❌ Error processing note:', error.message);
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
  const bodyLower = post.body ? post.body.toLowerCase() : '';
  if (bodyLower.includes('originated on [nostr]') || bodyLower.includes('originated on nostr') || bodyLower.includes('read full note')) {
    console.log(`[Hive→Nostr] ⏭️ Skipping Nostr-originated or truncated note: "${post.title}" (Permlink: ${post.permlink})`);
    return;
  }
  console.log(`[Hive→Nostr] ℹ️ Checking permlink: ${post.permlink}, processed size: ${processedHivePermlinks.size}`);
  if (processedHivePermlinks.has(post.permlink) || [...processedHivePermlinks].some(([permlink]) => permlink === post.permlink)) {
    console.log(`[Hive→Nostr] ⏭️ Skipping already processed note: "${post.title}" (Permlink: ${post.permlink})`);
    return;
  }
  processedHivePermlinks.add([post.permlink, Date.now()]);
  writeJsonFileSync(PROCESSED_PERMLINKS_FILE, [...processedHivePermlinks]);
  console.log(`[Hive→Nostr] ℹ️ Added permlink to processed: ${post.permlink}, new size: ${processedHivePermlinks.size}`);
  console.log(`[Hive→Nostr] ℹ️ Raw note body length: ${post.body.length} chars`);
  const cleanedBody = cleanContent(post.body);
  console.log(`[Hive→Nostr] ℹ️ Cleaned note body length: ${cleanedBody.length} chars`);
  let content = `${post.title}\n\n${cleanedBody}`;
  const hiveLink = createHiveLink(post.permlink);
  const footer = `\n\nAuto cross-post via Hostr bridge v${VERSION}`;
  const isTruncated = content.length > 380;
  if (isTruncated) {
    console.log(`[Hive→Nostr] ✂️ Truncating content from ${content.length} to 380 chars`);
    const suffix = `... read full note:\n${hiveLink}`;
    content = content.substring(0, 380 - (suffix.length + footer.length)) + suffix;
  } else {
    content += `\n\nOriginally posted on Hive at ${hiveLink}`;
  }
  content += footer;
  const postData = { content, permlink: post.permlink, isTruncated };
  if (!hiveToNostrQueue.some(item => item.permlink === post.permlink)) {
    hiveToNostrQueue.push(postData);
    console.log(`[Hive→Nostr] 📥 Added to queue: "${post.title}" (Permlink: ${post.permlink})`);
    console.log(`[Hive→Nostr] 📊 Queue status: ${hiveToNostrQueue.length} items waiting`);
    processHiveToNostrQueue();
  }
}

async function postToNostr(post) {
  console.log(`[Hive→Nostr] 📤 Attempting to post to Nostr: "${post.content.substring(0, 30)}..."`);
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
        console.log(`[Hive→Nostr] ✅ Published to relay: ${relay}`);
      } catch (error) {
        console.warn(`[Hive→Nostr] ⚠️ Failed to publish to relay ${relay}: ${error.message || 'Unknown error'}`);
      }
    }
    if (successfulRelays.length < 3) {
      throw new Error(`Failed to publish to at least 3 relays; successful: ${successfulRelays.join(', ')}`);
    }
    console.log(`[Hive→Nostr] ✅ Published to Nostr, event ID: ${signedEvent.id}, kind=1, relays: ${successfulRelays.join(', ')}`);
    return signedEvent;
  } catch (error) {
    console.error('[Hive→Nostr] ❌ Error posting to Nostr:', error.message);
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
});

// Initialization
async function start() {
  console.log(`[Bridge] ℹ️ Loaded environment: HIVE_USERNAME=${HIVE_USERNAME}, NOSTR_PUBLIC_KEY=${NOSTR_PUBLIC_KEY}`);
  cleanProcessedEntries();
  try {
    await listenToNostr();
    await pollHive();
    keepAlive();
  } catch (err) {
    console.error('[Bridge] ❌ Error in bridge initialization:', err.message);
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