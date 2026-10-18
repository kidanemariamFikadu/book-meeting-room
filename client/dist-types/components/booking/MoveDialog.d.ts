/**
 * The admin move and cancel dialogs (S-14, S-15).
 *
 * Both make the consequence obvious before the admin commits, and both
 * require a written reason that is quoted verbatim to the organizer. The
 * confirm button stays disabled until that reason exists (BR-M5).
 */
import { type BookingDetail } from '../../api/hooks.js';
export declare function MoveDialog({ booking, onClose, onMoved, }: {
    booking: BookingDetail;
    onClose: () => void;
    onMoved: () => void;
}): import("react").JSX.Element;
export declare function CancelDialog({ booking, isOwn, isAdmin, onClose, onCancelled, }: {
    booking: BookingDetail;
    isOwn: boolean;
    isAdmin?: boolean;
    onClose: () => void;
    onCancelled: () => void;
}): import("react").JSX.Element;
//# sourceMappingURL=MoveDialog.d.ts.map