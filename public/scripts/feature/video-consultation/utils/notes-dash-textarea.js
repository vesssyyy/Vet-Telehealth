import { NOTES_DASH } from './notes-fields.js';

function getLineAtCursor(value, cursorIndex) {
    const lines = value.split('\n');
    let lineStart = 0;
    let lineIndex = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const lineEnd = lineStart + lines[i].length;
        if (cursorIndex <= lineEnd) {
            lineIndex = i;
            break;
        }
        lineStart = lineEnd + 1;
    }
    return {
        lines,
        lineIndex,
        lineStart,
        line: lines[lineIndex] || '',
        isFirstLine: lineIndex === 0,
    };
}

function removeCurrentLine(value, lineIndex) {
    const lines = value.split('\n');
    const nextLines = lines.slice(0, lineIndex).concat(lines.slice(lineIndex + 1));
    return nextLines.join('\n');
}

export function attachNotesDashTextarea(textarea, { onFocusExtra } = {}) {
    if (!textarea) return;

    let justAddedLine = false;

    textarea.addEventListener('keydown', (event) => {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        const { line, lineIndex, lineStart, isFirstLine } = getLineAtCursor(value, start);

        if (event.key === 'Enter') {
            event.preventDefault();
            justAddedLine = true;
            const nextValue = `${value.slice(0, start)}\n${NOTES_DASH}${value.slice(end)}`;
            const cursorPos = start + 1 + NOTES_DASH.length;
            textarea.value = nextValue;
            textarea.setSelectionRange(cursorPos, cursorPos);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        if (isFirstLine && line.startsWith(NOTES_DASH)) {
            if (event.key === 'Backspace' && start <= NOTES_DASH.length) {
                event.preventDefault();
                return;
            }
            if (event.key === 'Delete' && start < NOTES_DASH.length) {
                event.preventDefault();
                return;
            }
        }

        const isPlaceholderLine = line === NOTES_DASH.trim() || line === NOTES_DASH || line === '';
        if (!isFirstLine && isPlaceholderLine && event.key === 'Backspace') {
            event.preventDefault();
            const nextValue = removeCurrentLine(value, lineIndex);
            const cursorPos = Math.max(0, lineStart - 1);
            textarea.value = nextValue;
            textarea.setSelectionRange(cursorPos, cursorPos);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    textarea.addEventListener('focus', () => {
        if (!textarea.value.trim()) {
            textarea.value = NOTES_DASH;
            textarea.setSelectionRange(NOTES_DASH.length, NOTES_DASH.length);
        }
        onFocusExtra?.();
    });

    textarea.addEventListener('input', () => {
        if (justAddedLine) {
            justAddedLine = false;
            return;
        }

        const start = textarea.selectionStart;
        const value = textarea.value;
        const { line, lineIndex, lineStart } = getLineAtCursor(value, start);
        const isPlaceholderLine = line === NOTES_DASH || line === NOTES_DASH.trim() || line === '';
        if (lineIndex > 0 && isPlaceholderLine) {
            const nextValue = removeCurrentLine(value, lineIndex);
            const cursorPos = Math.max(0, lineStart - 1);
            textarea.value = nextValue;
            textarea.setSelectionRange(cursorPos, cursorPos);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
}

