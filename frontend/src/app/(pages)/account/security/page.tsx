"use client";

import {
    useEffect,
    useRef,
    useState,
    type ClipboardEvent,
    type KeyboardEvent,
} from "react";
import { Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    enrollMfa,
    getMfaStatus,
    isMfaRequiredError,
    unenrollMfa,
    verifyMfaEnrollment,
} from "@/app/lib/mikeApi";
import { Modal } from "@/app/components/shared/Modal";
import {
    MfaVerificationPopup,
    needsMfaVerification,
} from "@/app/components/shared/MfaVerificationPopup";
import { accountGlassPrimaryButtonClassName } from "../accountStyles";
import { AccountSection } from "../AccountSection";
import { AccountToggle } from "../AccountToggle";

type Enrollment = {
    qrCode: string;
    secret: string;
};

function VerificationCodeInput({
    value,
    onChange,
    disabled,
}: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}) {
    const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
    const digits = Array.from({ length: 6 }, (_, index) => value[index] ?? "");

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
                    className="h-11 w-10 rounded-lg border border-transparent bg-gray-100 text-center text-lg font-medium text-gray-950 shadow-none outline-none transition-colors focus:border-gray-200 focus:ring-2 focus:ring-gray-300/45 disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label={`Verification code digit ${index + 1}`}
                    maxLength={1}
                />
            ))}
        </div>
    );
}

function MfaSettingsSkeleton() {
    return (
        <div className="px-4 py-5">
            <div className="space-y-1">
                <div className="flex items-start justify-between gap-3">
                    <div className="h-4 w-36 animate-pulse rounded bg-gray-100" />
                    <div className="h-3 w-14 shrink-0 animate-pulse rounded bg-gray-100" />
                </div>
                <div className="space-y-1.5 pt-1">
                    <div className="h-3 w-full max-w-md animate-pulse rounded bg-gray-100" />
                    <div className="h-3 w-3/4 max-w-sm animate-pulse rounded bg-gray-100" />
                </div>
            </div>
            <div className="mt-3 flex justify-end">
                <div className="h-9 w-20 animate-pulse rounded-lg bg-gray-100" />
            </div>
        </div>
    );
}

export default function SecurityPage() {
    const { applySessionToken } = useAuth();
    const { profile, updateMfaOnLogin } = useUserProfile();
    const [loading, setLoading] = useState(true);
    const [hasVerifiedFactor, setHasVerifiedFactor] = useState(false);
    const [sessionVerified, setSessionVerified] = useState(false);
    const [setupModalOpen, setSetupModalOpen] = useState(false);
    const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
    const [verificationCode, setVerificationCode] = useState("");
    const [setupKeyCopied, setSetupKeyCopied] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [savingLoginPreference, setSavingLoginPreference] = useState(false);
    const [pendingUnenroll, setPendingUnenroll] = useState(false);
    const [pendingLoginPreference, setPendingLoginPreference] = useState<
        boolean | null
    >(null);

    async function refreshMfaState() {
        setLoading(true);
        setStatus(null);
        try {
            const state = await getMfaStatus();
            setHasVerifiedFactor(state.enrolled);
            setSessionVerified(state.sessionVerified);
        } catch (error) {
            setStatus(
                error instanceof Error
                    ? error.message
                    : "Failed to load authenticator status.",
            );
            setHasVerifiedFactor(false);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void refreshMfaState();
    }, []);

    async function startEnrollment() {
        setBusy(true);
        setStatus(null);
        try {
            const data = await enrollMfa();
            setEnrollment({ qrCode: data.qrCode, secret: data.secret });
            setVerificationCode("");
            setSetupKeyCopied(false);
        } catch (error) {
            setStatus(
                error instanceof Error
                    ? error.message
                    : "Failed to start MFA setup.",
            );
        } finally {
            setBusy(false);
        }
    }

    function closeSetupModal() {
        if (busy) return;
        setSetupModalOpen(false);
        setEnrollment(null);
        setVerificationCode("");
        setSetupKeyCopied(false);
    }

    function returnToSetupInstructions() {
        if (busy) return;
        setEnrollment(null);
        setVerificationCode("");
        setSetupKeyCopied(false);
    }

    async function verifyEnrollment() {
        if (!enrollment || verificationCode.trim().length !== 6) return;

        setBusy(true);
        setStatus(null);
        try {
            const token = await verifyMfaEnrollment(verificationCode.trim());
            applySessionToken(token);
            setEnrollment(null);
            setSetupModalOpen(false);
            setVerificationCode("");
            setSetupKeyCopied(false);
            setStatus("MFA enabled.");
            await refreshMfaState();
        } catch (error) {
            setStatus(
                error instanceof Error
                    ? error.message
                    : "Failed to verify MFA code.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function copySetupKey() {
        if (!enrollment?.secret) return;
        await navigator.clipboard.writeText(enrollment.secret);
        setSetupKeyCopied(true);
        window.setTimeout(() => setSetupKeyCopied(false), 1600);
    }

    async function requestUnenroll() {
        setStatus(null);
        await unenrollFactor();
    }

    async function unenrollFactor() {
        setBusy(true);
        setStatus(null);
        try {
            await unenrollMfa();
            if (profile?.mfaOnLogin) {
                void updateMfaOnLogin(false);
            }
            setStatus("MFA disabled.");
            await refreshMfaState();
        } catch (error) {
            if (isMfaRequiredError(error)) {
                setPendingUnenroll(true);
                return;
            }
            setStatus(
                error instanceof Error
                    ? error.message
                    : "Failed to remove authenticator app.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleLoginPreferenceToggle() {
        if (!hasVerifiedFactor || savingLoginPreference) return;
        const enabled = !(profile?.mfaOnLogin === true);
        setSavingLoginPreference(true);
        setStatus(null);
        try {
            if (await needsMfaVerification()) {
                setPendingLoginPreference(enabled);
                return;
            }
            await saveLoginPreference(enabled);
        } catch (error) {
            setStatus(
                error instanceof Error
                    ? error.message
                    : "Failed to update login authentication preference.",
            );
        } finally {
            setSavingLoginPreference(false);
        }
    }

    async function saveLoginPreference(enabled: boolean) {
        setSavingLoginPreference(true);
        setStatus(null);
        try {
            const success = await updateMfaOnLogin(enabled);
            if (!success) {
                setStatus("Failed to update login authentication preference.");
            }
        } catch (error) {
            if (isMfaRequiredError(error)) {
                setPendingLoginPreference(enabled);
            } else {
                setStatus(
                    error instanceof Error
                        ? error.message
                        : "Failed to update login authentication preference.",
                );
            }
        } finally {
            setSavingLoginPreference(false);
        }
    }

    const loginMfaEnabled = profile?.mfaOnLogin === true;

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Multi-Factor Authentication
                </h2>
                <AccountSection>
                    {loading ? (
                        <MfaSettingsSkeleton />
                    ) : (
                        <>
                            <div className="px-4 py-5">
                                <div className="space-y-1">
                                    <div className="flex items-start justify-between gap-3">
                                        <p className="text-sm font-medium text-gray-900">
                                            Verification method
                                        </p>
                                        <span
                                            className={`shrink-0 text-xs font-medium ${
                                                hasVerifiedFactor
                                                    ? "text-green-700"
                                                    : "text-gray-500"
                                            }`}
                                        >
                                            {hasVerifiedFactor
                                                ? "Enabled"
                                                : "Not set up"}
                                        </span>
                                    </div>
                                    <p className="text-sm text-gray-500">
                                        {hasVerifiedFactor
                                            ? sessionVerified
                                                ? "Authenticator app is saved on your account. Sensitive actions are unlocked for this session."
                                                : "Authenticator app is saved on your account. Sensitive actions require a verification code."
                                            : "Add an authenticator app to protect sensitive actions such as exporting data, deleting data, deleting your account, and changing API keys."}
                                    </p>
                                </div>
                                {!hasVerifiedFactor && !enrollment ? (
                                    <div className="mt-3 flex justify-end">
                                        <Button
                                            variant="outline"
                                            onClick={() =>
                                                setSetupModalOpen(true)
                                            }
                                            disabled={busy}
                                            className={`h-9 w-full gap-1.5 sm:w-auto ${accountGlassPrimaryButtonClassName}`}
                                        >
                                            {busy ? (
                                                <>
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                    Starting...
                                                </>
                                            ) : (
                                                "Set up"
                                            )}
                                        </Button>
                                    </div>
                                ) : null}
                            </div>

                            {hasVerifiedFactor && (
                                <>
                                    <div className="mx-4 h-px bg-gray-200" />
                                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="space-y-1">
                                            <p className="text-sm font-medium text-gray-900">
                                                Login verification
                                            </p>
                                            <p className="text-sm text-gray-500">
                                                Ask for an authenticator code
                                                after each new login, instead of
                                                only before sensitive actions.
                                            </p>
                                        </div>
                                        <AccountToggle
                                            checked={loginMfaEnabled}
                                            disabled={savingLoginPreference}
                                            loading={savingLoginPreference}
                                            size="md"
                                            onChange={() =>
                                                void handleLoginPreferenceToggle()
                                            }
                                        />
                                    </div>
                                    <div className="flex justify-end px-4 pb-4 pt-1">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void requestUnenroll()
                                            }
                                            disabled={busy}
                                            className="text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
                                        >
                                            Remove authenticator app
                                        </button>
                                    </div>
                                </>
                            )}
                        </>
                    )}

                    {status && (
                        <>
                            <div className="mx-4 h-px bg-gray-200" />
                            <p className="px-4 py-3 text-xs text-gray-500">
                                {status}
                            </p>
                        </>
                    )}
                </AccountSection>
            </section>
            <Modal
                open={setupModalOpen}
                onClose={() => closeSetupModal()}
                title="Set up authenticator app"
                cancelAction={{
                    label: enrollment ? "Back" : "Cancel",
                    onClick: enrollment
                        ? () => returnToSetupInstructions()
                        : () => closeSetupModal(),
                    disabled: busy,
                }}
                primaryAction={
                    enrollment
                        ? {
                              label: busy ? "Verifying..." : "Verify",
                              onClick: () => void verifyEnrollment(),
                              disabled:
                                  busy || verificationCode.trim().length !== 6,
                          }
                        : {
                              label: busy ? "Starting..." : "Continue",
                              onClick: () => void startEnrollment(),
                              disabled: busy,
                          }
                }
            >
                <div className={enrollment ? "space-y-3 pt-2" : "space-y-5 pt-3"}>
                    {!enrollment ? (
                        <>
                            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                                Step 1
                            </p>
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-gray-900">
                                    Before you start
                                </p>
                                <p className="text-sm text-gray-500">
                                    Download an authenticator app such as Google
                                    Authenticator, Microsoft Authenticator,
                                    Authy, 1Password, or iCloud Passwords.
                                </p>
                            </div>
                            <ol className="list-decimal space-y-1 pl-4 text-sm text-gray-500">
                                <li>
                                    Download and open your authenticator app.
                                </li>
                                <li>
                                    Choose the option to add a new account.
                                </li>
                            </ol>
                        </>
                    ) : (
                        <>
                            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                                Step 2
                            </p>
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-gray-900">
                                    Scan this code
                                </p>
                                <p className="text-sm text-gray-500">
                                    In your authenticator app, add a new account
                                    and scan the QR code. If you cannot scan it,
                                    enter the setup key below manually.
                                </p>
                            </div>
                            <div className="min-w-0">
                                <div className="mb-1 flex items-center justify-between gap-3">
                                    <p className="text-xs font-medium text-gray-500">
                                        Setup key
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => void copySetupKey()}
                                        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition-colors hover:text-gray-950"
                                    >
                                        <Copy className="h-3 w-3" />
                                        {setupKeyCopied ? "Copied" : "Copy"}
                                    </button>
                                </div>
                                <p className="break-all text-xs text-gray-700">
                                    {enrollment.secret}
                                </p>
                            </div>
                            <div className="flex justify-center">
                                <div className="flex h-48 w-48 items-center justify-center rounded-xl bg-white p-2">
                                    <img
                                        src={enrollment.qrCode}
                                        alt="MFA QR code"
                                        className="h-full w-full"
                                    />
                                </div>
                            </div>
                            <div className="min-w-0 space-y-3">
                                <VerificationCodeInput
                                    value={verificationCode}
                                    onChange={setVerificationCode}
                                    disabled={busy}
                                />
                            </div>
                        </>
                    )}
                </div>
            </Modal>
            <MfaVerificationPopup
                open={pendingUnenroll}
                onCancel={() => setPendingUnenroll(false)}
                onVerified={() => {
                    setPendingUnenroll(false);
                    void unenrollFactor();
                }}
            />
            <MfaVerificationPopup
                open={pendingLoginPreference !== null}
                onCancel={() => setPendingLoginPreference(null)}
                onVerified={() => {
                    const enabled = pendingLoginPreference;
                    setPendingLoginPreference(null);
                    if (enabled !== null) void saveLoginPreference(enabled);
                }}
                title="Authenticator required"
                message="Enter a code from your authenticator app to change login verification."
            />
        </div>
    );
}
