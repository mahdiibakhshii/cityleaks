import { CHARACTERS, ANON_CHARACTER_ID, type CharacterDef } from '../../../shared/protocol';
import { getPlayerSpec, renderSpec } from '../game/sprites/drawSprite';

/**
 * The intro popup shown on every page load, before the game boots.
 *
 *   Phase 1 — a welcome panel (placeholder hero art + text) with Skip / Next.
 *   Phase 2 — character selection: four shape cards + Skip.
 *
 * `show()` resolves to the chosen character id (a CHARACTERS id, or
 * ANON_CHARACTER_ID when the player skips → the classic anonymous circle) and
 * removes the overlay. All DOM is built in code and styled by `.intro-*`
 * classes in styles/main.css, mirroring NoteUI.
 *
 * Procedural placeholders only: each card draws the character's actual in-game
 * SHAPE as an SVG, so the picker matches gameplay. Swap in real art / walk
 * sprites later without touching this flow.
 */
export class IntroOverlay {
  private overlay: HTMLDivElement;
  private phase1: HTMLDivElement;
  private phase2: HTMLDivElement;
  private resolve: ((characterId: string) => void) | null = null;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'intro-overlay';

    this.phase1 = this.buildPhase1();
    this.phase2 = this.buildPhase2();
    this.phase2.style.display = 'none';

    const card = document.createElement('div');
    card.className = 'intro-card';
    card.append(this.phase1, this.phase2);
    this.overlay.appendChild(card);
  }

  /** Mount the overlay and resolve once the player chooses or skips. */
  show(): Promise<string> {
    document.body.appendChild(this.overlay);
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  // ─── Phase 1: welcome ───

  private buildPhase1(): HTMLDivElement {
    const phase = document.createElement('div');
    phase.className = 'intro-phase';

    const hero = document.createElement('div');
    hero.className = 'intro-hero';
    hero.innerHTML = '<span class="intro-hero-emoji">🌐</span>';

    const title = document.createElement('h1');
    title.className = 'intro-title';
    title.textContent = 'Welcome to CityLeaks';

    const text = document.createElement('p');
    text.className = 'intro-text';
    text.textContent =
      'Roam the streets of Vienna. Every place you walk is recorded forever as a ' +
      'glowing trail on a living map shared by everyone. Leave anonymous notes for ' +
      'strangers to find. Ready to make your mark?';

    const actions = document.createElement('div');
    actions.className = 'intro-actions';
    actions.append(
      this.makeButton('Skip', 'intro-btn-ghost', () => this.choose(ANON_CHARACTER_ID)),
      this.makeButton('Next', 'intro-btn-primary', () => this.goToPhase2())
    );

    phase.append(hero, title, text, actions);
    return phase;
  }

  // ─── Phase 2: character selection ───

  private buildPhase2(): HTMLDivElement {
    const phase = document.createElement('div');
    phase.className = 'intro-phase';

    const title = document.createElement('h1');
    title.className = 'intro-title';
    title.textContent = 'Choose your character';

    const subtitle = document.createElement('p');
    subtitle.className = 'intro-text';
    subtitle.textContent = 'Pick a shape to play as — or skip to stay an anonymous circle.';

    const grid = document.createElement('div');
    grid.className = 'intro-characters';
    for (const char of CHARACTERS) grid.appendChild(this.makeCharacterCard(char));

    const actions = document.createElement('div');
    actions.className = 'intro-actions';
    actions.append(
      this.makeButton('Back', 'intro-btn-ghost', () => this.goToPhase1()),
      this.makeButton('Skip — play anonymous', 'intro-btn-ghost', () =>
        this.choose(ANON_CHARACTER_ID)
      )
    );

    phase.append(title, subtitle, grid, actions);
    return phase;
  }

  private makeCharacterCard(char: CharacterDef): HTMLButtonElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'intro-char';
    card.setAttribute('aria-label', char.name);

    const art = document.createElement('div');
    art.className = 'intro-char-art';
    art.appendChild(spritePreview(char.id));

    const name = document.createElement('div');
    name.className = 'intro-char-name';
    name.textContent = char.name;
    name.style.color = char.color ?? '#e8e8f0';

    const desc = document.createElement('div');
    desc.className = 'intro-char-desc';
    desc.textContent = char.description;

    card.append(art, name, desc);
    card.addEventListener('click', () => this.choose(char.id));
    return card;
  }

  // ─── Helpers ───

  private makeButton(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `intro-btn ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private goToPhase2(): void {
    this.phase1.style.display = 'none';
    this.phase2.style.display = '';
  }

  private goToPhase1(): void {
    this.phase2.style.display = 'none';
    this.phase1.style.display = '';
  }

  private choose(characterId: string): void {
    if (!this.resolve) return;
    const done = this.resolve;
    this.resolve = null;
    this.overlay.classList.add('intro-leaving');
    // Let the fade-out play, then unmount and resolve.
    setTimeout(() => {
      this.overlay.remove();
      done(characterId);
    }, 220);
  }
}

/**
 * A crisp, upscaled preview of a character's in-game sprite (stand frame), drawn
 * from the SAME procedural pixel art used in the game so the picker matches
 * gameplay exactly. Returns a <canvas> with nearest-neighbour scaling.
 */
function spritePreview(characterId: string): HTMLCanvasElement {
  const spec = getPlayerSpec(characterId);
  const sheet = renderSpec(spec);
  const scale = 5;

  const canvas = document.createElement('canvas');
  canvas.width = spec.width * scale;
  canvas.height = spec.height * scale;
  canvas.className = 'intro-sprite';
  canvas.style.imageRendering = 'pixelated';
  canvas.style.height = '100%';
  canvas.style.width = 'auto';
  canvas.setAttribute('aria-hidden', 'true');

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  // Frame 0 only (the stand pose) from the horizontal strip.
  ctx.drawImage(sheet, 0, 0, spec.width, spec.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}
