/** Re-exports the module augmentation so `import "…/types/index.js"` is enough. */
import "./discord.js";

export type {
  ArrayElement,
  DeepPartial,
  DeepReadonly,
  KeysOf,
  MaybePromise,
  WithRequired,
} from "./utility.js";
