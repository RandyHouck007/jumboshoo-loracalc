# Jumbo Shoo — LoRa Airtime Calculator

Single-sensor LoRa airtime, duty-cycle compliance, and energy calculator for the Jumbo Shoo geophone sensor network. Supports EU 868 MHz (sub-bands g, g1, g2, g3) and US 915 MHz.

**Tool version: v2.2**

---

## Local development

```bash
npm install
npm run dev
```

Then open http://localhost:5173

## Deploy to Vercel (recommended)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → Import your GitHub repo
3. Vercel auto-detects Vite — click **Deploy**
4. Done. You get a permanent HTTPS URL like `https://jumbo-shoo-calculator.vercel.app`

No configuration needed. Every push to `main` redeploys automatically.

## Deploy to Netlify

1. Push this repo to GitHub
2. Go to [netlify.com](https://netlify.com) → Add new site → Import from Git
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Click **Deploy**

## Build for static hosting

```bash
npm run build
```

Produces a `dist/` folder — upload to any static host (S3, GitHub Pages, etc).

---

## Project structure

```
├── index.html          # HTML entry point
├── vite.config.js      # Vite config (minimal)
├── package.json
└── src/
    ├── main.jsx        # React root
    └── App.jsx         # Calculator (all logic + UI in one file)
```

## References

- Semtech AN1200.13 — LoRa Modem Designer's Guide (ToA formula)
- ETSI EN 300 220 — EU 868 MHz sub-band duty-cycle limits
- FCC §15.247 — US 400 ms dwell time limit
- HopeRF RFM95W datasheet v2.0 — TX current values
