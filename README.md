# Spotify Lyrics

A small always-on-top mini-player that shows the song you're playing on Spotify and scrolls its
lyrics line-by-line, in time with the music. Like Spotify's lyrics panel, but floating over your
desktop so it stays out of the way of games and other apps.

Windows, macOS, and Linux. Free and open source (MIT).

> Not affiliated with Spotify. Lyrics are provided by [LRCLIB](https://lrclib.net). Requires a
> Spotify Premium account.

## Download

Get it from the **[website](https://carlos-h101.github.io/spotify-lyrics/)** or the
**[Releases page](https://github.com/Carlos-H101/spotify-lyrics/releases/latest)**:

- **Windows:** `Spotify-Lyrics-Setup.exe`
- **macOS:** `Spotify-Lyrics-arm64.dmg` (Apple Silicon) or `Spotify-Lyrics-x64.dmg` (Intel)
- **Linux:** `Spotify-Lyrics-x86_64.AppImage` or `Spotify-Lyrics-amd64.deb`

The app isn't code-signed yet, so your OS warns you the first time. On Windows click
**More info → Run anyway**; on macOS right-click the app and choose **Open**, or use
**System Settings → Privacy & Security → Open Anyway**. Full steps are on the
[website](https://carlos-h101.github.io/spotify-lyrics/).

## Connect your Spotify (one time, ~5 min)

Spotify caps hobby apps at a few users per key, so each person uses their own free key:

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Add this exact **Redirect URI**: `http://127.0.0.1:8888/callback`
3. Copy the app's **Client ID** (you do not need the secret; this uses PKCE).
4. In Spotify Lyrics, open **Settings → Spotify account**, paste the Client ID, and click **Connect**.

Reading playback requires **Spotify Premium** (Spotify's rule since Feb 2026).

## Using the overlay

- **Move it:** drag the header.
- **Lock / click-through:** the lock button, `Alt+Shift+L`, or the tray menu. When locked, the
  mouse passes straight through to whatever is behind it (great while gaming). Hover it to see the
  unlock hint.
- **Playback:** play/pause, previous/next, and a draggable seek bar at the bottom.
- **Show / hide:** `Alt+Shift+H`, or the tray icon. **Minimize / close:** buttons in the header.
- **Nudge sync:** `Alt+Shift+Left` / `Alt+Shift+Right`, or the offset slider in Settings.
- **Wrong or missing lyrics:** click ↻ to search again.

## Settings

Settings open as a full-screen panel inside the player (gear icon), with search and collapsible
sections: Appearance (themes, colors, background mode incl. see-through, blur, fonts, glow),
Layout, Behavior, and editable Hotkeys. Save up to **5 presets** of your whole setup and switch
any time. Changes apply live and are saved automatically.

## Build from source

Requires Node.js. (This uses npm for the **build tooling only**; the shipped app itself has zero
third-party runtime dependencies.)

```bash
npm install        # installs electron + electron-builder (dev only)
npm start          # run the app
npm run dist       # build installers for the current OS into dist/
```

### Run from source without npm (optional)

The app's runtime is pure Electron + Node built-ins, so you can also run it with no package
manager: double-click `setup.bat` (downloads + checksum-verifies the official Electron binary
into `electron\`), then `start.bat`.

## Releasing (maintainer)

Installers are built by GitHub Actions on every version tag and attached to a Release:

```bash
npm version patch        # or minor / major — bumps package.json and tags
git push --follow-tags   # pushes the tag, which triggers the build for Win/Mac/Linux
```

The website ([`docs/`](docs/index.html)) is served by GitHub Pages and links to the latest release.

## Where your data lives

Your settings, the encrypted Spotify token, and the lyrics cache live in the app's user-data
folder (`%APPDATA%\Spotify Lyrics\` on Windows, `~/Library/Application Support/Spotify Lyrics/`
on macOS, `~/.config/Spotify Lyrics/` on Linux). The refresh token is encrypted with the OS
keystore (Windows DPAPI / macOS Keychain / libsecret on Linux).

## Good to know

- **Fullscreen games:** the overlay draws over the desktop, browsers, and borderless-windowed
  games, and re-asserts itself on top. Windows still hides any overlay under *exclusive*-fullscreen
  games; run those in borderless/windowed mode.
- **Premium required:** if your Premium lapses, Spotify's API stops returning playback.
- **Custom icon:** replace `app/assets/logo.png` (square, ~1024×1024, transparent) to rebrand.

## Project layout

```
spotify-lyrics/
  app/                  the application (zero runtime dependencies)
    main.js             windows, tray, hotkeys, polling, IPC
    preload.js          the single, locked-down renderer bridge
    lib/                pkce, spotify, lyrics, store, icon (built-ins only)
    overlay/            the mini-player UI, sync engine, and inline settings panel
    assets/             logo.png / logo.ico
  docs/                 the download website (GitHub Pages)
  .github/workflows/    the build-and-release workflow
  package.json          electron-builder config (build tooling)
  start.bat / setup.bat the optional no-npm portable path
```

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Spotify AB; "Spotify" is a trademark of Spotify AB.
