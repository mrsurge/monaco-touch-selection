type DebugPayload = Record<string, unknown>

export type TouchSelectionDebugOptions = {
    capacity?: number,
    candidateRadius?: number,
    captureMoves?: boolean,
    clearExisting?: boolean,
}

export type TouchSelectionDebugSnapshotOptions = {
    dragId?: number,
    instanceId?: number,
    limit?: number,
}

type DebugRecord = DebugPayload & {
    sequence: number,
    timestamp: number,
    elapsed: number,
    type: string,
}

const DEFAULT_CAPACITY = 1024
const MAX_CAPACITY = 20_000
const DEFAULT_CANDIDATE_RADIUS = 3
const MAX_CANDIDATE_RADIUS = 12

let enabled = false
let capacity = DEFAULT_CAPACITY
let candidateRadius = DEFAULT_CANDIDATE_RADIUS
let captureMoves = true
let nextSequence = 1
let nextInstanceId = 1
let nextDragId = 1
let records: DebugRecord[] = []
const instances = new Map<number, {registeredAt: number}>()

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number) => {
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(value as number)))
}

const debugStatus = () => ({
    enabled,
    capacity,
    candidateRadius,
    captureMoves,
    recordCount: records.length,
    instanceIds: Array.from(instances.keys()),
})

export const isTouchSelectionDebugEnabled = () => enabled

export const shouldCaptureTouchSelectionMoves = () => enabled && captureMoves

export const getTouchSelectionDebugCandidateRadius = () => candidateRadius

export const recordTouchSelectionDebug = (type: string, payload: DebugPayload = {}) => {
    if (!enabled) return
    records.push({
        sequence: nextSequence++,
        timestamp: Date.now(),
        elapsed: performance.now(),
        type,
        ...payload,
    })
    if (records.length > capacity) records.splice(0, records.length - capacity)
}

export const registerTouchSelectionDebugInstance = () => {
    const instanceId = nextInstanceId++
    instances.set(instanceId, {registeredAt: Date.now()})
    recordTouchSelectionDebug('instance-register', {instanceId})
    return instanceId
}

export const unregisterTouchSelectionDebugInstance = (instanceId: number) => {
    recordTouchSelectionDebug('instance-dispose', {instanceId})
    instances.delete(instanceId)
}

export const nextTouchSelectionDebugDragId = () => nextDragId++

export const describeDebugPosition = (position: {
    lineNumber?: number,
    column?: number,
} | null | undefined) => position ? {
    lineNumber: position.lineNumber ?? null,
    column: position.column ?? null,
} : null

export const describeDebugSelection = (selection: {
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
    selectionStartLineNumber?: number,
    selectionStartColumn?: number,
    positionLineNumber?: number,
    positionColumn?: number,
} | null | undefined) => selection ? {
    startLineNumber: selection.startLineNumber,
    startColumn: selection.startColumn,
    endLineNumber: selection.endLineNumber,
    endColumn: selection.endColumn,
    selectionStartLineNumber: selection.selectionStartLineNumber ?? null,
    selectionStartColumn: selection.selectionStartColumn ?? null,
    positionLineNumber: selection.positionLineNumber ?? null,
    positionColumn: selection.positionColumn ?? null,
} : null

export const describeDebugTouch = (touch: Touch | null | undefined) => touch ? {
    identifier: touch.identifier,
    clientX: touch.clientX,
    clientY: touch.clientY,
    pageX: touch.pageX,
    pageY: touch.pageY,
    screenX: touch.screenX,
    screenY: touch.screenY,
    radiusX: touch.radiusX,
    radiusY: touch.radiusY,
    rotationAngle: touch.rotationAngle,
    force: touch.force,
} : null

export const describeDebugRect = (rect: DOMRect | DOMRectReadOnly | null | undefined) => rect ? {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
} : null

const describeDebugElement = (element: Element) => ({
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    classes: Array.from(element.classList).slice(0, 8),
})

export const describeDebugHitStack = (clientX: number, clientY: number) => {
    try {
        return document.elementsFromPoint(clientX, clientY).slice(0, 8).map(describeDebugElement)
    } catch (error) {
        return [{error: error instanceof Error ? error.message : String(error)}]
    }
}

export const touchSelectionDebug = {
    start(options: TouchSelectionDebugOptions = {}) {
        capacity = clampInteger(options.capacity, capacity, 64, MAX_CAPACITY)
        candidateRadius = clampInteger(
            options.candidateRadius,
            candidateRadius,
            1,
            MAX_CANDIDATE_RADIUS,
        )
        captureMoves = options.captureMoves ?? captureMoves
        if (options.clearExisting !== false) records = []
        enabled = true
        recordTouchSelectionDebug('capture-start', debugStatus())
        return debugStatus()
    },
    stop() {
        recordTouchSelectionDebug('capture-stop', debugStatus())
        enabled = false
        return debugStatus()
    },
    clear() {
        records = []
        return debugStatus()
    },
    status() {
        return debugStatus()
    },
    snapshot(options: TouchSelectionDebugSnapshotOptions = {}) {
        let selected = records
        if (options.dragId !== undefined) {
            selected = selected.filter((record) => record.dragId === options.dragId)
        }
        if (options.instanceId !== undefined) {
            selected = selected.filter((record) => record.instanceId === options.instanceId)
        }
        const limit = clampInteger(options.limit, selected.length, 0, selected.length)
        if (limit < selected.length) selected = selected.slice(selected.length - limit)
        return {
            status: debugStatus(),
            records: selected.map((record) => ({...record})),
        }
    },
    latestDrag() {
        let latest: DebugRecord | undefined
        for (let index = records.length - 1; index >= 0; index--) {
            if (typeof records[index]?.dragId === 'number') {
                latest = records[index]
                break
            }
        }
        if (!latest || typeof latest.dragId !== 'number') {
            return {status: debugStatus(), dragId: null, records: []}
        }
        const dragId = latest.dragId
        return {
            status: debugStatus(),
            dragId,
            records: records
                .filter((record) => record.dragId === dragId)
                .map((record) => ({...record})),
        }
    },
}
