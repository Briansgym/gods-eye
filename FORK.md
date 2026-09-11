# This fork

Working copy of [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) (MIT) for Brian Spencer / Intelligent Software Systems.

Upstream is the product. This repo is the same globe plus the layers we actually demo.

## Run it

```bash
git clone https://github.com/Briansgym/gods-eye.git
cd gods-eye
npm install
npm run doctor   # optional
npm run dev
```

Open the URL Vite prints (usually `http://127.0.0.1:5173`).

No keys required for a keyless globe (Esri + OSM). Copy `.env.example` → `.env` only if you want power-ups (Google 3D, TomTom, AIS, OpenAI voice, FIRMS). **Never commit `.env`.**

## What we added on top of upstream

- **Command box / command rail** — type or chip-drive the globe (fly, layers, CCTV)
- **Local command bus** — localhost SSE + `POST /api/gev/command` so another process can fly the camera. Do not expose this to the internet
- **Conflicts** — UCDP-backed conflict layer
- **News** — GDELT-backed news layer + roster panel
- **World camera catalogs** — `config/cctv_catalogs.json` (see `docs/CAMERA-CATALOGS.md`)

## Honest limits

Public signals only. Not people-search, not face-ID, not live spy satellite video. Some layers are live, some delayed, some modeled. Traffic without a TomTom key is not live speed.

## License

MIT on the code (keep `LICENSE`). Data sources and third-party ToS are **not** MIT — read `DATA_SOURCES.md` and `SECURITY.md` before you ship or commercialize anything.
