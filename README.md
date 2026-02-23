# NovumAI Extension

AI-powered real-time sales coaching on Google Meet. Captures tab audio, transcribes via AssemblyAI, and displays methodology-based suggestions during calls.

## Prerequisites

- Node.js 18+
- Chrome or Chromium-based browser
- NovumAI account (login via webapp at novumai.co)

## Setup

```bash
npm install
npm run build
```

## Load the Extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `chrome-extension` folder

## Environment

Default is **Development**. Toggle in the popup:

- **Development:** dev-api.novumai.co, dev-ws.novumai.co, dev.novumai.co
- **Production:** api.novumai.co, ws.novumai.co, www.novumai.co

Auth uses the `session_id` cookie from the NovumAI webapp. Log in at novumai.co first, then use the extension.

## Usage

1. Start a Google Meet call
2. Click the extension icon and start a session
3. Optional: select or create a lead for the call
4. Overlay shows real-time transcript and AI suggestions
5. End session from popup when call completes; redirects to analytics

## Project Structure

```
chrome-extension/
├── manifest.json
├── background/service-worker.js   # Orchestration, WebSockets, API
├── popup/                         # Popup UI, auth, lead picker
├── content/                       # Meet overlay, mic capture
├── offscreen/                     # Tab audio, PCM16 encoding
├── lib/                           # Config, API client, messages
└── assets/                        # Icons
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build Tailwind CSS to popup |
| `npm run watch:css` | Watch mode for CSS changes |
