/**
 * The recurrence editor (S-26) and the conflict preview (S-27).
 *
 * The live plain-English summary is the most valuable part: restating the rule
 * in words is the cheapest way to stop someone accidentally booking a room
 * three hundred times.
 *
 * Specification: docs/07-ui-screens.md, docs/12-recurrence.md section 4.
 */
import { type RecurrenceRule } from '@roombook/shared';
export interface RecurrenceValue {
    enabled: boolean;
    rule: RecurrenceRule;
}
export declare function defaultRule(localDate: string): RecurrenceRule;
export declare function RecurrenceEditor({ value, startLocalDate, startLocalTime, onChange, }: {
    value: RecurrenceValue;
    /** `YYYY-MM-DD` of the first occurrence, in the room timezone. */
    startLocalDate: string;
    /** `HH:mm`, used only for the summary line. */
    startLocalTime: string;
    onChange: (next: RecurrenceValue) => void;
}): import("react").JSX.Element;
export interface SeriesPreviewData {
    description: string;
    totalOccurrences: number;
    available: number;
    firstOccurrence: string | null;
    lastOccurrence: string | null;
    conflicts: Array<{
        occurrenceStartLocal: string;
        reason: string;
        detail?: string;
        conflictingTitle?: string;
    }>;
    truncated: boolean;
}
/**
 * Shown before anything is written.
 *
 * The confirm button states the real count, so nobody is surprised by what
 * they created — and a series that silently skipped three weeks is a meeting
 * people miss.
 */
export declare function SeriesPreviewDialog({ preview, roomName, loading, onClose, onConfirm, }: {
    preview: SeriesPreviewData;
    roomName: string;
    loading: boolean;
    onClose: () => void;
    onConfirm: (strategy: 'SKIP' | 'FAIL') => void;
}): import("react").JSX.Element;
export type EditScopeChoice = 'THIS_OCCURRENCE' | 'THIS_AND_FOLLOWING' | 'ENTIRE_SERIES';
/**
 * Asked before any change to an occurrence of a series.
 *
 * The default differs by role on purpose: an admin reclaiming a room almost
 * always means today, while an organizer editing their own standup usually
 * means the series. Getting that default right saves a great many accidental
 * series-wide changes (D16).
 */
export declare function ScopeChooserDialog({ title, action, defaultScope, loading, onClose, onChoose, }: {
    title: string;
    action: string;
    defaultScope: EditScopeChoice;
    loading: boolean;
    onClose: () => void;
    onChoose: (scope: EditScopeChoice) => void;
}): import("react").JSX.Element;
//# sourceMappingURL=RecurrenceEditor.d.ts.map