import type { editor, IPosition } from 'monaco-editor/esm/vs/editor/editor.api.js'

/** Sample the rendered view line so wrapping, token widths and tabs match Monaco. */
export function createSelectionLens(control: editor.ICodeEditor, host: HTMLElement) {
    const lens = document.createElement('div')
    lens.className = 'monaco-touch-selection-lens'
    lens.setAttribute('aria-hidden', 'true')
    const sample = document.createElement('div')
    sample.className = 'monaco-touch-selection-sample'
    const selectionLayer = document.createElement('div')
    const caret = document.createElement('div')
    caret.className = 'monaco-touch-lens-caret'
    lens.append(selectionLayer, sample, caret)
    let frame = 0
    let previous: Node | null = null
    let latest: IPosition
    let fingerY = 0
    const scale = 1.65
    function paint() {
        frame = 0
        const pos = control.getScrolledVisiblePosition(latest)
        const box = host.getBoundingClientRect()
        if (!pos || !box.width || !box.height) { lens.hidden = true; return }
        const sx = box.width / host.offsetWidth, sy = box.height / host.offsetHeight
        const y = box.top + (pos.top + pos.height / 2) * sy
        const row = [...host.querySelectorAll<HTMLElement>('.view-lines > .view-line')].find(line => {
            const r = line.getBoundingClientRect()
            return y >= r.top && y < r.bottom
        })
        if (!row) { lens.hidden = true; return }
        if (!lens.isConnected) {
            const theme = getComputedStyle(host)
            for (const name of ['--vscode-editor-background', '--vscode-editor-foreground',
                '--vscode-editorWidget-border', '--vscode-editorCursor-foreground', '--vscode-editorCursor-background']) {
                lens.style.setProperty(name, theme.getPropertyValue(name))
            }
            document.documentElement.append(lens)
        }
        lens.hidden = false
        const shape = control.getRawOptions().cursorStyle ?? 'line'
        if (row.firstChild !== previous || caret.dataset.shape !== shape) {
            sample.replaceChildren(...Array.from(row.childNodes, n => n.cloneNode(true)))
            // The copy lives outside .view-lines, so Monaco's descendant rules
            // no longer apply. Copy longhands: Chromium can return an empty
            // computed font shorthand even when every font metric is resolved.
            const originals = [row, ...row.querySelectorAll<HTMLElement>('span')]
            const copies = [sample, ...sample.querySelectorAll<HTMLElement>('span')]
            for (const [i, original] of originals.entries()) {
                const style = getComputedStyle(original)
                for (const property of ['font-family', 'font-size', 'font-weight', 'font-style',
                    'font-stretch', 'font-feature-settings', 'font-variation-settings', 'font-kerning',
                    'font-variant-ligatures', 'letter-spacing', 'word-spacing', 'line-height', 'tab-size', 'color']) {
                    copies[i].style.setProperty(property, style.getPropertyValue(property))
                }
            }
            previous = row.firstChild
            caret.replaceChildren()
            if (shape === 'block') caret.append(sample.cloneNode(true))
            caret.dataset.shape = shape
        }
        const offset = pos.left - (row.getBoundingClientRect().left - box.left) / sx
        sample.style.transform = `translate(${-offset * scale}px,-50%) scale(${scale})`
        const next = control.getScrolledVisiblePosition({ lineNumber: latest.lineNumber, column: latest.column + 1 })
        const cell = next && next.top === pos.top && next.left > pos.left
            ? next.left - pos.left : Number.parseFloat(getComputedStyle(row).fontSize) * 0.6
        caret.style.width = (shape.startsWith('block') ? cell : (control.getRawOptions().cursorWidth || 2)) * scale + 'px'
        caret.style.height = pos.height * scale + 'px'
        const glyph = caret.firstElementChild
        if (glyph instanceof HTMLElement) glyph.style.transform = sample.style.transform
        selectionLayer.replaceChildren()
        const selection = control.getSelection()
        if (selection && !selection.isEmpty()) {
            const anchorX = box.left + pos.left * sx
            for (const segment of host.querySelectorAll<HTMLElement>('.view-overlays .selected-text')) {
                // Monaco paints a filler followed by a background mask to round
                // an interior corner. Only the actual selected ranges belong in the lens.
                if (segment.nextElementSibling?.matches('.cslr.monaco-editor-background')) continue
                const rect = segment.getBoundingClientRect()
                if (y < rect.top || y >= rect.bottom) continue
                const mark = document.createElement('div')
                mark.className = 'monaco-touch-lens-selection'
                mark.style.left = `calc(50% + ${(rect.left - anchorX) / sx * scale}px)`
                mark.style.width = rect.width / sx * scale + 'px'
                mark.style.height = pos.height * scale + 'px'
                mark.style.backgroundColor = getComputedStyle(segment).backgroundColor
                selectionLayer.append(mark)
            }
        }
        const viewport = window.visualViewport
        const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0
        const right = left + (viewport?.width ?? window.innerWidth)
        const bottom = top + (viewport?.height ?? window.innerHeight)
        const x = box.left + pos.left * sx - lens.offsetWidth / 2
        const above = box.top + pos.top * sy - lens.offsetHeight - 12
        lens.style.left = Math.max(left, Math.min(x, right - lens.offsetWidth)) + 'px'
        lens.style.top = Math.max(top, Math.min(above >= top ? above : fingerY + 24, bottom - lens.offsetHeight)) + 'px'
    }
    return {
        update(position: IPosition, clientY: number) {
            latest = position
            fingerY = clientY
            if (!frame) frame = requestAnimationFrame(paint)
        },
        dispose() { cancelAnimationFrame(frame); lens.remove() },
    }
}
