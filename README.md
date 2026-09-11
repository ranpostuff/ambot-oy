# RescuePriority — Student Incident Reporter

A small, separate, **phone-only** web app for students to report an incident
straight to the RescuePriority Command Center. It's a static site (no build
step) that talks to the **same Firebase Realtime Database** as the main
RescuePriority dashboard — just deploy it at its own URL (or QR-code it) and
it plugs straight in. It's locked to a phone-width layout on purpose (see
"Phone-only, on purpose" below) — it isn't meant to be used on a laptop.

## How it works

1. **Log in** with your **LRN and password** (set for you on the admin
   dashboard — see "Logging in" below). This identifies you once per
   device; you stay logged in (see "Staying signed in") until you tap
   **Log Out**.
2. From Home, **Report an Incident** → one screen handles everything:
   **Just Me** vs **Everyone Here**, the specific incident type, exactly
   where it's happening (see "Campus map location" below), and an optional
   note. Or, for something too urgent for that: **Report Major Threat** →
   pick a room on the map and it sends immediately, no type picker, no
   notes.
3. Tapping **Send Report** arms a short (3-second), visibly-countable,
   cancellable window — tap again to cancel, or let it run out and it
   sends. There is no separate "Are you sure?" screen to navigate to;
   reporting a real emergency should take as few steps as possible.
   (Major Threat skips the countdown too — it sends the instant you pick a
   room.)
4. That write is picked up live by the main dashboard's Campus Map (the
   room glows red, same as any other emergency) and, in the room modal, a
   "Reported by" banner shows who sent the report — tapping it opens their
   photo, LRN, adviser, and parent contact in its own panel. This is
   whoever's logged in, **every time**, "Just Me" or "Everyone Here"
   alike — it's no longer hidden for room-wide reports the way it used to
   be when identification was scan-per-report instead of login-once.

## Logging in

Students sign in with their **LRN + a password** — there's no email/signup
here. A student's password is set on the main dashboard: **Students ->
Edit Student -> "Student Web App Password."** Leaving that field blank
when editing keeps whatever password (if any) they already have; leaving
it blank on a brand-new student means they simply can't log in yet until
someone sets one. An LRN that either isn't typed in or isn't on file
(`studentLogins/{lrn}` doesn't exist) is rejected before anything else is
checked — see `attemptLogin()` in `app.js`.

This replaced the old "scan your ID / type your LRN" step that used to run
**per report**. Logging in *is* identifying yourself now, once per device,
not once per report — see "What changed" below if you're comparing this
against an older version of this app.

## Staying signed in

After a successful login, the student's ID (not their password) is cached
in the browser's `localStorage` so they don't have to type LRN+password
every time they need to report something fast. There's a **Log Out**
button on the Home screen for shared/school-issued devices where that's
not appropriate — logging out clears the cached session and returns to the
login screen.

## Campus map location

The room implied by a student's **homeroom** isn't necessarily where an
incident is actually happening — a fall in the hallway, something in the
canteen, a fight in someone else's classroom, etc. The report screen
always shows a "Reporting from" row defaulting to the homeroom's linked
room, with a **Change** button that opens a full-screen campus map (grouped
by wing/building, same zones as the main dashboard, with search) so the
student can pick the real location before sending. Picking a different
room is never blocked or "corrected" back to the homeroom. This picker's
data lives in `facilities.js` — a standalone copy of the main dashboard's
room list (same convention as the Firebase config duplication below); keep
it in sync if rooms are added/renamed/removed on the main dashboard.

## Firebase reads/writes

- **Reads** a single `studentLogins/{lrn}` entry at login time (to check
  the password), then `students/{studentId}` and `sections/` — to show a
  name/photo/section on the report screen and to remember the student's
  homeroom-linked facility (used only as the map's default).
- **Writes** `incidents/{pushKey}` — a new permanent incident record, same
  shape the dashboard's own "Trigger Test Alert" creates, plus a few extra
  fields:
  - `reporterId` / `reporterName` / `reporterLrn` — **always** set, from
    whoever is logged in. This is "who reported it."
  - `studentId` / `studentName` — who the incident **concerns**: same
    person as the reporter for a "Just Me" report, `null` for an
    "Everyone Here"/Major Threat one (nobody specific is singled out).
    Kept for back-compat with older dashboard code that only ever read
    these two fields.
  - `incidentType`, `roomWide`, `description`, `reportedVia:
    "student-app"`, `facilityId` (the room the student actually picked on
    the map), `locationOverridden` (true if that differs from their
    homeroom's room).
- **Writes** `classrooms/{facilityId}` — sets `emergency: true` and
  `activeIncidentKey` so the Campus Map lights up, using the **picked**
  location, *only if that room isn't already mid-emergency* (a second
  report during an active emergency still gets logged in `incidents/`, it
  just won't replace which incident the room card points to — see
  `submitIncidentReport()` in `app.js` if you want to change that
  behavior).

It never writes to `students/`, `sections/`, `studentLogins/`,
`violations/`, or anything else the admin dashboard owns beyond the atomic
`counters/lastIncidentNumber` transaction (same one the dashboard uses, so
incident numbers stay sequential across both apps).

## Phone-only, on purpose

This is meant to be opened on a student's phone (bookmarked, or reached via
a QR code posted in each room) — not used side-by-side with the dashboard
on a laptop. The layout is hard-capped to a phone width (`max-width: 430px`
on the shell and the map overlay) with pinch-zoom disabled and safe-area
padding for notches/home indicators. On a wider screen it just centers with
a plain gutter around it — that's expected, not a bug to fix.

## Setup / deployment

1. Host these four files (`index.html`, `app.js`, `style.css`,
   `facilities.js`) anywhere static (Firebase Hosting, GitHub Pages,
   Netlify, a school subdomain). No build step, no npm install.
2. **Set student passwords first** — nobody can log in until the admin
   dashboard has set at least one student's "Student Web App Password."
3. **Security rules**: deploy `database.rules.json` (the same file the
   main dashboard uses — see its `RULES-NOTES.md`). It scopes a login
   check to the single `studentLogins/{lrn}` entry a student already knows
   (their own LRN), not the whole list, and reads of `students/`/
   `sections/` are still open client-side (needed for the name/photo/
   section lookup) — see the "What this still does *not* do" section of
   that file for the honest limitation and what a fuller fix looks like
   (a Cloud Function instead of a direct client read).
4. Put the URL behind a QR code posted in each classroom, or bookmark it
   on school-issued devices, so reporting is as close to one tap as
   possible.

## What's intentionally left out (per the spec this was built from)

- No physical panic button / hardware trigger — that's a separate,
  later piece.
- No self-serve signup — a student's password is set for them by an admin
  on the dashboard, not chosen by the student. There's also no "forgot
  password" flow; resetting one means an admin sets a new one the same way.
- No offline queueing — if the device has no connection, the report
  won't send. Worth adding before a real deployment (e.g. a service
  worker retry queue).

## What changed from the scan-based version

Earlier versions of this app had students scan their own ID QR code (or
type their LRN with no password) **immediately before each report**, and
had no login at all — the dashboard's "reported student" panel was also
hidden for "Everyone Here" reports since a room-wide report wasn't
considered to be "about" any one student. Both of those changed:
identification moved to a one-time LRN+password login per device, and the
dashboard now shows who *reported* something separately from who it
*concerns* — see "How it works" above. The camera-based QR scanning and
its `html5-qrcode` dependency were removed along with the old per-report
scan screen.
