---
name: picturas-traceability
description: Build or check the Phase 1 traceability chain of the PictuRAS video extension (use case element → requirement → component → test → result) from the code, tests and requirements document. Use when asked to fill the report's chapters 3.1, 5.3, 7.1 or 7.3, find orphan requirements, or check which requirements are implemented and tested.
---

# Traceability for the PictuRAS video extension

The Phase 1 report must close the cycle **use case → requirement → component → test**.

## Identifiers (from the Phase 1 guidelines)

| ID | Meaning |
|----|---------|
| `UC-VID-nnn` | video use case (UC-VID-003 frame extraction, UC-VID-004 trim; upload/library as defined in the report) |
| `REQ-VID-{FUNC}-nnn` | requirement; never reuse an ID |
| `FAk`, `RNk`, `Ak`, `Qk` | local to a use case; qualify in shared tables (`UC-VID-004/RN3`) |
| `RNG-nn`, `DQ-nnn`, `DA-nn` | cross-cutting rule, quality decision, architectural decision |
| `TST-{FUNC}-nn`, `T-nn` | test, corrective-maintenance task |
| `UCnn`, `RFnn`, `RNFnn` | baseline elements, only when altered (ALT) |

## Procedure

1. Collect requirement references from the code:
   `rg -o "REQ-VID-[A-Z]+-[A-Z0-9]+|UC-VID-[0-9]+|RN[0-9]+" --glob '!**/node_modules/**'`.
2. Collect tests: `rg -o "TST-[A-Z]+(-[A-Z]+)?-[0-9]+" imageStorageService/test apiGateway/test`.
3. For each requirement in the report, find the component (file + function) that realises it and
   the tests that verify it. Mark the status:
   - **implementado** – code path exists and at least one passing test covers it;
   - **parcial** – code exists but a branch, limit or profile is missing or untested;
   - **não implementado** – specified only; must also appear in chapter 3.1.
4. Report orphans in both directions: requirements without component/test, and code/tests that
   reference IDs not present in the report.
5. Shared requirements (submit video, follow task status, daily-operation billing) are listed once
   with several origins; do not duplicate them per use case.

Write the result as tables ready for the report (Typst or Markdown) and list every
assumption made. Do not mark a requirement as verified without a recorded test result in
`docs/testes-fase1.md`.
