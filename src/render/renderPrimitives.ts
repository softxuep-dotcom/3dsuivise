/**
 * 共享的几何、材质与配色 —— 「参数是常量的，就不该每个实例现造一份」。
 *
 * 从 GameRenderer.ts 拆出来。这里的每一个 geometry 都是**故意不回收**的：
 * 共享的东西本来就不该被 dispose，见下面那段关于 geo 计数翻倍的注释。
 * 全是模块级常量和小工厂，没有任何一行认识 GameRenderer。
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { WeaponKind } from "../game/simulation/types";

export const makeMaterial = (color: THREE.ColorRepresentation, roughness = 0.9): THREE.MeshStandardMaterial => (
  new THREE.MeshStandardMaterial({ color, roughness, flatShading: true })
);

/** 可搬运物的本色，以及被啃到快碎时染向的暗红。 */
export const STONE_COLOR = 0x748084;
export const WOOD_COLOR = 0x65432d;
export const BARRIER_DAMAGE_TINT = new THREE.Color(0x47231c);
export const ITEM_UP = new THREE.Vector3(0, 1, 0);
export const HIDDEN_ITEM_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * 地上的一捆枯木原来是两个独立 Mesh，也就是每捆两次 draw call。
 * 合并的只是渲染几何，碰撞和拾取仍然完全由 GroundItem 决定。
 */
const createWoodItemGeometry = (): THREE.BufferGeometry => {
  const logs = [-0.19, 0.19].map((z) => {
    const geometry = new THREE.CylinderGeometry(0.22, 0.26, 1.65, 7);
    geometry.rotateZ(Math.PI / 2);
    geometry.translate(0, 0, z);
    return geometry;
  });
  const merged = mergeGeometries(logs);
  for (const geometry of logs) geometry.dispose();
  return merged;
};

/** 石头原来的非均匀缩放烘进共享几何，实例矩阵只负责世界位置、朝向和耐久缩放。 */
const createStoneItemGeometry = (): THREE.BufferGeometry => {
  const geometry = new THREE.DodecahedronGeometry(0.7, 0);
  geometry.scale(2.15, 1.32, 1.7);
  return geometry;
};

export const WOOD_ITEM_GEOMETRY = createWoodItemGeometry();

/*
 * 共享几何与材质：**参数是常量的，就不该每个实例现造一份。**
 *
 * 起因是真机读数：白天 geo 215，35 秒后的夜里 geo 414 —— 几何体数量翻了一倍。
 * renderer.info.memory.geometries **只在 dispose() 时才减**，而这份代码里
 * 一处几何体的 dispose 都没有（除了 createWoodItemGeometry 末尾那次合并清理）。
 *
 * 最大的漏点是掉落物：createDropView 每次都新建 CircleGeometry /
 * DodecahedronGeometry / CylinderGeometry，而它们三个的参数全是常量；
 * 掉落视图过期时只从场景里移除、材质和几何都不回收。按注释自己的说法
 * 「夜里一场仗能掉几十份肉皮牙」，一局下来就是几百个泄漏的 GPU 缓冲。
 *
 * 修法不是补 dispose，是**共享** —— 共享的东西本来就不该被回收，
 * 顺带把 draw call 之外的另一项（缓冲数量与显存）也压下去。
 * 仙人掌的刺与矿脉的棱柱同理：形状逐个都一样，只是摆放不同。
 *
 * 主干和手臂原先因为"每株高度随机"留在了原地，现在也提上来了：随机的只是
 * **高度**，而高度可以交给实例矩阵在 Y 上缩放表达，见 CACTUS_TRUNK_* 那两段。
 */
export const DROP_HIDE_GEOMETRY = new THREE.CircleGeometry(0.62, 5);
export const DROP_MEAT_GEOMETRY = new THREE.DodecahedronGeometry(0.42, 0);
export const DROP_BONE_GEOMETRY = new THREE.CylinderGeometry(0.07, 0.07, 0.82, 6);
export const CACTUS_SPINE_GEOMETRY = new THREE.ConeGeometry(0.04, 0.2, 4);
export const CACTUS_ELBOW_GEOMETRY = new THREE.CapsuleGeometry(0.18, 0.34, 3, 6);
export const CACTUS_FLOWER_GEOMETRY = new THREE.IcosahedronGeometry(0.16, 0);

/*
 * 主干与手臂的基准胶囊。
 *
 * 每株的高度仍然是随机的（主干 1.6~2.5、手臂 0.55~0.95），但不再各造一份几何 ——
 * 取区间中点做基准，逐株用实例矩阵在 Y 上缩放。CapsuleGeometry 的总高是
 * `height + 2 × radius`，所以缩放比取 `(目标总高) / (基准总高)`。
 *
 * 代价是两端的半球会跟着在 Y 上被拉长或压扁：主干缩放比落在 0.83~1.17 之间，
 * 半球的竖直半径因此在 0.25~0.35 之间浮动（原本恒为 0.3）。这是几厘米的事，
 * 摊在一株两三米高、七面体的低模仙人掌上看不出来 —— 而换到的是
 * 「32 株 288 个 Mesh」变成「5 个 InstancedMesh」。
 */
export const CACTUS_TRUNK_RADIUS = 0.3;
export const CACTUS_TRUNK_BASE_HEIGHT = 2.05;
export const CACTUS_TRUNK_GEOMETRY = new THREE.CapsuleGeometry(CACTUS_TRUNK_RADIUS, CACTUS_TRUNK_BASE_HEIGHT, 3, 7);
export const CACTUS_ARM_RADIUS = 0.18;
export const CACTUS_ARM_BASE_HEIGHT = 0.75;
export const CACTUS_ARM_GEOMETRY = new THREE.CapsuleGeometry(CACTUS_ARM_RADIUS, CACTUS_ARM_BASE_HEIGHT, 3, 6);

/**
 * 一株仙人掌的五个合批。每株的九个部件散在这五个批次里，槽位由 cactusSlots 给。
 * 一株 = 主干 1 + 手臂 2 + 肘 2 + 花 1 + 刺 3。
 */
export interface CactusBatches {
  readonly trunks: THREE.InstancedMesh;
  readonly arms: THREE.InstancedMesh;
  readonly elbows: THREE.InstancedMesh;
  readonly flowers: THREE.InstancedMesh;
  readonly spines: THREE.InstancedMesh;
  /** 显隐翻转时要一起打 needsUpdate 的那五个，省得每次现拼数组。 */
  readonly all: readonly THREE.InstancedMesh[];
}

/**
 * 一株仙人掌九个部件的世界矩阵，建好就不再变（仙人掌不会移动）。
 * 割光时往实例里写零矩阵，长回来时把这些原样写回去 —— 比重算一遍便宜也短。
 */
export interface CactusPlacement {
  readonly trunk: THREE.Matrix4;
  readonly arms: readonly THREE.Matrix4[];
  readonly elbows: readonly THREE.Matrix4[];
  readonly flower: THREE.Matrix4;
  readonly spines: readonly THREE.Matrix4[];
}

/**
 * 矿脉的四根棱柱。
 *
 * 高度四根各不相同（参差是"矿脉"读感的全部来源），但这四个高度对**每一个**
 * 矿脉都一样 —— 原先写在循环里，14 个矿脉造出 56 份几何，实际只需要 4 份。
 * 表和几何一起提上来，摆放参数留在原地。
 *
 * [绕 Y 的方位, 离心距, 高度, 外倾角]
 */
export const IRON_SHARDS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 0.0, 2.05, 0.0],
  [1.9, 0.46, 1.42, 0.26],
  [3.6, 0.52, 1.68, 0.19],
  [5.2, 0.40, 1.15, 0.31],
];
/** 上细下粗的五棱柱：顶端收到 0.05，剪影是尖的。 */
export const IRON_SHARD_GEOMETRIES = IRON_SHARDS.map(
  ([, , height]) => new THREE.CylinderGeometry(0.05, 0.3, height, 5),
);
export const IRON_ORE_GEOMETRY = new THREE.OctahedronGeometry(0.34, 0);
export const STONE_ITEM_GEOMETRY = createStoneItemGeometry();

/**
 * 汽油桶。**整张图上唯一的锈红色**——沙丘、砾石、枯木、铁矿全是黄褐到灰的
 * 一族，所以这个色相在远处就是一个"那边有东西"的信号。没有小地图，
 * 桶能不能被看见完全取决于它在沙色里跳不跳得出来。
 */
export function createBarrelView(): THREE.Group {
  const group = new THREE.Group();
  const shell = makeMaterial(0xb43a24, 0.65);
  const band = makeMaterial(0x6f2416, 0.6);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 1.18, 12), shell);
  drum.castShadow = true;
  group.add(drum);
  for (const y of [-0.3, 0.3]) {
    const hoop = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.1, 12), band);
    hoop.position.y = y;
    group.add(hoop);
  }
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.14, 8), band);
  cap.position.set(0.2, 0.62, 0);
  group.add(cap);
  return group;
}

export interface BladeVisual {
  name: string;
  /** 刃宽倍率，基准是求生匕首的 0.25。 */
  width: number;
  /** 刃长倍率，基准是求生匕首的 0.95。 */
  length: number;
  /** 剑是双刃对称，刀是单刃（背侧拉直）。 */
  doubleEdged: boolean;
  color: number;
  roughness: number;
  metalness: number;
  gripColor: number;
  emissive?: number;
  emissiveIntensity?: number;
  /** 三阶长剑的独立刃口 mesh 颜色。 */
  edgeColor?: number;
  /** 剑线连击时刃身发什么光。 */
  comboGlow?: number;
}

/**
 * 七把武器的外观。
 *
 * 只有一个劈砍动画，七把武器挥起来是同一个动作 —— 所以**区分全靠剪影与颜色**。
 * 规则是色相分线、明度与自发光分阶：
 *
 *   刀线走冷色，越往上越"热"（铁被反复锻打）：生铁灰 → 淬蓝钢 → 暗铁 + 赤热纹
 *   剑线走暖色，越往上越"黑"（骨 → 牙 → 淬过的齿）：骨白 → 琥珀牙黄 → 墨黑 + 白刃口
 *
 * 刀越往上越宽越长（最宽 ×1.85），剑越往上越窄越长（最窄 ×0.70）。
 * 宽刀砍下去像斧，窄剑砍下去像削。
 */
export const WEAPON_VISUALS: Record<WeaponKind, BladeVisual> = {
  "survival-knife": {
    name: "SurvivalKnife", width: 1.00, length: 1.00, doubleEdged: false,
    color: 0xb8c1bd, roughness: 0.42, metalness: 0.52, gripColor: 0x4b3023,
  },

  "saber-1": {
    name: "IronCleaver", width: 1.35, length: 1.10, doubleEdged: false,
    color: 0x8a9299, roughness: 0.62, metalness: 0.35, gripColor: 0x4b3023,
  },
  "saber-2": {
    name: "ForgedBroadsaber", width: 1.55, length: 1.20, doubleEdged: false,
    color: 0x6f8ba8, roughness: 0.34, metalness: 0.72, gripColor: 0x3e2a1c,
  },
  "saber-3": {
    name: "SlagHeavysaber", width: 1.85, length: 1.30, doubleEdged: false,
    color: 0x4a4f57, roughness: 0.30, metalness: 0.80, gripColor: 0x2f2119,
    emissive: 0x8c2a10, emissiveIntensity: 0.55,
  },

  "sword-1": {
    name: "BoneShortsword", width: 0.85, length: 1.05, doubleEdged: true,
    color: 0xe4dcc4, roughness: 0.75, metalness: 0.05, gripColor: 0x5a4632,
    comboGlow: 0xfff0d0,
  },
  "sword-2": {
    name: "FangRapier", width: 0.75, length: 1.15, doubleEdged: true,
    color: 0xd9a441, roughness: 0.55, metalness: 0.15, gripColor: 0x4e3a24,
    comboGlow: 0xffc861,
  },
  "sword-3": {
    name: "SplitToothLongsword", width: 0.70, length: 1.28, doubleEdged: true,
    color: 0x2b2622, roughness: 0.45, metalness: 0.25, gripColor: 0x2a2119,
    edgeColor: 0xf2ece0, comboGlow: 0xf2ece0,
  },
};
