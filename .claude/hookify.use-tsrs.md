---
name: block-tsc-tsgo-use-tsrs
enabled: true
event: bash
action: block
pattern: (?:^|&&|\|\||;)\s*(?:npx\s+|bunx\s+)?(?:tsc|tsgo)(?:\s|$)
---

**BLOCKED: Do not invoke `tsc` or `tsgo`.**

Type checks, builds and type-aware lint run on `tsrs` on this machine.

**Use the package scripts instead:**

- `bun run check:types` -- type check (`tsrs --noEmit --fast`)
- `bun run build` -- build (`tsrs --build`)
- `bun run check:lint` -- lint, with oxlint's type-aware rules on `tsrs-lint`
