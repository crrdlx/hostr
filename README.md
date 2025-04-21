# Hostr

## Hive + Nostr = Hostr, a bidirectional bridge.

![hostr-200](https://files.peakd.com/file/peakd-hive/hostr/AJg9kuqkusqS8cafJVqxybvDL1ADqGPuBPfXKn5x2VSpKmjaFvh31X5gB4Cdz1s.png)

Hostr is a bidirectional bridge between [Nostr](https://nostr.com/) and [Hive](https://hive.io). What you post on one is automatically cross-posted to the other.  (See [SETUP.md](https://github.com/crrdlx/hostr/blob/main/SETUP.md) if you want to jump right in and run it.)

>*This is experimental, so consider it very beta, with no guarantees, and use at your own risk.*

Nostr and Hive have differences, mainly, Nostr is a *protocol* and Hive is a *blockchain*. Nostr does not have a token, although bitcoin is much-loved and used across Nostr. Hive has two main tokens: HIVE and the HBD stablecoin. More importantly, Nostr and Hive have similarities. Both are decentralized and censorship resistant thanks to users owning and controlling their own private keys.

## Nostr users - why you might want to bridge to Hive

I feel the #1 reason a Nostr user might wish to use this bridge is *to permanently store and chronicle your Nostr notes.*


1.  **Immutability** for your Nostr notes. Your notes on Nostr are held on relays; if they go away, your notes go away. (There was a “nosdrive.app” backup, however I do not believe it’s still working.) Hive is immutable. There is no "delete" and even an “edit” on Hive does not erase the original. Like with a wiki page, a Hive edit *shows* the most recent version, but the original *still remains* historically. This would give Nostr users a permanent record of their notes in chronological order.

2. Hive is an excellent **long form blogging** platform with stable and persistent links. Finding old Nostr notes can be difficult.

3.  **Increase your reach** and potentially gain followers. Your content will bridge off of the Nostr island and be opened to 10-30,000 daily Hive users. Go to [https://peakd.com/c/hive-133987](https://peakd.com/c/hive-133987) and look for “Hive statistics” to see numbers.

4.  **Earn rewards** in HIVE and HBD. “Likes” on Nostr do not reward you monetarily, but every upvote on Hive yields rewards. For bitcoin maxis, these tokens can easily be swapped into sats with tools like the [https://v4v.app](https://v4v.app) web app, or others.

5. Help **grow Nostr**. Every note that bridges over to Hive will have a footer saying something like, “This note originated on Nostr,” with a link back to your Nostr note.

## Hive users - why you might want to bridge to Nostr

1.  **Increase your reach** and potentially gain followers. Your content will be bridged off the Hive island and be opened to 17-18,000 daily users. See [https://stats.nostr.band](https://stats.nostr.band) for Nostr stats.

2.  **Earn bitcoin sats** in the form of “zaps.” Nostr does not have a token. But, it has a strong culture of zapping (tipping) bitcoin satoshis to other users to reward quality content. Memes are loved and often zapped too.

3.  **Unlimited posting**. Nostr is not held back by posting or activity limitations, such as with Resource Credits or community norms that frown on posting too often.

4. Even more **censorship resistance**. Hive is truly censorship-free in that posted content, no matter the content, does indeed posted. However, front ends can choose to show or not show content that the community has downvoted. Nostr is more free speech or censorship resistant...you post it, it's posted. (Relays can choose to relay it or not, accept it or reject it, but you could run your own relay.)

5. Help **grow Hive**. Every post that bridges over to Nostr will have a footer saying something like, “This post originated on Hive,” with a link back to your Hive blockchain post.

## Quirks about Nostr and Hive

**If you’re unfamiliar with Nostr, it has a few quirks:**

- You have one private key, called an “nsec”. It goes along with your “npub”, your public key. Your npub is your username, your nsec IS your account.

- You simply need an nsec, then a “client” which is a front end.

- You need to add “relays” to your client in order to connect. This is very easy, but how to do it depends on the client. Client's usually walk you through this when you start.

**If you’re unfamiliar with Hive, it has more quirks:**

- Hive has five private keys, yes, five. Each has a specific purpose. From least powerful to most powerful, they are: posting key (to post), active key (to move tokens), owner key (to do anything), memo key (to dm/pm), and backup/master private key (to totally restore all keys). Don’t worry about all the keys. For Hostr, we only deal with posting notes/posts, so the *posting key* is all we deal with.

- Hive has a culture of frowning on posting too often. Doing so can be seen as trying to milk the HIVE/HBD rewards that you gain from upvotes. Too much posting can be viewed as spamming and result in downvotes (this hurts your Web-of-Trust score, called “reputation” on Hive, and is shown alongside your username; you want to grow and keep your reputation up). The chain also has a 5-minute cool-down rule coded in: after posting, you cannot post for another five minutes.

- Additionally, to avoid spam, Hive actions burn “Resource Credits” or RCs. Think of RCs as the charge % in your phone battery. Every action on Hive uses RCs, so they dwindle with every use. Posting is high in RC cost. Bad news: if you run out of RCs, you’re unable to do things on Hive. Good news: RCs also recharge. If out of RCs, you can wait and then do things later. For the Hostr script, *over*-posting means the script will post until RCs are exhausted, then it will stall until RCs are recharged, post again, stall, etc. You can check your RCs in many places, such as a Hive explorer like [https://hivescan.info](https://hivescan.info) and entering your Hive username. If you have RC issues, reach out for help.

You don't want to over-post on Hive. To avoid over-posting, Hostr has two versions of the script:

1. **bidirectional-longform30023.js** that listens *only* for kind 30023 (long form) Nostr notes to bridge over to Hive. Kind 1 short notes are ignored.

2. **bidirectional-bridge.js** which listens for both kind 1 (short form) and kind 30023 (long form) Nostr notes to bridge over to Hive.

Which script version should I use?

1. If you post frequently on Nostr (more than 3 times per day?), the bidirectional-longform30023.js script is likely best. Only long form notes will bridge over. For newcomers to Hive, I would start with this one.

2. If you post infrequently on Nostr  (3 times per day or fewer?), the bidirectional-bridge.js (both kinds 1 and 30023) might work fine for you.

## Nostr users - how to begin

You’ll need a Hive account. You can see sign-up options at [https://signup.hive.io](https://signup.hive.io). Some options are free, others are not. I (crrdlx) have some free “VIP tickets” to sign up with and you are welcome to use one if you wish, see [https://crrdlx.vercel.app/hive-vip-ticket.html](https://crrdlx.vercel.app/hive-vip-ticket.html) (if they’re already spent, contact me.)

As with Nostr, the critical thing with a Hive account is saving your keys. Hive has multiple keys, just save them all. We’ll only use the “posting key” for the Hostr bridge, however. The other keys can be used on Hive if you wish. (For instance, the "active key" is used to handle your HIVE/HBD rewards earned.)

Once signed up (and keys are safe), you can adjust your Hive account/profile using any Hive front end like [https://peakd.com/username](https://peakd.com/username), [https://ecency.com/username](https://ecency.com/username), or [https://hive.blog/username](https://hive.blog/username). Just remember, every action on Hive burns RCs, keep an eye on that.

You can learn more about Hive at [https://hivewiki.vercel.app](https://hivewiki.vercel.app) if you wish.

See the "Setting up..." section below to set up the bridge.

## Hive users - how to begin

You’ll need a Nostr account. Getting a Nostr "account" is nothing more than generating keys. A simple way to do this is at [https://nstart.me](https://nstart.me) If you wish to dig into details, take a look at [http://nostrwiki.crrdlx.infinityfreeapp.com/doku.php?id=wiki:get-started](http://nostrwiki.crrdlx.infinityfreeapp.com/doku.php?id=wiki:get-started)

As with Hive, you simply need to safely store your private keys. On Nostr, your private key is called your “nsec” (sec, as in “secret”). Your public key is your “npub” (pub, as in "public"). Your nsec is all you need, but just so you know, your private key comes in two formats: (a) your nsec, and (b) the “hex” form (same key, just different forms). With the Hostr bridge, we’ll use the hex private key. Depending on how you join Nostr, your hex key may be given to you at sign up. But, even if it's not, you can always check back-and-forth between nsec and hex keys using a tool like [https://nostrtool.com](https://nostrtool.com) and choosing "Load a privkey from nsec/hex".

Again, just save your nsec and/or hex private key and you’re set.

You can learn more about Nostr at [https://nostrwiki.vercel.app](https://nostrwiki.vercel.app) if you wish.

See the "Setting up..." section below to set up the bridge.

## Setting up the Hostr bridge

To set up the bridge, see [SETUP.md](https://github.com/crrdlx/hostr/blob/main/SETUP.md) in the repo below. The Hostr bridge has a bit of technicals behind it, but don't get intimidated. Because technical things change, I’ll keep the technical how-to instructions housed at [https://github.com/crrdlx/hostr](https://github.com/crrdlx/hostr)


## Disclaimer

This is an experimental bridge, there are no guarantees. Consider it very beta. Use at your own risk. Source code: https://github.com/crrdlx/hostr

----

Built with ❤️ by crrdlx

Connect on Hive: @crrdlx
Connect on Nostr: npub1qpdufhjpel94srm3ett2azgf49m9dp3n5nm2j0rt0l2mlmc3ux3qza082j
All contacts: https://linktr.ee/crrdlx