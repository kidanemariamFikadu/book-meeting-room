/**
 * The selected location.
 *
 * Persisted in the URL and in localStorage so a shared link opens on the right
 * site, and a returning user does not have to pick again. The URL wins, since
 * an explicit link should beat a remembered preference.
 *
 * Specification: docs/14-multi-location.md section 7.
 */
import { type LocationSummary } from '../api/hooks.js';
export interface LocationScope {
    locations: LocationSummary[];
    selected: LocationSummary | null;
    selectedId: string | null;
    select: (id: string) => void;
    isLoading: boolean;
    isMultiSite: boolean;
}
export declare function useLocationScope(): LocationScope;
//# sourceMappingURL=useLocationScope.d.ts.map