// turndown-plugin-gfm ships no types. Only the `gfm` aggregate is used by the
// markdown editor; the individual rule exports are not part of its contract.
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}
