export interface Vec2 {
  x: number;
  z: number;
}

export type Phase = "day" | "night";

/**
 * 一条待渲染的文案：**键 + 参数**，不是成品字符串。
 *
 * 模拟层一律产出这个而不是中文/英文原文。两个理由：
 *   1. 模拟层是无头可测的核心（跑分器全靠它），塞进翻译就等于让它依赖语言状态；
 *   2. 已经推送出去的成品串没法重译 —— 玩家中途切语言，历史消息就是花的。
 *
 * 参数可以再套一层 LocalizedText（"获得铁矿 · {下一阶提示}"），由 t() 递归渲染。
 */
export interface LocalizedText {
  key: string;
  params?: Record<string, string | number | LocalizedText>;
}
/**
 * 双手搬运物：地图大石、玩家搭好后可以重新布置的树桩，以及汽油桶。
 *
 * 汽油桶走搬运而不是背包，是整个通关目标的支点：扛着桶就跑不快（×0.54）、
 * 也**打不了架**（requestAttack 直接被 carrying 挡掉）。于是"取油"这件事
 * 天然是一段没有还手能力的路程 —— 你得先决定这一趟安不安全。
 */
export type CarryKind = "stone" | "stake" | "fuel";
/** 地面上散落的可拾取物仍然有两种；木头进背包，大石上手。 */
export type GroundItemKind = "wood" | "stone";
export type InventoryItemKind =
  | "cactus-juice"
  | "raw-meat"
  | "cooked-meat"
  | "hide"
  | "iron-ore"
  | "water"
  | "wolf-fang"
  | "wood";

/** 装备分线。阶 0 的求生匕首与粗布衣不属于任何线。 */
export type EquipLine = "none" | "saber" | "sword" | "scale" | "hide";

/**
 * 武器：共用的阶 0，加两条各三阶的线。**全部是刀与剑，没有长柄武器** ——
 * 可用的攻击动画只有一个单手劈砍，拿着矛做劈砍是错的。
 *
 *   刀线 saber —— 阔刃（砍刀Ⅰ / Ⅱ / Ⅲ）。
 *                 扇形 220°→280°，一刀扫过身周一大圈，破甲，命中击退。
 *   剑线 sword —— 细刃（剑Ⅰ / Ⅱ / Ⅲ）。
 *                 扇形只有 100°，但咬住同一个目标会越打越疼（连击）。
 *
 * 两条线的分化**完全不依赖攻速**：一个动画意味着冷却必须全线统一，
 * 所以群体能力由扇形面积承担、单体能力由每击伤害与连击承担。
 */
export type WeaponKind =
  | "survival-knife"
  | "saber-1" | "saber-2" | "saber-3"
  | "sword-1" | "sword-2" | "sword-3";

/**
 * 护甲：共用的阶 0，加两条各三阶的线。
 *
 *   铁甲线 scale —— 高防御 + 近战反伤，代价是移速与劳力回复双惩罚。
 *   皮甲线 hide  —— 低防御 + 闪避，移速与劳力回复双加成。
 *
 * 减法防御吃"多而弱"的咬伤，百分比闪避吃"少而重"的咬伤，两条曲线必然交叉 ——
 * 交叉点解出来是原始攻击 30.0 / 35.2 / 35.9（逐阶）。所以重甲是守夜的甲，
 * 皮甲是扛精英狼重击的甲。
 */
export type ArmorKind =
  | "none"
  | "scale-1" | "scale-2" | "scale-3"
  | "hide-1" | "hide-2" | "hide-3";
export type WolfKind = "small" | "large" | "elite";
export type WolfMode = "entering" | "patrol" | "chase" | "raid" | "retreating" | "dead";
/**
 * 野狼白天在地图上游荡且只在被激怒后反击；夜袭狼从狗巢涌出且不掉狼皮；
 * **守巢犬**是第三种：从开局就趴在巢边那三桶汽油旁边，昼夜常驻、不撤退、不重生。
 *
 * 它们是"打"这条通关路线的收费站 —— 巢边的油离卡车只有三十几米，
 * 但要先能正面吃下五只大狼。绕开它们去捡野外的散桶完全可行，代价是路程。
 */
export type WolfRole = "wild" | "raider" | "guard";

/**
 * 荒漠猎物。全部无毒 —— 中毒会引入一条独立的持续伤害轴，和五轴模型是两回事。
 * 全部不攻击玩家，靠"警觉半径 + 冲刺时长"区分难度：
 * 长角羚最快最肥但冲得最久，铠甲虫几乎站着让你打。
 */
export type CritterKind =
  | "oryx"
  | "lizard"
  | "jerboa"
  | "corvid"
  | "gerbil"
  | "rat"
  | "beetle"
  | "sandeel";

export type CritterMode = "graze" | "flee" | "dead";

export interface CritterState extends Vec2 {
  id: number;
  kind: CritterKind;
  facing: Vec2;
  health: number;
  maxHealth: number;
  mode: CritterMode;
  /** 游荡的锚点，逃跑结束后会慢慢晃回来。 */
  anchor: Vec2;
  wanderAngle: number;
  /** 剩余冲刺时长；耗尽后即使玩家还在追也会停下喘气，这让追猎可行。 */
  sprint: number;
  hurtFlash: number;
  deathTimer: number;
  dropsCreated: boolean;
}

export interface CritterSpec {
  /** 名字不在这里 —— 走 i18n 的 `critter.<kind>.name`。 */
  maxHealth: number;
  fleeSpeed: number;
  grazeSpeed: number;
  /** 玩家进入这个半径就开始逃。 */
  alertRadius: number;
  /** 一次逃跑最多能冲多少秒。 */
  sprintSeconds: number;
  /** 冲刺回满需要多少秒的平静。 */
  sprintRecovery: number;
  /**
   * 转向速率上限（弧度/秒）。**这不是装饰参数，它同时是外观和手感。**
   *
   * 逃跑方向是"背对玩家"，也就是以玩家为原点算出来的 —— 贴身时这条向量转得极快
   * （玩家 8.2 m/s 从 1 米外擦过，方向一秒扫过 470°）。不限速的话大型猎物会原地甩头，
   * 而且因为它能瞬间掉头，跑得比你快就等于永远追不到。
   *
   * 限了速之后，猎物必须**画弧**才能转向，于是"抄近路截它"成为可行的追猎技巧 ——
   * 长角羚 (10.5 移速) 比玩家快得多这件事，第一次有了解法。
   * 体型越大转得越慢：铠甲虫几乎能原地转，长角羚要跑一个大弯。
   */
  turnRate: number;
  meat: number;
  hide: number;
  water: number;
  /** 世界上同时存在的目标数量。 */
  population: number;
  scale: number;
}
/** 体温越界后的瘫痪状态，带迟滞：进入与解除阈值不同。 */
export type SurvivalCondition = "normal" | "heatstroke" | "hypothermia";
/**
 * 死因。体温越界**不**致死（只施加中暑/失温的瘫痪状态），
 * 所以没有"冻死/热死"这两项 —— 但体温会经由减速间接把你送走，
 * 因此结算时要连带报出当时的瘫痪状态，否则玩家学不到真正的死因链。
 */
export type DeathCause = "dehydrated" | "starved" | "killed" | "exhausted";
export type CampKind = "windy-ridge" | "deep-cave" | "abandoned-camp";
export type TerrainStyle = "broken-spur" | "saddle-shoulder" | "cliff-alcove" | "wide-ledge" | "wind-crown";
export type LandmarkKind = "deadwood" | "wreck" | "monolith";

export interface InventoryStack {
  kind: InventoryItemKind;
  count: number;
}

export interface WorldDrop extends Vec2 {
  id: number;
  kind: InventoryItemKind;
  count: number;
  active: boolean;
  createdAt: number;
  expiresAt: number;
  burstAngle: number;
}

export interface CircleObstacle extends Vec2 {
  radius: number;
  kind: "wall" | "tree" | "landmark";
}

export interface CampDefinition extends Vec2 {
  id: number;
  entranceAngle: number;
  entranceWidth: number;
  radius: number;
  kind: CampKind;
  elevation: number;
  terrainStyle: TerrainStyle;
  approachWidth: number;
  platform: Vec2[];
  approach: Vec2[];
  gate: Vec2;
}

export interface TerrainDefinition {
  resolution: number;
  seed: number;
  maxWalkableSlope: number;
}

export interface TreeDefinition extends Vec2 {
  id: number;
  rotation: number;
  scale: number;
}

export interface HillDefinition extends Vec2 {
  id: number;
  scaleX: number;
  scaleZ: number;
  height: number;
  rotation: number;
}

export interface GroundItem extends Vec2 {
  id: number;
  kind: GroundItemKind;
  hp: number;
  placed: boolean;
  active: boolean;
  rotation: number;
}

/** 仙人掌：荒漠里位置固定、产出稳定的水源。 */
export interface CactusPatch extends Vec2 {
  id: number;
  juice: number;
  regrowAt: number;
}

export interface IronNode extends Vec2 {
  id: number;
  ore: number;
  rotation: number;
}

/**
 * 干枯的井：地图上预置的固定水源。
 * 基准版本要玩家先造井再提水，我们省掉建造那一步直接送几口 —— 井因此变成**地标**，
 * 玩家规划路线和过夜地点时必须把它算进去，而不是像挖沙那样随处摸奖。
 */
export interface WellDefinition extends Vec2 {
  id: number;
  rotation: number;
}

export interface WellState {
  id: number;
  /** 剩余可提水次数。 */
  charges: number;
  /** 下一次回蓄的绝对时刻（elapsed 秒）；charges 已满时为 0。 */
  refillAt: number;
}

/**
 * 狗巢：夜袭犬的出生点，也是地图上唯一一个"敌人有来处"的地标。
 *
 * 原先夜袭犬从地图四条边随机刷出，再先去一个**随机营地**附近的锚点、才折向
 * 唯一亮着火的那座 —— 实测第 1 夜配额 40 只里只有 9 只真正走到营地 20 米内
 * （23%），大半个夜晚它们都在路上。玩家因此学不到任何东西：狼不是从某处来的，
 * 它就是天气。
 *
 * 巢在地形上被刻成一圈土垄 + 中间的浅坑，**只留朝向营地的那一个口**
 * （实测 36 个方位里只有 3 个可走），所以狼流出来的方向是确定的、看得见的。
 */
export interface DenDefinition extends Vec2 {
  id: number;
  /** 巢口朝向（弧度），指向它要进攻的营地。 */
  mouthAngle: number;
  /** 土垄外缘半径；巢口在这个圈上开一道缺口。 */
  radius: number;
  /** 巢口的世界坐标，狼从这里冒出来。 */
  mouth: Vec2;
}

export interface LandmarkDefinition extends Vec2 {
  id: number;
  kind: LandmarkKind;
  rotation: number;
  scale: number;
}

/**
 * 汽油桶。通关要往卡车里装满 {@link FUEL_REQUIRED} 桶。
 *
 * 全图放 9 桶而只要 5 桶，是为了让两条路线都走得通而不是二选一：
 *   - **巢边 3 桶** 离卡车只有三十几米，但守巢的五只大狼就趴在旁边；
 *   - **野外 6 桶** 谁也不看着，但散在半张图上，扛一趟要一个白天的一大半。
 * 拿光巢边三桶也还差两桶，所以无论怎么打都得出门至少两趟。
 */
export interface FuelBarrelDefinition extends Vec2 {
  id: number;
  rotation: number;
  /** 是否属于守巢犬看着的那一组；只用于生成时定位守卫，运行时不再区分。 */
  guarded: boolean;
}

export type FuelBarrelPlacement = "ground" | "carried" | "loaded";

export interface FuelBarrelState extends Vec2 {
  id: number;
  rotation: number;
  placement: FuelBarrelPlacement;
}

/**
 * 卡车：荒原上唯一的出口。停在狗巢背面二十来米 —— 近到你一定会撞见巢，
 * 远到站在车边不会被守巢犬看见（它们的视野 14.5 米，车离桶 33 米）。
 */
export interface TruckDefinition extends Vec2 {
  rotation: number;
  /** 加满油后驶离的方向（单位向量），指向最近的一条地图边。 */
  exit: Vec2;
}

/**
 * 玩家搭建的放置物。
 *   树桩 —— 路障。1 个木头换一道能自愈的墙，是整套基地防御的基石；
 *          我们此前的防御只有"一个营地一块大石"，没有任何布防余地。
 *
 * 曾经还有一个"火窖"：到处都能搭的火源。它被撤掉了 —— 一旦哪儿都能生火，
 * 5 座营地就不再是地图上的锚点，"今晚回哪过夜"这个空间决策连同水井的规划价值
 * 一起被抹平。火只在营地烧，出门才有代价。
 */
export type StructureKind = "stake";

export interface PlacedStructure extends Vec2 {
  id: number;
  kind: StructureKind;
  hp: number;
  maxHp: number;
  rotation: number;
  active: boolean;
}

export interface StructureSpec {
  /** 名字与说明走 i18n 的 `structure.<kind>.name` / `.blurb`。 */
  /** 配方；只吃木头 —— 木头因此成为真正的核心资源。 */
  cost: Array<[InventoryItemKind, number]>;
  stamina: number;
  maxHp: number;
  /**
   * 减法护甲，和玩家、狼走同一套公式。
   * 路障最需要的其实是它而不是血量：它把"一群小狼"从威胁降成噪音，
   * 而这正是路障存在的意义 —— 用木头换时间，不是用木头换血条。
   */
  armor: number;
  /** 每秒自愈。白天自己长回来，树桩因此是一次性投入的阵地，不是每晚的消耗品。 */
  regen: number;
  /** 占地半径，同时用于碰撞与"离得太近不让放"的判定。 */
  radius: number;
}

/**
 * 地面物当路障时的耐久。
 *
 * 大石：封住营地那条唯一坡道的东西，所以要比树桩更硬 —— 它是天然巨石不是木桩，
 * 因此给高血高甲但**不自愈**。"搬石头堵门"是我们自己加的玩法，没有可参考的基准值，
 * 这组数是照着"树桩 ×2 血、更高护甲"定的。
 *
 * 枯木：成堆时才算路障（见 findBlockingItem 的 clusterSize 判定），聊胜于无。
 */
export const BARRIER_STATS: Record<GroundItemKind, { hp: number; armor: number }> = {
  stone: { hp: 1500, armor: 10 },
  wood: { hp: 70, armor: 0 },
};

export const STRUCTURE_SPECS: Record<StructureKind, StructureSpec> = {
  /**
   * 树桩。基准值是 1000 血 / +5.00 自愈 / 15 护甲 / 木头 ×1，
   * 按我们的量纲缩放后落在 800 / +2 / 6。
   *
   * 改之前是 220 血、无护甲、无自愈 —— 第 3 夜一只大狼 6.5 秒就拆了，
   * 而它本该拖住一只恶狼 85 秒。13 倍的差距，
   * 结果就是"12 劳力 + 1 木头换 6.5 秒"，没人会去造。
   */
  stake: {
    cost: [["wood", 1]], stamina: 12, maxHp: 800, armor: 6, regen: 2, radius: 0.9,
  },
};

export interface CampState {
  id: number;
  fuel: number;
}

export interface PlayerState extends Vec2 {
  facing: Vec2;
  health: number;
  maxHealth: number;
  /**
   * 攻击与防御**不再是玩家身上的字段** —— 它们由当前 weapon / armor 派生，
   * 见 GameSimulation.getAttackPower() / getDefense()。
   *
   * 原先是 `player.attack += 本阶增量` 一路累加上去的。那种写法在装备只有一条
   * 直线时勉强成立，一旦允许换装（骨剑 → 铁刀）就会重复计数：卸下的那件装备
   * 没有对应的减法，攻击力只增不减。派生之后"当前装备是什么，属性就是什么"，
   * 换线、降级、读档都不会算错。
   */
  /** 体温：0~100，白天有地板、夜晚有天花板，越界只致瘫不致死。 */
  warmth: number;
  /** 饥饿：归零立即死亡。 */
  hunger: number;
  /** 水分：归零立即死亡。 */
  water: number;
  /** 劳力：采集与攻击的预算，休息回复得快、行动回复得慢。 */
  stamina: number;
  maxStamina: number;
  condition: SurvivalCondition;
  inventory: Array<InventoryStack | null>;
  carrying: CarryKind | null;
  armor: ArmorKind;
  weapon: WeaponKind;
  resting: boolean;
  idleTime: number;
  attackCooldown: number;
  attackFlash: number;
  hurtFlash: number;
  /** 取水动作的剩余秒数，>0 时玩家正在提水或割仙人掌。 */
  gatherTimer: number;
  kills: number;
}

export interface WolfState extends Vec2 {
  id: number;
  kind: WolfKind;
  role: WolfRole;
  facing: Vec2;
  health: number;
  maxHealth: number;
  attack: number;
  defense: number;
  mode: WolfMode;
  raider: boolean;
  /** 野狼被打过之后才会主动追击，此前一直巡逻。 */
  provoked: boolean;
  anchor: Vec2;
  patrolAngle: number;
  speed: number;
  attackCooldown: number;
  lostTimer: number;
  /** Absolute simulation time when this raider joins the staggered dawn retreat. */
  retreatAt: number;
  /** Time spent failing to advance during retreat; relaxes slope limits to unstick the wolf. */
  retreatStuckTimer: number;
  hurtFlash: number;
  deathTimer: number;
  dropsCreated: boolean;
}

export interface WorldDefinition {
  size: number;
  terrain: TerrainDefinition;
  camps: CampDefinition[];
  walls: CircleObstacle[];
  trees: TreeDefinition[];
  hills: HillDefinition[];
  initialItems: GroundItem[];
  initialCacti: CactusPatch[];
  ironNodes: IronNode[];
  wells: WellDefinition[];
  landmarks: LandmarkDefinition[];
  dens: DenDefinition[];
  barrels: FuelBarrelDefinition[];
  truck: TruckDefinition;
  startCampId: number;
}

/** 通关要往卡车里装几桶油。 */
export const FUEL_REQUIRED = 5;

export type GameEvent =
  | { type: "pickup"; kind: CarryKind | InventoryItemKind }
  | { type: "drop"; kind: CarryKind }
  | { type: "loot-drop"; kind: InventoryItemKind; dropId: number }
  | { type: "feed-fire"; campId: number }
  | { type: "eat"; kind: "cactus-juice" | "cooked-meat" }
  | { type: "drink" }
  | { type: "draw-water" }
  | { type: "cook" }
  | { type: "thermal"; direction: "cool" | "warm" }
  | { type: "craft-coat" }
  | { type: "craft-weapon" }
  | { type: "rest"; active: boolean }
  | { type: "attack" }
  | { type: "exhausted" }
  | { type: "condition"; condition: SurvivalCondition }
  | { type: "wolf-hit"; wolfId: number }
  | { type: "wolf-killed"; wolfId: number }
  /** 重创触发。剑三阶 40% 的触发率，没有独立音效玩家就感知不到这个机制。 */
  | { type: "crit" }
  /** 剑线连击层数变化（含清零）。 */
  | { type: "combo"; stacks: number }
  /** 刀线击退：把狼推开并延后它的咬击。 */
  | { type: "knockback"; wolfId: number }
  /** 皮甲线闪避掉一次咬击。 */
  | { type: "dodge" }
  /** 铁甲线把伤害弹回给狼。 */
  | { type: "thorns"; wolfId: number; amount: number }
  | { type: "critter-hit"; critterId: number }
  | { type: "critter-killed"; critterId: number; kind: CritterKind }
  /** 一桶油进了车斗。 */
  | { type: "fuel-loaded"; loaded: number; required: number }
  /** 油加满、玩家上车，卡车开始驶离。之后只剩结算动画。 */
  | { type: "truck-depart" }
  | { type: "player-hit"; amount: number }
  | { type: "barrier-hit"; itemId: number; material: "stone" | "wood" }
  | { type: "build"; kind: StructureKind }
  | { type: "structure-destroyed"; kind: StructureKind }
  | { type: "phase"; phase: Phase; day: number }
  | { type: "message"; key: string; params?: LocalizedText["params"] }
  | { type: "victory" }
  /** 看完激励视频后原地复活。 */
  | { type: "revive" }
  | { type: "game-over" };

export interface InteractionHint {
  action: "pickup" | "drop" | "feed" | "cactus" | "mine" | "well" | "load" | "board" | "none";
  text: LocalizedText;
}

/**
 * 猎物图鉴。数值按基准版本等比缩放（基准主角 600 血 / 240 移速，我们是 100 / 8.2）。
 *
 * 设计意图是拉开一条「好抓但不值钱 ←→ 难抓但一顿管饱」的谱：
 *   铠甲虫  几乎不跑，一刀一块肉
 *   跳鼠    比玩家快，但冲 2 秒就没劲，绕两下能追到
 *   长角羚  比玩家快得多、冲 4.5 秒、90 血，但一头能提供两块肉、两张皮和两份水
 */
export const CRITTER_SPECS: Record<CritterKind, CritterSpec> = {
  beetle: {
    maxHealth: 8, fleeSpeed: 2.6, grazeSpeed: 0.7, alertRadius: 3.5,
    sprintSeconds: 99, sprintRecovery: 1, turnRate: 11, meat: 1, hide: 0, water: 0, population: 9, scale: 0.5,
  },
  sandeel: {
    // 钻沙脱离用「极短的冲刺 + 极快的速度」近似：一眨眼就没影，但只跑得动 1.4 秒。
    maxHealth: 6, fleeSpeed: 7.4, grazeSpeed: 0.5, alertRadius: 5,
    sprintSeconds: 1.4, sprintRecovery: 3, turnRate: 10, meat: 1, hide: 0, water: 0, population: 8, scale: 0.55,
  },
  gerbil: {
    maxHealth: 12, fleeSpeed: 7.6, grazeSpeed: 1.1, alertRadius: 7,
    sprintSeconds: 2.4, sprintRecovery: 3.5, turnRate: 9, meat: 1, hide: 0, water: 0, population: 7, scale: 0.6,
  },
  rat: {
    maxHealth: 14, fleeSpeed: 7, grazeSpeed: 1.1, alertRadius: 6.5,
    sprintSeconds: 2.6, sprintRecovery: 3.5, turnRate: 9, meat: 1, hide: 0, water: 0, population: 6, scale: 0.65,
  },
  lizard: {
    maxHealth: 16, fleeSpeed: 6.2, grazeSpeed: 0.9, alertRadius: 6,
    sprintSeconds: 3, sprintRecovery: 3, turnRate: 8, meat: 1, hide: 0, water: 0, population: 7, scale: 0.7,
  },
  jerboa: {
    maxHealth: 10, fleeSpeed: 9.6, grazeSpeed: 1.3, alertRadius: 9,
    sprintSeconds: 2, sprintRecovery: 4, turnRate: 7.5, meat: 2, hide: 0, water: 0, population: 6, scale: 0.7,
  },
  corvid: {
    maxHealth: 10, fleeSpeed: 5.2, grazeSpeed: 0.8, alertRadius: 8,
    sprintSeconds: 2.6, sprintRecovery: 3, turnRate: 7, meat: 2, hide: 0, water: 0, population: 5, scale: 0.85,
  },
  oryx: {
    maxHealth: 90, fleeSpeed: 10.5, grazeSpeed: 1.4, alertRadius: 11,
    sprintSeconds: 4.5, sprintRecovery: 6, turnRate: 2.6, meat: 2, hide: 2, water: 2, population: 4, scale: 1.5,
  },
};

export const INVENTORY_CAPACITY = 8;

export const INVENTORY_STACK_LIMITS: Record<InventoryItemKind, number> = {
  "cactus-juice": 4,
  "raw-meat": 3,
  "cooked-meat": 3,
  hide: 4,
  "iron-ore": 6,
  water: 4,
  /** 狼牙只用于四条线的三阶，单个配方最多要 3 颗 —— 上限 4 刚好一格装得下。 */
  "wolf-fang": 4,
  wood: 4,
};

/**
 * 碰撞半径。放在 types 里是因为 GameSimulation 和 WolfDirector 都要用，
 * 搁在任何一侧都会让两个模块循环 import。
 */
export const PLAYER_RADIUS = 0.72;
export const WOLF_RADIUS = 0.68;
/** 天然大石的碰撞半径。流场把石头当障碍时用的是同一个值。 */
export const STONE_COLLIDE_RADIUS = 1.48;
