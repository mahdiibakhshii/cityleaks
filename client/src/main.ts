import './styles/main.css';
import { Game } from './game/Game';
import { IntroOverlay } from './intro/IntroOverlay';
import { SPAWN } from './config';

async function bootstrap() {
  // Intro popup (shown every load): welcome → character pick. Resolves to the
  // chosen character id, or the anonymous circle on Skip. Then the game boots.
  const characterId = await new IntroOverlay().show();

  // Spawn at the configured point; Game.init() snaps to nearest walkable.
  const game = new Game(SPAWN.x, SPAWN.y, characterId);
  await game.init();
  game.connect();
  game.start();

  // Expose for debugging in the console.
  (window as unknown as { game: Game }).game = game;
}

bootstrap();
