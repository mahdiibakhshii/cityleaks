import { enemyDef } from '../../../shared/protocol';

export interface HuntUICallbacks {
  /** Popup opened — caller should freeze player movement. */
  onOpen: () => void;
  /** Popup dismissed (Continue) — caller should resume movement. */
  onClose: () => void;
}

/**
 * The "you did it" beat: a blocking success popup shown on the screens of the
 * hunters credited with a kill (the players near the trapped enemy). It freezes
 * the player until they hit Continue, and tallies the session's kills for a
 * little escalating reward. DOM built in code, styled by `.hunt-*` classes in
 * styles/main.css.
 */
export class HuntUI {
  private readonly cb: HuntUICallbacks;
  private readonly modal: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly subtitle: HTMLDivElement;
  private readonly tally: HTMLDivElement;
  private kills = 0;
  private open = false;

  constructor(callbacks: HuntUICallbacks) {
    this.cb = callbacks;

    this.modal = document.createElement('div');
    this.modal.className = 'hunt-modal';

    const panel = document.createElement('div');
    panel.className = 'hunt-panel';

    const burst = document.createElement('div');
    burst.className = 'hunt-burst';
    burst.textContent = '💥';

    this.title = document.createElement('div');
    this.title.className = 'hunt-title';
    this.title.textContent = 'Trapped!';

    this.subtitle = document.createElement('div');
    this.subtitle.className = 'hunt-subtitle';

    this.tally = document.createElement('div');
    this.tally.className = 'hunt-tally';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hunt-btn';
    button.textContent = 'Continue the hunt';
    button.addEventListener('click', () => this.hide());

    panel.append(burst, this.title, this.subtitle, this.tally, button);
    this.modal.appendChild(panel);
    document.body.appendChild(this.modal);
  }

  /** Show the success popup crediting a kill of the given enemy kind. */
  showSuccess(kind: string): void {
    this.kills++;
    const name = enemyDef(kind).name;
    this.subtitle.textContent = `You and your crew took down ${name}.`;
    this.tally.textContent =
      this.kills === 1 ? 'First catch of the session' : `${this.kills} caught this session`;
    if (!this.open) {
      this.open = true;
      this.modal.classList.add('visible');
      this.cb.onOpen();
    }
  }

  private hide(): void {
    if (!this.open) return;
    this.open = false;
    this.modal.classList.remove('visible');
    this.cb.onClose();
  }

  dispose(): void {
    this.modal.remove();
  }
}
