// Entry for the vendored markdown bundle (see package.json "vendor:markdown").
// Plasmo's Parcel drops ESM re-exports inside the unified ecosystem (e.g.
// property-information's hastToReact), crashing react-markdown at runtime —
// v8 (addProperty) and v10 (createProperty) alike. Pre-bundling with esbuild
// into one flat file sidesteps Parcel's cross-module resolution entirely.
// React stays external so the extension has a single React instance.
export { default } from "react-markdown"
export { default as remarkGfm } from "remark-gfm"
