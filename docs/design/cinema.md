# Cinema

The player. A scene, a scrubber, and a URL that reproduces a frame — and why
that is a separate thing from the scenes themselves.

---

## The one idea

> **A cutscene is a _format_. Cinema is a _player_ for it.**

[ADR-0010](../adr/0010-cinematic-director.md) settles how a scripted scene is
authored and evaluated: a shot list, pure sampling against the simulation's own
clock, running over the live world with nothing swapped out. That is the format,
and it is deliberately austere — a script is a function from a frame number to a
camera pose.

Cinema is the layer above it: transport controls, a timecode, a scene library,
and an address bar that describes the frame on screen. None of that belongs in
the format, and the split is what stops a player feature — scrubbing, looping, a
shareable still — from becoming a change to how scenes are written.

✅ **Built.**

---

## What it is for

Three audiences, and they want the same four buttons.

| Who                | Wants                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| **Somebody new**   | To watch the thing once, full screen, without meeting a cockpit first |
| **An author**      | To park on frame 1150 and compare it against the reference edit       |
| **Anyone sharing** | To send a link that opens on the exact frame they were looking at     |

The middle one is not a nicety. The proving scene is timed against a
frame-analysed reference edit, and its measured numbers are regression tests —
so "pause, seek to frame 1150, look" is the verification loop, and a player with
a scrubber is that loop with buttons on it. `ir.pause()` then
`ir.seekCutscene(1150)` is exactly what the transport does.

---

## Frames, not seconds

Everything in this mode is counted in **frames**: the URL, the readout, the step
buttons. A link carrying `t=48.2s` would round to a different still on a 24 fps
scene than on a 30 fps one, and the entire point of a shareable frame is that
two people see the same picture.

| Parameter | Means                                               |
| --------- | --------------------------------------------------- |
| `t`       | The frame to open on. Clamped to the scene's length |
| `play=1`  | Start running rather than parked on the still       |

`/cinema/tng-intro?t=1150` is a still. `/cinema/tng-intro?play=1` is the scene
from the top. A link opens on a still by **default**, because the frame is the
thing being shared and a player that started running would take it off screen
immediately.

The address bar is rewritten while paused and left alone while playing — a
router update twenty-four times a second is not a feature.

---

## The transport

Start · back a second · play/pause · forward a second · end · timecode · copy a
link · close. `Space` plays and pauses, the arrows step a frame, shift-arrow
steps a second.

Two rules that make it a player rather than a toolbar:

- **The scrubber is full width and above the buttons.** It is the control the
  bar exists for.
- **It hides itself.** After 2.6 seconds of stillness while a scene runs, the
  chrome fades and the frame is the picture and nothing else. Any movement
  brings it back.

**There is exactly one transport on screen at a time.** The scene's own overlay
carries a debug scrubber, and it is drawn only when the
[debug overlay](ux.md#the-debug-overlay) is on — two playheads a person could
disagree with is worse than none.

---

## What it plays

Scenes come from the same registry `ir.cutscenes()` lists, so the library and
the console cannot disagree about what exists. There is one today:
`tng-intro` — a shot-for-shot study of the 1987 title sequence, staged in Sol
over the live world.

**Nothing here is a video file.** Every frame is rendered from the running
simulation at whatever resolution the window is, which is the reason the mode is
interesting at all: a scene is a camera move through a real universe, and the
same seek that reproduces it here reproduces it in a test.

> ⚠️ The reference audio and any full-sequence render carry third-party rights.
> The audio path is gitignored on purpose, and publishing a render needs a
> rights check first.

---

## Not built

| Thing                     | Note                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| More than one scene       | ⬜ The registry takes them; the work is authoring, not plumbing                                |
| Playback speed            | ⬜ The clock already has time warp; the transport does not expose it                           |
| Loop                      | ⬜ The director stops on the final frame and hands the ship back; looping is a seek to 0       |
| Export a still or a range | ⬜ Needs [photo mode](art.md#photo-mode)'s writer, and a rights check for anything full-length |
| Chapter marks             | ⬜ A scene is a shot list, so the shot boundaries are already the marks — they are not exposed |

---

## Related

- [ADR-0010](../adr/0010-cinematic-director.md) — the format this plays
- [ux](ux.md#the-application-shell) — the shell and the routes
- [planetarium](planetarium.md) — the other mode with no ship
- [art](art.md#photo-mode) — photo mode, which is the in-game counterpart
