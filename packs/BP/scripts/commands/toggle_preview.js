import {
  CommandPermissionLevel,
  CustomCommandStatus,
  system
} from "@minecraft/server";

export const BUILDER_WAND_PREVIEW_PROPERTY = "builder_wands:preview_enabled";
export const BUILDER_WAND_PREVIEW_MODE_PROPERTY = "builder_wands:preview_mode";

const PREVIEW_MODE_FULL = "full";
const PREVIEW_MODE_SMART = "smart";

/**
 * Resolves the player that executed the custom command.
 *
 * @param {import("@minecraft/server").CustomCommandOrigin} origin Command origin.
 * @returns {import("@minecraft/server").Player|undefined} Player source.
 */
function getPlayerSource(origin) {
  const source = origin.sourceEntity;
  return source?.typeId === "minecraft:player" ? source : undefined;
}

/**
 * Toggles the per-player preview preference stored in dynamic properties.
 *
 * @param {import("@minecraft/server").Player} player Player running the command.
 * @returns {boolean} The new preview state.
 */
function togglePreviewFor(player) {
  const enabled = player.getDynamicProperty(BUILDER_WAND_PREVIEW_PROPERTY) !== false;
  const nextEnabled = !enabled;
  player.setDynamicProperty(BUILDER_WAND_PREVIEW_PROPERTY, nextEnabled);
  return nextEnabled;
}

/**
 * Toggles the per-player preview rendering mode.
 *
 * @param {import("@minecraft/server").Player} player Player running the command.
 * @returns {string} The new preview mode.
 */
function togglePreviewModeFor(player) {
  const mode = player.getDynamicProperty(BUILDER_WAND_PREVIEW_MODE_PROPERTY);
  const nextMode = mode === PREVIEW_MODE_SMART ? PREVIEW_MODE_FULL : PREVIEW_MODE_SMART;
  player.setDynamicProperty(BUILDER_WAND_PREVIEW_MODE_PROPERTY, nextMode);
  return nextMode;
}

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  customCommandRegistry.registerCommand(
    {
      name: "builder_wands:toggle_preview",
      description: "Toggle your Builder Wand placement preview.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false
    },
    (origin) => {
      const player = getPlayerSource(origin);
      if (!player) {
        return {
          status: CustomCommandStatus.Failure,
          message: "Only players can toggle Builder Wand preview."
        };
      }

      const enabled = togglePreviewFor(player);
      return {
        status: CustomCommandStatus.Success,
        message: `Builder Wand preview ${enabled ? "enabled" : "disabled"}.`
      };
    }
  );

  customCommandRegistry.registerCommand(
    {
      name: "builder_wands:toggle_preview_mode",
      description: "Toggle your Builder Wand preview render mode.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false
    },
    (origin) => {
      const player = getPlayerSource(origin);
      if (!player) {
        return {
          status: CustomCommandStatus.Failure,
          message: "Only players can toggle Builder Wand preview mode."
        };
      }

      const mode = togglePreviewModeFor(player);
      return {
        status: CustomCommandStatus.Success,
        message: `Builder Wand preview mode: ${mode === PREVIEW_MODE_SMART ? "smart outline" : "full block"}.`
      };
    }
  );
});
