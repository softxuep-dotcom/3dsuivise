import { angleDifference, distance, mulberry32, TAU } from "../simulation/geometry";
import { isTerrainWalkable, terrainSlopeAt } from "../terrain/TerrainModel";
import type {
  BerryPatch,
  CampKind,
  CampDefinition,
  CircleObstacle,
  GroundItem,
  HillDefinition,
  IronNode,
  LandmarkDefinition,
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
  camps: Array<{ x: number; z: number; entranceAngle: number; kind: CampKind; elevation: number }>;
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
    radius: 11,
  }));

  const walls: CircleObstacle[] = [];
  for (const camp of camps) {
    const segments = camp.kind === "deep-cave" ? 18 : camp.kind === "abandoned-camp" ? 15 : 13;
    for (let index = 0; index < segments; index += 1) {
      const angle = (index / segments) * TAU;
      if (angleDifference(angle, camp.entranceAngle) < camp.entranceWidth) continue;
      const uneven = (random() - 0.5) * 0.6;
      walls.push({
        x: camp.x + Math.cos(angle) * (camp.radius + uneven),
        z: camp.z + Math.sin(angle) * (camp.radius + uneven),
        radius: 1.55 + random() * 0.7,
        kind: "wall",
      });
    }
  }

  const hills: HillDefinition[] = BLUEPRINT.ridges.map((ridge, id) => ({ id, ...ridge }));
  const terrainWorld = { camps, hills, terrain };

  const trees: TreeDefinition[] = [];
  let attempts = 0;
  while (trees.length < 16 && attempts < 400) {
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

  // Every hollow has a movable entrance boulder; one seals caves, windy gaps may need two.
  for (const camp of camps) {
    const inward = camp.radius - 2.1;
    addItem(
      "stone",
      camp.x + Math.cos(camp.entranceAngle) * inward,
      camp.z + Math.sin(camp.entranceAngle) * inward,
    );
    if (camp.kind === "windy-ridge") {
      const sideAngle = camp.entranceAngle + Math.PI / 2;
      addItem(
        "stone",
        camp.x + Math.cos(camp.entranceAngle) * (inward - 1.6) + Math.cos(sideAngle) * 2.2,
        camp.z + Math.sin(camp.entranceAngle) * (inward - 1.6) + Math.sin(sideAngle) * 2.2,
      );
    }
  }

  // The starting abandoned camp contains enough wood to teach fire management immediately.
  const startCamp = camps[4];
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

  const initialBerries: BerryPatch[] = [
    { id: 0, x: -34, z: -18, berries: 2, regrowAt: 0 },
    { id: 1, x: -13, z: -34, berries: 2, regrowAt: 0 },
  ];
  while (initialBerries.length < 32) {
    const point = { x: (random() - 0.5) * 196, z: (random() - 0.5) * 196 };
    if (!awayFromCamps(point, camps, -2)) continue;
    if (!isTerrainWalkable(terrainWorld, point)) continue;
    if (initialBerries.some((berry) => distance(point, berry) < 6)) continue;
    initialBerries.push({ id: initialBerries.length, ...point, berries: 2, regrowAt: 0 });
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
    initialBerries,
    ironNodes,
    landmarks,
    startCampId: 4,
  };
}
