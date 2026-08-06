import { direction, pointInEllipse } from "./geometry";
import type { Vec2, WorldDefinition } from "./types";

const UNREACHABLE = 0xffff;

export class NavigationGrid {
  private readonly cellSize = 3;
  private readonly width: number;
  private readonly blocked: Uint8Array;
  private readonly flow: Uint16Array;
  private readonly queue: Uint32Array;
  private target: Vec2 = { x: 0, z: 0 };

  constructor(private readonly world: WorldDefinition) {
    this.width = Math.ceil(world.size / this.cellSize);
    const count = this.width * this.width;
    this.blocked = new Uint8Array(count);
    this.flow = new Uint16Array(count);
    this.queue = new Uint32Array(count);
    this.buildStaticObstacles();
  }

  rebuild(target: Vec2): void {
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
          if (this.blocked[neighbor] || this.flow[neighbor] !== UNREACHABLE) continue;
          if (dx !== 0 && dz !== 0) {
            const sideA = z * this.width + nx;
            const sideB = nz * this.width + x;
            if (this.blocked[sideA] || this.blocked[sideB]) continue;
          }
          this.flow[neighbor] = nextDistance;
          this.queue[write++] = neighbor;
        }
      }
    }
  }

  directionFrom(position: Vec2): Vec2 {
    const cell = this.toCell(position);
    if (cell < 0 || this.flow[cell] === UNREACHABLE) return direction(position, this.target);
    const x = cell % this.width;
    const z = Math.floor(cell / this.width);
    let best = cell;
    let bestDistance = this.flow[cell];
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= this.width || nz >= this.width) continue;
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
        const hitsHill = this.world.hills.some((hill) => pointInEllipse(point, hill, 0.8));
        this.blocked[index] = hitsWall || hitsHill ? 1 : 0;
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

  private findNearestOpenCell(start: number): number {
    if (start < 0) return -1;
    if (!this.blocked[start]) return start;
    const startX = start % this.width;
    const startZ = Math.floor(start / this.width);
    for (let radius = 1; radius < 6; radius += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const x = startX + dx;
          const z = startZ + dz;
          if (x < 0 || z < 0 || x >= this.width || z >= this.width) continue;
          const index = z * this.width + x;
          if (!this.blocked[index]) return index;
        }
      }
    }
    return -1;
  }
}
