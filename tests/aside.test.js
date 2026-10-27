import { test } from "node:test";
import assert from "node:assert/strict";
import { STATUS, setAside, wakeAside, bringBackNow, asideChoices, fromDateInput, toDateInput, startOfDay, reminderIcs, buildEdition, counts } from "../src/model.js";

const mon = new Date(2026, 9, 26, 21, 0).getTime(); // Monday evening

test("quick choices are future days with no repeats", () => {
  const c = asideChoices(mon);
  assert.deepEqual(c.map((x) => x.label), ["Tomorrow", "This weekend", "Next week", "In a month"]);
  assert.equal(toDateInput(c[0].until), "2026-10-27");
  assert.equal(toDateInput(c[1].until), "2026-10-31");
  assert.equal(toDateInput(c[2].until), "2026-11-02");
  assert.equal(toDateInput(c[3].until), "2026-11-26");
  const sun = new Date(2026, 10, 1, 9).getTime(); // Sunday: next week is tomorrow, so it's dropped
  assert.deepEqual(asideChoices(sun).map((x) => x.label), ["Tomorrow", "This weekend", "In a month"]);
});

test("date fields round-trip as local midnight", () => {
  assert.equal(fromDateInput("2026-11-03"), new Date(2026, 10, 3).getTime());
  assert.equal(fromDateInput(""), null);
  assert.equal(toDateInput(fromDateInput("2027-01-25")), "2027-01-25");
});

test("set aside hides an item until its day, then it comes back as new", () => {
  const item = { id: "a", status: STATUS.QUEUED, created: mon - 1e8, tags: [] };
  const until = fromDateInput("2026-11-03");
  const aside = setAside(item, until + 5000, mon);
  assert.equal(aside.status, STATUS.ASIDE);
  assert.equal(aside.until, until);
  assert.deepEqual(buildEdition([aside], null, { now: mon }).ids, []);
  assert.deepEqual(wakeAside([aside], until - 1), []);
  const [back] = wakeAside([aside], until + 1);
  assert.equal(back.status, STATUS.INBOX);
  assert.equal(back.backAt, until);
  assert.equal(back.until, undefined);
  assert.equal(counts([aside]).aside, 1);
  assert.equal(bringBackNow(aside, mon).status, STATUS.INBOX);
  assert.equal(startOfDay(until + 3600e3), until);
});

test("the reminder is a 9:00 event with an alert on that day", () => {
  const ics = reminderIcs({ title: "Pottery class, downtown", why: "Date idea", until: fromDateInput("2026-11-03"), appUrl: "https://grahamdeno.github.io/edition/", now: mon });
  assert.match(ics, /DTSTART:20261103T090000/);
  assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:PT0M/);
  assert.match(ics, /SUMMARY:Back in Shoebox: Pottery class\\, downtown/);
  assert.ok(ics.split("\r\n").every((l) => l.length <= 75));
});
