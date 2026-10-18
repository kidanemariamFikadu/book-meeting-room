/**
 * The room-by-time calendar grid.
 *
 * Everything else in this app is forms and tables; this is the one component
 * that earns real design effort.
 *
 * Structure: one DOM node per BOOKING, absolutely positioned over a CSS grid
 * of slots — not one node per slot per room, which at 50 rooms x 40 slots
 * would be 2,000 nodes and visibly slow.
 *
 * Keyboard contract (docs/07-ui-screens.md section 7):
 *   Tab            moves between ROOMS, not cells - 2,000 tab stops is not navigation
 *   Left/Right     move the cursor one slot within a room
 *   Up/Down        move between rooms at the same time
 *   Enter          book at the cursor, or open the booking under it
 *   Shift+Arrow    extend the selection
 *   Escape         clear the selection
 *   Home/End       first / last bookable slot of the day
 */
import type { DayAvailability } from '../../api/hooks.js';
export interface SlotSelection {
    roomId: string;
    start: Date;
    end: Date;
}
interface Props {
    data: DayAvailability;
    slotMinutes?: number;
    onSelect: (selection: SlotSelection) => void;
    onOpenBooking: (bookingId: string) => void;
}
export declare function CalendarGrid({ data, slotMinutes, onSelect, onOpenBooking }: Props): import("react").JSX.Element | null;
export {};
//# sourceMappingURL=CalendarGrid.d.ts.map