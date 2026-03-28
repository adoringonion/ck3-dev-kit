# CK3 Mod DevKit

VS Code extension and CLI tooling for Crusader Kings III mod development.

It provides a CK3-focused language server with workspace indexing, hover, completion, diagnostics, symbol search, reference search, quick fixes, semantic highlighting, and `error.log` analysis.

## Features

- CK3 script and localization parsing
- Workspace and vanilla indexing with cache support
- Hover, go to definition, find references, completion
- Document symbols and workspace symbols
- Live diagnostics for unresolved references and parser errors
- Semantic tokens for CK3-specific syntax such as event ids, `var:` references, `scope:` references, doctrines, cultures, and scripted callables
- Quick fixes for:
  - missing localization keys
  - missing `scripted_effect`, `scripted_trigger`, and `script_value` definitions
  - missing UTF-8 BOM in localization files
  - converting GUI `text = some_key` into `raw_text = "some_key"` when the unresolved value is intended to be literal text
- CK3 `error.log` analysis command
- CLI commands for indexing, diagnostics, symbol lookup, reference lookup, and cache management

## Install

### Development host

```powershell
npm install
npm run build
npm test
```

Open this repository in VS Code and press `F5`.

### Regular VS Code install

```powershell
npm install
npm run package:vsix
& "$env:LOCALAPPDATA\\Programs\\Microsoft VS Code\\bin\\code.cmd" --install-extension .\ck3-devkit-0.1.0.vsix --force
```

After installation, reload VS Code with `Developer: Reload Window`.

## Recommended workspace settings

Point the extension at your mod folder and the CK3 `game` folder.

```json
{
  "ck3ModDevkit.modRoots": [
    "${workspaceFolder}"
  ],
  "ck3ModDevkit.referenceRoots": [
    "D:/SteamLibrary/steamapps/common/Crusader Kings III/game"
  ],
  "ck3ModDevkit.errorLogPath": "C:/Users/<you>/Documents/Paradox Interactive/Crusader Kings III/logs/error.log"
}
```

Then run `CK3 Mod DevKit: Write Workspace File Associations` once so `.txt` files are treated as CK3 script files in the workspace.

## Commands

- `CK3 Mod DevKit: Write Workspace File Associations`
- `CK3 Mod DevKit: Rebuild Symbol Index`
- `CK3 Mod DevKit: Analyze CK3 Error Log`

## Diagnostics and quick fixes

The extension validates CK3 references against both your mod and vanilla data.

Examples:

- unresolved localization keys
- unresolved `scripted_effect` or `scripted_trigger` calls
- unresolved `script_value` references
- localization files saved without BOM

When possible, code actions are offered directly from the lightbulb menu.

## CLI

Build once before using the CLI:

```powershell
npm run build
```

Examples:

```powershell
node dist/cli.js ../my-mod ../game
node dist/find-symbol.js medium_prestige_value ../my-mod ../game
node dist/find-references.js show_pow_release_message_effect ../my-mod ../game
node dist/cache-info.js ../my-mod ../game
node dist/rebuild-cache.js ../my-mod ../game
node dist/diagnostics.js ../my-mod/events/sample_events.txt
node dist/validate-references.js ../my-mod ../game
node dist/analyze-error-log.js "C:/Users/<you>/Documents/Paradox Interactive/Crusader Kings III/logs/error.log" ../my-mod ../game
```

Exit codes:

- `0`: success
- `1`: execution error
- `2`: no match or diagnostics found

## Notes

- The extension is optimized for local modding workflows rather than the public VS Code marketplace.
- `referenceRoots` should point at CK3 vanilla data, usually the `game` directory.
- Rename is intentionally conservative and only applies to safe mod-local cases.
