# UI / UX audit — Mobile app, Telecaller and Sales Consultant (2026-10-27)

Release build (`assembleRelease`, x86_64) on the Pixel emulator, signed in as the
demo Telecaller and the demo Sales Consultant. Every bottom tab, the Schedule
sub-tabs and the lead detail were captured before and after the fixes.

## Per screen

| Screen                                      | What was wrong                                                                                                                                                                                              | Fix                                                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Today (both roles) · Overdue tile vs link   | Telecaller tile 150 over a "147 overdue" link. 50 seeded follow-ups were stored as `OVERDUE`: counted by the dashboard, left out of the list, and refused by complete / reschedule                          | Migration `202610270193` reopens them and stops `OVERDUE` being stored (applied). The link now reads 151                                                              |
| Today · Overdue tile vs link (second cause) | Tile 150, link 151: a follow-up the telecaller created after a call, on a customer they hold no lead for, is listed but the dashboard count also required that customer to be in scope                      | Migration `202610270211` counts a follow-up assigned to the caller like the list shows it; others stay scope-filtered. Verified 150 → 151, every other role unchanged |
| Today · recordings sync button              | Round background drawn square on release builds                                                                                                                                                             | Background on an inner view. (A grey square after a keyboard login is Android's focus highlight; it clears on the first touch)                                        |
| Follow-ups, Tasks, Schedule › Follow-ups    | Priority badges in capitals ("URGENT", "HIGH") beside sentence-case badges everywhere else                                                                                                                  | "Urgent", "High"                                                                                                                                                      |
| Lead detail · Next step                     | A lead handed to Sales showed "No follow-up set" while the Leads card for the same lead read "Follow-up overdue · 24 Oct": the open follow-up belongs to the consultant and is not in the telecaller's list | Shows "Demo Sales Consultant's follow-up · Overdue · 24 Oct, 1:00 pm" from the lead's own next follow-up time                                                         |
| Lead detail · temperature                   | "HOT" in capitals                                                                                                                                                                                           | "Hot", like the list badges                                                                                                                                           |
| Schedule › Test drives                      | Vehicle line "Demo Motors Demo SUV Demo SUV Premium": the variant already carries the model name                                                                                                            | The model is dropped when the variant starts with it                                                                                                                  |
| Leads (both roles)                          | Content OK: temperature chips with counts, sort, Call / WhatsApp, next follow-up and stage per card, stage colours per AGENTS.md 9.8, add-lead button                                                       | —                                                                                                                                                                     |
| Schedule › Visits, Test drives; Login       | Content OK. Test drives' Today tab deliberately keeps earlier drives that were never started, badged "Overdue"                                                                                              | —                                                                                                                                                                     |

## Timings (as the demo user, REST)

| Call                                                      | Telecaller | Sales Consultant |
| --------------------------------------------------------- | ---------- | ---------------- |
| `get_tenant_performance_dashboard` (Today tiles)          | 1.2 s      | —                |
| `get_followup_workspace_filtered_page` (Follow-ups, link) | 0.6–0.7 s  | 0.6 s            |

Measured from the workstation, so each includes the network round trip; the
follow-up list resolves the caller's scope once (telecaller and consultant fast
paths).
