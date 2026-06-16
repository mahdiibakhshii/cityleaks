import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic, writeFileAtomicSync } from './atomicWrite';
import { CHAT_MAX_MESSAGES, CHAT_MAX_MSG_LENGTH, type ChatMessage } from '../../shared/protocol';

/**
 * Persistent per-note chat rooms. Each note gets its own ring-buffered message
 * list capped at CHAT_MAX_MESSAGES. Messages are anonymous — the server assigns
 * a color per socket session; no identity crosses sessions.
 *
 * Storage: one JSON file per note, at <chatsDir>/<noteId>.json. Files are
 * created on first message; notes with no messages have no file.
 */
export class ChatStore {
  private chatsDir: string;
  // In-memory map: noteId → messages (last CHAT_MAX_MESSAGES, newest last).
  private rooms = new Map<string, ChatMessage[]>();
  // Monotonic per-note message counter (for stable ids without clock collisions).
  private counters = new Map<string, number>();
  // Coalescing async save: if a save is in flight, queue one more.
  private saving = new Set<string>();
  private saveQueued = new Set<string>();

  constructor(chatsDir: string) {
    this.chatsDir = chatsDir;
    fs.mkdirSync(chatsDir, { recursive: true });
  }

  /** Load all existing note chat files on startup. */
  loadFromDisk(): void {
    let count = 0;
    try {
      const files = fs.readdirSync(this.chatsDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const noteId = file.replace(/\.json$/, '');
        const filePath = path.join(this.chatsDir, file);
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw) as ChatMessage[];
          if (!Array.isArray(parsed)) continue;
          const valid = parsed.filter(
            (m) =>
              m &&
              typeof m.id === 'string' &&
              typeof m.noteId === 'string' &&
              typeof m.text === 'string' &&
              typeof m.color === 'string' &&
              typeof m.createdAt === 'number'
          );
          this.rooms.set(noteId, valid);
          // Resume counter past the highest seen.
          for (const m of valid) {
            const parts = m.id.split('_');
            const n = Number(parts[parts.length - 1]);
            if (Number.isFinite(n)) {
              const cur = this.counters.get(noteId) ?? 0;
              if (n >= cur) this.counters.set(noteId, n + 1);
            }
          }
          count++;
        } catch {
          // Corrupt file — skip, don't crash.
        }
      }
    } catch {
      // chatsDir doesn't exist yet — fine.
    }
    if (count > 0) console.log(`Chat rooms loaded: ${count}`);
  }

  /** All messages for a note (newest last). Returns empty array for new rooms. */
  getMessages(noteId: string): ChatMessage[] {
    return this.rooms.get(noteId) ?? [];
  }

  /**
   * Add a message to a note's room. Validates text, trims, enforces max length.
   * Returns the stored ChatMessage, or null if text is empty/invalid.
   * `color` is the server-assigned hex color for this chatter's session.
   */
  addMessage(noteId: string, text: unknown, color: string): ChatMessage | null {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim().slice(0, CHAT_MAX_MSG_LENGTH);
    if (trimmed.length === 0) return null;

    const counter = this.counters.get(noteId) ?? 0;
    this.counters.set(noteId, counter + 1);

    const msg: ChatMessage = {
      id: `cm${noteId}_${counter}`,
      noteId,
      text: trimmed,
      color,
      createdAt: Date.now(),
    };

    const messages = this.rooms.get(noteId) ?? [];
    messages.push(msg);
    // Ring buffer: drop oldest when over cap.
    if (messages.length > CHAT_MAX_MESSAGES) messages.splice(0, messages.length - CHAT_MAX_MESSAGES);
    this.rooms.set(noteId, messages);

    return msg;
  }

  /** Delete all chat rooms (called when all notes are wiped by the admin). */
  clearAll(): void {
    for (const noteId of [...this.rooms.keys()]) {
      this.deleteRoom(noteId);
    }
  }

  /** Delete all messages for a note (e.g. when the note is deleted). */
  deleteRoom(noteId: string): void {
    this.rooms.delete(noteId);
    this.counters.delete(noteId);
    const filePath = path.join(this.chatsDir, `${noteId}.json`);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  }

  /** Synchronous save of all rooms — use only on shutdown. */
  saveToDisk(): void {
    for (const [noteId, messages] of this.rooms) {
      if (messages.length === 0) continue;
      const filePath = path.join(this.chatsDir, `${noteId}.json`);
      writeFileAtomicSync(filePath, JSON.stringify(messages));
    }
  }

  /** Async coalesced save for a single note's room. */
  async saveToDiskAsync(noteId: string): Promise<void> {
    if (this.saving.has(noteId)) {
      this.saveQueued.add(noteId);
      return;
    }
    this.saving.add(noteId);
    try {
      const messages = this.rooms.get(noteId) ?? [];
      const filePath = path.join(this.chatsDir, `${noteId}.json`);
      await writeFileAtomic(filePath, JSON.stringify(messages));
    } finally {
      this.saving.delete(noteId);
      if (this.saveQueued.has(noteId)) {
        this.saveQueued.delete(noteId);
        await this.saveToDiskAsync(noteId);
      }
    }
  }
}
