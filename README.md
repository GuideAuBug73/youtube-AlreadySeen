# AlreadySeen – Mark as watched on YouTube

**English** | [Français](README.fr.md)

Chrome / Brave extension (Manifest V3) that adds a "Mark as watched" button:

- **in the player** (bottom-right controls),
- **under the video** (a "Marquer vue" button next to Share),
- **on every thumbnail** (on hover, top-left corner): home, search, channels, suggestions,
  playlists, Shorts.

Click again to remove the mark. The extension's interface is in French.

## Installation

1. Download `already-seen-vX.Y.Z.zip` from the latest
   [release](https://github.com/GuideAuBug73/youtube-AlreadySeen/releases/latest) and unzip it
   into a folder you will keep (Chrome reads it again at every start).
2. Open `chrome://extensions` (or `brave://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder.
4. Sign in to YouTube in this browser so that syncing with your account works.

To update: replace the folder's content with the new release, then click the extension's ↻
button in `chrome://extensions`.

## What happens when you mark a video

1. **Sync with your YouTube account** (on by default). The extension does what
   `yt-dlp --mark-watched` does: it fetches the video's playback tracking URLs
   (`videostatsPlaybackUrl` / `videostatsWatchtimeUrl`) and tells YouTube the video was played
   to the end. The video shows up in your account's watch history and the red progress bar goes
   to 100 %, on your other devices too. This works from thumbnails, without opening the video.
   You need to be signed in to YouTube in the browser.
2. **On the video page**, the player is also paused at the end of the video, so that its own
   signals (sent on pause or when leaving the page) don't move the progress back.
3. **Local storage** (`chrome.storage.local`): the video is remembered for good, so the green
   check and a full red bar show up immediately, before YouTube refreshes its thumbnails, and
   even when you are not signed in.

Removing the mark (second click) deletes the video from your account's watch history, like the
"Remove from watch history" menu on youtube.com/feed/history: the red bar goes away too. The
extension finds the entry by searching your history for the video's title. (Sending a
"position 0" does not work: YouTube ignores it once a video has been watched in full.) If it is
the video being played, the player goes back to the start and pauses, otherwise it would put
the video back in the history with its next signal.

## Set a progress manually (right click)

- **On the player's progress bar**: "Sauvegarder l'avancement à mm:ss" (the clicked time) or
  "Sauvegarder la position actuelle" (current position). The player moves there and pauses.
- **On a thumbnail's button**: 25 %, 50 %, 75 % or another value (a percentage or a time, for
  example `40` or `12:30`).

Your account's red bar moves to that position, even below a full watch. A position of just a
few seconds is ignored by YouTube: to go back to zero, remove the mark instead.

## Options (extension icon)

- YouTube account sync, and jump to the end (or to the start when unmarking) on the video page.
- Show or hide each of the three buttons.
- Mark automatically at X % of playback (90 % by default).
- Treat videos that YouTube already shows with a red bar ≥ X % as watched.
- Dim watched thumbnails, or hide them from feeds (never inside a playlist).
- Hide Shorts (shelves, cards and menu entry; never on Shorts pages or a channel's Shorts tab).
  On by default.
- Hide "Members only" videos. The badge is recognised by its star icon, whatever YouTube's
  language. Off by default.
- Hide "YouTube Playables" (built-in games): shelves, cards and menu entry, except on the games'
  own pages. On by default.
- JSON export / import of the local list, and clearing it.

## Code layout

The extension lives in `already-seen/`:

- `src/page.js`: script running in the page's own world (access to `ytcfg`, the player and the
  account cookies). It handles YouTube sync and moving the player.
- `src/content.js`: interface (buttons, bar, dimming, hiding), local list, automatic marking.
  It talks to `page.js` through `CustomEvent`s.
- `src/shared.js`: default settings and storage access, shared with the popup.
- `popup/`: the settings window.

## Publishing a version

1. Update `version` in `already-seen/manifest.json` (for example `1.1.0`) and commit.
2. Create and push the matching tag:

   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```

The `release` GitHub Action checks that the tag matches the manifest version, zips
`already-seen/` together with the licence, and publishes the release with the zip.

## Licence

[GNU GPL v3.0](LICENSE): you may use, modify and redistribute the extension, as long as any
distributed version stays under the same licence, with its source code.
