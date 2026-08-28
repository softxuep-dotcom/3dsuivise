import type { EquipmentSystem } from "./EquipmentSystem";
import type { TruckSystem } from "./TruckSystem";
import { loc } from "./text";
import { TAU } from "./geometry";
import { CRITTER_SPECS } from "./types";
import { COOKED_HEALTH, FIRE_WARMTH_RADIUS, NEED_WARNING } from "../balance/survival";
import type {
  CampDefinition, CampState, CritterState, GameEvent, LocalizedText,
  InventoryItemKind, Phase, PlayerState, Vec2, WorldDefinition,
} from "./types";

/**
 * 目标行、方位、地名、入夜警告 —— **模拟层里唯一产出玩家能读到的话的地方**。
 *
 * 分出来的理由和别的系统不一样。它不是"逻辑太长"，是**它的改动频率单独成一档**：
 * 近 60 次提交里 en.ts 和 zh.ts 各改了 31 次，而绝大多数文案改动最终要落到
 * `getObjective()` 那串优先级判断上。原先它埋在三千行模拟层的中段，
 * 改一句话要先在战斗、背包、寻路之间找到它。
 *
 * 现在它有单一落点，文案回归测试也就有了单一落点。
 *
 * ## 端口比别的系统都宽，这是它的职责决定的
 *
 * 目标行的工作就是**把整个模拟层概括成一句话** —— 快死了说什么、瘫痪了说什么、
 * 扛着桶说什么、天要黑了说什么。它必然看得见很多东西。
 *
 * 但请注意端口里**几乎全是只读查询**：这个类不改任何模拟状态，
 * 它自己的两个标志（{@link ObjectiveNarrator.objectiveStage} 和
 * duskWarningSent）除外。宽而只读，和宽而可写完全是两回事。
 *
 * ## 优先级是有顺序的，不要随手插队
 *
 * {@link ObjectiveNarrator.getObjective} 里那串 `if` 从上到下是：发车中 → 开场第一句 →
 * 致命轴（水/饿归零即死）→ 瘫痪状态 → 休息 → 扛桶 → 其余。
 * 往中间插一条，等于把某一类玩家在某一刻最该看到的话挤掉。
 */
export interface ObjectiveOwner {
  readonly world: WorldDefinition;
  readonly player: PlayerState;
  readonly camps: CampState[];
  readonly critters: CritterState[];
  readonly truck: Vec2 & { loaded: number };
  readonly phase: Phase;
  readonly phaseTime: number;
  readonly day: number;
  /** 世界时钟是否已经起表。没起表时说的是开场那一句。 */
  readonly clockStarted: boolean;
  emit(event: GameEvent): void;
  getInventoryCount(kind: InventoryItemKind): number;
  getComingNightDuration(): number;
  getNearestLitCamp(): { camp: CampDefinition; fuel: number; distance: number } | null;
  findNearestCamp(maxDistance: number): CampDefinition | null;
  findNearestHearth(maxDistance: number): { campId: number; distance: number } | null;
  hasNearerTarget(hearthDistance: number): boolean;
  isEntranceBlocked(camp: CampDefinition): boolean;
  screenBearingTo(target: Vec2): number;
}

export class ObjectiveNarrator {
  /**
   * 目标行推进到第几段。
   *
   * 公开是因为模拟层有两处要动它：入夜时直接拨到第 3 段，攻击落空时读它决定
   * 要不要提示。那两处都是**事件驱动的跳转**，不是叙述本身。
   */
  objectiveStage = 0;
  /**
   * 这一局有没有**真的从地上或树上**拿到过柴。
   *
   * 第 0 阶原先的判据是 `getInventoryCount("wood") > 0`，而开局口粮里就带着柴
   * （见 balance/world.ts 的 STARTING_RATION），于是它在**第一帧**就成立 ——
   * objectiveStage 0 → 1 当场跳过，`sim.26`「捡起身边的枯木」在任何一局里
   * 一次都不会显示。实机确认：起局前 stage=0 / wood=2，跑一帧就变 stage=1。
   *
   * 这不是那条"第一个白天目标行只说通关目标"的设计（那条在 getObjective 里，
   * 用 sim.fuelFirst 的优先级实现，没动）。这是判据写错了对象：
   * 要问的是"他捡过柴没有"，不是"他包里有没有柴"。
   */
  private gatheredWood = false;
  /** 入夜前的燃料警告每晚只发一次。 */
  private duskWarningSent = false;

  constructor(
    private readonly owner: ObjectiveOwner,
    private readonly truck: TruckSystem,
    private readonly equipment: EquipmentSystem,
  ) {}

  /** 新的一夜开始，警告可以再发一次。 */
  resetDuskWarning(): void {
    this.duskWarningSent = false;
  }

  /**
   * 玩家把一根柴收进了背包。**开局口粮不走这里** —— 那是在构造函数里发的，
   * 而这个口子挂在 addInventory 上、只在 running 之后才算数。
   */
  noteWoodGathered(): void {
    this.gatheredWood = true;
  }

  getCurrentLocationLabel(): LocalizedText {
    const camp = this.owner.findNearestCamp(14);
    return loc(camp ? `camp.${camp.kind}` : "camp.unnamed");
  }

  /** 把 {@link screenBearing} 的角度换成八个方位之一：0 = 正上方 = 北，顺时针数。 */
  bearingKey(bearing: number): string {
    const sector = Math.round(((bearing % TAU) + TAU) % TAU / (TAU / 8)) % 8;
    return ["compass.n", "compass.ne", "compass.e", "compass.se",
      "compass.s", "compass.sw", "compass.w", "compass.nw"][sector];
  }

  getObjective(): LocalizedText {
    if (this.truck.departing) return loc("sim.departing");
    /*
     * 开场第一句必须说清**为什么活着**，不是"先干个家务"。
     *
     * 原来写的是"移动或拿起枯木，开始第一天" —— 那是流程说明。而卡车（通关条件）
     * 就在出生点 34 米外、一抬头就看得见，玩家却完全不知道它是出路。
     * Poki 那批会话中位数只有 52 秒，绝大多数人从头到尾没被告知过目标是什么。
     * 现在第一句直接给：加满几桶、车在哪个方位、多远。
     */
    if (!this.owner.clockStarted) {
      const opening = this.truck.progress();
      return loc("sim.7", {
        required: opening.required,
        metres: Math.round(opening.truckDistance),
        bearing: loc(this.bearingKey(this.owner.screenBearingTo(this.owner.truck))),
      });
    }

    // 致命轴优先：水分和饥饿归零是立即死亡，必须压过其它所有提示。
    // 阈值与 HUD 的脉冲共用 NEED_WARNING —— 目标行说"去吃肉"的同一帧，
    // 背包和那格食物一起跳。两边各写一个 18 就会在下次调参时悄悄错开。
    const { water, hunger } = this.owner.player;
    if (water < NEED_WARNING && hunger < NEED_WARNING) return loc("sim.needsCritical");
    if (water < NEED_WARNING) return loc("sim.9");
    if (hunger < NEED_WARNING) return loc("sim.10");
    // 其次是瘫痪状态。
    if (this.owner.player.condition === "hypothermia") return loc("sim.11");
    if (this.owner.player.condition === "heatstroke") return loc("sim.12");

    if (this.owner.player.resting) return loc("sim.13");
    // 扛着桶的时候只说一件事：车在哪。扛桶期间打不了架、跑不快，
    // 别的提示这时全是噪音 —— 而且手上占着东西，E 只能放下或装车。
    const fuel = this.truck.progress();
    if (fuel.carrying) {
      return loc("sim.fuelCarrying", {
        metres: Math.round(fuel.truckDistance),
        bearing: loc(this.bearingKey(this.owner.screenBearingTo(this.owner.truck))),
      });
    }
    /*
     * 第一桶：**第一个白天里，目标行只说通关目标这一件事。**
     *
     * 平台数据（1.0.14，n=500）最高的一根柱子在 1~2 分钟，而录像显示大部分人
     * **没死就走了**。也就是说卡住他们的不是难度，是"这游戏要我干嘛"从头到尾没有答案：
     * 玩家一迈步，目标行就从「加满 6 桶油，开着卡车离开」跳成「走到篝火旁添柴」
     * （因为开局口粮里就有一根柴，下面那条 sim.14 恒真），t=26s 再跳成「用大石封门」。
     * 整个第一昼夜 190 秒里，通关进度一格都不动 —— 而囤柴封门这笔投资是为第 2 天付的，
     * 大部分人没有第 2 天。
     *
     * 所以这条排在捡柴生火链**之前**：出生点 8.5 米就有一桶（createWorld 末尾的教学桶），
     * 扛到 7.7 米外的车上，「汽油 1/6」当场跳格。第一桶进车之后这条自己消失，
     * 后面那条链原样接上，一个字没删。
     *
     * 三道闸：只在第 1 天、只在白天、只在还没装过任何一桶之前。
     * `phaseTime > 14` 是把最后 14 秒让给 sim.23 的入夜警告 ——
     * 8.5 米的桶如果 26 秒还没搬动，这条提示已经不起作用了，而天要黑是真的更急。
     */
    if (this.owner.day === 1 && this.owner.phase === "day" && this.owner.phaseTime > 14
      && this.owner.truck.loaded === 0 && fuel.nearest) {
      return loc("sim.fuelFirst", {
        required: fuel.required,
        metres: Math.round(fuel.nearest.distance),
        bearing: loc(this.bearingKey(fuel.nearest.bearing)),
      });
    }

    // 枯木现在进背包，所以指引从"往哪搬"变成"够不够、去哪烧"。
    // 同样要让过 requestInteraction 的优先级：手上占着东西、或者脚边有东西可捡时，
    // E 都不会去添柴，这里就不能喊"按互动键添柴"。
    if (this.owner.getInventoryCount("wood") > 0 && !this.owner.player.carrying) {
      const hearth = this.owner.findNearestHearth(FIRE_WARMTH_RADIUS);
      if (hearth && !this.owner.hasNearerTarget(hearth.distance)) return loc("sim.14");
    }
    if (fuel.loaded >= fuel.required) return loc("sim.fuelReady", { metres: Math.round(fuel.truckDistance) });

    if (this.owner.phase === "night") {
      if (this.owner.player.warmth < 30) return loc("sim.17");
      const lit = this.owner.getNearestLitCamp();
      if (!lit) return loc("sim.18");
      if (lit.fuel < 25) return loc("sim.19", { v0: Math.round(lit.fuel) });
      if (this.owner.day === 1 && this.owner.phaseTime > 60) return loc("sim.20");
      // 夜里不指路去搬油 —— 巢口就在那三桶旁边，夜袭犬正从那里往外涌。
      return loc("sim.nightHold", { loaded: fuel.loaded, required: fuel.required });
    }

    if (this.owner.phase === "day" && this.owner.day === 1 && this.owner.phaseTime <= 14) return loc("sim.23");
    if (this.owner.player.warmth > 78) return loc("sim.24");
    if (this.objectiveStage === 0) return loc("sim.26");
    if (this.objectiveStage === 1) return loc("sim.27");
    if (this.objectiveStage === 2) return loc("sim.28");
    if (this.owner.getInventoryCount("water") === 0 && this.owner.getInventoryCount("cactus-juice") === 0) return loc("sim.29");
    //
    // 下面这一段的顺序改过一次，值得记一笔。
    //
    // 通关目标（去搬油）原先排在**所有**装备提示之后，而那些提示的条件宽到几乎常真：
    // "没穿甲 + 地图上有野狗" 在前三天里一直成立。实测跑到第 2 天白天，目标行说的是
    // "沙海上有 5 只野狗 · 兽皮只从野狗和长角羚身上来" —— 玩家**从头到尾看不到自己在为什么活着**。
    //
    // 现在只有"现在就能做完的一步"能排在通关目标前面：手上已经有皮了（走两步就能穿上）、
    // 或者卡在三阶的最后一样材料上。其余的提示要么收紧到"真的还没入门"，要么删掉。
    if (this.equipment.equipped("armor").line === "none" && this.owner.getInventoryCount("hide") > 0) return loc("sim.30");
    // 三阶卡在狼牙上，而狼牙只有白天的大狼掉 —— 这条线索不给的话玩家找不到。
    if (this.equipment.equipped("weapon").tier === 2 && this.owner.getInventoryCount("wolf-fang") < 3) {
      return loc("sim.32", { v0: this.owner.getInventoryCount("wolf-fang") });
    }
    // 「沙海上有 N 只野狗 · 兽皮只从野狗和长角羚身上来」这一条删掉了。
    // 它的触发条件是"没穿甲 + 地图上有野狗"，前两三天一直成立，等于常年占着目标行；
    // 而它说的事已经有三个地方在说：开场卡的玩法三条、拿到第一张皮后的 sim.30、
    // 以及通关目标里"最近一桶有大狼守着"那半句。
    // 体力是恒定流失的轴，而烤肉是唯一的大额补给。身上有生肉却在掉血时，
    // 目标行直接把这条路指出来 —— 比等玩家自己翻背包发现要快得多。
    if (this.owner.player.health < 62 && this.owner.getInventoryCount("cooked-meat") === 0
      && this.owner.getInventoryCount("raw-meat") > 0) {
      const lit = this.owner.getNearestLitCamp();
      return lit
        ? loc("sim.cookNearby", { metres: Math.round(lit.distance), health: COOKED_HEALTH })
        : loc("sim.cookAnywhere");
    }
    // "缺肉"这条只在真的开始饿的时候压过通关目标。肚子还有一半就喊缺肉，
    // 会把整个白天都占成采集提示，玩家永远看不到自己到底在为什么活着。
    if (this.owner.player.hunger < 50
      && this.owner.getInventoryCount("raw-meat") === 0 && this.owner.getInventoryCount("cooked-meat") === 0) {
      const oryx = this.owner.critters.find((critter) => critter.kind === "oryx" && critter.mode !== "dead");
      if (oryx) return loc("sim.33", {
        meat: CRITTER_SPECS.oryx.meat,
        water: CRITTER_SPECS.oryx.water,
      });
      return loc("sim.34");
    }
    return this.describeFuelHunt(fuel);
  }

  /** 白天的常驻目标：还差几桶、最近一桶在哪个方向多远。 */
  describeFuelHunt(fuel: ReturnType<TruckSystem["progress"]>): LocalizedText {
    if (!fuel.nearest) return loc("sim.fuelNone", { loaded: fuel.loaded, required: fuel.required });
    // 最近的一桶往往就是巢边那三桶（离起点营地 41 米，比任何野外桶都近）。
    // 只报距离等于把拿着匕首的第 2 天玩家一头指进五只大狼里 —— 得说清那儿有狗看着，
    // 打还是绕才是玩家自己的选择。
    return loc(fuel.nearest.guarded ? "sim.fuelHuntGuarded" : "sim.fuelHunt", {
      left: fuel.required - fuel.loaded,
      metres: Math.round(fuel.nearest.distance),
      bearing: loc(this.bearingKey(fuel.nearest.bearing)),
    });
  }

  /**
   * 黄昏燃料预警。
   * 原先只有"火灭了 · 体温正在下降"这种**事后**提示，喊出来时玩家已经在挨冻了；
   * 而且天黑预警只在第 1 天出现，之后每一夜都是无预告的。
   * 这里改成**事前**并且给出确切数字：今晚多长、现在的火能烧多久、还差几根枯木。
   * 燃料每秒烧 1 点，一根枯木 +95 —— 所以缺口除以 95 就是要搬的根数。
   */
  warnDuskFuel(): void {
    const night = this.owner.getComingNightDuration();
    const lit = this.owner.getNearestLitCamp();
    const fuel = lit ? lit.fuel : 0;
    if (fuel >= night) {
      this.owner.emit({ type: "message", key: "msg.44", params: { v0: Math.round(fuel) } });
      return;
    }
    const logs = Math.ceil((night - fuel) / 95);
    // 背包里的柴已经够用时，缺的是“添进火里”这个动作，不是继续外出找柴。
    const carried = this.owner.getInventoryCount("wood");
    if (carried >= logs) {
      this.owner.emit({ type: "message", key: "msg.duskCarryEnough", params: { logs } });
      return;
    }
    const missing = logs - carried;
    this.owner.emit(fuel <= 0
      ? { type: "message", key: "msg.duskNoFire", params: { night, logs: missing } }
      : { type: "message", key: "msg.duskLowFire", params: { fuel: Math.round(fuel), night, logs: missing } });
  }

  updateObjectives(): void {
    // 每一天都预警，不再只有第 1 天。
    if (!this.duskWarningSent && this.owner.phase === "day" && this.owner.phaseTime <= 30) {
      this.duskWarningSent = true;
      this.warnDuskFuel();
    }
    /*
     * 第 0 阶：**捡起过柴**才算，不是"包里有柴"。见 gatheredWood 那段。
     *
     * carrying 也一起去掉了。它是枯木还能扛在手上那个年代的遗留 —— 现在柴进背包，
     * 手上扛的只可能是油桶、石头或木桩，而"捡起了一桶油"不该算作"捡起了身边的枯木"。
     * 留着它等于把这一阶交给开局那 8.5 米外的教学桶去收口，换个方式再废一次。
     */
    if (this.objectiveStage === 0 && this.gatheredWood) {
      this.objectiveStage = 1;
    } else if (this.objectiveStage === 1 && this.owner.camps.some((camp) => camp.fuel > 90)) {
      this.objectiveStage = 2;
      this.owner.emit({ type: "message", key: "msg.47" });
    } else if (this.objectiveStage === 2 && this.owner.world.camps.some((camp) => this.owner.isEntranceBlocked(camp))) {
      this.objectiveStage = 3;
      this.owner.emit({ type: "message", key: "msg.48" });
    }
  }
}
