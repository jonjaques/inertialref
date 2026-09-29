# Editor debug configurations

VS Code and Cursor both read `.vscode/launch.json`. Four configurations, and
the play button on **Launch Browser** is the one that starts the game.

| Configuration      | What it debugs                             | Port |
| ------------------ | ------------------------------------------ | ---- |
| **Launch Browser** | the client; starts `pnpm dev` if needed    | 5173 |
| **Attach Browser** | an already-running Chrome                  | 9222 |
| **Launch Node**    | the headless runner (`--self-test`)        | —    |
| **Attach Node**    | `pnpm sim`, which listens with `--inspect` | 9229 |

The Worker's workerd inspector under `cf dev` is on **9230**, so it does not
steal Node's default; the port is `dev.inspectorPort` in
`apps/server/wrangler.config.ts`. It is not one of the four configurations;
attach a Node debugger to 9230 if the Worker script is the thing with the
breakpoint.

## Launch Browser

Starts `node scripts/dev.mjs --ensure` as a background task. If something is
already answering on 5173 (a terminal that ran `pnpm dev`, including the Cloud
Agent boot terminal), the task reuses it and does not kill it when debugging
stops. If nothing is, the task is the two-child start and stopping debugging
stops those children.

Source maps are on in `pnpm dev` and in the production build. Breakpoints go
in `apps/game/src` and `packages/*/src`.

## Attach Browser

Start Chrome with a remote-debugging port, then attach:

```bash
chrome --remote-debugging-port=9222
```

Chromium, Edge, and Brave accept the same flag. Then open
http://localhost:5173 in that browser.

## Launch Node / Attach Node

Launch Node runs `apps/headless/src/main.ts --self-test` under the editor's
inspector. Attach Node connects to 9229, which `pnpm sim` binds with
`node --inspect=127.0.0.1:9229`. Type stripping preserves line numbers, so
breakpoints in the `.ts` sources bind without a compile step.
