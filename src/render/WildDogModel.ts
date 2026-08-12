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

const BODY = 0xffffff;
const PATCH = 0x34281f;
const CREAM = 0xf0d8a7;
const BLACK = 0x171514;
const RUST = 0xa94f27;
const AMBER = 0xe8b55c;

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

  // Deep chest, tucked waist and raised shoulders give the model an African wild-dog silhouette.
  add(new THREE.CapsuleGeometry(0.42, 0.82, 3, 6), BONE.root, BODY, [1.04, 1, 0.82], [-0.02, 0.88, 0], Math.PI / 2);
  add(new THREE.DodecahedronGeometry(1, 0), BONE.root, BODY, [0.5, 0.55, 0.43], [0.43, 0.94, 0]);
  add(new THREE.DodecahedronGeometry(1, 0), BONE.root, BODY, [0.43, 0.42, 0.37], [-0.5, 0.84, 0]);
  add(new THREE.DodecahedronGeometry(1, 0), BONE.root, BODY, [0.34, 0.46, 0.36], [0.69, 1.06, 0], -0.22);
  add(new THREE.DodecahedronGeometry(1, 0), BONE.root, CREAM, [0.3, 0.38, 0.44], [0.5, 0.8, 0]);

  // Raised dark saddle and short mane remain readable from the high isometric camera.
  add(new THREE.DodecahedronGeometry(1, 0), BONE.root, PATCH, [0.5, 0.14, 0.31], [-0.18, 1.22, 0.05], 0.07);
  for (let index = 0; index < 4; index += 1) {
    add(
      new THREE.ConeGeometry(0.075, 0.22 - index * 0.018, 4),
      BONE.root,
      BLACK,
      [1, 1, 0.78],
      [0.48 - index * 0.24, 1.39 - index * 0.035, 0],
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
    [scale[0], scale[1], 1], position, rotation,
  );
  addSidePatch(BLACK, [0.35, 0.27], [0.12, 0.93, 0.405], 0.3);
  addSidePatch(CREAM, [0.25, 0.19], [-0.48, 0.82, 0.365], -0.22);
  addSidePatch(RUST, [0.19, 0.23], [0.48, 0.9, 0.415], 0.14);
  addSidePatch(CREAM, [0.26, 0.2], [0.16, 0.95, -0.405], -0.27);
  addSidePatch(BLACK, [0.27, 0.24], [-0.45, 0.85, -0.37], 0.2);
  addSidePatch(RUST, [0.17, 0.2], [0.52, 0.9, -0.415], -0.12);

  // Rounded skull, black mask, long muzzle and very large ears separate it from a wolf at a glance.
  add(new THREE.DodecahedronGeometry(1, 1), BONE.head, BODY, [0.37, 0.34, 0.33], [0.96, 1.23, 0]);
  add(new THREE.DodecahedronGeometry(1, 0), BONE.head, BLACK, [0.25, 0.17, 0.34], [1.02, 1.34, 0]);
  add(new THREE.BoxGeometry(1, 1, 1), BONE.head, CREAM, [0.48, 0.24, 0.28], [1.29, 1.14, 0]);
  add(new THREE.DodecahedronGeometry(1, 0), BONE.head, BLACK, [0.2, 0.18, 0.29], [1.58, 1.14, 0]);
  add(new THREE.SphereGeometry(1, 6, 4), BONE.head, BLACK, [0.075, 0.07, 0.055], [1.7, 1.16, 0]);

  const addEar = (z: number): void => {
    const outward = z > 0 ? 0.1 : -0.1;
    add(new THREE.ConeGeometry(1, 1, 3), BONE.head, BLACK, [0.25, 0.58, 0.17], [0.79, 1.65, z], outward);
    add(new THREE.ConeGeometry(1, 1, 3), BONE.head, RUST, [0.13, 0.36, 0.06], [0.8, 1.64, z + Math.sign(z) * 0.092], outward);
  };
  addEar(0.25);
  addEar(-0.25);
  add(new THREE.SphereGeometry(1, 6, 4), BONE.head, BLACK, [0.08, 0.075, 0.045], [1.13, 1.31, 0.3]);
  add(new THREE.SphereGeometry(1, 6, 4), BONE.head, BLACK, [0.08, 0.075, 0.045], [1.13, 1.31, -0.3]);
  add(new THREE.SphereGeometry(1, 5, 4), BONE.head, AMBER, [0.035, 0.035, 0.025], [1.17, 1.325, 0.338]);
  add(new THREE.SphereGeometry(1, 5, 4), BONE.head, AMBER, [0.035, 0.035, 0.025], [1.17, 1.325, -0.338]);
  add(new THREE.BoxGeometry(1, 1, 1), BONE.jaw, PATCH, [0.43, 0.13, 0.25], [1.34, 1, 0]);
  add(new THREE.BoxGeometry(1, 1, 1), BONE.jaw, CREAM, [0.27, 0.055, 0.2], [1.4, 0.92, 0]);

  const addLeg = (
    bone: number,
    x: number,
    z: number,
    upperColor: number,
    lowerColor: number,
    rear = false,
  ): void => {
    add(new THREE.DodecahedronGeometry(1, 0), bone, upperColor, [rear ? 0.22 : 0.17, 0.28, 0.18], [x, 0.64, z]);
    add(new THREE.CylinderGeometry(0.09, 0.07, 0.56, 5), bone, lowerColor, [1, 1, 1], [x + (rear ? 0.04 : 0), 0.3, z]);
    add(new THREE.BoxGeometry(1, 1, 1), bone, BLACK, [0.2, 0.12, 0.2], [x + 0.09, 0.07, z]);
  };
  addLeg(BONE.frontLeft, 0.49, 0.3, PATCH, CREAM);
  addLeg(BONE.frontRight, 0.49, -0.3, RUST, BLACK);
  addLeg(BONE.rearLeft, -0.51, 0.28, BODY, BLACK, true);
  addLeg(BONE.rearRight, -0.51, -0.28, PATCH, CREAM, true);

  // Three colour blocks turn the tail into a readable white flag with a dark tip.
  add(new THREE.ConeGeometry(0.17, 0.52, 6), BONE.tail, PATCH, [1, 1, 1], [-1.06, 1.01, 0], Math.PI / 2.3);
  add(new THREE.ConeGeometry(0.14, 0.46, 6), BONE.tail, CREAM, [1, 1, 1], [-1.35, 1.2, 0], Math.PI / 2.3);
  add(new THREE.ConeGeometry(0.105, 0.27, 6), BONE.tail, BLACK, [1, 1, 1], [-1.59, 1.35, 0], Math.PI / 2.3);

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
    roughness: 0.95,
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
