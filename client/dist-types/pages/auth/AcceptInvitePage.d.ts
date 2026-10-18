/**
 * Accept an invitation (S-04), forgotten password (S-02) and reset (S-03).
 *
 * Grouped in one file because they are three variations on "prove you control
 * this mailbox, then choose a password", and keeping them together makes the
 * shared handling of a bad or expired token obvious.
 */
export declare function AcceptInvitePage(): import("react").JSX.Element;
export declare function ForgotPasswordPage(): import("react").JSX.Element;
export declare function ResetPasswordPage(): import("react").JSX.Element;
/** Shown after a password change elsewhere in the app. */
export declare function PasswordChangedNotice(): import("react").JSX.Element;
//# sourceMappingURL=AcceptInvitePage.d.ts.map