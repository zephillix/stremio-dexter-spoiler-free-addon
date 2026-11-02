# Dexter Spoiler-Free Thumbnails (Stremio addon)

Swaps the episode thumbnails for Dexter, Dexter: New Blood, Dexter: Original Sin and Dexter: Resurrection
with spoiler-free stills. Titles, descriptions and streams are untouched.

This product uses the TMDB API but is not endorsed or certified by TMDB.

## How people find and open it
Stremio asks addons in order and Cinemeta usually answers first for the normal Dexter entry, so this addon
has its own entries (ids starting with `dxs:`, which only this addon answers):

- **Search:** typing `dexter`, `new blood`, `original sin` or `resurrection` shows results under **Dexter (Spoiler-Free)**.
- **Discover:** Series -> catalog **Dexter (Spoiler-Free)**.
- **Board:** a **Dexter (Spoiler-Free)** row, where the Stremio version shows third-party catalogs.
- **Landing page:** opening the addon's address in a browser (`https://YOUR-HOST/`) shows an install button and these tips,
  so you can share one simple link.

The normal Dexter entry still comes from Cinemeta; only the entries above get the spoiler-free thumbnails.
Episodes still play from the viewer's own stream addons.

## Run it locally
1. Install Node.js 18+.
2. Put your TMDB API key in a file called `tmdb_key.txt` in this folder (or set the `TMDB_KEY` environment variable).
3. `npm install`, then `npm start`.
4. In Stremio: Addons -> paste `http://127.0.0.1:7000/manifest.json`.

Check matching progress at `/status`. Matches are saved in `matches.json`.
Episodes that are not matched yet show no thumbnail (never the spoiler one).

## Make it public (example: Render)
Stremio only accepts remote addons over HTTPS, and Render gives you that for free.

1. Run it locally first until `/status` shows `"matching":false`, so `matches.json` is complete.
2. Put this folder in a GitHub repository. Include `matches.json`. Do NOT upload `tmdb_key.txt` (the `.gitignore` already skips it).
3. On render.com: New -> Web Service -> pick the repository.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variable: `TMDB_KEY` = your TMDB API key
4. When it is live, your addon is `https://YOUR-NAME.onrender.com/manifest.json`. Paste that into Stremio's Addons page to install it, and share the same link.

Notes
- Render's free tier goes to sleep after ~15 minutes without visits and takes up to a minute to wake, which can make Stremio show nothing for that first request.
  A free uptime monitor (for example UptimeRobot) pinging `https://YOUR-NAME.onrender.com/health` every 5 minutes keeps it awake, or use a paid instance.
- Other hosts work too (Railway, Fly.io, a VPS, Stremio's Beamup): anything that runs `npm start` and sets the `PORT` variable.
- Keep the TMDB key out of the repository. If it ever leaks, create a new one in your TMDB account settings and update `TMDB_KEY`.
- To get it noticed, share the landing page link, and look for a community Stremio addon list to submit it to.
- TMDB's API terms ask for the attribution line above and are meant for non-commercial use.
