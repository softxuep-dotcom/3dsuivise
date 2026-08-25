import * as THREE from "three";
import type { WolfState } from "../../game/simulation/types";
import { clamp } from "../../game/simulation/geometry";

/**
 * 昼夜色板、狼的外观取值，以及两个只服务于表现的插值函数。
 *
 * 从 GameRenderer.ts 的模块级前言里分出来 —— 这些是**调色**，不是渲染逻辑。
 * 想改白天有多亮、夜里有多蓝、头犬该有多大，来这里，不必打开两千行的渲染循环。
 */
/** 长角羚的沙褐主色。 */
export const ORYX_COAT = 0xc19a63;

/** 长角羚的站立高度：2.3，比壮犬(1.7)高、比玩家(2.6)矮 —— 最值得追的那个剪影。 */
export const ORYX_HEIGHT = 2.3;

export const wolfBarScale = (wolf: WolfState): number => (
  wolf.kind === "elite" ? 1.6 : wolf.kind === "large" ? 1.15 : 0.9
);

/** 头顶血条：受伤后显示多久。够看清掉了多少，又不至于夜里几十条一直挂着。 */
export const WOLF_BAR_SECONDS = 2.6;

export const WOLF_BAR_WIDTH = 1.15;

export const WOLF_BAR_HEIGHT = 0.15;

/** 沿最短圆弧平滑角度，跨过 ±π 时不会整圈回转。 */
export const dampAngle = (current: number, target: number, speed: number, delta: number): number => {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * (1 - Math.exp(-speed * delta));
};

export const smoothTerrainBlend = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

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

/*
 * 昼夜光照配色表。**改这里就是改整个游戏的气质**，所以摊开写成常量而不是散在函数里。
 *
 * 白天走"暖主光 + 冷填充"，夜晚走"冷到底 + 一盏篝火"。见 syncDayNight 里那段。
 * 想回到 1.0.14 的全暖白天：DAY_SKY=d8bf8d、DAY_HEMI_SKY=ffeec4、
 * DAY_HEMI_GROUND=8a6a44、DAY_HEMI_INTENSITY=2.2、DAY_SUN_INTENSITY=3.2。
 */
export const DAY_SKY = new THREE.Color(0xc9c3b4);

export const DAY_HEMI_SKY = new THREE.Color(0xcdd8e6);

export const DAY_HEMI_GROUND = new THREE.Color(0x8a7250);

export const DAY_SUN = new THREE.Color(0xfff0cc);

export const DAY_HEMI_INTENSITY = 1.15;

export const DAY_SUN_INTENSITY = 4.1;

export const NIGHT_SKY = new THREE.Color(0x2c3d5c);

export const NIGHT_HEMI_SKY = new THREE.Color(0x8fa6cf);

export const NIGHT_HEMI_GROUND = new THREE.Color(0x3a4356);

export const NIGHT_SUN = new THREE.Color(0xa8bce0);

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

/** 猎物配色：整体压在沙色系里，靠明度和一点点色相区分，不抢狼的戏。 */
