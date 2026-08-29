# Assistance.Frontend — HumanAssistance Annotation Frontend

Web interface a human uses to answer image requests from an external system (Unity):
view the image, draw **bounding boxes with labels**, and optionally record a
**spoken answer**. The response is sent back to the requesting system over a WebSocket.
Core stack: **Node.js/Express backend** (file uploads, text-to-speech via gTTS,
translation via DeepL) plus a plain **HTML/JS frontend** with canvas annotation and
browser speech recognition.

> ℹ️ **This README was created with the support of AI** (Claude, based on the actual source code) — not exclusively AI-generated — and was reviewed by the author. Treat it as a helpful draft — verify the commands in your own environment before relying on them.

> **Platform:** Developed and tested exclusively on **Windows** (Windows 11, PowerShell).
> All commands in this guide are written for Windows/PowerShell.

---

## Prerequisites

| Item | Details |
|------|---------|
| **Node.js** | Version **18 or newer** (tested with v24.14.0). Ships with `npm`. |
| **DeepL API key** | Only needed to translate non-German spoken answers, but the server **will not start without a key**. Free key: <https://www.deepl.com/pro-api> |
| **ffmpeg** | Not needed separately — provided by the npm package `ffmpeg-static`. |
| **Browser** | Chrome/Edge recommended (microphone recording + `webkitSpeechRecognition` for the live transcript). |
| **External WebSocket server** | The frontend connects to `ws://<host>:40002` (the requesting Unity/relay system). **Not** part of this repo. Without it the app still starts but permanently shows "Getrennt" (disconnected). |

**Dependencies** (from [`package.json`](package.json), pinned exactly in [`package-lock.json`](package-lock.json)):

| Package | Installed version | Purpose |
|---------|-------------------|---------|
| express | 5.2.1 | HTTP server & routing |
| multer | 2.1.1 | File uploads (multipart/form-data) |
| uuid | 14.0.0 | unique file IDs |
| fluent-ffmpeg | 2.1.3 | audio conversion WebM → MP3 |
| ffmpeg-static | 5.3.0 | bundled ffmpeg binary |
| node-gtts | 2.0.2 | text-to-speech (Google TTS) |
| deepl-node | 1.27.0 | translation |

---

## Setup

**1. Clone the repository**

```powershell
git clone <REPO-URL>
```

**2. Change into the app folder**

```powershell
cd Assistance.Frontend\Assistance.Frontend
```

**3. (Optional) Pin the Node version with nvm-windows**

```powershell
nvm install 18
nvm use 18
```

**4. Install dependencies** (exact versions from the lockfile)

```powershell
npm ci
```

**5. Create the configuration file**

[`config.js`](config.js) is **not in the repo** (it holds the API key) and must be created
locally in the app folder (PowerShell):

```powershell
@'
module.exports = {
    DEEPL_API_KEY: 'YOUR_DEEPL_KEY_HERE',
    LANGUAGE_MAP: {
        german:  { gtts: 'de', deepl: 'DE' },
        english: { gtts: 'en', deepl: 'EN-US' },
    },
    DEFAULT_LANGUAGE: 'german',
};
'@ | Out-File -Encoding utf8 config.js
```

Replace `YOUR_DEEPL_KEY_HERE` with your real DeepL key (free keys end in `:fx`).

---

## Running

From the app folder:

```powershell
node server.js
```

On first start:
- The server binds to port **5500** and reads `config.js` (the DeepL translator is
  initialized — this fails if the key is missing).
- All reachable local addresses are printed to the console.

Then reachable at:

```
http://localhost:5500
```

On the network it is additionally reachable at the printed `http://<local-ip>:5500`
(useful when the Unity system runs on another device).

---

## Trying it without the external system

The web interface waits for a WebSocket request by default. The **backend endpoints**,
however, can be tested directly — e.g. the health check:

```powershell
curl.exe http://localhost:5500/health
```

Response:

```json
{ "status": "ok", "stored_files": 0 }
```

Text-to-speech (German transcript → MP3, without a real audio file):

```powershell
curl.exe -X POST http://localhost:5500/upload/audio -F "audio=@NUL" -F "language=german" -F "transcript=Hallo Welt"
```

Response (the URL serves the generated MP3, valid for 10 minutes):

```json
{ "audio_url": "http://localhost:5500/download/audio/<id>" }
```

---

## Interfaces (backend, port 5500)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/upload/image` | Store an image (field `image`), returns a download URL |
| `GET`  | `/download/image/:fileId` | Stream a stored image (with range support) |
| `POST` | `/upload/audio` | Process a spoken answer: TTS from transcript **or** WebM→MP3 conversion |
| `GET`  | `/download/audio/:fileId` | Stream a generated MP3 (with range support) |
| `GET`  | `/health` | Status query: `{ status, stored_files }` |

> All uploaded files live in the OS temp directory and are deleted automatically after
> **10 minutes** (`FILE_TTL_MS` in [`server.js`](server.js)).

### Fields of `POST /upload/audio`

Field (multipart/form-data) | Type | Required | Meaning
---|---|---|---
`audio` | File | yes | Audio recording (WebM). Ignored when `transcript` is set.
`transcript` | Text | no | If present, the audio is generated via **TTS from the transcript**.
`language` | Text | no | e.g. `german`, `english`. Default: `german`.

Logic: if a `transcript` is set and the language is **not** German, the text is translated
via DeepL first and then spoken. For German it is spoken directly. Without a `transcript`,
the actual recording is converted to MP3 via ffmpeg.

Example (English translation + speaking; the transcript input is German):

```powershell
curl.exe -X POST http://localhost:5500/upload/audio -F "audio=@NUL" -F "language=english" -F "transcript=Die SSD sitzt oben links"
```

Example response:

```json
{
  "audio_url": "http://localhost:5500/download/audio/8f3c...c1",
  "translated_text": "The SSD is located at the top left"
}
```

---

## Adjusting the configuration

| Setting | Where |
|---------|-------|
| DeepL key, language mapping, default language | [`config.js`](config.js) (`LANGUAGE_MAP`, `DEFAULT_LANGUAGE`) |
| Server port (5500) | [`server.js`](server.js) — constant `PORT` |
| File lifetime (10 min) | [`server.js`](server.js) — `FILE_TTL_MS` |
| Max upload size (50 MB) | [`server.js`](server.js) — `limits.fileSize` |
| WebSocket address of the Unity system (port 40002) | [`app.js`](app.js) — constant `WS_URL` |
| Browser speech-recognition language (`de-DE`) | [`app.js`](app.js) — `recognition.lang` |

---

## Debugging / Developing (VS Code)

Open this app folder as the workspace root (it contains `.vscode/`). The file
[`.vscode/launch.json`](.vscode/launch.json) provides, in the **Run and Debug** panel
(`Ctrl+Shift+D`):

- **Server (Backend)** — starts `server.js`, breakpoints in the backend active.
- **Chrome (Frontend)** — opens Chrome on port 5500, breakpoints in `app.js` active (server must be running).
- **Full Stack (Server + Chrome)** — both with a single `F5`.

---

## Project structure

```
Assistance.Frontend/            # repo root
└─ Assistance.Frontend/         # app folder (work here)
   ├─ README.md                 # this file
   ├─ server.js                 # Express backend (port 5500): upload, TTS, DeepL, streaming
   ├─ app.js                    # frontend: WebSocket, canvas annotation, audio recording, STT
   ├─ index.html                # annotation UI
   ├─ styles.css                # styling
   ├─ config.js                 # create LOCALLY: DeepL key + language mapping (gitignored)
   ├─ package.json              # dependencies & metadata
   ├─ package-lock.json         # exactly pinned versions (basis for `npm ci`)
   └─ .vscode/launch.json       # VS Code debug configuration
```

---

## Flow in brief

1. The external system (Unity) sends a request with an image and a question over the WebSocket relay (port 40002).
2. The frontend enqueues the request and shows the image on the canvas.
3. The operator draws bounding boxes, assigns labels, and optionally records a spoken answer.
4. During recording, browser speech recognition produces a transcript; the audio is sent to `POST /upload/audio`.
5. The server translates via DeepL for non-German and generates an MP3 via gTTS → returns `audio_url` (and possibly `translated_text`).
6. The annotated image is uploaded as a JPEG to `POST /upload/image` → `image_url`.
7. The frontend sends the response (`boxes`, `answer`, `image_url`, `audio_url`) back over the WebSocket.
8. The next request from the queue is shown.

---

*This documentation was created with the support of an AI assistant (Claude) and verified against the source code by the author.*
