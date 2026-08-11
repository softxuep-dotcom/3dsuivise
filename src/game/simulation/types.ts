export interface Vec2 {
  x: number;
  z: number;
}

export type Phase = "day" | "night";
export type CarryKind = "wood" | "stone";
export type GroundItemKind = CarryKind;
export type InventoryItemKind =
  | "cactus-juice"
  | "raw-meat"
  | "cooked-meat"
  | "hide"
  | "iron-ore"
  | "water"
  | "wash-water";
export type WeaponKind = "survival-knife" | "iron-spear" | "fang-spear";
/** 护甲三阶：无 → 兽皮衣 → 镶铁重甲。 */
export type ArmorKind = "none" | "leather" | "reinforced";
export type WolfKind = "small" | "large" | "alpha";
export type WolfMode = "entering" | "patrol" | "chase" | "raid" | "retreating" | "dead";
/** 野狼白天在地图上游荡且只在被激怒后反击；夜袭狼由边缘涌入且不掉狼皮。 */
export type WolfRole = "wild" | "raider";

/**
 * 荒漠猎物。取自原图的非毒生物 —— 蜘蛛、蝎子、眼镜蛇（都带 60 秒毒）没有移植。
 * 全部不攻击玩家，靠"警觉半径 + 冲刺时长"区分难度：
 * 骆驼最快最肥但冲得最久，甲壳虫几乎站着让你打。
 */
export type CritterKind =
  | "camel"
  | "lizard"
  | "hare"
  | "vulture"
  | "gerbil"
  | "rat"
  | "beetle"
  | "sandworm";

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
  label: string;
  maxHealth: number;
  fleeSpeed: number;
  grazeSpeed: number;
  /** 玩家进入这个半径就开始逃。 */
  alertRadius: number;
  /** 一次逃跑最多能冲多少秒。 */
  sprintSeconds: number;
  /** 冲刺回满需要多少秒的平静。 */
  sprintRecovery: number;
  meat: number;
  hide: number;
  water: number;
  /** 世界上同时存在的目标数量。 */
  population: number;
  scale: number;
}
/** 体温越界后的瘫痪状态，带迟滞：进入与解除阈值不同。 */
export type SurvivalCondition = "normal" | "heatstroke" | "hypothermia";
export type DeathCause = "dehydrated" | "starved" | "killed";
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
 * 原图要玩家先造井再提水，我们省掉建造那一步直接送几口 —— 井因此变成**地标**，
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

export interface LandmarkDefinition extends Vec2 {
  id: number;
  kind: LandmarkKind;
  rotation: number;
  scale: number;
}

export interface CampState {
  id: number;
  fuel: number;
}

export interface PlayerState extends Vec2 {
  facing: Vec2;
  health: number;
  maxHealth: number;
  attack: number;
  defense: number;
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
  startCampId: number;
}

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
  | { type: "craft-wash-water" }
  | { type: "craft-weapon" }
  | { type: "rest"; active: boolean }
  | { type: "attack" }
  | { type: "exhausted" }
  | { type: "condition"; condition: SurvivalCondition }
  | { type: "wolf-hit"; wolfId: number }
  | { type: "wolf-killed"; wolfId: number }
  | { type: "critter-hit"; critterId: number }
  | { type: "critter-killed"; critterId: number; kind: CritterKind }
  | { type: "alpha-spawned" }
  | { type: "player-hit"; amount: number }
  | { type: "barrier-hit"; itemId: number }
  | { type: "phase"; phase: Phase; day: number }
  | { type: "message"; text: string }
  | { type: "victory" }
  | { type: "game-over" };

export interface InteractionHint {
  action: "pickup" | "drop" | "feed" | "cactus" | "mine" | "well" | "none";
  text: string;
}

/**
 * 猎物图鉴。数值按原图等比缩放（原图主角 600 血 / 240 移速，我们是 100 / 8.2）。
 *
 * 设计意图是拉开一条「好抓但不值钱 ←→ 难抓但一顿管饱」的谱：
 *   甲壳虫  几乎不跑，一刀一块肉
 *   野兔    比玩家快，但冲 2 秒就没劲，绕两下能追到
 *   骆驼    比玩家快得多、冲 4.5 秒、90 血，但一头顶得上四块肉外加两份水
 */
export const CRITTER_SPECS: Record<CritterKind, CritterSpec> = {
  beetle: {
    label: "甲壳虫", maxHealth: 8, fleeSpeed: 2.6, grazeSpeed: 0.7, alertRadius: 3.5,
    sprintSeconds: 99, sprintRecovery: 1, meat: 1, hide: 0, water: 0, population: 9, scale: 0.5,
  },
  sandworm: {
    // 原图沙虫会「钻沙」瞬间脱离，这里用极短的冲刺 + 极快的速度近似。
    label: "沙虫", maxHealth: 6, fleeSpeed: 7.4, grazeSpeed: 0.5, alertRadius: 5,
    sprintSeconds: 1.4, sprintRecovery: 3, meat: 1, hide: 0, water: 0, population: 8, scale: 0.55,
  },
  gerbil: {
    label: "沙鼠", maxHealth: 12, fleeSpeed: 7.6, grazeSpeed: 1.1, alertRadius: 7,
    sprintSeconds: 2.4, sprintRecovery: 3.5, meat: 1, hide: 0, water: 0, population: 7, scale: 0.6,
  },
  rat: {
    label: "白颈鼠", maxHealth: 14, fleeSpeed: 7, grazeSpeed: 1.1, alertRadius: 6.5,
    sprintSeconds: 2.6, sprintRecovery: 3.5, meat: 1, hide: 0, water: 0, population: 6, scale: 0.65,
  },
  lizard: {
    label: "蜥蜴", maxHealth: 16, fleeSpeed: 6.2, grazeSpeed: 0.9, alertRadius: 6,
    sprintSeconds: 3, sprintRecovery: 3, meat: 1, hide: 0, water: 0, population: 7, scale: 0.7,
  },
  hare: {
    label: "野兔", maxHealth: 10, fleeSpeed: 9.6, grazeSpeed: 1.3, alertRadius: 9,
    sprintSeconds: 2, sprintRecovery: 4, meat: 2, hide: 0, water: 0, population: 6, scale: 0.7,
  },
  vulture: {
    label: "秃鹰", maxHealth: 10, fleeSpeed: 5.2, grazeSpeed: 0.8, alertRadius: 8,
    sprintSeconds: 2.6, sprintRecovery: 3, meat: 2, hide: 0, water: 0, population: 5, scale: 0.85,
  },
  camel: {
    label: "骆驼", maxHealth: 90, fleeSpeed: 10.5, grazeSpeed: 1.4, alertRadius: 11,
    sprintSeconds: 4.5, sprintRecovery: 6, meat: 4, hide: 2, water: 2, population: 4, scale: 1.5,
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
  "wash-water": 3,
};
