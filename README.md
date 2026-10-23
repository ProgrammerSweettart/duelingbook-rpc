# DuelingBook → Discord Rich Presence

Shows what you're doing on [DuelingBook](https://www.duelingbook.com) on your Discord profile.

<!-- replace with a screenshot of your own card: drag an image into a GitHub issue to get a URL -->

| while you're… | your Discord shows |
|---|---|
| in a duel | **Dueling · Goat Format (Rated) · Game 2 of 3 · 0-1 · Turn 6**<br>Sweettart (6500) vs Opponent (6000) · 2 watching — with a live timer |
| watching a duel | **Watching · Unlimited · Game 1 of 3**<br>the two players and their life points |
| just finished | **Match over · Lost 0-2**, for half a minute |
| testing hands | **Solo mode · Turn 3** |
| building a deck | **Deck Editor** |
| in the lobby | **Looking for a duel · Advanced (Rated) · Best of 3** |

Leave DuelingBook and it disappears.

## Install

**macOS / Linux** — paste this into Terminal and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/ProgrammerSweettart/duelingbook-rpc/main/install.sh | bash
```

It sets everything up for you (including Node, if you don't have it — no password needed) and opens the last step in your browser:

1. Install **[Tampermonkey](https://www.tampermonkey.net)** if you don't already have it — Chrome, Firefox, Edge, Zen, Brave, all fine.
2. A tab opens with the script → click **Install**, and say **yes** when it asks to connect to `127.0.0.1`.

Then open duelingbook.com with **Discord running** (the desktop app — Discord in a browser can't show this). Done.

**Windows** — [download the project](https://github.com/ProgrammerSweettart/duelingbook-rpc/archive/refs/heads/main.zip), unzip it, then right-click `windows/install.ps1` → *Run with PowerShell*, and do the same two browser steps. *(Untested — tell me how it goes.)*

To update later, run the same command again. To remove it: `~/.duelingbook-rpc/uninstall.sh`

## What it doesn't share

Your **deck name** and **the cards you play** only show during **rated duels**. Deck building, solo testing and unrated games stay vague on purpose, so nobody scouts your tech off your Discord. Everything else on the card is already public to your opponent anyway.

Want it different? In the DuelingBook tab, press F12 for the console and paste one of:

```js
localStorage.setItem('dbrpc.reveal', 'always')  // show decks and cards everywhere
localStorage.setItem('dbrpc.reveal', 'never')   // never show either
localStorage.removeItem('dbrpc.reveal')         // back to rated-only
```

## If nothing shows up

- **Is Discord the desktop app, and running?** It can't work through Discord in a browser.
- **Did you say yes to the `127.0.0.1` permission** when Tampermonkey asked? Without it the script can't reach the app. Reinstall the script from the tab the installer opened.
- Still nothing: run `curl 127.0.0.1:41337` in Terminal. If it prints `discord: connected`, the problem is the browser half; if it prints nothing, re-run the install command.
- In Discord, *Settings → Activity Privacy → Share your detected activities* must be on.

## Credits

Built with [@xhayper/discord-rpc](https://github.com/xhayper/discord-rpc). MIT licensed — do what you like with it.
Everyone who installs this shares one Discord application, so the card art and name are already set up; [internals](docs/internals.md) explains how to use your own instead, along with how the whole thing works.
