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
  | "wolf-hide"
  | "iron-ore"
  | "water";
export type WeaponKind = "wood-club" | "iron-spear";
export type WolfKind = "small" | "large" | "alpha";
export type WolfMode = "entering" | "patrol" | "chase" | "raid" | "retreating" | "dead";
/** 野狼白天在地图上游荡且只在被激怒后反击；夜袭狼由边缘涌入且不掉狼皮。 */
export type WolfRole = "wild" | "raider";
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
  hasLeatherCoat: boolean;
  weapon: WeaponKind;
  resting: boolean;
  idleTime: number;
  attackCooldown: number;
  attackFlash: number;
  hurtFlash: number;
  /** 取水动作的剩余秒数，>0 时玩家正在挖沙或割仙人掌。 */
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
  | { type: "dig-water" }
  | { type: "cook" }
  | { type: "craft-coat" }
  | { type: "craft-weapon" }
  | { type: "rest"; active: boolean }
  | { type: "attack" }
  | { type: "exhausted" }
  | { type: "condition"; condition: SurvivalCondition }
  | { type: "wolf-hit"; wolfId: number }
  | { type: "wolf-killed"; wolfId: number }
  | { type: "alpha-spawned" }
  | { type: "player-hit"; amount: number }
  | { type: "barrier-hit"; itemId: number }
  | { type: "phase"; phase: Phase; day: number }
  | { type: "message"; text: string }
  | { type: "victory" }
  | { type: "game-over" };

export interface InteractionHint {
  action: "pickup" | "drop" | "feed" | "cactus" | "mine" | "dig" | "none";
  text: string;
}

export const INVENTORY_CAPACITY = 8;

export const INVENTORY_STACK_LIMITS: Record<InventoryItemKind, number> = {
  "cactus-juice": 4,
  "raw-meat": 3,
  "cooked-meat": 3,
  "wolf-hide": 4,
  "iron-ore": 6,
  water: 4,
};
