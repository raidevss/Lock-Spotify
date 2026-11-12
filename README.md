# Lock Spotify

A [Spicetify](https://spicetify.app) extension that caps Spotify's maximum volume behind a password — made for shop speakers.

- A lock button next to Spotify's volume control locks the volume at its current level. It can go lower, never higher.
- Unlocking needs the password. **Change password** and **Check for updates** are in the unlock dialog (click the lock while it's locked).
- Spotify's **Normalize volume** is kept on (by the installer and by the extension), so quiet and loud songs play at a similar level.
- If Spotify stalls at the end of a song while it's in the background, the next song is started automatically.
- Blocks every way of raising the volume inside Spotify: slider, scroll, keyboard shortcuts, mute/unmute and Spotify Connect.

## Install (Windows)

Download [`Install Lock Spotify.cmd`](Install%20Lock%20Spotify.cmd) and double-click it. Or paste this into PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/raidevss/Lock-Spotify/main/install.ps1 | iex"
```

It installs whatever is missing — desktop Spotify, Spicetify, the extension — then applies it and blocks Spotify's
self-updates (an update would remove the lock). Run it again any time to repair or update everything.

Run it as the normal Windows user, not as administrator.

## Limits

This only controls Spotify's own volume. Lock the Windows volume and the amplifier separately if that matters.
