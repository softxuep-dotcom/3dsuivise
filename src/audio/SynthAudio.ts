import type { GameEvent } from "../game/simulation/types";

export class SynthAudio {
  enabled = true;
  private context: AudioContext | null;
  private master: GainNode | null = null;

  /**
   * "踏入沙海"的点击可能发生在主包到达之前，而 AudioContext 必须在那次用户手势里创建
   * （iOS 上手势外创建出来的一律是 suspended，事后 resume 也救不回来）。
   * 所以它由 index.html 的内联脚本先建好，这里接管；没有就退回自己建。
   */
  constructor(context: AudioContext | null = null) {
    this.context = context;
  }

  async unlock(): Promise<void> {
    if (!this.context) this.context = new AudioContext();
    if (!this.master) {
      this.master = this.context.createGain();
      this.master.gain.value = 0.18;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === "suspended") await this.context.resume();
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.enabled ? 0.18 : 0, this.context.currentTime, 0.02);
    }
    return this.enabled;
  }

  handle(event: GameEvent): void {
    if (!this.enabled || !this.context || !this.master) return;
    switch (event.type) {
      case "pickup":
        this.tone(event.kind === "cactus-juice" ? 620 : 360, 0.08, "sine", 0.6, 1.25);
        break;
      case "drop":
        this.tone(event.kind === "stone" ? 95 : 150, 0.1, "triangle", 0.85, 0.7);
        break;
      case "feed-fire":
        this.noise(0.28, 0.7);
        this.tone(240, 0.18, "sine", 0.45, 1.55);
        break;
      case "eat":
        this.tone(480, 0.11, "sine", 0.4, 1.2);
        break;
      case "drink":
        this.tone(680, 0.14, "sine", 0.32, 0.55);
        break;
      case "draw-water":
        this.noise(0.22, 0.22);
        break;
      case "exhausted":
        this.tone(140, 0.13, "triangle", 0.3, 0.6);
        break;
      case "condition":
        // 中暑往上滑、失温往下滑，恢复正常则是一个安定的中音。
        if (event.condition === "heatstroke") this.tone(300, 0.4, "sawtooth", 0.4, 1.9);
        else if (event.condition === "hypothermia") this.tone(300, 0.5, "sine", 0.45, 0.35);
        else this.tone(430, 0.22, "sine", 0.3, 1.15);
        break;
      case "alpha-spawned":
        this.tone(85, 0.9, "sawtooth", 0.95, 0.6);
        window.setTimeout(() => this.tone(120, 0.7, "square", 0.6, 0.5), 260);
        break;
      case "victory":
        this.tone(420, 0.3, "triangle", 0.6, 1.35);
        window.setTimeout(() => this.tone(560, 0.32, "triangle", 0.55, 1.3), 180);
        window.setTimeout(() => this.tone(720, 0.6, "sine", 0.5, 1.2), 380);
        break;
      case "loot-drop":
        this.tone(event.kind === "hide" ? 280 : 190, 0.1, "triangle", 0.35, 1.4);
        break;
      case "cook":
        this.noise(0.18, 0.34);
        this.tone(310, 0.22, "sine", 0.35, 1.35);
        break;
      case "craft-coat":
        this.tone(260, 0.18, "triangle", 0.45, 1.5);
        window.setTimeout(() => this.tone(390, 0.22, "triangle", 0.4, 1.25), 90);
        break;
      case "craft-weapon":
        this.tone(190, 0.1, "square", 0.42, 1.7);
        window.setTimeout(() => this.tone(520, 0.24, "triangle", 0.38, 1.18), 100);
        break;
      case "rest":
        if (event.active) this.tone(210, 0.14, "sine", 0.16, 0.85);
        break;
      case "attack":
        this.noise(0.08, 0.38);
        break;
      case "wolf-hit":
        this.tone(110, 0.12, "sawtooth", 0.65, 0.55);
        break;
      // 重创、连击、闪避、反伤、击退各有独立的声音。
      // 剑三阶 40% 的重创率、四段连击 —— 听不出区别就等于没有这些机制。
      case "crit":
        this.tone(880, 0.09, "square", 0.5, 2.4);
        window.setTimeout(() => this.tone(1320, 0.11, "triangle", 0.34, 1.9), 45);
        break;
      case "combo":
        // 音高随层数往上爬，玩家不用看 HUD 也知道自己攒到第几段了。
        if (event.stacks > 0) this.tone(420 + event.stacks * 110, 0.07, "sine", 0.26, 1.5);
        break;
      case "knockback":
        this.noise(0.07, 0.3);
        this.tone(90, 0.1, "sine", 0.4, 0.6);
        break;
      case "dodge":
        // 闪避是"什么都没发生"，所以声音要轻、要往上走 —— 和挨打的下沉音相反。
        this.noise(0.06, 0.22);
        this.tone(640, 0.09, "sine", 0.22, 1.8);
        break;
      case "thorns":
        this.tone(1180, 0.06, "square", 0.24, 0.7);
        break;
      case "wolf-killed":
        this.tone(170, 0.28, "triangle", 0.8, 0.45);
        break;
      case "critter-hit":
        this.tone(240, 0.08, "square", 0.4, 0.6);
        break;
      case "critter-killed":
        // 长角羚是大猎物，给一个更沉更长的音，和小猎物区分开。
        if (event.kind === "oryx") this.tone(150, 0.4, "triangle", 0.75, 0.42);
        else this.tone(330, 0.18, "triangle", 0.5, 0.5);
        break;
      case "player-hit":
        this.tone(75, 0.22, "sawtooth", 0.9, 0.45);
        break;
      case "barrier-hit":
        this.tone(120, 0.07, "square", 0.3, 0.8);
        break;
      case "phase":
        this.phaseCue(event.phase === "night");
        break;
      case "game-over":
        this.tone(170, 0.7, "triangle", 0.75, 0.35);
        break;
      case "message":
        break;
    }
  }

  private tone(frequency: number, duration: number, type: OscillatorType, volume: number, endRatio: number): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, frequency * endRatio), now + duration);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  private noise(duration: number, volume: number): void {
    if (!this.context || !this.master) return;
    const samples = Math.ceil(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, samples, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < samples; index += 1) data[index] = (Math.random() * 2 - 1) * (1 - index / samples);
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    filter.type = "lowpass";
    filter.frequency.value = 680;
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(filter).connect(gain).connect(this.master);
    source.start();
  }

  private phaseCue(night: boolean): void {
    if (!this.context) return;
    const notes = night ? [220, 164, 110] : [220, 330, 440];
    notes.forEach((frequency, index) => {
      window.setTimeout(() => this.tone(frequency, 0.32, "triangle", 0.55, night ? 0.8 : 1.08), index * 120);
    });
  }
}
