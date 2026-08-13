import { distance, mulberry32, TAU } from "../simulation/geometry";
import { campGatePosition, isTerrainWalkable, terrainSlopeAt } from "../terrain/TerrainModel";
import type {
  CactusPatch,
  CampKind,
  CampDefinition,
  CircleObstacle,
  FuelBarrelDefinition,
  GroundItem,
  HillDefinition,
  IronNode,
  WellDefinition,
  LandmarkDefinition,
  TerrainStyle,
  TreeDefinition,
  TruckDefinition,
  Vec2,
  WorldDefinition,
  DenDefinition,
} from "../simulation/types";
import { BARRIER_STATS } from "../simulation/types";
import mapBlueprint from "./mapBlueprint.json";

interface MapBlueprint {
  size: number;
  resolution: number;
  seed: number;
  maxWalkableSlope: number;
  startCampId: number;
  camps: Array<{
    x: number;
    z: number;
    entranceAngle: number;
    kind: CampKind;
    terrainStyle: TerrainStyle;
    elevation: number;
    radius: number;
    approachWidth: number;
    platform: Vec2[];
    approach: Vec2[];
    gate: Vec2;
  }>;
  /** 狗巢：位置与形状同时驱动地形烘焙（shape_dens）和运行时刷怪点。 */
  dens?: Array<{
    id: number;
    x: number;
    z: number;
    mouthAngle: number;
    radius: number;
    rimHeight: number;
    hollowDepth: number;
    mouthWidth: number;
  }>;
  ridges: Array<Omit<HillDefinition, "id">>;
}

const BLUEPRINT = mapBlueprint as MapBlueprint;

const CAMP_ENTRANCE_WIDTH: Record<CampKind, number> = {
  "deep-cave": 0.19,
  "abandoned-camp": 0.25,
  "windy-ridge": 0.32,
};

function awayFromCamps(point: Vec2, camps: CampDefinition[], padding: number): boolean {
  return camps.every((camp) => distance(point, camp) > camp.radius + padding);
}

/** 卡车的占地半径；同时进 walls，所以它对玩家、狗和寻路都是一堵实墙。 */
const TRUCK_RADIUS = 2.4;
/** 巢边那一组油桶离巢心多远。巢的土垄半径 8，12 米刚好落在垄外的平地上。 */
const DEN_BARREL_RADIUS = 12;
/** 卡车离巢心多远。33 米开外守巢犬看不见（它们视野 14.5 米）。 */
const TRUCK_DEN_DISTANCE = 22;
const DEN_BARREL_COUNT = 3;
const FIELD_BARREL_COUNT = 6;

type TerrainWorld = Parameters<typeof isTerrainWalkable>[0];

/**
 * 卡车与九桶汽油。
 *
 * 位置关系是这套目标的全部设计：
 *
 *   巢边 3 桶 ──(33 m)── 卡车
 *      ↑                    ↑
 *   守巢的五只大狼        安全，没有守卫
 *
 * 卡车放在**巢的背面**（mouthAngle + π），于是走到车边不会惊动趴在巢口那侧的守卫；
 * 而巢边三桶就在守卫脚下 —— 想吃这条近路就得先打赢。
 *
 * 野外六桶按"离巢远、彼此也远"散布，逼出真正的长途搬运：扛桶移速只有 0.54 倍。
 */
function placeTruckAndBarrels(
  den: DenDefinition | null,
  camps: CampDefinition[],
  terrainWorld: TerrainWorld,
  walls: CircleObstacle[],
  random: () => number,
  size: number,
): { truck: TruckDefinition; barrels: FuelBarrelDefinition[] } {
  const origin: Vec2 = den ?? { x: 36, z: -42 };
  const mouthAngle = den?.mouthAngle ?? 2.62;
  const truckAngle = mouthAngle + Math.PI;
  const truckPoint = {
    x: origin.x + Math.cos(truckAngle) * TRUCK_DEN_DISTANCE,
    z: origin.z + Math.sin(truckAngle) * TRUCK_DEN_DISTANCE,
  };
  // 驶出方向取最近的一条边：横向近就往横里开，纵向近就往纵里开。
  const half = size / 2;
  const exit: Vec2 = half - Math.abs(truckPoint.x) <= half - Math.abs(truckPoint.z)
    ? { x: Math.sign(truckPoint.x) || 1, z: 0 }
    : { x: 0, z: Math.sign(truckPoint.z) || 1 };
  const truck: TruckDefinition = {
    ...truckPoint,
    rotation: Math.atan2(exit.z, exit.x),
    exit,
  };

  const barrels: FuelBarrelDefinition[] = [];
  // 巢边三桶：沿巢口方向张开 ±0.45 弧度的一小段弧，三桶彼此隔着四五米，
  // 所以一次只能扛走一桶 —— 打完守卫还得往返三趟。
  for (let index = 0; index < DEN_BARREL_COUNT; index += 1) {
    const spread = (index - (DEN_BARREL_COUNT - 1) / 2) * 0.45;
    const angle = mouthAngle + spread;
    barrels.push({
      id: barrels.length,
      x: origin.x + Math.cos(angle) * DEN_BARREL_RADIUS,
      z: origin.z + Math.sin(angle) * DEN_BARREL_RADIUS,
      rotation: random() * TAU,
      guarded: true,
    });
  }

  // 野外六桶。约束按重要性排序：可走 > 离巢远 > 彼此远 > 不压在营地/墙上。
  // 找不到位置时逐步放松彼此的间距，保证六桶一定放得下。
  for (let index = 0; index < FIELD_BARREL_COUNT; index += 1) {
    let separation = 46;
    let placed = false;
    for (let attempt = 0; attempt < 900 && !placed; attempt += 1) {
      if (attempt > 0 && attempt % 300 === 0) separation -= 9;
      const point = { x: (random() - 0.5) * 186, z: (random() - 0.5) * 186 };
      if (distance(point, origin) < 55) continue;
      if (!awayFromCamps(point, camps, 10)) continue;
      if (!isTerrainWalkable(terrainWorld, point) || terrainSlopeAt(terrainWorld, point) > 0.4) continue;
      if (walls.some((wall) => distance(point, wall) < wall.radius + 2.4)) continue;
      if (barrels.some((barrel) => distance(point, barrel) < separation)) continue;
      barrels.push({ id: barrels.length, ...point, rotation: random() * TAU, guarded: false });
      placed = true;
    }
  }

  return { truck, barrels };
}

export function createWorld(seed = 71291): WorldDefinition {
  const random = mulberry32(seed);
  const size = BLUEPRINT.size;
  const terrain = {
    resolution: BLUEPRINT.resolution,
    seed: BLUEPRINT.seed,
    maxWalkableSlope: BLUEPRINT.maxWalkableSlope,
  };
  const camps: CampDefinition[] = BLUEPRINT.camps.map((source, id) => ({
    id,
    ...source,
    entranceWidth: CAMP_ENTRANCE_WIDTH[source.kind],
    radius: source.radius,
  }));

  const walls: CircleObstacle[] = [];

  const hills: HillDefinition[] = BLUEPRINT.ridges.map((ridge, id) => ({ id, ...ridge }));
  const terrainWorld = { camps, hills, terrain };

  /**
   * 狗巢。位置在蓝图里，地形烘焙时会照着它刻出土垄与缺口
   * （见 authoring/terrain/generate_heightfield.py 的 shape_dens）。
   * 这里只把它翻译成运行时结构，并算出巢口的世界坐标。
   *
   * 它现在还多了一个职责：**卡车与巢边三桶油都以它为原点定位**，
   * 所以这一段必须排在树/地标之前 —— 卡车要先占住位置，后面的散布才会避开它。
   */
  const dens: DenDefinition[] = (BLUEPRINT.dens ?? []).map((source) => ({
    id: source.id,
    x: source.x,
    z: source.z,
    mouthAngle: source.mouthAngle,
    radius: source.radius,
    // 巢口落在土垄的缺口上：从中心沿 mouthAngle 走到垄外一点，狼从这里踏出来。
    mouth: {
      x: source.x + Math.cos(source.mouthAngle) * source.radius * 0.82,
      z: source.z + Math.sin(source.mouthAngle) * source.radius * 0.82,
    },
  }));

  const { truck, barrels } = placeTruckAndBarrels(dens[0] ?? null, camps, terrainWorld, walls, random, size);
  walls.push({ x: truck.x, z: truck.z, radius: TRUCK_RADIUS, kind: "landmark" });

  const trees: TreeDefinition[] = [];
  let attempts = 0;
  while (trees.length < 18 && attempts < 450) {
    attempts += 1;
    const point = { x: (random() - 0.5) * 192, z: (random() - 0.5) * 192 };
    if (!awayFromCamps(point, camps, 3)) continue;
    if (!isTerrainWalkable(terrainWorld, point) || terrainSlopeAt(terrainWorld, point) > 0.42) continue;
    if (trees.some((tree) => distance(point, tree) < 8)) continue;
    trees.push({ id: trees.length, ...point, rotation: random() * TAU, scale: 0.75 + random() * 0.55 });
    walls.push({ ...point, radius: 1.05, kind: "tree" });
  }

  const initialItems: GroundItem[] = [];
  const addItem = (kind: GroundItem["kind"], x: number, z: number): void => {
    initialItems.push({
      id: initialItems.length,
      kind,
      x,
      z,
      hp: BARRIER_STATS[kind].hp,
      placed: false,
      active: true,
      rotation: random() * TAU,
    });
  };

  // Each cliff shelter has one narrow ramp and one movable boulder that can seal it.
  for (const camp of camps) {
    const gate = campGatePosition(camp);
    addItem("stone", gate.x, gate.z);
  }

  // The starting abandoned camp contains enough wood to teach fire management immediately.
  const startCamp = camps[BLUEPRINT.startCampId];
  addItem("wood", startCamp.x + 2.2, startCamp.z + 2.6);
  addItem("wood", startCamp.x - 2.4, startCamp.z + 1.4);
  addItem("wood", startCamp.x + 3.4, startCamp.z - 2.2);
  addItem("wood", startCamp.x - 3.8, startCamp.z - 1.7);

  for (let id = 0; id < 68; id += 1) {
    const kind: GroundItem["kind"] = random() < 0.72 ? "wood" : "stone";
    let point = { x: 0, z: 0 };
    for (let guard = 0; guard < 30; guard += 1) {
      point = { x: (random() - 0.5) * 196, z: (random() - 0.5) * 196 };
      const clearsWalls = walls.every((wall) => distance(point, wall) > wall.radius + 1.2);
      const clearsHills = isTerrainWalkable(terrainWorld, point);
      if (clearsWalls && clearsHills) break;
    }
    addItem(kind, point.x, point.z);
  }

  const initialCacti: CactusPatch[] = [
    { id: 0, x: -31, z: -15, juice: 2, regrowAt: 0 },
    { id: 1, x: -19, z: -22, juice: 2, regrowAt: 0 },
  ];
  while (initialCacti.length < 32) {
    const point = { x: (random() - 0.5) * 196, z: (random() - 0.5) * 196 };
    if (!awayFromCamps(point, camps, -2)) continue;
    if (!isTerrainWalkable(terrainWorld, point)) continue;
    if (initialCacti.some((cactus) => distance(point, cactus) < 6)) continue;
    initialCacti.push({ id: initialCacti.length, ...point, juice: 2, regrowAt: 0 });
  }

  const ironNodes: IronNode[] = [];
  attempts = 0;
  while (ironNodes.length < 14 && attempts < 500) {
    attempts += 1;
    const point = { x: (random() - 0.5) * 188, z: (random() - 0.5) * 188 };
    if (!awayFromCamps(point, camps, 3)) continue;
    if (!isTerrainWalkable(terrainWorld, point) || terrainSlopeAt(terrainWorld, point) > 0.52) continue;
    if (ironNodes.some((node) => distance(point, node) < 10)) continue;
    ironNodes.push({
      id: ironNodes.length,
      ...point,
      ore: 2 + Math.floor(random() * 2),
      rotation: random() * TAU,
    });
  }

  // 干枯的井：每座营地配一口，落在营地外 22~34 米的可走地面上。
  // 距离是刻意的 —— 井必须在"营地视野之外但一趟能来回"的圈上，
  // 取水才会变成一次需要规划的外出，而不是站在火边顺手就办了。
  const wells: WellDefinition[] = [];
  for (const camp of camps) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const angle = random() * TAU;
      const radius = 22 + random() * 12;
      const point = { x: camp.x + Math.cos(angle) * radius, z: camp.z + Math.sin(angle) * radius };
      if (Math.abs(point.x) > 96 || Math.abs(point.z) > 96) continue;
      if (!awayFromCamps(point, camps, 6)) continue;
      if (!isTerrainWalkable(terrainWorld, point) || terrainSlopeAt(terrainWorld, point) > 0.34) continue;
      if (walls.some((wall) => distance(point, wall) < wall.radius + 2.4)) continue;
      if (wells.some((well) => distance(point, well) < 26)) continue;
      wells.push({ id: wells.length, ...point, rotation: random() * TAU });
      break;
    }
  }

  const landmarks: LandmarkDefinition[] = [];
  attempts = 0;
  while (landmarks.length < 16 && attempts < 600) {
    attempts += 1;
    const point = { x: (random() - 0.5) * 190, z: (random() - 0.5) * 190 };
    if (!awayFromCamps(point, camps, 5)) continue;
    if (!isTerrainWalkable(terrainWorld, point) || terrainSlopeAt(terrainWorld, point) > 0.48) continue;
    if (landmarks.some((landmark) => distance(point, landmark) < 12)) continue;
    const index = landmarks.length;
    const kind = index % 5 < 2 ? "deadwood" : index % 5 < 4 ? "monolith" : "wreck";
    const landmark: LandmarkDefinition = {
      id: index,
      kind,
      ...point,
      rotation: random() * TAU,
      scale: 0.85 + random() * 0.45,
    };
    landmarks.push(landmark);
    if (kind !== "deadwood") {
      walls.push({ ...point, radius: kind === "wreck" ? 1.7 : 1.15, kind: "landmark" });
    }
  }

  return {
    size,
    terrain,
    camps,
    walls,
    trees,
    hills,
    initialItems,
    initialCacti,
    dens,
    barrels,
    truck,
    ironNodes,
    wells,
    landmarks,
    startCampId: BLUEPRINT.startCampId,
  };
}
