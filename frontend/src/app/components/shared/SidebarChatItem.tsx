"use client";

import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { MoreHorizontal, Pencil, Trash2, Check, X } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAuth } from "@/contexts/AuthContext";
import {
    streamingChatIds,
    subscribeToRoster,
} from "@/app/hooks/activeStreams";

/** Stable empty snapshot for the server render — a new [] would loop React. */
const EMPTY_IDS: string[] = [];
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import type { Chat } from "@/app/components/shared/types";
import { cn } from "@/lib/utils";

interface Props {
    chat: Chat;
    isActive: boolean;
    onSelect: () => void;
    projectName?: string;
}

// Compact "last used" label for the sidebar: today → time, this week →
// weekday, otherwise a short date (adding the year once it's no longer the
// current one).
function formatRelative(iso: string): string {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return "";
    const now = new Date();
    const sameDay = then.toDateString() === now.toDateString();
    if (sameDay) {
        return then.toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
        });
    }
    const diffDays = Math.floor(
        (now.getTime() - then.getTime()) / 86_400_000,
    );
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) {
        return then.toLocaleDateString(undefined, { weekday: "short" });
    }
    return then.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year:
            then.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
}

// Full "Mon D, YYYY, h:mm AM" used in the hover tooltip.
function formatFull(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

export function SidebarChatItem({ chat, isActive, onSelect, projectName }: Props) {
    const { renameChat, deleteChat } = useChatHistoryContext();
    const { user } = useAuth();
    const [isRenaming, setIsRenaming] = useState(false);
    const [editTitle, setEditTitle] = useState(chat.title ?? "");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const editInputRef = useRef<HTMLInputElement>(null);
    // Sidebar can show collaborator chats from projects the user owns;
    // rename/delete are still creator-only on the backend, so guard here.
    const isChatOwner = !!user?.id && chat.user_id === user.id;

    useEffect(() => {
        if (isRenaming) editInputRef.current?.focus();
    }, [isRenaming]);

    const handleRenameSave = async () => {
        const trimmed = editTitle.trim();
        if (trimmed) await renameChat(chat.id, trimmed);
        setIsRenaming(false);
    };

    const handleRenameCancel = () => {
        setIsRenaming(false);
        setEditTitle(chat.title ?? "");
    };

    const editedIso = chat.updated_at ?? chat.created_at;
    const editedLabel = formatRelative(editedIso);
    const startedFull = formatFull(chat.created_at);
    const editedFull = formatFull(editedIso);
    const titleText = chat.title ?? "Untitled chat";
    // Driven by the live stream registry, so the dot appears on whichever chat
    // is generating — including ones the user has navigated away from.
    const streamingIds = useSyncExternalStore(
        subscribeToRoster,
        streamingChatIds,
        () => EMPTY_IDS,
    );
    const generating = streamingIds.includes(chat.id);
    const hoverTitle =
        `${projectName ? `${projectName}: ` : ""}${titleText}` +
        `${startedFull ? `\nStarted ${startedFull}` : ""}` +
        `${editedFull ? `\nLast used ${editedFull}` : ""}`;

    return (
        <div
            className={cn(
                "group relative flex items-center w-full min-h-9 rounded-md transition-colors",
                isActive ? "bg-gray-200/60" : "hover:bg-gray-100",
            )}
        >
            {isRenaming ? (
                <div className="flex items-center w-full px-2 py-1">
                    <input
                        ref={editInputRef}
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void handleRenameSave();
                            if (e.key === "Escape") handleRenameCancel();
                        }}
                        className="flex-1 bg-white shadow-inner rounded px-1 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button
                        onClick={() => void handleRenameSave()}
                        className="ml-1.5 py-2 hover:bg-gray-200 rounded text-green-600"
                    >
                        <Check className="h-3 w-3" />
                    </button>
                    <button
                        onClick={handleRenameCancel}
                        className="ml-1 py-2 hover:bg-gray-200 rounded text-red-600"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            ) : (
                <>
                    <button
                        onClick={onSelect}
                        className={`flex flex-1 min-w-0 flex-col items-start gap-0.5 px-3 py-1.5 text-left ${
                            isActive ? "text-gray-900" : "text-gray-700"
                        }`}
                        title={hoverTitle}
                    >
                        <span className="flex w-full items-center gap-1.5 text-xs">
                            {/* A chat still generating in the background. The
                                answer is being written whether or not this is
                                the open chat, so say so here rather than
                                letting it look finished. */}
                            {generating && (
                                <span
                                    className="relative flex h-1.5 w-1.5 shrink-0"
                                    title="Still generating"
                                    aria-label="Still generating"
                                >
                                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500 opacity-75" />
                                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-600" />
                                </span>
                            )}
                            <span className="min-w-0 flex-1 truncate">
                                {projectName && (
                                    <span className="text-gray-400 font-normal">
                                        {projectName}:{" "}
                                    </span>
                                )}
                                {titleText}
                            </span>
                        </span>
                        {editedLabel && (
                            <span className="w-full truncate text-[10px] leading-none text-gray-400">
                                {editedLabel}
                            </span>
                        )}
                    </button>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className={`mr-1 rounded-md p-1 text-gray-500 transition-all hover:bg-gray-200 hover:text-gray-900 ${
                                    isActive
                                        ? "opacity-100"
                                        : "opacity-0 group-hover:opacity-100"
                                }`}
                            >
                                <MoreHorizontal className="h-4 w-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="z-101">
                            <DropdownMenuItem
                                onClick={() => {
                                    if (!isChatOwner) {
                                        setOwnerOnlyAction("rename this chat");
                                        return;
                                    }
                                    setEditTitle(chat.title ?? "");
                                    setIsRenaming(true);
                                }}
                            >
                                <Pencil className="mr-2 h-4 w-4" />
                                Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => {
                                    if (!isChatOwner) {
                                        setOwnerOnlyAction("delete this chat");
                                        return;
                                    }
                                    void deleteChat(chat.id);
                                }}
                                className="text-red-600 focus:text-red-600"
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </>
            )}
            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>
    );
}
