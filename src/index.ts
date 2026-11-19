import {editor, type IPosition, type IRange} from "monaco-editor/esm/vs/editor/editor.api.js"
import {
    describeDebugHitStack,
    describeDebugPosition,
    describeDebugRect,
    describeDebugSelection,
    describeDebugTouch,
    getTouchSelectionDebugCandidateRadius,
    isTouchSelectionDebugEnabled,
    nextTouchSelectionDebugDragId,
    recordTouchSelectionDebug,
    registerTouchSelectionDebugInstance,
    shouldCaptureTouchSelectionMoves,
    unregisterTouchSelectionDebugInstance,
} from "./debug.js"

export {
    touchSelectionDebug,
    type TouchSelectionDebugOptions,
    type TouchSelectionDebugSnapshotOptions,
} from "./debug.js"

type ICodeEditor = editor.ICodeEditor;
import { createSelectionLens } from './selection-lens.js'

const OPTION_FontSize_FALLBACK = 52
const OPTION_LineHeight_FALLBACK = 67

const DEFAULT_SELECTION_SYNC_TIMEOUT = 300
const DOUBLE_TAP_HANDLE_DELAY = 450
const HANDLE_PULSE_MS = 100
const REVEAL_INTERVAL = 50
const HANDLE_IDLE_MS = 75
const TOUCH_CONTEXT_MENU_WINDOW = 2000
const SELECTION_MENU_SCROLL_SETTLE_TIMEOUT = 90
export const OPEN_SELECTOR_MENU_EVENT = 'monaco-touch-selection:open-menu'

export type SelectorMenuTool = {
    name: string,
    innerHTML: string | Element | (() => string | Element),
    action: (() => Promise<void>) | (() => void)
}

export enum DefaultToolName {
    Copy = 'copy',
    Cut = 'cut',
    Paste = 'paste',
    SelectWord = 'selectWord',
    SelectAll = 'selectAll',
    GrowSelectionLeft = 'growSelectionLeft',
    GrowSelectionRight = 'growSelectionRight',
    ShrinkSelectionLeft = 'shrinkSelectionLeft',
    ShrinkSelectionRight = 'shrinkSelectionRight',
    Hover = 'hover',
    Find = 'find',
    Mention = 'mention',
    ReadOnly = 'readOnly',
    Undo = 'undo',
    Redo = 'redo',
    Close = 'close',
}

export type SelectorMenuToolConfig =
    (options: {
        editor: ICodeEditor,
        selectorMenu: HTMLDivElement,
        defaultTools: Map<DefaultToolName, SelectorMenuTool>,
        openMenu: () => void,
        closeMenu: () => void,
    }) => Iterable<SelectorMenuTool> | undefined


type Selector = HTMLDivElement & {
    bottomCursor: HTMLDivElement,
    textCursor: HTMLDivElement,
}

const updateSelectionStart = (selection: IRange, position: IPosition): IRange => {
    return {
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: selection.endLineNumber,
        endColumn: selection.endColumn
    }
}

const updateSelectionEnd = (selection: IRange, position: IPosition): IRange => {
    return {
        startLineNumber: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column
    }
}

// 当触点移动到上下边缘时，尝试垂直滚动
const scrollTopExtremityFit = (editor: ICodeEditor, touch: Touch, lineHeight: number) => {
    const scrollTop = editor.getScrollTop()

    const scrollHeight = editor.getScrollHeight()
    const viewHeight = editor.getLayoutInfo().height
    const maxScrollTop = Math.max(0, scrollHeight - viewHeight)

    const canScrollUp = scrollTop > 0
    const canScrollDown = scrollTop < maxScrollTop

    const previousTarget = editor.getTargetAtClientPoint(touch.clientX, touch.clientY - lineHeight)
    const nextTarget = editor.getTargetAtClientPoint(touch.clientX, touch.clientY + lineHeight)
    if (previousTarget === null && nextTarget !== null && canScrollUp) {
        // 触发向上滚动
        const newScrollTop = Math.max(0, scrollTop - lineHeight)
        editor.setScrollTop(newScrollTop, 0)
    } else if (previousTarget !== null && nextTarget === null && canScrollDown) {
        // 触发向下滚动
        const newScrollTop = Math.min(maxScrollTop, scrollTop + lineHeight)
        editor.setScrollTop(newScrollTop, 0)
    }
}

// 当触点移动到左右边缘时，尝试水平滚动
const scrollLeftExtremityFit = (editor: ICodeEditor, touch: Touch, letterWidth: number) => {
    const scrollLeft = editor.getScrollLeft()

    const scrollWidth = editor.getScrollWidth()
    const viewWidth = editor.getLayoutInfo().width
    const maxScrollLeft = Math.max(0, scrollWidth - viewWidth)

    const canScrollLeft = scrollLeft > 0
    const canScrollRight = scrollLeft < maxScrollLeft

    const previousTarget = editor.getTargetAtClientPoint(touch.clientX - letterWidth, touch.clientY)
    const nextTarget = editor.getTargetAtClientPoint(touch.clientX + letterWidth, touch.clientY)
    if (previousTarget === null && nextTarget !== null && canScrollLeft) {
        // 触发向左滚动
        const newScrollLeft = Math.max(0, scrollLeft - letterWidth)
        editor.setScrollLeft(newScrollLeft, 0)
    } else if (previousTarget !== null && nextTarget === null && canScrollRight) {
        // 触发向右滚动
        const newScrollLeft = Math.min(maxScrollLeft, scrollLeft + letterWidth)
        editor.setScrollLeft(newScrollLeft, 0)
    }
}

const attachTouchSelectionView = (
    editor: ICodeEditor,
    options?: {
        tools?: SelectorMenuToolConfig,
        leadingTools?: SelectorMenuToolConfig,
        navigationTools?: SelectorMenuToolConfig,
        mobile?: boolean,
        historicalReadOnly?: boolean,
        selectionSyncTimeout?: number | undefined,
        toolActionErrorHandler?: (name: string, error: Error | unknown) => Promise<void> | void,
    }
) => {
    const {
        tools,
        leadingTools,
        navigationTools,
        mobile = false,
        historicalReadOnly = false,
        selectionSyncTimeout = DEFAULT_SELECTION_SYNC_TIMEOUT,
        toolActionErrorHandler = (name: string, error: Error | unknown) => {
            console.error(`tool ${name} cause error: `, error)
        },
    } = options ?? {}

    if (!editor) {
        throw new Error("editor not existed")
    }

    // Resolve EditorOption enum values at call time (Monaco must be loaded by now)
    const _EditorOption = (globalThis as any).monaco?.editor?.EditorOption
    const OPTION_FontSize: number = _EditorOption?.fontSize ?? OPTION_FontSize_FALLBACK
    const OPTION_LineHeight: number = _EditorOption?.lineHeight ?? OPTION_LineHeight_FALLBACK

    const element = editor.getDomNode()
    if (!element || !(element instanceof HTMLElement)) {
        throw new Error("editor container element not existed or it is not a HTMLElement")
    }

    const editorOverlayGuard = element.querySelector('.overflow-guard')
    if (!editorOverlayGuard || !(editorOverlayGuard instanceof HTMLElement)) {
        throw new Error("no overlay guard or it is not a HTMLElement")
    }

    const debugInstanceId = registerTouchSelectionDebugInstance()
    let disposed = false
    const subscriptions: {dispose(): void}[] = []
    const viewEvents = new AbortController()
    const recordDebug = (type: string, payload: Record<string, unknown> = {}) => {
        recordTouchSelectionDebug(type, {
            instanceId: debugInstanceId,
            modelUri: editor.getModel()?.uri.toString() ?? null,
            ...payload,
        })
    }

    let selectionsShow = false
    let selections: HTMLDivElement | null = null
    let handleHitTimer: ReturnType<typeof setTimeout> | undefined
    // The first tap may create a caret handle directly over the second tap.
    // Keep it visible but inert until Monaco's double-tap window has closed.
    const deferCaretHandle = () => {
        clearTimeout(handleHitTimer)
        selections?.classList.add('tap-pending')
        handleHitTimer = setTimeout(() => {
            selections?.classList.remove('tap-pending')
        }, DOUBLE_TAP_HANDLE_DELAY)
    }
    const releaseHandleDelay = () => {
        clearTimeout(handleHitTimer)
        selections?.classList.remove('tap-pending')
    }
    let leftSelector: Selector | null = null
    let rightSelector: Selector | null = null
    const showSelections = () => {
        if (!selections) return
        if (selectionsShow) return
        selectionsShow = true
        selections.classList.add('show')
    }
    const hideSelections = () => {
        if (!selections) return
        if (!selectionsShow) return
        selectionsShow = false
        selections.classList.remove('show')
    }

    let selectorMenuShow = false
    let selectorMenuStack: HTMLDivElement | null = null
    let selectorUtilityMenuRow: HTMLDivElement | null = null
    let selectorMenu: HTMLDivElement | null = null
    let selectorLeadingMenu: HTMLDivElement | null = null
    let selectorNavigationMenu: HTMLDivElement | null = null
    let menuOutsideMouseDownHandler: ((event: MouseEvent) => void) | null = null
    let lastTouchInteractionAt = 0
    let selectorMenuBoundToSelection = false
    let selectorMenuScrollTimer: number | undefined = undefined
    let selectorMenuScrollFrame: number | undefined = undefined
    // Track menu items with dynamic (function) innerHTML for refresh on show.
    const _dynamicMenuItems: { el: HTMLDivElement, fn: () => string | Element }[] = []
    // Suppress auto-hide while a right-click or touch-handle flow opens the menus.
    let _menuGuard = false
    let activeDragDebug: {dragId: number, handle: 'left' | 'right'} | null = null
    let activeDragCleanup: ((reason: string) => void) | null = null
    const cancelActiveDrag = (reason = 'cancelled') => {
        const cleanup = activeDragCleanup
        activeDragCleanup = null
        cleanup?.(reason)
        _menuGuard = false
    }
    const cancelDragOnWindowBlur = () => cancelActiveDrag('window-blur')
    const cancelDragWhenHidden = () => {
        if (document.hidden) cancelActiveDrag('document-hidden')
    }
    window.addEventListener('blur', cancelDragOnWindowBlur)
    document.addEventListener('visibilitychange', cancelDragWhenHidden)
    const showSelectorMenu = () => {
        if (!selectorMenuStack) return
        // Refresh dynamic icons (e.g. readOnly toggle color).
        for (const d of _dynamicMenuItems) {
            const r = d.fn()
            d.el.innerHTML = typeof r === 'string' ? r : ''
            if (typeof r !== 'string') d.el.appendChild(r)
        }
        if (selectorMenuShow) return
        selectorMenuShow = true
        selectorMenuStack.classList.add('show')
    }
    const clearSelectorMenuScrollRestore = () => {
        clearTimeout(selectorMenuScrollTimer)
        selectorMenuScrollTimer = undefined
        if (selectorMenuScrollFrame !== undefined) {
            cancelAnimationFrame(selectorMenuScrollFrame)
            selectorMenuScrollFrame = undefined
        }
        selectorMenuStack?.classList.remove('scroll-repositioning')
    }
    const unbindSelectorMenuFromSelection = () => {
        selectorMenuBoundToSelection = false
        clearSelectorMenuScrollRestore()
    }
    const forceHideSelectorMenu = () => {
        if (!selectorMenuStack) return
        unbindSelectorMenuFromSelection()
        selectorMenuShow = false
        selectorMenuStack.classList.remove('show')
    }
    const hideSelectorMenu = () => {
        if (!selectorMenuStack) return
        if (!selectorMenuShow) return
        if (_menuGuard) return
        forceHideSelectorMenu()
    }

    const positionSelectorMenus = (
        anchorX: number,
        preferredAboveY: number,
        fallbackBelowY: number,
        touchMode: boolean,
        edge: 'none' | 'top' | 'bottom' = 'none',
    ) => {
        if (!selectorMenuStack) return
        selectorMenuStack.classList.toggle('touch-mode', touchMode)
        showSelectorMenu()

        const stackRect = selectorMenuStack.getBoundingClientRect()
        const stackWidth = stackRect.width
        const stackHeight = stackRect.height

        const viewportLeft = window.visualViewport?.offsetLeft ?? document.documentElement.offsetLeft
        const viewportTop = window.visualViewport?.offsetTop ?? document.body.offsetTop
        const viewportRight = window.visualViewport
            ? window.visualViewport.offsetLeft + window.visualViewport.width
            : document.documentElement.offsetLeft + document.body.clientWidth
        const viewportBottom = window.visualViewport
            ? window.visualViewport.offsetTop + window.visualViewport.height
            : document.body.offsetTop + document.body.clientHeight

        // The root stack avoids dead hit gaps while one viewport-clamped transform
        // keeps every island aligned with the active selection handle.
        const minX = viewportLeft
        const minY = viewportTop
        const maxX = viewportRight
        const maxY = viewportBottom
        const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

        const stackX = clamp(anchorX - stackWidth / 2, minX, maxX - stackWidth)
        let stackY
        if (edge === 'bottom') {
            stackY = fallbackBelowY - stackHeight
        } else {
            stackY = preferredAboveY - stackHeight
            if (edge === 'none' && stackY < minY) stackY = fallbackBelowY
        }
        stackY = clamp(stackY, minY, maxY - stackHeight)

        selectorMenuStack.style.transform = `translateX(${stackX}px) translateY(${stackY}px)`
    }

    const positionSelectorMenuForSelection = (): boolean => {
        if (!mobile || !selectorMenuStack || !leftSelector || !rightSelector || !selectionsShow) {
            return false
        }
        if (!editor.getSelection()) return false

        // Rendered handle geometry remains authoritative for wrapped lines and
        // selections whose logical direction differs from their visual order.
        const editorRect = element.getBoundingClientRect()
        const leftRect = leftSelector.getBoundingClientRect()
        const rightRect = rightSelector.getBoundingClientRect()
        const upperRect = leftRect.top <= rightRect.top ? leftRect : rightRect
        const anchorX = upperRect.left + upperRect.width / 2
        const lineHeight = editor.getOption(OPTION_LineHeight)

        selectorMenuBoundToSelection = true
        if (upperRect.top < editorRect.top) {
            positionSelectorMenus(anchorX, editorRect.top, editorRect.top, true, 'top')
        } else if (upperRect.top >= editorRect.bottom) {
            positionSelectorMenus(anchorX, editorRect.bottom, editorRect.bottom, true, 'bottom')
        } else {
            positionSelectorMenus(
                anchorX,
                upperRect.top,
                upperRect.bottom + lineHeight,
                true,
            )
        }
        return true
    }

    const scheduleSelectorMenuRestoreAfterScroll = () => {
        if (!selectorMenuBoundToSelection || !selectorMenuShow || !selectorMenuStack) return

        // Keep the stack measurable but non-interactive until Monaco has
        // committed the final handle transform for this scroll sequence.
        selectorMenuStack.classList.add('scroll-repositioning')
        clearTimeout(selectorMenuScrollTimer)
        if (selectorMenuScrollFrame !== undefined) {
            cancelAnimationFrame(selectorMenuScrollFrame)
            selectorMenuScrollFrame = undefined
        }
        selectorMenuScrollTimer = window.setTimeout(() => {
            selectorMenuScrollTimer = undefined
            selectorMenuScrollFrame = requestAnimationFrame(() => {
                selectorMenuScrollFrame = undefined
                if (!selectorMenuBoundToSelection || !selectorMenuShow) {
                    selectorMenuStack?.classList.remove('scroll-repositioning')
                    return
                }
                if (!positionSelectorMenuForSelection()) {
                    forceHideSelectorMenu()
                    return
                }
                selectorMenuStack?.classList.remove('scroll-repositioning')
            })
        }, SELECTION_MENU_SCROLL_SETTLE_TIMEOUT)
    }

    const openSelectorMenuAtCursor = (touchMode = true) => {
        if (!selectorMenuStack) return
        const rect = element.getBoundingClientRect()
        const position = editor.getPosition()
        const visible = position ? editor.getScrolledVisiblePosition(position) : null
        const clientX = visible
            ? rect.left + visible.left
            : rect.left + rect.width / 2
        const clientY = visible
            ? rect.top + visible.top + visible.height
            : rect.top + rect.height / 2

        _menuGuard = true
        if (!touchMode || !positionSelectorMenuForSelection()) {
            unbindSelectorMenuFromSelection()
            positionSelectorMenus(clientX, clientY - 10, clientY + 10, touchMode)
        }
        setTimeout(() => { _menuGuard = false }, 0)
    }
    const openSelectorMenuEventHandler = (event: Event) => {
        const detail = (event as CustomEvent<{touchMode?: boolean}>).detail
        openSelectorMenuAtCursor(detail?.touchMode !== false)
    }
    element.addEventListener(OPEN_SELECTOR_MENU_EVENT, openSelectorMenuEventHandler, {signal: viewEvents.signal})

    let resizeOb: ResizeObserver | null = new ResizeObserver(() => {
        hideSelections()
        hideSelectorMenu()

        const selection = editor.getSelection()
        if (selection) debounceSyncSelectionTransform(selection)
    })
    resizeOb.observe(element)

    const dispose = () => {
        if (disposed) return
        disposed = true
        viewEvents.abort()
        for (const subscription of subscriptions) subscription.dispose()
        clearTimeout(syncSelectorTimer)
        clearTimeout(handleHitTimer)
        cancelActiveDrag('editor-dispose')
        clearSelectorMenuScrollRestore()
        unregisterTouchSelectionDebugInstance(debugInstanceId)
        window.removeEventListener('blur', cancelDragOnWindowBlur)
        document.removeEventListener('visibilitychange', cancelDragWhenHidden)
        element.removeEventListener(OPEN_SELECTOR_MENU_EVENT, openSelectorMenuEventHandler)
        if (menuOutsideMouseDownHandler) {
            document.removeEventListener('mousedown', menuOutsideMouseDownHandler)
            menuOutsideMouseDownHandler = null
        }
        resizeOb?.disconnect()
        resizeOb = null

        selections?.remove()
        leftSelector?.remove()
        rightSelector?.remove()
        selectorMenuStack?.remove()

        selections = null
        leftSelector = null
        rightSelector = null
        selectorMenuStack = null
        selectorUtilityMenuRow = null
        selectorMenu = null
        selectorLeadingMenu = null
        selectorNavigationMenu = null
    }

    const selectAll = () => {
        editor.focus()
        const model = editor.getModel()
        if (model) {
            const fullRange = model.getFullModelRange()
            editor.setSelection(fullRange)
        }
    }

    const previousModelPosition = (position: IPosition): IPosition => {
        const model = editor.getModel()
        if (!model) return position
        if (position.column > 1) {
            return {lineNumber: position.lineNumber, column: position.column - 1}
        }
        if (position.lineNumber > 1) {
            const lineNumber = position.lineNumber - 1
            return {lineNumber, column: model.getLineMaxColumn(lineNumber)}
        }
        return position
    }

    const nextModelPosition = (position: IPosition): IPosition => {
        const model = editor.getModel()
        if (!model) return position
        const maxColumn = model.getLineMaxColumn(position.lineNumber)
        if (position.column < maxColumn) {
            return {lineNumber: position.lineNumber, column: position.column + 1}
        }
        if (position.lineNumber < model.getLineCount()) {
            return {lineNumber: position.lineNumber + 1, column: 1}
        }
        return position
    }

    const growSelectionLeft = () => {
        const selection = editor.getSelection()
        if (!selection) return
        const start = selection.getStartPosition()
        const previous = previousModelPosition(start)
        editor.setSelection({
            startLineNumber: previous.lineNumber,
            startColumn: previous.column,
            endLineNumber: selection.endLineNumber,
            endColumn: selection.endColumn,
        })
    }

    const growSelectionRight = () => {
        const selection = editor.getSelection()
        if (!selection) return
        const end = selection.getEndPosition()
        const next = nextModelPosition(end)
        editor.setSelection({
            startLineNumber: selection.startLineNumber,
            startColumn: selection.startColumn,
            endLineNumber: next.lineNumber,
            endColumn: next.column,
        })
    }

    const shrinkSelectionLeft = () => {
        const selection = editor.getSelection()
        if (!selection || selection.isEmpty()) return
        const next = nextModelPosition(selection.getStartPosition())
        editor.setSelection({
            startLineNumber: next.lineNumber,
            startColumn: next.column,
            endLineNumber: selection.endLineNumber,
            endColumn: selection.endColumn,
        })
    }

    const shrinkSelectionRight = () => {
        const selection = editor.getSelection()
        if (!selection || selection.isEmpty()) return
        const previous = previousModelPosition(selection.getEndPosition())
        editor.setSelection({
            startLineNumber: selection.startLineNumber,
            startColumn: selection.startColumn,
            endLineNumber: previous.lineNumber,
            endColumn: previous.column,
        })
    }

    const resolveTouchPosition = (
        clientX: number,
        clientY: number,
        debugContext?: {dragId: number, sampleId: number, source: string},
    ): IPosition | null => {
        const debugEnabled = isTouchSelectionDebugEnabled()
        const target = editor.getTargetAtClientPoint(clientX, clientY)
        const targetSummary = debugEnabled && target ? {
            type: target.type,
            mouseColumn: target.mouseColumn,
            position: describeDebugPosition(target.position),
            range: describeDebugSelection(target.range),
        } : null
        const debugBase = debugEnabled ? {
            ...debugContext,
            clientX,
            clientY,
            target: targetSummary,
            hitStack: describeDebugHitStack(clientX, clientY),
        } : null
        const recordResolution = (
            outcome: string,
            position: IPosition | null,
            details?: () => Record<string, unknown>,
        ) => {
            if (!debugBase) return
            recordDebug('resolve', {
                ...debugBase,
                outcome,
                resolvedPosition: describeDebugPosition(position),
                ...(details?.() ?? {}),
            })
        }
        if (!target?.position) {
            recordResolution('target-missing', null)
            return null
        }

        const model = editor.getModel()
        if (!model) {
            recordResolution('fallback-model-missing', target.position)
            return target.position
        }

        const lineNumber = target.position.lineNumber
        const maxColumn = model.getLineMaxColumn(lineNumber)
        const layout = editor.getLayoutInfo()
        const editorRect = element.getBoundingClientRect()
        const targetOffset = clientX - editorRect.left - layout.contentLeft + editor.getScrollLeft()
        const geometry = debugEnabled ? {
            editorRect: describeDebugRect(editorRect),
            contentLeft: layout.contentLeft,
            contentWidth: layout.contentWidth,
            targetOffset,
            scrollLeft: editor.getScrollLeft(),
            scrollTop: editor.getScrollTop(),
            visualViewport: window.visualViewport ? {
                offsetLeft: window.visualViewport.offsetLeft,
                offsetTop: window.visualViewport.offsetTop,
                width: window.visualViewport.width,
                height: window.visualViewport.height,
                scale: window.visualViewport.scale,
            } : null,
        } : null

        // Resolve against every rendered caret boundary in the visual row. The
        // point target chooses the row only; it is not the horizontal authority.
        try {
            const contentLeft = editorRect.left + layout.contentLeft
            const contentRight = contentLeft + Math.max(1, layout.contentWidth) - 1
            const rowStart = editor.getTargetAtClientPoint(contentLeft, clientY)?.position
            const rowEnd = editor.getTargetAtClientPoint(contentRight, clientY)?.position

            if (rowStart?.lineNumber !== lineNumber || rowEnd?.lineNumber !== lineNumber) {
                recordResolution('fallback-row-bounds', target.position, () => ({
                    geometry,
                    lineNumber,
                    maxColumn,
                    rowStart: describeDebugPosition(rowStart),
                    rowEnd: describeDebugPosition(rowEnd),
                }))
                return target.position
            }
            let low = Math.min(rowStart.column, rowEnd.column, target.position.column)
            let high = Math.max(rowStart.column, rowEnd.column, target.position.column)
            low = Math.max(1, low)
            high = Math.min(maxColumn, high)
            const searchLow = low
            const searchHigh = high

            while (low < high) {
                const middle = Math.floor((low + high) / 2)
                const offset = editor.getOffsetForColumn(lineNumber, middle)
                if (offset < 0) {
                    recordResolution('fallback-search-offset', target.position, () => ({
                        geometry,
                        lineNumber,
                        column: middle,
                        offset,
                        searchLow,
                        searchHigh,
                    }))
                    return target.position
                }
                if (offset < targetOffset) low = middle + 1
                else high = middle
            }

            const rightColumn = low
            const leftColumn = Math.max(1, rightColumn - 1)
            const rightOffset = editor.getOffsetForColumn(lineNumber, rightColumn)
            const leftOffset = editor.getOffsetForColumn(lineNumber, leftColumn)
            if (rightOffset < 0 || leftOffset < 0) {
                recordResolution('fallback-final-offset', target.position, () => ({
                    geometry,
                    lineNumber,
                    leftColumn,
                    leftOffset,
                    rightColumn,
                    rightOffset,
                    searchLow,
                    searchHigh,
                }))
                return target.position
            }

            const column = Math.abs(targetOffset - leftOffset) <= Math.abs(rightOffset - targetOffset)
                ? leftColumn
                : rightColumn
            const position = {lineNumber, column}
            const candidateOffsets: {column: number, offset: number, distance: number}[] = []
            if (debugEnabled) {
                const radius = getTouchSelectionDebugCandidateRadius()
                const candidateStart = Math.max(1, leftColumn - radius)
                const candidateEnd = Math.min(maxColumn, rightColumn + radius)
                for (let candidateColumn = candidateStart; candidateColumn <= candidateEnd; candidateColumn++) {
                    const offset = editor.getOffsetForColumn(lineNumber, candidateColumn)
                    candidateOffsets.push({
                        column: candidateColumn,
                        offset,
                        distance: offset < 0 ? -1 : Math.abs(targetOffset - offset),
                    })
                }
            }
            recordResolution('resolved', position, () => ({
                geometry,
                lineNumber,
                maxColumn,
                rowStart: describeDebugPosition(rowStart),
                rowEnd: describeDebugPosition(rowEnd),
                searchLow,
                searchHigh,
                leftColumn,
                leftOffset,
                rightColumn,
                rightOffset,
                candidateOffsets,
            }))
            return position
        } catch (error) {
            recordResolution('fallback-exception', target.position, () => ({
                geometry,
                error: error instanceof Error ? error.message : String(error),
            }))
            return target.position
        }
    }

    const copy = async (): Promise<boolean> => {
        try {
            const selection = editor.getSelection()
            if (!selection) return false
            const selectedText = editor.getModel()?.getValueInRange(selection)
            if (!selectedText) return false
            await navigator.clipboard.writeText(selectedText)
            return true
        } catch (e) {
            await toolActionErrorHandler(`copy fail: ${e}`, e)
            return false
        }
    }

    const cut = async (): Promise<boolean> => {
        try {
            const selection = editor.getSelection()
            if (!selection) return false
            const selectedText = editor.getModel()?.getValueInRange(selection)
            if (!selectedText) return false
            await navigator.clipboard.writeText(selectedText)
            editor.executeEdits('cut', [{range: selection, text: ''}])
            return true
        } catch (e) {
            await toolActionErrorHandler('cut', e)
            return false
        }
    }

    const paste = async (): Promise<boolean> => {
        try {
            const selection = editor.getSelection()
            if (!selection) return false

            const text = await navigator.clipboard.readText()
            if (text.length === 0) return false

            editor.executeEdits('paste', [{range: selection, text: text}])
            return true
        } catch (e) {
            await toolActionErrorHandler('paste', e)
            return false
        }
    }

    const undo = () => {
        editor.trigger('keyboard', 'undo', null)
    }

    const redo = () => {
        editor.trigger('keyboard', 'redo', null)
    }

    const sameSelectorBottomTransform = "translateX(-50%) translateY(25%) rotate(45deg)"
    const leftSelectorBottomTransform = "translateX(-100%) rotate(90deg)"
    const rightSelectorBottomTransform = ""

    const syncSelectionTransform = (selection: IRange) => {
        if (!leftSelector || !rightSelector) return

        const startPosition: IPosition = {
            lineNumber: selection.startLineNumber,
            column: selection.startColumn
        }
        const endPosition: IPosition = {
            lineNumber: selection.endLineNumber,
            column: selection.endColumn
        }

        // Get the position of the start and end of the selection in client coordinates
        const scrollLeft = editor.getScrollLeft()
        const scrollTop = editor.getScrollTop()
        const startCoords = editor.getScrolledVisiblePosition(startPosition)
        const endCoords = editor.getScrolledVisiblePosition(endPosition)

        if (!startCoords || !endCoords) return

        // Get the top position of the start and end lines
        const startTop = editor.getTopForPosition(startPosition.lineNumber, startPosition.column)
        const endTop = editor.getTopForPosition(endPosition.lineNumber, endPosition.column)

        // Monaco positions include the gutter. The overlay is rooted at the
        // editor origin and translates document coordinates by the scroll offset.
        if (selections) {
            selections.style.top = `-${scrollTop}px`
            selections.style.left = `-${scrollLeft}px`
        }
        const leftSelectorX = startCoords.left + scrollLeft
        const leftSelectorY = startTop
        const rightSelectorX = endCoords.left + scrollLeft
        const rightSelectorY = endTop

        leftSelector.style.opacity = "1"
        rightSelector.style.opacity = "1"
        selections?.classList.remove('position-pending')

        leftSelector.style.transform = `translateX(${leftSelectorX}px) translateY(${leftSelectorY}px)`
        rightSelector.style.transform = `translateX(${rightSelectorX}px) translateY(${rightSelectorY}px)`

        if (leftSelectorX === rightSelectorX && leftSelectorY === rightSelectorY) {
            leftSelector.bottomCursor.style.transform = sameSelectorBottomTransform
            rightSelector.bottomCursor.style.transform = sameSelectorBottomTransform
        } else {
            leftSelector.bottomCursor.style.transform = leftSelectorBottomTransform
            rightSelector.bottomCursor.style.transform = rightSelectorBottomTransform
        }
    }

    let lastSyncTime = 0
    let syncSelectorTimer: number | undefined = undefined

    const debounceSyncSelectionTransform = (selection: IRange) => {
        clearTimeout(syncSelectorTimer)
        if (!leftSelector || !rightSelector) return
        const currentSyncTime = Date.now()
        if (currentSyncTime - lastSyncTime < selectionSyncTimeout) {
            lastSyncTime = currentSyncTime
            leftSelector.style.opacity = "0"
            rightSelector.style.opacity = "0"
            selections?.classList.add('position-pending')
            syncSelectorTimer = window.setTimeout(() => {
                syncSelectionTransform(selection)
            }, selectionSyncTimeout)
            return
        } else {
            lastSyncTime = currentSyncTime
            syncSelectionTransform(selection)
        }
    }


    const toSelector = (element: HTMLDivElement): Selector => {
        element.classList.add('selector')

        const textCursor = document.createElement('div')
        textCursor.classList.add('text-cursor')
        element.appendChild(textCursor)

        const bottomCursor = document.createElement('div')
        bottomCursor.classList.add('bottom-cursor')
        element.appendChild(bottomCursor)

        const selector = element as Selector
        selector.textCursor = textCursor
        selector.bottomCursor = bottomCursor

        return selector
    }

    const initSelections = () => {
        selections = document.createElement('div')
        selections.classList.add('monaco-editor-touch-selections')

        const leftSelectorEl = document.createElement('div')
        leftSelectorEl.classList.add('left')
        leftSelector = toSelector(leftSelectorEl)
        selections.appendChild(leftSelectorEl)

        const rightSelectorEl = document.createElement('div')
        rightSelectorEl.classList.add('right')
        rightSelector = toSelector(rightSelectorEl)
        selections.appendChild(rightSelectorEl)

        let lineHeight = editor.getOption(OPTION_LineHeight)
        let fontSize = editor.getOption(OPTION_FontSize)

        const syncSelectorStyle = (lineHeight: number) => {
            if (leftSelector) {
                leftSelector.textCursor.style.height = `${lineHeight}px`
                leftSelector.bottomCursor.style.top = `${lineHeight}px`
                leftSelector.bottomCursor.style.marginTop = '0'
            }
            if (rightSelector) {
                rightSelector.textCursor.style.height = `${lineHeight}px`
                rightSelector.bottomCursor.style.top = `${lineHeight}px`
                rightSelector.bottomCursor.style.marginTop = '0'
            }
        }
        syncSelectorStyle(lineHeight)
        subscriptions.push(editor.onDidChangeConfiguration((e) => {
            lineHeight = editor.getOption(OPTION_LineHeight)
            syncSelectorStyle(lineHeight)
            if (e.hasChanged(OPTION_FontSize)) {
                fontSize = editor.getOption(OPTION_FontSize)
            }
        }))

        editorOverlayGuard.append(selections)
        const syncCurrentSelection = () => {
            const selection = editor.getSelection()
            if (selection) debounceSyncSelectionTransform(selection)
        }
        subscriptions.push(editor.onDidLayoutChange(syncCurrentSelection))
        subscriptions.push(editor.onDidContentSizeChange(syncCurrentSelection))
        syncCurrentSelection()
        subscriptions.push(editor.onDidScrollChange((e) => {
            if (selections) {
                selections.style.top = `-${e.scrollTop}px`
                selections.style.left = `-${e.scrollLeft}px`
            }
            scheduleSelectorMenuRestoreAfterScroll()
        }))

        const setupSelectorTouchEvent = (
            selector: Selector,
            updateSelection: (selection: IRange, position: IPosition) => IRange
        ) => {
            const showSelectionMenuByTouch = () => positionSelectorMenuForSelection()

            selector.bottomCursor.addEventListener('touchstart', (event: TouchEvent) => {
                const initialSelection = editor.getSelection()
                if (!initialSelection) return

                let touch = event.changedTouches[0] ?? event.touches[0]
                if (!touch) return
                cancelActiveDrag('replaced')
                const lens = createSelectionLens(editor, editorOverlayGuard)
                let fingerMovedSinceSample = false
                let stopTimer: ReturnType<typeof setTimeout> | undefined
                const stopHaptics = () => {
                    if (stopTimer === undefined) return
                    clearTimeout(stopTimer)
                    stopTimer = undefined
                    try { navigator.vibrate?.(0) } catch { /* Client may have suspended haptics. */ }
                }
                const pulseOnJump = () => {
                    if (!fingerMovedSinceSample || !navigator.vibrate) return
                    try {
                        navigator.vibrate(HANDLE_PULSE_MS)
                        clearTimeout(stopTimer)
                        stopTimer = setTimeout(stopHaptics, HANDLE_IDLE_MS)
                    } catch { /* Haptics are optional. */ }
                }
                const previousMenuWasVisible = selectorMenuShow
                forceHideSelectorMenu()
                const handle = selector.classList.contains('left') ? 'left' : 'right'
                const dragId = nextTouchSelectionDebugDragId()
                const recordDragDebug = (type: string, payload: () => Record<string, unknown>) => {
                    if (isTouchSelectionDebugEnabled()) recordDebug(type, payload())
                }
                activeDragDebug = {dragId, handle}
                _menuGuard = true
                clearTimeout(syncSelectorTimer)
                syncSelectorTimer = undefined
                const initialSelectorRect = isTouchSelectionDebugEnabled()
                    ? selector.getBoundingClientRect()
                    : null
                selections?.classList.add('dragging')
                if (leftSelector) leftSelector.style.opacity = "0"
                if (rightSelector) rightSelector.style.opacity = "0"

                const selectionIsEmpty = initialSelection.isEmpty()

                // Preserve the point actually grabbed, in client coordinates.
                let touchOffsetX = 0
                let touchOffsetY = 0
                try {
                    const anchorPos = selector.classList.contains('left')
                        ? {lineNumber: initialSelection.startLineNumber, column: initialSelection.startColumn}
                        : {lineNumber: initialSelection.endLineNumber, column: initialSelection.endColumn}
                    const scrolledPos = editor.getScrolledVisiblePosition(anchorPos)
                    if (scrolledPos) {
                        const editorRect = element.getBoundingClientRect()
                        const sx = element.offsetWidth ? editorRect.width / element.offsetWidth : 1
                        const sy = element.offsetHeight ? editorRect.height / element.offsetHeight : 1
                        touchOffsetX = editorRect.left + scrolledPos.left * sx - touch.clientX
                        touchOffsetY = editorRect.top + (scrolledPos.top + scrolledPos.height / 2) * sy - touch.clientY
                    }
                } catch (_e) { /* ignore */ }

                recordDragDebug('drag-start', () => ({
                    dragId,
                    handle,
                    eventTimestamp: event.timeStamp,
                    touch: describeDebugTouch(touch),
                    initialSelection: describeDebugSelection(initialSelection),
                    selectorRect: describeDebugRect(initialSelectorRect),
                    leftSelectorRect: describeDebugRect(leftSelector?.getBoundingClientRect()),
                    rightSelectorRect: describeDebugRect(rightSelector?.getBoundingClientRect()),
                    touchOffsetY,
                    touchOffsetX,
                    lineHeight,
                    fontSize,
                    previousMenuWasVisible,
                    menuVisibleAtStart: selectorMenuShow,
                    handleHitTestingDisabled: selections?.classList.contains('dragging') ?? false,
                    rawHitStack: describeDebugHitStack(touch.clientX, touch.clientY),
                }))

                // Don't start the drag interval until the finger actually moves.
                // This lets taps and long-presses work without the interval
                // immediately repositioning the cursor.
                let revealTimer: ReturnType<typeof setInterval> | null = null
                let touchMoved = false
                let moveCount = 0
                let sampledMoveCount = 0
                let sampleId = 0
                let latestMoveAt = performance.now()
                const applyTouchPosition = (source: string, currentSampleId: number) => {
                    const resolverX = touch.clientX + touchOffsetX
                    const resolverY = touch.clientY + touchOffsetY
                    const position = resolveTouchPosition(
                        resolverX,
                        resolverY,
                        {dragId, sampleId: currentSampleId, source},
                    )
                    if (!position) {
                        recordDragDebug('selection-write', () => ({
                            dragId,
                            sampleId: currentSampleId,
                            source,
                            handle,
                            outcome: 'position-missing',
                            touch: describeDebugTouch(touch),
                            resolverX,
                            resolverY,
                            selection: describeDebugSelection(editor.getSelection()),
                        }))
                        return
                    }
                    lens.update(position, touch.clientY)
                    if (selectionIsEmpty) {
                        const current = editor.getPosition()
                        if (current?.lineNumber === position.lineNumber && current.column === position.column) {
                            recordDragDebug('selection-write', () => ({
                                dragId,
                                sampleId: currentSampleId,
                                source,
                                handle,
                                outcome: 'duplicate-position',
                                resolvedPosition: describeDebugPosition(position),
                                currentPosition: describeDebugPosition(current),
                            }))
                            return
                        }
                        editor.setPosition(position)
                        if (source !== 'end') pulseOnJump()
                        recordDragDebug('selection-write', () => ({
                            dragId,
                            sampleId: currentSampleId,
                            source,
                            handle,
                            outcome: 'position-applied',
                            resolvedPosition: describeDebugPosition(position),
                            beforePosition: describeDebugPosition(current),
                            afterPosition: describeDebugPosition(editor.getPosition()),
                            afterSelection: describeDebugSelection(editor.getSelection()),
                        }))
                    } else {
                        const nextSelection = updateSelection(initialSelection, position)
                        const current = editor.getSelection()
                        if (
                            current?.startLineNumber === nextSelection.startLineNumber &&
                            current.startColumn === nextSelection.startColumn &&
                            current.endLineNumber === nextSelection.endLineNumber &&
                            current.endColumn === nextSelection.endColumn
                        ) {
                            recordDragDebug('selection-write', () => ({
                                dragId,
                                sampleId: currentSampleId,
                                source,
                                handle,
                                outcome: 'duplicate-selection',
                                resolvedPosition: describeDebugPosition(position),
                                currentSelection: describeDebugSelection(current),
                                proposedSelection: describeDebugSelection(nextSelection),
                            }))
                            return
                        }
                        editor.setSelection(nextSelection)
                        if (source !== 'end') pulseOnJump()
                        recordDragDebug('selection-write', () => ({
                            dragId,
                            sampleId: currentSampleId,
                            source,
                            handle,
                            outcome: 'selection-applied',
                            resolvedPosition: describeDebugPosition(position),
                            initialSelection: describeDebugSelection(initialSelection),
                            beforeSelection: describeDebugSelection(current),
                            proposedSelection: describeDebugSelection(nextSelection),
                            afterSelection: describeDebugSelection(editor.getSelection()),
                        }))
                    }
                }
                const sampleTouchPosition = () => {
                    sampleId += 1
                    const debugEnabled = isTouchSelectionDebugEnabled()
                    const sampledAt = debugEnabled ? performance.now() : 0
                    const scrollBefore = debugEnabled ? {
                        left: editor.getScrollLeft(),
                        top: editor.getScrollTop(),
                    } : null
                    scrollTopExtremityFit(editor, touch, lineHeight)
                    scrollLeftExtremityFit(editor, touch, fontSize)
                    const scrollAfter = debugEnabled ? {
                        left: editor.getScrollLeft(),
                        top: editor.getScrollTop(),
                    } : null
                    recordDragDebug('drag-sample', () => ({
                        dragId,
                        sampleId,
                        handle,
                        touch: describeDebugTouch(touch),
                        moveCount,
                        movesSincePreviousSample: moveCount - sampledMoveCount,
                        inputAgeMs: sampledAt - latestMoveAt,
                        scrollBefore,
                        scrollAfter,
                    }))
                    sampledMoveCount = moveCount
                    applyTouchPosition('sample', sampleId)
                    fingerMovedSinceSample = false
                }
                const startRevealTimer = () => {
                    if (revealTimer !== null) return
                    sampleTouchPosition()
                    revealTimer = setInterval(sampleTouchPosition, REVEAL_INTERVAL)
                }

                const handleMove = (event: TouchEvent) => {
                    event.preventDefault()
                    const moved = event.changedTouches[0] ?? event.touches[0] ?? touch
                    if (touch.clientX !== moved.clientX || touch.clientY !== moved.clientY) fingerMovedSinceSample = true
                    touch = moved
                    touchMoved = true
                    moveCount += 1
                    latestMoveAt = performance.now()
                    if (shouldCaptureTouchSelectionMoves()) {
                        recordDebug('touch-move', {
                            dragId,
                            handle,
                            moveCount,
                            eventTimestamp: event.timeStamp,
                            touches: event.touches.length,
                            changedTouches: event.changedTouches.length,
                            touch: describeDebugTouch(touch),
                            rawHitStack: describeDebugHitStack(touch.clientX, touch.clientY),
                        })
                    }
                    startRevealTimer()
                }

                let cleaned = false
                const cleanup = (reason: string) => {
                    if (cleaned) return
                    cleaned = true
                    stopHaptics()
                    lens.dispose()
                    if (revealTimer !== null) clearInterval(revealTimer)
                    revealTimer = null
                    document.removeEventListener('touchmove', handleMove)
                    document.removeEventListener('touchend', handleEnd)
                    document.removeEventListener('touchcancel', handleEnd)
                    if (activeDragCleanup === cleanup) activeDragCleanup = null
                    selections?.classList.remove('dragging')
                    const selection = editor.getSelection()
                    if (selection) syncSelectionTransform(selection)
                    recordDragDebug('drag-cleanup', () => ({
                        dragId,
                        handle,
                        reason,
                        moveCount,
                        sampleCount: sampleId,
                        finalTouch: describeDebugTouch(touch),
                        finalSelection: describeDebugSelection(selection),
                        leftSelectorRect: describeDebugRect(leftSelector?.getBoundingClientRect()),
                        rightSelectorRect: describeDebugRect(rightSelector?.getBoundingClientRect()),
                    }))
                    if (activeDragDebug?.dragId === dragId) activeDragDebug = null
                }

                const handleEnd = (event: TouchEvent) => {
                    if (event.type !== 'touchcancel') event.preventDefault()
                    touch = event.changedTouches[0] ?? event.touches[0] ?? touch
                    recordDragDebug('touch-end', () => ({
                        dragId,
                        handle,
                        eventType: event.type,
                        eventTimestamp: event.timeStamp,
                        touchMoved,
                        touch: describeDebugTouch(touch),
                    }))
                    if (touchMoved) {
                        sampleId += 1
                        applyTouchPosition('end', sampleId)
                    }
                    cleanup(event.type)

                    const selection = editor.getSelection()
                    if (event.type !== 'touchcancel' && selectorMenu && selection !== null) {
                        showSelectionMenuByTouch()
                    }

                    setTimeout(() => { _menuGuard = false }, 0)
                }

                activeDragCleanup = cleanup
                document.addEventListener('touchmove', handleMove, {passive: false})
                document.addEventListener('touchend', handleEnd)
                document.addEventListener('touchcancel', handleEnd)
            }, {passive: true})
        }

        setupSelectorTouchEvent(leftSelector, updateSelectionStart)
        setupSelectorTouchEvent(rightSelector, updateSelectionEnd)

        const selection = editor.getSelection()
        if (selection) debounceSyncSelectionTransform(selection)
    }

    subscriptions.push(editor.onDidChangeCursorSelection((e) => {
        if (!e.selection.isEmpty()) releaseHandleDelay()
        else if (!activeDragCleanup && Date.now() - lastTouchInteractionAt < 1000) deferCaretHandle()
        if (activeDragDebug && isTouchSelectionDebugEnabled()) {
            recordDebug('cursor-selection-event', {
                dragId: activeDragDebug.dragId,
                handle: activeDragDebug.handle,
                source: e.source,
                reason: e.reason,
                selection: describeDebugSelection(e.selection),
            })
        }
        hideSelectorMenu()
        if (activeDragCleanup) return
        setTimeout(() => {
            if (disposed) return
            debounceSyncSelectionTransform(e.selection)
        }, 0)
    }))

    initSelections()

    const selectionShrinkTools: Map<DefaultToolName, SelectorMenuTool> = new Map([
        [DefaultToolName.ShrinkSelectionLeft, {
            name: 'shrink selection from left',
            innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M 2 6 v 12 M 7 8 l 4 4 l -4 4 M 3 12 h 8"/>
</svg>`,
            action: () => {
                shrinkSelectionLeft()
                showSelectorMenu()
            },
        }],
        [DefaultToolName.ShrinkSelectionRight, {
            name: 'shrink selection from right',
            innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M 22 6 v 12 M 17 8 l -4 4 l 4 4 M 13 12 h 8"/>
</svg>`,
            action: () => {
                shrinkSelectionRight()
                showSelectorMenu()
            },
        }],
    ])

    const selectionAdjustmentTools: Map<DefaultToolName, SelectorMenuTool> = new Map([
        [DefaultToolName.GrowSelectionLeft, {
            name: 'grow selection left',
            innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M 2 6 v 12 M 7 16 l -4 -4 l 4 -4 M 5 12 h 7"/>
</svg>`,
            action: () => {
                growSelectionLeft()
                showSelectorMenu()
            },
        }],
        [DefaultToolName.GrowSelectionRight, {
            name: 'grow selection right',
            innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M 22 6 v 12 M 17 16 l 4 -4 l -4 -4 M 12 12 h 7"/>
</svg>`,
            action: () => {
                growSelectionRight()
                showSelectorMenu()
            },
        }],
    ])

    const getMenuTools = (
        selectorMenu: HTMLDivElement,
        configuredTools: SelectorMenuToolConfig | undefined = tools,
        useDefaultTools = true,
    ): Iterable<SelectorMenuTool> => {
        const defaultTools: Map<DefaultToolName, SelectorMenuTool> = new Map([
            [DefaultToolName.Copy, {
                name: 'copy',
                innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M 5 8 m 0 2 a 2 2 0 0 1 2 -2 h 8 a 2 2 0 0 1 2 2 v 8 a 2 2 0 0 1 -2 2 h -8 a 2 2 0 0 1 -2 -2 z M 9 6 a 2 2 0 0 1 2 -2 h 8 a 2 2 0 0 1 2 2 v 8 a 2 2 0 0 1 -2 2"/>
</svg>`,
                action: async () => {
                    const result = await copy()
                    if (result) hideSelectorMenu()
                }
            }],
            [DefaultToolName.Cut, {
                name: 'cut',
                innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M7 17m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
    <path d="M17 17m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
    <path d="M9.15 14.85l8.85 -10.85" />
    <path d="M6 4l8.85 10.85" />
</svg>`,
                action: async () => {
                    const result = await cut()
                    if (result) hideSelectorMenu()
                }
            }],
            [DefaultToolName.Paste, {
                name: 'paste',
                innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h3m9 -9v-5a2 2 0 0 0 -2 -2h-2" />
    <path d="M13 17v-1a1 1 0 0 1 1 -1h1m3 0h1a1 1 0 0 1 1 1v1m0 3v1a1 1 0 0 1 -1 1h-1m-3 0h-1a1 1 0 0 1 -1 -1v-1" />
    <path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z" />
</svg>`,
                action: async () => {
                    const result = await paste()
                    if (result) hideSelectorMenu()
                }
            }],
            [DefaultToolName.Undo, {
                name: 'undo',
                innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M9 14l-4 -4l4 -4"/>
    <path d="M5 10h11a4 4 0 1 1 0 8h-1"/>
</svg>`,
                action: () => {
                    undo()
                    showSelectorMenu()
                }
            }],
            [DefaultToolName.Redo, {
                name: 'redo',
                innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M15 14l4 -4l-4 -4"/>
    <path d="M19 10h-11a4 4 0 1 0 0 8h1"/>
</svg>`,
                action: () => {
                    redo()
                    showSelectorMenu()
                }
            }],
            [DefaultToolName.SelectWord, {
                name: 'select',
                innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M5 3h2m4 0h2m4 0h2M3 7v2m18-2v2M3 13v2m18-2v2M5 21h2m4 0h2m4 0h2"/>
</svg>`,
                action: () => {
                    const sel = editor.getSelection()
                    if (!sel) return
                    const model = editor.getModel()
                    if (!model) return
                    const word = model.getWordAtPosition(sel.getStartPosition())
                    if (word) {
                        editor.setSelection({
                            startLineNumber: sel.startLineNumber,
                            startColumn: word.startColumn,
                            endLineNumber: sel.endLineNumber,
                            endColumn: word.endColumn,
                        })
                        setTimeout(() => { editor.focus() })
                    }
                    showSelectorMenu()
                }
            }],
            [DefaultToolName.SelectAll, {
                name: 'select all',
                innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M 2 6 v 12 M 17 16 l 4 -4 l -4 -4 M 7 16 l -4 -4 l 4 -4 M 22 6 v 12 M 5 12 h 14"/>
</svg>`,
                action: () => {
                    selectAll()
                    showSelectorMenu()
                }
            }],
            [DefaultToolName.Hover, {
                name: 'hover',
                innerHTML: `<span class="icon" style="font-size: 1.2em; line-height: 1;">🚁</span>`,
                action: () => {
                    hideSelectorMenu()
                    const sel = editor.getSelection()
                    if (sel && sel.getStartPosition) {
                        try { editor.setPosition(sel.getStartPosition()) } catch (_) {}
                    }
                    const hoverAction = editor.getAction('editor.action.showHover')
                    if (hoverAction) {
                        hoverAction.run()
                    } else {
                        editor.trigger('touch', 'editor.action.showHover', null)
                    }
                    return true
                }
            }],
            [DefaultToolName.Find, {
                name: 'find',
                innerHTML: `<span class="icon" style="font-size: 1.2em; line-height: 1;">🔎</span>`,
                action: () => {
                    hideSelectorMenu()
                    const act = editor.getAction('actions.find')
                    if (act && act.run) { act.run() }
                    else { editor.trigger('touch-menu', 'actions.find', null) }
                }
            }],
            [DefaultToolName.ReadOnly, {
                name: 'read only',
                innerHTML: () => {
                    const ro = editor.getOption(_EditorOption?.readOnly ?? 89)
                    return `<svg xmlns="http://www.w3.org/2000/svg" class="icon" viewBox="0 0 100 100" style="fill: ${ro ? '#4fc3f7' : 'currentColor'}; stroke: none;"><path d="M84.4,24.3H38l7,7h39.4c0.8,0,1.5,0.7,1.5,1.5v38.5c0,0.2-0.1,0.5-0.2,0.7l5,5c1.4-1.5,2.2-3.5,2.2-5.6V32.8C92.9,28.2,89.1,24.3,84.4,24.3z"/><path d="M66.9,53.3c0,1.9,1.6,3.5,3.5,3.5h4.4c1.9,0,3.5-1.6,3.5-3.5c0-1.9-1.6-3.5-3.5-3.5h-4.4C68.5,49.8,66.9,51.3,66.9,53.3z"/><path d="M34.2,53.3c0-1.9-1.6-3.5-3.5-3.5h-4.4c-1.9,0-3.5,1.6-3.5,3.5s1.6,3.5,3.5,3.5h4.4C32.7,56.8,34.2,55.2,34.2,53.3z"/><path d="M60.4,45.5c1.9,0,3.5-1.6,3.5-3.5s-1.6-3.5-3.5-3.5H56c-1.1,0-2,0.5-2.6,1.2l5.8,5.8H60.4z"/><path d="M74.8,45.5c1.9,0,3.5-1.6,3.5-3.5c0-1.9-1.6-3.5-3.5-3.5h-4.4c-1.9,0-3.5,1.6-3.5,3.5c0,1.9,1.6,3.5,3.5,3.5H74.8z"/><path d="M26.3,45.5h4.4c1.9,0,3.5-1.6,3.5-3.5c0-1.9-1.6-3.5-3.5-3.5h-4.4c-1.9,0-3.5,1.6-3.5,3.5C22.8,43.9,24.4,45.5,26.3,45.5z"/><path d="M85.2,81.3l-8.4-8.4L70.8,67l0,0c0,0,0,0,0,0l-5.6-5.6l-4.6-4.6l0,0l-6.4-6.4l-6-6v0L23.3,19.5v0l-1.8-1.8c-1.4-1.4-3.6-1.4-4.9,0c-1.4,1.4-1.4,3.6,0,4.9l1.7,1.7h-1.5c-4.7,0-8.5,3.8-8.5,8.5v38.5c0,4.7,3.8,8.5,8.5,8.5h57l6.4,6.4c0.7,0.7,1.6,1,2.5,1c0.9,0,1.8-0.3,2.5-1c1.2-1.2,1.3-3,0.5-4.4C85.5,81.7,85.3,81.5,85.2,81.3z M16.8,72.8c-0.8,0-1.5-0.7-1.5-1.5V32.8c0-0.8,0.7-1.5,1.5-1.5h8.5l18.4,18.4l0,0h-2.6c-1.9,0-3.5,1.6-3.5,3.5s1.6,3.5,3.5,3.5h4.4c1.4,0,2.6-0.8,3.2-2l6.6,6.6H33.1c-1.9,0-3.5,1.6-3.5,3.5c0,1.9,1.6,3.5,3.5,3.5h29.3l4.5,4.5H16.8z"/></svg>`
                },
                action: () => {
                    const ro = editor.getOption(_EditorOption?.readOnly ?? 89)
                    editor.updateOptions({ readOnly: !ro })
                    if (ro) {
                        // Toggling OFF readOnly — blur so user taps to refocus with keyboard.
                        try {
                            const dom = editor.getDomNode()
                            const ta = dom?.querySelector('textarea.inputarea') as HTMLElement ?? dom?.querySelector('textarea') as HTMLElement
                            if (ta) ta.blur()
                        } catch (_) {}
                    }
                    showSelectorMenu()
                }
            }],
            [DefaultToolName.Mention, {
                name: 'mention',
                innerHTML: `<span class="icon" style="font-size: 1.2em; line-height: 1;">💬</span>`,
                action: () => {
                    hideSelectorMenu()
                    try {
                        const dom = editor.getDomNode()
                        if (dom) dom.dispatchEvent(new CustomEvent('te2:mention-request', { bubbles: false }))
                    } catch (_) {}
                    return true
                }
            }],
            [DefaultToolName.Close, {
                name: 'close',
                innerHTML: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    class="icon"
    viewBox="0 0 24 24"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="fill: none;"
>
    <path d="M18 6l-12 12" />
    <path d="M6 6l12 12" />
</svg>`,
                action: () => {
                    hideSelectorMenu()
                    return true
                }
            }]
        ])

        for (const [name, tool] of selectionAdjustmentTools) defaultTools.set(name, tool)
        for (const [name, tool] of selectionShrinkTools) defaultTools.set(name, tool)
        const mainTools = () => Array.from(defaultTools)
            .filter(([name]) => !selectionAdjustmentTools.has(name) && !selectionShrinkTools.has(name))
            .map(([, tool]) => tool)

        // Historical viewers retain selection geometry, but cannot expose editing
        // tools (including the read-only toggle) through defaults or custom islands.
        if (historicalReadOnly) {
            return useDefaultTools ? [DefaultToolName.Copy, DefaultToolName.SelectWord,
                DefaultToolName.SelectAll, DefaultToolName.Find, DefaultToolName.Close]
                .map(name => defaultTools.get(name)!) : []
        }

        if (configuredTools === undefined) {
            return useDefaultTools ? mainTools() : []
        }

        if (typeof configuredTools === 'function') {
            const result = configuredTools({
                editor,
                selectorMenu,
                defaultTools,
                openMenu: showSelectorMenu,
                closeMenu: hideSelectorMenu,
            })
            if (result === undefined) {
                return useDefaultTools ? mainTools() : []
            }
            return result
        }

        return useDefaultTools ? mainTools() : []
    }

    const initSelectorMenu = () => {
        selectorMenuStack = document.createElement('div')
        selectorMenuStack.classList.add('monaco-editor-touch-selector-menu-stack')
        selectorMenuStack.classList.toggle('mobile-mode', mobile)

        selectorUtilityMenuRow = document.createElement('div')
        selectorUtilityMenuRow.classList.add('utility-row')

        selectorMenu = document.createElement('div')
        selectorMenu.classList.add('monaco-editor-touch-selector-menu', 'main-menu')

        selectorLeadingMenu = document.createElement('div')
        selectorLeadingMenu.classList.add('monaco-editor-touch-selector-menu', 'leading-row')

        selectorNavigationMenu = document.createElement('div')
        selectorNavigationMenu.classList.add('monaco-editor-touch-selector-menu', 'navigation-row')

        selectorUtilityMenuRow.append(
            selectorLeadingMenu,
            selectorNavigationMenu,
        )
        selectorMenuStack.append(selectorUtilityMenuRow, selectorMenu)

        const appendMenuTools = (
            menu: HTMLDivElement,
            menuTools: Iterable<SelectorMenuTool>,
            trackDynamicItems: boolean,
        ) => {
            for (const menuTool of menuTools) {
                const menuItemElement = document.createElement('div')
                menuItemElement.classList.add('menu-item')
                menuItemElement.title = menuTool.name
                menuItemElement.setAttribute('role', 'button')
                menuItemElement.setAttribute('aria-label', menuTool.name)
                menuItemElement.tabIndex = 0

                if (typeof menuTool.innerHTML === 'function') {
                    const result = menuTool.innerHTML()
                    if (typeof result === 'string') menuItemElement.innerHTML = result
                    else menuItemElement.appendChild(result)
                    if (trackDynamicItems) {
                        _dynamicMenuItems.push({ el: menuItemElement, fn: menuTool.innerHTML })
                    }
                } else {
                    if (typeof menuTool.innerHTML === 'string') menuItemElement.innerHTML = menuTool.innerHTML
                    else menuItemElement.appendChild(menuTool.innerHTML)
                }

                const runAction = async () => {
                    try {
                        await menuTool.action()
                    } catch (e) {
                        await toolActionErrorHandler(menuTool.name, e)
                    }
                }
                menuItemElement.addEventListener('touchend', runAction)
                menuItemElement.addEventListener('click', runAction)
                menuItemElement.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    void runAction()
                })

                menu.appendChild(menuItemElement)
            }
        }
        appendMenuTools(selectorMenu, getMenuTools(selectorMenu), true)
        appendMenuTools(
            selectorLeadingMenu,
            getMenuTools(selectorLeadingMenu, leadingTools, false),
            true,
        )
        appendMenuTools(
            selectorNavigationMenu,
            getMenuTools(selectorNavigationMenu, navigationTools, false),
            true,
        )
        const setupMenuEvents = (menu: HTMLDivElement) => {
            menu.addEventListener('touchstart', (event) => {
                event.preventDefault()
            }, {passive: false})

            menu.addEventListener('touchmove', (event) => {
                event.preventDefault()
            }, {passive: false})

            menu.addEventListener('touchend', (event) => {
                event.preventDefault()
            }, {passive: false})

            // Prevent mousedown on menu from blurring the editor widget.
            menu.addEventListener('mousedown', (event) => {
                event.preventDefault()
            })
        }
        setupMenuEvents(selectorMenuStack)

        // Click outside menu dismisses it.
        menuOutsideMouseDownHandler = (event: MouseEvent) => {
            if (!selectorMenuShow || !selectorMenuStack) return
            if (selectorMenuStack.contains(event.target as Node)) return
            forceHideSelectorMenu()
        }
        document.addEventListener('mousedown', menuOutsideMouseDownHandler)

        document.documentElement.append(selectorMenuStack)
    }
    initSelectorMenu()

    // Monaco owns word selection and reports a completed hold without focusing
    // its textarea. This contribution only presents the existing touch menu.
    const holdSubscription = editor.onContextMenu((event) => {
        if (event.event.browserEvent.type !== '-monaco-gesturehold') return
        releaseHandleDelay()
        showSelections()
        const selection = editor.getSelection()
        if (selection) syncSelectionTransform(selection)
        positionSelectorMenuForSelection()
    })
    subscriptions.push(holdSubscription)

    element.addEventListener('touchstart', (event) => {
        lastTouchInteractionAt = Date.now()
        if (!(event.target instanceof Element && event.target.closest('.bottom-cursor'))) {
            deferCaretHandle()
        }
        showSelections()
    }, {passive: true, signal: viewEvents.signal})

    subscriptions.push(editor.onDidBlurEditorWidget(() => {
        hideSelections()
        hideSelectorMenu()
    }))

    element.addEventListener('click', (event) => {
        event.stopPropagation()
    }, {signal: viewEvents.signal})

    // Right-click (mouse) opens the selector menu at the cursor position.
    element.addEventListener('contextmenu', (event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        if (!selectorMenuStack) return

        const sourceCapabilities = (event as MouseEvent & {
            sourceCapabilities?: { firesTouchEvents?: boolean }
        }).sourceCapabilities
        const touchOrigin = sourceCapabilities?.firesTouchEvents === true
            || Date.now() - lastTouchInteractionAt <= TOUCH_CONTEXT_MENU_WINDOW
        // Native contextmenu duplicates the source-owned hold on some engines.
        if (touchOrigin) return

        // Guard: prevent onDidChangeCursorSelection / onDidBlurEditorWidget from
        // immediately hiding the menu we're about to show.
        _menuGuard = true

        // Only move cursor if there's no active selection (don't clobber selection).
        const sel = editor.getSelection()
        const hasSelection = sel && !sel.isEmpty()
        if (!hasSelection) {
            const target = editor.getTargetAtClientPoint(event.clientX, event.clientY)
            if (target && target.position) {
                editor.setPosition(target.position)
            }
        }

        if (!touchOrigin || !positionSelectorMenuForSelection()) {
            unbindSelectorMenuFromSelection()
            positionSelectorMenus(event.clientX, event.clientY - 10, event.clientY + 10, touchOrigin)
        }

        // Release guard after current event loop so blur/selection handlers don't fire.
        setTimeout(() => { _menuGuard = false }, 0)
    }, {signal: viewEvents.signal})
    return {dispose}
}

// Monaco keeps the editor alive while replacing its view DOM on setModel().
// Editor-owned subscriptions must not keep menus attached to the old view alive.
const touchOwners = new WeakMap<ICodeEditor, {refresh(): void}>()
export const editorTouchSelectionHelp = (
    editor: ICodeEditor,
    options?: Parameters<typeof attachTouchSelectionView>[1],
): void => {
    const existing = touchOwners.get(editor)
    if (existing) {
        existing.refresh()
        return
    }
    let view: ReturnType<typeof attachTouchSelectionView> | null = null
    let element: HTMLElement | null = null
    const refresh = () => {
        const nextElement = editor.getDomNode()
        if (nextElement === element) return
        view?.dispose()
        view = null
        element = null
        if (nextElement) view = attachTouchSelectionView(editor, options)
        element = nextElement
    }
    refresh()
    touchOwners.set(editor, {refresh})
    const modelSubscription = editor.onDidChangeModel(refresh)
    const disposeSubscription = editor.onDidDispose(() => {
        view?.dispose()
        view = null
        element = null
        modelSubscription.dispose()
        disposeSubscription.dispose()
        touchOwners.delete(editor)
    })
}
