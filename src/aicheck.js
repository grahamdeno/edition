/*
 * Checking the AI's writing: a fixed set of realistic emails, and the rules a good post
 * from each one has to meet. The same rules run three ways:
 *   - in the tests, on sample outputs and on the no-AI fallback, before every merge;
 *   - on the phone, as a guard: a post that pastes the email or keeps its clutter is thrown out;
 *   - in Shoebox Me (Settings › AI › Check AI writing), on the real AI, as a scorecard.
 * Everyone and everything in these emails is made up.
 */

export const SAMPLE_EMAILS = [
  {
    id: "flight", subject: "Fwd: Your trip confirmation: WILMINGTON to DENVER", fromName: "Graham",
    text: "Keep this for the trip\n\n---------- Forwarded message ---------\nFrom: Skyway Airlines <noreply@t.skyway.example>\nDate: Tue, Oct 27, 2026 at 9:14 PM\nSubject: Your trip confirmation: WILMINGTON to DENVER\nTo: Graham <g@example.com>\n\nHello Graham,\n\nThank you for choosing Skyway. Your trip is confirmed.\nConfirmation #: HX7Q2P\nFlight SK 2291 Sat, Nov 14 departs ILM 6:05 AM arrives DEN 10:40 AM\nCheck in opens 24 hours before departure.\nManage my trip (https://t.skyway.example/r/?id=h8a7f6e5d4c3b2a1908f7e6d5c4b3a2918f7e6d5c4b3a291)\nUnsubscribe | Privacy Policy\n© 2026 Skyway Airlines, Inc. All rights reserved.",
    links: ["https://t.skyway.example/r/?id=h8a7f6e5d4c3b2a1908f7e6d5c4b3a2918f7e6d5c4b3a291"],
    expect: { mention: [["denver", "den"], ["nov 14", "november 14", "2026-11-14"]], why: true },
  },
  {
    id: "coach", subject: "Fwd: Practice change", fromName: "Graham",
    text: "Begin forwarded message:\n\nFrom: Coach Rivera <coach@club.example>\nSubject: Practice change\nDate: October 27, 2026 at 6:02:11 PM EDT\nTo: U14 Parents <parents@club.example>\n\nHi all,\n\nThursday practice moves to 5:30 PM at Field 3 because of the lights. Bring water and shin guards. Saturday's game is still at 9 AM.\n\nThanks,\nCoach Rivera\n\nSent from my iPhone",
    links: [],
    expect: { mention: [["5:30"], ["field 3"]] },
  },
  {
    id: "outlook", subject: "FW: Q4 offsite agenda", fromName: "Graham",
    text: "Need to book a hotel for this.\n\n-----Original Message-----\nFrom: Dana Ortiz <dana@work.example>\nSent: Monday, October 26, 2026 4:15 PM\nTo: Team <team@work.example>\nSubject: Q4 offsite agenda\n\nTeam,\n\nThe Q4 offsite is Dec 3-4 in Raleigh. Day one is planning, day two is the roadmap review. Please book travel by Nov 13 and send dietary needs to me.\n\nDana\n\nCONFIDENTIALITY NOTICE: This email and any attachments are for the sole use of the intended recipient.",
    links: [],
    expect: { mention: [["raleigh"], ["dec 3", "december 3", "2026-12-03"]], why: true },
  },
  {
    id: "newsletter", subject: "The Weekly Fix #212: Why your sourdough is flat", fromName: "The Weekly Fix",
    text: "View this email in your browser (https://weeklyfix.example/v/212)\n\nThe Weekly Fix\nIssue #212\n\nWhy your sourdough is flat\nMost flat loaves come from an underactive starter, not your shaping. Feed it twice a day for three days and use it at its peak, when it has doubled and smells sweet. A cooler fridge proof (12 to 16 hours) also gives the loaf more lift.\n\nRead the full piece (https://weeklyfix.example/c/AbC123?utm_source=email&utm_medium=newsletter)\n\nAlso this week: the best cheap Dutch ovens, tested.\n\nYou're receiving this because you subscribed. Unsubscribe (https://weeklyfix.example/u/xyz) | Update preferences",
    links: ["https://weeklyfix.example/v/212", "https://weeklyfix.example/c/AbC123?utm_source=email&utm_medium=newsletter", "https://weeklyfix.example/u/xyz"],
    expect: { mention: [["starter"]], link: "https://weeklyfix.example/c/AbC123?utm_source=email&utm_medium=newsletter" },
  },
  {
    id: "receipt", subject: "Your order #10-4482-1193 has shipped", fromName: "Hearth Goods",
    text: "Hi Graham,\n\nGood news! Your order has shipped.\n\nOrder #10-4482-1193\nCast iron skillet, 12 in. x1 $39.99\nShipping: Free\nTotal: $39.99\n\nEstimated delivery: Friday, October 30\nTrack your package (https://track.hearth.example/p/88213)\n\nQuestions? Reply to this email.\n\nHearth Goods, 100 Main St, Springfield\nUnsubscribe",
    links: ["https://track.hearth.example/p/88213"],
    expect: { mention: [["skillet"], ["oct 30", "october 30", "2026-10-30", "friday"]], link: "https://track.hearth.example/p/88213" },
  },
  {
    id: "dentist", subject: "Appointment reminder", fromName: "Seaside Dental",
    text: "Dear Graham,\n\nThis is a reminder of your appointment with Dr. Patel on Tuesday, November 3, 2026 at 8:40 AM.\n\nPlease arrive 10 minutes early. To reschedule, call 555-0142 at least 24 hours ahead.\n\nSeaside Dental\n\nThis is an automated message. Please do not reply.",
    links: [],
    expect: { mention: [["nov 3", "november 3", "2026-11-03"], ["8:40"]] },
  },
  {
    id: "pta", subject: "Fall Festival volunteers needed", fromName: "Pine Hollow PTA",
    text: "Hello families!\n\nOur Fall Festival is Saturday, November 7 from 10 AM to 2 PM on the school field. We need volunteers for the bake sale and the ring toss. Sign up by Wednesday, November 4 here: https://signup.example/pta-fall\n\nTickets are $1 each or 25 for $20.\n\nThank you for all you do!\nPine Hollow PTA\n\nFollow us on Facebook | Instagram",
    links: ["https://signup.example/pta-fall"],
    expect: { mention: [["nov 7", "november 7", "2026-11-07", "saturday"]], link: "https://signup.example/pta-fall" },
  },
  {
    id: "bill", subject: "Your statement is ready", fromName: "Coastal Power",
    text: "Your October statement is ready.\n\nAmount due: $142.18\nDue date: November 12, 2026\nAccount ending in 4471\n\nView and pay your bill (https://pay.coastal.example/bill?acct=xx4471&src=em)\n\nAutopay is off for this account.\n\nCoastal Power | Privacy | Unsubscribe from marketing",
    links: ["https://pay.coastal.example/bill?acct=xx4471&src=em"],
    expect: { mention: [["142.18"], ["nov 12", "november 12", "2026-11-12"]] },
  },
  {
    id: "recipe", subject: "Fwd: that chili recipe", fromName: "Graham",
    text: "Make this Sunday\n\n---------- Forwarded message ---------\nFrom: Sam <sam@example.com>\nDate: Sun, Oct 25, 2026\nSubject: that chili recipe\n\nHere it is! Brown 2 lb ground beef with an onion, add 2 cans of beans, a can of crushed tomatoes, 3 tbsp chili powder and a spoon of cocoa. Simmer an hour. The cocoa is the secret.\n\nSam",
    links: [],
    expect: { mention: [["chili"], ["cocoa"]], why: true },
  },
  {
    id: "promo", subject: "48 HOURS ONLY: 40% off everything 🔥", fromName: "TrailPeak",
    text: "Don't miss out!\n\n40% OFF SITEWIDE\nUse code FALL40 at checkout. Ends Friday at midnight.\n\nShop now (https://trailpeak.example/sale?utm_campaign=fall40)\n\nFree shipping on orders over $50.\n\nTrailPeak Outfitters | Unsubscribe | View in browser",
    links: ["https://trailpeak.example/sale?utm_campaign=fall40"],
    expect: { mention: [["fall40", "40%"]] },
  },
  {
    id: "selfnote", subject: "idea", fromName: "Graham",
    text: "Weekend project: build a shelf for the garage out of the leftover 2x10s. Measure the wall first.",
    links: [],
    expect: { mention: [["shelf"]] },
  },
  {
    id: "linkonly", subject: "read later", fromName: "Graham",
    text: "https://essays.example/the-long-way-home\n\nSent from my iPhone",
    links: ["https://essays.example/the-long-way-home"],
    expect: { link: "https://essays.example/the-long-way-home" },
  },
  {
    id: "invite", subject: "Invitation: Roadmap review @ Thu Nov 5, 2026 2pm - 3pm (EST)", fromName: "Dana Ortiz",
    text: "You have been invited to the following event.\n\nRoadmap review\nWhen: Thursday Nov 5, 2026 2pm – 3pm Eastern Time\nWhere: Conference Room B / https://meet.example/abc-defg-hij\nWho: Dana Ortiz (organizer), Graham, Lee Chen\n\nPlease bring the Q1 priorities draft.\n\nGoing? Yes - Maybe - No\nInvitation from Calendar. You are receiving this email because you are an attendee of the event.",
    links: ["https://meet.example/abc-defg-hij"],
    expect: { mention: [["nov 5", "november 5", "2026-11-05", "thursday"], ["q1"]] },
  },
  {
    id: "package", subject: "Delivered: your package", fromName: "Parcel Express",
    text: "Your package was delivered.\n\nDelivered Tuesday, October 27 at 3:12 PM\nLeft at: Front door\nTracking number: 1Z999AA10123456784\n\nSee delivery photo (https://px.example/t/1Z999AA10123456784)\n\nParcel Express\nManage delivery preferences",
    links: ["https://px.example/t/1Z999AA10123456784"],
    expect: { mention: [["front door", "delivered"]] },
  },
  {
    id: "reply", subject: "Re: Saturday", fromName: "Lee Chen",
    text: "Works for me. I'll bring the cooler and the chairs, you grab ice.\n\nOn Tue, Oct 27, 2026 at 8:01 PM Graham <g@example.com> wrote:\n> Beach Saturday around 10? I'll get there early for a spot.\n> \n> G",
    links: [],
    expect: { mention: [["cooler", "chairs", "ice"]] },
  },
  {
    id: "school", subject: "Pine Hollow Weekly: Nov 2", fromName: "Pine Hollow Middle",
    text: "Pine Hollow Middle School Weekly Update\n\nDear Pine Hollow Families,\n\nReport cards go home Thursday, November 5. Picture retakes are Monday, November 9; bring your order form. The band winter concert is December 10 at 7 PM in the gym.\n\nHave a great week!\nPrincipal Morgan\n\nPine Hollow Middle School | 200 School Rd\nYou are receiving this message from the school district.",
    links: [],
    expect: { mention: [["report card", "nov 5", "november 5"]] },
  },
];

const words = (s) => String(s || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").match(/[a-z0-9$#.:%'-]+/g) || [];

/** The longest run of words the post copies straight out of the email. */
export function longestCopy(source, out) {
  const a = words(source), b = words(out);
  if (!a.length || !b.length) return 0;
  const at = new Map();
  a.forEach((w, i) => { if (!at.has(w)) at.set(w, []); at.get(w).push(i); });
  let best = 0;
  for (let j = 0; j < b.length; j++) {
    for (const i of at.get(b[j]) || []) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

const NOISE = [
  [/^(hi|hello|hey|dear|greetings)\b/i, "starts with a greeting"],
  [/\bunsubscribe\b|\bview (this email )?in (your )?browser\b|\bmanage (delivery |email )?preferences\b/i, "keeps a footer line"],
  [/\bsent from my (iphone|ipad)\b/i, "keeps a signature"],
  [/\b(forwarded message|original message)\b|^(from|to|subject|date|sent):/im, "keeps forwarding headers"],
  [/https?:\/\//i, "has a raw link in the words"],
  [/\bthis email\b/i, "says \"this email\""],
];

/**
 * Grade one post written from one email. Returns the problems found ([] is a pass).
 * hard: only the problems bad enough to throw the post out on the phone.
 */
export function gradeEmailPost(email, post, { hard = false } = {}) {
  const out = [];
  if (!post || (!post.headline && !post.body)) return ["no post"];
  const said = [post.headline, post.body, ...(post.items || []).map((i) => i.text)].filter(Boolean).join("\n");
  for (const [re, why] of NOISE) if (re.test(post.headline || "") || re.test(post.body || "")) out.push(why);
  const copied = longestCopy(email.text, post.body || "");
  if (copied >= 18) out.push(`pastes the email (${copied} words in a row)`);
  if (hard) return out;
  if (!post.headline) out.push("no headline");
  else {
    if (post.headline.length > 70) out.push(`headline too long (${post.headline.length})`);
    if (/^\s*(fwd?|fw|re)\s*:/i.test(post.headline)) out.push("headline keeps Fwd:/Re:");
  }
  if (!post.body) out.push("no body");
  else {
    if (post.body.length > 280) out.push(`body too long (${post.body.length})`);
    const sentences = post.body.split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;
    if (sentences > 3) out.push(`body runs ${sentences} sentences`);
  }
  // Numbers the post states must be in the email (a date's day, an amount, a time, a code).
  const src = `${email.subject}\n${email.text}`.toLowerCase();
  for (const n of new Set(said.match(/\d+(?:[.:]\d+)?/g) || [])) {
    if (!src.includes(n.toLowerCase())) out.push(`states ${n}, which isn't in the email`);
  }
  for (const i of post.items || []) {
    if (i.date && !src.includes(String(+i.date.slice(8, 10)))) out.push(`dates an item ${i.date}, not in the email`);
  }
  const e = email.expect || {};
  const lower = said.toLowerCase() + "\n" + (post.items || []).map((i) => i.date || "").join(" ");
  for (const any of e.mention || []) if (!any.some((t) => lower.includes(t))) out.push(`misses ${any[0]}`);
  if (e.link && post.link !== e.link) out.push(post.link ? "picks the wrong link" : "leaves out the link");
  if (post.link && !(email.links || []).includes(post.link)) out.push("invents a link");
  if (e.why && !post.why) out.push("drops the note above the forward");
  return out;
}
