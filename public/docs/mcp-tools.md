# MCP tool reference

Observation, action, and receipt tools exposed by the PhoneUse stdio server.

## Observation tools

| Tool | Purpose |
| --- | --- |
| phonebase_list_devices | List assigned devices and live capabilities. |
| phonebase_get_device | Inspect one assigned device. |
| phonebase_get_screenshot | Obtain the image plus its frame metadata. |
| phonebase_observe | Obtain the image, exact frame metadata, and live device safety state together. |
| phonebase_wait_for_screen | Read-only bounded literal-OCR check on fresh synchronized frames. Returns matched/not_matched, evidence, and an image when available; never replays motion. |
| phonebase_status | Read the current controller state. |
| phonebase_get_receipt | Inspect an accepted action’s durable state. |

## Action tools

| Tool | Operation |
| --- | --- |
| phonebase_open_app | Return to Home when needed, then locate an app label. With a configured station visual locator, unlabeled visible icons have a qualified visual fallback. This is not proof of installation or account readiness. |
| phonebase_tap_text | Use station-side OCR to tap one unique visible text label without a screenshot round trip. |
| phonebase_hover_move | Move above a point without touching. |
| phonebase_tap | Tap a point from a fresh observation. |
| phonebase_long_press | Press with a bounded duration. |
| phonebase_swipe | Swipe between two points on the same frame. |
| phonebase_input_text | Type a complete value in one call after station-side keyboard verification; never tap letters individually. |
| phonebase_phone_key | Use a key available on the current phone. |
| phonebase_hold | Pause physical motion. |
| phonebase_resume | Release Hold when the controller permits it. |
| phonebase_wait | Wait for a bounded duration. |

## Completion semantics

A completed receipt confirms physical execution, not the intended UI outcome. Supply expectedScreen to an action, or call phonebase_wait_for_screen afterward. Use text plus match: exact and normalized bounds around the actual input field for literal input checks; do not match a suggestion or history row. A bounded wait checks two distinct synchronized frames. An unmet check preserves the original receipt, returns isError, and sends no further motion. OCR may be uncertain or text may be clipped: inspect the actual image rather than loosening a check to force success. Matching a navigation title alone does not prove content has finished loading.

## Verify before continuing

Example expectedScreen for a top search field: {"text":"coding tips","match":"exact","bounds":{"left":0.21,"top":0.055,"right":0.7,"bottom":0.11},"keyboard":true,"timeoutMs":5000}. Derive bounds from your actual screenshot; these are not universal coordinates. Bounds are normalized 0–1. The standard English keyboard rows are measured before typing; layout switches include settle time, and the secondary symbol page supports = and +. Strict device key maps can further restrict characters. Account onboarding and platform access gates remain blockers, not robot successes. On arm 04, Back requires a recognized standard top-left chevron and uses its tested inset touch target; an unrecognized control is rejected rather than blindly swiped.

## Operator-only Home

`phonebase_home` (mechanical Home) is omitted from normal MCP tool discovery. It is available only for a local connection with `PHONEBASE_MCP_ALLOW_HOME=1`. Customer keys cannot perform mechanical Home. Phone Home (`phonebase_phone_key`) navigates the phone and remains a separate capability.
