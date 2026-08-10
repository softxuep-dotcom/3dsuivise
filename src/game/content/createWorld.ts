import { distance, mulberry32, TAU } from "../simulation/geometry";
import { campGatePosition, isTerrainWalkable, terrainSlopeAt } from "../terrain/TerrainModel";
import type {
  CactusPatch,
  CampKind,
  CampDefinition,
  CircleObstacle,
  GroundItem,
  HillDefinition,
  IronNode,
  WellDefinition,
  LandmarkDefinition,
  TerrainStyle,
  TreeDefinition,
  Vec2,
  WorldDefinition,
} from "../simulation/types";
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
      hp: kind === "stone" ? 220 : 70,
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
    ironNodes,
    wells,
    landmarks,
    startCampId: BLUEPRINT.startCampId,
  };
}
