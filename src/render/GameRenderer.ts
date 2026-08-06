import * as THREE from "three";
import type { GameSimulation } from "../game/simulation/GameSimulation";
import { clamp, lerp } from "../game/simulation/geometry";
import type { CampDefinition, GroundItem, Vec2, WolfState, WorldDefinition } from "../game/simulation/types";

interface CampView {
  flame: THREE.Group;
  glow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
}

interface WolfView {
  group: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
}

const makeMaterial = (color: THREE.ColorRepresentation, roughness = 0.9): THREE.MeshStandardMaterial => (
  new THREE.MeshStandardMaterial({ color, roughness, flatShading: true })
);

export class GameRenderer {
  readonly canvas: HTMLCanvasElement;

  private readonly simulation: GameSimulation;
  private readonly world: WorldDefinition;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(47, 1, 0.1, 320);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly worldPoint = new THREE.Vector3();
  private readonly cameraFocus = new THREE.Vector3();
  private readonly playerGroup: THREE.Group;
  private readonly playerBodyMaterial: THREE.MeshStandardMaterial;
  private readonly carriedWood: THREE.Object3D;
  private readonly carriedStone: THREE.Object3D;
  private readonly club: THREE.Mesh;
  private readonly campViews = new Map<number, CampView>();
  private readonly itemViews = new Map<number, THREE.Object3D>();
  private readonly berryViews = new Map<number, THREE.Object3D>();
  private readonly wolfViews = new Map<number, WolfView>();
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly fireLight = new THREE.PointLight(0xff8b38, 0, 22, 2);
  private readonly snow: THREE.Points;
  private cameraShake = 0;
  private time = 0;

  constructor(root: HTMLElement, world: WorldDefinition, simulation: GameSimulation) {
    this.world = world;
    this.simulation = simulation;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.canvas = this.renderer.domElement;
    root.appendChild(this.canvas);

    this.scene.background = new THREE.Color(0x9bb8c2);
    this.scene.fog = new THREE.FogExp2(0x8ca8b1, 0.008);
    this.hemisphere = new THREE.HemisphereLight(0xdff7ff, 0x52616a, 2.2);
    this.scene.add(this.hemisphere);
    this.sun = new THREE.DirectionalLight(0xfff1d4, 3.2);
    this.sun.position.set(-35, 55, 25);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.left = -32;
    this.sun.shadow.camera.right = 32;
    this.sun.shadow.camera.top = 32;
    this.sun.shadow.camera.bottom = -32;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 130;
    this.scene.add(this.sun, this.fireLight);

    this.buildGround();
    this.buildHills();
    this.buildCampWalls();
    this.buildTrees();
    this.buildCamps();
    this.buildBerryPatches();
    this.playerBodyMaterial = makeMaterial(0x2f7b8d, 0.75);
    const player = this.buildPlayer();
    this.playerGroup = player.group;
    this.carriedWood = player.carriedWood;
    this.carriedStone = player.carriedStone;
    this.club = player.club;
    this.scene.add(this.playerGroup);
    this.snow = this.buildSnow();
    this.scene.add(this.snow);

    this.cameraFocus.set(simulation.player.x, 0, simulation.player.z);
    this.resize();
    window.addEventListener("resize", this.resize);
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      document.getElementById("unsupported")?.classList.remove("hidden");
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      document.getElementById("unsupported")?.classList.add("hidden");
    });
  }

  render(deltaSeconds: number): void {
    const delta = Math.min(deltaSeconds, 0.05);
    this.time += delta;
    this.syncPlayer(delta);
    this.syncItems();
    this.syncBerries();
    this.syncWolves(delta);
    this.syncFires();
    this.syncDayNight();
    this.updateCamera(delta);
    this.updateSnow(delta);
    this.renderer.render(this.scene, this.camera);
  }

  screenToWorld(clientX: number, clientY: number): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, this.worldPoint)) return null;
    return { x: this.worldPoint.x, z: this.worldPoint.z };
  }

  impact(strength: number): void {
    this.cameraShake = Math.max(this.cameraShake, strength);
  }

  private readonly resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.fov = width < 760 ? (width < height ? 58 : 50) : 47;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private buildGround(): void {
    const geometry = new THREE.PlaneGeometry(this.world.size + 8, this.world.size + 8, 1, 1);
    const material = makeMaterial(0xdbe8e8, 1);
    const ground = new THREE.Mesh(geometry, material);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const edgeMaterial = makeMaterial(0x526772, 1);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(this.world.size + 12, 2.5, this.world.size + 12), edgeMaterial);
    edge.position.y = -1.35;
    edge.receiveShadow = true;
    this.scene.add(edge);
  }

  private buildHills(): void {
    const geometry = new THREE.SphereGeometry(1, 10, 6);
    const material = makeMaterial(0xb7c4c3, 1);
    const snowMaterial = makeMaterial(0xd7e2e1, 1);
    for (const hill of this.world.hills) {
      const mound = new THREE.Mesh(geometry, material);
      mound.position.set(hill.x, -0.55, hill.z);
      mound.rotation.y = hill.rotation;
      mound.scale.set(hill.scaleX, hill.height, hill.scaleZ);
      mound.receiveShadow = true;
      mound.castShadow = true;
      this.scene.add(mound);

      const cap = new THREE.Mesh(geometry, snowMaterial);
      cap.position.set(hill.x - 0.15, -0.25 + hill.height * 0.05, hill.z - 0.15);
      cap.rotation.y = hill.rotation;
      cap.scale.set(hill.scaleX * 0.92, hill.height * 0.92, hill.scaleZ * 0.92);
      cap.receiveShadow = true;
      this.scene.add(cap);
    }
  }

  private buildCampWalls(): void {
    const wallData = this.world.walls.filter((wall) => wall.kind === "wall");
    const geometry = new THREE.DodecahedronGeometry(1, 0);
    const material = makeMaterial(0x68787b, 1);
    const mesh = new THREE.InstancedMesh(geometry, material, wallData.length);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    wallData.forEach((wall, index) => {
      const height = 1.5 + ((index * 17) % 9) * 0.08;
      position.set(wall.x, height * 0.52 - 0.12, wall.z);
      rotation.setFromEuler(new THREE.Euler(index * 0.73, index * 0.41, index * 0.27));
      scale.set(wall.radius, height, wall.radius * 0.9);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  private buildTrees(): void {
    const trunkGeometry = new THREE.CylinderGeometry(0.22, 0.4, 3.4, 6);
    const branchGeometry = new THREE.ConeGeometry(1.25, 3.5, 7);
    const trunkMaterial = makeMaterial(0x51453d, 1);
    const branchMaterial = makeMaterial(0x465d58, 1);
    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, this.world.trees.length);
    const branches = new THREE.InstancedMesh(branchGeometry, branchMaterial, this.world.trees.length);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    this.world.trees.forEach((tree, index) => {
      position.set(tree.x, 1.65 * tree.scale, tree.z);
      rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), tree.rotation);
      scale.setScalar(tree.scale);
      matrix.compose(position, rotation, scale);
      trunks.setMatrixAt(index, matrix);
      position.y = 3.55 * tree.scale;
      matrix.compose(position, rotation, scale);
      branches.setMatrixAt(index, matrix);
    });
    trunks.castShadow = true;
    branches.castShadow = true;
    this.scene.add(trunks, branches);
  }

  private buildCamps(): void {
    const emberMaterial = new THREE.MeshStandardMaterial({
      color: 0xff7a26,
      emissive: 0xff4c12,
      emissiveIntensity: 2.6,
      roughness: 0.65,
      flatShading: true,
    });
    const innerMaterial = new THREE.MeshBasicMaterial({ color: 0xffdb67 });
    const logMaterial = makeMaterial(0x4c2d20, 1);
    const rockMaterial = makeMaterial(0x4c575a, 1);

    for (const camp of this.world.camps) {
      const group = new THREE.Group();
      group.position.set(camp.x, 0, camp.z);
      for (let index = 0; index < 8; index += 1) {
        const angle = (index / 8) * Math.PI * 2;
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.38, 0), rockMaterial);
        rock.position.set(Math.cos(angle) * 1.18, 0.28, Math.sin(angle) * 1.18);
        rock.scale.set(1.15, 0.72, 0.9);
        rock.rotation.y = angle;
        rock.castShadow = true;
        group.add(rock);
      }
      for (let index = 0; index < 3; index += 1) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 1.6, 6), logMaterial);
        log.rotation.z = Math.PI / 2;
        log.rotation.y = (index / 3) * Math.PI;
        log.position.y = 0.32 + index * 0.03;
        log.castShadow = true;
        group.add(log);
      }
      const flame = new THREE.Group();
      const outer = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.65, 7), emberMaterial);
      outer.position.y = 1.02;
      const inner = new THREE.Mesh(new THREE.ConeGeometry(0.31, 1.05, 6), innerMaterial);
      inner.position.set(0.08, 0.82, 0.03);
      flame.add(outer, inner);
      group.add(flame);

      const glowMaterial = new THREE.MeshBasicMaterial({
        color: 0xff8c3a,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const glow = new THREE.Mesh(new THREE.CircleGeometry(7.4, 32), glowMaterial);
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.035;
      group.add(glow);
      this.scene.add(group);
      this.campViews.set(camp.id, { flame, glow });
    }
  }

  private buildBerryPatches(): void {
    const shrubMaterial = makeMaterial(0x496b54, 1);
    const berryMaterial = new THREE.MeshStandardMaterial({ color: 0xbc4050, roughness: 0.7, emissive: 0x31040a });
    for (const patch of this.simulation.berries) {
      const group = new THREE.Group();
      const shrub = new THREE.Mesh(new THREE.IcosahedronGeometry(0.72, 0), shrubMaterial);
      shrub.position.y = 0.54;
      shrub.scale.set(1.25, 0.7, 1.05);
      group.add(shrub);
      for (let index = 0; index < 4; index += 1) {
        const berry = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 0), berryMaterial);
        const angle = (index / 4) * Math.PI * 2;
        berry.position.set(Math.cos(angle) * 0.46, 0.68 + (index % 2) * 0.18, Math.sin(angle) * 0.4);
        group.add(berry);
      }
      group.position.set(patch.x, 0, patch.z);
      this.scene.add(group);
      this.berryViews.set(patch.id, group);
    }
  }

  private buildPlayer(): { group: THREE.Group; carriedWood: THREE.Object3D; carriedStone: THREE.Object3D; club: THREE.Mesh } {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.56, 1.05, 4, 7), this.playerBodyMaterial);
    body.position.y = 1.27;
    body.castShadow = true;
    group.add(body);

    const hoodMaterial = makeMaterial(0x173942, 0.85);
    const faceMaterial = makeMaterial(0xd9a17e, 0.8);
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.48, 8, 6), hoodMaterial);
    hood.position.set(0, 2.12, 0);
    hood.castShadow = true;
    group.add(hood);
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.28, 7, 5), faceMaterial);
    face.position.set(0.35, 2.12, 0);
    face.scale.set(0.65, 0.85, 0.85);
    group.add(face);

    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.75, 0.72), makeMaterial(0x5c4933, 1));
    pack.position.set(-0.43, 1.42, 0);
    pack.castShadow = true;
    group.add(pack);

    const club = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 1.55, 6), makeMaterial(0x59402e, 1));
    club.position.set(0.55, 1.12, -0.46);
    club.rotation.z = -0.35;
    club.castShadow = true;
    group.add(club);

    const carriedWood = this.createItemView({ kind: "wood" } as GroundItem);
    carriedWood.position.set(-0.1, 1.6, 0.75);
    carriedWood.scale.setScalar(0.8);
    carriedWood.visible = false;
    group.add(carriedWood);
    const carriedStone = this.createItemView({ kind: "stone" } as GroundItem);
    carriedStone.position.set(-0.1, 1.55, 0.75);
    carriedStone.scale.setScalar(0.85);
    carriedStone.visible = false;
    group.add(carriedStone);
    return { group, carriedWood, carriedStone, club };
  }

  private buildSnow(): THREE.Points {
    const count = 620;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = (Math.random() - 0.5) * 65;
      positions[index * 3 + 1] = Math.random() * 28;
      positions[index * 3 + 2] = (Math.random() - 0.5) * 65;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color: 0xf5fcff, size: 0.16, transparent: true, opacity: 0.72, depthWrite: false });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    return points;
  }

  private syncPlayer(delta: number): void {
    const player = this.simulation.player;
    this.playerGroup.position.set(player.x, Math.sin(this.time * 9) * 0.025, player.z);
    const angle = -Math.atan2(player.facing.z, player.facing.x);
    this.playerGroup.rotation.y = angle;
    const attackProgress = player.attackFlash > 0 ? 1 - player.attackFlash / 0.22 : 0;
    this.club.rotation.z = -0.35 - Math.sin(attackProgress * Math.PI) * 1.7;
    this.carriedWood.visible = player.carrying === "wood";
    this.carriedStone.visible = player.carrying === "stone";
    const hurt = player.hurtFlash > 0;
    this.playerBodyMaterial.color.setHex(hurt ? 0xe4544d : 0x2f7b8d);
    if (hurt) this.cameraShake = Math.max(this.cameraShake, 0.13);
    this.playerGroup.scale.y = lerp(this.playerGroup.scale.y, player.attackFlash > 0 ? 0.93 : 1, delta * 15);
  }

  private syncItems(): void {
    for (const item of this.simulation.items) {
      let view = this.itemViews.get(item.id);
      if (view && view.userData.kind !== item.kind) {
        this.scene.remove(view);
        this.itemViews.delete(item.id);
        view = undefined;
      }
      if (!view) {
        view = this.createItemView(item);
        this.scene.add(view);
        this.itemViews.set(item.id, view);
      }
      view.visible = item.active;
      if (!item.active) continue;
      view.position.set(item.x, item.kind === "wood" ? 0.35 : 0.48, item.z);
      view.rotation.y = item.rotation;
      const damageScale = clamp(item.hp / (item.kind === "stone" ? 130 : 70), 0.55, 1);
      view.scale.setScalar(item.placed ? damageScale : 1);
    }
  }

  private createItemView(item: GroundItem): THREE.Object3D {
    let view: THREE.Object3D;
    if (item.kind === "wood") {
      const group = new THREE.Group();
      const material = makeMaterial(0x65432d, 1);
      for (let index = 0; index < 2; index += 1) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 1.65, 7), material);
        log.rotation.z = Math.PI / 2;
        log.position.z = (index - 0.5) * 0.38;
        log.castShadow = true;
        group.add(log);
      }
      view = group;
    } else {
      const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7, 0), makeMaterial(0x748084, 1));
      mesh.scale.set(1.25, 0.72, 0.92);
      mesh.castShadow = true;
      view = mesh;
    }
    view.userData.kind = item.kind;
    return view;
  }

  private syncBerries(): void {
    for (const patch of this.simulation.berries) {
      const view = this.berryViews.get(patch.id);
      if (view) view.visible = patch.berries > 0;
    }
  }

  private syncWolves(delta: number): void {
    const liveIds = new Set<number>();
    for (const wolf of this.simulation.wolves) {
      liveIds.add(wolf.id);
      let view = this.wolfViews.get(wolf.id);
      if (!view) {
        view = this.createWolfView(wolf);
        this.wolfViews.set(wolf.id, view);
        this.scene.add(view.group);
      }
      view.group.position.set(wolf.x, wolf.mode === "dead" ? 0.2 : 0, wolf.z);
      view.group.rotation.y = -Math.atan2(wolf.facing.z, wolf.facing.x);
      if (wolf.mode === "dead") {
        view.group.rotation.z = lerp(view.group.rotation.z, Math.PI / 2, delta * 8);
        view.group.scale.setScalar(clamp(wolf.deathTimer / 0.8, 0, 1));
      } else {
        view.group.rotation.z = 0;
        view.group.position.y = Math.abs(Math.sin(this.time * 8 + wolf.id)) * 0.04;
      }
      view.bodyMaterial.color.setHex(wolf.hurtFlash > 0 ? 0xe04a46 : wolf.raider ? 0x384550 : 0x56656b);
      view.bodyMaterial.emissive.setHex(wolf.mode === "chase" ? 0x160000 : 0x000000);
    }
    for (const [id, view] of this.wolfViews) {
      if (liveIds.has(id)) continue;
      this.scene.remove(view.group);
      view.bodyMaterial.dispose();
      this.wolfViews.delete(id);
    }
  }

  private createWolfView(wolf: WolfState): WolfView {
    const group = new THREE.Group();
    const bodyMaterial = makeMaterial(wolf.raider ? 0x384550 : 0x56656b, 0.95);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 1.05, 3, 5), bodyMaterial);
    body.rotation.z = Math.PI / 2;
    body.position.set(0, 0.75, 0);
    body.scale.set(1, 1, 0.82);
    body.castShadow = true;
    group.add(body);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.85, 5), bodyMaterial);
    head.rotation.z = -Math.PI / 2;
    head.position.set(0.95, 0.88, 0);
    head.castShadow = true;
    group.add(head);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.85, 5), bodyMaterial);
    tail.rotation.z = Math.PI / 2.35;
    tail.position.set(-0.85, 0.88, 0);
    group.add(tail);
    const eyeMaterial = new THREE.MeshBasicMaterial({ color: wolf.raider ? 0xff5b3d : 0xf3c668 });
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 5, 4), eyeMaterial);
    eye.position.set(1.12, 0.98, 0.29);
    group.add(eye);
    return { group, bodyMaterial };
  }

  private syncFires(): void {
    let nearestLit: CampDefinition | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const camp of this.world.camps) {
      const view = this.campViews.get(camp.id);
      if (!view) continue;
      const fuel = this.simulation.camps[camp.id].fuel;
      const lit = fuel > 0;
      view.flame.visible = lit;
      view.glow.visible = lit;
      if (!lit) continue;
      const flutter = 0.86 + Math.sin(this.time * 12 + camp.id * 2.3) * 0.12 + Math.sin(this.time * 19) * 0.05;
      const fuelScale = clamp(fuel / 18, 0.42, 1);
      view.flame.scale.set(flutter * fuelScale, (1.05 / flutter) * fuelScale, flutter * fuelScale);
      view.glow.material.opacity = 0.07 + fuelScale * 0.07;
      const value = (camp.x - this.simulation.player.x) ** 2 + (camp.z - this.simulation.player.z) ** 2;
      if (value < nearestDistance) {
        nearestDistance = value;
        nearestLit = camp;
      }
    }
    if (nearestLit && nearestDistance < 32 * 32) {
      this.fireLight.position.set(nearestLit.x, 2.4, nearestLit.z);
      this.fireLight.intensity = 3.2 + Math.sin(this.time * 14) * 0.3;
    } else {
      this.fireLight.intensity = 0;
    }
  }

  private syncDayNight(): void {
    const daylight = this.simulation.getDaylight();
    const sky = new THREE.Color().lerpColors(new THREE.Color(0x101a30), new THREE.Color(0x9bb8c2), daylight);
    this.scene.background = sky;
    if (this.scene.fog) this.scene.fog.color.copy(sky);
    this.hemisphere.color.lerpColors(new THREE.Color(0x53669e), new THREE.Color(0xdff7ff), daylight);
    this.hemisphere.groundColor.lerpColors(new THREE.Color(0x172035), new THREE.Color(0x52616a), daylight);
    this.hemisphere.intensity = lerp(0.78, 2.2, daylight);
    this.sun.color.lerpColors(new THREE.Color(0x7188c7), new THREE.Color(0xfff1d4), daylight);
    this.sun.intensity = lerp(0.45, 3.2, daylight);
    this.renderer.toneMappingExposure = lerp(0.88, 1.05, daylight);
  }

  private updateCamera(delta: number): void {
    const player = this.simulation.player;
    const smoothing = 1 - Math.exp(-delta * 5.5);
    this.cameraFocus.x = lerp(this.cameraFocus.x, player.x, smoothing);
    this.cameraFocus.z = lerp(this.cameraFocus.z, player.z, smoothing);
    const distanceScale = window.innerWidth < 760 && window.innerWidth < window.innerHeight ? 1.18 : 1;
    const shakeX = (Math.random() - 0.5) * this.cameraShake;
    const shakeZ = (Math.random() - 0.5) * this.cameraShake;
    this.camera.position.set(
      this.cameraFocus.x + 19 * distanceScale + shakeX,
      24 * distanceScale,
      this.cameraFocus.z + 19 * distanceScale + shakeZ,
    );
    this.camera.lookAt(this.cameraFocus.x, 0.8, this.cameraFocus.z);
    this.cameraShake = Math.max(0, this.cameraShake - delta * 0.8);
    this.sun.position.set(this.cameraFocus.x - 35, 55, this.cameraFocus.z + 25);
    this.sun.target.position.set(this.cameraFocus.x, 0, this.cameraFocus.z);
    this.sun.target.updateMatrixWorld();
  }

  private updateSnow(delta: number): void {
    const attribute = this.snow.geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    for (let index = 0; index < attribute.count; index += 1) {
      const offset = index * 3;
      array[offset] += delta * 0.65;
      array[offset + 1] -= delta * (2.3 + (index % 9) * 0.12);
      array[offset + 2] += delta * 0.28;
      if (array[offset + 1] < 0) {
        array[offset] = (Math.random() - 0.5) * 65;
        array[offset + 1] = 24 + Math.random() * 5;
        array[offset + 2] = (Math.random() - 0.5) * 65;
      }
    }
    attribute.needsUpdate = true;
    this.snow.position.set(this.cameraFocus.x, 0, this.cameraFocus.z);
    const material = this.snow.material as THREE.PointsMaterial;
    material.opacity = lerp(0.48, 0.78, 1 - this.simulation.getDaylight());
  }
}
