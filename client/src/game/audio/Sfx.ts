/**
 * Tiny procedural sound effects synthesized with the Web Audio API — no audio
 * asset files, matching the project's "authored in code" ethos. Used for the
 * enemy hunt: a cartoon SCREAM when an enemy is cornered to death, and a BOOM
 * when it explodes.
 *
 * The AudioContext can only start after a user gesture; the intro overlay click
 * provides one. We lazily create + resume the context on first play, and fail
 * silently if the browser still blocks it (audio is a bonus, never required).
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  /** Lazily create / resume the audio context. Returns null if unavailable. */
  private ensure(): AudioContext | null {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try {
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.45;
        this.master.connect(this.ctx.destination);
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** A short white-noise buffer, created once and reused. */
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 0.7);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** A panicked, wavering descending shriek — the cornered enemy's scream. */
  playScream(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const dur = 0.5;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(820, now);
    osc.frequency.exponentialRampToValueAtTime(1500, now + 0.12); // gasp up
    osc.frequency.exponentialRampToValueAtTime(240, now + dur); // wail down

    // Vibrato for the wavering "aaah".
    const vib = ctx.createOscillator();
    vib.frequency.value = 22;
    const vibGain = ctx.createGain();
    vibGain.gain.value = 90;
    vib.connect(vibGain).connect(osc.frequency);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.5, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(gain).connect(this.master);
    osc.start(now);
    vib.start(now);
    osc.stop(now + dur);
    vib.stop(now + dur);
  }

  /** A filtered noise thump — the explosion pop. */
  playExplosion(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const dur = 0.45;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, now);
    lp.frequency.exponentialRampToValueAtTime(120, now + dur);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(lp).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + dur);
  }
}
