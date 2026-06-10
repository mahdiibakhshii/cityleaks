import './styles/main.css';
import { Game } from './game/Game';
import { IntroOverlay } from './intro/IntroOverlay';
import { SPAWN } from './config';
import { ADMIN_CHARACTER_ID } from '../../shared/protocol';

async function bootstrap() {
  // Admin (Batman) session: the admin page opens /?admin=<token>. Skip the intro
  // and boot straight in as Batman; the token authorizes that identity on the
  // server (an invalid/absent token falls back to the anonymous circle there).
  const adminToken = new URLSearchParams(window.location.search).get('admin') ?? undefined;

  // Intro popup (shown every load): welcome → character pick. Resolves to the
  // chosen character id, or the anonymous circle on Skip. Then the game boots.
  const characterId = adminToken ? ADMIN_CHARACTER_ID : await new IntroOverlay().show();

  // Spawn at the configured point; Game.init() snaps to nearest walkable.
  const game = new Game(SPAWN.x, SPAWN.y, characterId, adminToken);
  await game.init();
  game.connect();
  game.start();

  // Expose for debugging in the console.
  (window as unknown as { game: Game }).game = game;
}

bootstrap();
