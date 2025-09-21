# Kindle SRS (Spaced Repetition System)

This project automates daily Kindle vocabulary review using **Google Apps Script** + **Google Drive** + **Google Calendar**.

## Features
- Reads `kindle_vocab.csv` (exported from Kindle vocab.db, stored in Drive).
- Spaced repetition cadence: **1, 3, 7, 14, 30 days**.
- Ensures **at least one word/day** (no empty days).
- Generates a **Google Doc → PDF** with:
  - Word + source book
  - Definition
  - Context sentence
  - Pronunciation (IPA)
  - Audio links (dictionary + optional TTS)
  - Conceptual image (Wikipedia thumbnail)
- Uploads PDF to Drive (`KindleSRS/Reviews`) and links it in a **daily 17:00 calendar event**.
- Guarantees **exactly one event/day** (no duplicates).
- State is tracked in `KindleSRS/srs_state.json` to avoid repetition and preserve history.

## Setup
1. Clone this repo locally.
   ```bash
   git clone https://github.com/<your-user>/kindle-srs.git
   cd kindle-srs/apps-script
