/**
 * @type {import("lint-staged").Configuration}
 */
export default {
  "*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}": ["oxfmt --write", "bun run fix:lint --", "oxfmt --write"],
  "*.{json,md}": ["oxfmt --write"],
};
