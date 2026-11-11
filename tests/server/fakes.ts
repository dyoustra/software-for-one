import type { SpriteCli } from "../../src/core/sprite.js";
import type { GitHubDevice } from "../../src/server/github-signin.js";

/** For tests that never touch a project: any Sprite call is a mistake. */
export const noSprites: SpriteCli = {
  create: async () => { throw new Error("no Sprites in this test"); },
  destroy: async () => { throw new Error("no Sprites in this test"); },
  exec: async () => { throw new Error("no Sprites in this test"); },
  pull: async () => { throw new Error("no Sprites in this test"); },
  push: async () => { throw new Error("no Sprites in this test"); },
};

/** For tests that never sign in with GitHub. */
export const noGitHubDevice: GitHubDevice = {
  start: async () => { throw new Error("no GitHub sign-in in this test"); },
  poll: async () => { throw new Error("no GitHub sign-in in this test"); },
  userId: async () => { throw new Error("no GitHub sign-in in this test"); },
};
