import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { CritterKind } from "../game/simulation/types";

/**
 * 猎物模型。
 *
 * 走的是**合并几何 + 顶点色**：一只动物一个 draw call，不用贴图也不用骨骼。
 * 原先每只猎物是十来个各自带材质的 Mesh 松散挂在 Group 上，只有"主色 + 点缀色"
 * 两种颜色可用 —— 想加一双眼睛就得再开一个材质。改成顶点色之后颜色不要钱，
 * 眼睛、鼻头、蹄子、耳廓内侧这些低多边形下辨识度最高的细节才做得起。
 *
 * 不上骨骼：猎物只有"起伏 + 转向"两种动作（见 GameRenderer.syncCritters），
 * 静态网格足够，八套骨骼的复杂度换不来对应的表现力。
 *
 * 约定沿用狗：**朝 +X**，脚底贴 y = 0，最终尺寸由渲染层按 CRITTER_SPECS.scale 缩放。
 */

const DARK = 0x241f1b;
const BONE_WHITE = 0xf2ead6;
const SAND = 0xd9bd8c;
const AMBER = 0xe8b55c;

type Add = (
  geometry: THREE.BufferGeometry,
  color: number,
  scale: [number, number, number],
  position: [number, number, number],
  rotateZ?: number,
  rotateX?: number,
  rotateY?: number,
) => void;

/** 一对左右对称的部件。耳朵、腿、眼睛都靠它，省掉一半重复代码。 */
const mirrored = (add: Add) => (
  geometry: () => THREE.BufferGeometry,
  color: number,
  scale: [number, number, number],
  position: [number, number, number],
  rotateZ = 0,
  rotateX = 0,
): void => {
  add(geometry(), color, scale, [position[0], position[1], position[2]], rotateZ, rotateX);
  add(geometry(), color, scale, [position[0], position[1], -position[2]], rotateZ, -rotateX);
};

/** 眼睛：深色眼球 + 一点高光。低多边形下这是性价比最高的细节，没有之一。 */
const addEyes = (add: Add, x: number, y: number, z: number, size: number, iris = AMBER): void => {
  const pair = mirrored(add);
  pair(() => new THREE.SphereGeometry(1, 6, 4), DARK, [size, size, size * 0.8], [x, y, z]);
  pair(
    () => new THREE.SphereGeometry(1, 5, 4), iris,
    [size * 0.45, size * 0.45, size * 0.35],
    [x + size * 0.5, y + size * 0.1, z + size * 0.55],
  );
};

// =====================================================================
// 长角羚 —— 最大的猎物，比玩家跑得快，唯一产水的一种。
// 剪影全押在**一对向后掠的长直角**上：驼峰是骆驼唯一的辨识符号，
// 换成角之后同一副骨架读起来就是另一个物种。
// =====================================================================
const buildOryx = (add: Add): void => {
  const COAT = 0xe4dac2;
  const FLANK = 0xc0ab8c;
  const HOOF = 0x1b1815;
  const pair = mirrored(add);

  // 躯干：前胸深、后腰收，肩部有羚羊特有的隆起。
  add(new THREE.CapsuleGeometry(0.36, 0.86, 4, 7), COAT, [1, 1, 0.86], [-0.02, 1.02, 0], Math.PI / 2);
  add(new THREE.DodecahedronGeometry(1, 0), COAT, [0.4, 0.42, 0.35], [0.42, 1.16, 0]);
  add(new THREE.DodecahedronGeometry(1, 0), FLANK, [0.34, 0.34, 0.32], [-0.52, 0.98, 0]);
  // 腹侧浅色分界，免得侧面糊成一整块。
  add(new THREE.BoxGeometry(1, 1, 1), BONE_WHITE, [0.86, 0.13, 0.62], [-0.05, 0.74, 0]);

  // 脖子前倾（羚羊不像骆驼那样高举），接一个楔形头。
  add(new THREE.CapsuleGeometry(0.15, 0.44, 3, 6), COAT, [1, 1, 0.9], [0.68, 1.32, 0], -0.72);
  add(new THREE.DodecahedronGeometry(1, 0), COAT, [0.19, 0.17, 0.16], [0.98, 1.53, 0]);
  add(new THREE.BoxGeometry(1, 1, 1), BONE_WHITE, [0.34, 0.15, 0.15], [1.2, 1.46, 0], -0.12);
  add(new THREE.DodecahedronGeometry(1, 0), DARK, [0.09, 0.08, 0.12], [1.38, 1.42, 0]);
  // 脸上的黑色纵纹与额斑 —— 直角羚最好认的花纹。
  pair(() => new THREE.BoxGeometry(1, 1, 1), DARK, [0.3, 0.1, 0.035], [1.14, 1.5, 0.1], -0.12);
  add(new THREE.BoxGeometry(1, 1, 1), DARK, [0.13, 0.22, 0.13], [0.94, 1.58, 0]);

  // 角：四段渐细的长杆，**向后掠**而不是向上竖 —— 直角羚的角几乎贴着背线走。
  // 竖起来会让整只动物比骆驼还高（实测缩放后 3.8，比玩家高一倍），
  // 而且那是牛羊的读法不是羚羊的；压平之后剪影往身后延伸，才是想要的那个轮廓。
  for (let index = 0; index < 4; index += 1) {
    const t = index / 3;
    pair(
      () => new THREE.CylinderGeometry(0.045 - index * 0.009, 0.038 - index * 0.008, 0.34, 5),
      index % 2 === 0 ? HOOF : 0x332c26,
      [1, 1, 1],
      [0.82 - t * 0.86, 1.68 + t * 0.26, 0.075 + t * 0.025],
      0.98 + t * 0.16,
    );
  }
  pair(() => new THREE.ConeGeometry(0.055, 0.2, 4), COAT, [1, 1, 0.5], [0.8, 1.62, 0.16], 0.5, 0.5);
  addEyes(add, 1.06, 1.5, 0.15, 0.055);

  // 腿：前后错开，细长，深色蹄。
  const leg = (x: number, z: number, upper: number): void => {
    add(new THREE.DodecahedronGeometry(1, 0), upper, [0.13, 0.24, 0.13], [x, 0.72, z]);
    add(new THREE.CylinderGeometry(0.055, 0.042, 0.62, 5), COAT, [1, 1, 1], [x, 0.34, z]);
    add(new THREE.CylinderGeometry(0.06, 0.07, 0.14, 5), HOOF, [1, 1, 1], [x, 0.07, z]);
  };
  leg(0.44, 0.26, COAT);
  leg(0.44, -0.26, COAT);
  leg(-0.46, 0.24, FLANK);
  leg(-0.46, -0.24, FLANK);

  // 尾巴：细杆 + 末端毛簇。
  add(new THREE.CylinderGeometry(0.03, 0.024, 0.4, 4), COAT, [1, 1, 1], [-0.82, 0.92, 0], Math.PI / 2.6);
  add(new THREE.ConeGeometry(0.07, 0.24, 5), DARK, [1, 1, 1], [-1.0, 0.74, 0], Math.PI * 0.86);
};

// =====================================================================
// 跳鼠 —— 全场最快（9.6，比玩家还快），但只冲得动 2 秒。
// 剪影押在**巨大后腿 + 极长尾 + 末端白毛球**上，和四足小兽完全不是一个轮廓。
// =====================================================================
const buildJerboa = (add: Add): void => {
  const FUR = SAND;
  const BELLY = 0xf4e8cf;
  const INNER = 0xc79a72;
  const pair = mirrored(add);

  add(new THREE.SphereGeometry(1, 7, 5), FUR, [0.3, 0.28, 0.26], [-0.02, 0.42, 0]);
  add(new THREE.SphereGeometry(1, 6, 4), BELLY, [0.2, 0.17, 0.19], [0.1, 0.31, 0]);
  add(new THREE.SphereGeometry(1, 7, 5), FUR, [0.19, 0.18, 0.17], [0.28, 0.62, 0]);
  add(new THREE.ConeGeometry(0.1, 0.22, 5), BELLY, [1, 1, 0.85], [0.45, 0.58, 0], -Math.PI / 2.1);
  add(new THREE.SphereGeometry(1, 5, 4), DARK, [0.04, 0.035, 0.035], [0.55, 0.57, 0]);

  // 耳朵比野兔还夸张，接近头高的一倍半。
  pair(() => new THREE.CapsuleGeometry(0.05, 0.26, 3, 5), FUR, [1, 1, 0.4], [0.24, 0.86, 0.08], -0.12);
  pair(() => new THREE.CapsuleGeometry(0.03, 0.2, 3, 4), INNER, [1, 1, 0.4], [0.25, 0.86, 0.088], -0.12);
  addEyes(add, 0.36, 0.66, 0.12, 0.05, 0x2a2018);

  // 后腿：折叠的大腿 + 细跖骨 + 长脚掌，跳鼠靠这个弹射。
  pair(() => new THREE.DodecahedronGeometry(1, 0), FUR, [0.16, 0.21, 0.11], [-0.16, 0.4, 0.16]);
  pair(() => new THREE.CylinderGeometry(0.04, 0.032, 0.3, 4), FUR, [1, 1, 1], [-0.1, 0.19, 0.17], 0.5);
  pair(() => new THREE.BoxGeometry(1, 1, 1), INNER, [0.2, 0.045, 0.07], [0.02, 0.03, 0.17]);
  // 前肢极小，几乎只是两点。
  pair(() => new THREE.CylinderGeometry(0.022, 0.018, 0.16, 4), FUR, [1, 1, 1], [0.24, 0.3, 0.1], 0.3);

  // 尾巴比身体还长，末端一撮白毛 —— 逃跑时最显眼的就是这一点。
  for (let index = 0; index < 3; index += 1) {
    add(
      new THREE.CylinderGeometry(0.026 - index * 0.004, 0.022 - index * 0.004, 0.3, 4),
      FUR, [1, 1, 1], [-0.42 - index * 0.28, 0.42 + index * 0.05, 0], Math.PI / 2.2 - index * 0.1,
    );
  }
  add(new THREE.SphereGeometry(1, 6, 4), DARK, [0.06, 0.06, 0.055], [-1.2, 0.6, 0]);
  add(new THREE.SphereGeometry(1, 6, 5), BONE_WHITE, [0.075, 0.09, 0.07], [-1.31, 0.65, 0]);
};

// =====================================================================
// 拾骨鸦 —— 中速，两块肉。
// 秃脖子是秃鹫的招牌，冠羽是鸦科的招牌 —— 换掉之后剪影上是两种鸟。
// =====================================================================
const buildCorvid = (add: Add): void => {
  const PLUME = 0x272430;
  const SHEEN = 0x3c3850;
  const BEAK = 0xb0a894;
  const pair = mirrored(add);

  add(new THREE.CapsuleGeometry(0.24, 0.4, 4, 7), PLUME, [1, 1, 0.86], [-0.04, 0.62, 0], Math.PI / 2);
  add(new THREE.DodecahedronGeometry(1, 0), SHEEN, [0.26, 0.2, 0.26], [0.08, 0.74, 0]);
  add(new THREE.SphereGeometry(1, 7, 5), PLUME, [0.15, 0.15, 0.14], [0.36, 0.88, 0]);
  // 钩喙：上喙略长下弯，下喙短 —— 两段就读得出"钩"。
  add(new THREE.ConeGeometry(0.06, 0.24, 5), BEAK, [1, 1, 0.8], [0.54, 0.9, 0], -Math.PI / 2.2);
  add(new THREE.ConeGeometry(0.04, 0.1, 4), BEAK, [1, 1, 0.8], [0.6, 0.84, 0], -Math.PI / 1.6);
  // 冠羽：三根后掠的小锥。
  for (let index = 0; index < 3; index += 1) {
    add(
      new THREE.ConeGeometry(0.035, 0.16 - index * 0.02, 4), SHEEN, [1, 1, 0.7],
      [0.34 - index * 0.09, 1.02 + index * 0.01, 0], 0.5 + index * 0.15,
    );
  }
  addEyes(add, 0.44, 0.92, 0.1, 0.042, 0xd8cf9a);

  // 收拢的翅膀贴着身体，三段羽片错开，比一块平板耐看得多。
  for (let index = 0; index < 3; index += 1) {
    pair(
      () => new THREE.BoxGeometry(1, 1, 1),
      index === 1 ? SHEEN : PLUME,
      [0.26 - index * 0.03, 0.035, 0.09],
      [0.02 - index * 0.2, 0.68 - index * 0.05, 0.2],
      -0.1 - index * 0.08,
    );
  }
  // 楔形尾羽。
  add(new THREE.BoxGeometry(1, 1, 1), PLUME, [0.3, 0.03, 0.16], [-0.48, 0.56, 0], 0.18);
  add(new THREE.BoxGeometry(1, 1, 1), SHEEN, [0.18, 0.025, 0.1], [-0.72, 0.5, 0], 0.18);
  // 两条细腿 + 爪。
  pair(() => new THREE.CylinderGeometry(0.028, 0.024, 0.32, 4), BEAK, [1, 1, 1], [0.02, 0.2, 0.1]);
  pair(() => new THREE.BoxGeometry(1, 1, 1), BEAK, [0.12, 0.03, 0.05], [0.06, 0.03, 0.1]);
};

// =====================================================================
// 岩蜥 —— 背脊棘刺 + 真正外撇的四肢。
// 蜥蜴的腿长在身体两侧而不是底下，这一条改对了它才不像"矮个子四足兽"。
// =====================================================================
const buildLizard = (add: Add): void => {
  const BACK = 0x7e8a4e;
  const BELLY = 0xc4c290;
  const BAND = 0x4d5530;
  const pair = mirrored(add);

  add(new THREE.CapsuleGeometry(0.19, 0.5, 4, 7), BACK, [1, 0.78, 0.92], [0, 0.2, 0], Math.PI / 2);
  add(new THREE.BoxGeometry(1, 1, 1), BELLY, [0.5, 0.06, 0.28], [0, 0.09, 0]);
  // 背脊棘刺：七片渐变的小锥，从颈后一路排到尾根。
  for (let index = 0; index < 7; index += 1) {
    const t = index / 6;
    add(
      new THREE.ConeGeometry(0.032, 0.13 - t * 0.06, 3), BAND, [1, 1, 0.5],
      [0.34 - index * 0.13, 0.33 - t * 0.05, 0], -0.25,
    );
  }
  // 楔形头 + 下颌线。
  add(new THREE.DodecahedronGeometry(1, 0), BACK, [0.17, 0.11, 0.14], [0.53, 0.23, 0]);
  add(new THREE.ConeGeometry(0.11, 0.24, 5), BACK, [1, 0.8, 0.9], [0.71, 0.21, 0], -Math.PI / 2);
  add(new THREE.BoxGeometry(1, 1, 1), BELLY, [0.16, 0.035, 0.11], [0.66, 0.15, 0]);
  addEyes(add, 0.56, 0.29, 0.1, 0.04, 0xc8a54a);

  // 尾巴四节渐细并轻微摆开，末端点地。
  for (let index = 0; index < 4; index += 1) {
    add(
      new THREE.ConeGeometry(0.11 - index * 0.024, 0.3, 5),
      index % 2 === 0 ? BACK : BAND, [1, 0.8, 1],
      [-0.42 - index * 0.27, 0.2 - index * 0.022, 0], Math.PI / 2,
    );
  }

  // 四肢外撇：大腿横向伸出去，小腿再折向地面 —— 蜥蜴的走法。
  const limb = (x: number, z: number): void => {
    pair(() => new THREE.CylinderGeometry(0.035, 0.03, 0.24, 4), BACK, [1, 1, 1], [x, 0.23, z], 0, Math.PI / 2.6);
    pair(() => new THREE.CylinderGeometry(0.028, 0.022, 0.18, 4), BAND, [1, 1, 1], [x, 0.11, z + 0.11]);
    pair(() => new THREE.BoxGeometry(1, 1, 1), BAND, [0.09, 0.02, 0.08], [x + 0.02, 0.02, z + 0.13]);
  };
  limb(0.3, 0.16);
  limb(-0.24, 0.16);
};

// =====================================================================
// 穴鼠 / 灰背鼠 —— 两种小鼠共用骨架，靠体型和尾巴区分：
// 穴鼠圆胖短尾，灰背鼠瘦长裸尾。原先这两种在视觉上完全一样。
// =====================================================================
const buildRodent = (add: Add, lean: boolean): void => {
  const FUR = lean ? 0x9a8f7c : 0xc9a878;
  const BELLY = lean ? 0xe6dfd0 : 0xf0dcbc;
  const TAIL = lean ? 0xd8c4a8 : FUR;
  const pair = mirrored(add);

  add(
    new THREE.CapsuleGeometry(lean ? 0.15 : 0.18, lean ? 0.34 : 0.24, 4, 6), FUR,
    [1, lean ? 0.92 : 1.05, lean ? 0.9 : 1], [0, lean ? 0.2 : 0.22, 0], Math.PI / 2,
  );
  add(new THREE.BoxGeometry(1, 1, 1), BELLY, [lean ? 0.3 : 0.22, 0.05, 0.18], [0, lean ? 0.09 : 0.11, 0]);
  add(new THREE.DodecahedronGeometry(1, 0), FUR, [0.14, 0.13, 0.12], [lean ? 0.34 : 0.28, 0.26, 0]);
  add(new THREE.ConeGeometry(0.085, lean ? 0.22 : 0.16, 5), BELLY, [1, 1, 0.85], [lean ? 0.52 : 0.42, 0.23, 0], -Math.PI / 2.1);
  add(new THREE.SphereGeometry(1, 5, 4), DARK, [0.028, 0.026, 0.026], [lean ? 0.62 : 0.5, 0.22, 0]);

  pair(() => new THREE.CircleGeometry(1, 6), FUR, [lean ? 0.09 : 0.07, lean ? 0.09 : 0.07, 1], [lean ? 0.3 : 0.26, 0.38, 0.09], 0, Math.PI / 2.4);
  addEyes(add, lean ? 0.42 : 0.36, 0.29, 0.09, lean ? 0.035 : 0.042, 0x241c14);

  // 四条短腿。
  const foot = (x: number): void => {
    pair(() => new THREE.CylinderGeometry(0.026, 0.022, 0.16, 4), FUR, [1, 1, 1], [x, 0.09, 0.11]);
    pair(() => new THREE.BoxGeometry(1, 1, 1), BELLY, [0.07, 0.02, 0.05], [x + 0.01, 0.015, 0.11]);
  };
  foot(lean ? 0.2 : 0.16);
  foot(lean ? -0.2 : -0.16);

  // 尾巴：灰背鼠的又长又裸，穴鼠的短而带毛。
  if (lean) {
    for (let index = 0; index < 3; index += 1) {
      add(
        new THREE.CylinderGeometry(0.018 - index * 0.003, 0.015 - index * 0.003, 0.26, 4), TAIL,
        [1, 1, 1], [-0.38 - index * 0.24, 0.22 + index * 0.03, 0], Math.PI / 2.3 - index * 0.08,
      );
    }
  } else {
    add(new THREE.CylinderGeometry(0.03, 0.02, 0.3, 4), TAIL, [1, 1, 1], [-0.34, 0.24, 0], Math.PI / 2.6);
    add(new THREE.SphereGeometry(1, 5, 4), BELLY, [0.045, 0.045, 0.04], [-0.5, 0.3, 0]);
  }
};

// =====================================================================
// 铠甲虫 —— 站着让你打的那一种。
// 鞘翅中缝 + 触角 + 六条外撇的腿，比一个压扁的球体像样得多。
// =====================================================================
const buildBeetle = (add: Add): void => {
  const SHELL = 0x2f2a26;
  const RIM = 0x6b5a3f;
  const GLOSS = 0x4a4139;
  const pair = mirrored(add);

  add(new THREE.SphereGeometry(1, 8, 6), SHELL, [0.3, 0.17, 0.24], [-0.02, 0.2, 0]);
  // 中缝把鞘翅劈成左右两片 —— 甲虫最好认的一条线。
  add(new THREE.BoxGeometry(1, 1, 1), GLOSS, [0.3, 0.03, 0.015], [-0.02, 0.35, 0]);
  pair(() => new THREE.CircleGeometry(1, 7), GLOSS, [0.09, 0.06, 1], [0.04, 0.3, 0.12], 0, -Math.PI / 2.6);
  add(new THREE.SphereGeometry(1, 6, 4), RIM, [0.24, 0.09, 0.2], [-0.02, 0.11, 0]);
  // 前胸背板 + 头。
  add(new THREE.BoxGeometry(1, 1, 1), GLOSS, [0.12, 0.09, 0.19], [0.22, 0.21, 0]);
  add(new THREE.DodecahedronGeometry(1, 0), SHELL, [0.09, 0.07, 0.1], [0.34, 0.18, 0]);
  addEyes(add, 0.38, 0.2, 0.07, 0.028, 0x8d7a4a);
  // 触角：两段折线。
  pair(() => new THREE.CylinderGeometry(0.012, 0.01, 0.16, 4), RIM, [1, 1, 1], [0.44, 0.26, 0.05], -0.9);
  pair(() => new THREE.CylinderGeometry(0.01, 0.008, 0.14, 4), RIM, [1, 1, 1], [0.55, 0.33, 0.08], -0.3);

  // 六条腿，三对分别向前、向侧、向后撇开。
  for (let index = 0; index < 3; index += 1) {
    const x = 0.16 - index * 0.17;
    const splay = index === 0 ? -0.5 : index === 2 ? 0.5 : 0;
    pair(() => new THREE.CylinderGeometry(0.016, 0.013, 0.18, 4), RIM, [1, 1, 1], [x, 0.13, 0.17], 0, Math.PI / 2.7);
    pair(() => new THREE.CylinderGeometry(0.013, 0.009, 0.16, 4), SHELL, [1, 1, 1], [x + splay * 0.06, 0.08, 0.25], splay);
  }
};

// =====================================================================
// 沙鳗 —— 极快但只冲 1.4 秒，露出沙面的只有一段。
// 原先是一串直线排开的球；改成**拱起的弓形 + 环形口器**，动势和辨识度都不一样了。
// =====================================================================
const buildSandeel = (add: Add): void => {
  const SKIN = 0xcdb489;
  const BELLY = 0xe8dcc0;
  const MAW = 0x8a5b4a;
  const pair = mirrored(add);

  // 五节沿正弦弓起的躯干：中段最高，两端没入沙里。
  for (let index = 0; index < 5; index += 1) {
    const t = index / 4;
    const radius = 0.19 - Math.abs(t - 0.35) * 0.14;
    add(
      new THREE.SphereGeometry(1, 7, 5), index % 2 === 0 ? SKIN : BELLY,
      [radius * 1.15, radius, radius], [0.34 - index * 0.21, 0.06 + Math.sin(t * Math.PI) * 0.26, 0],
    );
  }
  // 口器：一圈内翻的齿。张开的环比一个圆头有攻击性得多。
  add(new THREE.CylinderGeometry(0.15, 0.11, 0.1, 8), SKIN, [1, 1, 1], [0.44, 0.16, 0], -Math.PI / 2.4);
  add(new THREE.CylinderGeometry(0.1, 0.06, 0.08, 8), MAW, [1, 1, 1], [0.5, 0.19, 0], -Math.PI / 2.4);
  for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2;
    add(
      new THREE.ConeGeometry(0.022, 0.09, 3), BONE_WHITE, [1, 1, 1],
      [0.5 + Math.cos(angle) * 0.02, 0.19 + Math.sin(angle) * 0.1, Math.cos(angle) * 0.1],
      -Math.PI / 2.4,
    );
  }
  // 两片侧鳍让它在沙面上有方向感。
  pair(() => new THREE.BoxGeometry(1, 1, 1), BELLY, [0.14, 0.02, 0.07], [0.1, 0.26, 0.14], 0.2, 0.5);
};

const BUILDERS: Record<CritterKind, (add: Add) => void> = {
  oryx: buildOryx,
  jerboa: buildJerboa,
  corvid: buildCorvid,
  lizard: buildLizard,
  gerbil: (add) => buildRodent(add, false),
  rat: (add) => buildRodent(add, true),
  beetle: buildBeetle,
  sandeel: buildSandeel,
};

const createGeometry = (kind: CritterKind): THREE.BufferGeometry => {
  const parts: THREE.BufferGeometry[] = [];
  const add: Add = (geometry, color, scale, position, rotateZ = 0, rotateX = 0, rotateY = 0) => {
    let part = geometry;
    if (part.index) {
      const indexed = part;
      part = indexed.toNonIndexed();
      indexed.dispose();
    }
    part.scale(...scale);
    if (rotateX) part.rotateX(rotateX);
    if (rotateY) part.rotateY(rotateY);
    if (rotateZ) part.rotateZ(rotateZ);
    part.translate(...position);

    const count = part.getAttribute("position").count;
    const colors = new Float32Array(count * 3);
    const shade = new THREE.Color(color);
    for (let index = 0; index < count; index += 1) {
      colors[index * 3] = shade.r;
      colors[index * 3 + 1] = shade.g;
      colors[index * 3 + 2] = shade.b;
    }
    part.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    parts.push(part);
  };

  BUILDERS[kind](add);
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error(`Unable to assemble critter geometry: ${kind}`);
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
};

/** 几何按种类缓存 —— 同一种猎物场上有 4~9 只，没必要各建一份。 */
const geometryCache = new Map<CritterKind, THREE.BufferGeometry>();

export interface CritterMesh {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  /** 受击闪红走它：material.color 是乘在顶点色上的，设成红就是整体染红。 */
  material: THREE.MeshStandardMaterial;
}

export const createCritterMesh = (kind: CritterKind): CritterMesh => {
  let geometry = geometryCache.get(kind);
  if (!geometry) {
    geometry = createGeometry(kind);
    geometryCache.set(kind, geometry);
  }
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.92,
    metalness: 0.02,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  return { mesh, material };
};
