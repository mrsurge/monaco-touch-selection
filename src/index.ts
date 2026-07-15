import {editor, type IPosition, type IRange} from "monaco-editor/esm/vs/editor/editor.api.js"

type ICodeEditor = editor.ICodeEditor;

const OPTION_FontSize_FALLBACK = 52
const OPTION_LineHeight_FALLBACK = 67

const DEFAULT_SELECTION_SYNC_TIMEOUT = 300
const DBLCLICK_OPEN_MENU_TIMEOUT = 1000
const REVEAL_INTERVAL = 50

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

export const editorTouchSelectionHelp = (
    editor: ICodeEditor,
    options?: {
        tools?: SelectorMenuToolConfig,
        selectionSyncTimeout?: number | undefined,
        toolActionErrorHandler?: (name: string, error: Error | unknown) => Promise<void> | void,
    }
) => {
    const {
        tools,
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

    const margin = element.querySelector('.monaco-editor .margin')
    let leftMargin = 0
    if (margin && margin instanceof HTMLElement) {
        leftMargin = margin.offsetWidth
    }

    let selectionsShow = false
    let selections: HTMLDivElement | null = null
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
    let selectorMenu: HTMLDivElement | null = null
    let selectorAdjustmentMenu: HTMLDivElement | null = null
    // Track menu items with dynamic (function) innerHTML for refresh on show.
    const _dynamicMenuItems: { el: HTMLDivElement, fn: () => string | Element }[] = []
    // Suppress auto-hide while a right-click or touch-handle flow opens the menus.
    let _menuGuard = false
    let activeDragCleanup: (() => void) | null = null
    const cancelActiveDrag = () => {
        const cleanup = activeDragCleanup
        activeDragCleanup = null
        cleanup?.()
        _menuGuard = false
    }
    const cancelDragOnWindowBlur = () => cancelActiveDrag()
    const cancelDragWhenHidden = () => {
        if (document.hidden) cancelActiveDrag()
    }
    window.addEventListener('blur', cancelDragOnWindowBlur)
    document.addEventListener('visibilitychange', cancelDragWhenHidden)
    const showSelectorMenu = () => {
        if (!selectorMenu || !selectorAdjustmentMenu) return
        // Refresh dynamic icons (e.g. readOnly toggle color).
        for (const d of _dynamicMenuItems) {
            const r = d.fn()
            d.el.innerHTML = typeof r === 'string' ? r : ''
            if (typeof r !== 'string') d.el.appendChild(r)
        }
        if (selectorMenuShow) return
        selectorMenuShow = true
        selectorMenu.classList.add('show')
        selectorAdjustmentMenu.classList.add('show')
    }
    const hideSelectorMenu = () => {
        if (!selectorMenu || !selectorAdjustmentMenu) return
        if (!selectorMenuShow) return
        if (_menuGuard) return
        selectorMenuShow = false
        selectorMenu.classList.remove('show')
        selectorAdjustmentMenu.classList.remove('show')
    }

    const positionSelectorMenus = (
        anchorX: number,
        preferredAboveY: number,
        fallbackBelowY: number,
    ) => {
        if (!selectorMenu || !selectorAdjustmentMenu) return
        showSelectorMenu()

        const menuRect = selectorMenu.getBoundingClientRect()
        const adjustmentRect = selectorAdjustmentMenu.getBoundingClientRect()
        const islandGap = 6
        const stackWidth = Math.max(menuRect.width, adjustmentRect.width)
        const stackHeight = menuRect.height + islandGap + adjustmentRect.height

        const viewportLeft = window.visualViewport?.offsetLeft ?? document.documentElement.offsetLeft
        const viewportTop = window.visualViewport?.offsetTop ?? document.body.offsetTop
        const viewportRight = window.visualViewport
            ? window.visualViewport.offsetLeft + window.visualViewport.width
            : document.documentElement.offsetLeft + document.body.clientWidth
        const viewportBottom = window.visualViewport
            ? window.visualViewport.offsetTop + window.visualViewport.height
            : document.body.offsetTop + document.body.clientHeight

        // Menus live at the document root and must be able to overlay the host
        // menubar and drawers; only the visible viewport constrains them.
        const minX = viewportLeft
        const minY = viewportTop
        const maxX = viewportRight
        const maxY = viewportBottom
        const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

        const stackX = clamp(anchorX - stackWidth / 2, minX, maxX - stackWidth)
        let stackY = preferredAboveY - stackHeight
        if (stackY < minY) stackY = fallbackBelowY
        stackY = clamp(stackY, minY, maxY - stackHeight)

        const adjustmentX = stackX + (stackWidth - adjustmentRect.width) / 2
        const menuX = stackX + (stackWidth - menuRect.width) / 2
        selectorAdjustmentMenu.style.transform = `translateX(${adjustmentX}px) translateY(${stackY}px)`
        selectorMenu.style.transform = `translateX(${menuX}px) translateY(${stackY + adjustmentRect.height + islandGap}px)`
    }

    let resizeOb: ResizeObserver | null = new ResizeObserver(() => {
        hideSelections()
        hideSelectorMenu()

        const selection = editor.getSelection()
        if (selection) debounceSyncSelectionTransform(selection)
    })
    resizeOb.observe(element)

    editor.onDidDispose(() => {
        cancelActiveDrag()
        window.removeEventListener('blur', cancelDragOnWindowBlur)
        document.removeEventListener('visibilitychange', cancelDragWhenHidden)
        resizeOb?.disconnect()
        resizeOb = null

        selections?.remove()
        leftSelector?.remove()
        rightSelector?.remove()
        selectorMenu?.remove()
        selectorAdjustmentMenu?.remove()

        selections = null
        leftSelector = null
        rightSelector = null
        selectorMenu = null
        selectorAdjustmentMenu = null
    })

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

    const resolveTouchPosition = (clientX: number, clientY: number): IPosition | null => {
        const target = editor.getTargetAtClientPoint(clientX, clientY)
        if (!target?.position) return null

        const model = editor.getModel()
        if (!model) return target.position

        const lineNumber = target.position.lineNumber
        const maxColumn = model.getLineMaxColumn(lineNumber)
        const layout = editor.getLayoutInfo()
        const editorRect = element.getBoundingClientRect()
        const targetOffset = clientX - editorRect.left - layout.contentLeft + editor.getScrollLeft()

        // Resolve against every rendered caret boundary in the visual row. The
        // point target chooses the row only; it is not the horizontal authority.
        try {
            const contentLeft = editorRect.left + layout.contentLeft
            const contentRight = contentLeft + Math.max(1, layout.contentWidth) - 1
            const rowStart = editor.getTargetAtClientPoint(contentLeft, clientY)?.position
            const rowEnd = editor.getTargetAtClientPoint(contentRight, clientY)?.position

            if (rowStart?.lineNumber !== lineNumber || rowEnd?.lineNumber !== lineNumber) {
                return target.position
            }
            let low = Math.min(rowStart.column, rowEnd.column, target.position.column)
            let high = Math.max(rowStart.column, rowEnd.column, target.position.column)
            low = Math.max(1, low)
            high = Math.min(maxColumn, high)

            while (low < high) {
                const middle = Math.floor((low + high) / 2)
                const offset = editor.getOffsetForColumn(lineNumber, middle)
                if (offset < 0) return target.position
                if (offset < targetOffset) low = middle + 1
                else high = middle
            }

            const rightColumn = low
            const leftColumn = Math.max(1, rightColumn - 1)
            const rightOffset = editor.getOffsetForColumn(lineNumber, rightColumn)
            const leftOffset = editor.getOffsetForColumn(lineNumber, leftColumn)
            if (rightOffset < 0 || leftOffset < 0) return target.position

            const column = Math.abs(targetOffset - leftOffset) <= Math.abs(rightOffset - targetOffset)
                ? leftColumn
                : rightColumn
            return {lineNumber, column}
        } catch (_error) {
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
        const startCoords = editor.getScrolledVisiblePosition(startPosition)
        const endCoords = editor.getScrolledVisiblePosition(endPosition)

        if (!startCoords || !endCoords) return

        // Get the top position of the start and end lines
        const startTop = editor.getTopForPosition(startPosition.lineNumber, startPosition.column)
        const endTop = editor.getTopForPosition(endPosition.lineNumber, endPosition.column)

        // Calculate positions for the selectors based on line number top positions
        const leftSelectorX = startCoords.left + scrollLeft - leftMargin
        const leftSelectorY = startTop
        const rightSelectorX = endCoords.left + scrollLeft - leftMargin
        const rightSelectorY = endTop

        leftSelector.style.opacity = "1"
        rightSelector.style.opacity = "1"

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
        editor.onDidChangeConfiguration((e) => {
            lineHeight = editor.getOption(OPTION_LineHeight)
            syncSelectorStyle(lineHeight)
            if (e.hasChanged(OPTION_FontSize)) {
                fontSize = editor.getOption(OPTION_FontSize)
            }
        })

        editorOverlayGuard.append(selections)
        editor.onDidScrollChange((e) => {
            if (selections) {
                selections.style.top = `-${e.scrollTop}px`
                selections.style.left = `-${e.scrollLeft}px`
            }
        })

        const setupSelectorTouchEvent = (
            selector: Selector,
            updateSelection: (selection: IRange, position: IPosition) => IRange
        ) => {
            const showSelectionMenuByTouch = (touch: Touch) => {
                if (touch && leftSelector && rightSelector) {
                    const leftRect = leftSelector.getBoundingClientRect()
                    const rightRect = rightSelector.getBoundingClientRect()

                    // 计算 touch 点到 left selector 的距离
                    const leftDistancePow2 = Math.pow(touch.clientX - (leftRect.left + leftRect.width / 2), 2) +
                        Math.pow(touch.clientY - (leftRect.top + leftRect.height / 2), 2)

                    // 计算 touch 点到 right selector 的距离
                    const rightDistancePow2 = Math.pow(touch.clientX - (rightRect.left + rightRect.width / 2), 2) +
                        Math.pow(touch.clientY - (rightRect.top + rightRect.height / 2), 2)

                    // 选择距离更近的 selector
                    const closerRect = leftDistancePow2 <= rightDistancePow2 ? leftRect : rightRect;
                    positionSelectorMenus(
                        closerRect.left + closerRect.width / 2,
                        closerRect.top,
                        closerRect.bottom + lineHeight,
                    )
                }
            }

            selector.addEventListener('touchstart', (event: TouchEvent) => {
                const initialSelection = editor.getSelection()
                if (!initialSelection) return

                let touch = event.changedTouches[0] ?? event.touches[0]
                if (!touch) return
                cancelActiveDrag()
                _menuGuard = true
                clearTimeout(syncSelectorTimer)
                syncSelectorTimer = undefined
                if (leftSelector) leftSelector.style.opacity = "0"
                if (rightSelector) rightSelector.style.opacity = "0"

                const selectionIsEmpty = initialSelection.isEmpty()

                // Keep the handle's vertical grab offset while horizontal placement
                // follows the raw touch coordinate without spatial magnification.
                let touchOffsetY = 0
                try {
                    const anchorPos = selector.classList.contains('left')
                        ? {lineNumber: initialSelection.startLineNumber, column: initialSelection.startColumn}
                        : {lineNumber: initialSelection.endLineNumber, column: initialSelection.endColumn}
                    const scrolledPos = editor.getScrolledVisiblePosition(anchorPos)
                    if (scrolledPos) {
                        const editorRect = element.getBoundingClientRect()
                        touchOffsetY = editorRect.top + scrolledPos.top + scrolledPos.height / 2 - touch.clientY
                    }
                } catch (_e) { /* ignore */ }

                // Don't start the drag interval until the finger actually moves.
                // This lets taps and long-presses work without the interval
                // immediately repositioning the cursor.
                let revealTimer: ReturnType<typeof setInterval> | null = null
                let touchMoved = false
                const applyTouchPosition = () => {
                    const position = resolveTouchPosition(
                        touch.clientX,
                        touch.clientY + touchOffsetY - lineHeight * 1.5,
                    )
                    if (!position) return
                    if (selectionIsEmpty) {
                        const current = editor.getPosition()
                        if (current?.lineNumber === position.lineNumber && current.column === position.column) return
                        editor.setPosition(position)
                    } else {
                        const nextSelection = updateSelection(initialSelection, position)
                        const current = editor.getSelection()
                        if (
                            current?.startLineNumber === nextSelection.startLineNumber &&
                            current.startColumn === nextSelection.startColumn &&
                            current.endLineNumber === nextSelection.endLineNumber &&
                            current.endColumn === nextSelection.endColumn
                        ) return
                        editor.setSelection(nextSelection)
                    }
                }
                const sampleTouchPosition = () => {
                    scrollTopExtremityFit(editor, touch, lineHeight)
                    scrollLeftExtremityFit(editor, touch, fontSize)
                    applyTouchPosition()
                }
                const startRevealTimer = () => {
                    if (revealTimer !== null) return
                    sampleTouchPosition()
                    revealTimer = setInterval(sampleTouchPosition, REVEAL_INTERVAL)
                }

                const handleMove = (event: TouchEvent) => {
                    event.preventDefault()
                    touch = event.changedTouches[0] ?? event.touches[0] ?? touch
                    touchMoved = true
                    startRevealTimer()
                }

                let cleaned = false
                const cleanup = () => {
                    if (cleaned) return
                    cleaned = true
                    if (revealTimer !== null) clearInterval(revealTimer)
                    revealTimer = null
                    document.removeEventListener('touchmove', handleMove)
                    document.removeEventListener('touchend', handleEnd)
                    document.removeEventListener('touchcancel', handleEnd)
                    if (activeDragCleanup === cleanup) activeDragCleanup = null
                    const selection = editor.getSelection()
                    if (selection) syncSelectionTransform(selection)
                }

                const handleEnd = (event: TouchEvent) => {
                    if (event.type !== 'touchcancel') event.preventDefault()
                    touch = event.changedTouches[0] ?? event.touches[0] ?? touch
                    if (touchMoved) applyTouchPosition()
                    cleanup()

                    const selection = editor.getSelection()
                    if (event.type !== 'touchcancel' && selectorMenu && selection !== null) {
                        showSelectionMenuByTouch(touch)
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

        const setupTextCursorSelectWord = (textSelector: HTMLDivElement) => {
            let lastTouchTime = 0

            textSelector.addEventListener('touchstart', () => {
                lastTouchTime = Date.now()
            }, {passive: true})

            textSelector.addEventListener('touchend', () => {
                if (Date.now() - lastTouchTime > DBLCLICK_OPEN_MENU_TIMEOUT) {
                    return
                }

                const selection = editor.getSelection()
                if (!selection) return
                if (selection?.startColumn !== selection.endColumn || selection.startLineNumber !== selection.endLineNumber) return

                const model = editor.getModel()
                if (!model) return

                const word = model.getWordAtPosition(selection.getStartPosition())
                if (word) {
                    editor.setSelection({
                        startLineNumber: selection.startLineNumber,
                        startColumn: word.startColumn,
                        endLineNumber: selection.endLineNumber,
                        endColumn: word.endColumn,
                    })
                    setTimeout(() => {
                        editor.focus()
                    })
                }
            }, {passive: true})
        }

        setupTextCursorSelectWord(leftSelector.textCursor)
        setupTextCursorSelectWord(rightSelector.textCursor)

        const selection = editor.getSelection()
        if (selection) debounceSyncSelectionTransform(selection)
    }

    editor.onDidChangeCursorSelection((e) => {
        hideSelectorMenu()
        if (activeDragCleanup) return
        setTimeout(() => {
            debounceSyncSelectionTransform(e.selection)
        }, 0)
    })

    initSelections()

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
        selectorMenu: HTMLDivElement
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
        const mainTools = () => Array.from(defaultTools)
            .filter(([name]) => !selectionAdjustmentTools.has(name))
            .map(([, tool]) => tool)

        if (tools === undefined) return mainTools()

        if (typeof tools === 'function') {
            const result = tools({
                editor,
                selectorMenu,
                defaultTools,
                openMenu: showSelectorMenu,
                closeMenu: hideSelectorMenu,
            })
            if (result === undefined) {
                return mainTools()
            }
            return result
        }

        return mainTools()
    }

    const initSelectorMenu = () => {
        selectorMenu = document.createElement('div')
        selectorMenu.classList.add('monaco-editor-touch-selector-menu')
        selectorAdjustmentMenu = document.createElement('div')
        selectorAdjustmentMenu.classList.add('monaco-editor-touch-selector-menu', 'selection-adjustment')

        const appendMenuTools = (
            menu: HTMLDivElement,
            menuTools: Iterable<SelectorMenuTool>,
            trackDynamicItems: boolean,
        ) => {
            for (const menuTool of menuTools) {
                const menuItemElement = document.createElement('div')
                menuItemElement.classList.add('menu-item')
                menuItemElement.title = menuTool.name

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

                menu.appendChild(menuItemElement)
            }
        }
        appendMenuTools(selectorMenu, getMenuTools(selectorMenu), true)
        appendMenuTools(selectorAdjustmentMenu, selectionAdjustmentTools.values(), false)

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
        setupMenuEvents(selectorMenu)
        setupMenuEvents(selectorAdjustmentMenu)

        // Click outside menu dismisses it.
        document.addEventListener('mousedown', (event) => {
            if (!selectorMenuShow || !selectorMenu || !selectorAdjustmentMenu) return
            if (selectorMenu.contains(event.target as Node)) return
            if (selectorAdjustmentMenu.contains(event.target as Node)) return
            selectorMenuShow = false
            selectorMenu.classList.remove('show')
            selectorAdjustmentMenu.classList.remove('show')
        })

        document.documentElement.append(selectorMenu, selectorAdjustmentMenu)
    }
    initSelectorMenu()

    element.addEventListener('touchstart', () => {
        showSelections()
    }, {passive: true})

    editor.onDidBlurEditorWidget(() => {
        hideSelections()
        hideSelectorMenu()
    })

    element.addEventListener('click', (event) => {
        event.stopPropagation()
    })

    // Right-click (mouse) opens the selector menu at the cursor position.
    element.addEventListener('contextmenu', (event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        if (!selectorMenu || !selectorAdjustmentMenu) return

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

        positionSelectorMenus(event.clientX, event.clientY - 10, event.clientY + 10)

        // Release guard after current event loop so blur/selection handlers don't fire.
        setTimeout(() => { _menuGuard = false }, 0)
    })
}
