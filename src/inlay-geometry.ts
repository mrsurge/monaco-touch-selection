import type {editor, IPosition} from 'monaco-editor/esm/vs/editor/editor.api.js'

// Coordinates here are viewport CSS pixels. Hint parts and their padding
// are separate injected decorations, but share one model insertion point.
export function hintRuns(ed: editor.ICodeEditor, host: HTMLElement, line: number, clientY: number) {
    const runs = new Map<number, {left: number, right: number}>()
    const columns = new Set<number>()
    for (const d of ed.getLineDecorations(line) ?? []) {
        if (d.options.before?.inlineClassName?.endsWith(' te2-inlay-cursor-stop')) columns.add(d.range.startColumn)
        if (d.options.after?.inlineClassName?.endsWith(' te2-inlay-cursor-stop')) columns.add(d.range.endColumn)
    }
    if (!columns.size) return runs
    const row = Array.from(host.querySelectorAll<HTMLElement>('.view-lines > .view-line')).find(node => {
        const r = node.getBoundingClientRect()
        return clientY >= r.top && clientY < r.bottom
    })
    if (!row) return runs
    for (const el of row.querySelectorAll<HTMLElement>('.te2-inlay-cursor-stop')) {
        const r = el.getBoundingClientRect()
        const p = ed.getTargetAtClientPoint((r.left + r.right) / 2, clientY)?.position
        if (!p || p.lineNumber !== line || !columns.has(p.column)) continue
        const prev = runs.get(p.column)
        runs.set(p.column, {left: Math.min(prev?.left ?? r.left,r.left), right: Math.max(prev?.right ?? r.right,r.right)})
    }
    return runs
}

export function touchCoords(ed: editor.ICodeEditor, p: IPosition) {
    const pos = ed.getScrolledVisiblePosition(p), host = ed.getDomNode()
    if (!pos || !host || !host.offsetWidth || !host.offsetHeight) return pos
    const r = host.getBoundingClientRect(), sx = r.width / host.offsetWidth
    if (!sx || !r.height) return pos
    const runs = hintRuns(ed,host,p.lineNumber,r.top+(pos.top+pos.height/2)*r.height/host.offsetHeight)
    const hint = runs.get(p.column)
    return hint ? {...pos,left:(hint.right-r.left)/sx} : pos
}
