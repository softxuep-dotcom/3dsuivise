import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { GameSimulation } from "../game/simulation/GameSimulation";

/**
 * 战斗与引导的**一次性视觉反馈**：指路箭头、飞行中的石头、油桶爆炸的火球。
 *
 * ## 为什么把它们从 GameRenderer 里拿出来
 *
 * 那个类里挤着三种生命周期的东西：
 *
 *   build/create   只在构造时跑一次，之后再不碰（约 1400 行）
 *   sync/update    每帧都跑（约 960 行）
 *   一次性特效     被事件触发、放完就收（就是这个文件）
 *
 * 前两类都和"世界长什么样"绑在一起，第三类不是 —— 它只关心
 * "刚刚发生了什么，该让玩家看见什么"。这条界线值得用文件划出来，
 * 因为接下来的手感活（命中反馈、被扔飞的翻滚、音效同步）全会长在这一侧，
 * 而它们一条都不需要知道地形怎么建的。
 *
 * ## 它只要两个依赖
 *
 * 一个 scene 往里挂东西，一个"这个坐标的地面多高"。**不持有 GameRenderer**，
 * 也不碰相机 —— 震屏归渲染器（相机在它手里），这里只负责场景里的那些物件。
 * 这个窄接口是有意的：它让这个文件可以脱离 4000 行的渲染器单独读懂。
 */
export class CombatFeedbackView {
  private readonly guideArrow: THREE.Mesh;
  /** 箭头的上下浮动与自转共用这一个相位，秒。 */
  private guidePhase = 0;
  /** 算车头世界坐标用的暂存，避免每帧 new 一个 Vector3。 */
  private readonly guideAnchor = new THREE.Vector3();

  /*
   * 飞行中的石头。池子而不是按需 new：一次最多只可能有一块在天上
   * （玩家一次只扛得动一块），留 3 个纯粹是给"砸完立刻捡起来再砸"留余量。
   */
  private readonly stoneFlightViews: THREE.Mesh[] = [];
  /** 飞石自转的相位，秒。 */
  private stoneSpin = 0;

  /** 油桶爆炸的火球。第一次炸的时候才建，之后复用。 */
  private blastMesh: THREE.Mesh | null = null;
  private blastTime = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly groundHeightAt: (x: number, z: number) => number,
    stoneGeometry: THREE.BufferGeometry,
    stoneColor: THREE.ColorRepresentation,
  ) {
    this.guideArrow = this.buildGuideArrow();
    const stoneMaterial = new THREE.MeshStandardMaterial({
      color: stoneColor, roughness: 0.95, flatShading: true,
    });
    for (let index = 0; index < 3; index += 1) {
      const mesh = new THREE.Mesh(stoneGeometry, stoneMaterial);
      mesh.castShadow = false;
      mesh.visible = false;
      this.scene.add(mesh);
      this.stoneFlightViews.push(mesh);
    }
  }

  /**
   * 每帧一次。truckGroup 是外面传进来的 —— 指路箭头在玩家扛起油桶后要挪到车头，
   * 而车头的世界坐标只有那个 Group 知道。
   */
  update(delta: number, simulation: GameSimulation, truckGroup: THREE.Object3D): void {
    this.syncGuideArrow(delta, simulation, truckGroup);
    this.syncStoneFlights(delta, simulation);
    this.syncBlast(delta);
  }

  /**
   * 油桶炸了：一圈迅速扩张又淡出的火球。
   *
   * 只有一个球，复用 —— 同一时刻不可能炸两桶（玩家只扛得动一个）。
   * 用加色混合（AdditiveBlending）而不是普通透明：爆炸要"发光"，
   * 压在夜色和火光上要更亮，而不是像一层灰布。
   *
   * **震屏不在这里** —— 相机归渲染器管，那一行留在 GameRenderer.barrelBlast。
   */
  blast(x: number, z: number): void {
    if (!this.blastMesh) {
      this.blastMesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({
          color: 0xffb347, transparent: true, opacity: 0.9,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      this.scene.add(this.blastMesh);
    }
    this.blastMesh.position.set(x, this.groundHeightAt(x, z) + 1.1, z);
    this.blastMesh.visible = true;
    this.blastTime = 0;
  }

  /** 火球每帧涨大并淡出，0.5 秒走完。 */
  private syncBlast(delta: number): void {
    const mesh = this.blastMesh;
    if (!mesh || !mesh.visible) return;
    this.blastTime += delta;
    const t = this.blastTime / 0.5;
    if (t >= 1) {
      mesh.visible = false;
      return;
    }
    // 前段猛涨后段收尾：sqrt 让扩张一开始就快，符合"炸开"而不是"吹气球"。
    mesh.scale.setScalar(0.6 + Math.sqrt(t) * 5.0);
    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t) * (1 - t);
  }

  private buildGuideArrow(): THREE.Mesh {
    /*
     * 颜色跟卡车走，不跟油桶走。
     *
     * 地环是 0x36d9cc、HUD 那枚卡车指示牌的字是 0x8ff0e6 —— 这一族青绿在这个游戏里
     * 已经固定表示"通关路线上的东西"。箭头先指的虽然是个红油桶，但它说的仍是
     * 同一句话（"往这儿走"），所以用同一族颜色，而不是跟着被指的东西变。
     *
     * 带自发光：白天靠主光就够亮，但夜里环境光压得很低，纯漫反射会整根沉进背景。
     */
    const mesh = new THREE.Mesh(
      createGuideArrowGeometry(),
      new THREE.MeshStandardMaterial({
        color: 0x2fe0cf,
        emissive: 0x0f9c90,
        roughness: 0.45,
        metalness: 0,
        // 和场上所有道具同一档：平直着色，四个面各自一个色阶，轮廓才咬得住沙子。
        flatShading: true,
      }),
    );
    // 它是"指路的"，不是场上的实体：不投影，免得地上多出一道解释不了的影子。
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    this.scene.add(mesh);
    return mesh;
  }

  /**
   * 开局那一趟的指路箭头：先浮在第一桶油上，扛起来之后挪到车头，装进车里就退场。
   *
   * **不留状态机**，每帧从模拟层现算：中途把桶放下箭头就自己飞回桶上，再扛起来又回车头。
   * 一个 latch 都不需要，软重开也不用清 —— resetRun 换掉 simulation 之后它自然接着新的一局。
   *
   * 退场判据是 `loaded >= 1`：第一桶进了车，这段引导就干完了。剩下五桶不再指 ——
   * 否则它就从"开局教一次"变成一个常驻任务标记，正是 buildTruckBeacon 拆光柱时否掉的东西。
   * 退场只关 visible 不 dispose：软重开复用同一个渲染器，下一局还要用它。
   */
  private syncGuideArrow(delta: number, simulation: GameSimulation, truckGroup: THREE.Object3D): void {
    const arrow = this.guideArrow;
    const fuel = simulation.getFuelProgress();
    if (fuel.loaded >= 1) {
      arrow.visible = false;
      return;
    }

    if (fuel.carrying) {
      // 车头顶上。cab 在 buildTruck 里是 local (1.9, 1.95, 0)、高 1.5，顶面因此在 2.7，
      // 再留 0.35 的净空。localToWorld 会自己把 truckGroup 的世界矩阵更到最新。
      this.guideAnchor.set(1.9, 3.05, 0);
      truckGroup.localToWorld(this.guideAnchor);
    } else {
      /*
       * 第一桶 = createWorld 最后压进去的那一桶（出生点 2.2 米外那桶，见 placeBarrels
       * 末尾）。按下标取而不是记 id：软重开会换一整套 world，下标每局都对，记下来的 id 不一定。
       */
      const barrels = simulation.barrels;
      const first = barrels[barrels.length - 1];
      if (!first || first.placement !== "ground") {
        arrow.visible = false;
        return;
      }
      // 桶身 1.18 高、中心抬到地面 +0.62，顶盖到 +1.31；再留 0.24 净空。
      this.guideAnchor.set(first.x, this.groundHeightAt(first.x, first.z) + 1.55, first.z);
    }

    this.guidePhase += delta;
    arrow.visible = true;
    arrow.position.set(
      this.guideAnchor.x,
      this.guideAnchor.y + Math.sin(this.guidePhase * 2.6) * 0.19,
      this.guideAnchor.z,
    );
    // 固定朝向的等距相机不跟人转，所以慢转一圈就能保证四个面轮流对着玩家。
    arrow.rotation.y = this.guidePhase * 1.15;
  }

  /**
   * 飞行中的石头：水平位置由模拟层给，**高度和自转纯粹是表现**。
   *
   * 抛物线用 sin(progress×π)：起点落点都贴地，中途拱起 1.7 米。
   * 模拟层是平面直线判定，所以这条弧不参与命中 —— 它只是让"扔"这个动作读起来像扔，
   * 而不像一颗贴地滑行的子弹。高度不影响判定这件事是有意的：一块石头砸不砸得中，
   * 玩家该只用平面距离去估。
   */
  private syncStoneFlights(delta: number, simulation: GameSimulation): void {
    this.stoneSpin += delta;
    /*
     * 逐个数**在飞的**，不能按下标取。
     *
     * 模拟层那个池子是"找一个 active 为 false 的槽复用"，所以在飞的那块可能是
     * thrownStones[4] 而 [0..2] 全是用过的空槽。按下标配对的话，那一块永远不显示。
     * 现实里同时最多一块（一次只扛得动一个，冷却 0.75 秒比 0.6 秒的飞行还长），
     * 但这种"现实里碰不到"的错最难查，不如一开始就写对。
     */
    let slot = 0;
    for (const stone of simulation.thrownStones) {
      if (!stone.active) continue;
      const view = this.stoneFlightViews[slot];
      if (!view) break;
      slot += 1;
      const ground = this.groundHeightAt(stone.x, stone.z);
      view.visible = true;
      view.position.set(stone.x, ground + 0.42 + Math.sin(stone.progress * Math.PI) * 1.7, stone.z);
      view.rotation.set(this.stoneSpin * 5.2, this.stoneSpin * 3.7, this.stoneSpin * 4.4);
    }
    for (let index = slot; index < this.stoneFlightViews.length; index += 1) {
      this.stoneFlightViews[index].visible = false;
    }
  }
}

/*
 * 开局指路的浮动箭头。
 *
 * **做成几何体而不是贴图**：场景里每一件道具都是这么搭起来的（锥、胶囊、盒子 +
 * 平直着色），一张外来的箭头贴图会是整个 3D 场景里唯一一处纹理 —— 风格上对不上，
 * 还得为一个开局十几秒就退场的东西背一张图的体积和授权。
 *
 * 尺寸和"不发光柱"这两条是照着 buildTruckBeacon 那段定的：那里拆掉过一根 26 米的
 * 加色光柱，理由是"网游任务标记那一套，和低多边形沙漠不搭，而且注定挡视野"。
 * 所以这根箭头做得小（总高 1.68 米，和人一般高）、贴着目标浮、正常参与深度测试，
 * 不做任何穿墙显示。
 *
 * 这个高度是量出来的：竖屏一屏见 15.6 米、375 CSS px，1 米 ≈ 24 px，
 * 而等距相机压着看，竖向还要再乘 cos(41.8°) ≈ 0.75 —— 1.68 米落到屏幕上约 30 px。
 * 上一版做 1.32 米（约 24 px），在开局那一屏里读起来像地上插了根小钉子。
 *
 * 四棱锥的头配四棱柱的柄 —— 段数取 4 是为了和仙人掌刺那些四面锥同一档面数，
 * 而且两者的顶点相位一致，接缝处不会错开。两段合成一个几何，整根一次 draw call。
 *
 * **尖端在 y=0，往上长**：摆的时候直接把"要指的那个点"交给它，不用再减半高。
 */
function createGuideArrowGeometry(): THREE.BufferGeometry {
  // 头**比自己高还宽**（半径 0.72 对高 0.84）：等距相机压着看，竖向本来就只剩
  // cos(41.8°) ≈ 0.75，头做瘦了从画面上读出来是一根钉子，不是箭头。
  const head = new THREE.ConeGeometry(0.72, 0.84, 4);
  head.rotateX(Math.PI);
  head.translate(0, 0.42, 0);
  const shaft = new THREE.CylinderGeometry(0.24, 0.24, 0.84, 4);
  // 0.84 是锥底，柄从那里接着往上长，所以中心在 0.84 + 0.84/2。
  shaft.translate(0, 1.26, 0);
  const merged = mergeGeometries([head, shaft]);
  head.dispose();
  shaft.dispose();
  if (!merged) throw new Error("guide arrow geometry merge failed");
  return merged;
}
