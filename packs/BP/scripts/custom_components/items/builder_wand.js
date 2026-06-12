import { system, world } from "@minecraft/server";

const COOLDOWN_GROUP = "builder_wand";
const DEFAULT_MAX_PLACEMENTS = 64;
const HARD_MAX_PLACEMENTS = 512;
const USE_COOLDOWN_TICKS = 6;
const WAND_COMPONENT_ID = "builder_wands:builder_wand";
const OUTLINE_ENTITY_ID = "builder_wands:builder_wand_outline";
const PREVIEW_PROPERTY = "builder_wands:preview_enabled";
const PREVIEW_MODE_PROPERTY = "builder_wands:preview_mode";
const PREVIEW_MODE_FULL = "full";
const PREVIEW_MODE_SMART = "smart";
const OUTLINE_UPDATE_TICKS = 10;
const BLOCKLIST_TAG = "builder_wands:builder_wand_blocked";
const DIMENSION_IDS = ["overworld", "nether", "the_end"];
const DEFAULT_ENTITY_WIDTH = 0.6;
const DEFAULT_ENTITY_HEIGHT = 1.8;
const COLLISION_EPSILON = 0.0001;

const NEVER_COPY_BLOCKS = new Set([
  "minecraft:bee_nest",
  "minecraft:beehive"
]);

const FACE_NORMALS = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 }
};

const handledTickByPlayerId = new Map();
const activeOutlinesByPlayerId = new Map();

const OUTLINE_EDGE_PROPERTIES = [
  "builder_wands:edge_x_y0_z0",
  "builder_wands:edge_x_y0_z1",
  "builder_wands:edge_x_y1_z0",
  "builder_wands:edge_x_y1_z1",
  "builder_wands:edge_y_x0_z0",
  "builder_wands:edge_y_x0_z1",
  "builder_wands:edge_y_x1_z0",
  "builder_wands:edge_y_x1_z1",
  "builder_wands:edge_z_x0_y0",
  "builder_wands:edge_z_x0_y1",
  "builder_wands:edge_z_x1_y0",
  "builder_wands:edge_z_x1_y1"
];

const OUTLINE_EDGE_DEFS = [
  { property: "builder_wands:edge_x_y0_z0", axis: "x", ySide: 0, zSide: 1 },
  { property: "builder_wands:edge_x_y0_z1", axis: "x", ySide: 0, zSide: 0 },
  { property: "builder_wands:edge_x_y1_z0", axis: "x", ySide: 1, zSide: 1 },
  { property: "builder_wands:edge_x_y1_z1", axis: "x", ySide: 1, zSide: 0 },
  { property: "builder_wands:edge_y_x0_z0", axis: "y", xSide: 0, zSide: 1 },
  { property: "builder_wands:edge_y_x0_z1", axis: "y", xSide: 0, zSide: 0 },
  { property: "builder_wands:edge_y_x1_z0", axis: "y", xSide: 1, zSide: 1 },
  { property: "builder_wands:edge_y_x1_z1", axis: "y", xSide: 1, zSide: 0 },
  { property: "builder_wands:edge_z_x0_y0", axis: "z", xSide: 0, ySide: 0 },
  { property: "builder_wands:edge_z_x0_y1", axis: "z", xSide: 0, ySide: 1 },
  { property: "builder_wands:edge_z_x1_y0", axis: "z", xSide: 1, ySide: 0 },
  { property: "builder_wands:edge_z_x1_y1", axis: "z", xSide: 1, ySide: 1 }
];

/**
 * Reads a block defensively, since unloaded chunks and world-height limits can
 * throw from dimension.getBlock.
 *
 * @param {import("@minecraft/server").Dimension} dimension Dimension to read from.
 * @param {{x: number, y: number, z: number}} location Block location.
 * @returns {import("@minecraft/server").Block|undefined} The block, when accessible.
 */
function safeBlockAt(dimension, location) {
  try {
    return dimension.getBlock(location);
  } catch {
    return undefined;
  }
}

/**
 * Checks whether an entity-like object can still be used by the script.
 *
 * @param {unknown} target Entity-like object.
 * @returns {boolean} True when the object is still valid.
 */
function isLiveObject(target) {
  try {
    return typeof target?.isValid === "function" ? target.isValid() : !!target?.isValid;
  } catch {
    return false;
  }
}

/**
 * @param {import("@minecraft/server").Player} player Player using the wand.
 * @returns {boolean} Whether inventory costs should be skipped.
 */
function isCreativePlayer(player) {
  try {
    return String(player.getGameMode?.() ?? "").toLowerCase() === "creative";
  } catch {
    return false;
  }
}

/**
 * Gets the player's inventory container while tolerating component failures.
 *
 * @param {import("@minecraft/server").Player} player Player to inspect.
 * @returns {import("@minecraft/server").Container|undefined} Inventory container.
 */
function getInventory(player) {
  try {
    return player.getComponent("minecraft:inventory")?.container;
  } catch {
    return undefined;
  }
}

/**
 * Gets the currently selected item stack.
 *
 * @param {import("@minecraft/server").Player} player Player to inspect.
 * @returns {import("@minecraft/server").ItemStack|undefined} Held item.
 */
function getHeldItem(player) {
  const inventory = getInventory(player);
  if (!inventory) return undefined;

  try {
    return inventory.getItem(player.selectedSlotIndex ?? 0);
  } catch {
    return undefined;
  }
}

/**
 * Counts every stack matching a type id in a container.
 *
 * @param {import("@minecraft/server").Container|undefined} container Inventory container.
 * @param {string} typeId Item type to count.
 * @returns {number} Total matching item amount.
 */
function countItems(container, typeId) {
  if (!container) return 0;

  let total = 0;
  for (let slot = 0; slot < container.size; slot++) {
    const stack = container.getItem(slot);
    if (stack?.typeId === typeId) total += stack.amount;
  }

  return total;
}

/**
 * Removes one matching item from the first compatible stack.
 *
 * @param {import("@minecraft/server").Container|undefined} container Inventory container.
 * @param {string} typeId Item type to remove.
 * @returns {boolean} True when one item was consumed.
 */
function takeOneItem(container, typeId) {
  if (!container) return false;

  for (let slot = 0; slot < container.size; slot++) {
    const stack = container.getItem(slot);
    if (stack?.typeId !== typeId) continue;

    if (stack.amount <= 1) {
      container.setItem(slot, undefined);
    } else {
      stack.amount -= 1;
      container.setItem(slot, stack);
    }

    return true;
  }

  return false;
}

/**
 * Decides whether a source block can be copied and whether a target block can
 * be overwritten by the wand.
 *
 * @param {import("@minecraft/server").Block|undefined} block Block to inspect.
 * @param {"source"|"target"} mode Validation mode.
 * @returns {boolean} Whether the block passes the requested validation.
 */
function isUsableBlock(block, mode) {
  if (!block) return false;

  const isAir = block.isAir !== undefined
    ? block.isAir
    : block.typeId === "minecraft:air" ||
      block.typeId === "minecraft:cave_air" ||
      block.typeId === "minecraft:void_air";
  const isFluid = block.typeId === "minecraft:water" || block.typeId === "minecraft:lava";

  if (mode === "target") return isAir || isFluid;
  if (isAir || isFluid) return false;
  if (NEVER_COPY_BLOCKS.has(block.typeId) || block.typeId?.includes("shulker")) return false;

  try {
    if (block.hasTag?.(BLOCKLIST_TAG)) return false;
  } catch {}

  try {
    if (block.permutation?.hasTag?.(BLOCKLIST_TAG)) return false;
  } catch {}

  return true;
}

/**
 * Sends short player feedback without relying on one Bedrock API generation.
 *
 * @param {import("@minecraft/server").Player} player Target player.
 * @param {string} text Message to show.
 */
function showHint(player, text) {
  try {
    player.onScreenDisplay?.setActionBar?.(text);
    return;
  } catch {}

  try {
    player.setActionBar?.(text);
  } catch {}
}

/**
 * @param {import("@minecraft/server").Player} player Target player.
 * @param {string} soundId Bedrock sound id.
 * @param {number} [pitch=1] Playback pitch.
 */
function playUseSound(player, soundId, pitch = 1) {
  try {
    player.playSound(soundId, { volume: 0.7, pitch });
  } catch {}
}

/**
 * Damages the currently held wand once after a successful activation.
 *
 * @param {import("@minecraft/server").Player} player Player holding the wand.
 * @returns {boolean} True when the wand broke.
 */
function damageHeldWand(player) {
  if (isCreativePlayer(player)) return false;

  const inventory = getInventory(player);
  if (!inventory) return false;

  const slot = player.selectedSlotIndex ?? 0;
  const itemStack = inventory.getItem(slot);
  const durability = itemStack?.getComponent?.("minecraft:durability");
  if (!durability) return false;

  const nextDamage = durability.damage + 1;
  if (nextDamage >= durability.maxDurability) {
    inventory.setItem(slot, undefined);
    clearPlayerOutline(player.id);
    playUseSound(player, "random.break", 1);
    return true;
  }

  durability.damage = nextDamage;
  inventory.setItem(slot, itemStack);
  return false;
}

/**
 * Reads item-component v2 parameters from JSON and normalizes them into safe
 * runtime settings.
 *
 * @param {{max_placements?: unknown, maxPlacements?: unknown}|undefined} params Component params.
 * @returns {{maxPlacements: number}} Normalized wand settings.
 */
function readWandSettings(params) {
  const rawMaxPlacements = params?.max_placements ?? params?.maxPlacements;
  const maxPlacements = Math.floor(Number(rawMaxPlacements ?? DEFAULT_MAX_PLACEMENTS));

  return {
    maxPlacements: Number.isFinite(maxPlacements)
      ? Math.min(HARD_MAX_PLACEMENTS, Math.max(1, maxPlacements))
      : DEFAULT_MAX_PLACEMENTS
  };
}

/**
 * Gets the builder wand component from an item stack, if present.
 *
 * @param {import("@minecraft/server").ItemStack|undefined} itemStack Held item.
 * @returns {import("@minecraft/server").ItemCustomComponentInstance|undefined} Builder wand component.
 */
function getWandComponent(itemStack) {
  try {
    return itemStack?.getComponent?.(WAND_COMPONENT_ID);
  } catch {
    return undefined;
  }
}

/**
 * Reads the configured placement limit from the wand item currently in hand.
 *
 * @param {import("@minecraft/server").Player} player Player to inspect.
 * @returns {{maxPlacements: number}|undefined} Wand settings, if holding a wand.
 */
function readHeldWandSettings(player) {
  const itemStack = getHeldItem(player);
  const component = getWandComponent(itemStack);
  if (!component) return undefined;

  return readWandSettings(component.customComponentParameters?.params);
}

/**
 * Prevents the wand from placing blocks in cells occupied by entities.
 *
 * @param {import("@minecraft/server").Player} player Player using the wand.
 * @param {{targetBlock: import("@minecraft/server").Block}[]} plan Planned placements.
 * @returns {boolean} True when an entity blocks the planned area.
 */
function hasBlockedCell(player, plan) {
  if (!plan.length) return false;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const { targetBlock } of plan) {
    const { x, y, z } = targetBlock.location;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  let nearby = [];
  try {
    nearby = player.dimension.getEntities({
      location: { x: minX - 1, y: minY - 2, z: minZ - 1 },
      volume: {
        x: maxX - minX + 3,
        y: maxY - minY + 4,
        z: maxZ - minZ + 3
      },
      excludeFamilies: ["inanimate"]
    });
  } catch {
    return false;
  }

  for (const entity of nearby) {
    if (!isLiveObject(entity)) continue;

    try {
      const families = entity.getComponent("minecraft:type_family");
      if (families?.hasTypeFamily?.("inanimate")) continue;
    } catch {}

    const location = entity.location;
    if (!location) continue;

    let width = DEFAULT_ENTITY_WIDTH;
    let height = DEFAULT_ENTITY_HEIGHT;
    try {
      const collision = entity.getComponent("minecraft:collision_box");
      if (Number.isFinite(collision?.width)) width = Math.max(0, collision.width);
      if (Number.isFinite(collision?.height)) height = Math.max(0, collision.height);
    } catch {}

    const half = width / 2;
    const entityBox = {
      minX: location.x - half,
      maxX: location.x + half,
      minY: location.y,
      maxY: location.y + height,
      minZ: location.z - half,
      maxZ: location.z + half
    };

    for (const { targetBlock } of plan) {
      const { x, y, z } = targetBlock.location;
      const touchesBlock =
        entityBox.maxX > x + COLLISION_EPSILON &&
        entityBox.minX < x + 1 - COLLISION_EPSILON &&
        entityBox.maxY > y + COLLISION_EPSILON &&
        entityBox.minY < y + 1 - COLLISION_EPSILON &&
        entityBox.maxZ > z + COLLISION_EPSILON &&
        entityBox.minZ < z + 1 - COLLISION_EPSILON;

      if (touchesBlock) return true;
    }
  }

  return false;
}

/**
 * Chooses the two axes that lie flat on the clicked block face.
 *
 * @param {{x: number, y: number, z: number}} normal Clicked face normal.
 * @returns {[{x: number, y: number, z: number}, {x: number, y: number, z: number}]} Plane axes.
 */
function planeAxesFor(normal) {
  if (normal.y !== 0) {
    return [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 }
    ];
  }

  if (normal.x !== 0) {
    return [
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 }
    ];
  }

  return [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 }
  ];
}

/**
 * Sorts offsets so the patch grows from the clicked block outward.
 *
 * @param {{u: number, v: number}} a First offset.
 * @param {{u: number, v: number}} b Second offset.
 * @returns {number} Sort comparison.
 */
function sortByBuildOrder(a, b) {
  const aRing = Math.max(Math.abs(a.u), Math.abs(a.v));
  const bRing = Math.max(Math.abs(b.u), Math.abs(b.v));
  if (aRing !== bRing) return aRing - bRing;

  const aWalk = Math.abs(a.u) + Math.abs(a.v);
  const bWalk = Math.abs(b.u) + Math.abs(b.v);
  if (aWalk !== bWalk) return aWalk - bWalk;

  if (a.u !== b.u) return a.u - b.u;
  return a.v - b.v;
}

/**
 * Resolves one plane offset into the source block and adjacent target block.
 *
 * @param {import("@minecraft/server").Block} originBlock Clicked block.
 * @param {{x: number, y: number, z: number}} faceNormal Clicked face normal.
 * @param {[{x: number, y: number, z: number}, {x: number, y: number, z: number}]} axes Plane axes.
 * @param {string} sourceTypeId Block type that must be copied.
 * @param {{u: number, v: number}} offset Plane offset.
 * @returns {{sourceBlock: import("@minecraft/server").Block, targetBlock: import("@minecraft/server").Block}|undefined} Placement pair.
 */
function placementAt(originBlock, faceNormal, axes, sourceTypeId, offset) {
  const [uAxis, vAxis] = axes;
  const sourceLocation = {
    x: originBlock.location.x + uAxis.x * offset.u + vAxis.x * offset.v,
    y: originBlock.location.y + uAxis.y * offset.u + vAxis.y * offset.v,
    z: originBlock.location.z + uAxis.z * offset.u + vAxis.z * offset.v
  };

  const sourceBlock = safeBlockAt(originBlock.dimension, sourceLocation);
  if (sourceBlock?.typeId !== sourceTypeId || !isUsableBlock(sourceBlock, "source")) return undefined;

  const targetBlock = safeBlockAt(originBlock.dimension, {
    x: sourceLocation.x + faceNormal.x,
    y: sourceLocation.y + faceNormal.y,
    z: sourceLocation.z + faceNormal.z
  });
  if (!isUsableBlock(targetBlock, "target")) return undefined;

  return { sourceBlock, targetBlock };
}

/**
 * Builds a connected list of offsets that preserve the wand's main feel:
 * start near the clicked block, keep same-type connectivity, then expand up to
 * the maximum allowed count.
 *
 * @param {import("@minecraft/server").Block} originBlock Clicked block.
 * @param {{x: number, y: number, z: number}} faceNormal Clicked face normal.
 * @param {number} limit Maximum placements.
 * @returns {{u: number, v: number}[]} Ordered offsets to place.
 */
function collectConnectedOffsets(originBlock, faceNormal, limit) {
  const axes = planeAxesFor(faceNormal);
  const sourceTypeId = originBlock.typeId;
  const gridSide = Math.max(1, Math.floor(Math.sqrt(limit)));
  const low = -Math.floor((gridSide - 1) / 2);
  const high = Math.ceil((gridSide - 1) / 2);
  const square = [];
  const usable = new Map();

  for (let u = low; u <= high; u++) {
    for (let v = low; v <= high; v++) {
      const offset = { u, v };
      square.push(offset);
      if (placementAt(originBlock, faceNormal, axes, sourceTypeId, offset)) {
        usable.set(`${u},${v}`, offset);
      }
    }
  }
  square.sort(sortByBuildOrder);

  const accepted = [];
  const acceptedKeys = new Set();
  const pending = [{ u: 0, v: 0 }];
  const pendingKeys = new Set(["0,0"]);

  function enqueueNeighbors(offset) {
    const neighbors = [
      { u: offset.u + 1, v: offset.v },
      { u: offset.u - 1, v: offset.v },
      { u: offset.u, v: offset.v + 1 },
      { u: offset.u, v: offset.v - 1 }
    ];

    for (const neighbor of neighbors) {
      const key = `${neighbor.u},${neighbor.v}`;
      if (acceptedKeys.has(key) || pendingKeys.has(key)) continue;

      const knownSquareOffset = usable.get(key);
      if (knownSquareOffset) {
        pending.push(knownSquareOffset);
        pendingKeys.add(key);
        continue;
      }

      if (!placementAt(originBlock, faceNormal, axes, sourceTypeId, neighbor)) continue;
      pending.push(neighbor);
      pendingKeys.add(key);
    }
  }

  while (pending.length && accepted.length < limit) {
    pending.sort(sortByBuildOrder);

    const offset = pending.shift();
    const key = `${offset.u},${offset.v}`;
    if (acceptedKeys.has(key)) continue;

    const inSeedSquare = usable.has(key) || square.some((squareOffset) => squareOffset.u === offset.u && squareOffset.v === offset.v);
    if (inSeedSquare && !usable.has(key)) continue;
    if (!inSeedSquare && !placementAt(originBlock, faceNormal, axes, sourceTypeId, offset)) continue;

    accepted.push(offset);
    acceptedKeys.add(key);
    enqueueNeighbors(offset);
  }

  return accepted;
}

/**
 * Converts the final offset list into source/target block pairs.
 *
 * @param {import("@minecraft/server").Block} originBlock Clicked block.
 * @param {{x: number, y: number, z: number}} faceNormal Clicked face normal.
 * @param {number} limit Maximum placements.
 * @returns {{sourceBlock: import("@minecraft/server").Block, targetBlock: import("@minecraft/server").Block}[]} Placement plan.
 */
function planPlacements(originBlock, faceNormal, limit) {
  const axes = planeAxesFor(faceNormal);
  const sourceTypeId = originBlock.typeId;
  const plan = [];

  for (const offset of collectConnectedOffsets(originBlock, faceNormal, limit)) {
    const placement = placementAt(originBlock, faceNormal, axes, sourceTypeId, offset);
    if (placement) plan.push(placement);
    if (plan.length >= limit) break;
  }

  return plan;
}

/**
 * @param {{x: number, y: number, z: number}} location Block location.
 * @returns {string} Stable block location key.
 */
function blockKey(location) {
  return `${location.x},${location.y},${location.z}`;
}

/**
 * Reads the player's preview rendering mode.
 *
 * @param {import("@minecraft/server").Player} player Player to inspect.
 * @returns {string} Preview mode id.
 */
function getPreviewMode(player) {
  return player.getDynamicProperty(PREVIEW_MODE_PROPERTY) === PREVIEW_MODE_SMART
    ? PREVIEW_MODE_SMART
    : PREVIEW_MODE_FULL;
}

/**
 * Removes one preview entity safely.
 *
 * @param {import("@minecraft/server").Entity|undefined} entity Entity to remove.
 */
function removeOutlineEntity(entity) {
  try {
    if (isLiveObject(entity)) entity.remove();
  } catch {}
}

/**
 * Clears all preview entities owned by one player.
 *
 * @param {string} playerId Player id.
 */
function clearPlayerOutline(playerId) {
  const outline = activeOutlinesByPlayerId.get(playerId);
  if (!outline) return;

  for (const entity of outline.entities) removeOutlineEntity(entity);
  activeOutlinesByPlayerId.delete(playerId);
}

/**
 * Clears previews for players who left the world.
 *
 * @param {Set<string>} activePlayerIds Current player ids.
 */
function clearOfflineOutlines(activePlayerIds) {
  for (const playerId of activeOutlinesByPlayerId.keys()) {
    if (!activePlayerIds.has(playerId)) clearPlayerOutline(playerId);
  }
}

/**
 * Removes any leftover outline entities after reload.
 */
function cleanupOutlineEntities() {
  for (const dimensionId of DIMENSION_IDS) {
    try {
      const dimension = world.getDimension(dimensionId);
      for (const entity of dimension.getEntities({ type: OUTLINE_ENTITY_ID })) {
        removeOutlineEntity(entity);
      }
    } catch {}
  }

  activeOutlinesByPlayerId.clear();
}

/**
 * Collects all outline entity IDs that are still owned by this script run.
 *
 * @returns {Set<string>} Currently tracked outline entity ids.
 */
function getTrackedOutlineEntityIds() {
  const trackedIds = new Set();

  for (const outline of activeOutlinesByPlayerId.values()) {
    for (const entity of outline.entities) {
      if (!isLiveObject(entity)) continue;

      try {
        trackedIds.add(entity.id);
      } catch {}
    }
  }

  return trackedIds;
}

/**
 * Removes loaded outline entities that survived a script reload and no longer
 * belong to any active preview tracked in memory.
 */
function cleanupOrphanedOutlineEntities() {
  const trackedIds = getTrackedOutlineEntityIds();

  for (const dimensionId of DIMENSION_IDS) {
    try {
      const dimension = world.getDimension(dimensionId);
      for (const entity of dimension.getEntities({ type: OUTLINE_ENTITY_ID })) {
        if (trackedIds.has(entity.id)) continue;
        removeOutlineEntity(entity);
      }
    } catch {}
  }
}

/**
 * Gets the blocks currently targeted by the held Builder Wand preview.
 *
 * @param {import("@minecraft/server").Player} player Player to inspect.
 * @returns {import("@minecraft/server").Block[]} Target blocks to outline.
 */
function getPreviewBlocks(player) {
  const settings = readHeldWandSettings(player);
  if (!settings) return [];

  let hit;
  try {
    hit = player.getBlockFromViewDirection({
      maxDistance: 8,
      includeLiquidBlocks: false,
      includePassableBlocks: false
    });
  } catch {
    return [];
  }

  const faceNormal = FACE_NORMALS[String(hit?.face ?? "").toLowerCase()];
  if (!hit?.block || !faceNormal) return [];

  const creative = isCreativePlayer(player);
  const inventory = getInventory(player);
  const available = creative ? settings.maxPlacements : countItems(inventory, hit.block.typeId);
  if (available <= 0) return [];

  return planPlacements(hit.block, faceNormal, Math.min(settings.maxPlacements, available))
    .map(({ targetBlock }) => targetBlock);
}

/**
 * Builds a compact signature so unchanged previews do not respawn entities.
 *
 * @param {import("@minecraft/server").Player} player Player owning the outline.
 * @param {import("@minecraft/server").Block[]} blocks Preview blocks.
 * @param {string} mode Preview rendering mode.
 * @returns {string} Preview signature.
 */
function getOutlineSignature(player, blocks, mode) {
  if (!blocks.length) return "";
  return `${player.dimension.id};${mode};${blocks.map((block) => blockKey(block.location)).join("|")}`;
}

function sideCandidates(value, side) {
  return side === 0 ? [value - 1, value] : [value, value + 1];
}

/**
 * Gets the four block cells touching one edge of a block.
 *
 * @param {{x: number, y: number, z: number}} location Block location.
 * @param {{axis: string, xSide?: number, ySide?: number, zSide?: number}} edgeDef Edge definition.
 * @returns {{x: number, y: number, z: number}[]} Neighboring cells around the edge.
 */
function cellsAroundEdge(location, edgeDef) {
  const cells = [];

  if (edgeDef.axis === "x") {
    for (const y of sideCandidates(location.y, edgeDef.ySide)) {
      for (const z of sideCandidates(location.z, edgeDef.zSide)) cells.push({ x: location.x, y, z });
    }
  } else if (edgeDef.axis === "y") {
    for (const x of sideCandidates(location.x, edgeDef.xSide)) {
      for (const z of sideCandidates(location.z, edgeDef.zSide)) cells.push({ x, y: location.y, z });
    }
  } else {
    for (const x of sideCandidates(location.x, edgeDef.xSide)) {
      for (const y of sideCandidates(location.y, edgeDef.ySide)) cells.push({ x, y, z: location.z });
    }
  }

  return cells;
}

/**
 * @param {number[]} selectedIndexes Selected cell indexes around an edge.
 * @returns {boolean} Whether the edge should be visible.
 */
function shouldShowEdge(selectedIndexes) {
  if (selectedIndexes.length === 1 || selectedIndexes.length === 3) return true;
  return selectedIndexes.length === 2 &&
    ((selectedIndexes[0] === 0 && selectedIndexes[1] === 3) ||
      (selectedIndexes[0] === 1 && selectedIndexes[1] === 2));
}

/**
 * Builds a per-block map of visible outline edge properties.
 *
 * @param {import("@minecraft/server").Block[]} blocks Preview blocks.
 * @returns {Map<string, Set<string>>} Visible edge properties by block key.
 */
function createOutlineEdgeMap(blocks) {
  const selected = new Set(blocks.map((block) => blockKey(block.location)));
  const edgeMap = new Map();

  for (const block of blocks) {
    const currentKey = blockKey(block.location);

    for (const edgeDef of OUTLINE_EDGE_DEFS) {
      const cells = cellsAroundEdge(block.location, edgeDef);
      const selectedIndexes = [];
      const selectedKeys = [];

      for (let index = 0; index < cells.length; index++) {
        const key = blockKey(cells[index]);
        if (!selected.has(key)) continue;

        selectedIndexes.push(index);
        selectedKeys.push(key);
      }

      if (!shouldShowEdge(selectedIndexes)) continue;
      if (selectedKeys.sort()[0] !== currentKey) continue;

      if (!edgeMap.has(currentKey)) edgeMap.set(currentKey, new Set());
      edgeMap.get(currentKey).add(edgeDef.property);
    }
  }

  return edgeMap;
}

/**
 * Applies synced edge properties to one outline entity.
 *
 * @param {import("@minecraft/server").Entity} entity Outline entity.
 * @param {Set<string>} visibleEdges Visible edge property ids.
 */
function applyOutlineEdges(entity, visibleEdges) {
  for (const property of OUTLINE_EDGE_PROPERTIES) {
    try {
      entity.setProperty(property, visibleEdges.has(property));
    } catch {}
  }
}

/**
 * Replaces a player's preview outline with entities that match the given block
 * list.
 *
 * @param {import("@minecraft/server").Player} player Player owning the outline.
 * @param {import("@minecraft/server").Block[]} blocks Blocks to outline.
 */
function setPlayerOutline(player, blocks) {
  const mode = getPreviewMode(player);
  const signature = getOutlineSignature(player, blocks, mode);
  const previous = activeOutlinesByPlayerId.get(player.id);

  if (!signature) {
    clearPlayerOutline(player.id);
    return;
  }

  if (previous?.signature === signature && previous.entities.length > 0 && previous.entities.every(isLiveObject)) return;

  clearPlayerOutline(player.id);

  const entities = [];
  const fullBlockEdges = new Set(OUTLINE_EDGE_PROPERTIES);
  const smartEdgeMap = mode === PREVIEW_MODE_SMART ? createOutlineEdgeMap(blocks) : undefined;

  for (const block of blocks) {
    const visibleEdges = mode === PREVIEW_MODE_SMART
      ? smartEdgeMap.get(blockKey(block.location))
      : fullBlockEdges;
    if (!visibleEdges || visibleEdges.size === 0) continue;

    try {
      const { x, y, z } = block.location;
      const entity = block.dimension.spawnEntity(OUTLINE_ENTITY_ID, {
        x: x + 0.5,
        y,
        z: z + 0.5
      });
      applyOutlineEdges(entity, visibleEdges);
      entities.push(entity);
    } catch {}
  }

  if (entities.length > 0) {
    activeOutlinesByPlayerId.set(player.id, { signature, entities });
  } else {
    activeOutlinesByPlayerId.delete(player.id);
  }
}

/**
 * Places the planned block copies and pays the inventory cost.
 *
 * @param {import("@minecraft/server").Player} player Player using the wand.
 * @param {import("@minecraft/server").Block} clickedBlock Block clicked by the player.
 * @param {{x: number, y: number, z: number}} faceNormal Clicked face normal.
 * @param {{maxPlacements: number}} settings Wand settings from the item JSON.
 * @returns {number} Number of blocks placed.
 */
function useBuilderWand(player, clickedBlock, faceNormal, settings) {
  if (!isUsableBlock(clickedBlock, "source")) return 0;

  const creative = isCreativePlayer(player);
  const inventory = getInventory(player);
  const available = creative ? settings.maxPlacements : countItems(inventory, clickedBlock.typeId);
  if (available <= 0) {
    showHint(player, "\u00a7cYou need matching blocks");
    playUseSound(player, "note.bass", 0.65);
    return 0;
  }

  const plan = planPlacements(clickedBlock, faceNormal, Math.min(settings.maxPlacements, available));
  if (hasBlockedCell(player, plan)) {
    showHint(player, "\u00a7cEntity in the way");
    playUseSound(player, "note.bass", 0.65);
    return 0;
  }

  let placed = 0;
  for (const { sourceBlock, targetBlock } of plan) {
    try {
      targetBlock.setPermutation(sourceBlock.permutation);
    } catch {
      break;
    }

    if (!creative && !takeOneItem(inventory, clickedBlock.typeId)) {
      try {
        targetBlock.setType("minecraft:air");
      } catch {}
      break;
    }

    placed++;
  }

  if (placed > 0) {
    try {
      player.startItemCooldown(COOLDOWN_GROUP, USE_COOLDOWN_TICKS);
    } catch {}

    if (!damageHeldWand(player)) playUseSound(player, "place.stone", 1.1);
  } else {
    playUseSound(player, "note.bass", 0.75);
  }

  return placed;
}

/**
 * Handles the custom item component event and prevents same-tick duplicate
 * calls from double placing.
 *
 * @param {import("@minecraft/server").ItemComponentUseOnEvent} eventData Use-on event.
 * @param {{max_placements?: unknown, maxPlacements?: unknown}|undefined} params Component params.
 */
function handleUseOn(eventData, params) {
  const player = eventData.source ?? eventData.player;
  if (!eventData.itemStack) return;
  if (!isLiveObject(player) || player.typeId !== "minecraft:player") return;

  const faceNormal = FACE_NORMALS[String(eventData.blockFace ?? "").toLowerCase()];
  if (!faceNormal || !eventData.block) return;

  const previousTick = handledTickByPlayerId.get(player.id) ?? -1;
  if (previousTick === system.currentTick) return;

  handledTickByPlayerId.set(player.id, system.currentTick);
  useBuilderWand(player, eventData.block, faceNormal, readWandSettings(params));
}

system.beforeEvents.startup.subscribe(({ itemComponentRegistry }) => {
  itemComponentRegistry.registerCustomComponent(WAND_COMPONENT_ID, {
    onUseOn(eventData, componentData = {}) {
      handleUseOn(eventData, componentData.params);
    }
  });
});

world.afterEvents.worldLoad.subscribe(() => {
  system.runTimeout(cleanupOutlineEntities, 1);
});

system.run(cleanupOutlineEntities);

system.runInterval(() => {
  const players = world.getPlayers();
  const activePlayerIds = new Set(players.map((player) => player.id));
  clearOfflineOutlines(activePlayerIds);

  for (const player of players) {
    try {
      if (player.getDynamicProperty(PREVIEW_PROPERTY) === false) {
        clearPlayerOutline(player.id);
        continue;
      }
      setPlayerOutline(player, getPreviewBlocks(player));
    } catch {
      clearPlayerOutline(player.id);
    }
  }

  cleanupOrphanedOutlineEntities();
}, OUTLINE_UPDATE_TICKS);
