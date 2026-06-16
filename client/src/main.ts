import './styles/main.css';
import { Game } from './game/Game';
import { IntroOverlay } from './intro/IntroOverlay';
import { SPAWN } from './config';
import { ADMIN_CHARACTER_ID } from '../../shared/protocol';

async function bootstrap() {
  // Admin (Batman) session: the admin page opens /?batman=1. Skip the intro and
  // boot straight in as Batman; the server authorizes that identity from the
  // admin session COOKIE (set at login) on the socket handshake — no token in the
  // URL. Without a valid cookie, character=batman falls back to the anon circle.
  const wantBatman = new URLSearchParams(window.location.search).has('batman');

  // Intro popup (shown every load): welcome → character pick. Resolves to the
  // chosen character id, or the anonymous circle on Skip. Then the game boots.
  const characterId = wantBatman ? ADMIN_CHARACTER_ID : await new IntroOverlay().show();

  // Spawn at the configured point; Game.init() snaps to nearest walkable.
  const game = new Game(SPAWN.x, SPAWN.y, characterId);
  await game.init();
  game.connect();
  game.start();

  // Expose for debugging in the console.
  (window as unknown as { game: Game }).game = game;
}

bootstrap();
