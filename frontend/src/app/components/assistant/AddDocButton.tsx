"use client";

import { useRef, useState } from "react";
import { PlusIcon, Upload, LayoutGridIcon, Loader2Icon } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";

interface Props {
    /**
     * Hand the chosen files to the caller. Uploading is owned by the caller
     * (ChatInput) so progress stays visible after this menu closes.
     */
    onFilesSelected: (files: File[]) => void;
    onBrowseAll: () => void;
    selectedDocIds?: string[];
    hideLabel?: boolean;
    /** Whether any upload started from here is still in flight. */
    uploading?: boolean;
}

export function AddDocButton({
    onFilesSelected,
    onBrowseAll,
    selectedDocIds = [],
    hideLabel = false,
    uploading = false,
}: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        // Reset first so re-picking the same file fires `change` again.
        if (fileInputRef.current) fileInputRef.current.value = "";
        if (!files.length) return;
        onFilesSelected(files);
    };

    return (
        <>
            <input
                ref={fileInputRef}
                type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT}
                multiple
                className="hidden"
                onChange={handleChange}
            />
            <DropdownMenu onOpenChange={setIsOpen}>
                <DropdownMenuTrigger asChild>
                    <button
                        className={`flex items-center gap-1 px-2 h-8 rounded-lg text-sm transition-colors cursor-pointer ${
                            selectedDocIds.length > 0
                                ? "text-black hover:bg-gray-100"
                                : "text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                        } ${isOpen ? "bg-gray-100" : ""}`}
                        title="Add documents"
                        aria-label="Add documents"
                    >
                        {uploading ? (
                            <Loader2Icon className="h-4 w-4 shrink-0 animate-spin" />
                        ) : selectedDocIds.length > 0 ? (
                            <span className="font-medium tabular-nums">{selectedDocIds.length}</span>
                        ) : (
                            <PlusIcon
                                className={`h-4 w-4 shrink-0 transition-transform duration-300 ${isOpen ? "rotate-[135deg]" : ""}`}
                            />
                        )}
                        <span className={hideLabel ? "hidden" : "hidden sm:inline"}>
                            {selectedDocIds.length === 1
                                ? "Document"
                                : "Documents"}
                        </span>
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    className="w-44 z-50"
                    side="bottom"
                    align="start"
                >
                    <DropdownMenuItem
                        className="cursor-pointer"
                        onSelect={(e) => {
                            e.preventDefault();
                            fileInputRef.current?.click();
                        }}
                    >
                        <Upload className="h-4 w-4 mr-2 text-gray-500" />
                        <span className="text-sm">Upload files</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={onBrowseAll}
                    >
                        <LayoutGridIcon className="h-4 w-4 mr-2 text-gray-500" />
                        <span className="text-sm">Browse all</span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    );
}
