// Preview: list SRS events that would be deleted from tomorrow onward
function previewSrsToDelete() {
  const cal = (CALENDAR_ID === 'primary')
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CALENDAR_ID);

  const tz = TIMEZONE;
  const todayLocal = toLocalDate(new Date(), tz);
  const start = addDays_(todayLocal, 1);                // from tomorrow
  const end = new Date(); end.setFullYear(end.getFullYear() + 5);

  const prefix = 'Kindle SRS Review — ';

  
  const events = cal.getEvents(start, end, { search: prefix });

  let count = 0;
  events.forEach(ev => {
    const title = ev.getTitle() || '';
    const desc  = ev.getDescription() || '';
    const looksLikeSRS = title.indexOf(prefix) === 0 || /SRS_DATE=\d{4}-\d{2}-\d{2}/.test(desc);
    if (looksLikeSRS) {
      count++;
      Logger.log(`Would delete: ${title} @ ${ev.getStartTime()}`);
    }
  });
  Logger.log(`Preview: ${count} SRS events match for deletion (from tomorrow).`);
}

// Delete all SRS events from tomorrow onward (leaves today alone)
function cleanupSrsFromTomorrow() {
  const cal = (CALENDAR_ID === 'primary')
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CALENDAR_ID);

  const tz = TIMEZONE;
  const todayLocal = toLocalDate(new Date(), tz);
  const start = addDays_(todayLocal, 1);                // from tomorrow
  const end = new Date(); end.setFullYear(end.getFullYear() + 5);

  const prefix = 'Kindle SRS Review — ';
  const events = cal.getEvents(start, end, { search: prefix });

  let scanned = 0, deleted = 0;
  events.forEach(ev => {
    scanned++;
    const title = ev.getTitle() || '';
    const desc  = ev.getDescription() || '';
    const looksLikeSRS = title.indexOf(prefix) === 0 || /SRS_DATE=\d{4}-\d{2}-\d{2}/.test(desc);
    if (looksLikeSRS) {
      try { ev.deleteEvent(); deleted++; } catch (e) {}
    }
  });
  Logger.log(`Cleanup done: scanned ${scanned}, deleted ${deleted} SRS events (from tomorrow).`);
}

// Optional: delete SRS events in an explicit range (keeps other items)
function cleanupSrsInRange(startISO, endISO) {
  const cal = (CALENDAR_ID === 'primary')
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CALENDAR_ID);

  const tz = TIMEZONE;
  const start = toLocalDate(new Date(startISO + 'T00:00:00'), tz);
  const end   = toLocalDate(new Date(endISO   + 'T00:00:00'), tz);

  const prefix = 'Kindle SRS Review — ';
  const events = cal.getEvents(start, end, { search: prefix });

  let deleted = 0;
  events.forEach(ev => {
    const title = ev.getTitle() || '';
    const desc  = ev.getDescription() || '';
    const looksLikeSRS = title.indexOf(prefix) === 0 || /SRS_DATE=\d{4}-\d{2}-\d{2}/.test(desc);
    if (looksLikeSRS) {
      try { ev.deleteEvent(); deleted++; } catch (e) {}
    }
  });
  Logger.log(`Range cleanup: deleted ${deleted} SRS events between ${startISO} and ${endISO}.`);
}
