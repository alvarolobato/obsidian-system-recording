// Minimal `obsidian` stand-in for unit tests. Obsidian bundles moment at
// runtime; here we re-export the real moment package so date formatting in
// template rendering can be exercised without the Obsidian app.
/* eslint-disable no-restricted-imports, import/no-extraneous-dependencies */
import moment from "moment";

export { moment };
