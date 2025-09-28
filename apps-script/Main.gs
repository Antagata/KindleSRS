/*******************************
 * Kindle SRS — Apps Script (Drive + Calendar, daily at 17:00)
 * - Today: full hydration (defs/IPA/audio/image) + PDF + Calendar
 * - Future: safe planning (seed-only, horizon-capped) + PDFs generated in small batches
 * - Calendar links point to a direct PDF preview (uc?export=view&id=...)
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
const EVENT_DURATION_MIN = 15;
const CALENDAR_ID = 'primary';

const SRS_OFFSETS = [1, 3, 7, 14, 30];
const MIN_WORDS_PER_DAY = 1;
const PLAN_HORIZON_DAYS = 60;      // plan up to 60 days ahead
const PREFILL_FROM_TOMORROW = true;

const MAX_WORDS_PER_DAY = 0;       // 0 = no cap for daily PDF
const ADD_CAL_EMAIL_REMINDER = true;
const ADD_CAL_POPUP_REMINDER  = true;

const SEND_EMAIL = false;
const SEND_TO_EMAIL = ''; // e.g., 'you@example.com'

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
        definition: rec.stem || '',
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
    } else if (!state.words[key].definition && rec.stem) {
      state.words[key].definition = rec.stem;
    }
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

  // PDF + Calendar (direct preview link)
  const daily = (state.daily[todayISO] = state.daily[todayISO] || {});
  daily.word_keys = dueKeys;

  const { pdfFileId, pdfLink, pdfDirect } = generatePdfForDay_(local, dueKeys, state, reviewsFolder);
  daily.pdf_file_id = pdfFileId;
  daily.pdf_link    = pdfLink;
  daily.pdf_direct  = pdfDirect;

  createOrReplaceEvent_(local, dueKeys.length, pdfDirect);

  if (SEND_EMAIL) {
    try {
      MailApp.sendEmail({
        to: SEND_TO_EMAIL,
        subject: `Kindle SRS — ${todayISO} (${dueKeys.length} words)`,
        htmlBody: `Your review PDF is ready: <a href="${pdfDirect}">Open PDF</a>`
      });
    } catch (e) { /* ignore */ }
  }

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

    createOrReplaceEvent_(day, keys.length, pdfDirect);
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

/** ---------- CALENDAR ---------- **/
function createOrReplaceEvent_(localMidnight, nWords, pdfPreviewLink) {
  const cal = (CALENDAR_ID === 'primary')
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CALENDAR_ID);

  const dayStart = toLocalDate(localMidnight, TIMEZONE);
  const dayEnd   = addDays_(dayStart, 1);

  const dateStr = toISODate_(localMidnight, TIMEZONE);
  const prefix  = 'Kindle SRS Review — ' + dateStr;

  // Remove any existing SRS events for that day (one canonical per day)
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

    let needDef = !(w.definition && w.definition.trim());
    let needIPA = !(w.pron_ipa && w.pron_ipa.trim());
    let needDictAudio = !(w.audio_word_url && w.audio_word_url.trim());

    if (needDef && defCache.defs[lc]) { w.definition = defCache.defs[lc]; needDef = false; }
    if (needIPA && defCache.ipa[lc])   { w.pron_ipa   = defCache.ipa[lc];  needIPA = false; }
    if (needDictAudio && defCache.dictAudio[lc]) {
      w.audio_word_url = defCache.dictAudio[lc]; needDictAudio = false;
    }
    if (!needDef && !needIPA && !needDictAudio) return;

    try {
      const resp = UrlFetchApp.fetch(DICT_ENDPOINT(w.word), { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) return;
      const data = JSON.parse(resp.getContentText());
      if (Array.isArray(data) && data.length) {
        if (needDef && data[0].meanings?.length) {
          const defs = data[0].meanings[0].definitions || [];
          if (defs.length && defs[0].definition) {
            w.definition = String(defs[0].definition).trim();
            defCache.defs[lc] = w.definition; needDef = false;
          }
        }
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
    } catch (e) { /* ignore */ }
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