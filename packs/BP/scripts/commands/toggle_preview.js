import {
  CommandPermissionLevel,
  CustomCommandStatus,
  system
} from "@minecraft/server";

export const BUILDER_WAND_PREVIEW_PROPERTY = "builder_wands:preview_enabled";

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
  const enabled = player.getDynamicProperty(BUILDER_WAND_PREVIEW_PROPERTY) === true;
  const nextEnabled = !enabled;
  player.setDynamicProperty(BUILDER_WAND_PREVIEW_PROPERTY, nextEnabled);
  return nextEnabled;
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
});
