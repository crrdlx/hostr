// v 0.0.3
import 'dotenv/config';
import { SimplePool, finalizeEvent, getPublicKey } from 'nostr-tools';
import { Client, PrivateKey } from '@hiveio/dhive';
import WebSocket from 'ws';
import fs from 'fs';

// Version constant (matches comment at top of file)
const VERSION = '0.0.3';

// Explicitly set global WebSocket for nostr-tools
global.WebSocket = WebSocket;

// Load credentials
const HIVE_USERNAME = process.env.HIVE_USERNAME;
const HIVE_POSTING_KEY = process.env.HIVE_POSTING_KEY;
const NOSTR_PUBLIC_KEY = process.env.NOSTR_PUBLIC_KEY;
const NOSTR_PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY;

console.log(`Starting longform30023 bidirectional bridge for Hive user: ${HIVE_USERNAME}, Nostr pubkey: ${NOSTR_PUBLIC_KEY}`);

if (!HIVE_USERNAME || !HIVE_POSTING_KEY || !NOSTR_PUBLIC_KEY || !NOSTR_PRIVATE_KEY) {
  throw new Error('Missing required environment variables in .env file');
}

// Hive setup
const hiveClient = new Client('https://api.hive.blog');

// Nostr setup
const relays = [
  'wss://nostr.wine', // Kind 30023 focused
  'wss://purplepag.es', // Kind 30023 focused
  'wss://relay.nostr.band', // Kind 30023 reliable
  'wss://relay.damus.io', // General reliability
  'wss://nos.lol',
  'wss://nostr-pub.wellorder.net',
  'wss://offchain.pub',
  'wss://relay.snort.social', // Yakihonne/Habla
  'wss://relay.primal.net', // Yakihonne/Habla
  'wss://nostr.oxtr.dev', // Yakihonne/Habla
  'wss://nostr-relay.wlvs.space', // Yakihonne
  'wss://nostr.yakihonne.com', // Yakihonne-specific
  'wss://relay.current.fyi', // Broader propagation
];
const pool = new SimplePool();

// Rate limiting and queue variables
const FIVE_MINUTES_MS = 5 * 60 * 1000; // 5 minutes
const TWO_MINUTES_MS = 2 * 60 * 1000; // Poll Hive every 2 minutes
let lastHivePostTime = 0;
let nostrToHiveQueue = [];
let hiveToNostrQueue = [];
let nostrToHivePosting = false;
let hiveToNostrPosting = false;
const PROCESSED_FILE = 'processed_permlinks.json';
let processedHivePermlinks = new Set(fs.existsSync(PROCESSED_FILE) ? JSON.parse(fs.readFileSync(PROCESSED_FILE)) : []);

// --- Nostr-to-Hive Functions ---

// Generate title for kind 30023 post
function generateTitle(content, tags) {
  const titleTag = tags.find(tag => tag[0] === 'title');
  if (titleTag && titleTag[1]) {
    return titleTag[1].substring(0, 80); // Use title tag, truncate to 80 chars
  }
  return content.substring(0, 80) || 'Untitled Nostr Long-Form Article'; // Fallback
}

// Create Nostr event link
function createNostrLink(eventId) {
  return `https://njump.me/${eventId}`;
}

// Check if Nostr event is recent (within 10 minutes)
function isRecentEvent(event) {
  const now = Math.floor(Date.now() / 1000);
  const eventTime = event.created_at;
  const age = now - eventTime;
  const isRecent = age < (10 * 60); // Extended to 10 minutes
  if (!isRecent) {
    const minutes = Math.floor(age / 60);
    const seconds = age % 60;
    console.log(`[Nostr→Hive] ⏭️ Skipping old article (${minutes}m ${seconds}s old): "${event.content.substring(0, 30)}..."`);
  }
  return isRecent;
}

// Process Nostr-to-Hive queue
async function processNostrToHiveQueue() {
  if (nostrToHivePosting || nostrToHiveQueue.length === 0) {
    return;
  }

  const now = Date.now();
  const timeElapsed = now - lastHivePostTime;

  if (timeElapsed < FIVE_MINUTES_MS && lastHivePostTime !== 0) {
    const waitTime = FIVE_MINUTES_MS - timeElapsed;
    console.log(`[Nostr→Hive] ⏳ Waiting ${Math.ceil(waitTime/1000)} seconds before posting...`);
    setTimeout(processNostrToHiveQueue, waitTime);
    return;
  }

  nostrToHivePosting = true;
  const post = nostrToHiveQueue.shift();

  try {
    await postToHive(post.content, post.eventId, post.tags);
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

// Queue Nostr-to-Hive post
function queueNostrToHive(event) {
  if (event.content.includes('Originally posted on Hive at https://hive.blog')) {
    console.log(`[Nostr→Hive] ⏭️ Skipping Hive-originated article: "${event.content.substring(0, 30)}..."`);
    return;
  }
  const post = { content: event.content, eventId: event.id, tags: event.tags };
  if (!nostrToHiveQueue.some(item => item.content === event.content)) {
    nostrToHiveQueue.push(post);
    console.log(`[Nostr→Hive] 📥 Added to queue: kind=30023, content="${event.content.substring(0, 30)}..."`);
    console.log(`[Nostr→Hive] 📊 Queue status: ${nostrToHiveQueue.length} items waiting`);
    processNostrToHiveQueue();
  } else {
    console.log(`[Nostr→Hive] ⏭️ Skipping duplicate article: "${event.content.substring(0, 30)}..."`);
  }
}

// Post to Hive
async function postToHive(content, eventId, tags) {
  console.log(`[Nostr→Hive] 📤 Attempting to post to Hive: kind=30023, content="${content.substring(0, 30)}..."`);
  const permlink = Math.random().toString(36).substring(2);
  const title = generateTitle(content, tags);
  const nostrLink = createNostrLink(eventId);
  const body = `${content}\n\n---\n\n*This long-form article originated on [Nostr](${nostrLink})*\n\nCross-posted using [Hostr](https://github.com/crrdlx/hostr), version ${VERSION}`;
  const jsonMetadata = JSON.stringify({ 
    tags: ['nostr', 'hive', 'article'], 
    app: 'hostr-longform30023/1.0' 
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
    console.log(`[Nostr→Hive] ✅ Posted to Hive: ${result.id}, Title: "${title}"`);
    return result;
  } catch (error) {
    console.error('[Nostr→Hive] ❌ Error posting to Hive:', error.message);
    throw error;
  }
}

// Listen for Nostr kind 30023 events
async function listenToNostr() {
  const now = Math.floor(Date.now() / 1000);
  for (const relay of relays) {
    try {
      await pool.ensureRelay(relay);
      console.log(`[Nostr→Hive] 🔌 Connected to relay: ${relay}`);
    } catch (err) {
      console.error(`[Nostr→Hive] ❌ Failed to connect to relay ${relay}: ${err.message}`);
    }
  }
  const since = now - (10 * 60); // Look back 10 minutes
  const filter = { kinds: [1, 30023], authors: [NOSTR_PUBLIC_KEY], since };
  console.log(`[Nostr→Hive] 🕒 Processing events after ${new Date(since * 1000).toISOString()}`);
  console.log(`[Nostr→Hive] 🔍 Subscribing with filter: ${JSON.stringify(filter)}`);

  pool.subscribeMany(relays, [filter], {
    onevent: (event) => {
      if (event.kind === 1) {
        console.log(`[Nostr→Hive] ℹ️ Detected kind=1 event, ignoring: content="${event.content.substring(0, 30)}..."`);
        return;
      }
      console.log(`[Nostr→Hive] 📝 New Nostr long-form article: kind=${event.kind}, id=${event.id}, pubkey=${event.pubkey}, content="${event.content.substring(0, 30)}..."`);
      if (isRecentEvent(event)) {
        queueNostrToHive(event);
      }
    },
    oneose: () => console.log('[Nostr→Hive] 📦 End of stored events, listening for new ones'),
    onerror: (err) => console.error('[Nostr→Hive] ❌ Subscription error:', err.message || err),
  });
  console.log('[Nostr→Hive] 🎧 Listening for Nostr events...');
}

// --- Hive-to-Nostr Functions ---

// Fetch recent Hive posts
async function fetchRecentHivePosts() {
  try {
    const query = {
      tag: HIVE_USERNAME,
      limit: 10,
      truncate_body: 0,
    };
    console.log(`[Hive→Nostr] 🔍 Fetching posts with query: ${JSON.stringify(query)}`);
    const posts = await hiveClient.database.getDiscussions('blog', query);
    console.log(`[Hive→Nostr] 📋 Fetched ${posts.length} posts from Hive API`);
    return posts;
  } catch (error) {
    console.error('[Hive→Nostr] ❌ Error fetching Hive posts:', error.message);
    return [];
  }
}

// Check if Hive post is recent (within 5 minutes)
function isRecentPost(post) {
  const postTime = new Date(post.created + 'Z').getTime();
  const now = Date.now();
  const age = now - postTime;
  const isRecent = age < FIVE_MINUTES_MS;
  if (!isRecent) {
    const minutes = Math.floor(age / 60000);
    const seconds = Math.floor((age % 60000) / 1000);
    console.log(`[Hive→Nostr] ⏭️ Skipping old post (${minutes}m ${seconds}s old): "${post.title}"`);
  }
  return isRecent;
}

// Create Hive post link
function createHiveLink(permlink) {
  return `https://hive.blog/@${HIVE_USERNAME}/${permlink}`;
}

// Process Hive-to-Nostr queue
async function processHiveToNostrQueue() {
  if (hiveToNostrPosting || hiveToNostrQueue.length === 0) {
    return;
  }

  hiveToNostrPosting = true;
  const post = hiveToNostrQueue.shift();

  try {
    await postToNostr(post);
    processedHivePermlinks.add(post.permlink);
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processedHivePermlinks]));
    console.log(`[Hive→Nostr] 📊 Queue status: ${hiveToNostrQueue.length} items remaining`);
  } catch (error) {
    console.error('[Hive→Nostr] ❌ Error processing post:', error.message);
    hiveToNostrQueue.unshift(post);
    setTimeout(processHiveToNostrQueue, TWO_MINUTES_MS);
  } finally {
    hiveToNostrPosting = false;
    if (hiveToNostrQueue.length > 0) {
      setTimeout(processHiveToNostrQueue, 100);
    }
  }
}

// Queue Hive-to-Nostr post
function queueHiveToNostr(post) {
  // Double-check for Nostr origin or truncated posts
  const bodyLower = post.body.toLowerCase();
  if (bodyLower.includes('originated on [nostr]') || bodyLower.includes('originated on nostr') || bodyLower.includes('read full note below')) {
    console.log(`[Hive→Nostr] ⏭️ Skipping Nostr-originated or truncated note: "${post.title}" (Permlink: ${post.permlink})`);
    return;
  }
  // Skip already processed posts
  if (processedHivePermlinks.has(post.permlink)) {
    console.log(`[Hive→Nostr] ⏭️ Skipping already processed note: "${post.title}" (Permlink: ${post.permlink})`);
    return;
  }
  console.log(`[Hive→Nostr] ℹ️ Note body length: ${post.body.length} chars`);
  let content = `${post.title}\n\n${post.body}`;
  const hiveLink = createHiveLink(post.permlink);
  const footer = `\n\nCross-posted using Hostr (https://github.com/crrdlx/hostr), version ${VERSION}`;
  if (content.length > 280) {
    console.log(`[Hive→Nostr] ✂️ Truncating content from ${content.length} to 280 chars`);
    const suffix = `... read full note below:\n${hiveLink}`;
    content = content.substring(0, 280 - (suffix.length + footer.length)) + suffix;
  } else {
    content += `\n\nOriginally posted on Hive at ${hiveLink}`;
  }
  content += footer;
  const postData = { content, permlink: post.permlink };
  if (!hiveToNostrQueue.some(item => item.permlink === post.permlink)) {
    hiveToNostrQueue.push(postData);
    console.log(`[Hive→Nostr] 📥 Added to queue: "${post.title}" (Permlink: ${post.permlink})`);
    console.log(`[Hive→Nostr] 📊 Queue status: ${hiveToNostrQueue.length} items waiting`);
    processHiveToNostrQueue();
  } else {
    console.log(`[Hive→Nostr] ⏭️ Skipping duplicate note: "${post.title}"`);
  }
}

// Post to Nostr
async function postToNostr(post) {
  console.log(`[Hive→Nostr] 📤 Attempting to post to Nostr: "${post.content.substring(0, 30)}..."`);
  const event = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'story'],
      ['t', 'hostr'],
      ['t', 'nostr'],
      ['t', 'note'],
      ['r', createHiveLink(post.permlink)],
    ],
    content: post.content,
    pubkey: getPublicKey(NOSTR_PRIVATE_KEY),
  };

  try {
    const signedEvent = finalizeEvent(event, Buffer.from(NOSTR_PRIVATE_KEY, 'hex'));
    await Promise.any(pool.publish(relays, signedEvent));
    console.log(`[Hive→Nostr] ✅ Published to Nostr, event ID: ${signedEvent.id}, kind=1`);
    return signedEvent;
  } catch (error) {
    console.error('[Hive→Nostr] ❌ Error posting to Nostr:', error.message);
    throw error;
  }
}

// Poll Hive for new posts
async function pollHive() {
  try {
    console.log('[Hive→Nostr] 🔍 Checking for new Hive posts...');
    const posts = await fetchRecentHivePosts();
    const sortedPosts = [...posts].sort((a, b) => 
      new Date(a.created + 'Z').getTime() - new Date(b.created + 'Z').getTime()
    );
    let newPostsFound = 0;

    for (const post of sortedPosts) {
      if (post.author !== HIVE_USERNAME) {
        console.log(`[Hive→Nostr] ⏭️ Skipping post from ${post.author} (not ${HIVE_USERNAME})`);
        continue;
      }
      // Enhanced loop prevention
      const bodyLower = post.body.toLowerCase();
      if (bodyLower.includes('originated on [nostr]') || bodyLower.includes('originated on nostr') || bodyLower.includes('read full note below')) {
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

// Keep process alive
function keepAlive() {
  setInterval(() => {
    console.log('[Bridge] 🕒 Heartbeat: Still listening for events...');
  }, 60 * 1000); // Every 60 seconds
}

// Initialization
async function start() {
  console.log(`[Bridge] ℹ️ Loaded environment: HIVE_USERNAME=${HIVE_USERNAME}, NOSTR_PUBLIC_KEY=${NOSTR_PUBLIC_KEY}`);
  for (const relay of relays) {
    try {
      await pool.ensureRelay(relay);
      console.log(`[Bridge] 🔌 Connected to relay: ${relay}`);
    } catch (err) {
      console.error(`[Bridge] ❌ Failed to connect to relay ${relay}: ${err.message}`);
    }
  }
  console.log('[Bridge] 🎧 Starting longform30023 bidirectional bridge...');
  await listenToNostr();
  await pollHive();
  keepAlive();
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