import type {
  CampDefinition,
  CampState,
  GameEvent,
  PlayerState,
} from "../game/simulation/types";

type SampleKey =
  | "build"
  | "cloth"
  | "confirm"
  | "fire-loop"
  | "flesh-hit"
  | "flesh-hit-heavy"
  | "footstep"
  | "metal-hit"
  | "pickup-soft"
  | "stone-hit"
  | "warning"
  | "weapon-swing"
  | "wolf-growl"
  | "wolf-howl"
  | "wood-hit";

const sampleUrl = (name: string): string => `${import.meta.env.BASE_URL}audio/sfx/${name}.mp3`;

const SAMPLE_FILES: Record<SampleKey, readonly string[]> = {
  build: [sampleUrl("build-1"), sampleUrl("build-2")],
  cloth: [sampleUrl("cloth-1"), sampleUrl("cloth-2")],
  confirm: [sampleUrl("confirm")],
  "fire-loop": [sampleUrl("fire-loop")],
  "flesh-hit": [sampleUrl("flesh-hit-1"), sampleUrl("flesh-hit-2")],
  "flesh-hit-heavy": [sampleUrl("flesh-hit-heavy")],
  footstep: [
    sampleUrl("footstep-1"),
    sampleUrl("footstep-2"),
    sampleUrl("footstep-3"),
    sampleUrl("footstep-4"),
  ],
  "metal-hit": [sampleUrl("metal-hit-1"), sampleUrl("metal-hit-2")],
  "pickup-soft": [sampleUrl("pickup-soft-1"), sampleUrl("pickup-soft-2")],
  "stone-hit": [sampleUrl("stone-hit-1"), sampleUrl("stone-hit-2")],
  warning: [sampleUrl("warning")],
  "weapon-swing": [sampleUrl("weapon-swing-1"), sampleUrl("weapon-swing-2")],
  "wolf-growl": [sampleUrl("wolf-growl-1"), sampleUrl("wolf-growl-2")],
  "wolf-howl": [sampleUrl("wolf-howl")],
  "wood-hit": [sampleUrl("wood-hit-1"), sampleUrl("wood-hit-2")],
};

const MASTER_VOLUME = 0.22;
const FOOTSTEP_STRIDE = 1.45;

/**
 * 真实采样负责动作质感，短合成音负责状态和连击等抽象反馈。
 * 采样加载失败时游戏仍可运行，对应事件会自动退回原来的合成音。
 */
export class SynthAudio {
  enabled = true;
  /** 广告期间的临时静音，独立于玩家的 enabled 开关。 */
  private adMuted = false;
  private context: AudioContext | null;
  private master: GainNode | null = null;
  private effectsBus: GainNode | null = null;
  private ambienceBus: GainNode | null = null;
  private fireGain: GainNode | null = null;
  private fireSource: AudioBufferSourceNode | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly samples = new Map<SampleKey, AudioBuffer[]>();
  private previousPlayerPosition: { x: number; z: number } | null = null;
  private footstepTravel = 0;
  private lastGrowlAt = -Infinity;

  /**
   * AudioContext 必须在用户手势里创建（iOS 上手势外创建出来的一律是 suspended，
   * 事后 resume 也救不回来）。开场没有按钮，第一次手势可能早于主包到达，
   * 所以它由 index.html 的内联脚本先建好，这里接管；没有就退回自己建。
   */
  constructor(context: AudioContext | null = null) {
    this.context = context;
  }

  /** 第一次手势晚于本对象构造时，接管内联引导创建的 context。 */
  adopt(context: AudioContext | null): void {
    if (context && !this.context) this.context = context;
  }

  async unlock(): Promise<void> {
    if (!this.context) this.context = new AudioContext();
    if (!this.master) {
      this.master = this.context.createGain();
      this.master.gain.value = MASTER_VOLUME;
      this.master.connect(this.context.destination);

      this.effectsBus = this.context.createGain();
      this.effectsBus.gain.value = 1;
      this.effectsBus.connect(this.master);

      this.ambienceBus = this.context.createGain();
      this.ambienceBus.gain.value = 0.72;
      this.ambienceBus.connect(this.master);
    }
    if (this.context.state === "suspended") await this.context.resume();
    // 不阻塞第一次操作；资源只有约 290 KB，加载完成后自动接管后续事件。
    void this.loadSamples();
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    this.applyGain();
    return this.enabled;
  }

  /** 广告期间压掉游戏声音，但不改变玩家自己的声音开关。 */
  setAdMuted(muted: boolean): void {
    this.adMuted = muted;
    this.applyGain();
  }

  private applyGain(): void {
    if (!this.master || !this.context) return;
    const audible = this.enabled && !this.adMuted;
    this.master.gain.setTargetAtTime(audible ? MASTER_VOLUME : 0, this.context.currentTime, 0.02);
  }

  /**
   * 距离驱动脚步，距离火堆越近篝火声越响。这里读取模拟快照，不改任何游戏状态。
   */
  update(
    player: PlayerState,
    camps: readonly CampState[],
    campDefinitions: readonly CampDefinition[],
    movementActive: boolean,
  ): void {
    this.updateFootsteps(player, movementActive);
    this.updateCampfire(player, camps, campDefinitions);
  }

  handle(event: GameEvent): void {
    if (!this.enabled || this.adMuted || !this.context || !this.master) return;
    switch (event.type) {
      case "pickup":
        if (event.kind === "stone") this.playSample("stone-hit", 0.24, 1.25);
        else if (event.kind === "wood" || event.kind === "stake") this.playSample("wood-hit", 0.28, 1.2);
        else if (event.kind === "iron-ore" || event.kind === "fuel") this.playSample("metal-hit", 0.3, 1.12);
        else if (!this.playSample("pickup-soft", 0.32, 1.08)) {
          this.tone(event.kind === "cactus-juice" ? 620 : 360, 0.08, "sine", 0.6, 1.25);
        }
        break;
      case "drop":
        if (event.kind === "stone") this.playSample("stone-hit", 0.58, 0.9);
        else if (event.kind === "stake") this.playSample("wood-hit", 0.52, 0.92);
        else this.playSample("metal-hit", 0.48, 0.82);
        break;
      case "fuel-loaded":
        this.playSample("metal-hit", 0.4, 0.84);
        window.setTimeout(() => this.playSample("confirm", 0.42, 0.95 + event.loaded * 0.035), 80);
        break;
      case "truck-depart":
        this.tone(70, 1.1, "sawtooth", 0.9, 1.35);
        window.setTimeout(() => this.tone(105, 0.9, "square", 0.55, 1.5), 240);
        break;
      case "feed-fire":
        this.playSample("wood-hit", 0.38, 0.92);
        this.noise(0.28, 0.46);
        break;
      case "eat":
        if (!this.playSample("pickup-soft", 0.2, 0.72)) this.tone(480, 0.11, "sine", 0.4, 1.2);
        break;
      case "drink":
        this.tone(680, 0.14, "sine", 0.32, 0.55);
        break;
      case "draw-water":
        this.noise(0.22, 0.22);
        break;
      case "exhausted":
        if (!this.playSample("warning", 0.34, 0.9)) this.tone(140, 0.13, "triangle", 0.3, 0.6);
        break;
      case "condition":
        if (event.condition === "heatstroke") this.tone(300, 0.4, "sawtooth", 0.4, 1.9);
        else if (event.condition === "hypothermia") this.tone(300, 0.5, "sine", 0.45, 0.35);
        else this.tone(430, 0.22, "sine", 0.3, 1.15);
        break;
      case "victory":
        this.playSample("confirm", 0.58, 0.9);
        this.tone(420, 0.3, "triangle", 0.6, 1.35);
        window.setTimeout(() => this.tone(560, 0.32, "triangle", 0.55, 1.3), 180);
        window.setTimeout(() => this.tone(720, 0.6, "sine", 0.5, 1.2), 380);
        break;
      case "loot-drop":
        this.playSample(event.kind === "iron-ore" ? "metal-hit" : "pickup-soft", 0.22, 1.18);
        break;
      case "cook":
        this.noise(0.18, 0.3);
        this.playSample("confirm", 0.24, 0.8);
        break;
      case "craft-coat":
        this.playSample("cloth", 0.5, 0.95);
        window.setTimeout(() => this.playSample("confirm", 0.34, 0.9), 110);
        break;
      case "craft-weapon":
        this.playSample("metal-hit", 0.55, 0.9);
        window.setTimeout(() => this.playSample("confirm", 0.38, 1.02), 100);
        break;
      case "build":
        this.playSample("build", 0.62, 0.92);
        break;
      case "structure-destroyed":
        this.playSample("wood-hit", 0.78, 0.72);
        window.setTimeout(() => this.playSample("build", 0.48, 0.7), 75);
        break;
      case "thermal":
        this.tone(event.direction === "warm" ? 240 : 560, 0.16, "sine", 0.26,
          event.direction === "warm" ? 1.45 : 0.72);
        break;
      case "rest":
        if (event.active) this.tone(210, 0.14, "sine", 0.16, 0.85);
        break;
      case "attack":
        if (!this.playSample("weapon-swing", 0.52, 0.94 + Math.random() * 0.12)) this.noise(0.08, 0.38);
        break;
      case "wolf-hit":
        this.playSample("flesh-hit", 0.64, 0.9 + Math.random() * 0.12);
        this.maybeGrowl(0.32);
        break;
      case "crit":
        this.playSample("metal-hit", 0.58, 1.18);
        this.tone(880, 0.09, "square", 0.5, 2.4);
        window.setTimeout(() => this.tone(1320, 0.11, "triangle", 0.34, 1.9), 45);
        break;
      case "combo":
        if (event.stacks > 0) this.tone(420 + event.stacks * 110, 0.07, "sine", 0.26, 1.5);
        break;
      case "knockback":
        this.playSample("flesh-hit-heavy", 0.62, 0.88);
        this.tone(90, 0.1, "sine", 0.34, 0.6);
        break;
      case "dodge":
        this.playSample("weapon-swing", 0.26, 1.32);
        this.tone(640, 0.09, "sine", 0.22, 1.8);
        break;
      case "thorns":
        this.playSample("metal-hit", 0.42, 1.32);
        break;
      case "wolf-killed":
        this.playSample("flesh-hit-heavy", 0.68, 0.74);
        this.maybeGrowl(0.58, true);
        break;
      case "critter-hit":
        this.playSample("flesh-hit", 0.48, 1.12);
        break;
      case "critter-killed":
        this.playSample("flesh-hit-heavy", event.kind === "oryx" ? 0.68 : 0.48,
          event.kind === "oryx" ? 0.76 : 1.05);
        break;
      case "player-hit":
        this.playSample("flesh-hit-heavy", 0.78, 0.78);
        this.tone(75, 0.2, "sawtooth", 0.62, 0.45);
        break;
      case "barrier-hit":
        this.playSample(event.material === "stone" ? "stone-hit" : "wood-hit", 0.54,
          0.88 + Math.random() * 0.12);
        break;
      case "phase":
        this.phaseCue(event.phase === "night");
        if (event.phase === "night") window.setTimeout(() => this.playSample("wolf-howl", 0.42, 0.94), 260);
        else this.playSample("confirm", 0.24, 1.14);
        break;
      case "revive":
        this.playSample("confirm", 0.55, 1.1);
        this.tone(260, 0.42, "sine", 0.45, 2.1);
        break;
      case "game-over":
        this.playSample("warning", 0.42, 0.62);
        this.tone(170, 0.7, "triangle", 0.75, 0.35);
        break;
      case "message":
        break;
    }
  }

  private async loadSamples(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    const context = this.context;
    if (!context) return;
    this.loadPromise = Promise.all((Object.keys(SAMPLE_FILES) as SampleKey[]).map(async (key) => {
      const decoded = await Promise.all(SAMPLE_FILES[key].map(async (url): Promise<AudioBuffer | null> => {
        try {
          const response = await fetch(url, { cache: "force-cache" });
          if (!response.ok) return null;
          return await context.decodeAudioData(await response.arrayBuffer());
        } catch {
          return null;
        }
      }));
      const available = decoded.filter((buffer): buffer is AudioBuffer => buffer !== null);
      if (available.length > 0) this.samples.set(key, available);
    })).then(() => undefined);
    return this.loadPromise;
  }

  private playSample(key: SampleKey, volume = 1, playbackRate = 1): boolean {
    if (!this.enabled || this.adMuted || !this.context || !this.effectsBus) return false;
    const variants = this.samples.get(key);
    if (!variants?.length) return false;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = variants[Math.floor(Math.random() * variants.length)];
    source.playbackRate.value = playbackRate;
    gain.gain.value = volume;
    source.connect(gain).connect(this.effectsBus);
    source.start();
    return true;
  }

  private updateFootsteps(player: PlayerState, movementActive: boolean): void {
    const previous = this.previousPlayerPosition;
    this.previousPlayerPosition = { x: player.x, z: player.z };
    if (!previous || !movementActive) {
      this.footstepTravel = 0;
      return;
    }
    const distance = Math.hypot(player.x - previous.x, player.z - previous.z);
    // 复活、传送或掉帧后的大跳不能被误听成一串脚步。
    if (distance > 2) {
      this.footstepTravel = 0;
      return;
    }
    this.footstepTravel += distance;
    if (this.footstepTravel < FOOTSTEP_STRIDE) return;
    this.footstepTravel %= FOOTSTEP_STRIDE;
    this.playSample("footstep", player.carrying ? 0.34 : 0.28,
      (player.carrying ? 0.9 : 1) * (0.94 + Math.random() * 0.12));
  }

  private updateCampfire(
    player: PlayerState,
    camps: readonly CampState[],
    campDefinitions: readonly CampDefinition[],
  ): void {
    if (!this.context || !this.ambienceBus) return;
    let target = 0;
    for (const camp of camps) {
      if (camp.fuel <= 0) continue;
      const definition = campDefinitions.find((candidate) => candidate.id === camp.id);
      if (!definition) continue;
      const distance = Math.hypot(player.x - definition.x, player.z - definition.z);
      target = Math.max(target, Math.max(0, Math.min(1, 1 - (distance - 1.5) / 11)) * 0.72);
    }
    if (target > 0.001) this.ensureFireLoop();
    if (this.fireGain) this.fireGain.gain.setTargetAtTime(target, this.context.currentTime, 0.24);
  }

  private ensureFireLoop(): void {
    if (this.fireSource || !this.context || !this.ambienceBus) return;
    const buffer = this.samples.get("fire-loop")?.[0];
    if (!buffer) return;
    this.fireGain = this.context.createGain();
    this.fireGain.gain.value = 0;
    this.fireGain.connect(this.ambienceBus);
    this.fireSource = this.context.createBufferSource();
    this.fireSource.buffer = buffer;
    this.fireSource.loop = true;
    this.fireSource.connect(this.fireGain);
    this.fireSource.start();
  }

  private maybeGrowl(volume: number, force = false): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    if (!force && (now - this.lastGrowlAt < 1.1 || Math.random() > 0.34)) return;
    this.lastGrowlAt = now;
    this.playSample("wolf-growl", volume, 0.82 + Math.random() * 0.16);
  }

  private tone(frequency: number, duration: number, type: OscillatorType, volume: number, endRatio: number): void {
    if (!this.context || !this.effectsBus) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, frequency * endRatio), now + duration);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    oscillator.connect(gain).connect(this.effectsBus);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  private noise(duration: number, volume: number): void {
    if (!this.context || !this.effectsBus) return;
    const samples = Math.ceil(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, samples, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < samples; index += 1) {
      data[index] = (Math.random() * 2 - 1) * (1 - index / samples);
    }
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    filter.type = "lowpass";
    filter.frequency.value = 680;
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(filter).connect(gain).connect(this.effectsBus);
    source.start();
  }

  private phaseCue(night: boolean): void {
    const notes = night ? [220, 164, 110] : [220, 330, 440];
    notes.forEach((frequency, index) => {
      window.setTimeout(() => this.tone(frequency, 0.32, "triangle", 0.45, night ? 0.8 : 1.08), index * 120);
    });
  }
}
