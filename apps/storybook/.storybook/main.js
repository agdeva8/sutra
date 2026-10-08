import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type { import('@storybook/react-vite').StorybookConfig } */
const config = {
  stories: ["../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    // Storybook's Model Context Protocol server. It publishes the component
    // manifest and the docs toolset over HTTP so a coding agent can ask what
    // components and stories exist, and read their props, without scraping
    // the static build. Served alongside the dev server at
    // http://localhost:6007/mcp — note 6007, not the 6006 in Storybook's docs,
    // because that is the port this app pins (see package.json).
    { name: "@storybook/addon-mcp", options: { endpoint: "/mcp" } },
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  // Required by the addon's docs toolset — it builds the component manifest
  // the MCP server serves. Supported by the react-vite framework we use.
  features: { componentsManifest: true },
  staticDirs: ["../public"],

  // This used to come from the project's vite.config.js, which Storybook
  // merged automatically. That file is gone now that the standalone Vite app
  // has been removed, so the three things the copied app code depends on live
  // here instead.
  viteFinal: async (viteConfig) => {
    // The React plugin used to arrive via the project's vite.config.js, which
    // Storybook merged automatically. With that file gone, nothing provides the
    // automatic JSX runtime and every `.js` component throws
    // `React is not defined` — so it is registered explicitly here.
    viteConfig.plugins = [...(viteConfig.plugins || []), react()];

    viteConfig.resolve = viteConfig.resolve || {};
    viteConfig.resolve.alias = {
      ...(viteConfig.resolve.alias || {}),
      // craco mapped `@/*` to `src/*` in the original app; the copied
      // components import through it.
      "@": path.resolve(here, "../src"),
    };

    // CRA parsed JSX in `.js` files; esbuild defaults `.js` to the plain JS
    // loader and chokes on the first `<Tag>`. Most copied components are `.js`
    // (App.js, Coach.js, Timeline.js, …). Setting `include` replaces Vite's
    // default filter, so the plain `.jsx` pattern is listed back explicitly —
    // otherwise this config file's own neighbours lose their transform.
    viteConfig.esbuild = {
      ...(viteConfig.esbuild || {}),
      loader: "jsx",
      include: [/src\/.*\.jsx?$/, /\.jsx$/],
      exclude: [],
    };

    // src/lib/api.js reads process.env.REACT_APP_BACKEND_URL to build the API
    // base. Without this define it is a ReferenceError at module load and every
    // story that touches the API dies. Empty string means "same origin,
    // relative /api", which is what the in-page mock serves.
    viteConfig.define = {
      ...(viteConfig.define || {}),
      "process.env.REACT_APP_BACKEND_URL": JSON.stringify(""),
    };

    return viteConfig;
  },
};

export default config;
