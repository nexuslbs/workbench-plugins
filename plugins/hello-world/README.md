# hello-world

The greeting plugin, moved OUT of the core repository (`nexuslbs/workbench`)
into this plugins repository. It is the smallest possible consumer of the plugin
contract and the plugin the docs use in their examples.

- registers the command `hello world` through `ctx.workbench.registerCommand`
- config: `message` (default `Hello World`)
- imports NOTHING from the core package: the contract is the injected
  `ctx.workbench` service

Loaded like every other plugin, from any source:

```yaml
sources:
  - kind: path
    id: workbench-plugins
    path: ../workbench-plugins/plugins
  - kind: git
    id: workbench-plugins
    url: https://github.com/nexuslbs/workbench-plugins
    ref: main
    subdir: plugins

plugins:
  hello-world:
    message: Hello World
```

The core repository ships no plugin at all, so the `sources:` block above (or
any other external source) is what makes this command exist.
