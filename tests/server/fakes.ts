import type { SpriteCli } from "../../src/core/sprite.js";

/** For tests that never touch a project: any Sprite call is a mistake. */
export const noSprites: SpriteCli = {
  create: async () => { throw new Error("no Sprites in this test"); },
  destroy: async () => { throw new Error("no Sprites in this test"); },
  exec: async () => { throw new Error("no Sprites in this test"); },
  pull: async () => { throw new Error("no Sprites in this test"); },
  push: async () => { throw new Error("no Sprites in this test"); },
};
