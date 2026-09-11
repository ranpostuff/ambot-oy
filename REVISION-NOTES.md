# RescuePriority Student Web App — Revision Notes

This revision preserves the existing LRN/password login, Firebase project, incident numbering, classroom emergency signaling, Major Threat shortcut, campus location picker, and help-notification workflow.

Added:
- Real camera QR scanning using `html5-qrcode` with the existing LRN-only QR payload.
- Manual LRN lookup as an alternative to QR scanning.
- Separate reporter identity (logged-in account) and student-involved identity.
- Additive incident fields: `studentLrn`, `studentSection`, and `identificationMethod`.
- Full-page Incident History and Incident Detail views.
- Full-page Violation History and Violation Detail views.
- Responsive UI for the new identification and history components.

The QR scanner does not log a student in. It only selects the student involved in the current incident.
