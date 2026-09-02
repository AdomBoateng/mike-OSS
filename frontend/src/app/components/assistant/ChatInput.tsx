"use client";

import {
    useState,
    useCallback,
    useEffect,
    useRef,
    forwardRef,
    useImperativeHandle,
} from "react";
import {
    AlertCircle,
    ArrowRight,
    Check,
    File,
    FileText,
    FolderOpen,
    Library,
    Loader2,
    RotateCw,
    Square,
    X,
} from "lucide-react";
import { AddDocButton } from "./AddDocButton";
import { AddDocumentsModal } from "../shared/AddDocumentsModal";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { ApiKeyMissingModal } from "../shared/ApiKeyMissingModal";
import { ModelToggle } from "./ModelToggle";
import { useSelectedModel, getStoredModelId } from "@/app/hooks/useSelectedModel";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { uploadStandaloneDocument } from "@/app/lib/mikeApi";
import {
    formatUnsupportedDocumentWarning,
    partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import type { Document, Message } from "../shared/types";
import { cn } from "@/lib/utils";

export interface ChatInputHandle {
    addDoc: (doc: Document) => void;
}

/**
 * A file being uploaded from the composer. `file` is retained on failure so the
 * chip can offer a retry without asking the user to re-pick it.
 */
interface UploadItem {
    uploadId: string;
    filename: string;
    status: "uploading" | "error";
    file?: File;
}

interface Props {
    onSubmit: (message: Message) => void;
    onCancel: () => void;
    isLoading: boolean;
    /**
     * The user's own past messages in this chat, oldest first, for Up-arrow
     * recall. Omitted on a brand-new chat, where there is nothing to recall.
     */
    history?: string[];
    hideAddDocButton?: boolean;
    hideWorkflowButton?: boolean;
    onProjectsClick?: () => void;
    projectName?: string;
    projectCmNumber?: string | null;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
    {
        onSubmit,
        onCancel,
        isLoading,
        history,
        hideAddDocButton,
        hideWorkflowButton,
        onProjectsClick,
        projectName,
        projectCmNumber,
    }: Props,
    ref,
) {
    const [value, setValue] = useState("");
    const [attachedDocs, setAttachedDocs] = useState<Document[]>([]);
    const [selectedWorkflow, setSelectedWorkflow] = useState<{
        id: string;
        title: string;
    } | null>(null);
    const [model, setModel] = useSelectedModel();
    const { profile, customModels } = useUserProfile();
    const apiKeys = profile?.apiKeys;
    const customConfigured = profile?.customLlmConfigured ?? false;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const controlsRef = useRef<HTMLDivElement>(null);
    // Shell-style history recall. `historyIndex` is a position in `history`, or
    // null when the composer is showing the user's own draft rather than a
    // recalled message. The draft is stashed on the first Up so walking back
    // and forward again returns what they had actually typed.
    const [historyIndex, setHistoryIndex] = useState<number | null>(null);
    const draftRef = useRef("");
    const [compactControls, setCompactControls] = useState(false);
    const [docSelectorOpen, setDocSelectorOpen] = useState(false);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [uploads, setUploads] = useState<UploadItem[]>([]);
    const [uploadWarning, setUploadWarning] = useState<string | null>(null);
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);

    useImperativeHandle(ref, () => ({
        addDoc: (doc: Document) => {
            setAttachedDocs((prev) => {
                if (prev.some((d) => d.id === doc.id)) return prev;
                return [...prev, doc];
            });
        },
    }));

    // Only custom-endpoint models are selectable now, so if the persisted
    // selection is a (removed) built-in model, snap it to the first available
    // custom model once the endpoint's models have loaded. Guard against the
    // first-render window where `model` still holds the pre-hydration default
    // (a built-in id) but a valid custom model is already saved — snapping then
    // would clobber the user's real choice with the first model in the list.
    useEffect(() => {
        if (customModels.length === 0) return;
        if (customModels.some((m) => m.id === model)) return;
        const stored = getStoredModelId();
        if (stored && customModels.some((m) => m.id === stored)) return;
        setModel(customModels[0].id);
    }, [customModels, model, setModel]);

    useEffect(() => {
        const el = controlsRef.current;
        if (!el) return;
        const update = () => setCompactControls(el.offsetWidth < 430);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const handleAddDocsFromSelector = useCallback(
        (selectedDocs: Document[]) => {
            setAttachedDocs((prev) => {
                const existing = new Set(prev.map((d) => d.id));
                return [
                    ...prev,
                    ...selectedDocs.filter((d) => !existing.has(d.id)),
                ];
            });
        },
        [],
    );

    // Uploads are owned here rather than in AddDocButton so their progress stays
    // on screen after that dropdown closes: each file gets a chip alongside the
    // attached-document chips, which turns into the real chip on success or an
    // inline retry/dismiss on failure. Files are uploaded and tracked
    // individually so one rejected file does not discard the others.
    const handleUploadFiles = useCallback((files: File[]) => {
        const { supported, unsupported } =
            partitionSupportedDocumentFiles(files);
        setUploadWarning(formatUnsupportedDocumentWarning(unsupported));
        if (supported.length === 0) return;

        const started = supported.map((file) => ({
            uploadId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            file,
        }));
        setUploads((prev) => [
            ...prev,
            ...started.map(({ uploadId, file }) => ({
                uploadId,
                filename: file.name,
                status: "uploading" as const,
            })),
        ]);

        started.forEach(({ uploadId, file }) => {
            uploadStandaloneDocument(file)
                .then((doc) => {
                    setUploads((prev) =>
                        prev.filter((u) => u.uploadId !== uploadId),
                    );
                    setAttachedDocs((prev) =>
                        prev.some((d) => d.id === doc.id) ? prev : [...prev, doc],
                    );
                })
                .catch((err) => {
                    console.error("Upload failed:", err);
                    setUploads((prev) =>
                        prev.map((u) =>
                            u.uploadId === uploadId
                                ? { ...u, status: "error" as const, file }
                                : u,
                        ),
                    );
                });
        });
    }, []);

    const retryUpload = useCallback(
        (uploadId: string) => {
            const failed = uploads.find((u) => u.uploadId === uploadId);
            if (!failed?.file) return;
            setUploads((prev) => prev.filter((u) => u.uploadId !== uploadId));
            handleUploadFiles([failed.file]);
        },
        [uploads, handleUploadFiles],
    );

    const uploadingCount = uploads.filter(
        (u) => u.status === "uploading",
    ).length;

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setValue(e.target.value);
        // Editing makes it their text, not a recalled message: drop out of
        // history so the next Up starts again from the most recent message.
        setHistoryIndex(null);
        const el = e.target;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    };

    /** Put a recalled message in the composer, resized, caret at the end. */
    const applyRecalled = (text: string) => {
        setValue(text);
        const el = textareaRef.current;
        if (!el) return;
        // The caret has to move after React has painted the new value,
        // otherwise setSelectionRange applies to the old text.
        requestAnimationFrame(() => {
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
            el.setSelectionRange(text.length, text.length);
        });
    };

    const handleSubmit = () => {
        const query = value.trim();
        if (!query || isLoading) return;
        // Hold the message until in-flight uploads land, otherwise the docs the
        // user just picked would not be attached to the turn they picked them for.
        if (uploadingCount > 0) return;
        if (apiKeys && !isModelAvailable(model, apiKeys, customConfigured)) {
            setApiKeyModalProvider(getModelProvider(model));
            return;
        }
        setValue("");
        setHistoryIndex(null);
        draftRef.current = "";
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
        }

        const files = attachedDocs.map((d) => ({
            filename: d.filename,
            document_id: d.id,
        }));
        setAttachedDocs([]);
        const wf = selectedWorkflow;
        setSelectedWorkflow(null);

        onSubmit?.({
            role: "user",
            content: query,
            files: files.length > 0 ? files : undefined,
            workflow: wf ?? undefined,
            model,
        });
    };

    const handleActionClick = () => {
        if (isLoading) {
            onCancel();
        } else {
            handleSubmit();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
            return;
        }

        const past = history ?? [];
        const el = e.currentTarget;
        const caret = el.selectionStart;
        const collapsed = caret === el.selectionEnd;

        // Up recalls the previous message. Entering history requires the caret
        // at the very start, so Up still moves the cursor inside a multi-line
        // draft; but once recalling, repeated Up keeps walking back the way a
        // shell does — the caret sits at the end of the recalled text, so
        // requiring position 0 again would strand the user after one step.
        // Typing resets historyIndex, which hands Up back to the cursor.
        const browsing = historyIndex !== null;
        if (
            e.key === "ArrowUp" &&
            past.length > 0 &&
            collapsed &&
            (browsing || caret === 0)
        ) {
            e.preventDefault();
            if (historyIndex === null) draftRef.current = value;
            const next =
                historyIndex === null
                    ? past.length - 1
                    : Math.max(0, historyIndex - 1);
            setHistoryIndex(next);
            applyRecalled(past[next]);
            return;
        }

        // Down walks back towards the present, and past the newest message
        // restores whatever draft the recall interrupted.
        if (e.key === "ArrowDown" && browsing && collapsed) {
            e.preventDefault();
            if (historyIndex >= past.length - 1) {
                setHistoryIndex(null);
                applyRecalled(draftRef.current);
            } else {
                const next = historyIndex + 1;
                setHistoryIndex(next);
                applyRecalled(past[next]);
            }
        }
    };

    return (
        <>
            <div className="w-full">
                <div className="rounded-[18px] border border-white/65 bg-white/60 shadow-[0_4px_10px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.85),inset_0_-6px_14px_rgba(255,255,255,0.18)] backdrop-blur-2xl md:rounded-[22px]">
                    {/* Attached chips */}
                    {(selectedWorkflow ||
                        attachedDocs.length > 0 ||
                        uploads.length > 0) && (
                        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                            {selectedWorkflow && (
                                <div className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full text-xs bg-blue-600 text-white border border-white/20 shadow backdrop-blur-sm">
                                    <Library className="h-2.5 w-2.5 shrink-0" />
                                    <span className="max-w-[140px] truncate">
                                        {selectedWorkflow.title}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setSelectedWorkflow(null)
                                        }
                                        className="rounded-full p-0.5 ml-0.5 text-white/60 hover:text-white hover:bg-white/20 transition-colors"
                                    >
                                        <X className="h-2.5 w-2.5" />
                                    </button>
                                </div>
                            )}
                            {attachedDocs.map((doc) => {
                                const ft = doc.file_type?.toLowerCase();
                                const isPdf = ft === "pdf";
                                return (
                                    <div
                                        key={doc.id}
                                        className="inline-flex items-center gap-1 rounded-[10px] border border-white/70 bg-white py-0.5 pl-2 pr-1 text-xs text-gray-800 shadow-[0_2px_6px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl"
                                    >
                                        {isPdf ? (
                                            <FileText className="h-2.5 w-2.5 shrink-0 text-red-500" />
                                        ) : (
                                            <File className="h-2.5 w-2.5 shrink-0 text-blue-500" />
                                        )}
                                        <span className="max-w-[140px] truncate">
                                            {doc.filename}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setAttachedDocs((prev) =>
                                                    prev.filter(
                                                        (d) => d.id !== doc.id,
                                                    ),
                                                )
                                            }
                                            className="ml-0.5 rounded-full p-0.5 text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-gray-700"
                                        >
                                            <X className="h-2.5 w-2.5" />
                                        </button>
                                    </div>
                                );
                            })}
                            {uploads.map((u) => {
                                const failed = u.status === "error";
                                return (
                                    <div
                                        key={u.uploadId}
                                        className={cn(
                                            "inline-flex items-center gap-1 rounded-[10px] border py-0.5 pl-2 pr-1 text-xs shadow-[0_2px_6px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl",
                                            failed
                                                ? "border-red-200 bg-red-50 text-red-700"
                                                : "border-white/70 bg-white text-gray-500",
                                        )}
                                        title={
                                            failed
                                                ? `Upload failed: ${u.filename}`
                                                : `Uploading ${u.filename}…`
                                        }
                                    >
                                        {failed ? (
                                            <AlertCircle className="h-2.5 w-2.5 shrink-0 text-red-500" />
                                        ) : (
                                            <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-gray-400" />
                                        )}
                                        <span
                                            className={cn(
                                                "max-w-[140px] truncate",
                                                !failed && "animate-pulse",
                                            )}
                                        >
                                            {u.filename}
                                        </span>
                                        {failed && (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    retryUpload(u.uploadId)
                                                }
                                                aria-label={`Retry uploading ${u.filename}`}
                                                title="Retry"
                                                className="ml-0.5 rounded-full p-0.5 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-600"
                                            >
                                                <RotateCw className="h-2.5 w-2.5" />
                                            </button>
                                        )}
                                        {failed && (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setUploads((prev) =>
                                                        prev.filter(
                                                            (p) =>
                                                                p.uploadId !==
                                                                u.uploadId,
                                                        ),
                                                    )
                                                }
                                                aria-label={`Dismiss failed upload ${u.filename}`}
                                                className="rounded-full p-0.5 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-600"
                                            >
                                                <X className="h-2.5 w-2.5" />
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {uploadWarning && (
                        <div className="flex items-start gap-1.5 px-3 pt-2 text-xs text-amber-700">
                            <AlertCircle className="mt-[1px] h-3 w-3 shrink-0" />
                            <span className="flex-1">{uploadWarning}</span>
                            <button
                                type="button"
                                onClick={() => setUploadWarning(null)}
                                aria-label="Dismiss warning"
                                className="rounded-full p-0.5 text-amber-500 transition-colors hover:bg-amber-500/10 hover:text-amber-700"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </div>
                    )}

                    {/* Input */}
                    <div className="px-4 pt-4">
                        <textarea
                            ref={textareaRef}
                            rows={1}
                            placeholder="Ask a question about your documents..."
                            value={value}
                            onChange={handleChange}
                            onKeyDown={handleKeyDown}
                            className="w-full resize-none text-sm overflow-hidden border-0 text-base p-0 bg-transparent outline-none placeholder:text-gray-400 leading-6 max-h-48"
                        />
                    </div>

                    {/* Controls */}
                    <div
                        ref={controlsRef}
                        className="flex items-center justify-between md:p-2.5 p-2"
                    >
                        <div className="flex items-center gap-1">
                            {!hideAddDocButton && (
                                <AddDocButton
                                    onFilesSelected={handleUploadFiles}
                                    onBrowseAll={() => setDocSelectorOpen(true)}
                                    selectedDocIds={attachedDocs.map(
                                        (d) => d.id,
                                    )}
                                    hideLabel={compactControls}
                                    uploading={uploadingCount > 0}
                                />
                            )}
                            {!hideWorkflowButton && (
                                <button
                                    type="button"
                                    onClick={() => setWorkflowModalOpen(true)}
                                    aria-label="Open workflows"
                                    className={cn(
                                        "flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors",
                                        selectedWorkflow
                                            ? "text-blue-600 hover:bg-white/55"
                                            : "text-gray-400 hover:bg-white/55 hover:text-gray-700",
                                    )}
                                >
                                    {selectedWorkflow ? (
                                        <Check className="h-3.5 w-3.5" />
                                    ) : (
                                        <Library className="h-3.5 w-3.5" />
                                    )}
                                    <span
                                        className={
                                            compactControls
                                                ? "hidden"
                                                : "hidden sm:inline"
                                        }
                                    >
                                        Workflows
                                    </span>
                                </button>
                            )}
                            {onProjectsClick && (
                                <button
                                    type="button"
                                    onClick={onProjectsClick}
                                    aria-label="Open projects"
                                    className={cn(
                                        "flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm text-gray-400 hover:text-gray-700 transition-colors",
                                        "hover:bg-white/55",
                                    )}
                                >
                                    <FolderOpen className="h-3.5 w-3.5" />
                                    <span className="hidden sm:inline">
                                        Projects
                                    </span>
                                </button>
                            )}
                        </div>

                        <div className="flex items-center gap-1">
                            <ModelToggle
                                value={model}
                                onChange={setModel}
                                apiKeys={apiKeys}
                                customModels={customModels}
                                customConfigured={customConfigured}
                            />
                            <button
                                type="button"
                                className={cn(
                                    "relative bg-gradient-to-b from-neutral-700 to-black text-white rounded-[10px] h-8 w-8 flex items-center justify-center cursor-pointer disabled:cursor-default disabled:from-neutral-600 disabled:to-black backdrop-blur-xl border border-white/30 active:enabled:scale-95 transition-all duration-150",
                                    "shadow-[0_5px_14px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.24)]",
                                )}
                                onClick={handleActionClick}
                                disabled={
                                    !isLoading &&
                                    (!value.trim() || uploadingCount > 0)
                                }
                                title={
                                    uploadingCount > 0
                                        ? `Waiting for ${uploadingCount} upload${uploadingCount === 1 ? "" : "s"} to finish…`
                                        : undefined
                                }
                            >
                                {isLoading ? (
                                    <Square
                                        className="h-4 w-4"
                                        fill="currentColor"
                                        strokeWidth={0}
                                    />
                                ) : uploadingCount > 0 ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <ArrowRight className="h-4 w-4" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <AddDocumentsModal
                open={docSelectorOpen}
                onClose={() => setDocSelectorOpen(false)}
                onSelect={handleAddDocsFromSelector}
                breadcrumb={["Assistant", "Add Documents"]}
            />
            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={(wf) => {
                    setSelectedWorkflow({ id: wf.id, title: wf.title });
                    setWorkflowModalOpen(false);
                }}
                projectName={projectName}
                projectCmNumber={projectCmNumber}
            />
            <ApiKeyMissingModal
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
        </>
    );
});
