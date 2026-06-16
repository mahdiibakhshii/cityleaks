import '../styles/chat.css';
import { ChatApp } from './ChatApp';

// Extract note id from the URL path (/c/n1) or query (?note=n1).
function getNoteId(): string | null {
  // Path form: /c/n1
  const pathMatch = window.location.pathname.match(/^\/c\/([^/?#]+)/);
  if (pathMatch) return pathMatch[1];
  // Query form: ?note=n1 (fallback for dev proxy)
  const params = new URLSearchParams(window.location.search);
  return params.get('note');
}

const noteId = getNoteId();
const root = document.getElementById('chat-root')!;

if (!noteId) {
  root.innerHTML = `
    <div class="chat-error">
      <div class="chat-error-icon">404</div>
      <div>No note found at this address.<br>Scan the QR code on the sticker again.</div>
    </div>`;
} else {
  const app = new ChatApp(root, noteId);
  app.start();
}
