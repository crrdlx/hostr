# Setup Guide for Nostr-Hive Bridge
Hostr, Nostr <--> Hive bridge: [https://github.com/crrdlx/hostr](https://github.com/crrdlx/hostr)

## What You’ll Need
- A computer or server with Ubuntu. Ideally, Hostr will run 24/7, so a VPS or dedicated device (like a Raspberry Pi) is ideal. Hostr was set up using Ubuntu 24.04.
- A Hive account. See sign up at [signup.hive.io](https://signup.hive.io) for options or use a free [VIP ticket](https://crrdlx.vercel.app/hive-vip-ticket.html).
- A Nostr account. Create one at [nstart.me](https://nstart.me) or use a Nostr app like [nostrudel.ninja](https://nostrudel.ninja) or [iris.to](https://iris.to).

## Step-by-Step Instructions

### 1. Install Basic Tools
You’ll need some software to run the bridge. Open a terminal (a command line window) on your Ubuntu system.

- Update your system:
  ```bash
  sudo apt update && sudo apt upgrade -y
  ```
- Install Node.js (to run the bridge):
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt install -y nodejs
  ```
- Install Git (to download the code):
  ```bash
  sudo apt install -y git
  ```
- Check versions:
  ```bash
  node -v
  npm -v
  git --version
  ```
  You should see `v18` or higher for Node.js, `8` or higher for npm, and `2` or higher for Git.

### 2. Download the Hostr Bridge Code
Get the bridge code from GitHub.

- Create a folder and download:
  ```bash
  mkdir ~/hostr
  cd ~/hostr
  git clone https://github.com/crrdlx/hostr.git .
  ```
- Check files:
  ```bash
  ls
  ```
  You should see a  `bidirectional-bridge.js`, `bidirectional-longform30023.js`, `package.json`, a license, `README.md`, and this  `SETUP.md`.


### 3. Install Dependencies
The bridge needs extra code libraries, which are listed in the `package.json` file.

- Install all required libraries:
  ```bash
  npm install
  ```
  This automatically downloads libraries like `nostr-tools` and `@hiveio/dhive`, along with other dependencies needed for the bridge. It may take a minute.

### 4. Set Up Your Credentials
The bridge needs your Hive and Nostr account details to post for you.

- Create a `.env` file. Keep this file private, as it contains sensitive keys!
  ```bash
  nano .env
  ```
- Paste this, filling in your details:
  ```
  # Your Hive username (e.g., hostr, without @)
  HIVE_USERNAME=your_hive_username
  # Your Hive POSTING key (starts with 5 or P, found in peakd.com > Wallet > Keys > Posting Private Key). Do NOT use Active or Owner keys!
  HIVE_POSTING_KEY=your_hive_posting_key
  # Your Nostr public key (starts with npub, found in your Nostr app like nostrudel.ninja > Settings > Public Key)
  NOSTR_PUBLIC_KEY=your_nostr_public_key
  # Your Nostr private key in HEX format (NOT nsec). If you have an nsec key, convert it to HEX at nostrtool.com (Load a privkey from nsec/hex). Keep this secret!
  NOSTR_PRIVATE_KEY=your_nostr_private_key
  ```
  - **Hive Username**: Your Hive account name (e.g., `hostr`, without `@`).
  - **Hive Posting Key**: Find this in your Hive wallet (e.g., on [peakd.com](https://peakd.com) under Wallet > Keys > Posting Private Key). Starts with `5` or `P`. Use the **Posting Key** (not Active or Owner) to avoid errors.
  - **Nostr Public Key**: Starts with `npub`. Get it from your Nostr app (e.g., [nostrudel.ninja](https://nostrudel.ninja) Settings > Public Key).
  - **Nostr Private Key**: Needs to be in HEX format (not `nsec`). If your app gives an `nsec` key, convert it to HEX at [nostrtool.com](https://nostrtool.com) (select "Load a privkey from nsec/hex"). Keep this secret!
- Save: Press `Ctrl+O`, `Enter`, then `Ctrl+X`.
- Secure the file:
  ```bash
  chmod 600 .env
  ```

### 5. Run the Bridge
Choose which bridge to run:
- `bidirectional-longform30023.js`: Only listens for and bridges Nostr *long-form articles* (kind 30023) to Hive, and it bridges Hive posts to Nostr. This is recommended if you post frequently on Nostr to avoid spamming Hive. "Frequently" might mean more than 3 posts per day.
- `bidirectional-bridge.js`: Listens for and bridges both  long-form articles (kind 30023) *and* short notes (kind 1) to Hive, and it bridges Hive posts to Nostr. Use this version if you post rarely on Nostr. By "rarely," that may mean 3 or fewer per day.

If unsure, start with `bidirectional-longform30023.js` to be safe. See `README.md` for details.

- Run your chosen bridge:
  ```bash
  node bidirectional-longform30023.js
  ```
  Or:
  ```bash
  node bidirectional-bridge.js
  ```
- You should see:
  ```
  Starting bidirectional bridge for Hive user: your_hive_username, Nostr pubkey: your_nostr_public_key
  [Bridge] 🔌 Connected to relay: wss://nos.lol
  ...
  [Nostr→Hive] 🎧 Listening for Nostr events...
  [Hive→Nostr] 🔍 Checking for new Hive posts...
  ```
- Test it:
  - In [nostrudel.ninja](https://nostrudel.ninja) or your Nostr client of choice, post a Nostr note. Use relays like `wss://nos.lol` or `wss://nostr.wine`. It should appear on Hive ([peakd.com/@your_hive_username](https://peakd.com)) shortly.
  - Post on Hive via [peakd.com](https://peakd.com) or your Hive front end of choice. It should appear on Nostr ([nostrudel.ninja](https://nostrudel.ninja)) shortly.
- Stop: Press `Ctrl+C`.

If tests work, stick with your chosen bridge. Just remember community posting norms on Hive. You don't want to post too often there (see the README.md).

### 6. Keep It Running
To run the bridge 24/7, use `tmux` (keeps it running even if you close the terminal).

- Install tmux:
  ```bash
  sudo apt install -y tmux
  ```
- Start a tmux session and start the bridge:
  ```bash
  tmux new -s hostr-bridge
  cd ~/hostr
  node bidirectional-longform30023.js
  ```
  Or:
  ```bash
  node bidirectional-bridge.js
  ```
- Detach (leave bridge running): Press `Ctrl+B`, then `D`.

- Check current tmux sessions:
  ```
  tmux ls
  ```
- Reconnect later:
  ```bash
  tmux a -t hostr-bridge
  ```
- Stop the bridge:
  ```bash
  tmux a -t hostr-bridge
  # Press Ctrl+C to stop
  # Press Ctrl+B, then D to detach
  ```

### Tips
- **Hive Posting**: Hive allows one post every 5 minutes. The bridge queues posts to avoid spamming. Too many Hive posts can lead to downvotes and lower reputation, so build your reputation carefully. Use `bidirectional-longform30023.js` if you post often on Nostr.
- **Nostr Relays**: The bridge uses relays like `wss://nos.lol` and `wss://nostr.wine`. Ensure your Nostr app (e.g., [nostrudel.ninja](https://nostrudel.ninja)) uses these relays for posts to be detected.
- **Security**: Never share your `.env` file or Nostr private key/Hive posting key.
- **Troubleshooting**:
  - No posts on Hive? Check logs for errors (e.g., wrong Hive posting key).
  - No posts on Nostr? Verify your Nostr keys and relays in your app.
  - Restart with `node bidirectional-longform30023.js` or `node bidirectional-bridge.js` to see logs.
- **Community**: Use tags that are relevant to the content of your post. Hive frowns on tag spamming. Post sparingly (a few times per day) to respect Hive norms.

### What’s Happening?
- **Nostr to Hive**: Your Nostr notes (kind 1) and articles (kind 30023) become Hive posts with a link to Nostr.
- **Hive to Nostr**: Your Hive posts become Nostr notes with a link to Hive. Nostr-originated posts are skipped to avoid loops.
- **Safety**: The bridge prevents duplicates and respects Hive’s posting limits.

## Need Help?
- On the Hive side, reach out to @crrdlx or comment anywhere with `!HELP` or `!help` in any Hive post and describe your issue. Someone will respond.
- On the Nostr side, message crrdlx at `npub1qpdufhjpel94srm3ett2azgf49m9dp3n5nm2j0rt0l2mlmc3ux3qza082j`
- Check `README.md` for more details.

Happy bridging!

----

## Disclaimer

This is an experimental bridge.  Expect that there will be glitches, errors, and corrections to be made. So, consider it very beta, with no guarantees, and use at your own risk. Source code: https://github.com/crrdlx/hostr

----
Connect on Hive: @crrdlx
Connect on Nostr: npub1qpdufhjpel94srm3ett2azgf49m9dp3n5nm2j0rt0l2mlmc3ux3qza082j
All contacts: https://linktr.ee/crrdlx