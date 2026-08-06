export interface Vec2 {
  x: number;
  z: number;
}

export type Phase = "day" | "night";
export type CarryKind = "wood" | "stone";
export type GroundItemKind = CarryKind;
export type WolfMode = "entering" | "patrol" | "chase" | "raid" | "dead";

export interface CircleObstacle extends Vec2 {
  radius: number;
  kind: "wall" | "tree";
}

export interface CampDefinition extends Vec2 {
  id: number;
  entranceAngle: number;
  radius: number;
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

export interface BerryPatch extends Vec2 {
  id: number;
  berries: number;
  regrowAt: number;
}

export interface CampState {
  id: number;
  fuel: number;
}

export interface PlayerState extends Vec2 {
  facing: Vec2;
  health: number;
  warmth: number;
  hunger: number;
  berries: number;
  carrying: CarryKind | null;
  attackCooldown: number;
  attackFlash: number;
  hurtFlash: number;
  kills: number;
}

export interface WolfState extends Vec2 {
  id: number;
  facing: Vec2;
  health: number;
  mode: WolfMode;
  raider: boolean;
  anchor: Vec2;
  patrolAngle: number;
  speed: number;
  attackCooldown: number;
  lostTimer: number;
  hurtFlash: number;
  deathTimer: number;
}

export interface WorldDefinition {
  size: number;
  camps: CampDefinition[];
  walls: CircleObstacle[];
  trees: TreeDefinition[];
  hills: HillDefinition[];
  initialItems: GroundItem[];
  initialBerries: BerryPatch[];
  startCampId: number;
}

export type GameEvent =
  | { type: "pickup"; kind: CarryKind | "berry" }
  | { type: "drop"; kind: CarryKind }
  | { type: "feed-fire"; campId: number }
  | { type: "eat" }
  | { type: "attack" }
  | { type: "wolf-hit"; wolfId: number }
  | { type: "wolf-killed"; wolfId: number }
  | { type: "player-hit"; amount: number }
  | { type: "barrier-hit"; itemId: number }
  | { type: "phase"; phase: Phase; day: number }
  | { type: "message"; text: string }
  | { type: "game-over" };

export interface InteractionHint {
  action: "pickup" | "drop" | "feed" | "berry" | "none";
  text: string;
}
