/**
 * The application shell: navigation, location switcher, user menu.
 *
 * Admin entries are rendered only for those who have the role, which is a
 * convenience — the server re-checks every request regardless.
 *
 * Specification: docs/07-ui-screens.md section 3, docs/14-multi-location.md section 7.
 */
import { type ReactNode } from 'react';
import { Button } from '../ui/index.js';
export declare function AppShell(): import("react").JSX.Element | null;
/** A centred container for the auth screens, which have no shell. */
export declare function CentredLayout({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
export { Button };
//# sourceMappingURL=AppShell.d.ts.map