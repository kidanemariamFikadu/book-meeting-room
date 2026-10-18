/**
 * UI primitives.
 *
 * Anything involving focus management or ARIA is built on Radix rather than
 * hand-rolled — a focus trap written from scratch is how accessibility bugs
 * ship. Everything else is a thin, typed wrapper over a real HTML element, so
 * keyboard behaviour and form semantics come for free.
 *
 * Specification: docs/07-ui-screens.md section 7.
 */
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import s from './ui.module.css';
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    loading?: boolean;
    size?: 'sm' | 'md';
}
export declare const Button: import("react").ForwardRefExoticComponent<ButtonProps & import("react").RefAttributes<HTMLButtonElement>>;
export interface FieldProps {
    label: string;
    error?: string;
    hint?: ReactNode;
    required?: boolean;
    children: ReactNode;
    className?: string;
}
/**
 * Wires a real `<label>` to its control and announces errors.
 *
 * The error is tied with `aria-describedby` and marked `role="alert"`, so a
 * screen reader hears it when it appears rather than only on focus.
 */
export declare function Field({ label, error, hint, required, children, className }: FieldProps): import("react").JSX.Element;
export declare const Input: import("react").ForwardRefExoticComponent<InputHTMLAttributes<HTMLInputElement> & import("react").RefAttributes<HTMLInputElement>>;
export declare const Textarea: import("react").ForwardRefExoticComponent<TextareaHTMLAttributes<HTMLTextAreaElement> & import("react").RefAttributes<HTMLTextAreaElement>>;
export declare const Select: import("react").ForwardRefExoticComponent<SelectHTMLAttributes<HTMLSelectElement> & import("react").RefAttributes<HTMLSelectElement>>;
export declare function Checkbox({ label, description, ...rest }: InputHTMLAttributes<HTMLInputElement> & {
    label: string;
    description?: string;
}): import("react").JSX.Element;
export declare function Badge({ children, tone, }: {
    children: ReactNode;
    tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'pending';
}): import("react").JSX.Element;
/**
 * An error surfaced inline, with the request id available for support.
 *
 * Users are not asked to read a stack trace, but a reference they can quote
 * turns "it broke" into a specific line in the log.
 */
export declare function ErrorNotice({ title, error, onRetry, }: {
    title?: string;
    error: unknown;
    onRetry?: () => void;
}): import("react").JSX.Element;
export declare function InfoNotice({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
/** Explains what would appear here, and offers the action that creates it. */
export declare function EmptyState({ title, description, action, }: {
    title: string;
    description: string;
    action?: ReactNode;
}): import("react").JSX.Element;
/** Fixed-height skeleton rows, so content arriving causes no layout shift. */
export declare function Skeleton({ rows }: {
    rows?: number;
}): import("react").JSX.Element;
export declare function FullPageSpinner({ label }: {
    label?: string;
}): import("react").JSX.Element;
export interface ModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    children?: ReactNode;
    footer?: ReactNode;
    wide?: boolean;
}
export declare function Modal({ open, onOpenChange, title, description, children, footer, wide, }: ModalProps): import("react").JSX.Element;
/**
 * A confirmation that states the consequence before it happens.
 *
 * `consequence` is deliberately a required prop: "Are you sure?" tells the user
 * nothing, while "The room will be free immediately and 3 people emailed" does.
 */
export declare function ConfirmDialog({ open, onOpenChange, title, consequence, confirmLabel, destructive, loading, onConfirm, children, }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    consequence: ReactNode;
    confirmLabel?: string;
    destructive?: boolean;
    loading?: boolean;
    onConfirm: () => void;
    children?: ReactNode;
}): import("react").JSX.Element;
interface Toast {
    id: number;
    message: string;
    tone: 'success' | 'error';
}
export declare function ToastProvider({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
export declare function useToast(): {
    show: (message: string, tone?: Toast["tone"]) => void;
};
export declare function PageHeader({ title, description, actions, }: {
    title: string;
    description?: string;
    actions?: ReactNode;
}): import("react").JSX.Element;
export declare function Card({ children, className }: {
    children: ReactNode;
    className?: string;
}): import("react").JSX.Element;
export { s as uiStyles };
//# sourceMappingURL=index.d.ts.map