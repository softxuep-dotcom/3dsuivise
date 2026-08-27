import * as THREE from "three";
import type { GameSimulation } from "../../game/simulation/GameSimulation";
import { clamp, lerp } from "../../game/simulation/geometry";
import { CRITTER_SPECS } from "../../game/simulation/types";
import type { CritterState, WolfState, WorldDrop } from "../../game/simulation/types";
import { instantiateAnimal } from "../AnimalModels";
import type { AnimalAsset, AnimalInstance } from "../AnimalModels";
import { createCritterMesh } from "../CritterModels";
import { createFallbackDog, createWolfBar, DROP_BONE_GEOMETRY, DROP_HIDE_GEOMETRY, DROP_MEAT_GEOMETRY, makeMaterial } from "../visuals/models";
import type { CritterView } from "../visuals/models";
import { dampAngle, ORYX_COAT, ORYX_HEIGHT, WOLF_BAR_HEIGHT, WOLF_BAR_SECONDS, WOLF_BAR_WIDTH, wolfBarScale, wolfBellyColor, wolfBodyColor, wolfScale } from "../visuals/palette";

interface WolfView {
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

/**
 * 会动的东西的视图池：**狼、猎物、掉落物**。
 *
 * 这三类和世界里别的东西不一样 —— 它们**会凭空出现、也会消失**。
 * 石头、井、仙人掌开局建一次就摆在那儿，而狼每晚刷几十只、猎物被打死又补回来、
 * 掉落物三分钟就过期。所以只有这三类需要"存活集 → 缺则新建 → 剪枝回收"这一套，
 * 而这一套原先在 CreatureViews 里抄了三遍。
 *
 * 抽出来之后 CreatureViews 不再持有这三张表，也不必知道狼的血条怎么淡出、
 * 猎物死了怎么侧翻 —— 它只管每帧喊一句 {@link CreatureViews.sync}。
 *
 * ## 端口十个成员，全是渲染上下文
 *
 * 比模拟层那几个宽，因为渲染确实要这么多东西：场景、模拟状态、地形高度、
 * 两份动物模型资源、三种掉落物材质、画质档、以及全局时间。
 * 但它们**全是只读的共享资源** —— 这个类只往 scene 里加减自己那三类对象。
 */

export interface CreatureViewsOwner {
  readonly scene: THREE.Scene;
  readonly simulation: GameSimulation;
  /** 全局累计时间，用来驱动掉落物的浮动和闪烁。 */
  readonly time: number;
  /** 低画质档：手机上关掉一部分细节，见 CreatureViews 的构造函数。 */
  readonly lowPower: boolean;
  /**
   * 狼和猎物在多远之外停止绘制。**null = 不剔除。**
   *
   * 由渲染层按当前画质档算好递进来（见 GameRenderer.cullDistance）——
   * 这里不该知道有几档、哪档配哪个数。
   */
  readonly cullDistance: number | null;
  readonly wolfAsset: AnimalAsset | null;
  readonly deerAsset: AnimalAsset | null;
  readonly dropHideMaterial: THREE.MeshStandardMaterial;
  readonly dropMeatMaterial: THREE.MeshStandardMaterial;
  readonly dropBoneMaterial: THREE.MeshStandardMaterial;
  /** 地形在这一点的高度。所有贴地的东西都要问它。 */
  worldHeight(x: number, z: number): number;
}

export class CreatureViews {
  private readonly wolfViews = new Map<number, WolfView>();
  private readonly critterViews = new Map<number, CritterView>();
  private readonly dropViews = new Map<number, THREE.Object3D>();

  constructor(private readonly owner: CreatureViewsOwner) {}

  /** 每帧一次，三类一起同步。 */
  sync(delta: number): void {
    this.syncWolves(delta);
    this.syncCritters(delta);
    this.syncDrops();
  }

  /*
   * **没有 reset()。** 软重启换局时这三张表不清空 —— 新的一局里旧 id 全都不在存活集里，
   * 下一帧的剪枝会把它们摘干净。这是原先的行为，照搬。
   */

  syncCritters(delta: number): void {
    const liveIds = new Set<number>();
    for (const critter of this.owner.simulation.critters) {
      liveIds.add(critter.id);
      let view = this.critterViews.get(critter.id);
      if (!view) {
        view = this.createCritterView(critter);
        this.critterViews.set(critter.id, view);
        this.owner.scene.add(view.group);
      }
      const cull = this.owner.cullDistance;
      if (cull !== null) {
        const far = Math.hypot(critter.x - this.owner.simulation.player.x, critter.z - this.owner.simulation.player.z) > cull;
        view.group.visible = !far;
        if (far) continue;
      }
      const spec = CRITTER_SPECS[critter.kind];
      const terrainY = this.owner.worldHeight(critter.x, critter.z);
      view.animal?.mixer.update(delta);
      view.group.position.set(critter.x, terrainY, critter.z);
      // 朝向走**最短弧**插值，不能直接赋值也不能对角度做朴素 lerp：
      // 后者在 ±π 交界处会绕远路转一整圈，正好发生在猎物调头的那一刻。
      // 模拟层已经限了转向速率（CritterSpec.turnRate），这里是第二层保险，
      // 专治地形推挤造成的单帧抖动。
      view.group.rotation.y = dampAngle(
        view.group.rotation.y, -Math.atan2(critter.facing.z, critter.facing.x), 14, delta,
      );
      const fade = critter.mode === "dead" ? clamp(critter.deathTimer / 0.7, 0, 1) : 1;
      view.group.scale.setScalar((view.animal ? ORYX_HEIGHT : spec.scale) * fade);
      if (critter.mode === "dead") {
        // 有 Death 片段的就让片段自己演；程序化几何没有动画，只能靠侧翻表达倒地。
        // 两者都保留"缩小消失"，那是尸体退场的统一语言。
        if (view.animal) view.animal.play("Death", { loop: false, fade: 0.08 });
        else view.group.rotation.z = lerp(view.group.rotation.z, Math.PI / 2, delta * 8);
      } else {
        view.group.rotation.z = 0;
        if (view.animal) {
          // 逃跑用 Gallop、吃草用 Walk。播放速度跟着实际移速走 ——
          // 长角羚吃草 1.4、逃跑 10.5，同一个 Walk 拿来两用会像开了快进。
          view.animal.play(critter.mode === "flee" ? "Gallop" : "Walk", {
            timeScale: clamp(critter.mode === "flee" ? spec.fleeSpeed / 7 : spec.grazeSpeed / 1.1, 0.6, 1.9),
          });
        } else {
          // 使用连续的落脚曲线，避免 abs(sin) 在触地瞬间形成尖角，看起来像模型发抖。
          const bounce = critter.mode === "flee" ? 0.07 : 0.012;
          const rate = critter.mode === "flee" ? 10 : 2.5;
          const stride = (1 - Math.cos(this.owner.time * rate + critter.id * 0.83)) * 0.5;
          view.group.position.y = terrainY + stride * bounce;
        }
      }
      // 顶点色是被 material.color 乘上去的，所以程序化猎物平时保持纯白；
      // 鹿没有顶点色，平时要保持它自己的沙褐主色。
      view.bodyMaterial.color.setHex(critter.hurtFlash > 0 ? 0xff5a55 : view.baseColor);
    }
    for (const [id, view] of this.critterViews) {
      if (liveIds.has(id)) continue;
      this.disposeCritterView(view);
      this.critterViews.delete(id);
    }
  }

  createCritterView(critter: CritterState): CritterView {
    // 几何按种类共享（见 CritterModels 的缓存），材质每只一份 ——
    // 受击闪红是逐只的，共享材质会让同种猎物一起变红。
    const group = new THREE.Group();
    // 长角羚是唯一一个**玩家会专门去追**的猎物（90 血 / 肉 + 皮 + 水），
    // 也是唯一大到能看清动作的 —— 所以只有它值得一份带骨骼的素材。
    // 其余七种都在半米上下，从等距视角看就是几个色块，程序化几何足够。
    if (critter.kind === "oryx" && this.owner.deerAsset) {
      const animal = instantiateAnimal(this.owner.deerAsset);
      group.add(animal.root);
      // 剑羚的配色：沙褐身子 + 近白的腹面 + 近黑的面部与腿纹。
      // 素材自带的三个色槽正好对上，不用改一个顶点。
      const main = animal.materials.get("Main");
      const light = animal.materials.get("Main_Light");
      const dark = animal.materials.get("Main_Dark");
      if (main) main.color.setHex(ORYX_COAT);
      if (light) light.color.setHex(0xefe3cd);
      if (dark) dark.color.setHex(0x2e2620);
      return { group, bodyMaterial: main ?? makeMaterial(ORYX_COAT, 0.95), animal, baseColor: ORYX_COAT };
    }
    const { mesh, material } = createCritterMesh(critter.kind);
    group.add(mesh);
    return { group, bodyMaterial: material, animal: null, baseColor: 0xffffff };
  }

  syncWolves(delta: number): void {
    const liveIds = new Set<number>();
    for (const wolf of this.owner.simulation.wolves) {
      liveIds.add(wolf.id);
      let view = this.wolfViews.get(wolf.id);
      if (!view) {
        view = this.createWolfView(wolf);
        this.wolfViews.set(wolf.id, view);
        this.owner.scene.add(view.group);
        this.owner.scene.add(view.bar);
      }
      const cull = this.owner.cullDistance;
      if (cull !== null) {
        const far = Math.hypot(wolf.x - this.owner.simulation.player.x, wolf.z - this.owner.simulation.player.z) > cull;
        // 远处的狗跳过全部同步：动画混合器、朝向插值、血条、材质染色都不用算。
        // 近处的血条交回 syncWolfBar 决定（它只在受伤后亮 2.6 秒）。
        view.group.visible = !far;
        if (far) { view.bar.visible = false; continue; }
      }
      this.syncWolfBar(wolf, view, delta);
      const movedX = wolf.x - view.lastPosition.x;
      const movedZ = wolf.z - view.lastPosition.y;
      const movedDistance = Math.hypot(movedX, movedZ);
      // 只让真正的位移改变显示朝向。寻路会在障碍前左右试探 facing；狼没有移动时
      // 跟着它转，会表现成站在原地高频甩身。
      const movingNow = wolf.mode !== "dead" && movedDistance > Math.max(0.003, delta * 0.12);
      if (movingNow && wolf.hurtFlash <= 0) {
        const inverseDistance = 1 / movedDistance;
        const directionBlend = 1 - Math.exp(-delta * 10);
        view.travelDirection.x = lerp(view.travelDirection.x, movedX * inverseDistance, directionBlend);
        view.travelDirection.y = lerp(view.travelDirection.y, movedZ * inverseDistance, directionBlend);
        if (view.travelDirection.lengthSq() > 0.01) view.travelDirection.normalize();
        const travelHeading = -Math.atan2(view.travelDirection.y, view.travelDirection.x);
        const turnSpeed = wolf.mode === "chase" || wolf.mode === "retreating" ? 11 : 7;
        view.visualHeading = dampAngle(view.visualHeading, travelHeading, turnSpeed, delta);
      } else if (wolf.biting) {
        /*
         * 上面那条"只让真正的位移改变显示朝向"的唯一豁免。
         *
         * 狗一进咬击射程就**停下**，movingNow 从此恒假 —— 朝向于是冻在冲刺进来
         * 那一刻，玩家绕到侧面之后它照咬不误、模型却朝着别处。光在 WolfDirector
         * 里每帧写 facing 是不够的：不开这个口子，表现层根本不看那个值。
         *
         * 只信 wolf.biting 这一个状态，不用"离玩家多近"去反推 —— biting 为真时
         * facing 是 WolfDirector 对着玩家写死的，不是寻路的试探值，没有甩身风险。
         * 也不再要求 hurtFlash <= 0：挨打硬直里更要盯着人，否则一边挨砍一边转开。
         *
         * travelDirection 一起写，是为了它重新跑起来时那几帧不会从一个过时的
         * 方向插值回来（那会表现成起步先甩一下头）。
         */
        view.travelDirection.set(wolf.facing.x, wolf.facing.z);
        const biteHeading = -Math.atan2(wolf.facing.z, wolf.facing.x);
        view.visualHeading = dampAngle(view.visualHeading, biteHeading, 11, delta);
      }
      const actualSpeed = delta > 0 ? movedDistance / delta : 0;
      const targetMoveAmount = movingNow ? clamp(actualSpeed / Math.max(wolf.speed, 0.1), 0, 1) : 0;
      const movementBlend = 1 - Math.exp(-delta * (movingNow ? 18 : 14));
      view.moveAmount = lerp(view.moveAmount, targetMoveAmount, movementBlend);
      view.lastPosition.set(wolf.x, wolf.z);
      view.group.position.set(wolf.x, this.owner.worldHeight(wolf.x, wolf.z) + (wolf.mode === "dead" ? 0.2 : 0), wolf.z);
      view.group.rotation.y = view.visualHeading;
      view.group.scale.setScalar(wolfScale(wolf));
      view.animal?.mixer.update(delta);
      if (view.animal) {
        // 手工摆骨头那一整套（迈腿、点头、张嘴、翘尾、倒地侧翻）全删了 ——
        // 现在由素材自带的片段承担。侧翻尤其不能留：Death 片段本身就是倒地，
        // 再叠一个 90° 侧滚会把狗翻到肚皮朝天。
        view.group.rotation.z = 0;
        this.syncWolfAnimation(wolf, view);
      } else if (wolf.mode === "dead") {
        view.group.rotation.z = lerp(view.group.rotation.z, Math.PI / 2, delta * 8);
      } else {
        view.group.rotation.z = 0;
      }
      const bodyColor = wolf.hurtFlash > 0 ? 0xe04a46
        : wolf.mode === "retreating" ? 0x7d9094
          : wolfBodyColor(wolf);
      const bellyColor = wolf.hurtFlash > 0 ? 0xe04a46
        : wolf.mode === "retreating" ? 0x9fb0b4
          : wolfBellyColor(wolf);
      view.tinted.forEach((material, index) => {
        material.color.setHex(index === 0 ? bodyColor : bellyColor);
        material.emissive.setHex(wolf.mode === "chase" ? 0x160000 : 0x000000);
      });
    }
    for (const [id, view] of this.wolfViews) {
      if (liveIds.has(id)) continue;
      this.disposeWolfView(view);
      this.wolfViews.delete(id);
    }
  }

  /**
   * 头顶血条的显示规则。
   *
   * 不常驻：夜里地图上有几十只狼，全挂血条就是一片红。只在**这一刻挨了打**之后
   * 亮 2.6 秒，够看清掉了多少血、够判断还要几刀。所有狼统一遵守这条规则，
   * 精英狼也不再占用一条常驻 BOSS 血槽。
   */
  syncWolfBar(wolf: WolfState, view: WolfView, delta: number): void {
    if (wolf.health < view.lastHealth) view.barTimer = WOLF_BAR_SECONDS;
    view.lastHealth = wolf.health;
    view.barTimer = Math.max(0, view.barTimer - delta);

    const visible = wolf.mode !== "dead" && view.barTimer > 0;
    view.bar.visible = visible;
    if (!visible) return;

    const barScale = wolfBarScale(wolf);
    const ratio = clamp(wolf.health / wolf.maxHealth, 0, 1);
    // 精灵缩放以中心为基准，所以填充条要一边缩一边往左挪，左端才钉得住。
    const width = WOLF_BAR_WIDTH * barScale;
    view.barFill.scale.set(width * ratio, WOLF_BAR_HEIGHT * barScale, 1);
    view.barFill.position.x = -width * (1 - ratio) * 0.5;
    // wolfScale 就是这只狗的世界高度，所以血条直接挂在"头顶再抬 0.45"。
    view.bar.position.set(
      wolf.x,
      this.owner.worldHeight(wolf.x, wolf.z) + wolfScale(wolf) + 0.45,
      wolf.z,
    );
    // 最后 0.5 秒淡出，避免"啪"地消失。
    const opacity = clamp(view.barTimer / 0.5, 0, 1);
    view.barFill.material.opacity = opacity;
    (view.bar.children[0] as THREE.Sprite).material.opacity = opacity * 0.72;
  }

  syncDrops(): void {
    const liveIds = new Set<number>();
    for (const drop of this.owner.simulation.drops) {
      if (!drop.active) continue;
      liveIds.add(drop.id);
      let view = this.dropViews.get(drop.id);
      if (!view) {
        view = this.createDropView(drop);
        this.dropViews.set(drop.id, view);
        this.owner.scene.add(view);
      }
      const age = this.owner.simulation.elapsed - drop.createdAt;
      const burst = clamp(age / 0.42, 0, 1);
      const hop = Math.sin(burst * Math.PI) * 1.15;
      view.position.set(drop.x, this.owner.worldHeight(drop.x, drop.z) + 0.25 + hop, drop.z);
      view.rotation.y = drop.burstAngle + this.owner.time * 0.8;
      const timeLeft = drop.expiresAt - this.owner.simulation.elapsed;
      view.visible = timeLeft > 20 || Math.floor(this.owner.time * 7) % 2 === 0;
    }
    for (const [id, view] of this.dropViews) {
      if (liveIds.has(id)) continue;
      this.owner.scene.remove(view);
      this.dropViews.delete(id);
    }
  }

  createDropView(drop: WorldDrop): THREE.Object3D {
    if (drop.kind === "hide") {
      const hide = new THREE.Mesh(DROP_HIDE_GEOMETRY, this.owner.dropHideMaterial);
      hide.rotation.x = -Math.PI / 2;
      hide.scale.set(1.25, 0.82, 1);
      // 兽皮是一张贴地的圆片，影子和它自己基本重合 —— 低功耗档不投影，看不出来。
      hide.castShadow = !this.owner.lowPower;
      return hide;
    }
    const group = new THREE.Group();
    const meat = new THREE.Mesh(DROP_MEAT_GEOMETRY, this.owner.dropMeatMaterial);
    meat.scale.set(1.25, 0.65, 0.9);
    // 夜里一场仗能掉几十份肉皮牙，全在玩家脚边 —— 正好落在阴影相机里。
    meat.castShadow = !this.owner.lowPower;
    group.add(meat);
    const bone = new THREE.Mesh(DROP_BONE_GEOMETRY, this.owner.dropBoneMaterial);
    bone.rotation.z = Math.PI / 2;
    bone.position.y = 0.08;
    group.add(bone);
    return group;
  }

  disposeWolfView(view: WolfView): void {
    this.owner.scene.remove(view.group);
    this.owner.scene.remove(view.bar);
    view.animal?.dispose();
    for (const material of view.tinted) material.dispose();
    for (const child of view.bar.children) (child as THREE.Sprite).material.dispose();
  }

  disposeCritterView(view: CritterView): void {
    this.owner.scene.remove(view.group);
    view.animal?.dispose();
    view.bodyMaterial.dispose();
  }

  createWolfView(wolf: WolfState): WolfView {
    const group = new THREE.Group();
    const animal = this.owner.wolfAsset ? instantiateAnimal(this.owner.wolfAsset) : null;
    const tinted: THREE.MeshStandardMaterial[] = [];
    if (animal) {
      group.add(animal.root);
      // 只染毛色与腹面：鼻头和眼睛留素材原样，不然整只狗糊成一个色块。
      const main = animal.materials.get("Main");
      const light = animal.materials.get("Main_Light");
      if (main) { main.color.setHex(wolfBodyColor(wolf)); tinted.push(main); }
      if (light) { light.color.setHex(wolfBellyColor(wolf)); tinted.push(light); }
    } else {
      const fallback = createFallbackDog(wolfBodyColor(wolf));
      group.add(fallback.mesh);
      tinted.push(fallback.material);
    }
    const { bar, fill } = createWolfBar(wolf);
    return {
      group,
      animal,
      tinted,
      lastPosition: new THREE.Vector2(wolf.x, wolf.z),
      visualHeading: -Math.atan2(wolf.facing.z, wolf.facing.x),
      travelDirection: new THREE.Vector2(wolf.facing.x, wolf.facing.z).normalize(),
      moveAmount: 0,
      bar,
      barFill: fill,
      barTimer: 0,
      lastHealth: wolf.health,
    };
  }

  /**
   * 狗该播哪个片段。
   *
   * 驱动量用的是 `view.moveAmount`（真实位移 / 名义移速）而不是 `wolf.mode` ——
   * 那是主线为了修"原地甩身"引进来的量，正好也是动画最该跟的量：
   * 被地形卡住的狗 moveAmount 会掉到 0，于是它站着喘气而不是原地滑步。
   */
  syncWolfAnimation(wolf: WolfState, view: WolfView): void {
    const animal = view.animal;
    if (!animal) return;
    if (wolf.mode === "dead") {
      animal.play("Death", { loop: false, fade: 0.08 });
      return;
    }
    // 咬击：AI 咬完把冷却重置到 1.15 秒。取前 0.53 秒当扑咬窗口，配 2.5 倍速 ——
    // Attack 片段本身 1.33 秒，正好在窗口里播完一遍。窗口再短就只能看到片段的
    // 前三分之一，那看着不像咬，像抽搐。
    if (wolf.mode === "chase" && wolf.attackCooldown > 0.62) {
      animal.play("Attack", { loop: false, fade: 0.05, timeScale: 2.5 });
      return;
    }
    if (view.moveAmount <= 0.035) {
      animal.play("Idle");
      return;
    }
    // 跑的播放速度跟着这只狗的实际移速走 —— 每夜 +4% 移速的成长曲线，
    // 玩家因此能从"腿倒得更快"上看出来，而不只是数值上快了。
    const pace = wolf.speed * view.moveAmount;
    if (wolf.mode === "chase" || wolf.mode === "raid" || wolf.mode === "retreating") {
      animal.play("Gallop", { timeScale: clamp(pace / 3.4, 0.7, 1.8) });
      return;
    }
    animal.play("Walk", { timeScale: clamp(pace / 3.0, 0.6, 1.5) });
  }
}
