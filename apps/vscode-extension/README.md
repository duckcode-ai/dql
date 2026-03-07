# DQL Language Support

VS Code extension for DQL with:

- Syntax highlighting for DQL files (`.dql`)
- Snippets for dashboards, workbooks, and blocks
- Language Server support (diagnostics, completion, hover, formatting)

## Development

```bash
pnpm --filter dql-language-support build
```

## Packaging

```bash
pnpm --filter dql-language-support package
```

This generates a `.vsix` artifact that can be installed in VS Code.
