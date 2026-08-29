const express    = require('express');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const ffmpeg     = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const gtts   = require('node-gtts');
const deepl  = require('deepl-node');
const { DEEPL_API_KEY, LANGUAGE_MAP, DEFAULT_LANGUAGE } = require('./config');
ffmpeg.setFfmpegPath(ffmpegPath);

const translator = new deepl.Translator(DEEPL_API_KEY);
const PORT       = 5500;

const app = express();

// ── Static frontend files───────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── Temporary storage───────────────────────────────────────────────────────
// file_id → { filePath, timer }
const fileStore = {};
const FILE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function registerFile(filePath) {
    const fileId = uuidv4();
    const timer  = setTimeout(() => deleteFile(fileId), FILE_TTL_MS);
    fileStore[fileId] = { filePath, timer };
    return fileId;
}

function deleteFile(fileId) {
    const entry = fileStore[fileId];
    if (!entry) return;
    clearTimeout(entry.timer);
    delete fileStore[fileId];
    fs.unlink(entry.filePath, () => {});
}

const upload = multer({
    storage: multer.diskStorage({
        destination: os.tmpdir(),
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname) || '.bin';
            cb(null, `${uuidv4()}${ext}`);
        }
    }),
    limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

// ── Log local IPs────────────────────────────────────────────────────────
function getLocalIPs() {
    const ifaces = os.networkInterfaces();
    return Object.values(ifaces)
        .flat()
        .filter(i => i.family === 'IPv4' && !i.internal)
        .map(i => i.address);
}

// ── POST /upload/image ───────────────────────────────────────────────────────
// Accepts an image (multipart/form-data, field: "image").
// Returns { image_url } — analogous to the AI API.
app.post('/upload/image', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Kein Bild empfangen.' });
    }

    const fileId  = registerFile(req.file.path);
    const baseUrl = `${req.protocol}://${req.hostname}:${PORT}`;
    const imageUrl = `${baseUrl}/download/image/${fileId}`;

    console.log(`[Upload Image] ${fileId} → ${req.file.path}`);
    res.json({ image_url: imageUrl });
});

// ── GET /download/image/:fileId ──────────────────────────────────────────────
app.get('/download/image/:fileId', (req, res) => {
    const { fileId } = req.params;
    const entry      = fileStore[fileId];

    if (!entry || !fs.existsSync(entry.filePath)) {
        return res.status(404).json({ error: 'Datei nicht gefunden.' });
    }

    console.log(`[Download Image] ${fileId}`);
    streamFile(req, res, entry.filePath, 'image/jpeg');
});

// ── Helper: translate text via DeepL────────────────────────────────
async function translateText(text, targetLanguage) {
    const deeplTarget = LANGUAGE_MAP[targetLanguage]?.deepl ?? 'EN-US';
    const result = await translator.translateText(text, null, deeplTarget);
    return result.text;
}

// ── Helper: text → MP3 via node-gtts─────────────────────────────────
function textToMp3(text, langCode, outputPath) {
    return new Promise((resolve, reject) => {
        gtts(langCode).save(outputPath, text, (err) => {
            if (err) reject(err);
            else resolve(outputPath);
        });
    });
}

// ── POST /upload/audio ───────────────────────────────────────────────────────
// Optional fields: transcript (string), language (string, e.g. "english")
// If a transcript is present, the audio is ALWAYS based on the transcript (TTS):
//   - Non-default language (e.g. english): the transcript is translated first, then spoken.
//   - Default language (german): the transcript is spoken directly (no translation needed).
// Only without a transcript is the actual recording (WebM → MP3) used (fallback).
app.post('/upload/audio', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Keine Audiodatei empfangen.' });
    }

    const language   = (req.body?.language || DEFAULT_LANGUAGE).toLowerCase();
    const transcript = (req.body?.transcript || '').trim();
    const inputPath  = req.file.path;

    console.log(`[Upload Audio] language="${language}" transcript="${transcript}" file="${inputPath}"`);

    if (transcript) {
        // Audio is generated from the transcript (TTS) – the actual recording is not needed.
        fs.unlink(inputPath, () => {});
        try {
            let textToSpeak    = transcript;
            let translatedText = null;

            // Only translate for a non-default language; german is spoken directly.
            if (language !== DEFAULT_LANGUAGE) {
                console.log(`[Upload Audio] Translating: "${transcript}" → ${language}`);
                textToSpeak    = await translateText(transcript, language);
                translatedText = textToSpeak;
                console.log(`[Upload Audio] Translated: "${textToSpeak}"`);
            }

            const langCode = LANGUAGE_MAP[language]?.gtts ?? 'en';
            const mp3Path  = path.join(os.tmpdir(), `${uuidv4()}.mp3`);
            console.log(`[Upload Audio] TTS with lang=${langCode} → ${mp3Path}`);
            await textToMp3(textToSpeak, langCode, mp3Path);
            console.log(`[Upload Audio] TTS done`);

            const fileId   = registerFile(mp3Path);
            const baseUrl  = `${req.protocol}://${req.hostname}:${PORT}`;
            const audioUrl = `${baseUrl}/download/audio/${fileId}`;
            console.log(`[Upload Audio] From transcript (${language}) → ${audioUrl}`);

            const payload = { audio_url: audioUrl };
            if (translatedText != null) payload.translated_text = translatedText;
            return res.json(payload);
        } catch (err) {
            console.error('[Upload Audio] TTS/translation failed:', err);
            return res.status(500).json({ error: `TTS/Übersetzung fehlgeschlagen: ${err.message}` });
        }
    }

    // Fallback (no transcript): convert the actual recording WebM → MP3
    const mp3Path = path.join(os.tmpdir(), `${uuidv4()}.mp3`);
    ffmpeg(inputPath)
        .audioCodec('libmp3lame')
        .format('mp3')
        .on('end', () => {
            fs.unlink(inputPath, () => {});
            const fileId   = registerFile(mp3Path);
            const baseUrl  = `${req.protocol}://${req.hostname}:${PORT}`;
            const audioUrl = `${baseUrl}/download/audio/${fileId}`;
            console.log(`[Upload Audio] ${fileId} → ${mp3Path}`);
            res.json({ audio_url: audioUrl });
        })
        .on('error', (err) => {
            console.error('[Upload Audio] Conversion failed:', err.message);
            fs.unlink(inputPath, () => {});
            res.status(500).json({ error: 'Audio-Konvertierung fehlgeschlagen.' });
        })
        .save(mp3Path);
});

// ── GET /download/audio/:fileId ──────────────────────────────────────────────
app.get('/download/audio/:fileId', (req, res) => {
    const { fileId } = req.params;
    const entry      = fileStore[fileId];

    if (!entry || !fs.existsSync(entry.filePath)) {
        return res.status(404).json({ error: 'Datei nicht gefunden.' });
    }

    console.log(`[Download Audio] ${fileId}`);
    streamFile(req, res, entry.filePath, 'audio/mpeg');
});

// ── Helper: stream file with range-request support──────────────────
function streamFile(req, res, filePath, mimeType) {
    const stat     = fs.statSync(filePath);
    const fileSize = stat.size;
    const range    = req.headers['range'];

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);

    if (range) {
        // Partial content (e.g. for audio scrubbing in the browser)
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(startStr, 10);
        const end   = endStr ? parseInt(endStr, 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
            'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': chunkSize,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        // Full file
        res.setHeader('Content-Length', fileSize);
        res.writeHead(200);
        fs.createReadStream(filePath).pipe(res);
    }
}

// ── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', stored_files: Object.keys(fileStore).length });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🖥  Assistance Frontend`);
    console.log(`   http://localhost:${PORT}`);
    getLocalIPs().forEach(ip => console.log(`   http://${ip}:${PORT}`));
    console.log(`\n📁 Upload:   POST http://localhost:${PORT}/upload/image`);
    console.log(`📥 Download: GET  http://localhost:${PORT}/download/image/:id\n`);
});
