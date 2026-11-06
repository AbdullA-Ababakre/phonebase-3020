# Frames & coordinates

A point is meaningful only in the exact image used to choose it.

## Read image metadata

| Header | Meaning |
| --- | --- |
| X-Phonebase-Frame-Sequence | Exact sequence identifier for this observation. |
| X-Phonebase-Frame-Width | Viewport width used for action coordinates. |
| X-Phonebase-Frame-Height | Viewport height used for action coordinates. |
| X-Phonebase-Captured-At | Capture timestamp in Unix milliseconds. |

## Keep the coordinate system intact

The origin is at the top-left. X increases to the right and Y increases downwards. Use the returned image dimensions, not browser CSS dimensions. If your vision pipeline resizes or crops the image, correctly map its result back to the original observation before submitting.

> Never reuse an old sequence with a new image or clamp an out-of-range coordinate. Get a fresh screenshot after each completed action.

## Freshness and exact frames

Omit `sequence` to request a fresh current screenshot. An optional `?sequence=…` requests a retained exact observation; unavailable or stale observations are rejected. Frame history and freshness windows are bounded by station configuration, so long processing delays require a new observation.

Coordinate actions use two freshness tiers. Frames up to 15 seconds old are accepted directly. From 15 to 60 seconds, the station compares the observed image and intended target region with the current screen; it proceeds only when both remain unchanged. FRAME_CHANGED or FRAME_REVALIDATION_REQUIRED means you must obtain a new observation. Frames older than 60 seconds return STALE_FRAME.

## Live video

The console uses an authenticated WebSocket stream and bounded frame backpressure. For application integrations, start with REST screenshots unless continuous video is necessary. See [WebSocket reference](/docs/live-video).
