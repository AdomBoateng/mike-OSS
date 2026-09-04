"use client";

import { useState, useRef, useEffect, type ClipboardEvent, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "@/app/components/shared/Modal";
import { useAuth } from "@/contexts/AuthContext";
import { challengeMfa, getMfaStatus } from "@/app/lib/mikeApi";

/** Whether the current session must step up (enrolled but not yet verified). */
export async function needsMfaVerification() {
    const status = await getMfaStatus();
    return status.enrolled && !status.sessionVerified;
}

interface MfaVerificationPopupProps {
    open: boolean;
    onCancel: () => void;
    onVerified: () => void;
    title?: string;
    message?: string;
}

export function MfaVerificationPopup({
    open,
    onCancel,
    onVerified,
    title = "Two-factor verification required",
    message = "Enter a code from your authenticator app to continue.",
}: MfaVerificationPopupProps) {
    const { applySessionUser } = useAuth();
    const [code, setCode] = useState("");
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const canVerify = !verifying && code.trim().length === 6;

    useEffect(() => {
        if (open) {
            setCode("");
            setError(null);
        }
    }, [open]);

    async function verify() {
        if (!canVerify) return;

        setVerifying(true);
        setError(null);
        try {
            const sessionUser = await challengeMfa(code.trim());
            applySessionUser(sessionUser);
            setCode("");
            onVerified();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "That code is incorrect or expired.",
            );
        } finally {
            setVerifying(false);
        }
    }

    if (!open) return null;

    return (
        <Modal
            open={open}
            onClose={onCancel}
            title={title}
            size="sm"
            className="h-auto min-h-[310px] max-h-[min(92vh,400px)]"
            cancelAction={{
                label: "Cancel",
                onClick: onCancel,
                disabled: verifying,
            }}
            primaryAction={{
                label: verifying ? (
                    <span className="inline-flex items-center gap-1.5">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Verifying...
                    </span>
                ) : (
                    "Verify"
                ),
                onClick: () => void verify(),
                disabled: !canVerify,
            }}
        >
            <div className="space-y-5 pb-2 pt-0">
                <p className="text-sm text-gray-500 pb-6">{message}</p>
                <div className="space-y-4">
                    <VerificationCodeInput
                        value={code}
                        onChange={setCode}
                        disabled={verifying}
                        autoFocus={open}
                        onSubmit={() => void verify()}
                        canSubmit={canVerify}
                    />
                </div>
                {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
        </Modal>
    );
}

export function VerificationCodeInput({
    value,
    onChange,
    disabled,
    autoFocus,
    onSubmit,
    canSubmit,
}: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    autoFocus?: boolean;
    onSubmit?: () => void;
    canSubmit?: boolean;
}) {
    const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
    const digits = Array.from({ length: 6 }, (_, index) => value[index] ?? "");

    useEffect(() => {
        if (!autoFocus || disabled) return;
        const focusTimer = window.setTimeout(() => {
            const firstEmptyIndex = digits.findIndex((digit) => !digit);
            inputsRef.current[
                firstEmptyIndex === -1 ? 0 : firstEmptyIndex
            ]?.focus();
        }, 0);
        return () => window.clearTimeout(focusTimer);
    }, [autoFocus, disabled]);

    function updateDigit(index: number, nextValue: string) {
        const digit = nextValue.replace(/\D/g, "").slice(-1);
        const nextDigits = [...digits];
        nextDigits[index] = digit;
        onChange(nextDigits.join(""));
        if (digit && index < inputsRef.current.length - 1) {
            inputsRef.current[index + 1]?.focus();
        }
    }

    function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
        event.preventDefault();
        const pasted = event.clipboardData
            .getData("text")
            .replace(/\D/g, "")
            .slice(0, 6);
        if (!pasted) return;
        onChange(pasted);
        inputsRef.current[Math.min(pasted.length, 6) - 1]?.focus();
    }

    function handleKeyDown(
        event: KeyboardEvent<HTMLInputElement>,
        index: number,
    ) {
        if (event.key === "Enter") {
            event.preventDefault();
            if (canSubmit) onSubmit?.();
            return;
        }
        if (event.key === "Backspace" && !digits[index] && index > 0) {
            inputsRef.current[index - 1]?.focus();
        }
        if (event.key === "ArrowLeft" && index > 0) {
            event.preventDefault();
            inputsRef.current[index - 1]?.focus();
        }
        if (event.key === "ArrowRight" && index < digits.length - 1) {
            event.preventDefault();
            inputsRef.current[index + 1]?.focus();
        }
    }

    return (
        <div
            className="flex justify-center gap-2"
            role="group"
            aria-label="Six digit verification code"
        >
            {digits.map((digit, index) => (
                <input
                    key={index}
                    ref={(element) => {
                        inputsRef.current[index] = element;
                    }}
                    type="text"
                    inputMode="numeric"
                    autoComplete={index === 0 ? "one-time-code" : "off"}
                    value={digit}
                    disabled={disabled}
                    onChange={(event) => updateDigit(index, event.target.value)}
                    onPaste={handlePaste}
                    onKeyDown={(event) => handleKeyDown(event, index)}
                    className="h-13 w-12 rounded-lg border border-gray-300 bg-gray-50 text-center text-2xl font-medium font-serif text-gray-950 shadow-none outline-none transition-colors focus:border-gray-400 focus:ring-2 focus:ring-gray-300/45 disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label={`Verification code digit ${index + 1}`}
                    maxLength={1}
                />
            ))}
        </div>
    );
}
