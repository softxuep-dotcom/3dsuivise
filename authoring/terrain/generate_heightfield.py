"""Bake the authoritative terrain heightfield used by both Three.js and Blender.

The spectral-noise, domain-warping and erosion staging is inspired by Daniel
Andrino's MIT-licensed terrain-erosion-3-ways project:
https://github.com/dandrino/terrain-erosion-3-ways

The implementation here is purpose-built for Ember Ridge: three authored ridge
chains and five individually drawn cliff shelters.
"""

from __future__ import annotations

import base64
import json
import math
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates, zoom


ROOT = Path(__file__).resolve().parents[2]
BLUEPRINT_PATH = ROOT / "src" / "game" / "content" / "mapBlueprint.json"
OUTPUT_PATH = ROOT / "src" / "game" / "content" / "terrainHeightfield.json"
WORK_RESOLUTION = 256


def smoothstep(edge0: float, edge1: float, value: np.ndarray) -> np.ndarray:
    amount = np.clip((value - edge0) / max(1e-6, edge1 - edge0), 0.0, 1.0)
    return amount * amount * (3.0 - 2.0 * amount)


def normalize(values: np.ndarray, low: float = -1.0, high: float = 1.0) -> np.ndarray:
    minimum = float(values.min())
    maximum = float(values.max())
    if maximum - minimum < 1e-8:
        return np.full_like(values, (low + high) * 0.5)
    return low + (values - minimum) * (high - low) / (maximum - minimum)


def spectral_noise(shape: tuple[int, int], rng: np.random.Generator, power: float, lower: float, upper: float) -> np.ndarray:
    """Band-limited 1/f noise with *tapered* band edges.

    The band used to be a hard mask (`envelope = 0` outside `lower..upper`).
    A step in the frequency domain convolves the spatial domain with a ringing
    kernel, and that ringing is what produced the long dead-straight ridges
    fanning out across the map -- clearly visible in a slope map as a starburst,
    and on screen as crumpled-foil creases that no desert has.

    Rolling both edges off over roughly an octave keeps the same spectral
    character (same seed, same slope, same feature scale) while removing the
    ringing.
    """
    frequencies = tuple(np.fft.fftfreq(size, d=1.0 / size) for size in shape)
    radial = np.hypot(*np.meshgrid(*frequencies))
    envelope = np.zeros_like(radial)
    positive = radial > 0.0
    envelope[positive] = np.power(radial[positive], power)
    envelope *= smoothstep(lower * 0.5, lower * 1.6, radial)
    envelope *= 1.0 - smoothstep(upper * 0.62, upper, radial)
    phases = np.exp(2j * np.pi * rng.random(shape))
    values = np.real(np.fft.ifft2(np.fft.fft2(phases) * envelope))
    return normalize(values)


def warped_noise(shape: tuple[int, int], rng: np.random.Generator) -> np.ndarray:
    source = spectral_noise(shape, rng, -2.15, 1.2, 42.0)
    warp_x = spectral_noise(shape, rng, -2.0, 1.2, 10.0) * 18.0
    warp_z = spectral_noise(shape, rng, -2.0, 1.2, 10.0) * 18.0
    rows, columns = np.indices(shape, dtype=np.float64)
    return map_coordinates(source, (rows + warp_z, columns + warp_x), order=1, mode="wrap")


def sample_chain_points(points: list[dict], samples_per_segment: int = 9) -> list[dict]:
    """Catmull-Rom sample all ridge attributes to avoid straight escarpments."""
    keys = ("x", "z", "height", "left", "right")
    values = np.asarray([[point[key] for key in keys] for point in points], dtype=np.float64)
    padded = np.vstack((values[0], values, values[-1]))
    result: list[dict] = []
    for index in range(1, len(padded) - 2):
        p0, p1, p2, p3 = padded[index - 1:index + 3]
        for step in range(samples_per_segment):
            t = step / samples_per_segment
            t2, t3 = t * t, t * t * t
            sample = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2*p0 - 5*p1 + 4*p2 - p3) * t2 + (-p0 + 3*p1 - 3*p2 + p3) * t3)
            result.append({key: float(sample[key_index]) for key_index, key in enumerate(keys)})
    result.append(points[-1])
    return result


def ridge_chain_height(terrain: np.ndarray, x_grid: np.ndarray, z_grid: np.ndarray, chain: dict) -> np.ndarray:
    points = sample_chain_points(chain["points"])
    chain_height = np.zeros_like(terrain)
    for start, end in zip(points, points[1:]):
        vx = end["x"] - start["x"]
        vz = end["z"] - start["z"]
        length_squared = max(1e-6, vx * vx + vz * vz)
        amount = np.clip(((x_grid - start["x"]) * vx + (z_grid - start["z"]) * vz) / length_squared, 0.0, 1.0)
        closest_x = start["x"] + vx * amount
        closest_z = start["z"] + vz * amount
        signed_distance = ((x_grid - closest_x) * -vz + (z_grid - closest_z) * vx) / math.sqrt(length_squared)
        left = start["left"] + (end["left"] - start["left"]) * amount
        right = start["right"] + (end["right"] - start["right"]) * amount
        width = np.where(signed_distance >= 0.0, left, right)
        normalized_distance = np.abs(signed_distance) / np.maximum(width, 1.0)
        on_steep_side = signed_distance < 0.0 if chain["steepSide"] == "right" else signed_distance >= 0.0
        gentle_profile = np.power(np.clip(1.0 - smoothstep(0.08, 1.0, normalized_distance), 0.0, 1.0), 1.22)
        if chain.get("edgeProfile", "natural") == "shoulder":
            escarpment_profile = 1.0 - smoothstep(0.5, 0.94, normalized_distance)
            profile = np.where(on_steep_side, escarpment_profile, gentle_profile)
        else:
            asymmetric_profile = np.power(np.clip(1.0 - smoothstep(0.18, 1.0, normalized_distance), 0.0, 1.0), 1.08)
            profile = np.where(on_steep_side, asymmetric_profile, gentle_profile)
        height = start["height"] + (end["height"] - start["height"]) * amount
        chain_height = np.maximum(chain_height, profile * height)
    return chain_height


NEIGHBOUR_OFFSETS = [
    (dz, dx)
    for dz in (-1, 0, 1)
    for dx in (-1, 0, 1)
    if (dz, dx) != (0, 0)
]


def flow_accumulation(height: np.ndarray, exponent: float = 1.15) -> np.ndarray:
    """Multiple-flow-direction accumulation.

    This used to be plain D8: every cell picked its single steepest neighbour
    and handed it the whole catchment. D8's well-known failure mode is that
    drainage can only leave a cell along one of eight fixed bearings, so
    channels snap to 45-degree lines and run dead straight for hundreds of
    cells. `erode` then carved those lines into the surface, and the result was
    the starburst of ruler-straight ridges fanning across the whole map -- very
    obvious in a slope map, and on screen the desert read as crumpled foil.

    Spreading each cell's water over *every* downslope neighbour, weighted by
    slope^exponent, is the standard fix (Freeman 1991). Channels become
    dendritic and the straight-line bias disappears. `exponent` controls how
    focused the channels stay: 1.0 is very diffuse, larger values approach D8.
    """
    rows, columns = height.shape
    flat = height.ravel()
    accumulation = np.ones(rows * columns, dtype=np.float64)
    # 从高到低处理，保证每个格子出水时它自己的汇水量已经收齐。
    for index in np.argsort(flat)[::-1]:
        z, x = divmod(int(index), columns)
        targets: list[int] = []
        weights: list[float] = []
        total = 0.0
        for dz, dx in NEIGHBOUR_OFFSETS:
            nz = z + dz
            nx = x + dx
            if nz < 0 or nz >= rows or nx < 0 or nx >= columns:
                continue
            neighbour = nz * columns + nx
            drop = flat[index] - flat[neighbour]
            if drop <= 0.0:
                continue
            weight = (drop / math.hypot(dx, dz)) ** exponent
            targets.append(neighbour)
            weights.append(weight)
            total += weight
        if total <= 0.0:
            continue
        carried = accumulation[index] / total
        for neighbour, weight in zip(targets, weights):
            accumulation[neighbour] += carried * weight
    return accumulation.reshape(height.shape)


def erode(height: np.ndarray, passes: int = 3) -> np.ndarray:
    result = height.copy()
    for pass_index in range(passes):
        accumulation = flow_accumulation(result)
        gradient_z, gradient_x = np.gradient(result)
        slope = np.hypot(gradient_x, gradient_z)
        flow = np.log1p(accumulation)
        flow = normalize(gaussian_filter(flow, 0.75), 0.0, 1.0)
        channel = flow * smoothstep(0.015, 0.22, slope)
        result -= gaussian_filter(channel, 0.8 + pass_index * 0.15) * (0.34 - pass_index * 0.055)
        smoothed = gaussian_filter(result, 1.05)
        steep = smoothstep(0.22, 0.58, np.hypot(*np.gradient(result)))
        result = result * (1.0 - steep * 0.13) + smoothed * steep * 0.13
    return result


def world_to_local(camp: dict, x_grid: np.ndarray, z_grid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    dx = x_grid - camp["x"]
    dz = z_grid - camp["z"]
    forward_x = math.cos(camp["entranceAngle"])
    forward_z = math.sin(camp["entranceAngle"])
    return -dx * forward_z + dz * forward_x, dx * forward_x + dz * forward_z


def local_to_world(camp: dict, point: dict) -> tuple[float, float]:
    forward_x = math.cos(camp["entranceAngle"])
    forward_z = math.sin(camp["entranceAngle"])
    side_x, side_z = -forward_z, forward_x
    return (
        camp["x"] + side_x * point["x"] + forward_x * point["z"],
        camp["z"] + side_z * point["x"] + forward_z * point["z"],
    )


def host_chain_to_world(camp: dict, host: dict) -> dict:
    points = []
    for point in host["points"]:
        x, z = local_to_world(camp, point)
        points.append({
            "x": x,
            "z": z,
            "height": point["height"],
            "left": point["left"],
            "right": point["right"],
        })
    return {"steepSide": host["steepSide"], "edgeProfile": "shoulder", "points": points}


def polygon_mask_and_distance(x_local: np.ndarray, z_local: np.ndarray, polygon: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    inside = np.zeros_like(x_local, dtype=bool)
    distance = np.full_like(x_local, np.inf)
    for start, end in zip(polygon, polygon[1:] + polygon[:1]):
        x1, z1 = start["x"], start["z"]
        x2, z2 = end["x"], end["z"]
        crosses = ((z1 > z_local) != (z2 > z_local)) & (
            x_local < (x2 - x1) * (z_local - z1) / (z2 - z1 + 1e-9) + x1
        )
        inside ^= crosses
        vx, vz = x2 - x1, z2 - z1
        amount = np.clip(((x_local - x1) * vx + (z_local - z1) * vz) / max(1e-6, vx * vx + vz * vz), 0.0, 1.0)
        closest_x = x1 + vx * amount
        closest_z = z1 + vz * amount
        distance = np.minimum(distance, np.hypot(x_local - closest_x, z_local - closest_z))
    return inside, np.where(inside, -distance, distance)


def catmull_rom(points: list[tuple[float, float]], samples_per_segment: int = 14) -> np.ndarray:
    values = np.asarray(points, dtype=np.float64)
    padded = np.vstack((values[0], values, values[-1]))
    result: list[np.ndarray] = []
    for index in range(1, len(padded) - 2):
        p0, p1, p2, p3 = padded[index - 1:index + 3]
        for step in range(samples_per_segment):
            t = step / samples_per_segment
            t2, t3 = t * t, t * t * t
            result.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2*p0 - 5*p1 + 4*p2 - p3) * t2 + (-p0 + 3*p1 - 3*p2 + p3) * t3))
    result.append(values[-1])
    return np.asarray(result)


def path_distance_and_progress(x_grid: np.ndarray, z_grid: np.ndarray, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    distance = np.full_like(x_grid, np.inf)
    progress = np.zeros_like(x_grid)
    segment_count = len(points) - 1
    for index, (start, end) in enumerate(zip(points, points[1:])):
        vx, vz = end - start
        length_squared = max(1e-6, vx * vx + vz * vz)
        amount = np.clip(((x_grid - start[0]) * vx + (z_grid - start[1]) * vz) / length_squared, 0.0, 1.0)
        closest_x = start[0] + vx * amount
        closest_z = start[1] + vz * amount
        candidate = np.hypot(x_grid - closest_x, z_grid - closest_z)
        better = candidate < distance
        distance[better] = candidate[better]
        progress[better] = (index + amount[better]) / segment_count
    return distance, progress


def polyline_distance_and_side(x_grid: np.ndarray, z_grid: np.ndarray, points: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    """Return nearest distance and signed side (positive is segment-left)."""
    distance = np.full_like(x_grid, np.inf)
    signed_side = np.zeros_like(x_grid)
    for start, end in zip(points, points[1:]):
        vx, vz = end["x"] - start["x"], end["z"] - start["z"]
        length = max(1e-6, math.hypot(vx, vz))
        amount = np.clip(((x_grid - start["x"]) * vx + (z_grid - start["z"]) * vz) / (length * length), 0.0, 1.0)
        closest_x = start["x"] + vx * amount
        closest_z = start["z"] + vz * amount
        delta_x, delta_z = x_grid - closest_x, z_grid - closest_z
        candidate = np.hypot(delta_x, delta_z)
        better = candidate < distance
        distance[better] = candidate[better]
        signed_side[better] = ((-vz * delta_x + vx * delta_z) / length)[better]
    return distance, signed_side


def shelter_platform_height(camp: dict, local_x: np.ndarray, local_z: np.ndarray, micro: np.ndarray) -> np.ndarray:
    style = camp["terrainStyle"]
    elevation = camp["elevation"]
    if style == "broken-spur":
        # A narrow rock spur that falls gently toward its pointed nose.
        feature = local_z * 0.028 - local_x * 0.014
    elif style == "saddle-shoulder":
        # A shallow cross-saddle: the flanks sit higher than the central lane.
        feature = np.square(local_x / 14.0) * 0.48 - np.square(local_z / 17.0) * 0.12
    elif style == "cliff-alcove":
        # A sheltered apron cut into a taller rear cliff.
        feature = smoothstep(1.0, 11.0, -local_z) * 0.46 - local_x * 0.008
    elif style == "wide-ledge":
        # An L-shaped shelf with a readable half-metre upper bench.
        feature = smoothstep(-1.5, 1.5, -local_z) * 0.58 + local_x * 0.009
    elif style == "wind-crown":
        # The upper crown is a separate floor patch; keep the lower bench
        # subtly pitched so it still reads as exposed terrain.
        feature = -local_z * 0.012 + np.clip(local_x / 18.0, -1.0, 1.0) * 0.12
    else:
        raise ValueError(f"Unknown terrain style: {style}")
    return elevation + feature + micro


def ramp_profile(style: str, progress: np.ndarray) -> np.ndarray:
    if style == "broken-spur":
        return np.power(smoothstep(0.07, 0.96, progress), 0.82)
    if style == "saddle-shoulder":
        return smoothstep(0.08, 0.92, progress)
    if style == "cliff-alcove":
        return np.power(smoothstep(0.04, 0.99, progress), 1.08)
    if style == "wide-ledge":
        return smoothstep(0.05, 0.48, progress) * 0.53 + smoothstep(0.61, 0.98, progress) * 0.47
    if style == "wind-crown":
        first = smoothstep(0.04, 0.32, progress) * 0.36
        second = smoothstep(0.43, 0.69, progress) * 0.34
        third = smoothstep(0.79, 0.98, progress) * 0.30
        return first + second + third
    raise ValueError(f"Unknown terrain style: {style}")


def sample_nearest(field: np.ndarray, x_grid: np.ndarray, z_grid: np.ndarray, x: float, z: float) -> float:
    row, column = np.unravel_index(np.argmin(np.square(x_grid - x) + np.square(z_grid - z)), field.shape)
    return float(field[row, column])


def shape_dens(terrain: np.ndarray, x_grid: np.ndarray, z_grid: np.ndarray, dens: list[dict], rng: np.random.Generator) -> np.ndarray:
    """Raise an earth mound with a hollow centre and one walkable mouth.

    The silhouette has to do two jobs at once from a high isometric camera:
    read as "something lives in there" from 50 m away, and stay walkable at the
    mouth so the pack can actually stream out of it. So the rim is a ring
    (raised), the middle is a shallow bowl (sunken), and a wedge of the ring
    facing ``mouthAngle`` is left flat at the surrounding ground height.
    """
    result = terrain.copy()
    micro = gaussian_filter(rng.normal(0.0, 1.0, terrain.shape), 1.1)
    micro = normalize(micro) * 0.12
    for den in dens:
        dx = x_grid - den["x"]
        dz = z_grid - den["z"]
        radius = np.hypot(dx, dz)
        outer = den["radius"]

        # Ring profile: peaks partway out, falls to nothing at the outer edge so
        # the mound blends into the plain instead of ending on a cliff.
        rim = np.sin(np.clip(radius / outer, 0.0, 1.0) * np.pi) ** 1.4
        # Bowl: only the inner half, so the floor sits below the surrounding ground.
        # NOTE: this module's smoothstep clamps the divisor to max(1e-6, edge1 - edge0),
        # so it does NOT support descending edges — a reversed pair silently degrades
        # into a step function pointing the wrong way. Always go ascending + (1.0 - x).
        hollow = 1.0 - smoothstep(0.0, outer * 0.55, radius)

        # The mouth is a wedge around mouthAngle, widened by mouthWidth at the rim.
        angle = np.arctan2(dz, dx)
        delta = np.abs(np.arctan2(np.sin(angle - den["mouthAngle"]), np.cos(angle - den["mouthAngle"])))
        half_wedge = np.arctan2(den["mouthWidth"] * 0.5, max(1.0, outer * 0.7))
        mouth = 1.0 - smoothstep(half_wedge, half_wedge * 2.1, delta)

        raise_amount = rim * den["rimHeight"] * (1.0 - mouth)
        sink_amount = hollow * den["hollowDepth"] * (1.0 - mouth * 0.75)
        shell = 1.0 - smoothstep(outer * 0.9, outer * 1.35, radius)
        result += (raise_amount - sink_amount + micro * shell) * shell

        # Bake a broad, level combat apron around the three guarded barrels.
        #
        # The barrels sit 12 m down the mouth axis. Before this pass the den rim
        # and the underlying ridge left several 2-4 m ledges within melee range:
        # the player could stand on one side, hit the guards below, and remain
        # unreachable. Flattening only the mouth-facing ellipse keeps the den's
        # rear silhouette while ensuring both sides of the fight share one floor.
        forward = dx * math.cos(den["mouthAngle"]) + dz * math.sin(den["mouthAngle"])
        lateral = -dx * math.sin(den["mouthAngle"]) + dz * math.cos(den["mouthAngle"])
        apron_center = outer + 4.0
        apron_distance = np.hypot((forward - apron_center) / 12.0, lateral / 11.0)
        apron = 1.0 - smoothstep(0.62, 1.0, apron_distance)
        # Do not flatten the back or sides of the mound; open only the mouth side.
        apron *= smoothstep(outer * 0.55, outer * 0.95, forward)
        apron_height = sample_nearest(
            terrain,
            x_grid,
            z_grid,
            den["x"] + math.cos(den["mouthAngle"]) * apron_center,
            den["z"] + math.sin(den["mouthAngle"]) * apron_center,
        )
        apron_target = apron_height + micro * 0.05
        result = result * (1.0 - apron) + apron_target * apron
    return result


def shape_shelters(terrain: np.ndarray, x_grid: np.ndarray, z_grid: np.ndarray, camps: list[dict], rng: np.random.Generator) -> np.ndarray:
    original = terrain.copy()
    result = terrain.copy()
    micro = gaussian_filter(rng.normal(0.0, 1.0, terrain.shape), 1.35)
    micro = normalize(micro) * 0.09
    for camp in camps:
        local_x, local_z = world_to_local(camp, x_grid, z_grid)
        _inside, signed_distance = polygon_mask_and_distance(local_x, local_z, camp["platform"])

        world_points = [local_to_world(camp, point) for point in camp["approach"]]
        curve = catmull_rom(world_points, samples_per_segment=18)
        path_distance, progress = path_distance_and_progress(x_grid, z_grid, curve)

        # Only compress the interior floor into the host ridge. Outside ground
        # remains untouched; cliff relief must come from the continuous host
        # shoulder, never from a local trench around the camp.
        platform_blend = 1.0 - smoothstep(-0.9, 2.15, signed_distance)
        platform_target = shelter_platform_height(camp, local_x, local_z, micro)
        result = result * (1.0 - platform_blend) + platform_target * platform_blend

        if "upperPlatform" in camp:
            _upper_inside, upper_signed_distance = polygon_mask_and_distance(local_x, local_z, camp["upperPlatform"])
            upper_blend = 1.0 - smoothstep(-0.75, 1.55, upper_signed_distance)
            upper_target = camp["elevation"] + 1.05 + micro * 0.55
            result = result * (1.0 - upper_blend) + upper_target * upper_blend

        # Cut the sole walkable route back through the protected perimeter.
        # Each style owns a different vertical rhythm (S-ramp, saddle dogleg,
        # cleft, traversing shelf or three-stage switchback).
        outer_x, outer_z = world_points[-1]
        outer_height = sample_nearest(original, x_grid, z_grid, outer_x, outer_z)
        descent = ramp_profile(camp["terrainStyle"], progress)
        inner_height = shelter_platform_height(camp, local_x, local_z, micro)
        ramp_target = inner_height * (1.0 - descent) + outer_height * descent

        # The ramp tapers: a narrow pinch where it pierces the perimeter (so a
        # single boulder still seals the camp) opening into a wide apron on the
        # way down. A constant-width ramp reads as a slot milled into the ridge,
        # and because the runtime slope test samples ±0.7 around the player it
        # also rejected movement the moment you drifted off the centre line —
        # the walkable lane was only 0.7-2.0m wide against a 1.44m player.
        gate_half = camp["gateGap"] * 0.5 + 0.55
        outer_half = camp["approachWidth"] * 0.5
        widen = smoothstep(0.06, 0.42, progress)
        half_width = gate_half + (outer_half - gate_half) * widen
        # Graded shoulders instead of walls: this is what actually buys walkable
        # width, because it drops the lateral gradient below maxWalkableSlope.
        shoulder = 1.35 + 2.55 * widen
        # smoothstep() takes scalar edges; here they vary per cell, so inline it.
        edge = np.clip((path_distance - half_width) / np.maximum(1e-6, shoulder), 0.0, 1.0)
        path_blend = 1.0 - edge * edge * (3.0 - 2.0 * edge)
        result = result * (1.0 - path_blend) + ramp_target * path_blend
    return result


def main() -> None:
    with BLUEPRINT_PATH.open("r", encoding="utf-8") as handle:
        blueprint = json.load(handle)
    rng = np.random.default_rng(blueprint["seed"])
    shape = (WORK_RESOLUTION + 1, WORK_RESOLUTION + 1)
    extent = blueprint["size"] * 0.5
    coordinates = np.linspace(-extent, extent, WORK_RESOLUTION + 1)
    x_grid, z_grid = np.meshgrid(coordinates, coordinates)

    macro = spectral_noise(shape, rng, -2.35, 0.8, 8.0)
    ridged = 1.0 - np.abs(spectral_noise(shape, rng, -1.75, 1.4, 24.0))
    terrain = warped_noise(shape, rng) * 1.4 + macro * 0.85 + (ridged - 0.5) * 0.9
    ridge_layer = np.zeros_like(terrain)
    for chain in blueprint["ridgeChains"]:
        ridge_layer = np.maximum(ridge_layer, ridge_chain_height(terrain, x_grid, z_grid, chain))
    for camp in blueprint["camps"]:
        for host in camp["hostShoulders"]:
            ridge_layer = np.maximum(ridge_layer, ridge_chain_height(terrain, x_grid, z_grid, host_chain_to_world(camp, host)))
    terrain += ridge_layer
    terrain = erode(terrain)
    terrain = shape_shelters(terrain, x_grid, z_grid, blueprint["camps"], rng)
    # 狗巢在营地之后刻：它离任何一座营地都在 22 米以上，不会互相压。
    terrain = shape_dens(terrain, x_grid, z_grid, blueprint.get("dens", []), rng)

    output_resolution = blueprint["resolution"]
    if output_resolution != WORK_RESOLUTION:
        scale = (output_resolution + 1) / (WORK_RESOLUTION + 1)
        terrain = zoom(terrain, scale, order=3)
        terrain = terrain[:output_resolution + 1, :output_resolution + 1]

    minimum = float(terrain.min())
    maximum = float(terrain.max())
    quantized = np.round((terrain - minimum) / max(1e-8, maximum - minimum) * 65535.0).astype("<u2")
    payload = {
        "size": blueprint["size"],
        "resolution": output_resolution,
        "minHeight": round(minimum, 6),
        "maxHeight": round(maximum, 6),
        "encoding": "uint16-le-base64",
        "source": "Authored ridge splines with domain-warped spectral noise and offline erosion",
        "data": base64.b64encode(quantized.tobytes()).decode("ascii"),
    }
    with OUTPUT_PATH.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.write("\n")
    print(f"Wrote {OUTPUT_PATH} ({quantized.shape[1]}x{quantized.shape[0]}, {minimum:.2f}..{maximum:.2f}m)")


if __name__ == "__main__":
    main()
