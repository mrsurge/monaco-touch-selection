import type { editor, IPosition } from 'monaco-editor/esm/vs/editor/editor.api.js'

/** Sample the rendered view line so wrapping, token widths and tabs match Monaco. */
export function createSelectionLens(control: editor.ICodeEditor, host: HTMLElement) {
    const lens = document.createElement('div')
    lens.className = 'monaco-touch-selection-lens'
    lens.setAttribute('aria-hidden', 'true')
    const sample = document.createElement('div')
    sample.className = 'monaco-touch-selection-sample'
    lens.append(sample)
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
                '--vscode-editorWidget-border', '--vscode-editorCursor-foreground']) {
                lens.style.setProperty(name, theme.getPropertyValue(name))
            }
            document.documentElement.append(lens)
        }
        lens.hidden = false
        if (row.firstChild !== previous) {
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
        }
        const offset = pos.left - (row.getBoundingClientRect().left - box.left) / sx
        sample.style.transform = `translate(${-offset * scale}px,-50%) scale(${scale})`
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
