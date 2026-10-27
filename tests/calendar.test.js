import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIcs, eventsOn, wallToUtc } from "../src/calendar.js";

process.env.TZ = process.env.TZ || "America/New_York";
const day = (y, m, d) => new Date(y, m - 1, d).getTime();
const cal = (...events) => `BEGIN:VCALENDAR\r\nX-WR-CALNAME:Work\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
const ev = (lines) => `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT`;
const titles = (ics, d) => eventsOn(parseIcs(ics), d).map((e) => e.title);

test("zones convert wall time to the right instant", () => {
  assert.equal(new Date(wallToUtc({ y: 2026, m: 10, d: 27, h: 9 }, "America/Los_Angeles")).toISOString(), "2026-10-27T16:00:00.000Z");
  assert.equal(new Date(wallToUtc({ y: 2026, m: 11, d: 2, h: 9 }, "America/New_York")).toISOString(), "2026-11-02T14:00:00.000Z"); // after DST ends
});

test("one-off, all-day and folded lines", () => {
  const ics = cal(
    ev(["UID:a", "SUMMARY:Sprint review with the", "  Army team", "DTSTART;TZID=America/New_York:20261027T140000", "DTEND;TZID=America/New_York:20261027T150000", "LOCATION:Room 2\\, HQ",
      "BEGIN:VALARM", "TRIGGER:-PT10M", "END:VALARM"]),
    ev(["UID:b", "SUMMARY:Heidi's field trip", "DTSTART;VALUE=DATE:20261027", "DTEND;VALUE=DATE:20261028"]),
    ev(["UID:c", "SUMMARY:Tomorrow thing", "DTSTART:20261028T130000Z", "DTEND:20261028T140000Z"]),
  );
  const out = eventsOn(parseIcs(ics), day(2026, 10, 27));
  assert.deepEqual(out.map((e) => e.title), ["Heidi's field trip", "Sprint review with the Army team"]);
  assert.equal(out[1].location, "Room 2, HQ");
  assert.equal(out[1].calendar, "Work");
  assert.equal(new Date(out[1].start).getHours(), 14);
});

test("weekly repeats keep their local time across DST, skip EXDATEs and moved dates", () => {
  const base = ["UID:stand", "SUMMARY:Standup", "DTSTART;TZID=America/New_York:20260105T093000", "DTEND;TZID=America/New_York:20260105T094500", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"];
  const ics = cal(
    ev([...base, "EXDATE;TZID=America/New_York:20261030T093000"]),
    ev(["UID:stand", "RECURRENCE-ID;TZID=America/New_York:20261102T093000", "SUMMARY:Standup (moved)", "DTSTART;TZID=America/New_York:20261102T110000", "DTEND;TZID=America/New_York:20261102T111500"]),
  );
  assert.deepEqual(titles(ics, day(2026, 10, 26)), ["Standup"]); // Monday
  assert.deepEqual(titles(ics, day(2026, 10, 27)), []); // Tuesday
  assert.deepEqual(titles(ics, day(2026, 10, 30)), []); // Friday, skipped
  assert.deepEqual(titles(ics, day(2026, 11, 2)), ["Standup (moved)"]); // Monday after DST, moved
  const wed = eventsOn(parseIcs(ics), day(2026, 11, 4))[0];
  assert.equal(new Date(wed.start).getHours(), 9);
  assert.equal(new Date(wed.start).getMinutes(), 30);
});

test("every other week, monthly last Friday, yearly birthdays, COUNT and UNTIL", () => {
  const ics = cal(
    ev(["UID:1", "SUMMARY:Hockey", "DTSTART;TZID=America/New_York:20261004T200000", "DTEND;TZID=America/New_York:20261004T213000", "RRULE:FREQ=WEEKLY;INTERVAL=2"]),
    ev(["UID:2", "SUMMARY:Retro", "DTSTART;TZID=America/New_York:20260130T150000", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=-1FR"]),
    ev(["UID:3", "SUMMARY:Nora's birthday", "DTSTART;VALUE=DATE:20190507", "RRULE:FREQ=YEARLY"]),
    ev(["UID:4", "SUMMARY:PT", "DTSTART;TZID=America/New_York:20261019T070000", "DTEND;TZID=America/New_York:20261019T080000", "RRULE:FREQ=DAILY;COUNT=5"]),
    ev(["UID:5", "SUMMARY:Course", "DTSTART;TZID=America/New_York:20261001T180000", "DTEND;TZID=America/New_York:20261001T190000", "RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261022T220000Z"]),
    ev(["UID:6", "SUMMARY:Cancelled", "STATUS:CANCELLED", "DTSTART;TZID=America/New_York:20261018T080000", "DTEND;TZID=America/New_York:20261018T090000"]),
  );
  assert.deepEqual(titles(ics, day(2026, 10, 18)), ["Hockey"]);
  assert.deepEqual(titles(ics, day(2026, 10, 25)), []);
  assert.deepEqual(titles(ics, day(2026, 10, 30)), ["Retro"]);
  assert.deepEqual(titles(ics, day(2026, 10, 23)), ["PT"]);
  assert.deepEqual(titles(ics, day(2026, 10, 24)), []);
  assert.deepEqual(titles(ics, day(2026, 10, 22)), ["PT", "Course"].sort((a, b) => (a === "PT" ? -1 : 1)));
  assert.deepEqual(titles(ics, day(2026, 10, 29)), []);
  assert.deepEqual(titles(ics, day(2027, 5, 7)), ["Nora's birthday"]);
});

test("Outlook zone names are understood", () => {
  const ics = cal(ev(["UID:o", "SUMMARY:Sync", "DTSTART;TZID=Pacific Standard Time:20261027T090000", "DTEND;TZID=Pacific Standard Time:20261027T093000"]));
  const [e] = eventsOn(parseIcs(ics), day(2026, 10, 27));
  assert.equal(new Date(e.start).toISOString(), "2026-10-27T16:00:00.000Z");
});

import { cleanEventTitle, eventPlace, calLink } from "../src/calendar.js";

test("event titles lose mail prefixes; online meetings are named by service", () => {
  assert.equal(cleanEventTitle("FW: RE: Data Engineering Standup"), "Data Engineering Standup");
  assert.equal(cleanEventTitle("Following: Lunch and Learn"), "Lunch and Learn");
  assert.equal(cleanEventTitle(""), "Busy");
  assert.deepEqual(eventPlace({ location: "Microsoft Teams Meeting" }), { text: "Teams", online: true });
  assert.equal(eventPlace({ location: "", notes: "Join https://zoom.us/j/123" }).text, "Zoom");
  assert.equal(eventPlace({ location: "Little Leaps, 5226 S. College Rd, Wilmington, NC" }).text, "Little Leaps");
  assert.equal(calLink({ notes: "Join: https://teams.microsoft.com/l/meetup-join/abc) more" }), "https://teams.microsoft.com/l/meetup-join/abc");
});

import { freeGaps, barRange } from "../src/calendar.js";

test("free stretches skip overlaps and short gaps", () => {
  const h = 3600e3, d = new Date(2026, 9, 27).getTime();
  const ev = (s, e) => ({ start: d + s * h, end: d + e * h, allDay: false });
  const gaps = freeGaps([ev(12.5, 13), ev(14, 15), ev(14.5, 16), ev(16, 17), ev(19, 20.25)], d + 11.85 * h, d + 21 * h, 45 * 60e3);
  assert.deepEqual(gaps.map((g) => [(g.start - d) / h, (g.end - d) / h]), [[13, 14], [17, 19], [20.25, 21]]);
});

test("the bar spans 7a to 9p unless events run earlier or later", () => {
  const h = 3600e3, d = new Date(2026, 9, 27).getTime();
  assert.deepEqual(barRange([{ start: d + 8 * h, end: d + 9 * h }], d), { from: d + 7 * h, to: d + 21 * h });
  assert.deepEqual(barRange([{ start: d + 5.5 * h, end: d + 6 * h }, { start: d + 21 * h, end: d + 22.25 * h }], d), { from: d + 5 * h, to: d + 23 * h });
});
