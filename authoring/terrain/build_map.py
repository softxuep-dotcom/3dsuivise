import bpy
import base64
import json
import math
import os
import random
import struct
from pathlib import Path
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "authoring" / "terrain"
BLUEPRINT_PATH = ROOT / "src" / "game" / "content" / "mapBlueprint.json"
HEIGHTFIELD_PATH = ROOT / "src" / "game" / "content" / "terrainHeightfield.json"
BLEND_PATH = SOURCE_DIR / "ember_ridge_map.blend"
PREVIEW_SUFFIX = os.environ.get("TERRAIN_PREVIEW_SUFFIX", "")
OVERVIEW_PATH = SOURCE_DIR / f"preview_overview{PREVIEW_SUFFIX}.png"
START_PATH = SOURCE_DIR / f"preview_start_camp{PREVIEW_SUFFIX}.png"
CAMP_PREVIEW_PATHS = [SOURCE_DIR / f"preview_camp_{index + 1}{PREVIEW_SUFFIX}.png" for index in range(5)]
LOW_PREVIEW_PATHS = [SOURCE_DIR / f"preview_camp_{index + 1}_low{PREVIEW_SUFFIX}.png" for index in range(5)]
SLOPE_PATH = SOURCE_DIR / f"preview_slope{PREVIEW_SUFFIX}.png"
NAV_PATH = SOURCE_DIR / f"preview_navigation{PREVIEW_SUFFIX}.png"

with BLUEPRINT_PATH.open("r", encoding="utf-8") as handle:
    BLUEPRINT = json.load(handle)
with HEIGHTFIELD_PATH.open("r", encoding="utf-8") as handle:
    HEIGHTFIELD = json.load(handle)
height_bytes = base64.b64decode(HEIGHTFIELD["data"])
HEIGHT_VALUES = struct.unpack(f"<{len(height_bytes) // 2}H", height_bytes)


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def lerp(a, b, amount):
    return a + (b - a) * amount


def smoothstep(edge0, edge1, value):
    amount = clamp((value - edge0) / max(0.0001, edge1 - edge0), 0.0, 1.0)
    return amount * amount * (3.0 - 2.0 * amount)


def imul(a, b):
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def hash2(x, y, seed):
    value = (imul(x, 374761393) + imul(y, 668265263) + imul(seed, 1442695041)) & 0xFFFFFFFF
    value = imul(value ^ (value >> 13), 1274126177)
    return ((value ^ (value >> 16)) & 0xFFFFFFFF) / 4294967295.0


def value_noise(x, y, seed):
    ix = math.floor(x)
    iy = math.floor(y)
    fx = x - ix
    fy = y - iy
    sx = fx * fx * (3.0 - 2.0 * fx)
    sy = fy * fy * (3.0 - 2.0 * fy)
    a = lerp(hash2(ix, iy, seed), hash2(ix + 1, iy, seed), sx)
    b = lerp(hash2(ix, iy + 1, seed), hash2(ix + 1, iy + 1, seed), sx)
    return lerp(a, b, sy) * 2.0 - 1.0


def base_height(x, y):
    seed = BLUEPRINT["seed"]
    warped_x = x + value_noise(x / 54.0, y / 54.0, seed + 901) * 7.5
    warped_y = y + value_noise(x / 54.0, y / 54.0, seed + 977) * 7.5
    ridge_field = 1.0 - abs(value_noise(warped_x / 34.0, warped_y / 34.0, seed + 401))
    height = value_noise(warped_x / 62.0, warped_y / 62.0, seed) * 1.25
    height += value_noise(warped_x / 29.0, warped_y / 29.0, seed + 31) * 0.82
    height += (ridge_field - 0.48) * 1.45
    height += value_noise(warped_x / 9.0, warped_y / 9.0, seed + 79) * 0.14
    for ridge_id, ridge in enumerate(BLUEPRINT["ridges"]):
        dx = x - ridge["x"]
        dy = y - ridge["z"]
        cosine = math.cos(-ridge["rotation"])
        sine = math.sin(-ridge["rotation"])
        local_x = dx * cosine - dy * sine
        local_y = dx * sine + dy * cosine
        local_y += math.sin(local_x / max(5.0, ridge["scaleX"]) * math.pi * 1.7 + ridge_id * 0.73) * ridge["scaleZ"] * 0.09
        edge_noise = value_noise((x + ridge_id * 17) / 12.0, (y - ridge_id * 11) / 12.0, seed + 1301) * 0.12
        q = (local_x * local_x / (ridge["scaleX"] ** 2) + local_y * local_y / (ridge["scaleZ"] ** 2)) / (1.0 + edge_noise)
        if q < 1.0:
            height += ridge["height"] * (smoothstep(1.0, 0.0, q) ** 1.35)
    return height


def camp_approach_offset(camp, camp_id, along):
    start = camp["radius"] * 0.55
    end = camp["radius"] + 24.0
    amount = clamp((along - start) / (end - start), 0.0, 1.0)
    return math.sin(amount * math.pi) * math.sin(camp_id * 1.73 + 0.55) * 1.75


def shape_camp(height, camp, camp_id, x, y):
    dx = x - camp["x"]
    dy = y - camp["z"]
    radius = camp["radius"]
    forward_x = math.cos(camp["entranceAngle"])
    forward_y = math.sin(camp["entranceAngle"])
    along = dx * forward_x + dy * forward_y
    across = -dx * forward_y + dy * forward_x
    half_across = radius * (0.73 + (camp_id % 3) * 0.045)
    half_along = radius * (1.24 + ((camp_id + 1) % 2) * 0.1)
    shifted_along = along + radius * 0.28
    result = height
    profile_angle = math.atan2(across / half_across, shifted_along / half_along)
    edge_warp = 1.0 + math.sin(profile_angle * 3.0 + camp_id * 1.41) * 0.11 + math.sin(profile_angle * 5.0 - camp_id * 0.83) * 0.055
    profile = math.hypot(across / half_across, shifted_along / half_along) / edge_warp
    plateau = 1.0 - smoothstep(0.82, 1.025, profile)
    detail = value_noise((x + camp_id * 13) / 7.5, (y - camp_id * 7) / 7.5, 6101 + camp_id) * 0.16
    crown = camp["elevation"] + detail + (1.0 - clamp(profile, 0.0, 1.0)) * 0.1
    result = lerp(result, crown, plateau)
    ramp_start = radius * 0.55
    ramp_end = radius + 24.0
    if ramp_start - 1.5 < along < ramp_end and abs(across) < 5.2:
        centered_across = abs(across - camp_approach_offset(camp, camp_id, along))
        lane = 1.0 - smoothstep(1.7, 3.05, centered_across)
        start = smoothstep(ramp_start - 1.5, ramp_start + 1.2, along)
        end = 1.0 - smoothstep(ramp_end - 4.0, ramp_end, along)
        descent = smoothstep(radius - 1.8, ramp_end - 4.5, along)
        target = lerp(camp["elevation"] + detail * 0.3, height, descent)
        result = lerp(result, target, lane * start * end)
    return result


def terrain_height(x, y):
    resolution = HEIGHTFIELD["resolution"]
    size = HEIGHTFIELD["size"]
    grid_x = clamp((x + size * 0.5) / size * resolution, 0.0, resolution)
    grid_y = clamp((y + size * 0.5) / size * resolution, 0.0, resolution)
    x0, y0 = math.floor(grid_x), math.floor(grid_y)
    x1, y1 = min(resolution, x0 + 1), min(resolution, y0 + 1)
    stride = resolution + 1
    height_range = HEIGHTFIELD["maxHeight"] - HEIGHTFIELD["minHeight"]
    def decode(index):
        return HEIGHTFIELD["minHeight"] + HEIGHT_VALUES[index] / 65535.0 * height_range
    top = lerp(decode(y0 * stride + x0), decode(y0 * stride + x1), grid_x - x0)
    bottom = lerp(decode(y1 * stride + x0), decode(y1 * stride + x1), grid_x - x0)
    return lerp(top, bottom, grid_y - y0)


def terrain_slope(x, y, distance=0.9):
    dx = (terrain_height(x + distance, y) - terrain_height(x - distance, y)) / (distance * 2.0)
    dy = (terrain_height(x, y + distance) - terrain_height(x, y - distance)) / (distance * 2.0)
    return math.hypot(dx, dy)


def terrain_snow(x, y):
    height = terrain_height(x, y)
    slope = terrain_slope(x, y, 1.1)
    drift = value_noise(x / 11.0, y / 11.0, BLUEPRINT["seed"] + 503) * 0.5 + 0.5
    altitude = smoothstep(11.5, 13.5, height)
    return clamp(altitude * (1.0 - smoothstep(0.38, 0.9, slope)) * smoothstep(0.58, 0.82, drift), 0.0, 1.0)


def make_material(name, color, roughness=1.0, emission=None):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*color, 1.0)
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (*color, 1.0)
    principled.inputs["Roughness"].default_value = roughness
    if emission:
        principled.inputs["Emission Color"].default_value = (*emission, 1.0)
        principled.inputs["Emission Strength"].default_value = 2.5
    return material


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.name != "Collection":
            bpy.data.collections.remove(collection)
    base = bpy.data.collections.get("Collection")
    base.name = "TERRAIN"
    return {
        "terrain": base,
        "camps": bpy.data.collections.new("CAMPS"),
        "landmarks": bpy.data.collections.new("LANDMARKS"),
        "markers": bpy.data.collections.new("GAMEPLAY_MARKERS"),
    }


COLLECTIONS = clear_scene()
for key in ("camps", "landmarks", "markers"):
    bpy.context.scene.collection.children.link(COLLECTIONS[key])

MAT_GRASS = make_material("Ground_DryGrass", (0.34, 0.38, 0.25))
MAT_SOIL = make_material("Ground_Soil", (0.38, 0.31, 0.23))
MAT_ROCK = make_material("Ground_Rock", (0.31, 0.34, 0.32))
MAT_SNOW = make_material("Ground_SparseSnow", (0.68, 0.75, 0.72))
MAT_WALL = make_material("Camp_Rock", (0.28, 0.31, 0.29))
MAT_WOOD = make_material("Old_Wood", (0.28, 0.19, 0.12))
MAT_FIRE = make_material("Fire_Marker", (1.0, 0.21, 0.03), 0.6, (1.0, 0.08, 0.01))
MAT_FLAG = make_material("Wind_Flag", (0.43, 0.18, 0.10))
MAT_PATH = make_material("Ground_WornPath", (0.42, 0.31, 0.19))
MAT_COVER = make_material("Ground_DryCover", (0.28, 0.34, 0.19))

MAT_TERRAIN = bpy.data.materials.new("Terrain_VertexBlend")
MAT_TERRAIN.use_nodes = True
terrain_principled = MAT_TERRAIN.node_tree.nodes.get("Principled BSDF")
terrain_principled.inputs["Roughness"].default_value = 0.96
terrain_vertex_color = MAT_TERRAIN.node_tree.nodes.new("ShaderNodeVertexColor")
terrain_vertex_color.layer_name = "TerrainColor"
MAT_TERRAIN.node_tree.links.new(terrain_vertex_color.outputs["Color"], terrain_principled.inputs["Base Color"])


def move_to_collection(obj, collection):
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)


def add_rock(name, x, y, z, scale=(1.0, 1.0, 1.0), rotation=(0.0, 0.0, 0.0), material=MAT_WALL, collection=None):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1.0, location=(x, y, z), rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(material)
    move_to_collection(obj, collection or COLLECTIONS["landmarks"])
    return obj


def mix_color(a, b, amount):
    return tuple(lerp(a[index], b[index], clamp(amount, 0.0, 1.0)) for index in range(3))


def point_segment_distance(x, y, start, end):
    vx, vy = end[0] - start[0], end[1] - start[1]
    amount = clamp(((x - start[0]) * vx + (y - start[1]) * vy) / max(0.0001, vx * vx + vy * vy), 0.0, 1.0)
    return math.hypot(x - (start[0] + vx * amount), y - (start[1] + vy * amount))


def camp_local_to_world(camp, point):
    forward_x = math.cos(camp["entranceAngle"])
    forward_y = math.sin(camp["entranceAngle"])
    side_x, side_y = -forward_y, forward_x
    return (
        camp["x"] + side_x * point["x"] + forward_x * point["z"],
        camp["z"] + side_y * point["x"] + forward_y * point["z"],
    )


def camp_path_distance(camp, x, y):
    points = [camp_local_to_world(camp, point) for point in camp["approach"]]
    return min(point_segment_distance(x, y, start, end) for start, end in zip(points, points[1:]))


def terrain_color(x, y):
    # Keep Blender's vertex preview close to the WebGL palette so the .blend
    # remains a trustworthy authoring artifact instead of a nearly-black debug view.
    dry = (0.467, 0.467, 0.361)
    damp = (0.349, 0.400, 0.306)
    soil = (0.353, 0.271, 0.196)
    rock = (0.400, 0.420, 0.404)
    snow = (0.765, 0.796, 0.769)
    height = terrain_height(x, y)
    slope = terrain_slope(x, y, 1.15)
    moisture_noise = value_noise(x / 18.0, y / 18.0, BLUEPRINT["seed"] + 211) * 0.5 + 0.5
    moisture = clamp(moisture_noise * 0.72 + clamp((1.8 - height) / 7.0, 0.0, 0.35), 0.0, 1.0)
    color = mix_color(dry, damp, moisture * 0.72)
    camp_wear_amount = 0.0
    path_wear_amount = 0.0
    for camp in BLUEPRINT["camps"]:
        distance = math.hypot(x - camp["x"], y - camp["z"])
        camp_wear = 1.0 - smoothstep(camp["radius"] * 0.2, camp["radius"] * 0.55, distance)
        path_wear = 1.0 - smoothstep(camp["approachWidth"] * 0.48, camp["approachWidth"] * 0.48 + 1.65, camp_path_distance(camp, x, y))
        camp_wear_amount = max(camp_wear_amount, camp_wear * 0.42)
        path_wear_amount = max(path_wear_amount, path_wear)
    color = mix_color(color, soil, camp_wear_amount)
    color = mix_color(color, rock, smoothstep(0.3, 0.72, slope))
    color = mix_color(color, soil, path_wear_amount * 0.84)
    color = mix_color(color, snow, terrain_snow(x, y) * 0.9 * (1.0 - path_wear_amount * 0.82))
    macro = 0.93 + value_noise(x / 24.0, y / 24.0, BLUEPRINT["seed"] + 1703) * 0.055
    return tuple(clamp(channel * macro, 0.0, 1.0) for channel in color)


size = BLUEPRINT["size"] + 8.0
segments = BLUEPRINT["resolution"]
vertices = []
faces = []
for row in range(segments + 1):
    y = -size / 2.0 + size * row / segments
    for column in range(segments + 1):
        x = -size / 2.0 + size * column / segments
        vertices.append((x, y, terrain_height(x, y)))
for row in range(segments):
    for column in range(segments):
        a = row * (segments + 1) + column
        faces.append((a, a + 1, a + segments + 2, a + segments + 1))

mesh = bpy.data.meshes.new("EmberRidge_Heightfield")
mesh.from_pydata(vertices, [], faces)
mesh.materials.clear()
mesh.materials.append(MAT_TERRAIN)
colors = mesh.color_attributes.new(name="TerrainColor", type="BYTE_COLOR", domain="POINT")
for vertex in mesh.vertices:
    color = terrain_color(vertex.co.x, vertex.co.y)
    colors.data[vertex.index].color = (*color, 1.0)
for polygon in mesh.polygons:
    polygon.use_smooth = True
terrain = bpy.data.objects.new("TERRAIN_Heightfield", mesh)
COLLECTIONS["terrain"].objects.link(terrain)

cover_vertices = []
cover_faces = []
cover_random = random.Random(BLUEPRINT["seed"] + 4403)
cover_count = 0
cover_attempts = 0
while cover_count < 520 and cover_attempts < 9000:
    cover_attempts += 1
    x = cover_random.uniform(-105, 105)
    y = cover_random.uniform(-105, 105)
    if terrain_slope(x, y) > 0.5:
        continue
    if any(math.hypot(x - camp["x"], y - camp["z"]) < camp["radius"] - 1.5 for camp in BLUEPRINT["camps"]):
        continue
    base = len(cover_vertices)
    scale = cover_random.uniform(0.35, 0.82)
    angle = cover_random.uniform(0.0, math.tau)
    side_x = math.cos(angle) * 0.18 * scale
    side_y = math.sin(angle) * 0.18 * scale
    height = terrain_height(x, y) + 0.02
    cover_vertices.extend([
        (x - side_x, y - side_y, height),
        (x + side_x, y + side_y, height),
        (x + math.sin(angle) * 0.06, y + math.cos(angle) * 0.06, height + 0.68 * scale),
    ])
    cover_faces.append((base, base + 1, base + 2))
    cover_count += 1
cover_mesh = bpy.data.meshes.new("Ground_Cover_Tufts")
cover_mesh.from_pydata(cover_vertices, [], cover_faces)
cover_mesh.materials.append(MAT_COVER)
cover = bpy.data.objects.new("LANDMARKS_DryGroundCover", cover_mesh)
COLLECTIONS["landmarks"].objects.link(cover)

for ridge_id, ridge in enumerate(BLUEPRINT["ridges"]):
    for rock_id in range(3):
        along = (rock_id - 1) * ridge["scaleX"] * 0.18
        x = ridge["x"] + math.cos(ridge["rotation"]) * along + math.sin(ridge["rotation"]) * (1.1 if rock_id % 2 else -0.8)
        y = ridge["z"] + math.sin(ridge["rotation"]) * along - math.cos(ridge["rotation"]) * (1.1 if rock_id % 2 else -0.8)
        rock_height = 0.9 + (ridge_id % 4) * 0.28 + rock_id * 0.16
        add_rock(
            f"RIDGE_{ridge_id:02d}_Outcrop_{rock_id}", x, y, terrain_height(x, y) + rock_height * 0.42,
            (1.2 + rock_id * 0.32, 0.9 + (ridge_id % 3) * 0.22, rock_height),
            (rock_id * 0.34, 0.0, ridge["rotation"] + rock_id * 0.8),
        )

for camp_id, camp in enumerate(BLUEPRINT["camps"]):
    cx, cy = camp["x"], camp["z"]
    elevation = terrain_height(cx, cy)
    marker = bpy.data.objects.new(f"CAMP_{camp_id:02d}_{camp['kind']}_CENTER", None)
    marker.location = (cx, cy, elevation + 0.2)
    marker.empty_display_type = "CIRCLE"
    marker.empty_display_size = 2.0
    COLLECTIONS["markers"].objects.link(marker)
    forward_x = math.cos(camp["entranceAngle"])
    forward_y = math.sin(camp["entranceAngle"])
    side_x, side_y = -forward_y, forward_x
    entrance_x = cx + side_x * camp["gate"]["x"] + forward_x * camp["gate"]["z"]
    entrance_y = cy + side_y * camp["gate"]["x"] + forward_y * camp["gate"]["z"]
    entrance = bpy.data.objects.new(f"CAMP_{camp_id:02d}_ENTRANCE", None)
    entrance.location = (entrance_x, entrance_y, terrain_height(entrance_x, entrance_y) + 0.2)
    entrance.empty_display_type = "ARROWS"
    entrance.rotation_euler[2] = camp["entranceAngle"]
    COLLECTIONS["markers"].objects.link(entrance)

    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.72, depth=1.0, location=(cx, cy, elevation + 0.5))
    fire = bpy.context.object
    fire.name = f"CAMP_{camp_id:02d}_Fire"
    fire.data.materials.append(MAT_FIRE)
    move_to_collection(fire, COLLECTIONS["camps"])

    stone_x = entrance_x
    stone_y = entrance_y
    add_rock(
        f"CAMP_{camp_id:02d}_MovableBoulder", stone_x, stone_y, terrain_height(stone_x, stone_y) + 0.8,
        (1.55, 1.3, 1.1), (0.1, 0.22, camp["entranceAngle"]), MAT_WALL, COLLECTIONS["camps"],
    )

    back = camp["entranceAngle"] + math.pi
    if camp["kind"] == "deep-cave":
        for offset in (-1, 0, 1):
            angle = back + offset * 0.16
            x = cx + math.cos(angle) * 8.2
            y = cy + math.sin(angle) * 8.2
            scale = (2.1, 1.7, 2.8 if offset == 0 else 2.0)
            add_rock(f"CAMP_{camp_id:02d}_CaveArch_{offset+1}", x, y, terrain_height(x, y) + scale[2] * 0.42, scale, material=MAT_WALL, collection=COLLECTIONS["camps"])
    elif camp["kind"] == "windy-ridge":
        x = cx + math.cos(back) * 5.8
        y = cy + math.sin(back) * 5.8
        bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=0.1, depth=5.2, location=(x, y, elevation + 2.6))
        pole = bpy.context.object
        pole.name = f"CAMP_{camp_id:02d}_WindMast"
        pole.data.materials.append(MAT_WOOD)
        move_to_collection(pole, COLLECTIONS["camps"])
        bpy.ops.mesh.primitive_cube_add(location=(x + 0.8, y, elevation + 4.1), scale=(0.85, 0.05, 0.38))
        flag = bpy.context.object
        flag.name = f"CAMP_{camp_id:02d}_WindFlag"
        flag.data.materials.append(MAT_FLAG)
        move_to_collection(flag, COLLECTIONS["camps"])
    else:
        for crate_id in range(3):
            angle = back + 0.35
            radius = 4.8 + crate_id * 1.15
            x = cx + math.cos(angle) * radius
            y = cy + math.sin(angle) * radius
            bpy.ops.mesh.primitive_cube_add(location=(x, y, terrain_height(x, y) + 0.45), scale=(0.62, 0.52, 0.45))
            crate = bpy.context.object
            crate.name = f"CAMP_{camp_id:02d}_RuinedCrate_{crate_id}"
            crate.rotation_euler[2] = back + crate_id * 0.4
            crate.data.materials.append(MAT_WOOD)
            move_to_collection(crate, COLLECTIONS["camps"])
        shelter_angle = back - 0.55
        shelter_x = cx + math.cos(shelter_angle) * 5.4
        shelter_y = cy + math.sin(shelter_angle) * 5.4
        bpy.ops.mesh.primitive_plane_add(size=2.0, location=(shelter_x, shelter_y, elevation + 1.55))
        lean_to = bpy.context.object
        lean_to.name = f"CAMP_{camp_id:02d}_TornLeanTo"
        lean_to.scale = (1.85, 1.3, 1.0)
        lean_to.rotation_euler = (0.52, 0.0, shelter_angle)
        lean_to.data.materials.append(MAT_SOIL)
        move_to_collection(lean_to, COLLECTIONS["camps"])
        fence_angle = back + 1.1
        fence_x = cx + math.cos(fence_angle) * 6.5
        fence_y = cy + math.sin(fence_angle) * 6.5
        bpy.ops.mesh.primitive_cube_add(location=(fence_x, fence_y, elevation + 0.72), scale=(2.4, 0.11, 0.08))
        fence = bpy.context.object
        fence.name = f"CAMP_{camp_id:02d}_BrokenFence"
        fence.rotation_euler = (0.0, -0.18, back - 0.35)
        fence.data.materials.append(MAT_WOOD)
        move_to_collection(fence, COLLECTIONS["camps"])

random.seed(BLUEPRINT["seed"] + 2026)
tree_count = 0
attempts = 0
while tree_count < 18 and attempts < 1200:
    attempts += 1
    x = random.uniform(-103, 103)
    y = random.uniform(-103, 103)
    if terrain_slope(x, y) > 0.42:
        continue
    if any(math.hypot(x - camp["x"], y - camp["z"]) < camp["radius"] + 3.0 for camp in BLUEPRINT["camps"]):
        continue
    height = terrain_height(x, y)
    bpy.ops.mesh.primitive_cone_add(vertices=7, radius1=1.15, radius2=0.08, depth=3.8, location=(x, y, height + 2.7))
    tree = bpy.context.object
    tree.name = f"TREE_{tree_count:03d}"
    tree.scale = (random.uniform(0.65, 1.1), random.uniform(0.65, 1.1), random.uniform(0.8, 1.3))
    tree.data.materials.append(MAT_GRASS)
    move_to_collection(tree, COLLECTIONS["landmarks"])
    tree_count += 1


def point_camera(camera, target):
    direction = Vector(target) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


bpy.ops.object.light_add(type="SUN", location=(-45, -55, 80))
sun = bpy.context.object
sun.name = "Preview_Sun"
sun.data.energy = 2.7
sun.rotation_euler = (math.radians(36), math.radians(-18), math.radians(-58))
sun.data.color = (1.0, 0.9, 0.78)

bpy.ops.object.light_add(type="AREA", location=(25, -20, 55))
fill = bpy.context.object
fill.name = "Preview_SkyFill"
fill.data.energy = 560
fill.data.shape = "DISK"
fill.data.size = 85

bpy.ops.object.camera_add(location=(148, -178, 190))
camera = bpy.context.object
camera.name = "Preview_Camera"
camera.data.lens = 54
point_camera(camera, (0, 0, 0))
bpy.context.scene.camera = camera

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1280
scene.render.resolution_y = 820
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
scene.world.color = (0.055, 0.075, 0.08)
scene.world.use_nodes = True
world_background = scene.world.node_tree.nodes.get("Background")
world_background.inputs["Color"].default_value = (0.035, 0.055, 0.07, 1.0)
world_background.inputs["Strength"].default_value = 0.38
scene.view_settings.look = "AgX - Medium High Contrast"

scene.render.filepath = str(OVERVIEW_PATH)
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
bpy.ops.render.render(write_still=True)

start_camp = BLUEPRINT["camps"][BLUEPRINT["startCampId"]]
camera.location = (start_camp["x"] + 35, start_camp["z"] + 26, 34)
camera.data.lens = 54
point_camera(camera, (start_camp["x"], start_camp["z"], start_camp["elevation"] + 0.5))
scene.render.filepath = str(START_PATH)
bpy.ops.render.render(write_still=True)

# Bare-terrain review set. Props are intentionally hidden: each shelter must
# read from geology alone at a shared camera/lens before decoration can help it.
COLLECTIONS["camps"].hide_render = True
COLLECTIONS["landmarks"].hide_render = True
for index, camp in enumerate(BLUEPRINT["camps"]):
    last_x, last_y = camp_local_to_world(camp, camp["approach"][-1])
    direction_x, direction_y = last_x - camp["x"], last_y - camp["z"]
    length = max(0.001, math.hypot(direction_x, direction_y))
    direction_x, direction_y = direction_x / length, direction_y / length
    side_x, side_y = -direction_y, direction_x

    camera.location = (
        camp["x"] + direction_x * 48.0 + side_x * 25.0,
        camp["z"] + direction_y * 48.0 + side_y * 25.0,
        camp["elevation"] + 48.0,
    )
    camera.data.lens = 52
    point_camera(camera, (camp["x"], camp["z"], camp["elevation"] - 0.2))
    scene.render.filepath = str(CAMP_PREVIEW_PATHS[index])
    bpy.ops.render.render(write_still=True)

    camera.location = (
        camp["x"] + direction_x * 52.0 + side_x * 12.0,
        camp["z"] + direction_y * 52.0 + side_y * 12.0,
        terrain_height(camp["x"] + direction_x * 52.0, camp["z"] + direction_y * 52.0) + 13.0,
    )
    camera.data.lens = 50
    point_camera(camera, (camp["x"], camp["z"], camp["elevation"] + 1.2))
    scene.render.filepath = str(LOW_PREVIEW_PATHS[index])
    bpy.ops.render.render(write_still=True)

# Slope and navigation validation use the exact same sampled heightfield as the
# browser. The colors are temporary and restored before saving the .blend.
original_colors = [tuple(item.color) for item in colors.data]
camera.data.type = "ORTHO"
camera.data.ortho_scale = BLUEPRINT["size"] + 6.0
camera.location = (0.0, 0.0, 180.0)
camera.rotation_euler = (0.0, 0.0, 0.0)
scene.render.resolution_x = 1024
scene.render.resolution_y = 1024
for vertex in mesh.vertices:
    slope = terrain_slope(vertex.co.x, vertex.co.y, 0.72)
    amount = smoothstep(0.12, 1.15, slope)
    colors.data[vertex.index].color = (0.12 + amount * 0.78, 0.62 - amount * 0.47, 0.18, 1.0)
scene.render.filepath = str(SLOPE_PATH)
bpy.ops.render.render(write_still=True)

for vertex in mesh.vertices:
    walkable = terrain_slope(vertex.co.x, vertex.co.y, 0.72) <= BLUEPRINT["maxWalkableSlope"]
    colors.data[vertex.index].color = (0.12, 0.52, 0.2, 1.0) if walkable else (0.72, 0.08, 0.06, 1.0)
scene.render.filepath = str(NAV_PATH)
bpy.ops.render.render(write_still=True)

for item, color in zip(colors.data, original_colors):
    item.color = color
camera.data.type = "PERSP"
scene.render.resolution_x = 1280
scene.render.resolution_y = 820
COLLECTIONS["camps"].hide_render = False
COLLECTIONS["landmarks"].hide_render = False
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))

print(f"Saved {BLEND_PATH}")
print(f"Rendered {OVERVIEW_PATH}")
print(f"Rendered {START_PATH}")
