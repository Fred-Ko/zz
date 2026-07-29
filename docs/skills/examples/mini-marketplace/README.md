# mini-marketplace

A minimal ZZ marketplace catalog that demonstrates the `marketplace.json` format. It lists one plugin (`my-plugin`) using a relative path source.

## Install command

```
/marketplace add ./docs/skills/examples/mini-marketplace
/marketplace install my-plugin@example-marketplace
```

Or from the CLI:

```
zz plugin marketplace add ./docs/skills/examples/mini-marketplace
zz plugin install my-plugin@example-marketplace
```

## What it demonstrates

- Minimum required `marketplace.json` fields: `name`, `owner.name`, `plugins`
- Relative path plugin source using `./` prefix (`"source": "./my-plugin"`)
- Plugin bundled inside the same directory tree as the marketplace catalog
- Extra catalog metadata: the example includes a top-level `description`; current marketplace parsing preserves extra top-level fields, while runtime behavior uses required fields and plugin entries.

## Structure

```
mini-marketplace/
  .zz-plugin/
    marketplace.json      ← canonical ZZ catalog
  .claude-plugin/
    marketplace.json      ← Claude-compatible mirror
  README.md
  my-plugin/
    package.json          ← zz.extensions manifest
    index.ts              ← extension entry point
```

Published and local marketplaces use the same catalog location. ZZ loads `.zz-plugin/marketplace.json` first, then the legacy compatibility path, and finally `.claude-plugin/marketplace.json` (the Claude Code-compatible path this example ships). Point `/marketplace add` at this folder to load the example.
