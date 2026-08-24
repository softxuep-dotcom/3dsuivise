/**
 * 狼与猎物的**外观**：视图结构、三档体型与毛色、头顶血条、资源加载失败时的替身。
 *
 * 从 GameRenderer.ts 拆出来。三档狗的高度与毛色是同一件事的两面 ——
 * 等距视角下"这只咬不咬得动"靠剪影和明度判断，不靠血条 —— 所以尺寸表和
 * 配色表必须放在一起读。
 */
import * as THREE from "three";
import type { WolfState } from "../game/simulation/types";
import type { AnimalInstance } from "./AnimalModels";
import { makeMaterial } from "./renderPrimitives";

export interface WolfView {
  group: THREE.Group;
  /** Quaternius 狼的实例；资源没加载成功时是 null，此时 group 里是程序化替身。 */
  animal: AnimalInstance | null;
  /** 受击闪红要作用到的材质。狼模型有毛色与腹面两份，替身只有一份。 */
  tinted: THREE.MeshStandardMaterial[];
  /** 上一帧的世界坐标；模型朝向与步态都以真实位移为准，不直接照搬寻路的瞬时 facing。 */
  lastPosition: THREE.Vector2;
  /** 已平滑的显示朝向。狼停住时保持这个角度，避免原地左右甩身。 */
  visualHeading: number;
  /** 真实移动方向的低通结果；寻路连续左右试探时不会把抖动直接传给模型。 */
  travelDirection: THREE.Vector2;
  /** 0..1 的移动权重，给起步与停步留一个很短的缓冲。 */
  moveAmount: number;
  /** 头顶血条：受伤后短暂浮现。挂在场景根上而不是狼身上，免得继承死亡侧翻。 */
  bar: THREE.Group;
  barFill: THREE.Sprite;
  /** 血条剩余显示秒数。 */
  barTimer: number;
  /** 上一帧的血量，用来发现"这一刻挨打了"。 */
  lastHealth: number;
}

/** 猎物配色：整体压在沙色系里，靠明度和一点点色相区分，不抢狼的戏（表在 CritterModels.ts）。 */
export interface CritterView {
  group: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
  /** 只有长角羚用 Quaternius 的鹿；其余七种仍是程序化几何。 */
  animal: AnimalInstance | null;
  /** 没受击时该显示的颜色。程序化几何是白（顶点色自带配色），鹿是它的沙褐主色。 */
  baseColor: number;
}

/** 长角羚的沙褐主色。 */
export const ORYX_COAT = 0xc19a63;

/** 长角羚的站立高度：2.3，比壮犬(1.7)高、比玩家(2.6)矮 —— 最值得追的那个剪影。 */
export const ORYX_HEIGHT = 2.3;

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
 * 血条自己的尺度，**不复用 wolfScale**。
 *
 * wolfScale 的含义已经从"几何倍率"改成"世界高度"（1.15 / 1.7 / 2.7），
 * 直接拿去乘血条，头犬的血条会跟着长到近三倍宽、飘到头顶两米以上。
 * 这里保留接近原来的那组倍率，只留下"越大的狗血条越宽"这一点。
 */
export const wolfBarScale = (wolf: WolfState): number => (
  wolf.kind === "elite" ? 1.6 : wolf.kind === "large" ? 1.15 : 0.9
);

// 精英狼比大狼再大一档，但不再是全场唯一的 BOSS 剪影。
/**
 * 三档狗的**站立高度**（世界单位）。模型按高度归一化到 1，所以这里就是高度本身。
 *
 * 尺子是玩家：玩家 2.6 高。于是野狗到腰（1.15）、壮犬到胸（1.7）、
 * 头犬比你还高一头（2.7）—— 等距视角下判断"这只咬不咬得动"靠的是剪影，不是血条，
 * 所以这三档必须一眼分得开。狼的高/长是 0.51，换算回体长是 2.3 / 3.3 / 5.3。
 */
export const wolfScale = (wolf: WolfState): number => (
  wolf.kind === "elite" ? 2.7 : wolf.kind === "large" ? 1.7 : 1.15
);

/** 腹面与口鼻的浅色。跟主色同色相、抬明度，模型自带的 Main_Light 槽正好吃这个。 */
export const wolfBellyColor = (wolf: WolfState): number => {
  if (wolf.kind === "elite") return 0x7d5a3f;
  if (wolf.role === "guard") return 0x8e8f86;
  if (wolf.kind === "large") return 0xc98d55;
  return 0xf0d3a0;
};

/**
 * 三档狗的毛色。
 *
 * 分档规则是**明度**而不是色相：夜里只有篝火一盏光源，色相差在暗处基本读不出来，
 * 而明暗差还在。所以从白天的野狗到头犬是一路压暗，头犬几乎是黑褐色的一块。
 */
export const wolfBodyColor = (wolf: WolfState): number => {
  if (wolf.kind === "elite") return 0x4a2f1e;
  // 守巢犬单独一个色：它和白天的壮犬同为 large，但玩家要学会的是
  // "巢边那三只不一样、碰它就得打完"。走**冷灰褐**而不是继续在暖褐里分深浅 ——
  // 全场只有它们不是沙漠色系，远远一眼就能认出来那圈是谁在守着。
  if (wolf.role === "guard") return 0x5b5f57;
  if (wolf.kind === "large") return 0x8f5228;
  if (wolf.role === "wild") return 0xd9a95f;
  return wolf.raider ? 0xc07a34 : 0xcf9a56;
};

/** 头顶血条：受伤后显示多久。够看清掉了多少，又不至于夜里几十条一直挂着。 */
export const WOLF_BAR_SECONDS = 2.6;
export const WOLF_BAR_WIDTH = 1.15;
export const WOLF_BAR_HEIGHT = 0.15;

/** 沿最短圆弧平滑角度，跨过 ±π 时不会整圈回转。 */
export const dampAngle = (current: number, target: number, speed: number, delta: number): number => {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * (1 - Math.exp(-speed * delta));
};

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
