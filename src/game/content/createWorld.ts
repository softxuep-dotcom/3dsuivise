import { distance, mulberry32, normalize, TAU } from "../simulation/geometry";
import { campGatePosition, campLocalToWorld, isTerrainWalkable, terrainSlopeAt } from "../terrain/TerrainModel";
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
const DEN_BARREL_COUNT = 3;

/**
 * 卡车停在**出生营地大门外**：出门就看得见它，它就是"我在为什么忙活"的实体答案。
 *
 * 之前卡车停在狗巢背面 22 米 —— 玩家要跑过大半张图才第一次见到通关目标，
 * 而巢边那三桶油离车只有 33 米，于是最优解永远是"清掉守卫、原地搬三趟"，
 * 野外那六桶几乎没人碰。把车挪到家门口之后，九桶油对卡车的距离第一次拉开了梯度。
 */
const TRUCK_GATE_MIN = 6;
const TRUCK_GATE_MAX = 22;
/**
 * 卡车所在地的坡度上限。比井（0.34）更严 —— 井只要人站得住，
 * 车还要能**开出去**：太陡的话发车动画会把车推进坡里。
 */
const TRUCK_MAX_SLOPE = 0.26;
/**
 * 发车方向的采样步长。**一路验到图外**，不是验个二三十米就算数 ——
 * 营地崖壁能在四十米外横在路中间（camp0 的崖坡度 0.99），
 * 而"停得下、开不出去"是玩家在通关那一刻才会撞上的死局。
 */
const TRUCK_EXIT_STEP = 3;
/** 卡车模型的车身长度（buildTruck 的底盘 BoxGeometry 是 6.2 长）。 */
const TRUCK_LENGTH = 6.2;
/** 想让卡车在画面上比坡底靠右几个车身。 */
const TRUCK_RIGHT_LENGTHS = 2.5;
/** 为此在坡底邻域里搜多大范围、多密。 */
const TRUCK_SHIFT_RANGE = 22;
const TRUCK_SHIFT_STEP = 2;

type TerrainWorld = Parameters<typeof isTerrainWalkable>[0];

/**
 * 卡车选址：沿出生营地的大门朝向往外扫，取第一个**车开得出去**的点。
 *
 * 不写死坐标 —— 地形是烘焙出来的，一旦重烘或换出生营地，写死的点就会落进坡里，
 * 而"卡在地形里发不了车"是没法从存档里救回来的那种 bug。所以这里用游戏自己的
 * `isTerrainWalkable` / `terrainSlopeAt` 逐点验，并且**连发车方向也一起验**。
 */
function placeTruck(
  startCamp: CampDefinition,
  camps: CampDefinition[],
  terrainWorld: TerrainWorld,
  walls: CircleObstacle[],
  size: number,
): TruckDefinition {
  /*
   * 锚点用**坡道末端**而不是大门。
   *
   * 营地建在 11.8 米高的台地上，大门只是坡顶；玩家真正"走出来"的那一刻是在坡底，
   * 而坡道是拐弯的（camp1 从大门 (-0.3,-19.5) 绕到坡底 (-0.3,-34.5)）。
   * 按大门方向放车，车会落在坡的侧面 —— 下坡时它在你身后。
   * 按坡底 + 出坡方向放，下坡走完抬头正好看见。
   */
  const approach = startCamp.approach.map((local) => campLocalToWorld(startCamp, local));
  const rampEnd = approach[approach.length - 1] ?? campGatePosition(startCamp);
  const rampPrev = approach[approach.length - 2] ?? startCamp;
  const outward = normalize({ x: rampEnd.x - rampPrev.x, z: rampEnd.z - rampPrev.z });
  const gate = rampEnd;
  const half = size / 2;

  /** 这条边一路开到图外是否畅通。车宽 2.4，所以左右各偏一个车身也要能过。 */
  const exitClear = (point: Vec2, exit: Vec2): boolean => {
    const side = { x: -exit.z, z: exit.x };
    const limit = half - (Math.abs(exit.x) > 0 ? Math.abs(point.x) : Math.abs(point.z));
    for (let step = TRUCK_EXIT_STEP; step <= limit + TRUCK_EXIT_STEP; step += TRUCK_EXIT_STEP) {
      for (const lateral of [0, TRUCK_RADIUS, -TRUCK_RADIUS]) {
        const ahead = {
          x: point.x + exit.x * step + side.x * lateral,
          z: point.z + exit.z * step + side.z * lateral,
        };
        if (Math.abs(ahead.x) > half || Math.abs(ahead.z) > half) continue;
        if (!isTerrainWalkable(terrainWorld, ahead)) return false;
        if (terrainSlopeAt(terrainWorld, ahead) > TRUCK_MAX_SLOPE + 0.16) return false;
      }
    }
    return true;
  };

  /** 四条边都试，返回第一条真正通到图外的；一条都不通就返回 null。 */
  const findExit = (point: Vec2): Vec2 | null => {
    const candidates: Vec2[] = [
      { x: 0, z: -1 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 1, z: 0 },
    ];
    // 优先离得最近的那条边，纯粹是为了动画短一点。
    candidates.sort((a, b) => {
      const da = a.x !== 0 ? half - a.x * point.x : half - a.z * point.z;
      const db = b.x !== 0 ? half - b.x * point.x : half - b.z * point.z;
      return da - db;
    });
    return candidates.find((exit) => exitClear(point, exit)) ?? null;
  };

  const usable = (point: Vec2): Vec2 | null => {
    if (Math.abs(point.x) > half - 12 || Math.abs(point.z) > half - 12) return null;
    if (!isTerrainWalkable(terrainWorld, point)) return null;
    if (terrainSlopeAt(terrainWorld, point) > TRUCK_MAX_SLOPE) return null;
    // 车身是实心的，别让它和营地崖壁或已有障碍互相嵌进去。
    if (!awayFromCamps(point, camps, TRUCK_RADIUS + 2)) return null;
    if (walls.some((wall) => distance(point, wall) < wall.radius + TRUCK_RADIUS + 1.5)) return null;
    return findExit(point);
  };

  // 从坡底往外推，同时左右摆 —— 坡底正前方常常还在坡的影响区里。
  for (let distanceOut = TRUCK_GATE_MIN; distanceOut <= TRUCK_GATE_MAX; distanceOut += 2) {
    for (const sweep of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9]) {
      const angle = Math.atan2(outward.z, outward.x) + sweep;
      const point = {
        x: gate.x + Math.cos(angle) * distanceOut,
        z: gate.z + Math.sin(angle) * distanceOut,
      };
      const exit = usable(point);
      if (!exit) continue;
      /*
       * 找到位置之后，在邻域里挑一个**在画面上更靠右**的落点。
       *
       * 不能只沿屏幕右方直线推：实测那条线正好穿过一条山脊，
       * +8~16 米可走、+18~22 米是 0.28~0.44 的陡坡，而且推过去之后**四个方向的
       * 驶出通道全被堵死**（北 15 米不可走、西 18 米坡度 0.44…）。
       * 只推不搜的结果是每一档都被 usable() 否掉、车静默地回到原位。
       *
       * 所以改成扫一小片：允许它在纵向也挪一点来绕开山脊，
       * 评分只要求「屏幕右位移接近目标」且「屏幕上下漂移尽量小」。
       * 一个都找不到就退回原点 —— 宁可不挪，也不能把车放到开不出去的地方。
       */
      const targetRight = TRUCK_RIGHT_LENGTHS * TRUCK_LENGTH;
      let best: { point: Vec2; exit: Vec2; score: number } | null = null;
      for (let dx = -TRUCK_SHIFT_RANGE; dx <= TRUCK_SHIFT_RANGE; dx += TRUCK_SHIFT_STEP) {
        for (let dz = -TRUCK_SHIFT_RANGE; dz <= TRUCK_SHIFT_RANGE; dz += TRUCK_SHIFT_STEP) {
          // 屏幕右 = 世界 (+x, −z)/√2，屏幕上 = 世界 (−x, −z)/√2。
          const right = (dx - dz) / Math.SQRT2;
          const up = -(dx + dz) / Math.SQRT2;
          const score = Math.abs(right - targetRight) + Math.abs(up) * 0.8;
          if (best && score >= best.score) continue;
          const candidate = { x: point.x + dx, z: point.z + dz };
          const candidateExit = usable(candidate);
          if (!candidateExit) continue;
          best = { point: candidate, exit: candidateExit, score };
        }
      }
      if (best) return { ...best.point, rotation: Math.atan2(best.exit.z, best.exit.x), exit: best.exit };
      return { ...point, rotation: Math.atan2(exit.z, exit.x), exit };
    }
  }

  // 兜底：扫不到就贴着坡底放，并且仍然挑一条最不坏的边。
  const fallback = { x: gate.x + outward.x * TRUCK_GATE_MIN, z: gate.z + outward.z * TRUCK_GATE_MIN };
  const exit = findExit(fallback) ?? { x: 0, z: Math.sign(fallback.z) || 1 };
  return { ...fallback, rotation: Math.atan2(exit.z, exit.x), exit };
}

function placeBarrels(
  den: DenDefinition | null,
  truck: TruckDefinition,
  camps: CampDefinition[],
  terrainWorld: TerrainWorld,
  walls: CircleObstacle[],
  random: () => number,
): FuelBarrelDefinition[] {
  const origin: Vec2 = den ?? { x: 36, z: -42 };
  const mouthAngle = den?.mouthAngle ?? 2.62;

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

  /*
   * 野外六桶。卡车挪到出生营地门口之后，"离巢远"不再等于"离车远"，
   * 所以约束改成**按到卡车的距离分档**：近、中、远各两桶。
   *
   * 这样第一趟一定拿得到（最近的一桶 30~55 米），而最后一两桶必须走远门 ——
   * 九桶油对卡车第一次有了梯度，而不是"要么巢边三桶、要么满图乱找"。
   */
  const bands: Array<[number, number]> = [[30, 55], [55, 85], [85, 125]];
  for (const [near, far] of bands) {
    for (let slot = 0; slot < 2; slot += 1) {
      let separation = 34;
      let placed = false;
      for (let attempt = 0; attempt < 900 && !placed; attempt += 1) {
        if (attempt > 0 && attempt % 300 === 0) separation -= 8;
        const point = { x: (random() - 0.5) * 186, z: (random() - 0.5) * 186 };
        const toTruck = distance(point, truck);
        if (toTruck < near || toTruck > far) continue;
        // 别贴着狗巢 —— 那三桶是"守卫版"，野外桶必须是真的没人看着。
        if (distance(point, origin) < 34) continue;
        if (!awayFromCamps(point, camps, 10)) continue;
        if (!isTerrainWalkable(terrainWorld, point) || terrainSlopeAt(terrainWorld, point) > 0.4) continue;
        if (walls.some((wall) => distance(point, wall) < wall.radius + 2.4)) continue;
        if (barrels.some((barrel) => distance(point, barrel) < separation)) continue;
        barrels.push({ id: barrels.length, ...point, rotation: random() * TAU, guarded: false });
        placed = true;
      }
      // 该档实在放不下就放宽到全图随便找一个合法点，保证总数永远是 9 桶。
      if (!placed) {
        for (let attempt = 0; attempt < 600; attempt += 1) {
          const point = { x: (random() - 0.5) * 186, z: (random() - 0.5) * 186 };
          if (distance(point, origin) < 34) continue;
          if (distance(point, truck) < 26) continue;
          if (!awayFromCamps(point, camps, 10)) continue;
          if (!isTerrainWalkable(terrainWorld, point) || terrainSlopeAt(terrainWorld, point) > 0.4) continue;
          if (walls.some((wall) => distance(point, wall) < wall.radius + 2.4)) continue;
          if (barrels.some((barrel) => distance(point, barrel) < 18)) continue;
          barrels.push({ id: barrels.length, ...point, rotation: random() * TAU, guarded: false });
          break;
        }
      }
    }
  }

  return barrels;
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

  // 卡车先定 —— 它挂进 walls，后面所有撒点都要绕开它。
  const truck = placeTruck(camps[BLUEPRINT.startCampId], camps, terrainWorld, walls, size);
  walls.push({ x: truck.x, z: truck.z, radius: TRUCK_RADIUS, kind: "landmark" });
  const barrels = placeBarrels(dens[0] ?? null, truck, camps, terrainWorld, walls, random);

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

  /*
   * 每座营地一条窄坡道，外加一块能把它堵死的大石。
   *
   * 石头放在门**旁边**，不是门口正中。原先是 addItem("stone", gate.x, gate.z)——
   * 那在天然石头还没有碰撞的年代没问题：它只是躺在门口的建材，玩家搬起来、
   * 放下（placed = true）才算堵门。后来 isBlockingGroundItem 把天然石头也算成实体，
   * 这块石头就从"建材"变成了"出生即焊死的门闩"：五座营地的大门全部从开局起
   * 就通不过去，玩家进不去、狗也进不去（实测流场可达格从 99.9% 掉到 0.4%）。
   *
   * 沿入口法线挪开一个身位：石头仍然就在手边，堵不堵门重新变成玩家的选择。
   */
  for (const camp of camps) {
    const gate = campGatePosition(camp);
    const aside = camp.entranceAngle + Math.PI / 2;
    // 半个门宽（让开通道）+ 石头自己的碰撞半径 1.48 + 余量。
    // 只加 1.6 不够：岩壁洞窟的门本来就最窄，石头还是压在通道上，
    // 那一座的流场可达格仍然只有 0.4%。
    const offset = CAMP_ENTRANCE_WIDTH[camp.kind] / 2 + 1.48 + 1.1;
    addItem("stone", gate.x + Math.cos(aside) * offset, gate.z + Math.sin(aside) * offset);
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
