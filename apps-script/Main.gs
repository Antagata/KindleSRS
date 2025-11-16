/*******************************
 * Kindle SRS — Apps Script (Drive + Notion, daily at 17:00)
 * - Today: full hydration (defs/IPA/audio/image) + PDF + Notion
 * - Future: safe planning (seed-only, horizon-capped) + PDFs generated in small batches
 * - Notion integration sends daily words to your Notion database
 *******************************/

/** ---------- CONFIG ---------- **/
const CSV_FILE_ID = '1vYdrc55cD4_II7itNAGB0LiDntMNBU8g'; // kindle_vocab.csv Drive file ID
const ROOT_PATH = 'KindleSRS';
const REVIEWS_SUBFOLDER = 'Reviews';
const AUDIO_SUBFOLDER = 'Audio';
const STATE_FILENAME = 'srs_state.json';
const DEF_CACHE_FILENAME = 'definitions_cache.json';

const TIMEZONE = 'Europe/Zurich';
const REVIEW_HOUR = 17;
const REVIEW_MIN = 0;

const SRS_OFFSETS = [1, 3, 7, 14, 30];
const MIN_WORDS_PER_DAY = 1;
const PLAN_HORIZON_DAYS = 60;      // plan up to 60 days ahead
const PREFILL_FROM_TOMORROW = true;

const MAX_WORDS_PER_DAY = 0;       // 0 = no cap for daily PDF

// Email notification settings
const SEND_EMAIL = true;
const SEND_TO_EMAIL = 'afrimath111@gmail.com';

// Notion integration settings
const SEND_TO_NOTION = true;
const NOTION_API_KEY = 'YOUR_NOTION_API_KEY'; // You'll add this after setting up Notion API
const NOTION_DATABASE_ID = '2ada999f2ee8803ba54beef705cdd4c6'; // Extracted from your Notion URL

// Future PDFs: generate a limited number per run to avoid timeouts
const MAX_FUTURE_PDFS_PER_RUN = 6; // tweak if runs are fast/slow on your account

// Concept images + dictionary/IPA
function DICT_ENDPOINT(w) {
  return 'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w);
}
function WIKI_SUMMARY(w) {
  return 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(w);
}
const CONCEPT_IMG_MAX_WIDTH = 300;

// Audio
const DOWNLOAD_DICT_AUDIO = true;      // download dict MP3 to Drive
const CLOUD_TTS_ENABLED = false;       // Google Cloud TTS (optional)
const CLOUD_TTS_API_KEY = 'YOUR_API_KEY';
const CLOUD_TTS_LANG = 'en-US';
const CLOUD_TTS_VOICE = 'en-US-Wavenet-F';
const CLOUD_TTS_SPEAKING_RATE = 1.0;

/** ---------- ENTRYPOINTS ---------- **/
function runDaily() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(280)) { Logger.log('runDaily: could not obtain lock'); return; }
  try {
    _runForDate_(new Date());          // ONLY today
  } finally {
    lock.releaseLock();
  }
}

function runOnce() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(280)) { Logger.log('runOnce: could not obtain lock'); return; }
  try {
    _runForDate_(new Date());          // ONLY today
  } finally {
    lock.releaseLock();
  }
}

/** ---------- CORE: TODAY ---------- **/
function _runForDate_(jsDate) {
  const tz = TIMEZONE;
  const local = toLocalDate(jsDate, tz);

  // Folders/state
  const rootFolder    = ensureFolderPath_(ROOT_PATH);
  const reviewsFolder = ensureSubfolder_(rootFolder, REVIEWS_SUBFOLDER);
  const audioFolder   = ensureSubfolder_(rootFolder, AUDIO_SUBFOLDER);

  const stateFile = ensureStateFile_(rootFolder, STATE_FILENAME);
  const state     = readJson_(stateFile) || { meta: { version: 6 }, words: {}, daily: {} };

  const defCacheFile = ensureStateFile_(rootFolder, DEF_CACHE_FILENAME);
  const defCache     = readJson_(defCacheFile) || { defs: {}, imgs: {}, ipa: {}, dictAudio: {} };

  // CSV
  const { records } = _loadCsv_();
  let newWords = 0;
  records.forEach(rec => {
    const key = wordKey_(rec.word, rec.source);
    if (!state.words[key]) {
      state.words[key] = {
        word: rec.word,
        definition: '[pending]',  // Definition will be fetched by hydration
        context: rec.context || '',
        source: rec.source || '',
        first_seen: null,
        due_days: SRS_OFFSETS.slice(),
        due_dates: [],
        original_date: rec.date ? toISODate_(rec.date, tz) : null,
        pron_ipa: '',
        image_url: '',
        audio_word_url: '',
        audio_sentence_url: ''
      };
      newWords++;
    }
    // Note: we no longer overwrite with stem - let hydration fetch real definitions
  });

  // Ensure min words (robust: seed -> borrow -> restart)
  _ensureMinForDay_(state, local, MIN_WORDS_PER_DAY, { mode: 'today' });

  // Due today
  const todayISO = toISODate_(local, tz);
  let dueKeys = Object.keys(state.words).filter(k => (state.words[k].due_dates || []).indexOf(todayISO) !== -1);
  
  if (MAX_WORDS_PER_DAY > 0 && dueKeys.length > MAX_WORDS_PER_DAY) {
    dueKeys = dueKeys.slice(0, MAX_WORDS_PER_DAY);
  }

  // Hydrate today (defs, IPA, audio, image)
  _hydrateDefinitions_(dueKeys, state, defCache);
  _hydrateConceptImages_(dueKeys, state, defCache);

  const audioFolderRef = DOWNLOAD_DICT_AUDIO || CLOUD_TTS_ENABLED ? audioFolder : null;
  _downloadDictAudiosToDrive_(dueKeys, state, defCache, audioFolderRef);
  _ensureSentenceAudio_(dueKeys, state, audioFolderRef);

  // PDF generation
  const daily = (state.daily[todayISO] = state.daily[todayISO] || {});
  daily.word_keys = dueKeys;

  const { pdfFileId, pdfLink, pdfDirect } = generatePdfForDay_(local, dueKeys, state, reviewsFolder);
  daily.pdf_file_id = pdfFileId;
  daily.pdf_link    = pdfLink;
  daily.pdf_direct  = pdfDirect;

  // Send to Notion
  if (SEND_TO_NOTION) {
    _sendToNotion_(dueKeys, state, todayISO, pdfDirect);
  }

  // Send email notification
  if (SEND_EMAIL) {
    try {
      MailApp.sendEmail({
        to: SEND_TO_EMAIL,
        subject: `Kindle SRS — ${todayISO} (${dueKeys.length} words)`,
        htmlBody: `Your review PDF is ready: <a href="${pdfDirect}">Open PDF</a>`
      });
    } catch (e) { /* ignore */ }
  }

  // CRITICAL: Remove today's date from due_dates after review is completed
  // Then schedule the NEXT review based on SRS progression
  dueKeys.forEach(key => {
    const word = state.words[key];
    if (word && word.due_dates) {
      // Remove today from the schedule
      let dueDates = word.due_dates.filter(date => date !== todayISO);

      // Count how many times this word has been reviewed (past dates only)
      const pastReviews = dueDates.filter(date => date < todayISO).length + 1; // +1 for today

      // Determine next SRS interval based on review count
      // Review 1 → next in 1 day, Review 2 → next in 3 days, etc.
      const nextIntervalIndex = Math.min(pastReviews, SRS_OFFSETS.length - 1);
      const nextInterval = SRS_OFFSETS[nextIntervalIndex];

      // Schedule next review
      const nextReviewDate = addDays_(local, nextInterval);
      const nextReviewISO = toISODate_(nextReviewDate, tz);

      // Add next review date if not already scheduled
      if (dueDates.indexOf(nextReviewISO) === -1) {
        dueDates.push(nextReviewISO);
        dueDates.sort();
      }

      word.due_dates = dueDates;
    }
  });

  writeJson_(stateFile, state);
  writeJson_(defCacheFile, defCache);
  Logger.log(`Done ${todayISO}: ${dueKeys.length} words • new words merged: ${newWords}`);
}

/** ---------- CORE: FUTURE BATCH (sequenced PDFs) ---------- **/
function _generateFutureBatch_(startJsDate) {
  const tz = TIMEZONE;
  const rootFolder    = ensureFolderPath_(ROOT_PATH);
  const reviewsFolder = ensureSubfolder_(rootFolder, REVIEWS_SUBFOLDER);
  const audioFolder   = ensureSubfolder_(rootFolder, AUDIO_SUBFOLDER);

  const stateFile = ensureStateFile_(rootFolder, STATE_FILENAME);
  const state     = readJson_(stateFile) || { meta: { version: 6 }, words: {}, daily: {} };

  // Plan horizon bounds
  let begin = toLocalDate(startJsDate, tz);
  if (PREFILL_FROM_TOMORROW) begin = addDays_(begin, 1);
  const end = addDays_(begin, PLAN_HORIZON_DAYS - 1);
  const capYMD = toISODate_(end, tz);

  // Ensure min words (SAFE: seed-only, horizon-capped)
  for (let i = 0; i < PLAN_HORIZON_DAYS; i++) {
    const day = addDays_(begin, i);
    _ensureMinForDay_(state, day, MIN_WORDS_PER_DAY, { mode: 'future', capYMD });
  }

  // Generate PDFs/events for a limited number of upcoming days per run
  let created = 0;
  for (let i = 0; i < PLAN_HORIZON_DAYS && created < MAX_FUTURE_PDFS_PER_RUN; i++) {
    const day = addDays_(begin, i);
    const ymd = toISODate_(day, tz);

    // Skip if PDF already exists for that day in state
    const already = state.daily[ymd] && state.daily[ymd].pdf_file_id;
    if (already) continue;

    const keys = Object.keys(state.words).filter(k => (state.words[k].due_dates || []).indexOf(ymd) !== -1);
    if (!keys.length) continue;

    // For future PDFs, keep it lightweight: no extra hydration here
    const { pdfFileId, pdfLink, pdfDirect } = generatePdfForDay_(day, keys, state, reviewsFolder);
    state.daily[ymd] = state.daily[ymd] || {};
    state.daily[ymd].word_keys  = keys;
    state.daily[ymd].pdf_file_id = pdfFileId;
    state.daily[ymd].pdf_link    = pdfLink;
    state.daily[ymd].pdf_direct  = pdfDirect;

    created++;
  }

  writeJson_(stateFile, state);
  Logger.log(`Future batch: created ${created} PDF(s) up to ${capYMD}`);
}

/** ---------- PDF / DOC ---------- **/
function generatePdfForDay_(localMidnight, wordKeys, state, reviewsFolder) {
  const todayISO = toISODate_(localMidnight, TIMEZONE);
  const title = `Kindle SRS — ${todayISO} (${wordKeys.length} words)`;

  const doc = DocumentApp.create(title);
  const body = doc.getBody();
  body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.TITLE);

  if (wordKeys.length === 0) {
    body.appendParagraph('No words due today. Keep reading! 📚');
  } else {
    let idx = 1;
    wordKeys.forEach(k => {
      const w = state.words[k];

      body.appendParagraph(`${idx}. ${w.word}${w.source ? ` — ${w.source}` : ''}`)
          .setHeading(DocumentApp.ParagraphHeading.HEADING2);

      const ipa = (w.pron_ipa ? ` /${w.pron_ipa.replace(/^\/|\/$/g,'')}/` : '');
      body.appendParagraph(`Pronunciation:${ipa || ' [pending]'}`);

      body.appendParagraph(`Definition: ${w.definition ? w.definition : '[pending]'}`);
      if (w.context) body.appendParagraph(`Context: ${w.context}`);

      if (w.audio_word_url) {
        const p = body.appendParagraph(`🔊 Word audio: ${w.audio_word_url}`);
        try { p.setLinkUrl(w.audio_word_url); } catch (e) {}
      }
      if (w.audio_sentence_url) {
        const p2 = body.appendParagraph(`🗣️ Sentence audio: ${w.audio_sentence_url}`);
        try { p2.setLinkUrl(w.audio_sentence_url); } catch (e) {}
      }

      if (w.image_url) {
        try {
          const imgRes = UrlFetchApp.fetch(w.image_url, { muteHttpExceptions: true });
          if (imgRes.getResponseCode() === 200) {
            const blob = imgRes.getBlob();
            const img = body.appendImage(blob);
            try { img.setWidth(CONCEPT_IMG_MAX_WIDTH); } catch (e) {}
          }
        } catch (e) { /* ignore */ }
      }

      body.appendParagraph(''); // spacer
      idx++;
    });
  }

  doc.saveAndClose();

  // Export to PDF, share, and trash the Doc to keep Drive tidy
  const docFile = DriveApp.getFileById(doc.getId());
  const pdfBlob = docFile.getBlob().getAs('application/pdf');
  const pdfFile = reviewsFolder.createFile(pdfBlob).setName(title + '.pdf');
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  try { docFile.setTrashed(true); } catch (e) {}

  const viewLink   = pdfFile.getUrl();                     // Drive UI
  const pdfDirect  = driveDirectLink_(pdfFile.getId(), 'view'); // direct preview

  return { pdfFileId: pdfFile.getId(), pdfLink: viewLink, pdfDirect: pdfDirect };
}

function driveDirectLink_(fileId, mode) {
  var exportParam = (mode === 'download') ? 'download' : 'view';
  return 'https://drive.google.com/uc?export=' + exportParam + '&id=' + fileId;
}

/** ---------- CALENDAR (DEPRECATED - Using Notion instead) ---------- **/
// Calendar integration has been replaced with Notion integration
// Old calendar function kept here for reference only
/*
function createOrReplaceEvent_(localMidnight, nWords, pdfPreviewLink) {
  const cal = (CALENDAR_ID === 'primary')
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CALENDAR_ID);

  const dayStart = toLocalDate(localMidnight, TIMEZONE);
  const dayEnd   = addDays_(dayStart, 1);

  const dateStr = toISODate_(localMidnight, TIMEZONE);
  const prefix  = 'Kindle SRS Review — ' + dateStr;

  const existing = cal.getEvents(dayStart, dayEnd, { search: prefix });
  existing.forEach(e => { try { e.deleteEvent(); } catch (err) {} });

  const start = new Date(localMidnight);
  start.setHours(REVIEW_HOUR, REVIEW_MIN, 0, 0);
  const end = new Date(start.getTime() + EVENT_DURATION_MIN * 60000);

  const summary = `${prefix} (${nWords} words)`;
  const description =
    `Daily spaced repetition review.\n` +
    `PDF (preview): ${pdfPreviewLink}\n` +
    `SRS_DATE=${dateStr}`;

  const ev = cal.createEvent(summary, start, end, { description });
  if (ADD_CAL_POPUP_REMINDER) { try { ev.addPopupReminder(0); } catch (e) {} }
  if (ADD_CAL_EMAIL_REMINDER) { try { ev.addEmailReminder(0); } catch (e) {} }
  return ev.getId();
}
*/

/** ---------- NO-GAPS (seed/borrow/restart for today; seed-only for future) ---------- **/
function _ensureMinForDay_(state, localMidnight, minCount, opts) {
  const tz = TIMEZONE;
  const ymd = toISODate_(localMidnight, tz);
  const mode = (opts && opts.mode) || 'today';
  const capYMD = opts && opts.capYMD;

  const countForDay = () =>
    Object.keys(state.words).filter(k => (state.words[k].due_dates || []).indexOf(ymd) !== -1).length;

  const need = () => Math.max(0, minCount - countForDay());
  if (need() <= 0) return;

  // Seed from unstarted
  {
    const pool = Object.keys(state.words).filter(k => !state.words[k].first_seen);
    while (need() > 0 && pool.length) {
      const k = pool.shift();
      _seedWordFromDate_(state, k, localMidnight, capYMD);
    }
    if (need() <= 0) return;
  }

  // Future planning stops here (no borrow/restart)
  if (mode === 'future') return;

  // Borrow (extra review today)
  {
    const horizonDays = 7;
    const candidates = [];
    for (let i = 1; i <= horizonDays; i++) {
      const futureYMD = toISODate_(addDays_(localMidnight, i), tz);
      Object.keys(state.words).forEach(key => {
        const s = state.words[key];
        const due = s.due_dates || [];
        if (due.indexOf(futureYMD) !== -1 && due.indexOf(ymd) === -1) {
          candidates.push({ key, dist: i });
        }
      });
    }
    candidates.sort((a, b) => a.dist - b.dist || (a.key < b.key ? -1 : 1));
    const picked = new Set();
    for (let i = 0; i < candidates.length && need() > 0; i++) {
      const { key } = candidates[i];
      if (picked.has(key)) continue;
      picked.add(key);
      const s = state.words[key];
      const set = new Set(s.due_dates || []);
      set.add(ymd);
      s.due_dates = Array.from(set).sort();
    }
    if (need() <= 0) return;
  }

  // Restart (new cycle from today)
  {
    const completed = Object.keys(state.words).filter(key => {
      const due = (state.words[key].due_dates || []).slice().sort();
      if (!due.length) return false;
      return due[due.length - 1] < ymd;
    });
    completed.sort();
    for (let i = 0; i < completed.length && need() > 0; i++) {
      const key = completed[i];
      const s = state.words[key];
      const set = new Set(s.due_dates || []);
      set.add(ymd);
      SRS_OFFSETS.forEach(off => {
        const d = addDays_(localMidnight, off);
        set.add(toISODate_(d, tz));
      });
      s.due_dates = Array.from(set).sort();
    }
  }
}

// Seed: set first_seen and add today + offsets (capped by capYMD if provided)
function _seedWordFromDate_(state, key, localMidnight, capYMD) {
  const tz = TIMEZONE;
  const ymd0 = toISODate_(localMidnight, tz);
  const w = state.words[key];
  if (!w) return;
  if (!w.due_days || !w.due_days.length) w.due_days = SRS_OFFSETS.slice();

  w.first_seen = ymd0;

  const dates = [ymd0];
  SRS_OFFSETS.forEach(off => {
    const d = addDays_(localMidnight, off);
    const y = toISODate_(d, tz);
    if (!capYMD || y <= capYMD) dates.push(y);
  });

  const set = new Set([...(w.due_dates || []), ...dates]);
  w.due_dates = Array.from(set).sort();
}

/** ---------- HYDRATION (defs/images/audio) ---------- **/
function _hydrateDefinitions_(keys, state, defCache) {
  defCache.defs = defCache.defs || {};
  defCache.ipa  = defCache.ipa  || {};
  defCache.dictAudio = defCache.dictAudio || {};

  keys.forEach(k => {
    const w = state.words[k];
    if (!w) return;

    const lc = (w.word || '').toLowerCase();

    // Check if definition needs fetching (empty, '[pending]', or equals the word itself)
    let needDef = !w.definition ||
                  w.definition.trim() === '' ||
                  w.definition === '[pending]' ||
                  w.definition.toLowerCase() === lc;  // Avoid self-referential definitions
    let needIPA = !(w.pron_ipa && w.pron_ipa.trim());
    let needDictAudio = !(w.audio_word_url && w.audio_word_url.trim());

    // Try cache first
    if (needDef && defCache.defs[lc]) { w.definition = defCache.defs[lc]; needDef = false; }
    if (needIPA && defCache.ipa[lc])   { w.pron_ipa   = defCache.ipa[lc];  needIPA = false; }
    if (needDictAudio && defCache.dictAudio[lc]) {
      w.audio_word_url = defCache.dictAudio[lc]; needDictAudio = false;
    }
    if (!needDef && !needIPA && !needDictAudio) return;

    // Try Dictionary API first
    try {
      const resp = UrlFetchApp.fetch(DICT_ENDPOINT(w.word), { muteHttpExceptions: true });
      if (resp.getResponseCode() === 200) {
        const data = JSON.parse(resp.getContentText());
        if (Array.isArray(data) && data.length) {
          // Fetch definition
          if (needDef && data[0].meanings?.length) {
            const defs = data[0].meanings[0].definitions || [];
            if (defs.length && defs[0].definition) {
              w.definition = String(defs[0].definition).trim();
              defCache.defs[lc] = w.definition;
              needDef = false;
            }
          }
          // Fetch IPA and audio
          const ph = data[0].phonetics || [];
          if (ph.length) {
            if (needIPA) {
              const ipa = (ph.find(p => p.text)?.text) || '';
              if (ipa) { w.pron_ipa = ipa; defCache.ipa[lc] = ipa; needIPA = false; }
            }
            if (needDictAudio) {
              const audioUrl = (ph.find(p => p.audio)?.audio) || '';
              if (audioUrl) {
                w.audio_word_url = audioUrl;
                defCache.dictAudio[lc] = w.audio_word_url;
                needDictAudio = false;
              }
            }
          }
        }
      }
    } catch (e) { /* ignore */ }

    // Wikipedia fallback for definition if dictionary API failed
    if (needDef) {
      try {
        const wikiResp = UrlFetchApp.fetch(WIKI_SUMMARY(w.word), { muteHttpExceptions: true });
        if (wikiResp.getResponseCode() === 200) {
          const wikiData = JSON.parse(wikiResp.getContentText());
          if (wikiData && wikiData.extract) {
            // Use first sentence or first ~150 chars as definition
            let extract = String(wikiData.extract).trim();
            const firstSentence = extract.split(/[.!?]\s/)[0];
            if (firstSentence && firstSentence.length > 20) {
              w.definition = firstSentence + '.';
              defCache.defs[lc] = w.definition;
              needDef = false;
            } else if (extract.length > 20) {
              // Use truncated extract if first sentence is too short
              w.definition = extract.substring(0, 150) + (extract.length > 150 ? '...' : '');
              defCache.defs[lc] = w.definition;
              needDef = false;
            }
          }
        }
      } catch (e) { /* ignore */ }
    }

    // If still no definition, mark as "No definition found"
    if (needDef && (!w.definition || w.definition === '[pending]')) {
      w.definition = 'No definition found';
    }
  });
}

function _hydrateConceptImages_(keys, state, defCache) {
  defCache.imgs = defCache.imgs || {};
  keys.forEach(k => {
    const w = state.words[k];
    if (!w) return;
    const wc = (w.word || '').toLowerCase();
    if (w.image_url && w.image_url.trim()) return;
    if (defCache.imgs[wc]) { w.image_url = defCache.imgs[wc]; return; }

    const url = _fetchWikiThumbUrl_(w.word);
    w.image_url = url || '';
    defCache.imgs[wc] = w.image_url;
  });
}

function _fetchWikiThumbUrl_(word) {
  try {
    const res = UrlFetchApp.fetch(WIKI_SUMMARY(word), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return '';
    const data = JSON.parse(res.getContentText());
    if (data && data.thumbnail && data.thumbnail.source) return String(data.thumbnail.source);
  } catch (e) { /* ignore */ }
  return '';
}

function _downloadDictAudiosToDrive_(keys, state, defCache, audioFolder) {
  if (!DOWNLOAD_DICT_AUDIO || !audioFolder) return;

  keys.forEach(k => {
    const w = state.words[k];
    if (!w || !w.audio_word_url) return;
    if (w.audio_word_url.startsWith('https://drive.google.com/')) return;

    try {
      const res = UrlFetchApp.fetch(w.audio_word_url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) return;
      const blob = res.getBlob().setName(`${(w.word || 'word')}.mp3`);
      const f = audioFolder.createFile(blob);
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      w.audio_word_url = f.getUrl();
      const lc = (w.word || '').toLowerCase();
      defCache.dictAudio[lc] = w.audio_word_url;
    } catch (e) { /* ignore */ }
  });
}

function _ensureSentenceAudio_(keys, state, audioFolder) {
  if (!CLOUD_TTS_ENABLED || !audioFolder) return;

  keys.forEach(k => {
    const w = state.words[k];
    if (!w) return;
    if (w.audio_sentence_url && w.audio_sentence_url.trim()) return;

    const sentence = (w.context && w.context.trim())
      ? w.context.trim()
      : `Here is an example using the word ${w.word} in a sentence.`;

    const url = _ttsSynthesize_(sentence, `${(w.word||'word')}_sentence`, audioFolder);
    if (url) w.audio_sentence_url = url;
  });
}

function _ttsSynthesize_(text, filenameBase, audioFolder) {
  if (!CLOUD_TTS_ENABLED || !CLOUD_TTS_API_KEY) return '';
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(CLOUD_TTS_API_KEY)}`;
  const payload = {
    input: { text },
    voice: { languageCode: CLOUD_TTS_LANG, name: CLOUD_TTS_VOICE },
    audioConfig: { audioEncoding: 'MP3', speakingRate: CLOUD_TTS_SPEAKING_RATE }
  };
  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return '';
    const data = JSON.parse(resp.getContentText());
    if (!data.audioContent) return '';
    const blob = Utilities.newBlob(Utilities.base64Decode(data.audioContent), 'audio/mpeg', `${filenameBase}.mp3`);
    const file = audioFolder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (e) { return ''; }
}

/** ---------- NOTION INTEGRATION ---------- **/
function _sendToNotion_(wordKeys, state, dateISO, pdfLink) {
  if (!NOTION_API_KEY || NOTION_API_KEY === 'YOUR_NOTION_API_KEY') {
    Logger.log('⚠️  Notion API key not configured. Skipping Notion sync.');
    return;
  }

  try {
    // Create a page for each word in the Notion database
    wordKeys.forEach(key => {
      const word = state.words[key];
      if (!word) return;

      const notionPayload = {
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          'Word': {
            title: [{ text: { content: word.word || 'Unknown' } }]
          },
          'Definition': {
            rich_text: [{ text: { content: word.definition || 'No definition' } }]
          },
          'Context': {
            rich_text: [{ text: { content: word.context || '' } }]
          },
          'Source': {
            rich_text: [{ text: { content: word.source || '' } }]
          },
          'Review Date': {
            date: { start: dateISO }
          },
          'PDF Link': {
            url: pdfLink || ''
          }
        }
      };

      const options = {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'Authorization': 'Bearer ' + NOTION_API_KEY,
          'Notion-Version': '2022-06-28'
        },
        payload: JSON.stringify(notionPayload),
        muteHttpExceptions: true
      };

      const response = UrlFetchApp.fetch('https://api.notion.com/v1/pages', options);
      const responseCode = response.getResponseCode();

      if (responseCode === 200) {
        Logger.log(`✅ Sent "${word.word}" to Notion`);
      } else {
        Logger.log(`❌ Failed to send "${word.word}" to Notion: ${response.getContentText()}`);
      }
    });
  } catch (e) {
    Logger.log(`❌ Notion integration error: ${e.message}`);
  }
}

/** ---------- CSV / UTIL / STATE ---------- **/
function _loadCsv_() {
  const csv  = DriveApp.getFileById(CSV_FILE_ID).getBlob().getDataAsString();
  const rows = Utilities.parseCsv(csv);
  if (!rows || rows.length < 2) throw new Error('CSV appears empty or malformed.');
  const header = rows[0].map(h => (h || '').trim());
  const req = ['Word', 'Stem', 'BookTitle', 'Context', 'DateAdded'];
  req.forEach(col => {
    if (header.indexOf(col) === -1) throw new Error('Missing column: ' + col + '. Found: ' + header.join(', '));
  });
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const word = safeStr_(row[idx.Word]);
    if (!word) continue;
    records.push({
      word: word,
      stem: safeStr_(row[idx.Stem]),
      context: safeStr_(row[idx.Context]),
      source: safeStr_(row[idx.BookTitle]),
      date: parseDate_(row[idx.DateAdded], TIMEZONE)
    });
  }
  return { records };
}

function ensureFolderPath_(pathStr) {
  const parts = pathStr.split('/').map(s => s.trim()).filter(Boolean);
  let folder = DriveApp.getRootFolder();
  parts.forEach(name => {
    const it = folder.getFoldersByName(name);
    folder = it.hasNext() ? it.next() : folder.createFolder(name);
  });
  return folder;
}
function ensureSubfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function ensureStateFile_(parentFolder, name) {
  const it = parentFolder.getFilesByName(name);
  return it.hasNext() ? it.next() : parentFolder.createFile(name, JSON.stringify({}), MimeType.PLAIN_TEXT);
}
function readJson_(file) {
  try { return JSON.parse(file.getBlob().getDataAsString()); }
  catch (e) { return null; }
}
function writeJson_(file, obj) {
  file.setTrashed(true);
  const parent = file.getParents().hasNext() ? file.getParents().next() : DriveApp.getRootFolder();
  parent.createFile(file.getName(), JSON.stringify(obj, null, 2), MimeType.PLAIN_TEXT);
  return true;
}
function toLocalDate(date, tz) {
  const str = Utilities.formatDate(date, tz, 'yyyy-MM-dd');
  return new Date(str + 'T00:00:00' + offsetISO_(tz));
}
function toISODate_(date, tz) { return Utilities.formatDate(date, tz, 'yyyy-MM-dd'); }
function addDays_(date, days) { const d = new Date(date.getTime()); d.setDate(d.getDate() + days); return d; }
function safeStr_(v) { return (v == null) ? '' : String(v).trim(); }
function wordKey_(word, source) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, (word.toLowerCase() + '|' + (source||'').toLowerCase()))
    .map(b => (b + 256).toString(16).slice(-2)).join('');
}
function parseDate_(val, tz) {
  if (!val) return null;
  const d = new Date(val);
  if (!isNaN(d.getTime())) {
    const isoDay = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    return new Date(isoDay + 'T00:00:00' + offsetISO_(tz));
  }
  return null;
}
function offsetISO_(tz) {
  const now = new Date();
  const m = Utilities.formatDate(now, tz, 'Z').match(/([+-]\d{2})(\d{2})/);
  const hh = Number(m[1]); const mm = Number(m[2]);
  const total = (Math.sign(hh) >= 0 ? 1 : -1) * (Math.abs(hh) * 60 + mm);
  const sign = total >= 0 ? '+' : '-';
  const abs = Math.abs(total);
  const H = String(Math.floor(abs / 60)).padStart(2, '0');
  const M = String(abs % 60).padStart(2, '0');
  return `${sign}${H}:${M}`;
}

/** ---------- DIAGNOSTIC: confirm schedule ---------- **/
function _nowInTz_(tz) {
  const now = new Date();
  const day = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const hms = Utilities.formatDate(now, tz, 'HH:mm:ss');
  return new Date(`${day}T${hms}${offsetISO_(tz)}`);
}

function _nextReviewTime_(tz) {
  const now = _nowInTz_(tz);
  const next = toLocalDate(now, tz);
  next.setHours(REVIEW_HOUR, REVIEW_MIN, 0, 0);
  if (now.getTime() >= next.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function _logScheduleNote_() {
  const tz = TIMEZONE;
  const now = _nowInTz_(tz);
  const next = _nextReviewTime_(tz);

  // Check if a time-driven trigger exists for runDaily
  let hasDailyTrigger = false;
  try {
    hasDailyTrigger = ScriptApp.getProjectTriggers().some(t =>
      t.getHandlerFunction && t.getHandlerFunction() === 'runDaily' &&
      t.getEventType && t.getEventType() === ScriptApp.EventType.CLOCK
    );
  } catch (e) { /* ignore */ }

  const nowFormatted = Utilities.formatDate(now, tz, "EEE, yyyy-MM-dd HH:mm:ss");
  const nextFormatted = Utilities.formatDate(next, tz, "EEE, yyyy-MM-dd HH:mm");
  
  Logger.log(
    `[Scheduler] Now: ${nowFormatted} (${tz})  | ` +
    `Next planned 17:00: ${nextFormatted} (${tz})  | ` +
    `Time-driven trigger for runDaily present: ${hasDailyTrigger ? 'YES' : 'NO'}`
  );
}

// Hook the note to the end of the main entrypoints:
(function() {
  const _runDailyOrig = runDaily;
  runDaily = function() { try { _runDailyOrig(); } finally { _logScheduleNote_(); } };
  const _runOnceOrig = runOnce;
  runOnce  = function() { try { _runOnceOrig(); }  finally { _logScheduleNote_(); } };
})();

/** ---- One-off purge: delete all future Kindle SRS events (keeps today) ---- */
function purgeFutureSrs() {
  const cal = (CALENDAR_ID === 'primary')
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CALENDAR_ID);

  const tz = TIMEZONE;
  const todayLocal = toLocalDate(new Date(), tz);
  const start = addDays_(todayLocal, 1); // from tomorrow
  const end = new Date(); end.setFullYear(end.getFullYear() + 5);

  const prefix = 'Kindle SRS Review — ';
  const events = cal.getEvents(start, end, { search: prefix });

  let scanned = 0, deleted = 0;
  for (const ev of events) {
    scanned++;
    const title = ev.getTitle() || '';
    const desc  = ev.getDescription() || '';
    const looksLikeSRS = title.indexOf(prefix) === 0 || /SRS_DATE=\d{4}-\d{2}-\d{2}/.test(desc);
    if (looksLikeSRS) { try { ev.deleteEvent(); deleted++; } catch (e) {} }
  }
  Logger.log(`Purge complete: scanned ${scanned}, deleted ${deleted} future SRS events.`);
}

/** ---- One-time: create/refresh the daily trigger at 17:00 local ---- */
function ensureDailyTrigger() {
  // remove existing runDaily triggers
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runDaily') ScriptApp.deleteTrigger(t);
  });
  // create a fresh one
  ScriptApp.newTrigger('runDaily')
    .timeBased()
    .atHour(REVIEW_HOUR)
    .everyDays(1)
    .inTimezone(TIMEZONE)
    .create();
  Logger.log(`Created daily trigger for runDaily @ ${REVIEW_HOUR}:00 ${TIMEZONE}`);
}

/** ---- Quick diagnostics: show today + next 7 counts and today's PDF link ---- */
function diagnoseNow() {
  const tz = TIMEZONE;
  const root = ensureFolderPath_(ROOT_PATH);
  const state = readJson_(ensureStateFile_(root, STATE_FILENAME)) || {words:{}, daily:{}};
  const today = toLocalDate(new Date(), tz);
  const ymd = toISODate_(today, tz);

  const all = Object.keys(state.words);
  const dueToday = all.filter(k => (state.words[k].due_dates||[]).indexOf(ymd) !== -1);

  Logger.log(`Total words: ${all.length}`);
  Logger.log(`Due today  : ${dueToday.length}`);

  // next 7 days preview
  for (let i=0;i<7;i++){
    const d = addDays_(today, i);
    const y = toISODate_(d, tz);
    const n = all.filter(k => (state.words[k].due_dates||[]).indexOf(y) !== -1).length;
    Logger.log(`${y}: ${n} word(s)`);
  }

  const daily = state.daily[ymd];
  if (daily && (daily.pdf_direct || daily.pdf_link)) {
    Logger.log(`Today PDF: ${daily.pdf_direct || daily.pdf_link}`);
  }
}

/** ---- Force rebuild today (useful for testing) ---- */
function forceRegenerateToday() {
  const tz = TIMEZONE;
  const root = ensureFolderPath_(ROOT_PATH);
  const stateFile = ensureStateFile_(root, STATE_FILENAME);
  const state = readJson_(stateFile) || { words:{}, daily:{} };

  const ymd = toISODate_(toLocalDate(new Date(), tz), tz);
  if (!state.daily) state.daily = {};
  if (!state.daily[ymd]) state.daily[ymd] = {};
  state.daily[ymd].pdf_file_id = null;
  state.daily[ymd].pdf_link = null;
  state.daily[ymd].pdf_direct = null;

  writeJson_(stateFile, state);
  runOnce();
}

/** ---- 15-DAY SRS SCHEDULE ANALYSIS ---- */
function analyze15DaySchedule() {
  const tz = TIMEZONE;
  const root = ensureFolderPath_(ROOT_PATH);
  const state = readJson_(ensureStateFile_(root, STATE_FILENAME)) || {words:{}, daily:{}};
  const today = toLocalDate(new Date(), tz);
  
  Logger.log('=== 15-DAY SRS SCHEDULE ANALYSIS ===');
  Logger.log('');
  
  let totalReviews = 0;
  const dailyWordCounts = [];
  const allScheduledWords = new Set();
  const wordFrequency = {};
  
  // Analyze each day
  for (let i = 0; i < 15; i++) {
    const date = addDays_(today, i);
    const dateISO = toISODate_(date, tz);
    const wordKeysForDay = Object.keys(state.words).filter(k => 
      (state.words[k].due_dates || []).indexOf(dateISO) !== -1
    );
    
    const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
    const dayLabel = i === 0 ? 'TODAY' : i === 1 ? 'TOMORROW' : `Day +${i}`;
    
    Logger.log(`${dayLabel.padEnd(10)} ${dayName} ${dateISO}: ${wordKeysForDay.length} word(s)`);
    
    // Track word frequency and details
    wordKeysForDay.forEach(key => {
      const word = state.words[key];
      allScheduledWords.add(word.word);
      wordFrequency[word.word] = (wordFrequency[word.word] || 0) + 1;
      
      if (wordKeysForDay.length <= 10) { // Only show details if not too many
        const definition = word.definition || 'No definition';
        const source = word.source || 'Unknown source';
        Logger.log(`    • "${word.word}" - ${definition} [${source}]`);
      }
    });
    
    dailyWordCounts.push(wordKeysForDay.length);
    totalReviews += wordKeysForDay.length;
    Logger.log('');
  }
  
  // Analysis Summary
  Logger.log('=== SRS CADENCE ANALYSIS ===');
  Logger.log(`📊 Total reviews: ${totalReviews} over 15 days`);
  Logger.log(`📈 Average per day: ${(totalReviews/15).toFixed(1)} reviews`);
  Logger.log(`📉 Min/Max per day: ${Math.min(...dailyWordCounts)} / ${Math.max(...dailyWordCounts)}`);
  Logger.log(`🎯 Unique words: ${allScheduledWords.size} different words`);
  Logger.log('');
  
  // Check for issues
  const duplicateWords = Object.entries(wordFrequency).filter(([word, count]) => count > 5);
  const veryLightDays = dailyWordCounts.filter(count => count < 2).length;
  const veryHeavyDays = dailyWordCounts.filter(count => count > 20).length;
  
  Logger.log('=== HEALTH CHECK ===');
  if (duplicateWords.length > 0) {
    Logger.log(`⚠️  Words appearing too frequently (>5 times):`);
    duplicateWords.forEach(([word, count]) => {
      Logger.log(`   "${word}" appears ${count} times`);
    });
  }
  
  if (veryLightDays > 0) Logger.log(`📉 ${veryLightDays} days have very few reviews (<2)`);
  if (veryHeavyDays > 0) Logger.log(`📈 ${veryHeavyDays} days have many reviews (>20)`);
  
  if (duplicateWords.length === 0 && veryLightDays <= 2 && veryHeavyDays <= 2) {
    Logger.log('✅ SRS schedule looks healthy!');
  }
  
  Logger.log('');
  Logger.log('💡 Use markWordAsMastered(["word1", "word2"]) to remove mastered words');
}

/** ---- Quick function to master the word "put" ---- */
function masterWordPut() {
  markWordAsMastered(["put"]);
}

/** ---- Quick function to master all problematic words ---- */
function masterProblematicWords() {
  markWordAsMastered(["put", "bade", "antics", "prodded", "gauze"]);
}

/** ---- Master duplicate words ---- */
function masterDuplicateWords() {
  markWordAsMastered(["British", "incredibly"]);
}

/** ---- Spread out clustered schedule for better daily distribution ---- */
function fixScheduleClustering() {
  const tz = TIMEZONE;
  const root = ensureFolderPath_(ROOT_PATH);
  const stateFile = ensureStateFile_(root, STATE_FILENAME);
  const state = readJson_(stateFile) || {words:{}, daily:{}};
  const today = toLocalDate(new Date(), tz);
  const todayISO = toISODate_(today, tz);
  
  Logger.log('=== FIXING SCHEDULE CLUSTERING ===');
  Logger.log('');
  
  // Find words with future dates
  const activeWords = [];
  Object.keys(state.words).forEach(key => {
    const word = state.words[key];
    const futureDates = (word.due_dates || []).filter(date => date > todayISO);
    if (futureDates.length > 0) {
      activeWords.push({
        key: key,
        word: word.word,
        futureDates: futureDates
      });
    }
  });
  
  Logger.log(`📊 Found ${activeWords.length} active words to redistribute`);
  
  // Redistribute words across 15 days more evenly
  activeWords.forEach((item, index) => {
    const word = state.words[item.key];
    const pastDates = (word.due_dates || []).filter(date => date <= todayISO);
    
    // Create staggered schedule: spread words across different starting days
    const startOffset = (index % 7) + 1; // Start between day 1-7
    const newDates = [];
    
    // Each word gets reviews at: start, start+3, start+7, start+14, start+30
    [0, 3, 7, 14, 30].forEach(interval => {
      const reviewDate = addDays_(today, startOffset + interval);
      const reviewISO = toISODate_(reviewDate, tz);
      newDates.push(reviewISO);
    });
    
    // Keep past dates + new distributed future dates
    word.due_dates = [...pastDates, ...newDates].sort();
    
    if (index < 10) { // Show first 10 as examples
      Logger.log(`✅ "${word.word}": new schedule starts day +${startOffset}`);
    }
  });
  
  writeJson_(stateFile, state);
  
  Logger.log('');
  Logger.log(`🎉 Redistributed ${activeWords.length} words across 15 days`);
  Logger.log('📅 Words now start on different days for better distribution');
  Logger.log('🔄 Run analyze15DaySchedule() to see improved balance');
}

/*
 * =============================================================================
 * 📍 USER MANAGEMENT FUNCTIONS - ADD YOUR CUSTOM FUNCTIONS HERE
 * =============================================================================
 * These functions should be placed at the end of your script, after all the 
 * core SRS functionality but before the final utility functions.
 * 
 * Current location: After line ~830, before showTriggers() function
 * =============================================================================
 */

/** ---- Mark words as mastered (removes from SRS and replaces with new words) ---- */
function markWordAsMastered(wordsToMaster) {
  if (!Array.isArray(wordsToMaster) || wordsToMaster.length === 0) {
    Logger.log('❌ ERROR: Please provide an array of words to mark as mastered');
    Logger.log('📝 EXAMPLE: markWordAsMastered(["the", "incredibly"])');
    return;
  }
  
  const tz = TIMEZONE;
  const root = ensureFolderPath_(ROOT_PATH);
  const stateFile = ensureStateFile_(root, STATE_FILENAME);
  const state = readJson_(stateFile) || {words:{}, daily:{}};
  const today = toLocalDate(new Date(), tz);
  
  Logger.log('=== MARKING WORDS AS MASTERED ===');
  Logger.log('');
  
  let masteredCount = 0;
  let notFoundCount = 0;
  
  wordsToMaster.forEach(wordToMaster => {
    // Find the word key (word + source combination)
    const matchingKeys = Object.keys(state.words).filter(key => 
      state.words[key].word === wordToMaster
    );
    
    if (matchingKeys.length === 0) {
      Logger.log(`❌ Word "${wordToMaster}" not found in system`);
      notFoundCount++;
    } else {
      matchingKeys.forEach(key => {
        const word = state.words[key];
        Logger.log(`✅ Mastered "${wordToMaster}" from ${word.source || 'unknown source'}`);
        Logger.log(`   Definition: ${word.definition || 'No definition'}`);
        
        // Mark as mastered instead of deleting - keeps history
        word.mastered = true;
        word.mastered_date = toISODate_(today, tz);
        word.due_dates = []; // Remove from future reviews
        
        masteredCount++;
      });
    }
  });
  
  if (masteredCount > 0) {
    // Replace mastered words with new ones from completed pool
    Logger.log('');
    Logger.log('� REPLACING WITH NEW WORDS...');
    
    // Find completed words to restart
    const completedWords = [];
    Object.keys(state.words).forEach(key => {
      const word = state.words[key];
      const dueDates = word.due_dates || [];
      const futureDates = dueDates.filter(date => date > toISODate_(today, tz));
      const hasPastDates = dueDates.some(date => date < toISODate_(today, tz));
      
      // Not mastered and completed cycle = candidate for restart
      if (!word.mastered && word.first_seen && hasPastDates && futureDates.length === 0) {
        completedWords.push({
          key: key,
          word: word.word,
          lastDate: Math.max(...dueDates.map(d => new Date(d)))
        });
      }
    });
    
    // Sort by last review date and restart the same number as mastered
    completedWords.sort((a, b) => a.lastDate - b.lastDate);
    const toRestart = completedWords.slice(0, masteredCount);
    
    toRestart.forEach(item => {
      const word = state.words[item.key];
      
      // Add new SRS cycle starting from tomorrow
      const newDates = [];
      SRS_OFFSETS.forEach(offset => {
        const reviewDate = addDays_(today, offset);
        const reviewISO = toISODate_(reviewDate, tz);
        newDates.push(reviewISO);
      });
      
      const existingDates = word.due_dates || [];
      const combinedDates = [...existingDates, ...newDates];
      word.due_dates = Array.from(new Set(combinedDates)).sort();
      
      Logger.log(`🆕 Replaced with "${word.word}" - next reviews: ${newDates.join(', ')}`);
    });
    
    writeJson_(stateFile, state);
    
    Logger.log('');
    Logger.log(`✅ Successfully mastered ${masteredCount} word(s)`);
    Logger.log(`� Replaced with ${toRestart.length} new words`);
    if (notFoundCount > 0) {
      Logger.log(`⚠️  ${notFoundCount} word(s) not found`);
    }
    Logger.log('💾 State file updated');
    Logger.log('');
    Logger.log('🔄 Run analyze15DaySchedule() to see updated schedule');
  } else {
    Logger.log('❌ No words were mastered');
  }
}

/** ---- Temporary: inspect existing triggers ---- */
function showTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const hf = typeof t.getHandlerFunction === 'function' ? t.getHandlerFunction() : '';
    const et = typeof t.getEventType === 'function' ? t.getEventType() : '';
    Logger.log(`handler=${hf} type=${et}`);
  });
}

/** ---- Bootstrap authentication - run once to trigger consent screen ---- */
function __bootstrapAuth() {
  // Touch Docs
  const d = DocumentApp.create("KindleSRS Auth Bootstrap " + new Date());
  // Touch Drive (create & trash a folder to assert Drive scope)
  const f = DriveApp.createFolder("KindleSRS_AUTH_TEST");
  f.setTrashed(true);
  DriveApp.getFileById(d.getId()).setTrashed(true);
}