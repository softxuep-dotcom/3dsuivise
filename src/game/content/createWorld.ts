import { distance, mulberry32, normalize, TAU } from "../simulation/geometry";
import { campGatePosition, campLocalToWorld, distanceToCampApproach, isTerrainWalkable, terrainSlopeAt } from "../terrain/TerrainModel";
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
 * 教学桶离出生点多远、朝卡车偏多少弧度。见 placeBarrels 末尾那段。
 *
 * **8.5 → 2.2 米，偏角 0.95 → 2.20。**
 *
 * 8.5 米那一版有个没算到的后果：FUEL_PICKUP_REACH 只有 2.6，所以**开局够不着这桶**，
 * 而行动键的提示走 getInteractionHint 的优先级表。出生营地 1 的出生点 3.2 米内
 * 正好有一口井（WELL_REACH = 3.2），于是第一帧：
 *
 *     目标行   加满 6 桶油，开着卡车离开沙海 · 车在…约 8 米
 *     行动键   [提水] 从井里提水 · 井中余 1
 *
 * 两句话说的不是同一件事。玩家照着目标行按下去，花掉 8 劳力（STAMINA_COST_DRAW）、
 * 用光那口井**唯一一次**蓄水（WELL_CHARGES_INITIAL = 1），而通关进度一格没动 ——
 * 而这是他按的第一个键。
 *
 * 把桶收进 2.6 米之内，findNearestBarrel 在优先级表里就排到井前面，冲突自动消失，
 * 开场第一下按键必定是「扛桶」。取 2.2 而不是 2.5，是给判定留一点余量。
 *
 * 偏角同时从 0.95 加到 2.20，因为**桶不能掉进装车判定圈**：五座营地里营地 3 的
 * 卡车离出生点只有 5.0 米，2.2 米配 0.95 弧度时桶离车最近只有 4.09 米，
 * 比 TRUCK_LOAD_REACH（4.5）还近 —— 那等于把"扛一段路"这一课整个教没了。
 * 实测各偏角下五营地的桶→车最小值：
 *
 *     0.95 → 4.09m ✗     1.40 → 5.07m     1.80 → 5.86m
 *     2.20 → 6.50m ✓     2.40 → 6.74m     2.60 → 6.93m
 *
 * 取 2.20：留 2.0 米余量，五座营地的落点全部可走、坡度全部合格。
 * tests/tutorialBarrel.test.ts 钉着 > 4.5 这条。
 */
const TUTORIAL_BARREL_RADIUS = 2.2;
const TUTORIAL_BARREL_SPREAD = 2.20;

/**
 * 卡车停在**出生营地大门外**：出门就看得见它，它就是"我在为什么忙活"的实体答案。
 *
 * 之前卡车停在狗巢背面 22 米 —— 玩家要跑过大半张图才第一次见到通关目标，
 * 而巢边那三桶油离车只有 33 米，于是最优解永远是"清掉守卫、原地搬三趟"，
 * 野外那六桶几乎没人碰。把车挪到家门口之后，九桶油对卡车的距离第一次拉开了梯度。
 */
const TRUCK_GATE_MIN = 6;
const TRUCK_GATE_MAX = 14;
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
const TRUCK_RIGHT_LENGTHS = 1.0;
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
  startCamp: CampDefinition,
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

  /*
   * 第十桶：**出生点脚边的教学桶**，最后 push 所以 id 固定是 9，前九桶的 id 一个没动。
   *
   * 平台数据（1.0.14，n=500）里最高的一根柱子是 1~2 分钟，而录像显示大部分人
   * **没死就走了** —— 也就是说他们不是打不过，是不知道自己在干嘛。而通关目标
   * "往车里装 6 桶油"在整个第一昼夜（190 秒）里进度一格都不会动：最近的野外桶
   * 32 米，目标行又在玩家一迈步就跳去讲捡柴，于是"这游戏要我做什么"从头到尾没有答案。
   *
   * 这一桶是唯一的答案：出生点朝卡车偏 0.95 弧度、8.5 米，正好落在开场那一帧里。
   * 玩家走两步 → 扛起来（移速 ×0.54、不能攻击，扛运的代价当场就懂）→ 走到车边 →
   * 装车 → 「汽油 1/6」跳格。**十秒钟里他把通关循环整个跑了一遍。**
   *
   * 偏角取负值是为了和教学枯木岔开：那一根在 spawnFacing **+1.15**、6.5 米
   * （GameSimulation.addTutorialWood），两件教学道具分居左右，开场那一帧里不会叠在一起。
   *
   * 摆在这里而不是 GameSimulation 里，是因为它得和别的桶一样进 world 定义 ——
   * 渲染层、寻路网格、getFuelProgress 全都读 world.barrels，特判一个"第十桶"
   * 要在四个地方各写一遍。
   */
  const approach = startCamp.approach.map((local) => campLocalToWorld(startCamp, local));
  const spawn = approach[approach.length - 1] ?? campGatePosition(startCamp);
  const toTruck = Math.atan2(truck.z - spawn.z, truck.x - spawn.x);
  const tutorialAngle = toTruck - TUTORIAL_BARREL_SPREAD;
  barrels.push({
    id: barrels.length,
    x: spawn.x + Math.cos(tutorialAngle) * TUTORIAL_BARREL_RADIUS,
    z: spawn.z + Math.sin(tutorialAngle) * TUTORIAL_BARREL_RADIUS,
    // 朝向写死、不消费 random()：这一桶每局都要出现在同一个地方。
    rotation: tutorialAngle,
    guarded: false,
  });

  return barrels;
}

/**
 * 出生营地轮换：首局永远是设计好的那一座，换图只发生在"再来一局"之后。
 *
 * 蓝图里五座营地的平台、坡道、大门、地形烘焙全是现成的，换 startCampId
 * 连带把卡车也挪走了（placeTruck 的第一个参数就是出生营地），所以"随机出生点"
 * 和"随机车子落点"本来就是同一个开关。
 *
 * **但首局不能动。** 白天 40 秒、46 秒第一次挨咬、最近野外油桶 32 米、
 * 出生点那桶偏 0.95 弧度 8.5 米 —— 整条开场节奏都是照 #1 调出来的，
 * 而平台判定最看重的就是这前三分钟。换图放在玩家已经点了"再来一局"之后：
 * 那时他已经上手，而"每局不一样"正是重开这件事需要的理由。
 *
 * 轮换顺序按**到狗巢的距离与 #1 的差**从小到大排。夜袭的到达时刻是这张图上
 * 最敏感的量（攻营配额与三波节奏全按 #1 的 114 米调的），所以先给差得少的：
 *
 *   #1 114m（首局） → #0 104m → #4 137m → #2 67m → #3 193m
 *
 * #2 会早二三十秒压上来，#3 要多跑 80 米、第一夜可能一只都摸不到人 ——
 * 这两座排在后面，等前面两座验证过重开率再说。
 */
/**
 * 蓝图那座出生营地（#1）下，placeBarrels 消耗掉的 random() 次数。
 *
 * 这个数存在的理由，是"换营地不该把整张图洗一遍"。
 *
 * placeBarrels 是拒绝采样（撞墙、离车太近、跟别的桶挨太近都重抽），而它是主随机流的
 * **第一个**消费者。出生营地一换，卡车跟着换位置，拒绝次数就变 —— 于是后面的树、
 * 仙人掌、地物、矿脉、井、地标抽到的数整体错位，**整张图跟着变**。实测换 #1 → #0
 * 时 world 的 15 个字段里有 10 个不一样。那样软重启就得重建地形以外的几乎所有东西。
 *
 * 所以油桶单开一条流，主流则在这里**快进固定的 71 次**，跳到"原先 #1 那一局
 * placeBarrels 消耗完"的位置。两个效果同时拿到：
 *
 *   · 首局（#1）的世界和拆流之前**逐字节相同** —— 油桶那条流起点也是 seed，
 *     卡车又在原位，所以抽出来的桶位一模一样；主流快进 71 次之后散落物也一模一样。
 *     "最近野外桶 32 米、单趟 12 秒"这条调好的开场因此原样保住。
 *   · 其余营地共用 #1 的散落物，只有卡车、油桶、出生营地脚边那 4 根柴不同
 *     （walls 1/36、initialItems 4/97、barrels 7/10，其余字段全同）。
 *
 * **改动 placeBarrels 的采样逻辑就必须重新量这个数**，否则首局那张图会悄悄漂掉。
 * tests/worldRotation.test.ts 锁着它。
 */
const BARREL_STREAM_DRAWS = 71;

const CAMP_ROTATION = [0, 4, 2, 3] as const;

/** runIndex 0 = 这台机器上的第一局。 */
export function pickStartCamp(runIndex: number): number {
  if (!Number.isInteger(runIndex) || runIndex <= 0) return BLUEPRINT.startCampId;
  return CAMP_ROTATION[(runIndex - 1) % CAMP_ROTATION.length];
}

export function createWorld(seed = 71291, startCampId = BLUEPRINT.startCampId): WorldDefinition {
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
  const truck = placeTruck(camps[startCampId], camps, terrainWorld, walls, size);
  walls.push({ x: truck.x, z: truck.z, radius: TRUCK_RADIUS, kind: "landmark" });
  /*
   * 油桶单开一条随机流，不共用 `random`。
   *
   * placeBarrels 是拒绝采样（撞到墙、离车太近、跟别的桶挨太近都重抽），而它是
   * `random` 的第一个消费者 —— 循环多转一圈，后面的树、仙人掌、地物、矿脉、井、
   * 地标抽到的数就整体错位一格，**整张图跟着变**。
   *
   * 这在"每局同一张图"的时候看不出来。但出生营地一换，卡车跟着换位置，
   * 拒绝次数就变了 —— 于是换营地会把散落物全洗一遍。实测：换 #1 → #0，
   * world 的 15 个字段里有 10 个不一样。
   *
   * 拆开之后换营地只动卡车、油桶、出生营地脚边那 4 根柴，其余逐字节相同 ——
   * 软重启因此只需要重建这三样，地形网格和几万个散落物的显存都留着不动。
   */
  const barrels = placeBarrels(dens[0] ?? null, truck, camps, camps[startCampId], terrainWorld, walls, mulberry32(seed));
  // 主流快进到"原先 placeBarrels 消耗完"的位置，见 BARREL_STREAM_DRAWS。
  for (let i = 0; i < BARREL_STREAM_DRAWS; i += 1) random();

  /*
   * 树现在能砍（每棵两份柴，见 GameSimulation 的 STAMINA_COST_CHOP 那段），
   * 所以它们的位置从"随便撒"变成了一件有后果的事。
   *
   * 原先纯随机撒 18 棵，实测五座营地里有三座方圆 30 米一棵树都没有 ——
   * 而柴火不再生、除出生营地外每座营地附近只有两三根枯木。也就是说
   * 玩家一换营地就断燃料，砍树这条路对最需要它的那三座营地根本不存在。
   *
   * 现在分两批：每座营地先保底两棵（18~26 米，走得到但不至于长在门口），
   * 其余按老规矩满图撒。
   */
  const trees: TreeDefinition[] = [];
  const addTree = (point: Vec2): void => {
    trees.push({ id: trees.length, ...point, rotation: random() * TAU, scale: 0.75 + random() * 0.55 });
    walls.push({ ...point, radius: 1.05, kind: "tree" });
  };

  for (const camp of camps) {
    let placed = 0;
    for (let guard = 0; guard < 60 && placed < 2; guard += 1) {
      const angle = random() * TAU;
      const radius = 18 + random() * 8;
      const point = { x: camp.x + Math.cos(angle) * radius, z: camp.z + Math.sin(angle) * radius };
      if (!awayFromCamps(point, camps, 3)) continue;
      if (!isTerrainWalkable(terrainWorld, point) || terrainSlopeAt(terrainWorld, point) > 0.42) continue;
      if (trees.some((tree) => distance(point, tree) < 7)) continue;
      // 别长在坡道上 —— 那是营地唯一的进出口。
      if (distanceToCampApproach(camp, point) < camp.approachWidth * 0.5 + 2) continue;
      addTree(point);
      placed += 1;
    }
  }

  let attempts = 0;
  while (trees.length < 26 && attempts < 450) {
    attempts += 1;
    const point = { x: (random() - 0.5) * 192, z: (random() - 0.5) * 192 };
    if (!awayFromCamps(point, camps, 3)) continue;
    if (!isTerrainWalkable(terrainWorld, point) || terrainSlopeAt(terrainWorld, point) > 0.42) continue;
    if (trees.some((tree) => distance(point, tree) < 8)) continue;
    addTree(point);
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
  const startCamp = camps[startCampId];
  addItem("wood", startCamp.x + 2.2, startCamp.z + 2.6);
  addItem("wood", startCamp.x - 2.4, startCamp.z + 1.4);
  addItem("wood", startCamp.x + 3.4, startCamp.z - 2.2);
  addItem("wood", startCamp.x - 3.8, startCamp.z - 1.7);

  /*
   * 68 → 88 件，木头占比 0.72 → 0.60（石头从 ~19 块涨到 ~35 块）。
   *
   * 改这个是因为地图上"看着像石头、其实碰都碰不了"的东西太多了：光是装饰性的
   * 卵石就有两百多颗（见 GameRenderer.buildGroundCover）。玩家分不出哪块能搬 ——
   * 而能搬的那种是有用的：封营地缺口靠它，野狗会先去拆挡路的东西。
   *
   * 石头是**实体障碍**（isBlockingGroundItem 对未放置的石头也返回 true），
   * 所以加的量要克制：35 块散在 220×220 上仍然很稀，狼群寻路的回归测试兜着。
   */
  for (let id = 0; id < 88; id += 1) {
    const kind: GroundItem["kind"] = random() < 0.60 ? "wood" : "stone";
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
    startCampId,
  };
}
