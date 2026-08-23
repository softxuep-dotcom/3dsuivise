import type {
  CampDefinition,
  CampState,
  GameEvent,
  PlayerState,
} from "../game/simulation/types";

/**
 * 只留四个采样。
 *
 * 一度铺满了 15 组真实采样（脚步、挥砍、各种材质撞击、皮革、狼吠…），
 * 结果是战斗里同时有五六种敲击声在响 —— 铁甲反伤每挨一口就"当"一记金属，
 * 玩下来像在打铁铺。真实采样在这种密度下互相打架，反而不如合成音干净。
 *
 * 判断标准变成一条：**这个声音是不是"一直在响"的？**
 *   - `fire-loop` 与 `wolf-howl` 是**氛围**，各自一个，永远不会撞在一起；
 *   - `confirm` / `warning` 是 **UI 反馈**，玩家主动操作才出现，天然稀疏。
 * 其余高频的战斗与采集反馈全部退回合成音：短、闷、音量小，叠在一起也不刺耳。
 */
type SampleKey = "confirm" | "fire-loop" | "warning" | "wolf-howl";

const sampleUrl = (name: string): string => `${import.meta.env.BASE_URL}audio/sfx/${name}.mp3`;

const SAMPLE_FILES: Record<SampleKey, readonly string[]> = {
  confirm: [sampleUrl("confirm")],
  "fire-loop": [sampleUrl("fire-loop")],
  warning: [sampleUrl("warning")],
  "wolf-howl": [sampleUrl("wolf-howl")],
};

const MASTER_VOLUME = 0.22;
/**
 * 步距 = BASE + PER_SPEED × 移速。见 updateFootsteps —— 固定步距会让频率
 * 和速度严格线性，满速跑出 5.7 步/秒，那是真人冲刺的近两倍。
 */
const FOOTSTEP_STRIDE_BASE = 1.04;
const FOOTSTEP_STRIDE_PER_SPEED = 0.21;

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
  private engineGain: GainNode | null = null;
  private engineSource: OscillatorNode | null = null;
  /** 每个音色上次播放的时刻，供 playSample 的节流用。 */
  private readonly lastSampleAt = new Map<SampleKey, number>();
  /** 闷响的节流表，按截止频率分桶，见 thudThrottled。 */
  private readonly lastThudAt = new Map<number, number>();
  private previousPlayerPosition: { x: number; z: number } | null = null;
  private footstepTravel = 0;
  private footstepLeft = false;
  private lastFootstepCheck = 0;
  private loadPromise: Promise<void> | null = null;
  private readonly samples = new Map<SampleKey, AudioBuffer[]>();

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
  /** 每帧的持续音：脚步与篝火。 */
  update(
    player: PlayerState,
    camps: readonly CampState[],
    campDefinitions: readonly CampDefinition[],
    movementActive: boolean,
    truck: { x: number; z: number; loaded: number },
  ): void {
    this.updateFootsteps(player, movementActive);
    this.updateCampfire(player, camps, campDefinitions);
    this.updateTruckEngine(player, truck);
  }

  /**
   * 脚步。合成的一记闷响，不用采样。
   *
   * ## 步距随速度增长，不是固定值
   *
   * 旧实现用固定步距 1.45，于是频率和速度**严格线性**：满速 8.2 就是
   * 5.7 步/秒 —— 真人冲刺才 2.7~3.0 步/秒（160~180 步/分），
   * 快了近一倍，听起来就是"哒哒哒哒"的机枪声。
   *
   * 现实里人走快时**步幅也变大**，所以频率增长是次线性的。
   * 这里用 `步距 = 1.04 + 0.21 × 移速` 拟合：
   *
   *     满速 8.2  → 3.0 步/秒      扛油桶 4.4 → 2.2 步/秒
   *     中暑 3.3  → 1.9 步/秒      失温   2.1 → 1.4 步/秒
   *
   * 全部落在真人区间里，而各种减速状态仍然听得出差别 —— 压缩了但没抹平。
   * 这一条顺带让脚步成了**移速的听觉表**：扛着桶跑起来节奏明显变沉，
   * 玩家不用看数值就知道自己慢了。
   *
   * ## 为什么音量压得很低
   *
   * 手机端只有 25~40% 的玩家开着声音，脚步因此**不能承载任何信息**，
   * 它只是质感垫底。沙地本来也是软的：低通 260 Hz、55 毫秒、音量 0.09，
   * 左右脚交替微调音高，避免听成同一个音在复读。
   */
  private updateFootsteps(player: PlayerState, movementActive: boolean): void {
    const previous = this.previousPlayerPosition;
    this.previousPlayerPosition = { x: player.x, z: player.z };
    if (!previous || !movementActive || player.resting || !this.context) {
      this.footstepTravel = 0;
      return;
    }
    const now = this.context.currentTime;
    const elapsed = now - this.lastFootstepCheck;
    this.lastFootstepCheck = now;
    const distance = Math.hypot(player.x - previous.x, player.z - previous.z);
    if (distance <= 0 || elapsed <= 0 || elapsed > 0.5) return;

    const speed = distance / elapsed;
    const stride = FOOTSTEP_STRIDE_BASE + FOOTSTEP_STRIDE_PER_SPEED * speed;
    this.footstepTravel += distance;
    if (this.footstepTravel < stride) return;
    this.footstepTravel %= stride;

    // 左右脚交替：右脚略沉一点，两只脚不完全一样才不像复读。
    this.footstepLeft = !this.footstepLeft;
    const cutoff = this.footstepLeft ? 280 : 240;
    // 扛着东西时脚更重：低一档、响一点。
    const laden = player.carrying !== null;
    this.thud(0.055, laden ? 0.12 : 0.09, laden ? cutoff * 0.8 : cutoff);
  }

  handle(event: GameEvent): void {
    if (!this.enabled || this.adMuted || !this.context || !this.master) return;
    switch (event.type) {
      /*
       * 材质靠**低通截止**区分，不靠不同的采样：石头亮、木头中、金属稍高、
       * 软物最闷。全部落在同一个原语上，同时响也只是叠成一记更厚的闷响。
       */
      case "pickup":
        this.thud(0.07, 0.2, event.kind === "stone" ? 900
          : event.kind === "wood" || event.kind === "stake" ? 620
            : event.kind === "iron-ore" || event.kind === "fuel" ? 1100 : 420);
        if (event.kind === "cactus-juice" || event.kind === "water") {
          this.tone(event.kind === "cactus-juice" ? 620 : 520, 0.07, "sine", 0.18, 1.25);
        }
        break;
      case "drop":
        this.thud(0.13, 0.34, event.kind === "stone" ? 420 : event.kind === "stake" ? 320 : 500);
        break;
      case "fuel-loaded":
        this.thud(0.12, 0.3, 560);
        window.setTimeout(() => this.playSample("confirm", 0.42, 0.95 + event.loaded * 0.035), 80);
        if (event.loaded === 1) this.tone(440, 0.13, "square", 0.2, 1.8);
        if (event.loaded === 2) {
          this.tone(620, 0.16, "sine", 0.24, 1.18);
          window.setTimeout(() => this.tone(760, 0.12, "sine", 0.2, 1.08), 90);
        }
        if (event.loaded === 3) {
          this.tone(155, 0.34, "square", 0.3, 0.86);
          window.setTimeout(() => this.tone(132, 0.3, "square", 0.24, 0.92), 105);
        }
        if (event.loaded === 5) this.tone(48, 0.75, "sawtooth", 0.4, 1.7);
        if (event.loaded >= event.required) {
          window.setTimeout(() => this.tone(330, 0.34, "triangle", 0.34, 1.5), 160);
        }
        break;
      case "truck-horn":
        this.tone(148, 0.46, "square", 0.54, 0.86);
        window.setTimeout(() => this.tone(124, 0.4, "square", 0.4, 0.94), 95);
        break;
      case "truck-depart":
        this.tone(70, 1.1, "sawtooth", 0.9, 1.35);
        window.setTimeout(() => this.tone(105, 0.9, "square", 0.55, 1.5), 240);
        break;
      case "feed-fire":
        this.noise(0.28, 0.34);
        break;
      case "eat":
        this.tone(480, 0.11, "sine", 0.3, 1.2);
        break;
      case "drink":
        this.tone(680, 0.14, "sine", 0.28, 0.55);
        break;
      case "draw-water":
        this.noise(0.22, 0.2);
        break;
      case "exhausted":
        this.playSample("warning", 0.3, 0.9, 900);
        break;
      case "condition":
        if (event.condition === "heatstroke") this.tone(300, 0.4, "sawtooth", 0.34, 1.9);
        else if (event.condition === "hypothermia") this.tone(300, 0.5, "sine", 0.38, 0.35);
        else this.tone(430, 0.22, "sine", 0.26, 1.15);
        break;
      case "victory":
        this.playSample("confirm", 0.58, 0.9);
        this.tone(420, 0.3, "triangle", 0.6, 1.35);
        window.setTimeout(() => this.tone(560, 0.32, "triangle", 0.55, 1.3), 180);
        window.setTimeout(() => this.tone(720, 0.6, "sine", 0.5, 1.2), 380);
        break;
      case "loot-drop":
        this.thud(0.06, 0.14, event.kind === "iron-ore" ? 1000 : 460);
        break;
      case "cook":
        this.noise(0.18, 0.24);
        this.playSample("confirm", 0.24, 0.8);
        break;
      case "craft-coat":
        this.noise(0.16, 0.22);
        window.setTimeout(() => this.playSample("confirm", 0.34, 0.9), 110);
        break;
      case "craft-weapon":
        this.thud(0.1, 0.3, 900);
        window.setTimeout(() => this.playSample("confirm", 0.38, 1.02), 100);
        break;
      case "build":
        this.thud(0.11, 0.34, 540);
        window.setTimeout(() => this.thud(0.09, 0.24, 460), 90);
        break;
      case "structure-destroyed":
        this.thud(0.26, 0.42, 380);
        this.tone(180, 0.24, "triangle", 0.3, 0.5);
        break;
      case "thermal":
        this.tone(event.direction === "warm" ? 240 : 560, 0.16, "sine", 0.24,
          event.direction === "warm" ? 1.45 : 0.72);
        break;
      case "rest":
        if (event.active) this.tone(210, 0.14, "sine", 0.16, 0.85);
        break;
      /*
       * 挥砍：带通白噪 + 频率下扫（见 swoosh）。每次随机一点起手频率，
       * 连挥不会听成复读；0.55 秒的冷却下这个长度（0.15 秒）刚好不重叠。
       */
      case "attack":
        this.swoosh(0.15, 0.26, 1700 + Math.random() * 500, 380);
        break;
      case "wolf-hit":
        this.thud(0.09, 0.34, 340);
        break;
      case "crit":
        // 重创的签名就是这两个上扬音。原先在它们下面还垫了一记亮金属敲击，
        // 而剑三阶 40% 的触发率意味着那一记几乎每秒都来 —— 现在只留音。
        this.tone(880, 0.09, "square", 0.42, 2.4);
        window.setTimeout(() => this.tone(1320, 0.11, "triangle", 0.3, 1.9), 45);
        break;
      case "combo":
        if (event.stacks > 0) this.tone(420 + event.stacks * 110, 0.07, "sine", 0.24, 1.5);
        break;
      case "knockback":
        this.thud(0.14, 0.34, 260);
        this.tone(90, 0.1, "sine", 0.3, 0.6);
        break;
      case "dodge":
        // 闪避是"擦身而过"，用更短更高的一记风声，和挥砍区分开。
        this.swoosh(0.09, 0.16, 2600, 900, 1.6);
        break;
      case "thorns":
        /*
         * 反伤**每挨一口就触发**，是持续状态而不是事件。原先它是一记明亮的金属敲击，
         * 穿铁甲守夜时每口咬击都"当"一声 —— 这是"打铁铺"感的主要来源。
         * 现在压成一记很轻的低频闷响，再加 260 ms 间隔：一群狗同时咬只响一次。
         */
        this.thudThrottled(0.08, 0.14, 200, 260);
        break;
      case "wolf-killed":
        this.thud(0.2, 0.4, 260);
        this.tone(140, 0.18, "triangle", 0.26, 0.55);
        break;
      case "critter-hit":
        this.thud(0.07, 0.22, 420);
        break;
      case "critter-killed":
        this.thud(event.kind === "oryx" ? 0.2 : 0.1, event.kind === "oryx" ? 0.36 : 0.22,
          event.kind === "oryx" ? 280 : 460);
        break;
      case "player-hit":
        // 夜里常有三五只同时咬到，节流成一记，否则糊成一坨。
        this.thudThrottled(0.16, 0.4, 240, 90);
        this.tone(75, 0.2, "sawtooth", 0.5, 0.45);
        break;
      case "barrier-hit":
        this.thud(0.1, 0.26, event.material === "stone" ? 700 : 480);
        break;
      case "phase":
        this.phaseCue(event.phase === "night");
        // 第一夜的那一声要压过其余所有反馈：那是整局唯一一次"狼群第一次出现"，
        // 而第一夜教学正好在这一刻停住时间、把镜头推向营火。之后的夜晚是常态，
        // 音量退回氛围级别，免得每天听一次同样的惊吓。
        if (event.phase === "night") {
          const first = event.day === 1;
          window.setTimeout(() => this.playSample("wolf-howl", first ? 0.72 : 0.42, first ? 0.88 : 0.94), 260);
        } else this.playSample("confirm", 0.24, 1.14);
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

  /**
   * 放一个采样。`minGapMs` 是**同一个音色的最小间隔**。
   *
   * 没有它的时候，五只狗同时咬就是五声一模一样的金属响叠在一起 ——
   * 铁甲的反伤（thorns）每挨一口就响一次，夜里几十只狗轮流上，
   * 整局听起来像在打铁铺。`maybeGrowl` 早就自己做了 1.1 秒的节流，
   * 只是没推广到别处；这里把它变成所有采样的公共能力。
   *
   * 默认 45 ms 只合并"同一帧里同时触发"的那种重叠，不改变任何现有节奏；
   * 高频事件在调用处各自给更大的间隔。
   */
  private playSample(key: SampleKey, volume = 1, playbackRate = 1, minGapMs = 45): boolean {
    if (!this.enabled || this.adMuted || !this.context || !this.effectsBus) return false;
    const variants = this.samples.get(key);
    if (!variants?.length) return false;
    const now = this.context.currentTime;
    if (now - (this.lastSampleAt.get(key) ?? -Infinity) < minGapMs / 1000) return true;
    this.lastSampleAt.set(key, now);
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = variants[Math.floor(Math.random() * variants.length)];
    source.playbackRate.value = playbackRate;
    gain.gain.value = volume;
    source.connect(gain).connect(this.effectsBus);
    source.start();
    return true;
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

  /** 第五桶后发动机成为一条近场环境音；距离衰减，不把全地图变成持续低鸣。 */
  private updateTruckEngine(player: PlayerState, truck: { x: number; z: number; loaded: number }): void {
    if (!this.context || !this.ambienceBus) return;
    const distance = Math.hypot(player.x - truck.x, player.z - truck.z);
    const target = truck.loaded >= 5 ? Math.max(0, Math.min(1, 1 - (distance - 3) / 24)) * 0.2 : 0;
    if (target > 0.001) this.ensureEngineLoop();
    if (this.engineGain) this.engineGain.gain.setTargetAtTime(target, this.context.currentTime, 0.32);
  }

  private ensureEngineLoop(): void {
    if (this.engineSource || !this.context || !this.ambienceBus) return;
    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 170;
    filter.Q.value = 1.4;
    this.engineGain = this.context.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.ambienceBus);
    this.engineSource = this.context.createOscillator();
    this.engineSource.type = "sawtooth";
    this.engineSource.frequency.value = 54;
    this.engineSource.connect(filter).connect(this.engineGain);
    this.engineSource.start();
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

  /**
   * 挥砍的风声。**重做的攻击音就是这个。**
   *
   * 原来用的是 weapon-swing 采样：一记很干的"唰"，两个变体轮换，
   * 0.55 秒冷却下连着按就是机关枪，而且它和命中的 flesh-hit 抢同一个频段。
   *
   * 换成带通滤波的白噪 + **频率下扫**：起手在高频（空气被劈开），
   * 收尾掉到中低频（力道落下去）。听感上是"挥"而不是"敲"，
   * 而且能量集中在一小段带宽里，连挥也不会糊成一片。
   * 包络是先冲后落（前 18% 冲到顶），这一下让它有"甩"的重量感。
   */
  private swoosh(duration: number, volume: number, fromHz: number, toHz: number, q = 1.1): void {
    if (!this.context || !this.effectsBus) return;
    const now = this.context.currentTime;
    const samples = Math.ceil(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, samples, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    const peak = Math.max(1, Math.floor(samples * 0.18));
    for (let index = 0; index < samples; index += 1) {
      // 起手快速冲到顶，之后平滑衰减 —— 线性衰减听起来像"泄气"。
      const envelope = index < peak
        ? index / peak
        : Math.pow(1 - (index - peak) / (samples - peak), 1.8);
      data[index] = (Math.random() * 2 - 1) * envelope;
    }
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    filter.type = "bandpass";
    filter.Q.value = q;
    filter.frequency.setValueAtTime(fromHz, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, toHz), now + duration);
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(filter).connect(gain).connect(this.effectsBus);
    source.start(now);
  }

  /**
   * 带节流的闷响，给**每挨一口就触发**的那两个事件用（反伤、玩家受击）。
   *
   * 节流按"截止频率"分桶而不是全局一把锁：反伤（200Hz）和受击（240Hz）
   * 各自计时，互不影响 —— 否则挨一口咬会把同一瞬间的反伤声吃掉，
   * 玩家就看不出铁甲在起作用。
   */
  private thudThrottled(duration: number, volume: number, cutoffHz: number, minGapMs: number): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    const key = Math.round(cutoffHz);
    if (now - (this.lastThudAt.get(key) ?? -Infinity) < minGapMs / 1000) return;
    this.lastThudAt.set(key, now);
    this.thud(duration, volume, cutoffHz);
  }

  /**
   * 闷响。所有"打到东西"的反馈都走它 —— 低通截止决定材质：
   * 越低越像肉、越高越像石头或铁。
   *
   * 用一个原语而不是一堆采样，是为了让这些高频反馈**天然处在同一个频段里**：
   * 五只狗同时咬中时它们互相叠加成一记更响的闷响，而不是五种不同音色打架。
   */
  private thud(duration: number, volume: number, cutoffHz: number): void {
    if (!this.context || !this.effectsBus) return;
    const now = this.context.currentTime;
    const samples = Math.ceil(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, samples, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < samples; index += 1) {
      data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / samples, 2.4);
    }
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(cutoffHz, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, cutoffHz * 0.45), now + duration);
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(filter).connect(gain).connect(this.effectsBus);
    source.start(now);
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
