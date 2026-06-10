# Sticky Notes

> Anonymous text "stuck" to a map location. Added after the original four build
> phases; this doc is the spec for the feature as implemented. Parallels the
> [leak grid](leak-grid.md) in spirit: ownerless, persistent, streamed to every
> client on connect.

## Concept

A player can pin a short piece of text ("**sticking**") to wherever they are
standing. Every note shows up for everyone as an always-visible icon on the map.
Walking close to a note reveals its full text **fullscreen**; walking past the
threshold hides it again, leaving only the icon. This makes notes brief
"glitches" in the walk — a message someone left here surfaces, then fades as you
move on.

Like the leak grid, notes are:
- **Anonymous / ownerless** — no author identity is stored or shown.
- **Persistent** — saved to disk, survive restarts, sent in full to new clients.
- **Shared** — every game client and the monitor see the same notes live.

## Data model

```typescript
// shared/protocol.ts
interface Note {
  id: string;       // server-assigned, e.g. "n42"
  x: number;        // IMAGE/DATA coords (same convention as players/leak grid)
  y: number;
  text: string;     // trimmed, ≤ NOTE_MAX_LENGTH chars
  createdAt: number; // epoch ms
}

// Client → server request (server assigns id/createdAt, clamps x/y to bounds)
interface NoteCreate {
  x: number;
  y: number;
  text: string;
}
```

Constants (shared/protocol.ts):

```typescript
export const NOTE_MAX_LENGTH = 200;    // server-enforced text cap
export const NOTE_REVEAL_RADIUS = 120; // world units; closer reveals the text
```

## Server — `server/src/NoteStore.ts`

Mirrors `LeakGrid`'s role for structured data:

- `create(req: NoteCreate, bounds): Note | null` — trims text, rejects empty /
  non-finite coords, slices to `NOTE_MAX_LENGTH`, clamps position to
  `MAP_BOUNDS`, assigns `id` + `createdAt`, appends, returns the stored note.
- `getAll(): Note[]` — sent to every client on connect.
- Persistence to **`server/data/notes.json`** (plain JSON — notes are rare and
  small, so JSON stays human-readable):
  - `loadFromDisk()` on startup (validates shape, resumes the id counter past
    the highest existing id).
  - `saveToDiskAsync()` — coalesced (one in-flight write at a time; a save
    requested mid-write re-runs after) — called after each new note.
  - `saveToDisk()` — synchronous, used only on graceful shutdown.

`GameServer` owns the store, emits `note:existing` on connect (game **and**
monitor rooms), handles `note:create`, and broadcasts `note:new` to game +
monitor. `/api/status` reports a `notes` count. TD does not receive notes.

## Client — game

- **`client/src/game/NoteLayer.ts`** — the always-visible icons + proximity
  query. Each note is a camera-facing `THREE.Sprite` sharing one procedurally
  drawn texture (folded paper note + blue pin — no asset files). Sits at
  `NOTE.Z` (above the path overlay, below the local player).
  - `setNotes(notes)` / `addNote(note)` — from `note:existing` / `note:new`.
  - `getRevealNote(x, y): Note | null` — nearest note within
    `NOTE.REVEAL_RADIUS` (linear scan; note counts are small).
  - `setRevealed(id)` — optionally hides a revealed note's own icon
    (`NOTE.HIDE_ICON_WHEN_REVEALED`).
  - Constructor takes an optional world-unit `iconSize` (the monitor passes a
    larger value for its zoomed-out view).
- **`client/src/game/NoteUI.ts`** — all the DOM:
  - A persistent **"Stick a note"** button (bottom-right, clear of the
    bottom-left joystick).
  - A **compose modal** (textarea + live char counter, `maxLength` =
    `NOTE_MAX_LENGTH`). Submitting calls back with the trimmed text.
  - A **fullscreen reveal overlay**: `pointer-events:none` and **below** the
    joystick z-index, so the player keeps moving and the joystick stays usable
    on top. The font size is binary-searched to fill the screen without
    overflowing (`fitRevealText`), keyed by note id so it only re-fits when the
    revealed note changes.
- **`client/src/game/Game.ts`** wires it together: on submit, sends the note at
  the player's current position; each frame, reveals the nearest in-range note
  and hides it when none is in range.
- **Input freeze while composing:** `InputManager.setEnabled(false)` is called
  on compose-open (and `true` on close); `Keyboard` also ignores keys typed into
  text fields, so WASD typed into the textarea never drives the player.

## Client — monitor

`MonitorApp` reuses `NoteLayer` (constructed with a larger icon size,
`MAP_BOUNDS.width / 40`, so markers read when the whole city is fit to one
screen) and listens for `note:existing` / `note:new`. No reveal overlay on the
monitor — it has no local player.

## Protocol events

| Event | Dir | Payload | When |
|---|---|---|---|
| `note:existing` | S→C | `Note[]` | On connect (game + monitor) |
| `note:new` | S→C | `Note` | Broadcast when any player sticks a note |
| `note:create` | C→S | `NoteCreate` | A player sticks a note |

The note's author receives `note:new` like everyone else (the broadcast targets
the whole `game` room), so there's no optimistic local insert — the round-trip
is the single source of truth and avoids duplicates.

## Styling / responsiveness

`client/src/styles/main.css` styles all note DOM by class. Mobile uses the base
pixel sizes; a `@media (hover: hover) and (pointer: fine)` block (the same
desktop detection that hides the joystick) scales the button and modal up and
proportional to the viewport via `clamp(min, vw/vmin, max)`, since the
mobile-tuned sizes look small on large desktop screens.

## Config knobs (`client/src/config.ts` → `NOTE`)

| Key | Meaning |
|---|---|
| `REVEAL_RADIUS` | Re-exported `NOTE_REVEAL_RADIUS` (world units). |
| `ICON_SIZE` | In-game icon size in world units. |
| `Z` | Draw order (above paths, below player). |
| `ICON_PAPER` / `ICON_FOLD` / `ICON_ACCENT` | Procedural icon colors. |
| `HIDE_ICON_WHEN_REVEALED` | Hide a note's own icon while its text is shown. |

## Testing

`node tools/note-test.mjs` (server running; `URL` env overrides the port) — 9
checks: snapshot on connect, broadcast to sender + others, id assignment,
whitespace trim, position preservation, empty-note rejection, new-client
snapshot includes prior notes, `/api/status` note count.

## Not done / possible extensions

- No rate-limit or profanity filter (max-length cap is the only moderation).
- Notes never expire (permanent, like the leak grid).
- Notes are not streamed to TouchDesigner.
