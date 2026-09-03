"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Sparkles, PencilLine, Upload } from "lucide-react";
import { listDocumentsOverview } from "@/app/lib/mikeApi";
import type { DocumentOverview } from "../shared/types";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { HeaderFilterDropdown } from "../shared/HeaderFilterDropdown";
import {
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableHeaderRow,
    TableRow,
    TableScrollArea,
} from "../shared/TablePrimitive";

/**
 * Provenance filter. "assistant" deliberately covers both documents the
 * assistant wrote and ones it edited: from a lawyer's point of view the
 * question is "what has the assistant touched", not which of the two
 * mechanisms produced it.
 */
type OriginFilter = "upload" | "assistant" | "assistant_edited";

const ORIGIN_OPTIONS: { value: OriginFilter; label: string }[] = [
    { value: "upload", label: "Uploaded by me" },
    { value: "assistant", label: "Created by assistant" },
    { value: "assistant_edited", label: "Edited by assistant" },
];

const STANDALONE = "__standalone__";

function formatBytes(bytes: number | null): string {
    if (bytes === null || bytes <= 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatDate(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

/** Where clicking a row should go: the project viewer, or the standalone one. */
function documentHref(doc: DocumentOverview): string {
    return doc.project_id
        ? `/projects/${doc.project_id}?document=${doc.id}`
        : `/assistant?document=${doc.id}`;
}

export function DocumentList() {
    const router = useRouter();
    const [documents, setDocuments] = useState<DocumentOverview[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [projectFilter, setProjectFilter] = useState<string | null>(null);
    const [originFilter, setOriginFilter] = useState<OriginFilter | null>(null);

    useEffect(() => {
        let cancelled = false;
        listDocumentsOverview()
            .then((docs) => {
                if (!cancelled) setDocuments(docs);
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Could not load documents.",
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Only projects that actually hold a visible document are offered, so the
    // filter can never select an empty result.
    const projectOptions = useMemo(() => {
        const byId = new Map<string, string>();
        let hasStandalone = false;
        for (const doc of documents) {
            if (doc.project_id) {
                byId.set(doc.project_id, doc.project_name ?? "Untitled project");
            } else {
                hasStandalone = true;
            }
        }
        const options = [...byId.entries()]
            .map(([value, label]) => ({ value, label }))
            .sort((a, b) => a.label.localeCompare(b.label));
        if (hasStandalone) {
            options.unshift({ value: STANDALONE, label: "Not in a project" });
        }
        return options;
    }, [documents]);

    const visible = useMemo(
        () =>
            documents.filter((doc) => {
                if (projectFilter === STANDALONE && doc.project_id) return false;
                if (
                    projectFilter &&
                    projectFilter !== STANDALONE &&
                    doc.project_id !== projectFilter
                ) {
                    return false;
                }
                if (originFilter === "upload" && doc.origin !== "upload")
                    return false;
                if (originFilter === "assistant" && doc.origin !== "assistant")
                    return false;
                if (originFilter === "assistant_edited" && !doc.assistant_edited)
                    return false;
                return true;
            }),
        [documents, projectFilter, originFilter],
    );

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader loading={loading}>Documents</PageHeader>

            {!loading && (
                <div className="px-4 pb-3 text-xs text-gray-500">
                    {visible.length}
                    {visible.length === documents.length
                        ? ""
                        : ` of ${documents.length}`}{" "}
                    {documents.length === 1 ? "document" : "documents"}
                </div>
            )}

            <TableScrollArea className="px-4 pb-6">
                <TableHeaderRow>
                    <TableHeaderCell className="flex-1 min-w-0">
                        Name
                    </TableHeaderCell>
                    <TableHeaderCell className="w-44">
                        <div className="flex items-center gap-1">
                            <span>Project</span>
                            <HeaderFilterDropdown
                                label="Filter by project"
                                value={projectFilter}
                                allLabel="All Projects"
                                widthClassName="w-56"
                                options={projectOptions}
                                onChange={setProjectFilter}
                            />
                        </div>
                    </TableHeaderCell>
                    <TableHeaderCell className="w-48">
                        <div className="flex items-center gap-1">
                            <span>Source</span>
                            <HeaderFilterDropdown
                                label="Filter by source"
                                value={originFilter}
                                allLabel="All Sources"
                                widthClassName="w-52"
                                options={ORIGIN_OPTIONS}
                                onChange={setOriginFilter}
                            />
                        </div>
                    </TableHeaderCell>
                    <TableHeaderCell className="w-24">Size</TableHeaderCell>
                    <TableHeaderCell className="w-28">Updated</TableHeaderCell>
                </TableHeaderRow>

                <TableBody>
                    {loading &&
                        Array.from({ length: 6 }).map((_, i) => (
                            <TableRow key={i} interactive={false}>
                                <TableCell className="flex-1 min-w-0">
                                    <SkeletonLine className="w-64" />
                                </TableCell>
                                <TableCell className="w-44">
                                    <SkeletonLine className="w-24" />
                                </TableCell>
                                <TableCell className="w-48">
                                    <SkeletonLine className="w-28" />
                                </TableCell>
                                <TableCell className="w-24">
                                    <SkeletonLine className="w-12" />
                                </TableCell>
                                <TableCell className="w-28">
                                    <SkeletonLine className="w-16" />
                                </TableCell>
                            </TableRow>
                        ))}

                    {!loading && error && (
                        <TableEmptyState>{error}</TableEmptyState>
                    )}

                    {!loading && !error && visible.length === 0 && (
                        <TableEmptyState>
                            {documents.length === 0
                                ? "No documents yet. Upload one from the assistant or a project."
                                : "No documents match these filters."}
                        </TableEmptyState>
                    )}

                    {!loading &&
                        !error &&
                        visible.map((doc) => (
                            <TableRow
                                key={doc.id}
                                onClick={() => router.push(documentHref(doc))}
                            >
                                <TableCell className="flex flex-1 min-w-0 items-center gap-2">
                                    <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                                    <span className="truncate text-sm text-gray-900">
                                        {doc.filename ?? "Untitled"}
                                    </span>
                                    {doc.version_count > 1 && (
                                        <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                                            v{doc.latest_version_number ?? doc.version_count}
                                        </span>
                                    )}
                                </TableCell>

                                <TableCell className="w-44">
                                    {doc.project_name ?? (
                                        <span className="text-gray-400">
                                            Not in a project
                                        </span>
                                    )}
                                </TableCell>

                                <TableCell className="flex w-48 items-center gap-1.5">
                                    {doc.origin === "assistant" ? (
                                        <>
                                            <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                                            <span>Assistant</span>
                                        </>
                                    ) : (
                                        <>
                                            <Upload className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                            <span>Uploaded</span>
                                        </>
                                    )}
                                    {/* A document can be both: uploaded by the
                                        user, then edited by the assistant. */}
                                    {doc.assistant_edited && (
                                        <span
                                            className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700"
                                            title="The assistant produced a version of this document"
                                        >
                                            <PencilLine className="h-2.5 w-2.5" />
                                            edited
                                        </span>
                                    )}
                                </TableCell>

                                <TableCell className="w-24">
                                    {formatBytes(doc.size_bytes)}
                                </TableCell>
                                <TableCell className="w-28">
                                    {formatDate(doc.updated_at ?? doc.created_at)}
                                </TableCell>
                            </TableRow>
                        ))}
                </TableBody>
            </TableScrollArea>
        </div>
    );
}
