import { angleDifference, distance, mulberry32, pointInEllipse, TAU } from "../simulation/geometry";
import type {
  BerryPatch,
  CampDefinition,
  CircleObstacle,
  GroundItem,
  HillDefinition,
  TreeDefinition,
  Vec2,
  WorldDefinition,
} from "../simulation/types";

const CAMP_LAYOUT: Array<[number, number, number]> = [
  [-82, -82, 0.78], [-20, -92, 1.35], [58, -82, 2.3],
  [-91, -35, 0.15], [-30, -30, -0.55], [34, -40, 2.85], [88, -16, 3.1],
  [-78, 26, -0.2], [-19, 22, 1.05], [48, 18, 2.55],
  [-46, 76, -1.15], [49, 75, -2.35],
];

function awayFromCamps(point: Vec2, camps: CampDefinition[], padding: number): boolean {
  return camps.every((camp) => distance(point, camp) > camp.radius + padding);
}

export function createWorld(seed = 71291): WorldDefinition {
  const random = mulberry32(seed);
  const size = 220;
  const camps: CampDefinition[] = CAMP_LAYOUT.map(([x, z, entranceAngle], id) => ({
    id,
    x,
    z,
    entranceAngle,
    radius: 11,
  }));

  const walls: CircleObstacle[] = [];
  for (const camp of camps) {
    const segments = 22;
    for (let index = 0; index < segments; index += 1) {
      const angle = (index / segments) * TAU;
      if (angleDifference(angle, camp.entranceAngle) < 0.34) continue;
      const uneven = (random() - 0.5) * 0.6;
      walls.push({
        x: camp.x + Math.cos(angle) * (camp.radius + uneven),
        z: camp.z + Math.sin(angle) * (camp.radius + uneven),
        radius: 1.35 + random() * 0.45,
        kind: "wall",
      });
    }
  }

  const hills: HillDefinition[] = [];
  for (let id = 0; id < 42; id += 1) {
    const point = {
      x: (random() - 0.5) * (size - 18),
      z: (random() - 0.5) * (size - 18),
    };
    if (!awayFromCamps(point, camps, 7)) continue;
    hills.push({
      id,
      ...point,
      scaleX: 4 + random() * 7,
      scaleZ: 3 + random() * 6,
      height: 1.1 + random() * 2.2,
      rotation: random() * TAU,
    });
  }

  const trees: TreeDefinition[] = [];
  let attempts = 0;
  while (trees.length < 24 && attempts < 400) {
    attempts += 1;
    const point = { x: (random() - 0.5) * 192, z: (random() - 0.5) * 192 };
    if (!awayFromCamps(point, camps, 3)) continue;
    if (hills.some((hill) => pointInEllipse(point, hill, 1.4))) continue;
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
      hp: kind === "stone" ? 95 : 70,
      placed: false,
      active: true,
      rotation: random() * TAU,
    });
  };

  // The starting hollow always teaches the loop without a long search.
  addItem("wood", -28, -27.4);
  addItem("wood", -21, -31);
  addItem("wood", -38, -24);
  addItem("wood", -31, -15);
  addItem("stone", -21, -20);
  addItem("stone", -17, -24);

  for (let id = 0; id < 68; id += 1) {
    const kind: GroundItem["kind"] = random() < 0.72 ? "wood" : "stone";
    let point = { x: 0, z: 0 };
    for (let guard = 0; guard < 30; guard += 1) {
      point = { x: (random() - 0.5) * 196, z: (random() - 0.5) * 196 };
      const clearsWalls = walls.every((wall) => distance(point, wall) > wall.radius + 1.2);
      const clearsHills = hills.every((hill) => !pointInEllipse(point, hill, 1.2));
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
    if (hills.some((hill) => pointInEllipse(point, hill, 1))) continue;
    if (initialBerries.some((berry) => distance(point, berry) < 6)) continue;
    initialBerries.push({ id: initialBerries.length, ...point, berries: 2, regrowAt: 0 });
  }

  return {
    size,
    camps,
    walls,
    trees,
    hills,
    initialItems,
    initialBerries,
    startCampId: 4,
  };
}
