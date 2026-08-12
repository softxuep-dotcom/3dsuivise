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
): void => {
  geometry.scale(...scale);
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
  ): void => {
    parts.push(rigidPart(geometry, bone, color, (part) => scaledAt(part, scale, position, rotateZ)));
  };

  // Broad chest, narrow waist and raised shoulders give a recognisable feral-dog silhouette.
  add(new THREE.CapsuleGeometry(0.42, 0.78, 2, 5), BONE.root, BODY, [1, 1, 0.82], [0, 0.84, 0], Math.PI / 2);
  add(new THREE.DodecahedronGeometry(1, 0), BONE.root, BODY, [0.48, 0.52, 0.42], [0.43, 0.91, 0]);
  add(new THREE.DodecahedronGeometry(1, 0), BONE.root, BODY, [0.43, 0.43, 0.38], [-0.47, 0.82, 0]);
  add(new THREE.DodecahedronGeometry(1, 0), BONE.root, PATCH, [0.44, 0.12, 0.3], [-0.18, 1.19, 0.08], 0.08);
  add(new THREE.DodecahedronGeometry(1, 0), BONE.root, CREAM, [0.27, 0.34, 0.43], [0.52, 0.82, 0]);

  // Head, long muzzle and oversized dark ears distinguish it from the old pointed-cone wolf.
  add(new THREE.DodecahedronGeometry(1, 0), BONE.head, BODY, [0.38, 0.34, 0.32], [0.94, 1.2, 0]);
  add(new THREE.BoxGeometry(1, 1, 1), BONE.head, CREAM, [0.5, 0.23, 0.28], [1.26, 1.12, 0]);
  add(new THREE.BoxGeometry(1, 1, 1), BONE.head, BLACK, [0.17, 0.19, 0.3], [1.56, 1.13, 0]);
  add(new THREE.ConeGeometry(1, 1, 3), BONE.head, BLACK, [0.22, 0.5, 0.15], [0.8, 1.58, 0.25], -0.08);
  add(new THREE.ConeGeometry(1, 1, 3), BONE.head, BLACK, [0.22, 0.5, 0.15], [0.8, 1.58, -0.25], -0.08);
  add(new THREE.SphereGeometry(1, 5, 4), BONE.head, BLACK, [0.055, 0.055, 0.035], [1.12, 1.29, 0.29]);
  add(new THREE.SphereGeometry(1, 5, 4), BONE.head, BLACK, [0.055, 0.055, 0.035], [1.12, 1.29, -0.29]);
  add(new THREE.BoxGeometry(1, 1, 1), BONE.jaw, PATCH, [0.42, 0.12, 0.24], [1.31, 1, 0]);

  const addLeg = (bone: number, x: number, z: number, lowerColor: number): void => {
    add(new THREE.CylinderGeometry(0.105, 0.085, 0.68, 5), bone, PATCH, [1, 1, 1], [x, 0.39, z]);
    add(new THREE.BoxGeometry(1, 1, 1), bone, lowerColor, [0.16, 0.18, 0.2], [x + 0.055, 0.08, z]);
  };
  addLeg(BONE.frontLeft, 0.48, 0.29, CREAM);
  addLeg(BONE.frontRight, 0.48, -0.29, BLACK);
  addLeg(BONE.rearLeft, -0.5, 0.28, BLACK);
  addLeg(BONE.rearRight, -0.5, -0.28, CREAM);

  add(new THREE.ConeGeometry(0.16, 0.78, 5), BONE.tail, BODY, [1, 1, 1], [-1.14, 1.04, 0], Math.PI / 2.25);
  add(new THREE.ConeGeometry(0.12, 0.34, 5), BONE.tail, BLACK, [1, 1, 1], [-1.46, 1.22, 0], Math.PI / 2.25);

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
