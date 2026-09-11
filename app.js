/* ==========================================================================
   RESCUEPRIORITY — STUDENT INCIDENT REPORTER
   --------------------------------------------------------------------------
   Standalone mobile-first web app, separate deployment from the main
   RescuePriority dashboard, but pointed at the SAME Firebase Realtime
   Database. It only READS students/ and sections/ (to identify the
   reporting student) and only WRITES to incidents/ and
   classrooms/{facilityId} — the exact same two paths the main dashboard's
   "Trigger Test Alert" button writes to (see script.js in the main
   project), so a report from this app lights up the Campus Map exactly
   like any other emergency. It also READS a single studentLogins/{lrn}
   entry at sign-in time (see LOGIN below) and nothing else.

   LOGIN: students sign in with their LRN + a password set for them on the
   admin dashboard (Students -> Edit Student -> "Student Web App Password").
   Login identifies the REPORTER once per device (the session is remembered
   in localStorage until Log Out is pressed). Per-report QR/manual LRN
   identification is separately available for the STUDENT INVOLVED, so
   scanning another student's card never changes the reporting account. An LRN with no password set on file, or
   the wrong password, can't get in — see attemptLogin() below. This is the
   same SHA-256-via-Web-Crypto hash the admin dashboard's students.js uses
   when it sets a student's password, duplicated here rather than shared
   (same convention as the duplicated firebaseConfig below); see this
   project's RULES-NOTES.md for the caveat that this is a client-side hash,
   not a substitute for a real backend with salted/bcrypt-style hashing.

   Extra fields added onto the incidents/{pushKey} record, on top of the
   dashboard's existing shape (incidentNumber, timestamp, classroom,
   status, resolvedAt):
       reporterId         : string   (the logged-in student's key in
                                       students/ — always set, "Just Me" or
                                       "Everyone Here" alike, since login
                                       identifies whoever sent the report)
       reporterName       : string   (denormalized for display even if the
                                       student record is later edited/removed)
       reporterLrn        : string   (denormalized LRN)
       studentId          : string | null (who the incident CONCERNS — same
                                       as reporterId for an individual "Just
                                       Me" report, null for a room-wide
                                       "Everyone Here"/Major Threat one,
                                       since nobody specific is singled out.
                                       Kept for back-compat with dashboard
                                       code that reads it; reporterId/Name/
                                       Lrn are what to use if you just want
                                       "who sent this report".)
       studentName        : string | null (denormalized, paired with studentId)
       incidentType       : string   ("Headache", "Fire", "Fight", ...)
       roomWide           : boolean  (true = whole-area report, false = one student)
       description        : string | null (optional free-text notes)
       reportedVia        : "student-app"
       facilityId         : string | null (the ACTUAL place the student picked
                                            on the map — see below)
       locationOverridden : boolean  (true if the student changed the location
                                       away from the room their homeroom
                                       implied — real incidents don't always
                                       happen at your assigned seat, so this
                                       is never forced to match it)

   SECURITY NOTE: this app can only do what your Firebase Realtime Database
   security rules allow. Reading students/sections is still a client-side
   lookup (needed to show name/photo/section on the report screen and in
   the admin dashboard's reporter panel) — for a real deployment you may
   still want to move that behind a Cloud Function that returns only what's
   needed. The studentLogins/{lrn} password check, at least, is no longer
   wide open: see database.rules.json — a client can only read the single
   LRN entry it already knows (its own), not browse the whole list, and
   only an authenticated admin account can write one.
========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    getDatabase,
    ref,
    get,
    push,
    set,
    update,
    runTransaction,
    onValue
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { SCHOOL_FACILITIES, ZONE_ORDER, displayFacilityName, findFacility } from "./facilities.js";
import { triggerIncidentAlert } from "./notify-incident.js";

/* Same public client config used throughout the main RescuePriority app —
   this is a Firebase Web SDK config (not a secret; access is governed by
   Firebase security rules), duplicated here so this app has zero
   dependency on the main dashboard's codebase. */
const firebaseConfig = {
    apiKey: "AIzaSyDHPzeyaEtVvEvnH1Va81i24tpiCX8Gx-8",
    authDomain: "school-alert-system-8f211.firebaseapp.com",
    databaseURL: "https://school-alert-system-8f211-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "school-alert-system-8f211",
    storageBucket: "school-alert-system-8f211.firebasestorage.app",
    messagingSenderId: "568204675808",
    appId: "1:568204675808:web:1ca3536d31b7dc5db45e85",
    measurementId: "G-JT58NQCRMQ"
};

const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

const sectionsRootRef = ref(database, "sections");
const incidentsRootRef = ref(database, "incidents");
const lastIncidentNumberRef = ref(database, "counters/lastIncidentNumber");

const SESSION_STORAGE_KEY = "rp-student-session"; // localStorage: { studentId, lrn }

/* ==========================================================================
   STATE
========================================================================== */
// The logged-in identity — set once at login (or restored from
// localStorage), cleared on logout. This is who's REPORTING, always,
// regardless of "Just Me" vs "Everyone Here" (see submitIncidentReport()).
let loggedInStudentId = null;
let loggedInStudent = null;
let loggedInSection = null;
let loggedInLrn = null;

let homeFacilityId = null;      // the room implied by the logged-in student's homeroom (may be null)
let selectedFacilityId = null;  // the room actually picked for THIS report — defaults to homeFacilityId
let locationOverridden = false; // true once the student changes it away from the home room
let mapFullscreen = false;      // true while the campus map picker is expanded to full screen

let reportRoomWide = false;     // false = "Just Me", true = "Everyone Here"
let reportType = null;

// The student the incident concerns is deliberately separate from the
// logged-in reporter. By default an individual report concerns the reporter;
// QR/manual LRN can select another student without changing the login session.
let involvedStudentId = null;
let involvedStudent = null;
let involvedSection = null;
let involvedIdentificationMethod = "logged-in-account";
let html5QrInstance = null;
let qrCameraRunning = false;

// true only while the student is going through the "Report Major Threat"
// shortcut: no type picker, no notes — just pick a room on the map and it
// submits immediately as a room-wide report. Reporter identity is still
// attached (they're logged in), same as any other report — only the extra
// screens are skipped, for speed.
let majorThreatMode = false;

const ARM_SECONDS = 3; // how long the Send button stays cancellable before it actually fires
let armTimer = null;
let armInterval = null;
let armRemaining = ARM_SECONDS;

/* ==========================================================================
   SCREEN NAVIGATION
========================================================================== */
function showScreen(id) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("active", el.id === id));
    if (id !== "screen-report") {
        cancelArmedSend();
        stopQrCamera();
    }
}

function setupBackButtons() {
    document.querySelectorAll("[data-back-to]").forEach((btn) => {
        btn.addEventListener("click", () => showScreen(btn.dataset.backTo));
    });
}

document.addEventListener("DOMContentLoaded", () => {
    setupBackButtons();
    setupLoginScreen();
    setupHomeButton();
    setupLogoutButton();
    setupMajorThreatButton();
    setupReportScreen();
    setupMapOverlay();
    setupSuccessScreen();
    setupInvolvedStudentIdentification();
    setupHistoryScreens();
    restoreSession();
});

/* ==========================================================================
   LOGIN — LRN + password, checked against studentLogins/{lrn} (set on the
   admin dashboard). Login establishes reporter accountability; QR/manual
   LRN identification later in the report identifies the student involved.
========================================================================== */
async function hashPassword(rawPassword) {
    const bytes = new TextEncoder().encode(rawPassword);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function setupLoginScreen() {
    const form = document.getElementById("login-form");
    if (!form) return;

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const lrnInput = document.getElementById("login-lrn");
        const passwordInput = document.getElementById("login-password");
        const lrn = lrnInput ? lrnInput.value.trim() : "";
        const password = passwordInput ? passwordInput.value : "";
        if (!lrn || !password) return;
        attemptLogin(lrn, password);
    });
}

async function attemptLogin(lrn, password) {
    const submitBtn = document.getElementById("btn-login-submit");
    hideLoginError();
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Signing In\u2026";
    }

    try {
        const loginSnapshot = await get(ref(database, `studentLogins/${lrn}`));
        if (!loginSnapshot.exists()) {
            showLoginError(`LRN ${lrn} isn't set up for this app yet. Ask your adviser or the admin office.`);
            return;
        }

        const { studentId, passwordHash } = loginSnapshot.val();
        const typedHash = await hashPassword(password);
        if (typedHash !== passwordHash) {
            showLoginError("Incorrect password. Try again, or ask your adviser to reset it.");
            return;
        }

        const studentSnapshot = await get(ref(database, `students/${studentId}`));
        if (!studentSnapshot.exists()) {
            showLoginError("Your login is on file, but your student record wasn't found. Contact the admin office.");
            return;
        }

        await applyLoggedInIdentity(studentId, studentSnapshot.val(), lrn);
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ studentId, lrn }));

        const passwordInput = document.getElementById("login-password");
        if (passwordInput) passwordInput.value = "";

        showScreen("screen-home");
    } catch (error) {
        console.error("Login failed:", error);
        showLoginError("Couldn't reach the server. Check your connection and try again.");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Log In";
        }
    }
}

/* Tries to silently resume a previous session (studentId + lrn only — never
   the password — cached in localStorage after a successful login) so a
   student doesn't have to re-type their password every time they open the
   app on their own phone. Falls back to the login screen if nothing's
   cached, or if the cached student/login no longer checks out (removed
   roster entry, revoked login, etc.). There's a "Log Out" button on the
   home screen for anyone who doesn't want this on a shared device. */
async function restoreSession() {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
        showScreen("screen-login");
        return;
    }

    try {
        const { studentId, lrn } = JSON.parse(raw);
        const [studentSnapshot, loginSnapshot] = await Promise.all([
            get(ref(database, `students/${studentId}`)),
            get(ref(database, `studentLogins/${lrn}`))
        ]);

        if (!studentSnapshot.exists() || !loginSnapshot.exists() || loginSnapshot.val().studentId !== studentId) {
            localStorage.removeItem(SESSION_STORAGE_KEY);
            showScreen("screen-login");
            return;
        }

        await applyLoggedInIdentity(studentId, studentSnapshot.val(), lrn);
        showScreen("screen-home");
    } catch (error) {
        console.error("Couldn't restore session:", error);
        showScreen("screen-login");
    }
}

async function applyLoggedInIdentity(studentId, student, lrn) {
    loggedInStudentId = studentId;
    loggedInStudent = student;
    loggedInLrn = lrn;

    const sectionsSnapshot = await get(sectionsRootRef);
    const sections = sectionsSnapshot.val() || {};
    loggedInSection = student.sectionId ? sections[student.sectionId] || null : null;

    homeFacilityId = (loggedInSection && loggedInSection.facilityId) || student.facilityId || null;

    const nameEl = document.getElementById("home-logged-in-as");
    if (nameEl) {
        const firstName = student.firstName || "";
        nameEl.textContent = firstName ? ` (${firstName})` : "";
    }
}

function setupLogoutButton() {
    const btn = document.getElementById("btn-logout");
    if (btn) btn.addEventListener("click", logout);
}

function logout() {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    loggedInStudentId = null;
    loggedInStudent = null;
    loggedInSection = null;
    loggedInLrn = null;
    homeFacilityId = null;

    const loginForm = document.getElementById("login-form");
    if (loginForm) loginForm.reset();
    hideLoginError();

    showScreen("screen-login");
}

function showLoginError(message) {
    const el = document.getElementById("login-error");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("hidden");
}

function hideLoginError() {
    const el = document.getElementById("login-error");
    if (el) el.classList.add("hidden");
}

/* ==========================================================================
   HOME
========================================================================== */
function setupHomeButton() {
    const btn = document.getElementById("btn-start-report");
    if (btn) {
        btn.addEventListener("click", () => {
            resetReportState();
            populateReportScreen();
            showScreen("screen-report");
        });
    }
}

function resetReportState() {
    selectedFacilityId = homeFacilityId;
    locationOverridden = false;

    reportRoomWide = false;
    reportType = null;
    majorThreatMode = false;
    setInvolvedStudent(loggedInStudentId, loggedInStudent, loggedInSection, "logged-in-account");
    cancelArmedSend();

    document.getElementById("report-notes").value = "";
    document.querySelectorAll(".notes-disclosure").forEach((d) => (d.open = false));

    document.querySelectorAll(".type-chip").forEach((chip) => chip.classList.remove("selected"));
    document.getElementById("report-summary").classList.add("hidden");

    // Reset scope segmented control back to "Just Me"
    document.querySelectorAll(".segmented-btn").forEach((b) => b.classList.toggle("active", b.dataset.scope === "individual"));
    document.getElementById("individual-type-grid").classList.remove("hidden");
    document.getElementById("roomwide-type-grid").classList.add("hidden");
    document.getElementById("scope-hint").textContent = "A personal emergency \u2014 headache, injury, panic attack, etc.";

    updateSendButtonState();
}

/* ==========================================================================
   MAJOR THREAT SHORTCUT — lives on the home screen. Bypasses the type
   picker and notes entirely: tapping it opens the campus map straight
   away, and picking a room immediately submits a room-wide report for
   that room (see pickFacility() and sendMajorThreatReport() below).
   Reporter identity (whoever is logged in) is still attached — only the
   extra screens are skipped, for speed.
========================================================================== */
function setupMajorThreatButton() {
    const btn = document.getElementById("btn-major-threat");
    if (btn) {
        btn.addEventListener("click", startMajorThreatReport);
    }
}

function startMajorThreatReport() {
    resetReportState();
    majorThreatMode = true;
    reportRoomWide = true;
    reportType = "Major Threat";
    openMapOverlay();
}

/* ==========================================================================
   STUDENT INVOLVED — QR / MANUAL LRN
========================================================================== */
function studentFullName(student) {
    if (!student) return "";
    return [student.firstName, student.middleName, student.lastName, student.extension]
        .filter((v) => v && String(v).trim()).join(" ");
}

function sectionDisplayName(section) {
    return section ? [section.gradeName, section.name].filter(Boolean).join(" – ") : null;
}

function setInvolvedStudent(studentId, student, section, method) {
    involvedStudentId = studentId || null;
    involvedStudent = student || null;
    involvedSection = section || null;
    involvedIdentificationMethod = method || null;
    renderInvolvedStudent();
    updateSendButtonState();
}

function renderInvolvedStudent() {
    const el = document.getElementById("involved-student-selected");
    if (!el) return;
    if (!involvedStudent) {
        el.innerHTML = '<strong>No student selected</strong><span>Scan a QR code or enter an LRN.</span>';
        return;
    }
    const method = involvedIdentificationMethod === "qr" ? "QR code" : involvedIdentificationMethod === "manual-lrn" ? "Manual LRN" : "Logged-in account";
    el.innerHTML = `<strong>${escapeHtml(studentFullName(involvedStudent) || "Student")}</strong>
        <span>${escapeHtml(sectionDisplayName(involvedSection) || "Section not on file")} · LRN ${escapeHtml(involvedStudent.lrn || loggedInLrn || "--")}</span>
        <small>Identified via ${method}</small>`;
}

function setupInvolvedStudentIdentification() {
    const useReporter = document.getElementById("btn-use-reporter");
    const qrToggle = document.getElementById("btn-open-qr");
    const startQr = document.getElementById("btn-start-qr");
    const stopQr = document.getElementById("btn-stop-qr");
    const form = document.getElementById("manual-lrn-form");

    if (useReporter) useReporter.addEventListener("click", () => setInvolvedStudent(loggedInStudentId, loggedInStudent, loggedInSection, "logged-in-account"));
    if (qrToggle) qrToggle.addEventListener("click", () => document.getElementById("qr-scanner-panel")?.classList.toggle("hidden"));
    if (startQr) startQr.addEventListener("click", startQrCamera);
    if (stopQr) stopQr.addEventListener("click", stopQrCamera);
    if (form) form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = document.getElementById("manual-lrn-input");
        const lrn = input ? input.value.trim() : "";
        if (lrn) await identifyStudentByLrn(lrn, "manual-lrn");
    });
}

async function identifyStudentByLrn(lrn, method) {
    const feedback = document.getElementById("involved-student-feedback");
    if (feedback) { feedback.textContent = "Looking up student…"; feedback.classList.remove("hidden", "is-error", "is-success"); }
    try {
        const studentsSnap = await get(ref(database, "students"));
        const students = studentsSnap.val() || {};
        const match = Object.entries(students).find(([, student]) => String(student.lrn || "").trim() === String(lrn).trim());
        if (!match) throw new Error("No student was found for that LRN.");
        const [studentId, student] = match;
        const sectionSnap = student.sectionId ? await get(ref(database, `sections/${student.sectionId}`)) : null;
        const section = sectionSnap && sectionSnap.exists() ? sectionSnap.val() : null;
        setInvolvedStudent(studentId, student, section, method);
        if (feedback) { feedback.textContent = `${studentFullName(student)} selected.`; feedback.classList.add("is-success"); }
        if (method === "qr") await stopQrCamera();
    } catch (error) {
        if (feedback) { feedback.textContent = error.message || "Student lookup failed."; feedback.classList.add("is-error"); }
    }
}

async function startQrCamera() {
    if (qrCameraRunning) return;
    const feedback = document.getElementById("involved-student-feedback");
    if (typeof window.Html5Qrcode === "undefined") {
        if (feedback) { feedback.textContent = "Camera scanner failed to load. Use manual LRN entry."; feedback.classList.remove("hidden"); feedback.classList.add("is-error"); }
        return;
    }
    try {
        html5QrInstance = new window.Html5Qrcode("incident-qr-reader");
        await html5QrInstance.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 220, height: 220 } },
            (decodedText) => identifyStudentByLrn(decodedText.trim(), "qr"),
            () => {}
        );
        qrCameraRunning = true;
        document.getElementById("btn-start-qr")?.classList.add("hidden");
        document.getElementById("btn-stop-qr")?.classList.remove("hidden");
    } catch (error) {
        if (feedback) { feedback.textContent = "Camera unavailable. Check permission or use manual LRN entry."; feedback.classList.remove("hidden"); feedback.classList.add("is-error"); }
    }
}

async function stopQrCamera() {
    if (!html5QrInstance) return;
    try {
        if (qrCameraRunning) await html5QrInstance.stop();
        html5QrInstance.clear();
    } catch (error) {
        console.warn("QR camera cleanup failed:", error);
    }
    html5QrInstance = null;
    qrCameraRunning = false;
    document.getElementById("btn-start-qr")?.classList.remove("hidden");
    document.getElementById("btn-stop-qr")?.classList.add("hidden");
}

function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}

/* ==========================================================================
   REPORT SCREEN — scope + type + location + notes, all on one screen,
   ending in a single Send button (no separate confirm screen). The
   identity card at the top always shows whoever is logged in (they're the
   one reporting), regardless of "Just Me" vs "Everyone Here".
========================================================================== */
function populateReportScreen() {
    const nameEl = document.getElementById("identity-name");
    const metaEl = document.getElementById("identity-meta");
    const photoEl = document.getElementById("identity-photo");
    const photoFallbackEl = document.getElementById("identity-photo-fallback");

    if (!loggedInStudent) return;

    const fullName = [loggedInStudent.firstName, loggedInStudent.middleName, loggedInStudent.lastName, loggedInStudent.extension]
        .filter((v) => v && String(v).trim())
        .join(" ");

    nameEl.textContent = fullName || "Student";
    metaEl.textContent = loggedInSection
        ? `${loggedInSection.gradeName || "--"} \u2013 ${loggedInSection.name}`
        : "Section not on file";

    const initials = ((loggedInStudent.firstName || "").charAt(0) + (loggedInStudent.lastName || "").charAt(0)).toUpperCase();
    photoFallbackEl.textContent = initials || "?";

    if (loggedInStudent.photoUrl) {
        photoEl.src = loggedInStudent.photoUrl;
        photoEl.classList.remove("hidden");
        photoFallbackEl.classList.add("hidden");
        photoEl.onerror = () => {
            photoEl.classList.add("hidden");
            photoFallbackEl.classList.remove("hidden");
        };
    } else {
        photoEl.classList.add("hidden");
        photoFallbackEl.classList.remove("hidden");
    }

    renderInvolvedStudent();
    updateLocationRow();
    updateReportSummary();
}

function setupReportScreen() {
    setupScopeSegmented();
    setupTypeGrids();
    setupNotes();
    setupSendButton();

    const mapBtn = document.getElementById("btn-open-map");
    if (mapBtn) mapBtn.addEventListener("click", openMapOverlay);
}

function setupScopeSegmented() {
    const buttons = document.querySelectorAll(".segmented-btn");
    const hint = document.getElementById("scope-hint");
    const individualGrid = document.getElementById("individual-type-grid");
    const roomwideGrid = document.getElementById("roomwide-type-grid");

    buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
            buttons.forEach((b) => b.classList.toggle("active", b === btn));
            reportRoomWide = btn.dataset.scope === "roomwide";
            const involvedCard = document.getElementById("involved-student-card");
            if (involvedCard) involvedCard.classList.toggle("hidden", reportRoomWide);
            if (!reportRoomWide && !involvedStudentId) {
                setInvolvedStudent(loggedInStudentId, loggedInStudent, loggedInSection, "logged-in-account");
            }

            individualGrid.classList.toggle("hidden", reportRoomWide);
            roomwideGrid.classList.toggle("hidden", !reportRoomWide);

            hint.textContent = reportRoomWide
                ? "Something affecting everyone around you \u2014 fire, a fight, an intruder, etc."
                : "A personal emergency \u2014 headache, injury, panic attack, etc.";

            // Switching scope clears the previously-selected type since the
            // two grids use different options.
            reportType = null;
            document.querySelectorAll(".type-chip").forEach((chip) => chip.classList.remove("selected"));
            updateSendButtonState();
            updateReportSummary();
        });
    });
}

function setupTypeGrids() {
    document.querySelectorAll(".type-grid").forEach((grid) => {
        grid.querySelectorAll(".type-chip").forEach((chip) => {
            chip.addEventListener("click", () => {
                grid.querySelectorAll(".type-chip").forEach((c) => c.classList.remove("selected"));
                chip.classList.add("selected");
                reportType = chip.dataset.type;
                updateSendButtonState();
                updateReportSummary();
            });
        });
    });
}

function setupNotes() {
    // Notes are read directly from the textarea at submit time — nothing
    // to wire up here beyond letting the <details> disclosure do its thing.
}

function updateLocationRow() {
    const valueEl = document.getElementById("location-value");
    const facility = findFacility(selectedFacilityId);

    if (!facility) {
        valueEl.textContent = loggedInSection ? loggedInSection.name : "Pick a location on the map";
        return;
    }

    const label = `${displayFacilityName(facility.name)} \u00b7 ${facility.zone}`;
    valueEl.textContent = locationOverridden ? `${label} (changed)` : label;
}

function updateReportSummary() {
    const summaryEl = document.getElementById("report-summary");
    if (!reportType) {
        summaryEl.classList.add("hidden");
        return;
    }

    const facility = findFacility(selectedFacilityId);
    const roomLabel = facility ? displayFacilityName(facility.name) : (loggedInSection ? loggedInSection.name : "unspecified location");
    const scopeLabel = reportRoomWide ? "Everyone Here" : "Just Me";

    summaryEl.textContent = `${reportType} \u2014 ${scopeLabel} \u2014 ${roomLabel}`;
    summaryEl.classList.remove("hidden");
}

function updateSendButtonState() {
    const btn = document.getElementById("btn-send");
    const label = document.getElementById("btn-send-label");
    if (!btn || !label) return;

    if (!reportType) {
        btn.disabled = true;
        label.textContent = "Select an incident type";
        return;
    }
    if (!reportRoomWide && !involvedStudentId) {
        btn.disabled = true;
        label.textContent = "Identify the student involved";
        return;
    }

    btn.disabled = false;
    if (!btn.classList.contains("armed")) {
        label.textContent = "Send Report";
    }
}

/* ==========================================================================
   SEND BUTTON — tap once to arm a short, visible, cancellable countdown
   instead of navigating to a separate confirmation screen. Tap again while
   armed to cancel. This replaces the old Confirm screen so reporting a real
   emergency takes as few steps as possible.
========================================================================== */
function setupSendButton() {
    const btn = document.getElementById("btn-send");
    if (!btn) return;

    btn.addEventListener("click", () => {
        if (btn.disabled) return;
        if (btn.classList.contains("armed")) {
            cancelArmedSend();
        } else {
            armSend();
        }
    });
}

function armSend() {
    const btn = document.getElementById("btn-send");
    const label = document.getElementById("btn-send-label");
    const progress = document.getElementById("btn-send-progress");

    btn.classList.add("armed");
    armRemaining = ARM_SECONDS;
    label.textContent = `Sending in ${armRemaining}s \u2014 Tap to Cancel`;
    progress.style.transition = "none";
    progress.style.width = "100%";
    // Force layout so the next width change (0%) actually transitions.
    // eslint-disable-next-line no-unused-expressions
    progress.offsetWidth;
    progress.style.transition = `width ${ARM_SECONDS}s linear`;
    progress.style.width = "0%";

    armInterval = setInterval(() => {
        armRemaining -= 1;
        if (armRemaining > 0) {
            label.textContent = `Sending in ${armRemaining}s \u2014 Tap to Cancel`;
        }
    }, 1000);

    armTimer = setTimeout(() => {
        finalizeSend();
    }, ARM_SECONDS * 1000);
}

function cancelArmedSend() {
    const btn = document.getElementById("btn-send");
    const progress = document.getElementById("btn-send-progress");
    if (armTimer) clearTimeout(armTimer);
    if (armInterval) clearInterval(armInterval);
    armTimer = null;
    armInterval = null;
    if (btn) btn.classList.remove("armed");
    if (progress) {
        progress.style.transition = "none";
        progress.style.width = "0%";
    }
    updateSendButtonState();
}

async function finalizeSend() {
    const btn = document.getElementById("btn-send");
    const label = document.getElementById("btn-send-label");
    if (armInterval) clearInterval(armInterval);
    armInterval = null;
    armTimer = null;

    btn.disabled = true;
    label.textContent = "Reporting...";

    try {
        const incidentKey = await submitIncidentReport();
        populateSuccessScreen(incidentKey, reportRoomWide);
        showScreen("screen-success");
    } catch (error) {
        console.error("Failed to submit incident report:", error);
        alert("Couldn't send the report. Check your connection and try again.");
        btn.classList.remove("armed");
        btn.disabled = false;
        updateSendButtonState();
    }
}

/* Fires the instant a room is picked in Major Threat mode (see
   pickFacility() above) — no arm/cancel countdown, no confirm screen; the
   whole point of the shortcut is speed. Jumps straight to the success
   screen with a transient "sending" message, then fills in the real
   status once the write actually completes. */
async function sendMajorThreatReport() {
    showScreen("screen-success");
    const detailEl = document.getElementById("success-detail");
    const statusEl = document.getElementById("success-help-status");
    if (detailEl) detailEl.textContent = "Sending your report\u2026";
    setHelpStatus(statusEl, "waiting");

    try {
        const incidentKey = await submitIncidentReport();
        populateSuccessScreen(incidentKey, true);
    } catch (error) {
        console.error("Failed to submit major threat report:", error);
        alert("Couldn't send the report. Check your connection and try again.");
        majorThreatMode = false;
        showScreen("screen-home");
    }
}

/* ==========================================================================
   CAMPUS MAP OVERLAY — lets the student pick where this is ACTUALLY
   happening instead of trusting the room implied by their homeroom. Real
   incidents happen in hallways, the canteen, another section's room, etc.
========================================================================== */
function setupMapOverlay() {
    const closeBtn = document.getElementById("btn-close-map");
    const useScannedBtn = document.getElementById("btn-use-scanned");
    const searchInput = document.getElementById("map-search");
    const fullscreenBtn = document.getElementById("btn-toggle-fullscreen");

    if (closeBtn) {
        closeBtn.addEventListener("click", () => {
            // Closing without picking a room cancels the shortcut — otherwise
            // the next room pick anywhere else in the app would misfire as
            // an instant major-threat submission.
            majorThreatMode = false;
            closeMapOverlay();
        });
    }
    if (useScannedBtn) {
        useScannedBtn.addEventListener("click", () => {
            selectedFacilityId = homeFacilityId;
            locationOverridden = false;
            updateLocationRow();
            updateReportSummary();
            closeMapOverlay();
        });
    }
    if (searchInput) {
        searchInput.addEventListener("input", () => renderMapZones(searchInput.value.trim().toLowerCase()));
    }
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener("click", () => {
            mapFullscreen = !mapFullscreen;
            applyMapFullscreenState();
        });
    }

    setupMapTabs();
}

/* Two ways to pick a location, per the same floating window: tap the
   visual campus map, or search a flat list — both end up here so
   selection/closing behaves identically either way. */
function pickFacility(facility) {
    selectedFacilityId = facility.id;
    locationOverridden = facility.id !== homeFacilityId;

    if (majorThreatMode) {
        closeMapOverlay();
        sendMajorThreatReport();
        return;
    }

    updateLocationRow();
    updateReportSummary();
    closeMapOverlay();
}

function setupMapTabs() {
    const tabButtons = document.querySelectorAll(".map-tab");
    tabButtons.forEach((tabBtn) => {
        tabBtn.addEventListener("click", () => {
            const target = tabBtn.dataset.tab;

            tabButtons.forEach((b) => b.classList.toggle("active", b === tabBtn));

            const mapPanel = document.getElementById("map-tab-panel-map");
            const searchPanel = document.getElementById("map-tab-panel-search");
            if (mapPanel) mapPanel.classList.toggle("hidden", target !== "map");
            if (searchPanel) searchPanel.classList.toggle("hidden", target !== "search");
        });
    });
}

function openMapOverlay() {
    const overlay = document.getElementById("map-overlay");
    const useScannedBtn = document.getElementById("btn-use-scanned");
    const searchInput = document.getElementById("map-search");
    const titleEl = document.getElementById("map-overlay-title");

    if (searchInput) searchInput.value = "";
    if (useScannedBtn) useScannedBtn.classList.toggle("hidden", !homeFacilityId || !locationOverridden);
    if (titleEl) {
        titleEl.textContent = majorThreatMode
            ? "Where is the threat?"
            : "Where is this happening?";
    }

    renderMapZones("");
    renderMiniBlueprint();
    applyMapFullscreenState();
    if (overlay) overlay.classList.remove("hidden");
}

/* ==========================================================================
   FULL-SCREEN TOGGLE — expands the picker to the full viewport and swaps
   the compact mini-blueprint chips for a full-size reproduction of the
   admin dashboard's actual Campus Map layout (see buildFullBlueprint()
   below). Purely a display mode; selecting a room works identically
   either way since both call the same pickFacility().
========================================================================== */
function applyMapFullscreenState() {
    const overlay = document.getElementById("map-overlay");
    const toggleBtn = document.getElementById("btn-toggle-fullscreen");
    const miniBlueprint = document.getElementById("mini-blueprint");
    const fullBlueprint = document.getElementById("full-blueprint-container");
    const hint = document.getElementById("mini-blueprint-hint");

    if (overlay) overlay.classList.toggle("is-fullscreen", mapFullscreen);
    if (toggleBtn) {
        toggleBtn.classList.toggle("is-active", mapFullscreen);
        const label = mapFullscreen ? "Exit full screen" : "Full screen";
        toggleBtn.title = label;
        toggleBtn.setAttribute("aria-label", label);
    }
    if (miniBlueprint) miniBlueprint.classList.toggle("hidden", mapFullscreen);
    if (fullBlueprint) fullBlueprint.classList.toggle("hidden", !mapFullscreen);
    if (hint) {
        hint.textContent = mapFullscreen
            ? "Tap a room on the campus blueprint below."
            : "Tap a room or area below.";
    }

    if (mapFullscreen) buildFullBlueprint();
}

function closeMapOverlay() {
    const overlay = document.getElementById("map-overlay");
    if (overlay) overlay.classList.add("hidden");
}

/* ==========================================================================
   MINIATURE CAMPUS MAP (default "Campus Map" tab)
   --------------------------------------------------------------------------
   A scaled-down copy of the admin dashboard's blueprint — same wing/zone
   layout and orientation (Top Wing, Left/Courtyard+Gym/Right, Bottom Wing,
   then the two SHS building clusters) — as small tappable room chips
   instead of the admin's full-size room cards, since this floating window
   is meant to stay small. The "Search" tab (renderMapZones, above) covers
   every one of these same facilities as a flat searchable list — this is
   just the visual alternative to it.
========================================================================== */
function renderMiniBlueprint() {
    const container = document.getElementById("mini-blueprint");
    if (!container) return;
    container.innerHTML = "";

    function chip(facility, extraClass) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mini-room-chip" + (extraClass ? ` ${extraClass}` : "");
        if (facility.id === selectedFacilityId) btn.classList.add("selected");
        btn.textContent = displayFacilityName(facility.name);
        btn.title = facility.section;
        btn.addEventListener("click", () => pickFacility(facility));
        return btn;
    }

    function wingRow(zoneName) {
        const wrap = document.createElement("div");
        const label = document.createElement("p");
        label.className = "mini-zone-label";
        label.textContent = zoneName;
        wrap.appendChild(label);

        const row = document.createElement("div");
        row.className = "mini-wing-row";
        SCHOOL_FACILITIES.filter((f) => f.zone === zoneName).forEach((f) => row.appendChild(chip(f)));
        wrap.appendChild(row);
        return wrap;
    }

    // Top Wing
    container.appendChild(wingRow("Top Wing"));

    // Left Wing / Courtyard (Gym) / Right Wing — three columns, same
    // left-to-right orientation as the admin blueprint.
    const middleRow = document.createElement("div");
    middleRow.className = "mini-middle-row";

    const leftCol = document.createElement("div");
    leftCol.className = "mini-middle-col";
    SCHOOL_FACILITIES.filter((f) => f.zone === "Left Wing").forEach((f) => leftCol.appendChild(chip(f)));

    const courtyardCol = document.createElement("div");
    courtyardCol.className = "mini-courtyard-col";
    const courtyardLabel = document.createElement("p");
    courtyardLabel.className = "mini-zone-label";
    courtyardLabel.textContent = "Courtyard";
    courtyardCol.appendChild(courtyardLabel);
    SCHOOL_FACILITIES.filter((f) => f.zone === "Courtyard").forEach((f) => courtyardCol.appendChild(chip(f, "mini-room-chip-gym")));

    const rightCol = document.createElement("div");
    rightCol.className = "mini-middle-col";
    SCHOOL_FACILITIES.filter((f) => f.zone === "Right Wing").forEach((f) => rightCol.appendChild(chip(f)));

    middleRow.appendChild(leftCol);
    middleRow.appendChild(courtyardCol);
    middleRow.appendChild(rightCol);
    container.appendChild(middleRow);

    // Bottom Wing
    container.appendChild(wingRow("Bottom Wing"));

    // SHS Building 1 / SHS Building 2
    ["SHS Building 1", "SHS Building 2"].forEach((zoneName) => container.appendChild(wingRow(zoneName)));
}

/* ==========================================================================
   FULL CAMPUS BLUEPRINT (full-screen mode only)
   --------------------------------------------------------------------------
   Same structure and tier split as the admin dashboard's buildCampusMap()
   in script.js: top wing across the top, left/courtyard(SHS clusters +
   gym)/right in the middle, bottom wing offset under the courtyard. The
   two SHS blocks each split into two tiers by the same fixed room lists
   the admin dashboard uses, so the layout lines up exactly.
========================================================================== */
const FULL_BLUEPRINT_SHS1_TIER1_IDS = ["shs1-sapphire", "shs1-sci", "shs1-amethyst", "shs1-amaranth"];
const FULL_BLUEPRINT_SHS2_TIER1_IDS = ["shs2-fuschia", "shs2-driftwood", "shs2-emerald", "shs2-cr1"];

function buildFullBlueprint() {
    const top = document.getElementById("fb-wing-top");
    const left = document.getElementById("fb-wing-left");
    const right = document.getElementById("fb-wing-right");
    const bottom = document.getElementById("fb-wing-bottom");
    const shs1Tier1 = document.getElementById("fb-shs1-tier-1");
    const shs1Tier2 = document.getElementById("fb-shs1-tier-2");
    const shs2Tier1 = document.getElementById("fb-shs2-tier-1");
    const shs2Tier2 = document.getElementById("fb-shs2-tier-2");
    const gymSlot = document.getElementById("fb-courtyard-gym-slot");

    if (!top || !left || !right || !bottom) return;

    [top, left, right, bottom, shs1Tier1, shs1Tier2, shs2Tier1, shs2Tier2, gymSlot].forEach((el) => {
        if (el) el.innerHTML = "";
    });

    SCHOOL_FACILITIES.forEach((facility) => {
        const card = createFullBlueprintRoomCard(facility);

        if (facility.zone === "Top Wing") {
            top.appendChild(card);
        } else if (facility.zone === "Left Wing") {
            left.appendChild(card);
        } else if (facility.zone === "Right Wing") {
            right.appendChild(card);
        } else if (facility.zone === "Bottom Wing") {
            bottom.appendChild(card);
        } else if (facility.zone === "SHS Building 1") {
            (FULL_BLUEPRINT_SHS1_TIER1_IDS.includes(facility.id) ? shs1Tier1 : shs1Tier2).appendChild(card);
        } else if (facility.zone === "SHS Building 2") {
            (FULL_BLUEPRINT_SHS2_TIER1_IDS.includes(facility.id) ? shs2Tier1 : shs2Tier2).appendChild(card);
        } else if (facility.zone === "Courtyard") {
            // GYM — sits in the open courtyard space beside the SHS
            // clusters, positioned via CSS (.courtyard-gym-slot) so it
            // never disturbs their layout, same as the admin blueprint.
            if (gymSlot) {
                card.classList.add("fb-room-card-gym");
                gymSlot.appendChild(card);
            }
        }
    });
}

function createFullBlueprintRoomCard(facility) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "fb-room-card";
    if (facility.id === selectedFacilityId) card.classList.add("selected");
    if (facility.id === homeFacilityId) card.classList.add("is-scanned-room");

    card.innerHTML = `<span class="fb-room-number">${displayFacilityName(facility.name)}</span>`;
    card.title = facility.section;
    card.addEventListener("click", () => pickFacility(facility));

    return card;
}

function renderMapZones(filterText) {
    const container = document.getElementById("map-zones");
    if (!container) return;

    container.innerHTML = "";

    ZONE_ORDER.forEach((zone) => {
        const facilitiesInZone = SCHOOL_FACILITIES.filter((f) => {
            if (f.zone !== zone) return false;
            if (!filterText) return true;
            const haystack = `${displayFacilityName(f.name)} ${f.section}`.toLowerCase();
            return haystack.includes(filterText);
        });

        if (facilitiesInZone.length === 0) return;

        const zoneBlock = document.createElement("div");
        zoneBlock.className = "map-zone-block";

        const heading = document.createElement("h3");
        heading.className = "map-zone-heading";
        heading.textContent = zone;
        zoneBlock.appendChild(heading);

        const grid = document.createElement("div");
        grid.className = "map-zone-grid";

        facilitiesInZone.forEach((facility) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "map-room-btn";
            if (facility.id === selectedFacilityId) btn.classList.add("selected");
            if (facility.id === homeFacilityId) btn.classList.add("is-scanned-room");

            btn.innerHTML = `
                <span class="map-room-name">${displayFacilityName(facility.name)}</span>
                <span class="map-room-sub">${facility.section}</span>
            `;

            btn.addEventListener("click", () => pickFacility(facility));

            grid.appendChild(btn);
        });

        zoneBlock.appendChild(grid);
        container.appendChild(zoneBlock);
    });

    if (!container.children.length) {
        const empty = document.createElement("p");
        empty.className = "map-empty";
        empty.textContent = "No matching location found.";
        container.appendChild(empty);
    }
}

/* ==========================================================================
   FIREBASE WRITE — mirrors the main dashboard's raiseClassroomEmergency()
   in script.js: atomic incident-number transaction, then a permanent
   incidents/{pushKey} record, then the current-state classrooms/ flag.
   Uses selectedFacilityId (the map pick) rather than blindly trusting the
   room implied by the logged-in student's homeroom, since the two can
   legitimately differ.
========================================================================== */
async function submitIncidentReport() {
    const facility = findFacility(selectedFacilityId);
    const roomName = facility ? facility.name : (loggedInSection ? loggedInSection.name : "Unknown Room");

    const reporterFullName = loggedInStudent
        ? [loggedInStudent.firstName, loggedInStudent.middleName, loggedInStudent.lastName, loggedInStudent.extension]
            .filter((v) => v && String(v).trim())
            .join(" ")
        : null;

    // The reporting account and the student involved are deliberately
    // separate. QR/manual LRN can select another student without changing
    // the authenticated reporting identity.
    const studentId = reportRoomWide ? null : involvedStudentId;
    const studentName = reportRoomWide ? null : studentFullName(involvedStudent);
    const studentLrn = reportRoomWide ? null : ((involvedStudent && involvedStudent.lrn) || (involvedStudentId === loggedInStudentId ? loggedInLrn : null));
    const studentSection = reportRoomWide ? null : sectionDisplayName(involvedSection);

    const notes = document.getElementById("report-notes") ? document.getElementById("report-notes").value.trim() : "";

    const numberResult = await runTransaction(lastIncidentNumberRef, (current) => (current || 0) + 1);
    const incidentNumber = numberResult.snapshot.val();

    const newIncidentRef = push(incidentsRootRef);
    await set(newIncidentRef, {
        incidentNumber: `Emergency #${String(incidentNumber).padStart(3, "0")}`,
        timestamp: Date.now(),
        classroom: roomName,
        status: "Active",
        resolvedAt: null,
        studentId,
        studentName,
        studentLrn,
        studentSection,
        identificationMethod: reportRoomWide ? "room-wide" : involvedIdentificationMethod,
        reporterId: loggedInStudentId,
        reporterName: reporterFullName,
        reporterLrn: loggedInLrn,
        incidentType: reportType,
        roomWide: reportRoomWide,
        description: notes || null,
        reportedVia: "student-app",
        facilityId: selectedFacilityId || null,
        locationOverridden
    });

    if (selectedFacilityId) {
        // Don't stomp an already-active emergency's activeIncidentKey — if the
        // room is already flagged, this new report still gets logged above,
        // it just won't replace which incident the room card/modal points to.
        // (See this app's README for the tradeoff and how to change it.)
        const classroomRef = ref(database, `classrooms/${selectedFacilityId}`);
        const existingSnapshot = await get(classroomRef);
        const existing = existingSnapshot.val();

        if (!existing || !existing.emergency) {
            await update(classroomRef, {
                emergency: true,
                activeIncidentKey: newIncidentRef.key,
                // Mirrors this report's scope so the Campus Map can color
                // "affects everyone here" incidents differently from a
                // single-person one without a second lookup.
                roomWide: reportRoomWide
            });
        }
    }

    triggerIncidentAlert(newIncidentRef.key);

    return newIncidentRef.key;
}

/* ==========================================================================
   SUCCESS SCREEN
   --------------------------------------------------------------------------
   Used to say "Help is on the way" the instant the report was sent — but
   that's a promise the app has no way to back up: if nobody has actually
   seen the report yet, the student is waiting on nothing. Instead this
   screen starts in a neutral "waiting for confirmation" state and only
   switches to "help is on the way" once an admin has actually pressed
   "Notify Student" on the dashboard (incidents/{key}.helpNotifiedAt gets
   set at that moment — see student-incident-panel / script.js on the main
   dashboard) — watched live here via onValue so it updates the instant
   that happens, with no polling and no fixed delay.
========================================================================== */
let helpNotifiedUnsubscribe = null;

function populateSuccessScreen(incidentKey, roomWide) {
    stopWatchingHelpNotified();

    const detailEl = document.getElementById("success-detail");
    const statusEl = document.getElementById("success-help-status");

    if (detailEl) {
        detailEl.textContent = roomWide
            ? "The Command Center has been notified for everyone in this area."
            : "The Command Center has been notified.";
    }

    setHelpStatus(statusEl, "waiting");

    if (!incidentKey) return;

    const incidentRef = ref(database, `incidents/${incidentKey}/helpNotifiedAt`);
    helpNotifiedUnsubscribe = onValue(incidentRef, (snapshot) => {
        if (snapshot.val()) {
            setHelpStatus(statusEl, "confirmed");
        }
    });
}

function setHelpStatus(statusEl, state) {
    if (!statusEl) return;
    statusEl.classList.remove("help-status-waiting", "help-status-confirmed");

    if (state === "confirmed") {
        statusEl.classList.add("help-status-confirmed");
        statusEl.textContent = "Help is on the way.";
    } else {
        statusEl.classList.add("help-status-waiting");
        statusEl.textContent = "Waiting for the Command Center to confirm\u2026";
    }
}

function stopWatchingHelpNotified() {
    if (helpNotifiedUnsubscribe) {
        helpNotifiedUnsubscribe();
        helpNotifiedUnsubscribe = null;
    }
}

function setupHistoryScreens() {
    document.getElementById("btn-open-incidents")?.addEventListener("click", () => loadIncidentHistory());
    document.getElementById("btn-open-violations")?.addEventListener("click", () => loadViolationHistory());
}

async function loadIncidentHistory() {
    const root = document.getElementById("incident-history-list");
    showScreen("screen-incident-history");
    if (!root || !loggedInStudentId) return;
    root.innerHTML = '<div class="history-empty">Loading…</div>';
    try {
        const snap = await get(incidentsRootRef);
        const records = Object.entries(snap.val() || {})
            .map(([key, value]) => ({ key, ...value }))
            .filter((item) => item.reporterId === loggedInStudentId || item.studentId === loggedInStudentId)
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        renderHistoryList(root, records, "incident");
    } catch (error) { root.innerHTML = '<div class="history-empty">Could not load incident history.</div>'; }
}

async function loadViolationHistory() {
    const root = document.getElementById("violation-history-list");
    showScreen("screen-violation-history");
    if (!root || !loggedInStudentId) return;
    root.innerHTML = '<div class="history-empty">Loading…</div>';
    try {
        const snap = await get(ref(database, `violations/${loggedInStudentId}`));
        const records = Object.entries(snap.val() || {}).map(([key, value]) => ({ key, ...value })).sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
        renderHistoryList(root, records, "violation");
    } catch (error) { root.innerHTML = '<div class="history-empty">Could not load violation history.</div>'; }
}

function renderHistoryList(root, records, kind) {
    root.innerHTML = "";
    if (!records.length) { root.innerHTML = `<div class="history-empty">No ${kind} records found.</div>`; return; }
    records.forEach((record) => {
        const btn = document.createElement("button"); btn.type = "button"; btn.className = "history-item";
        const title = kind === "incident" ? (record.incidentType || record.incidentNumber || "Incident") : (record.type || "Violation");
        const subtitle = kind === "incident" ? `${record.status || "Reported"} · ${record.classroom || "Location not recorded"}` : `${ordinal(record.offenseCount)}${record.notes ? " · " + record.notes : ""}`;
        btn.innerHTML = `<span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle)}</small></span><time>${formatStudentDate(record.timestamp)}</time>`;
        btn.addEventListener("click", () => kind === "incident" ? openIncidentDetail(record) : openViolationDetail(record));
        root.appendChild(btn);
    });
}

function openIncidentDetail(record) {
    const root = document.getElementById("student-incident-detail");
    if (!root) return;
    root.innerHTML = `<span class="eyebrow">${escapeHtml(record.incidentNumber || "Incident report")}</span><h2>${escapeHtml(record.incidentType || "Incident")}</h2>
        <div class="detail-grid"><div><small>Status</small><strong>${escapeHtml(record.status || "Reported")}</strong></div><div><small>Reported</small><strong>${escapeHtml(formatStudentDate(record.timestamp))}</strong></div><div><small>Location</small><strong>${escapeHtml(record.classroom || "--")}</strong></div><div><small>Identification</small><strong>${escapeHtml(formatIdentificationMethod(record.identificationMethod))}</strong></div></div>
        <section><h3>Student involved</h3><p>${escapeHtml(record.studentName || (record.roomWide ? "Everyone in the area" : "Not recorded"))}${record.studentLrn ? `<br><small>LRN ${escapeHtml(record.studentLrn)}</small>` : ""}</p></section>
        <section><h3>Description</h3><p>${escapeHtml(record.description || "No additional details were provided.")}</p></section>
        ${record.helpNotifiedAt ? `<section><h3>Status update</h3><p>Command Center confirmed help at ${escapeHtml(formatStudentDate(record.helpNotifiedAt))}.</p></section>` : ""}
        ${record.resolvedAt ? `<section><h3>Resolution</h3><p>Resolved ${escapeHtml(formatStudentDate(record.resolvedAt))}${record.resolutionReason ? ` — ${escapeHtml(record.resolutionReason)}` : ""}</p></section>` : ""}`;
    showScreen("screen-incident-detail");
}

function openViolationDetail(record) {
    const root = document.getElementById("student-violation-detail");
    if (!root) return;
    root.innerHTML = `<span class="eyebrow">Violation record</span><h2>${escapeHtml(record.type || "Violation")}</h2>
        <div class="detail-grid"><div><small>Date</small><strong>${escapeHtml(formatStudentDate(record.timestamp))}</strong></div><div><small>Offense</small><strong>${escapeHtml(ordinal(record.offenseCount))}</strong></div></div>
        <section><h3>Notes</h3><p>${escapeHtml(record.notes || "No notes were recorded.")}</p></section>`;
    showScreen("screen-violation-detail");
}

function ordinal(n) { n=Number(n)||1; if(n===1)return "1st offense"; if(n===2)return "2nd offense"; if(n===3)return "3rd offense"; return `${n}th offense`; }
function formatStudentDate(ms) { return ms ? new Date(ms).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" }) : "--"; }
function formatIdentificationMethod(method) { return method === "qr" ? "QR code" : method === "manual-lrn" ? "Manual LRN" : method === "room-wide" ? "Room-wide report" : "Logged-in account"; }

function setupSuccessScreen() {
    const doneBtn = document.getElementById("btn-success-done");
    if (doneBtn) {
        doneBtn.addEventListener("click", () => {
            stopWatchingHelpNotified();
            resetReportState();
            showScreen("screen-home");
        });
    }
}
