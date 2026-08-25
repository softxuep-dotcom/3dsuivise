import * as THREE from "three";
import type { WeaponKind, WolfState } from "../../game/simulation/types";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { AnimalInstance } from "../AnimalModels";
import { WOLF_BAR_HEIGHT, WOLF_BAR_WIDTH, wolfBarScale } from "./palette";

/**
 * 可复用的几何体、材质工厂，以及几件"长成什么样"由代码写死的道具。
 *
 * 从 GameRenderer.ts 的模块级前言里分出来。那段前言有 389 行 —— 占整个文件的 13%，
 * 而且和渲染循环没有任何关系：它只回答"这东西长什么样"，不回答"这一帧怎么画"。
 *
 * ## 几何体为什么是模块级共享的
 *
 * 参数固定的几何体跨实例共享，避免掉落物过期、狼死亡回收之后持续遗留 GPU 缓冲。
 * 一局里会生成上百个掉落物和几十只狼，各自 new 一份 BufferGeometry 是纯粹的浪费，
 * 而且 dispose 漏一个就是一处慢性泄漏。
 */
/** 可搬运物的本色，以及被啃到快碎时染向的暗红。 */
export const STONE_COLOR = 0x748084;

export const WOOD_COLOR = 0x65432d;

export const BARRIER_DAMAGE_TINT = new THREE.Color(0x47231c);

/* 参数固定的几何体跨实例共享，避免掉落物过期后持续遗留 GPU 缓冲。 */
export const DROP_HIDE_GEOMETRY = new THREE.CircleGeometry(0.62, 5);

export const DROP_MEAT_GEOMETRY = new THREE.DodecahedronGeometry(0.42, 0);

export const DROP_BONE_GEOMETRY = new THREE.CylinderGeometry(0.07, 0.07, 0.82, 6);

export const CACTUS_SPINE_GEOMETRY = new THREE.ConeGeometry(0.04, 0.2, 4);

export const CACTUS_ELBOW_GEOMETRY = new THREE.CapsuleGeometry(0.18, 0.34, 3, 6);

export const CACTUS_FLOWER_GEOMETRY = new THREE.IcosahedronGeometry(0.16, 0);

/** [绕 Y 的方位, 离心距, 高度, 外倾角]；每座矿脉复用同一组几何体。 */
export const IRON_SHARDS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 0.0, 2.05, 0.0],
  [1.9, 0.46, 1.42, 0.26],
  [3.6, 0.52, 1.68, 0.19],
  [5.2, 0.40, 1.15, 0.31],
];

export const IRON_SHARD_GEOMETRIES = IRON_SHARDS.map(
  ([, , height]) => new THREE.CylinderGeometry(0.05, 0.3, height, 5),
);

export const IRON_ORE_GEOMETRY = new THREE.OctahedronGeometry(0.34, 0);

/**
 * 狗的程序化替身。
 *
 * 只在 Wolf.glb 加载失败时用得上（GitHub Pages 从子目录发布，资源路径出过一次
 * 404）。**刻意做得很潦草**：它的存在意义是"别让夜里的狗变成隐形的"，
 * 不是备用美术方案 —— 做得越像，越会掩盖资源没加载成功这件事。
 */
export function createFallbackDog(color: number): { mesh: THREE.Object3D; material: THREE.MeshStandardMaterial } {
  const material = makeMaterial(color, 0.95);
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.44, 3, 6), material);
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.28;
  body.castShadow = true;
  group.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.2, 0.18), material);
  head.position.set(0.42, 0.36, 0);
  group.add(head);
  for (const [x, z] of [[0.24, 0.11], [0.24, -0.11], [-0.24, 0.11], [-0.24, -0.11]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.28, 4), material);
    leg.position.set(x, 0.14, z);
    group.add(leg);
  }
  return { mesh: group, material };
}

/**
 * 每只狼一套血条材质，不共用 —— 淡出是逐条各自算的，共用材质会让全场血条一起闪。
 * 精灵本来就不合批，两个精灵两次绘制，隐藏时直接跳过，所以这点开销是值的。
 */
export const createWolfBar = (wolf: WolfState): { bar: THREE.Group; fill: THREE.Sprite } => {
  const group = new THREE.Group();
  const back = new THREE.Sprite(new THREE.SpriteMaterial({
    color: 0x0a0f13, transparent: true, opacity: 0.72, depthWrite: false,
  }));
  const fill = new THREE.Sprite(new THREE.SpriteMaterial({
    color: wolf.kind === "elite" ? 0xff8a3d : 0xe2564a, transparent: true, depthWrite: false,
  }));
  const barScale = wolfBarScale(wolf);
  back.scale.set(WOLF_BAR_WIDTH * barScale + 0.06, WOLF_BAR_HEIGHT * barScale + 0.05, 1);
  fill.scale.set(WOLF_BAR_WIDTH * barScale, WOLF_BAR_HEIGHT * barScale, 1);
  // 填充画在底板之上；两者都不写深度，避免互相打架。
  back.renderOrder = 8;
  fill.renderOrder = 9;
  group.add(back, fill);
  group.visible = false;
  return { bar: group, fill };
};

export interface CritterView {
  group: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
  /** 只有长角羚用 Quaternius 的鹿；其余七种仍是程序化几何。 */
  animal: AnimalInstance | null;
  /** 没受击时该显示的颜色。程序化几何是白（顶点色自带配色），鹿是它的沙褐主色。 */
  baseColor: number;
}

export const makeMaterial = (color: THREE.ColorRepresentation, roughness = 0.9): THREE.MeshStandardMaterial => (
  new THREE.MeshStandardMaterial({ color, roughness, flatShading: true })
);

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

/**
 * 车顶装油进度使用的桶形图标。白色主体由 SpriteMaterial.color 着色，
 * 深色桶箍保留轮廓，因此未点亮的格子在沙地和夜色里也都能读出来。
 */
export function createFuelPipTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("fuel pip canvas context unavailable");

  context.beginPath();
  context.moveTo(20, 10);
  context.lineTo(44, 10);
  context.lineTo(49, 17);
  context.lineTo(49, 47);
  context.lineTo(44, 54);
  context.lineTo(20, 54);
  context.lineTo(15, 47);
  context.lineTo(15, 17);
  context.closePath();
  context.fillStyle = "#ffffff";
  context.fill();
  context.strokeStyle = "#172522";
  context.lineWidth = 4;
  context.lineJoin = "round";
  context.stroke();
  for (const y of [20, 44]) {
    context.beginPath();
    context.moveTo(16, y);
    context.lineTo(48, y);
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/**
 * 开局指路的浮动箭头，来自 main 分支的引导逻辑。
 * 尖端位于局部 y=0，摆放时可以直接使用目标顶部坐标。
 */
export function createGuideArrowView(): THREE.Mesh {
  const head = new THREE.ConeGeometry(0.72, 0.84, 4);
  head.rotateX(Math.PI);
  head.translate(0, 0.42, 0);
  const shaft = new THREE.CylinderGeometry(0.24, 0.24, 0.84, 4);
  shaft.translate(0, 1.26, 0);
  const geometry = mergeGeometries([head, shaft]);
  head.dispose();
  shaft.dispose();
  if (!geometry) throw new Error("guide arrow geometry merge failed");

  const arrow = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      // 青绿色沿用卡车地环：它表示同一条通关路线，而不是油桶本身的颜色。
      color: 0x2fe0cf,
      emissive: 0x0f9c90,
      roughness: 0.45,
      metalness: 0,
      flatShading: true,
    }),
  );
  arrow.castShadow = false;
  arrow.receiveShadow = false;
  arrow.visible = false;
  return arrow;
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
