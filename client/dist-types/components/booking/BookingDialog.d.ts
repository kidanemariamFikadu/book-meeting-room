/**
 * Creating a booking (S-07), and recovering from a clash (BR-C4).
 *
 * The conflict panel is the point of this component. A 409 is never a dead
 * end: the server returns the nearest free times in the same room and other
 * rooms free at that moment, and each is one click away. The user never
 * retypes anything.
 */
export interface DraftBooking {
    roomId: string;
    roomName: string;
    start: Date;
    end: Date;
    timezone: string;
    requiresApproval?: boolean;
}
export declare function BookingDialog({ draft, onClose, onBooked, rooms, }: {
    draft: DraftBooking;
    onClose: () => void;
    onBooked: (id: string) => void;
    rooms: Array<{
        roomId: string;
        name: string;
    }>;
}): import("react").JSX.Element;
export declare function StatusBadge({ status }: {
    status: string;
}): import("react").JSX.Element;
//# sourceMappingURL=BookingDialog.d.ts.map