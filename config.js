// ── Configuration ────────────────────────────────────────────────────────────
module.exports = {
    DEEPL_API_KEY: 'yourDeepLApiKey',

    // Language mapping: Unity language string → gTTS language code / DeepL target language
    LANGUAGE_MAP: {
        german:  { gtts: 'de', deepl: 'DE' },
        english: { gtts: 'en', deepl: 'EN-US' },
    },
    DEFAULT_LANGUAGE: 'german',
};
