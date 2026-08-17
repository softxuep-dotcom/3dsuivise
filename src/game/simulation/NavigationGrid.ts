import { isTerrainWalkable, terrainHeightAt } from "../terrain/TerrainModel";
import { direction } from "./geometry";
import type { Vec2, WorldDefinition } from "./types";

const UNREACHABLE = 0xffff;

export class NavigationGrid {
  /**
   * 3 → 1.5。营地坡道是一条宽约 2.5 米的回头弯，而 buildStaticObstacles 只采样
   * 格子中心 —— 3 米的格子里，弯道那几格的中心正好落在崖壁上，整条坡道在流场里
   * 是断的。狼因此只能退化成直线奔向目标，一头撞在崖上原地磨一整夜。
   *
   * 加密到 1.5 米：格数从 74² = 5476 涨到 147² = 21609，一次 BFS 约 17 万次邻居
   * 访问，每 0.65 秒一次 —— 相对于每帧几十只狼的移动计算可以忽略。
   */
  private readonly cellSize = 1.5;
  private readonly width: number;
  private readonly blocked: Uint8Array;
  /**
   * 会移动的障碍（目前是天然石头）。和 blocked 分开存，因为它每次 rebuild 都要重算：
   * 玩家能把石头搬走，格子得跟着解封。
   */
  private readonly dynamic: Uint8Array;
  /** 上一轮盖过章的格子，用来 O(改动量) 清零，不必每次扫全图。 */
  private dynamicStamped: number[] = [];
  private readonly flow: Uint16Array;
  private readonly queue: Uint32Array;
  private target: Vec2 = { x: 0, z: 0 };

  constructor(private readonly world: WorldDefinition) {
    this.width = Math.ceil(world.size / this.cellSize);
    const count = this.width * this.width;
    this.blocked = new Uint8Array(count);
    this.dynamic = new Uint8Array(count);
    this.flow = new Uint16Array(count);
    this.queue = new Uint32Array(count);
    this.buildStaticObstacles();
  }

  /**
   * @param obstacles 实心但**不在 world.walls 里**的圆形障碍 —— 目前是天然石头。
   *
   * 为什么非传不可：石头有碰撞（isBlockingGroundItem 认 kind === "stone"），
   * 而流场只认 world.walls 和地形，于是"物理上撞不过去"和"寻路说直着走"长期不一致。
   * 狗照着流场笔直撞上石头、被碰撞弹回、下一帧又被指向石头 —— 每 40 秒跑出
   * 一百多米路程，净位移 0.0 米，看着就是在原地抽搐。
   */
  rebuild(target: Vec2, obstacles: readonly { x: number; z: number; radius: number }[] = []): void {
    this.stampDynamic(obstacles);
    this.target = { ...target };
    this.flow.fill(UNREACHABLE);
    const targetCell = this.findNearestOpenCell(this.toCell(target));
    if (targetCell < 0) return;
    let read = 0;
    let write = 0;
    this.flow[targetCell] = 0;
    this.queue[write++] = targetCell;
    while (read < write) {
      const current = this.queue[read++];
      const x = current % this.width;
      const z = Math.floor(current / this.width);
      const nextDistance = Math.min(UNREACHABLE - 1, this.flow[current] + 1);
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dz === 0) continue;
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= this.width || nz >= this.width) continue;
          const neighbor = nz * this.width + nx;
          if (this.isBlocked(neighbor) || this.flow[neighbor] !== UNREACHABLE) continue;
          if (dx !== 0 && dz !== 0) {
            const sideA = z * this.width + nx;
            const sideB = nz * this.width + x;
            if (this.isBlocked(sideA) || this.isBlocked(sideB)) continue;
          }
          this.flow[neighbor] = nextDistance;
          this.queue[write++] = neighbor;
        }
      }
    }
  }

  directionFrom(position: Vec2): Vec2 {
    const cell = this.toCell(position);
    if (cell < 0) return direction(position, this.target);
    if (this.flow[cell] === UNREACHABLE) {
      /*
       * 站在流场没覆盖到的格子里 —— 这**不是**异常，是常态。
       *
       * buildStaticObstacles 只采样格子中心，所以一个中心压在崖壁上的 1.5m 格子里，
       * 完全可能有站得住的地方；实体沿坡滑行或被 resolveCollisions 推挤都会落进来。
       * 实测：狗顺着流场走到营地崖脚，第 3.5 秒踏进这样一格，此后 blocked=1、
       * flow=UNREACHABLE，而它脚下的地形其实是可走的。
       *
       * 这时**绝不能**退回"直奔目标"。崖下抬头看台上的玩家，那条直线正是被地形
       * 挡住的方向，于是每一帧都被 canTraverseTerrain 拒掉、一步也走不动 ——
       * 狗就永远站在崖下盯着人，不上来咬。而且这是个单向陷阱：唯一被给出的方向
       * 就是走不通的那个，它自己爬不出来。
       *
       * 改为先朝最近的、**迈得过去的**有流场格走，把自己拉回路网上，再继续下坡。
       */
      const escape = this.nearestFlowCell(cell, position);
      return direction(position, escape < 0 ? this.target : this.cellCenter(escape));
    }
    const x = cell % this.width;
    const z = Math.floor(cell / this.width);
    let best = cell;
    let bestDistance = this.flow[cell];
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= this.width || nz >= this.width) continue;
        /*
         * 对角必须两条边都通 —— 和 rebuild() 里 BFS 的判定**逐字一致**。
         *
         * 少了这一条，给出的方向会指向一个 BFS 自己从没走过的对角：那条直线要斜着
         * 削过被阻挡格的角。实体一步踏进去就落到 flow=UNREACHABLE 的格子里，
         * 被上面的 escape 弹回来，下一帧又被指向同一个对角 —— 来回抖。
         * 实测营地 4 的攻营犬就卡在这上面：每秒走 2.11 米的路程，净位移 0.00 米，
         * 流场值在 10 和 UNREACHABLE 之间反复横跳，一整夜停在离玩家 19.6 米的地方。
         */
        if (dx !== 0 && dz !== 0
          && (this.isBlocked(z * this.width + nx) || this.isBlocked(nz * this.width + x))) continue;
        const neighbor = nz * this.width + nx;
        if (this.flow[neighbor] < bestDistance) {
          best = neighbor;
          bestDistance = this.flow[neighbor];
        }
      }
    }
    return direction(position, this.cellCenter(best));
  }

  private buildStaticObstacles(): void {
    for (let z = 0; z < this.width; z += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const index = z * this.width + x;
        const point = this.cellCenter(index);
        const hitsWall = this.world.walls.some((wall) => {
          const dx = point.x - wall.x;
          const dz = point.z - wall.z;
          const radius = wall.radius + 0.8;
          return dx * dx + dz * dz < radius * radius;
        });
        const hitsSteepTerrain = !isTerrainWalkable(this.world, point);
        this.blocked[index] = hitsWall || hitsSteepTerrain ? 1 : 0;
      }
    }
  }

  private isBlocked(index: number): boolean {
    return this.blocked[index] === 1 || this.dynamic[index] === 1;
  }

  /** 把圆形障碍盖进 dynamic 层；只碰它自己覆盖的那几格，全图扫描没必要。 */
  private stampDynamic(obstacles: readonly { x: number; z: number; radius: number }[]): void {
    for (const index of this.dynamicStamped) this.dynamic[index] = 0;
    this.dynamicStamped = [];
    const half = this.world.size / 2;
    for (const obstacle of obstacles) {
      /*
       * 半径**不加**格子padding。
       *
       * 直觉上该加半格（格子按中心采样，贴着格边的石头会漏掉），但这里加不得：
       * 地图故意在每座营地的单一入口预留了一块可搬大石，而入口本来就窄。
       * 多封 0.75 米，整座营地在流场里就成了孤岛 —— 实测 BFS 可达格从 99.9%
       * 掉到 0.6%，狗一只都摸不进来。宁可让流场略微乐观、把最后半格交给
       * findSteppableDirection 去贴着绕，也不能把入口整个焊死。
       */
      const reach = obstacle.radius;
      const minX = Math.max(0, Math.floor((obstacle.x - reach + half) / this.cellSize));
      const maxX = Math.min(this.width - 1, Math.floor((obstacle.x + reach + half) / this.cellSize));
      const minZ = Math.max(0, Math.floor((obstacle.z - reach + half) / this.cellSize));
      const maxZ = Math.min(this.width - 1, Math.floor((obstacle.z + reach + half) / this.cellSize));
      for (let z = minZ; z <= maxZ; z += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const index = z * this.width + x;
          if (this.dynamic[index] === 1) continue;
          const center = this.cellCenter(index);
          const dx = center.x - obstacle.x;
          const dz = center.z - obstacle.z;
          if (dx * dx + dz * dz > reach * reach) continue;
          this.dynamic[index] = 1;
          this.dynamicStamped.push(index);
        }
      }
    }
  }

  private toCell(point: Vec2): number {
    const half = this.world.size / 2;
    const x = Math.floor((point.x + half) / this.cellSize);
    const z = Math.floor((point.z + half) / this.cellSize);
    if (x < 0 || z < 0 || x >= this.width || z >= this.width) return -1;
    return z * this.width + x;
  }

  private cellCenter(index: number): Vec2 {
    const half = this.world.size / 2;
    return {
      x: (index % this.width) * this.cellSize - half + this.cellSize / 2,
      z: Math.floor(index / this.width) * this.cellSize - half + this.cellSize / 2,
    };
  }

  /**
   * 从 start 向外一圈圈找最近的、BFS 走到过、**而且从 origin 迈得过去**的格子。
   *
   * 三条都必要：
   *  - 有流场值：一个不可达的开放格救不了任何人（这是它和 findNearestOpenCell 的区别，
   *    那个是给目标点用的，只看 blocked）。
   *  - 迈得过去：只按流场值挑会选中崖**上**那一格 —— 它离目标最近，方向却是垂直崖壁。
   *    实测就是这样：狗在第 4.5 秒逃出来一次，5.5 秒又被推回去，6 秒起彻底钉死。
   *  - 由近及远：先回到刚才走过的路上，而不是横着贴崖脚平移。
   *
   * 半径给到 8 格（12m），足够跨过营地崖壁那一圈。
   */
  private nearestFlowCell(start: number, origin: Vec2): number {
    const startX = start % this.width;
    const startZ = Math.floor(start / this.width);
    const maxSlope = this.world.terrain.maxWalkableSlope;
    const originHeight = terrainHeightAt(this.world, origin);
    for (let radius = 1; radius <= 8; radius += 1) {
      let best = -1;
      let bestScore = Infinity;
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          // 只看这一圈的边，里面几圈上一轮已经查过了。
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          const x = startX + dx;
          const z = startZ + dz;
          if (x < 0 || z < 0 || x >= this.width || z >= this.width) continue;
          const index = z * this.width + x;
          if (this.flow[index] === UNREACHABLE) continue;
          const center = this.cellCenter(index);
          const travel = Math.hypot(center.x - origin.x, center.z - origin.z);
          if (travel < 0.0001) continue;
          // 和 GameSimulation.canTraverseTerrain 同一条坡度规则：爬不上去的不算数。
          if (Math.abs(terrainHeightAt(this.world, center) - originHeight) / travel > maxSlope) continue;
          // 同圈内优先离得近的，再用流场值破平 —— 先归队，再谈朝目标走。
          const score = travel * 100 + this.flow[index];
          if (score < bestScore) {
            best = index;
            bestScore = score;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  private findNearestOpenCell(start: number): number {
    if (start < 0) return -1;
    if (!this.isBlocked(start)) return start;
    const startX = start % this.width;
    const startZ = Math.floor(start / this.width);
    for (let radius = 1; radius < 6; radius += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const x = startX + dx;
          const z = startZ + dz;
          if (x < 0 || z < 0 || x >= this.width || z >= this.width) continue;
          const index = z * this.width + x;
          if (!this.isBlocked(index)) return index;
        }
      }
    }
    return -1;
  }
}
