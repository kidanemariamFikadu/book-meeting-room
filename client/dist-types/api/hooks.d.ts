/**
 * TanStack Query hooks.
 *
 * Every screen reads server state through one of these, never a bare `fetch`,
 * so loading, error and empty states come from the hook rather than being
 * remembered per screen.
 *
 * Query keys and what invalidates them: docs/05-api-spec.md section 9.
 */
import type { Role } from '@roombook/shared';
export interface MeUser {
    id: string;
    email: string;
    fullName: string;
    role: Role;
    status: string;
    timezone: string | null;
    homeLocationId: string | null;
    emailOptOutReminders: boolean;
    lastLoginAt: string | null;
    organization: {
        id: string;
        name: string;
        defaultTimezone: string;
    };
    homeLocation: {
        id: string;
        name: string;
        timezone: string;
    } | null;
    adminLocationIds: string[];
    administersAllLocations: boolean;
}
export interface LocationSummary {
    id: string;
    name: string;
    code: string | null;
    address: string | null;
    timezone: string;
    country: string | null;
    isActive: boolean;
    sortOrder: number;
    roomCount: number;
    currentLocalTime: string;
    businessHoursStart: string | null;
    businessHoursEnd: string | null;
    businessDays: number[];
}
export interface Feature {
    id: string;
    name: string;
    icon: string | null;
    sortOrder: number;
}
export interface RoomSummary {
    id: string;
    name: string;
    capacity: number;
    floor: string | null;
    description: string | null;
    colour: string;
    isActive: boolean;
    requiresApproval: boolean;
    location: {
        id: string;
        name: string;
        timezone: string;
        isActive: boolean;
    };
    features: Feature[];
    hours: Array<{
        id: string;
        weekday: number;
        startLocal: string;
        endLocal: string;
    }>;
    approver: {
        id: string;
        fullName: string;
        email: string;
    } | null;
    limits: {
        minBookingMinutes: number | null;
        maxBookingMinutes: number | null;
        maxAdvanceDays: number | null;
        minNoticeMinutes: number | null;
    };
}
export interface UserRow {
    id: string;
    email: string;
    fullName: string;
    role: Role;
    status: string;
    timezone: string | null;
    homeLocationId: string | null;
    lastLoginAt: string | null;
    lockedUntil: string | null;
    createdAt: string;
    homeLocation: {
        id: string;
        name: string;
    } | null;
    locationAccess: Array<{
        locationId: string;
        location: {
            name: string;
        };
    }>;
}
interface Envelope<T> {
    data: T;
}
export declare const keys: {
    me: readonly ["auth", "me"];
    locations: (opts?: {
        includeInactive?: boolean;
    }) => readonly ["locations", {
        includeInactive?: boolean;
    }];
    location: (id: string) => readonly ["location", string];
    rooms: (filters?: Record<string, unknown>) => readonly ["rooms", Record<string, unknown>];
    room: (id: string) => readonly ["room", string];
    features: readonly ["features"];
    users: (opts?: Record<string, unknown>) => readonly ["users", Record<string, unknown>];
};
export declare function useMe(enabled?: boolean): import("@tanstack/react-query").UseQueryResult<{
    user: MeUser;
    csrfToken: string;
}, Error>;
export declare function useLocations(opts?: {
    includeInactive?: boolean;
}): import("@tanstack/react-query").UseQueryResult<LocationSummary[], Error>;
export declare function useLocation(id: string | undefined): import("@tanstack/react-query").UseQueryResult<Record<string, unknown>, Error>;
export declare const useCreateLocation: () => import("@tanstack/react-query").UseMutationResult<Envelope<LocationSummary>, Error, Record<string, unknown>, unknown>;
export declare const useUpdateLocation: () => import("@tanstack/react-query").UseMutationResult<Envelope<LocationSummary>, Error, {
    id: string;
} & Record<string, unknown>, unknown>;
export declare const useDeleteLocation: () => import("@tanstack/react-query").UseMutationResult<{
    deleted: boolean;
    name: string;
}, Error, string, unknown>;
export declare const useSetLocationActive: () => import("@tanstack/react-query").UseMutationResult<Envelope<LocationSummary>, Error, {
    id: string;
    isActive: boolean;
}, unknown>;
export interface RoomFilters {
    locationId?: string;
    minCapacity?: number;
    features?: string[];
    includeInactive?: boolean;
    q?: string;
}
export declare function useRooms(filters?: RoomFilters): import("@tanstack/react-query").UseQueryResult<RoomSummary[], Error>;
export declare function useRoom(id: string | undefined): import("@tanstack/react-query").UseQueryResult<RoomSummary, Error>;
export declare const useCreateRoom: () => import("@tanstack/react-query").UseMutationResult<Envelope<RoomSummary>, Error, Record<string, unknown>, unknown>;
export declare const useUpdateRoom: () => import("@tanstack/react-query").UseMutationResult<Envelope<RoomSummary>, Error, {
    id: string;
} & Record<string, unknown>, unknown>;
export declare const useSetRoomActive: () => import("@tanstack/react-query").UseMutationResult<Envelope<RoomSummary>, Error, {
    id: string;
    isActive: boolean;
    force?: boolean;
}, unknown>;
export declare const useDeleteRoom: () => import("@tanstack/react-query").UseMutationResult<{
    deleted: boolean;
    name: string;
}, Error, string, unknown>;
export declare function useFeatures(): import("@tanstack/react-query").UseQueryResult<(Feature & {
    _count: {
        rooms: number;
    };
})[], Error>;
export declare const useCreateFeature: () => import("@tanstack/react-query").UseMutationResult<Envelope<Feature>, Error, {
    name: string;
    icon?: string;
}, unknown>;
export declare const useDeleteFeature: () => import("@tanstack/react-query").UseMutationResult<{
    deleted: boolean;
}, Error, string, unknown>;
export declare function useUsers(opts?: {
    includeDisabled?: boolean;
}): import("@tanstack/react-query").UseQueryResult<UserRow[], Error>;
export declare const useInviteUser: () => import("@tanstack/react-query").UseMutationResult<Envelope<UserRow>, Error, Record<string, unknown>, unknown>;
export declare const useUpdateUser: () => import("@tanstack/react-query").UseMutationResult<Envelope<UserRow>, Error, {
    id: string;
} & Record<string, unknown>, unknown>;
export declare const useResendInvite: () => import("@tanstack/react-query").UseMutationResult<{
    sent: boolean;
}, Error, string, unknown>;
export declare const useSetUserStatus: () => import("@tanstack/react-query").UseMutationResult<Envelope<UserRow>, Error, {
    id: string;
    active: boolean;
    force?: boolean;
}, unknown>;
export declare function useChangePassword(): import("@tanstack/react-query").UseMutationResult<void, Error, {
    currentPassword: string;
    newPassword: string;
}, unknown>;
export declare function useUpdateProfile(): import("@tanstack/react-query").UseMutationResult<Envelope<UserRow>, Error, Record<string, unknown>, unknown>;
export interface BusySlot {
    bookingId: string;
    startsAt: string;
    endsAt: string;
    title: string;
    organizer: {
        id: string;
        fullName: string;
    } | null;
    status: string;
    isPrivate: boolean;
    isMine: boolean;
    canAdminister: boolean;
}
export interface RoomAvailability {
    roomId: string;
    name: string;
    capacity: number;
    floor: string | null;
    colour: string;
    features: Array<{
        id: string;
        name: string;
    }>;
    bookableWindows: Array<{
        startsAt: string;
        endsAt: string;
    }>;
    busy: BusySlot[];
    closures: Array<{
        id: string;
        startsAt: string;
        endsAt: string;
        reason: string;
    }>;
    freeSlots: Array<{
        startsAt: string;
        endsAt: string;
    }>;
}
export interface DayAvailability {
    date: string;
    timezone: string;
    locationId: string;
    locationName: string;
    rooms: RoomAvailability[];
}
export interface FreeRoom {
    roomId: string;
    name: string;
    capacity: number;
    floor: string | null;
    colour: string;
    locationId: string;
    locationName: string;
    timezone: string;
    features: Array<{
        id: string;
        name: string;
    }>;
    requiresApproval: boolean;
}
export interface BookingDetail {
    id: string;
    title: string;
    description: string | null;
    startsAt: string;
    endsAt: string;
    status: string;
    isPrivate: boolean;
    cancellationReason: string | null;
    room: {
        id: string;
        name: string;
        capacity: number;
        floor: string | null;
        colour: string;
        requiresApproval: boolean;
        location: {
            id: string;
            name: string;
            timezone: string;
            address: string | null;
        };
    };
    organizer: {
        id: string;
        fullName: string;
        email: string;
    };
    attendees: Array<{
        id: string;
        email: string;
        displayName: string | null;
        response: string;
    }>;
}
export declare function useDayAvailability(date: string, locationId: string | null | undefined): import("@tanstack/react-query").UseQueryResult<DayAvailability, Error>;
export declare function useFindRooms(params: {
    startsAt: string;
    endsAt: string;
    locationId?: string;
    minCapacity?: number;
    features?: string[];
    allLocations?: boolean;
} | null): import("@tanstack/react-query").UseQueryResult<FreeRoom[], Error>;
export declare function useBookings(filters?: Record<string, string | undefined>): import("@tanstack/react-query").UseQueryResult<BookingDetail[], Error>;
export declare function useBooking(id: string | undefined): import("@tanstack/react-query").UseQueryResult<BookingDetail, Error>;
export declare const useCreateBooking: () => import("@tanstack/react-query").UseMutationResult<{
    data: BookingDetail;
}, Error, Record<string, unknown>, unknown>;
export declare const useUpdateBooking: () => import("@tanstack/react-query").UseMutationResult<{
    data: BookingDetail;
}, Error, {
    id: string;
} & Record<string, unknown>, unknown>;
export declare const useMoveBooking: () => import("@tanstack/react-query").UseMutationResult<{
    data: BookingDetail;
}, Error, {
    id: string;
} & Record<string, unknown>, unknown>;
export declare const useCancelBooking: () => import("@tanstack/react-query").UseMutationResult<{
    data: BookingDetail;
}, Error, {
    id: string;
    reason?: string;
}, unknown>;
export declare const useEndBookingEarly: () => import("@tanstack/react-query").UseMutationResult<{
    data: BookingDetail;
}, Error, string, unknown>;
export {};
//# sourceMappingURL=hooks.d.ts.map