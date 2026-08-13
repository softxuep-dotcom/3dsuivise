import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const BONE = {
  root: 0,
  head: 1,
  jaw: 2,
  frontLeft: 3,
  frontRight: 4,
  rearLeft: 5,
  rearRight: 6,
  tail: 7,
} as const;

// KayKit-like palette: broad, readable colour blocks rather than noisy realistic fur.
// BODY remains white so GameRenderer's per-kind tint can recolour the main coat.
const BODY = 0xffffff;
const PATCH = 0x49382d;
const CREAM = 0xf2ddb0;
const BLACK = 0x211d1a;
const RUST = 0xb85f32;
const AMBER = 0xf3bd55;

export interface WildDogRig {
  mesh: THREE.SkinnedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  root: THREE.Bone;
  head: THREE.Bone;
  jaw: THREE.Bone;
  legs: [THREE.Bone, THREE.Bone, THREE.Bone, THREE.Bone];
  tail: THREE.Bone;
}

const rigidPart = (
  geometry: THREE.BufferGeometry,
  boneIndex: number,
  color: number,
  transform: (part: THREE.BufferGeometry) => void,
): THREE.BufferGeometry => {
  if (geometry.index) {
    const indexed = geometry;
    geometry = indexed.toNonIndexed();
    indexed.dispose();
  }
  transform(geometry);
  const count = geometry.getAttribute("position").count;
  const skinIndices = new Uint16Array(count * 4);
  const skinWeights = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  const shade = new THREE.Color(color);
  for (let index = 0; index < count; index += 1) {
    skinIndices[index * 4] = boneIndex;
    skinWeights[index * 4] = 1;
    colors[index * 3] = shade.r;
    colors[index * 3 + 1] = shade.g;
    colors[index * 3 + 2] = shade.b;
  }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
};

const scaledAt = (
  geometry: THREE.BufferGeometry,
  scale: [number, number, number],
  position: [number, number, number],
  rotateZ = 0,
  rotateX = 0,
  rotateY = 0,
): void => {
  geometry.scale(...scale);
  if (rotateX) geometry.rotateX(rotateX);
  if (rotateY) geometry.rotateY(rotateY);
  if (rotateZ) geometry.rotateZ(rotateZ);
  geometry.translate(...position);
};

const createGeometry = (): THREE.BufferGeometry => {
  const parts: THREE.BufferGeometry[] = [];
  const add = (
    geometry: THREE.BufferGeometry,
    bone: number,
    color: number,
    scale: [number, number, number],
    position: [number, number, number],
    rotateZ = 0,
    rotateX = 0,
    rotateY = 0,
  ): void => {
    parts.push(rigidPart(geometry, bone, color, (part) => scaledAt(
      part, scale, position, rotateZ, rotateX, rotateY,
    )));
  };

  // Rounded connected masses mirror the KayKit character's chunky, readable silhouette.
  add(new THREE.CapsuleGeometry(0.43, 0.84, 4, 8), BONE.root, BODY, [1.06, 1, 0.86], [-0.04, 0.9, 0], Math.PI / 2);
  add(new THREE.DodecahedronGeometry(1, 1), BONE.root, BODY, [0.5, 0.54, 0.44], [0.42, 0.96, 0]);
  add(new THREE.DodecahedronGeometry(1, 1), BONE.root, BODY, [0.43, 0.43, 0.38], [-0.51, 0.88, 0]);
  add(new THREE.DodecahedronGeometry(1, 1), BONE.root, BODY, [0.37, 0.47, 0.38], [0.67, 1.09, 0], -0.20);
  add(new THREE.DodecahedronGeometry(1, 1), BONE.root, CREAM, [0.31, 0.37, 0.45], [0.49, 0.82, 0]);

  // One clean dark saddle and three mane tufts survive the high isometric camera.
  add(new THREE.DodecahedronGeometry(1, 1), BONE.root, PATCH, [0.5, 0.13, 0.32], [-0.17, 1.24, 0.04], 0.06);
  for (let index = 0; index < 3; index += 1) {
    add(
      new THREE.ConeGeometry(0.072, 0.19 - index * 0.018, 5),
      BONE.root,
      BLACK,
      [1, 1, 0.78],
      [0.48 - index * 0.25, 1.39 - index * 0.03, 0],
      0.04,
    );
  }

  // Flat, irregular side patches add the characteristic mottled coat without textures or extra draw calls.
  const addSidePatch = (
    color: number,
    scale: [number, number],
    position: [number, number, number],
    rotation: number,
  ): void => add(
    new THREE.CircleGeometry(1, 7), BONE.root, color,
    [scale[0], scale[1], 1], position, rotation, 0,
    position[2] < 0 ? Math.PI : 0,
  );
  addSidePatch(BLACK, [0.34, 0.25], [0.10, 0.96, 0.43], 0.28);
  addSidePatch(CREAM, [0.23, 0.18], [-0.48, 0.85, 0.39], -0.20);
  addSidePatch(RUST, [0.18, 0.21], [0.46, 0.91, 0.44], 0.12);
  addSidePatch(CREAM, [0.25, 0.19], [0.14, 0.97, -0.43], -0.24);
  addSidePatch(BLACK, [0.25, 0.22], [-0.44, 0.87, -0.39], 0.18);
  addSidePatch(RUST, [0.17, 0.19], [0.48, 0.92, -0.44], -0.10);

  // Large round ears are intentional: African wild dog identity, softened to match KayKit.
  add(new THREE.DodecahedronGeometry(1, 1), BONE.head, BODY, [0.39, 0.36, 0.35], [0.97, 1.26, 0]);
  add(new THREE.DodecahedronGeometry(1, 1), BONE.head, BLACK, [0.24, 0.16, 0.35], [1.03, 1.36, 0]);
  add(new THREE.CapsuleGeometry(0.18, 0.34, 3, 6), BONE.head, CREAM, [1, 1, 0.84], [1.33, 1.16, 0], Math.PI / 2);
  add(new THREE.DodecahedronGeometry(1, 1), BONE.head, BLACK, [0.18, 0.16, 0.26], [1.58, 1.15, 0]);
  add(new THREE.SphereGeometry(1, 8, 5), BONE.head, BLACK, [0.07, 0.065, 0.055], [1.7, 1.17, 0]);

  const addEar = (z: number): void => {
    // Flattened spheres read as rounded ears, closer to the player's friendly toy-like shapes.
    add(new THREE.SphereGeometry(1, 8, 6), BONE.head, BLACK, [0.25, 0.40, 0.12], [0.79, 1.59, z]);
    add(new THREE.SphereGeometry(1, 8, 6), BONE.head, RUST, [0.15, 0.26, 0.035], [0.82, 1.59, z + Math.sign(z) * 0.112]);
  };
  addEar(0.27);
  addEar(-0.27);
  add(new THREE.SphereGeometry(1, 8, 5), BONE.head, BLACK, [0.065, 0.06, 0.04], [1.15, 1.33, 0.31]);
  add(new THREE.SphereGeometry(1, 8, 5), BONE.head, BLACK, [0.065, 0.06, 0.04], [1.15, 1.33, -0.31]);
  add(new THREE.SphereGeometry(1, 6, 5), BONE.head, AMBER, [0.026, 0.026, 0.02], [1.18, 1.34, 0.342]);
  add(new THREE.SphereGeometry(1, 6, 5), BONE.head, AMBER, [0.026, 0.026, 0.02], [1.18, 1.34, -0.342]);
  add(new THREE.CapsuleGeometry(0.11, 0.30, 3, 6), BONE.jaw, PATCH, [1, 1, 0.9], [1.36, 1.01, 0], Math.PI / 2);
  add(new THREE.BoxGeometry(1, 1, 1), BONE.jaw, CREAM, [0.24, 0.045, 0.18], [1.42, 0.94, 0]);

  const addLeg = (
    bone: number,
    x: number,
    z: number,
    upperColor: number,
    lowerColor: number,
    rear = false,
  ): void => {
    add(new THREE.DodecahedronGeometry(1, 1), bone, upperColor, [rear ? 0.21 : 0.18, 0.28, 0.19], [x, 0.64, z]);
    add(new THREE.CylinderGeometry(0.09, 0.075, 0.54, 7), bone, lowerColor, [1, 1, 1], [x + (rear ? 0.04 : 0), 0.31, z]);
    add(new THREE.CapsuleGeometry(0.09, 0.16, 3, 6), bone, BLACK, [1, 1, 1.12], [x + 0.1, 0.08, z], Math.PI / 2);
  };
  addLeg(BONE.frontLeft, 0.49, 0.3, PATCH, CREAM);
  addLeg(BONE.frontRight, 0.49, -0.3, RUST, BLACK);
  addLeg(BONE.rearLeft, -0.51, 0.28, BODY, BLACK, true);
  addLeg(BONE.rearRight, -0.51, -0.28, PATCH, CREAM, true);

  // Thick raised tail with a white flag and dark tip: iconic and easy to read at game scale.
  add(new THREE.CapsuleGeometry(0.16, 0.36, 3, 7), BONE.tail, PATCH, [1, 1, 0.92], [-1.04, 1.05, 0], Math.PI / 2.25);
  add(new THREE.CapsuleGeometry(0.13, 0.32, 3, 7), BONE.tail, CREAM, [1, 1, 0.9], [-1.35, 1.23, 0], Math.PI / 2.25);
  add(new THREE.ConeGeometry(0.1, 0.26, 7), BONE.tail, BLACK, [1, 1, 1], [-1.61, 1.38, 0], Math.PI / 2.25);

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error("Unable to assemble wild dog geometry");
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
};

const wildDogGeometry = createGeometry();

export const createWildDogRig = (tint: number): WildDogRig => {
  const material = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
    vertexColors: true,
  });
  const mesh = new THREE.SkinnedMesh(wildDogGeometry, material);
  mesh.name = "WildDog";
  mesh.castShadow = true;
  mesh.frustumCulled = true;

  const root = new THREE.Bone();
  root.name = "DogRoot";
  const head = new THREE.Bone();
  head.name = "DogHead";
  head.position.set(0.72, 1.08, 0);
  const jaw = new THREE.Bone();
  jaw.name = "DogJaw";
  jaw.position.set(0.47, -0.02, 0);
  head.add(jaw);

  const makeLeg = (name: string, x: number, z: number): THREE.Bone => {
    const leg = new THREE.Bone();
    leg.name = name;
    leg.position.set(x, 0.7, z);
    return leg;
  };
  const legs: WildDogRig["legs"] = [
    makeLeg("DogFrontLeft", 0.48, 0.29),
    makeLeg("DogFrontRight", 0.48, -0.29),
    makeLeg("DogRearLeft", -0.5, 0.28),
    makeLeg("DogRearRight", -0.5, -0.28),
  ];
  const tail = new THREE.Bone();
  tail.name = "DogTail";
  tail.position.set(-0.78, 0.92, 0);

  root.add(head, ...legs, tail);
  mesh.add(root);
  mesh.updateMatrixWorld(true);
  const bones = [root, head, jaw, ...legs, tail];
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  return { mesh, root, head, jaw, legs, tail };
};
