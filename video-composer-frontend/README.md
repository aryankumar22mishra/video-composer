# Video Composer — Frontend

A **React 19** single-page application built with **Vite 8**. It provides the user interface for uploading video/image clips, configuring composition settings, monitoring job progress, and previewing the finished video — complete with an interactive timeline view.

## Requirements

- **Node.js** 18+ (tested with 20+)
- **npm** (ships with Node.js)

## Setup

```bash
cd video-composer-frontend
npm install
```

## Run the development server

```bash
cd video-composer-frontend
npm run dev
# → http://localhost:5173
```

The frontend expects the Django backend to be running on `http://localhost:8000`. Requests to `/api/*` and `/media/*` are proxied automatically via the Vite config — no additional setup needed.

## Available scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Vite dev server with HMR |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run lint` | Run Oxlint static analysis |

## Features

- **Upload panel** — select multiple image/video clips and an optional audio file
- **Duration control** — set how many seconds each image clip should display
- **Job submission** — sends multipart form data to the backend API
- **Live status polling** — automatically refreshes job state every 2 seconds
- **Video player** — preview the rendered output once complete
- **Interactive timeline** — visual track display, play/pause, seek, and zoom controls

## Proxy configuration (Vite)

From `vite.config.js`:

```js
server: {
  proxy: {
    '/api':    { target: 'http://localhost:8000', changeOrigin: true },
    '/media':  { target: 'http://localhost:8000', changeOrigin: true },
  },
}
```

This means all API and media requests from the React app are forwarded to the Django backend, avoiding CORS issues during development.

## Project structure

```
video-composer-frontend/
├── public/
│   ├── favicon.svg
│   └── icons.svg
├── src/
│   ├── assets/
│   ├── App.css          # Component styles (dark theme, timeline)
│   ├── App.jsx          # Main application component
│   ├── index.css        # Global base styles
│   └── main.jsx         # React entry point
├── dist/                # Production build output
├── index.html           # SPA shell
├── vite.config.js       # Vite configuration
├── package.json         # Dependencies & scripts
└── README.md            # ← you are here
