# Monaco Touch Selection

support touch selection for monaco editor.

![preview.png](preview.png)

```
npm install monaco-touch-selection
```

## Example

```html
<div id="container"></div>
```

```typescript
import * as monaco from 'monaco-editor';
import {editorTouchSelectionHelp} from 'monaco-touch-selection';
import 'monaco-touch-selection/dist/style.css';

const element = document.getElementById('container')

const editor = monaco.editor.create(element, {
    value: '',
});

editorTouchSelectionHelp({
    editor,
    element
})
```

## API

Give your editor to `editorTouchSelectionHelp`.

```typescript
declare const editorTouchSelectionHelp: (editor: ICodeEditor, options?: {
    tools?: SelectorMenuToolConfig
    selectionSyncTimeout?: number | undefined
    toolActionErrorHandler?: (name: string, error: Error | unknown) => Promise<void> | void
}) => void
```

## Menu Tools

Here is the type for menu tool.

```typescript
type SelectorMenuTool = {
    name: string
    innerHTML: string | Element | (() => string | Element)
    action: () => (Promise<void> | void)
}
```

You can customize menu tools by `editorTouchSelectionHelp` argument `tools` like this:

```typescript
editorTouchSelectionHelp(editor, {
    tools: ({defaultTools}) => {
        const copyTool = defaultTools.get(DefaultToolName.Copy)
        if (copyTool) {
            copyTool.action = () => {
                // TODO: change default copy action
            }
        }
        return defaultTools.values()
    }
})
```

Here is enum for default tools.

```typescript
declare enum DefaultToolName {
    Copy = "copy",
    Cut = "cut",
    Paste = "paste",
    SelectAll = "selectAll",
    Undo = "undo",
    Redo = "redo",
    Close = "close"
}
```

Here is type for menu tool config function.

```typescript
type SelectorMenuToolConfig = (options: {
    editor: ICodeEditor
    selectorMenu: HTMLDivElement
    defaultTools: Map<DefaultToolName, SelectorMenuTool>
    openMenu: () => void
    closeMenu: () => void
}) => Iterable<SelectorMenuTool> | undefined
```

## Style

If you want to make simple style modifications, you can override the following CSS variables:

```css
:root {
    --monaco-editor_touch-selection_z-index: 100000;
    --monaco-editor_touch-selector_color: #1E90FF;
    --monaco-editor_touch-selector_size: 1.2rem;

    --monaco-editor_touch-selector-menu_z-index: 100001;
    --monaco-editor_touch-selector-menu_bg-color: #f7f7f7;
    --monaco-editor_touch-selector-menu_height: 1.8rem;
    --monaco-editor_touch-selector-menu_border-color: #ccc;
    --monaco-editor_touch-selector-menu_icon-color: #666;
}
```

For more extensive customization, you can directly modify or extend the styles in [style.css](src/style.css).

## TE2 Integration And Maintenance

This worktree is the editable source for Code TE2's patched touch-selection
extension. The generated `dist/` files and Code TE2's static vendor files are
deployment artifacts; do not patch either copy independently of `src/index.ts`
and `src/style.css`.

### Import And Deployment Flow

1. `npm run build` compiles `src/index.ts` into ESM and UMD outputs and copies
   `src/style.css` to `dist/style.css`.
2. Code TE2 tracks copies of the UMD and CSS under
   `app/apps/file_editor_cm6/static/vendor/monaco-touch-selection/` in the
   parent repository.
3. Code TE2's `monaco_editor/inline_host.ts` injects those files from their
   `/api/app/file_editor_cm6/static/vendor/monaco-touch-selection/` URLs. The
   UMD exposes `window['monaco-touch-selection']`; the editor integration calls
   `editorTouchSelectionHelp` from that global.
4. `app/android_editor_assets_bundle.json` includes the complete static vendor
   directory in Android OTA bundles. The Rust bundle endpoint builds from the
   current parent-repository files and serves the archive with `no-store`, so a
   forced same-version refresh does not reuse stale touch-extension bytes.

Build and deploy from this worktree:

```sh
npm ci
npm run build

cp dist/index.umd.cjs \
  ../../app/apps/file_editor_cm6/static/vendor/monaco-touch-selection/monaco-touch-selection.patched.umd.js
cp dist/style.css \
  ../../app/apps/file_editor_cm6/static/vendor/monaco-touch-selection/monaco-touch-selection.css
```

Changing the touch-extension source while retaining these filenames does not
require rebuilding Code TE2's host bundle because the host loads the vendor
URLs directly. Rebuild Code TE2 itself if `inline_host.ts`, its asset paths, or
other host source changes.

### Modification Guardrails

- Keep touch coordinates in browser CSS pixels. Do not apply `devicePixelRatio`,
  DOM scale normalization, or artificial finger-to-caret magnification unless
  a measured Monaco coordinate mismatch proves one is required.
- Treat `touchmove` as input capture only. It should replace the latest `Touch`;
  one fixed 50 ms sampler owns rendered-column resolution, scrolling, and
  Monaco selection writes. Doing that work for every browser touch event causes
  long drags to accumulate latency.
- Compare the resolved caret or range with Monaco's current state before calling
  `setPosition` or `setSelection`. Duplicate writes trigger avoidable Monaco
  cursor-selection work.
- Keep one authoritative active-drag cleanup. It must clear the interval and
  document listeners on end, cancel, replacement, editor disposal, window blur,
  and document hiding.
- Resolve horizontal placement against Monaco's rendered insertion boundaries;
  tabs, proportional glyphs, wrapped rows, and horizontal scroll make character
  width arithmetic unreliable.
- Mount floating menus at the document root, retain their high z-index, and
  clamp only to the visual viewport. They must be allowed to overlay Code TE2
  drawers and the menubar.
- Preserve touch-only automatic menu opening and desktop's explicit right-click
  behavior when changing menu lifecycle code.
- Modify touch-target sizing and menu presentation in `src/style.css`, then
  rebuild and deploy both generated assets together.

### Validation

```sh
npm run build
node --check dist/index.umd.cjs
cmp dist/index.umd.cjs \
  ../../app/apps/file_editor_cm6/static/vendor/monaco-touch-selection/monaco-touch-selection.patched.umd.js
cmp dist/style.css \
  ../../app/apps/file_editor_cm6/static/vendor/monaco-touch-selection/monaco-touch-selection.css
git diff --check
```

Live validation should cover a sustained handle drag, column-by-column
placement, edge auto-scroll, interrupted drag cleanup, menu placement near all
viewport edges, drawer/menubar overlay, touch menu activation, and desktop
right-click behavior.
