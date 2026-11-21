import type { editor, IPosition } from 'monaco-editor/esm/vs/editor/editor.api.js'
import {touchCoords, hintRuns} from './inlay-geometry.js'

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
    const neighbors = [-1, 1].map(() => sample.cloneNode(false) as HTMLDivElement)
    const scene = document.createElement('div')
    scene.style.cssText = 'position:absolute;inset:0'
    scene.append(selectionLayer, ...neighbors, sample, caret)
    lens.append(scene)
    let frame = 0
    const sources = new WeakMap<HTMLElement, Node | null>()
    let latest: IPosition
    let fingerY = 0
    let fingerX = 0
    let caretClientX = 0
    let editorScaleX = 1
    let placement: 'above' | 'below' | undefined
    const scale = 1.65
    let fontCopyFactor = 1
    function pan() {
        // The scene is painted relative to the snapped caret. Translate the
        // whole scene so the continuous virtual touch point is at lens center.
        scene.style.transform = `translateX(${(caretClientX - fingerX) * scale / editorScaleX}px)`
        const viewport = window.visualViewport
        const left = viewport?.offsetLeft ?? 0
        lens.style.left = Math.max(left, Math.min(fingerX - lens.offsetWidth / 2,
            left + (viewport?.width ?? window.innerWidth) - lens.offsetWidth)) + 'px'
    }
    function paint() {
        frame = 0
        const pos = touchCoords(control,latest)
        const box = host.getBoundingClientRect()
        if (!pos || !box.width || !box.height) { lens.hidden = true; return }
        const sx = box.width / host.offsetWidth, sy = box.height / host.offsetHeight
        const y = box.top + (pos.top + pos.height / 2) * sy
        const rows = [...host.querySelectorAll<HTMLElement>('.view-lines > .view-line')]
        const row = rows.find(line => {
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
            // Some Android hosts report an already scaled computed font-size,
            // then apply their text scale again to an explicit px declaration.
            // Measure that conversion in the lens once, not on each drag frame.
            const probe = document.createElement('span')
            probe.style.fontSize = '100px'
            sample.append(probe)
            const effective = Number.parseFloat(getComputedStyle(probe).fontSize)
            if (Number.isFinite(effective) && effective > 0) fontCopyFactor = 100 / effective
            probe.remove()
        }
        lens.hidden = false
        const shape = control.getRawOptions().cursorStyle ?? 'line'
        const anchorX = box.left + pos.left * sx
        caretClientX = anchorX
        editorScaleX = sx
        const anchorRect = row.getBoundingClientRect()
        const center = (anchorRect.top + anchorRect.bottom) / 2
        lens.style.height = Math.ceil(pos.height * scale * 1.65) + 'px'
        const visibleRows = [row, ...[-1, 1].map(direction => rows.find(candidate => {
            const rect = candidate.getBoundingClientRect()
            const edge = direction < 0 ? anchorRect.top - 0.5 : anchorRect.bottom + 0.5
            return edge >= rect.top && edge < rect.bottom
        }))]
        for (const [index, target] of [sample, ...neighbors].entries()) {
            const source = visibleRows[index]
            target.hidden = !source
            if (!source) continue
            const rect = source.getBoundingClientRect()
            target.style.top = `calc(50% + ${((rect.top + rect.bottom) / 2 - center) / sy * scale}px)`
            target.style.transform = `translate(${(rect.left - anchorX) / sx * scale}px,-50%) scale(${scale})`
            if (sources.get(target) === source.firstChild && (index !== 0 || caret.dataset.shape === shape)) continue
            target.replaceChildren(...Array.from(source.childNodes, n => n.cloneNode(true)))
            // The copy lives outside .view-lines, so Monaco's descendant rules
            // no longer apply. Copy longhands: Chromium can return an empty
            // computed font shorthand even when every font metric is resolved.
            const originals = [source, ...source.querySelectorAll<HTMLElement>('span')]
            const copies = [target, ...target.querySelectorAll<HTMLElement>('span')]
            for (const [i, original] of originals.entries()) {
                const style = getComputedStyle(original)
                if (original.classList.contains('te2-inlay-cursor-stop')) {
                    copies[i].style.backgroundColor = style.backgroundColor
                    copies[i].style.borderRadius = style.borderRadius
                    copies[i].style.padding = style.padding
                    copies[i].style.display = style.display
                    if (style.display === 'inline-block') copies[i].style.width = style.width
                }
                for (const property of ['font-family', 'font-size', 'font-weight', 'font-style',
                    'font-stretch', 'font-feature-settings', 'font-variation-settings', 'font-kerning',
                    'font-variant-ligatures', 'letter-spacing', 'word-spacing', 'line-height', 'tab-size', 'color']) {
                    const value = style.getPropertyValue(property)
                    copies[i].style.setProperty(property, property === 'font-size' && fontCopyFactor !== 1
                        ? Number.parseFloat(value) * fontCopyFactor + 'px' : value)
                }
            }
            sources.set(target, source.firstChild)
            if (index !== 0) continue
            caret.replaceChildren()
            if (shape === 'block') caret.append(sample.cloneNode(true))
            caret.dataset.shape = shape
        }
        const next = control.getScrolledVisiblePosition({ lineNumber: latest.lineNumber, column: latest.column + 1 })
        const nextHint = hintRuns(control,host,latest.lineNumber,y).get(latest.column+1)
        const nextLeft = nextHint ? (nextHint.left-box.left)/sx : next?.left
        const cell = next && next.top === pos.top && nextLeft !== undefined && nextLeft > pos.left
            ? nextLeft - pos.left : Number.parseFloat(getComputedStyle(row).fontSize) * 0.6
        caret.style.width = (shape.startsWith('block') ? cell : (control.getRawOptions().cursorWidth || 2)) * scale + 'px'
        caret.style.height = pos.height * scale + 'px'
        const glyph = caret.firstElementChild
        if (glyph instanceof HTMLElement) glyph.style.transform = sample.style.transform
        selectionLayer.replaceChildren()
        const selection = control.getSelection()
        if (selection && !selection.isEmpty()) {
            for (const segment of host.querySelectorAll<HTMLElement>('.view-overlays .selected-text, .view-overlays .selected-text + .cslr.monaco-editor-background')) {
                const rect = segment.getBoundingClientRect()
                const dy = ((rect.top + rect.bottom) / 2 - center) / sy * scale
                if (Math.abs(dy) > (lens.offsetHeight + rect.height / sy * scale) / 2) continue
                const mark = document.createElement('div')
                mark.className = 'monaco-touch-lens-selection'
                mark.style.left = `calc(50% + ${(rect.left - anchorX) / sx * scale}px)`
                mark.style.width = rect.width / sx + 'px'
                mark.style.top = `calc(50% + ${dy}px)`
                mark.style.height = rect.height / sy + 'px'
                mark.style.transformOrigin = 'left center'
                mark.style.transform = `translateY(-50%) scale(${scale})`
                const paint = getComputedStyle(segment)
                mark.style.backgroundColor = paint.backgroundColor
                mark.style.borderRadius = paint.borderRadius
                selectionLayer.append(mark)
            }
        }
        const viewport = window.visualViewport
        const top = viewport?.offsetTop ?? 0
        const bottom = top + (viewport?.height ?? window.innerHeight)
        const above = box.top + pos.top * sy - lens.offsetHeight - 12
        pan()
        const nextPlacement = above >= top ? 'above' : 'below'
        lens.style.transition = placement === nextPlacement && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'top 80ms ease-out' : 'none'
        placement = nextPlacement
        lens.style.top = Math.max(top, Math.min(above >= top ? above : fingerY + 24, bottom - lens.offsetHeight)) + 'px'
    }
    return {
        move(clientX: number) {
            fingerX = clientX
            if (lens.isConnected) pan()
        },
        update(position: IPosition, clientY: number) {
            latest = position
            fingerY = clientY
            if (!frame) frame = requestAnimationFrame(paint)
        },
        dispose() { cancelAnimationFrame(frame); lens.remove() },
    }
}
