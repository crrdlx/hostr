// v 0.0.4
import 'dotenv/config';
import { SimplePool, finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { Client, PrivateKey } from '@hiveio/dhive';
import WebSocket from 'ws';
import fs from 'fs';

// Version constant (matches comment at top of file)
const VERSION = '0.0.4';

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
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processedHivePermlinks]));
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
    posts.forEach(post => {
      console.log(`[Hive→Nostr] 📋 Post: author=${post.author}, permlink=${post.permlink}, title="${post.title}", parent_author=${post.parent_author || ''}, created=${post.created}`);
    });
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
    console.log(`[Hive→Nostr] ⏭️ Skipping old post (${minutes}m ${seconds}s old, created ${post.created} UTC): "${post.title}"`);
  }
  return isRecent;
}

// Create Hive post link
function createHiveLink(permlink) {
  return `https://hive.blog/@${HIVE_USERNAME}/${permlink}`;
}

// Fetch Nostr event by ID with retry
async function fetchNostrEvent(eventId, retries = 5, timeoutMs = 45000) {
  console.log(`[Hive→Nostr] 🔍 Fetching Nostr event: id=${eventId}, retries left=${retries}`);
  const now = Math.floor(Date.now() / 1000);
  const since = now - (7 * 24 * 60 * 60); // Look back 7 days
  const primaryFilter = { ids: [eventId], since };
  const fallbackFilter = { kinds: [1, 30023], authors: [NOSTR_PUBLIC_KEY], since };

  // Ensure relay connections
  for (const relay of relays) {
    try {
      await pool.ensureRelay(relay);
      console.log(`[Hive→Nostr] 🔌 Reconnected to relay for fetch: ${relay}`);
    } catch (err) {
      console.error(`[Hive→Nostr] ⚠️ Failed to reconnect to relay ${relay}: ${err.message}`);
    }
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Try primary filter
      console.log(`[Hive→Nostr] ℹ️ Trying primary filter: ${JSON.stringify(primaryFilter)}`);
      const event = await pool.get(relays, primaryFilter, { timeout: timeoutMs });
      if (event) {
        console.log(`[Hive→Nostr] 📝 Fetched event JSON: ${JSON.stringify(event, null, 2)}`);
        // Log relays where event was found
        for (const relay of relays) {
          try {
            const relayEvent = await pool.get([relay], primaryFilter, { timeout: timeoutMs / 2 });
            if (relayEvent) {
              console.log(`[Hive→Nostr] ✅ Event found on relay: ${relay}`);
            }
          } catch (error) {
            console.log(`[Hive→Nostr] ⚠️ Event not found on relay ${relay}: ${error.message}`);
          }
        }
        return event;
      } else {
        console.log(`[Hive→Nostr] ⚠️ No event found for id=${eventId} with primary filter on attempt ${attempt}`);
      }
    } catch (error) {
      console.error(`[Hive→Nostr] ❌ Error fetching event on attempt ${attempt} with primary filter: ${error.message}`);
    }

    // Try fallback filter on last attempt
    if (attempt === retries) {
      try {
        console.log(`[Hive→Nostr] ℹ️ Trying fallback filter: ${JSON.stringify(fallbackFilter)}`);
        const event = await pool.get(relays, fallbackFilter, { timeout: timeoutMs });
        if (event && event.id === eventId) {
          console.log(`[Hive→Nostr] 📝 Fetched event JSON via fallback: ${JSON.stringify(event, null, 2)}`);
          for (const relay of relays) {
            try {
              const relayEvent = await pool.get([relay], fallbackFilter, { timeout: timeoutMs / 2 });
              if (relayEvent && relayEvent.id === eventId) {
                console.log(`[Hive→Nostr] ✅ Event found on relay: ${relay}`);
              }
            } catch (error) {
              console.log(`[Hive→Nostr] ⚠️ Event not found on relay ${relay}: ${error.message}`);
            }
          }
          return event;
        } else {
          console.log(`[Hive→Nostr] ⚠️ No matching event found for id=${eventId} with fallback filter`);
        }
      } catch (error) {
        console.error(`[Hive→Nostr] ❌ Error fetching event with fallback filter: ${error.message}`);
      }
    }

    if (attempt < retries) {
      console.log(`[Hive→Nostr] ⏳ Retrying fetch in 3s...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  console.log(`[Hive→Nostr] ⚠️ Failed to fetch event id=${eventId} after ${retries} attempts`);
  return null;
}

// Process Hive-to-Nostr queue
async function processHiveToNostrQueue() {
  if (hiveToNostrPosting || hiveToNostrQueue.length === 0) {
    return;
  }

  hiveToNostrPosting = true;
  const post = hiveToNostrQueue.shift();

  try {
    const signedEvent = await postToNostr(post);
    processedHivePermlinks.add(post.permlink);
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processedHivePermlinks]));
    console.log(`[Hive→Nostr] 📊 Queue status: ${hiveToNostrQueue.length} items remaining`);
    // Fetch the published event for debugging (non-blocking)
    try {
      await fetchNostrEvent(signedEvent.id);
    } catch (error) {
      console.error(`[Hive→Nostr] ⚠️ Failed to fetch event ${signedEvent.id} for verification: ${error.message}`);
    }
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
  // Double-check for Nostr origin
  const bodyLower = post.body.toLowerCase();
  if (bodyLower.includes('originated on [nostr]') || bodyLower.includes('originated on nostr')) {
    console.log(`[Hive→Nostr] ⏭️ Skipping Nostr-originated post: "${post.title}" (Permlink: ${post.permlink})`);
    return;
  }
  // Skip already processed posts
  if (processedHivePermlinks.has(post.permlink)) {
    console.log(`[Hive→Nostr] ⏭️ Skipping already processed post: "${post.title}" (Permlink: ${post.permlink})`);
    return;
  }
  console.log(`[Hive→Nostr] ℹ️ Post body length: ${post.body.length} chars`);
  const summary = post.body.substring(0, 60).replace(/\n+/g, ' ').trim().substring(0, 60); // Strict 60 chars
  const content = `# ${post.title}\n\n${post.body}\n\n---\n\nOriginally posted on Hive at ${createHiveLink(post.permlink)}\n\nCross-posted using [Hostr](https://github.com/crrdlx/hostr), version ${VERSION}`;
  const postData = { content, permlink: post.permlink, title: post.title, summary };
  if (!hiveToNostrQueue.some(item => item.permlink === post.permlink)) {
    hiveToNostrQueue.push(postData);
    console.log(`[Hive→Nostr] 📥 Added to queue: "${post.title}" (Permlink: ${post.permlink})`);
    console.log(`[Hive→Nostr] 📊 Queue status: ${hiveToNostrQueue.length} items waiting`);
    processHiveToNostrQueue();
  } else {
    console.log(`[Hive→Nostr] ⏭️ Skipping duplicate post: "${post.title}"`);
  }
}

// Post to Nostr
async function postToNostr(post) {
  console.log(`[Hive→Nostr] 📤 Attempting to post to Nostr: "${post.content.substring(0, 30)}..."`);
  const isLongPost = post.content.length > 280;
  const eventKind = isLongPost ? 30023 : 1;
  const createdAt = Math.floor(Date.now() / 1000);
  // Parse JSON metadata if available
  let hiveTags = ['story', 'hostr', 'nostr', 'article'];
  try {
    if (post.json_metadata) {
      const metadata = typeof post.json_metadata === 'string' ? JSON.parse(post.json_metadata) : post.json_metadata;
      if (metadata.tags && Array.isArray(metadata.tags)) {
        hiveTags = [...new Set([...hiveTags, ...metadata.tags])];
      }
    }
  } catch (error) {
    console.error(`[Hive→Nostr] ⚠️ Error parsing JSON metadata: ${error.message}`);
  }
  const tags = eventKind === 30023 ? [
    ['title', post.title],
    ['summary', post.summary],
    ['client', `hostr-longform30023/${VERSION}`],
    ['published_at', createdAt.toString()],
    ['d', `hive:${HIVE_USERNAME}:${post.permlink}`],
    ['alt', `Long-form article: ${post.title} by ${HIVE_USERNAME}`],
    ['r', createHiveLink(post.permlink)],
    ...hiveTags.map(tag => ['t', tag]),
  ] : [
    ['client', `hostr-longform30023/${VERSION}`],
    ['r', createHiveLink(post.permlink)],
    ...hiveTags.map(tag => ['t', tag]),
  ];

  console.log(`[Hive→Nostr] ℹ️ Posting as kind=${eventKind} (length=${post.content.length})`);
  console.log(`[Hive→Nostr] ℹ️ Tags: ${JSON.stringify(tags)}`);
  console.log(`[Hive→Nostr] ℹ️ Content preview: "${post.content.substring(0, 100)}..."`);

  const event = {
    kind: eventKind,
    created_at: createdAt,
    tags,
    content: post.content,
    pubkey: getPublicKey(NOSTR_PRIVATE_KEY),
  };

  console.log(`[Hive→Nostr] 📝 Unsigned Event JSON: ${JSON.stringify(event, null, 2)}`);

  try {
    const signedEvent = finalizeEvent(event, Buffer.from(NOSTR_PRIVATE_KEY, 'hex'));
    console.log(`[Hive→Nostr] 📝 Signed Event JSON: ${JSON.stringify(signedEvent, null, 2)}`);
    const nevent = nip19.neventEncode({ id: signedEvent.id, relays, author: signedEvent.pubkey });
    console.log(`[Hive→Nostr] 📝 Nevent: ${nevent}`);
    const successfulRelays = [];
    for (const relay of relays) {
      try {
        await pool.publish([relay], signedEvent);
        successfulRelays.push(relay);
        console.log(`[Hive→Nostr] ✅ Published to relay: ${relay}`);
      } catch (error) {
        console.error(`[Hive→Nostr] ⚠️ Failed to publish to relay ${relay}: ${error.message}`);
      }
    }
    if (successfulRelays.length === 0) {
      throw new Error('Failed to publish to any relays');
    }
    console.log(`[Hive→Nostr] ✅ Published to Nostr, event ID: ${signedEvent.id}, kind=${eventKind}, relays: ${successfulRelays.join(', ')}`);
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
      if (bodyLower.includes('originated on [nostr]') || bodyLower.includes('originated on nostr')) {
        console.log(`[Hive→Nostr] ⏭️ Skipping Nostr-originated post: "${post.title}" (Permlink: ${post.permlink})`);
        continue;
      }
      if (isRecentPost(post)) {
        console.log(`[Hive→Nostr] 📝 Found recent Hive post: "${post.title}"`);
        queueHiveToNostr(post);
        newPostsFound++;
      }
    }

    if (newPostsFound === 0) {
      console.log('[Hive→Nostr] 📭 No new posts found');
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
  // Fetch existing events for debugging
  await fetchNostrEvent('74522852adc66725e21f0a5890472672ba343a3ac8'); // Bird story 3
  await fetchNostrEvent('a25ee8579eeb67a84dc9950db17e2eb309fc26329af2cba8e4f73e8aa70758f6'); // Bird Story 4
  await fetchNostrEvent('7ee41426033f3979ebe992842baa4dcad44e74e5ee625b5ce543e54cde9d4f37'); // Panda Story 1
  await fetchNostrEvent('40d3563239a277b45050cac711640265094eb1c5815c8de20da798a76c10a425'); // Red Panda Story Test 13
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